#!/usr/bin/env node
/**
 * Regression coverage for profile-scoped extension routing.
 *
 * A worker once persisted `wrong:אוטומציות — Start Page` while a different profile
 * happened to own port 9224. That raw verdict permanently rejected the correct worker,
 * forcing every tool through Apple Events; when TCC returned -1743 the whole MCP died.
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(
  readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")
);
const xcodeProject = readFileSync(
  new URL("../xcode/Safari MCP/Safari MCP.xcodeproj/project.pbxproj", import.meta.url),
  "utf8"
);

function extractedCanonicalizer() {
  const start = background.indexOf("function _canonicalProfileName(");
  const end = background.indexOf("\n}", start);
  assert.ok(start > 0 && end > start, "profile canonicalizer should exist");
  const source = background.slice(start, end + 2);
  return Function(`${source}; return _canonicalProfileName;`)();
}

test("legacy wrong:<profile> window verdicts migrate to a stable profile identity", () => {
  const canonical = extractedCanonicalizer();
  assert.equal(canonical("wrong:אוטומציות — עמוד הפתיחה"), "אוטומציות");
  assert.equal(canonical("wrong:עבודה — Meta Business Suite"), "עבודה");
  assert.equal(canonical("מחקר אנונימי"), "מחקר אנונימי");
  assert.equal(canonical("notfound"), "");
  assert.equal(canonical("__personal__"), "");
});

test("transient verification failures are not persisted as profile identities", () => {
  const verify = background.slice(
    background.indexOf("async function _verifyProfileMatch("),
    background.indexOf("async function _discoverProfileWindow(")
  );
  assert.match(verify, /detectedProfile === expected/);
  assert.match(verify, /remove\("mcpVerifiedProfile"\)/);
  assert.doesNotMatch(
    verify,
    /mcpVerifiedProfile:\s*result\.actualProfile\s*\|\|\s*"__personal__"/,
    "notfound/error must not poison all future reconnects"
  );
});

test("profile verification never creates or closes a temporary browser tab", () => {
  const verify = background.slice(
    background.indexOf("async function _verifyProfileMatch("),
    background.indexOf("async function _discoverProfileWindow(")
  );
  assert.doesNotMatch(verify, /browser\.tabs\.create\(/);
  assert.doesNotMatch(verify, /browser\.tabs\.remove\(/);
  assert.match(verify, /browser\.scripting\.executeScript\(/);
  assert.match(verify, /document\.title === marker/);
  assert.match(verify, /rejecting without opening a tab/);
});

test("the server rejects stale workers before they can run the visible-tab verifier", () => {
  assert.match(background, /connect\?verifier=existing-tab-v1/);
  assert.match(index, /searchParams\.get\("verifier"\) !== "existing-tab-v1"/);
  assert.match(index, /res\.writeHead\(426/);
  assert.match(index, /status: "upgrade_required"/);
});

test("a verified profile extension may bypass denied Apple Events", () => {
  assert.match(
    index,
    /_extensionConnected && \(!_preferAppleScript \|\| _profileExtensionVerified\)/,
    "extension routing must unlock only after profile verification"
  );
  assert.match(index, /_profileExtensionVerified = true;[\s\S]{0,180}profile-verified/);
});

test("new_tab recreates a closed verified-profile window through WebExtension APIs", () => {
  const newTabCase = background.slice(
    background.indexOf('case "new_tab":'),
    background.indexOf('case "close_tab":')
  );
  assert.match(newTabCase, /browser\.windows\.getAll\(\)/);
  assert.match(newTabCase, /browser\.windows\.create\(\{ url: "about:blank", focused: false \}\)/);
  assert.doesNotMatch(index, /SAFARI_PROFILE_WINDOW_OPENER|PROFILE_WINDOW_OPENER/);
  assert.match(index, /_waitForVerifiedProfileExtension\(30000\)/);
  assert.match(index, /refusing AppleScript fallback/);
  const verifier = background.slice(
    background.indexOf("async function _verifyProfileMatch("),
    background.indexOf("async function _discoverProfileWindow(")
  );
  assert.match(verifier, /if \(!allWindows\.length\) return !!expected && storedProfile === expected/);
});

test("a proxy new_tab also restores a closed profile window on the extension host", () => {
  const proxyHandler = index.slice(
    index.indexOf('if (req.method === "POST" && req.url === "/proxy-command")'),
    index.indexOf('res.writeHead(404)')
  );
  const recoveryAt = proxyHandler.indexOf('if (type === "new_tab") await _waitForVerifiedProfileExtension(30000);');
  const sendAt = proxyHandler.indexOf('await sendToExtension(type, payload, timeout)');
  assert.ok(recoveryAt >= 0, "proxy handler must wait for the profile worker for new_tab");
  assert.ok(sendAt > recoveryAt, "profile worker recovery must happen before proxying new_tab");
});

test("profile commands allow a suspended Safari worker to wake", () => {
  const timeouts = index.slice(
    index.indexOf("const _commandTimeouts ="),
    index.indexOf("const _nullMeansFailure")
  );
  for (const command of ["click", "fill", "list_tabs", "new_tab", "close_tab", "press_key"]) {
    assert.match(timeouts, new RegExp(`${command}: 30000`), `${command} must survive Safari's worker wake delay`);
  }
});

test("named-profile commands never fall back to AppleScript", () => {
  const routing = index.slice(
    index.indexOf("async function extensionOrFallback("),
    index.indexOf("// Read version from package.json")
  );
  assert.match(routing, /if \(_preferAppleScript\) throw new Error/);
  assert.match(routing, /if \(_preferAppleScript\) \{[\s\S]*refusing AppleScript fallback/);
  assert.match(routing, /const savedApp = _preferAppleScript \? null/);
  assert.match(
    routing,
    /if \(_preferAppleScript && \(!_extensionConnected \|\| !_profileExtensionVerified\)\) \{[\s\S]*_waitForVerifiedProfileExtension\(30000\)/,
    "a suspended profile worker must get a safe reconnect window before the command is sent"
  );
});

test("secondary instances proxy only to a host with the same Safari profile", () => {
  assert.match(index, /proxy-check\?profile=\$\{profile\}/);
  assert.match(index, /profile !== hostProfile/);
  assert.match(index, /profile: process\.env\.SAFARI_PROFILE \|\| ""/);
});

test("profile workers discover separate bridge ports instead of racing for 9224", () => {
  assert.match(background, /const BRIDGE_PORTS = \[9224, 9228, 9232, 9236\]/);
  assert.match(background, /mcpBridgeUrl/);
  assert.match(background, /trying next bridge/);
  assert.match(index, /SAFARI_MCP_BRIDGE_PORT/);
  assert.match(index, /SAFARI_MCP_BRIDGE_WS_PORT/);
  for (const port of [9224, 9228, 9232, 9236]) {
    assert.match(
      manifest.content_security_policy.extension_pages,
      new RegExp(`http://127\\.0\\.0\\.1:${port}(?:\\s|$)`),
      `extension CSP must allow profile bridge ${port}`
    );
  }
});

test("the isolated command bridge is shipped in both extension targets", () => {
  const commandEntry = manifest.content_scripts.find((entry) =>
    entry.js.includes("command-content.js")
  );
  assert.ok(commandEntry, "manifest must load the isolated command bridge");
  assert.equal(commandEntry.world, undefined, "command bridge must not run in the MAIN page world");
  assert.equal(
    (xcodeProject.match(/command-content\.js in Resources/g) || []).length,
    4,
    "the file needs two build-file declarations and one resource entry per platform target"
  );
});

test("same-tab link clicks navigate from the worker without losing the command result", () => {
  const clickCase = background.slice(
    background.indexOf('case "click":'),
    background.indexOf('case "double_click":')
  );
  assert.match(clickCase, /return "__MCP_NAVIGATE__:" \+ href/);
  assert.match(clickCase, /execInTabIsolated/);
  assert.match(clickCase, /result\.startsWith\("__MCP_NAVIGATE__:"\)/);
  assert.match(clickCase, /await browser\.tabs\.update\(tabId, \{ url: href \}\)/);
  assert.match(clickCase, /await waitForTabLoad\(tabId/);
  assert.match(clickCase, /let from = document\.elementFromPoint\(cx, cy\)/);
  assert.match(clickCase, /const notPrevented = from\.dispatchEvent\(clickEvent\)/);
  assert.match(clickCase, /if \(href && notPrevented && location\.href === beforeUrl/);
  assert.doesNotMatch(clickCase, /location\.href = href/);
  assert.match(background, /world: "ISOLATED"/);
});

test("isolated tab commands retry only Safari's transient access denial", () => {
  const start = background.indexOf("async function execInTabIsolated(");
  const end = background.indexOf("\n}\n\n// Execute in ALL frames", start);
  assert.ok(start > 0 && end > start, "isolated executor should exist");
  const source = background.slice(start, end + 2);
  assert.match(source, /does not have access to this tab/);
  assert.match(source, /Invalid call to scripting\.executeScript/);
  assert.match(source, /if \(!accessIsStillSettling\) throw initialError/);
  assert.match(source, /await sleep\(250\)/);
  assert.equal(
    (source.match(/results = await execute\(\)/g) || []).length,
    2,
    "the executor should make at most one retry"
  );
});

test("duplicate URL resolution prefers the tab owned by the calling session", () => {
  const resolver = background.slice(
    background.indexOf("async function getTargetTab("),
    background.indexOf("async function getActiveTab(")
  );
  assert.match(
    resolver,
    /matches\.find\(t => _isTabOwnedBySession\(sessionId, t\.id\)\) \|\| matches\[0\]/
  );
  assert.match(resolver, /all\.find\(t => _canAdoptMarkedOwnedTab\(t, tabUrl\)\)/);
  assert.match(resolver, /matches = all\.filter\(t => t\.url === tabUrl\)/);
});

test("stateless callers can resume a routed tab only with its durable marker receipt", () => {
  const extractStart = background.indexOf("function _extractMcpTabMarker(");
  const extractEnd = background.indexOf("\n}", extractStart);
  const start = background.indexOf("function _canAdoptMarkedOwnedTab(");
  const end = background.indexOf("\n}", start);
  assert.ok(extractStart > 0 && extractEnd > extractStart, "marker extractor should exist");
  assert.ok(start > 0 && end > start, "marked-tab adoption helper should exist");
  const extractSource = background.slice(extractStart, extractEnd + 2);
  const source = background.slice(start, end + 2);
  const marker = "meta_appeal_A1B2C3D4";
  const adopt = Function(
    "_isTabOwnedByAnySession",
    "_tabOwnershipMarkers",
    "_tabOwnershipOrigins",
    "_markerOwnershipOrigins",
    `${extractSource}; ${source}; return _canAdoptMarkedOwnedTab;`
  )(
    (id) => id === 42,
    new Map([[42, marker]]),
    new Map([[42, "https://example.test"]]),
    new Map([[marker, "https://example.test"]])
  );

  const marked = `https://example.test/path#mcp-tab=${marker}`;
  assert.equal(adopt({ id: 42, url: marked }, marked), true);
  assert.equal(
    adopt({ id: 42, url: `https://example.test/next?view=1#mcp-tab=${marker}` }, marked),
    true,
    "same-origin SPA routing may change the visible URL"
  );
  assert.equal(
    adopt({ id: 42, url: "https://example.test/next" }, marked),
    true,
    "a stored receipt survives routers that strip the marker"
  );
  const adoptAfterSessionLoss = Function(
    "_isTabOwnedByAnySession",
    "_tabOwnershipMarkers",
    "_tabOwnershipOrigins",
    "_markerOwnershipOrigins",
    `${extractSource}; ${source}; return _canAdoptMarkedOwnedTab;`
  )(
    () => false,
    new Map([[42, marker]]),
    new Map([[42, "https://example.test"]]),
    new Map([[marker, "https://example.test"]])
  );
  assert.equal(adoptAfterSessionLoss({ id: 42, url: marked }, marked), true);
  assert.equal(
    adoptAfterSessionLoss({ id: 42, url: marked }, "https://example.test/path"),
    true,
    "a stateless caller may recover the receipt from the live URL on the exact route"
  );
  assert.equal(
    adoptAfterSessionLoss({ id: 42, url: marked }, "https://example.test/other"),
    false,
    "a live receipt cannot make a different same-origin route eligible"
  );
  assert.equal(
    adoptAfterSessionLoss({ id: 42, url: "https://example.test/next" }, marked),
    false,
    "local-storage fallback alone cannot authorize a markerless reused tab id"
  );
  const adoptAfterExtensionReload = Function(
    "_isTabOwnedByAnySession",
    "_tabOwnershipMarkers",
    "_tabOwnershipOrigins",
    "_markerOwnershipOrigins",
    `${extractSource}; ${source}; return _canAdoptMarkedOwnedTab;`
  )(
    () => false,
    new Map(),
    new Map(),
    new Map([[marker, "https://example.test"]])
  );
  assert.equal(
    adoptAfterExtensionReload({ id: 84, url: marked }, "https://example.test/path"),
    true,
    "a live receipt rebinds the tab after Safari renumbers ids during an extension reload"
  );
  assert.equal(
    adoptAfterExtensionReload({ id: 84, url: "https://example.test/path" }, "https://example.test/path"),
    false,
    "tab-id recovery still requires the high-entropy marker in the live URL"
  );
  assert.equal(adopt({ id: 7, url: marked }, marked), false, "user tab is never adoptable");
  assert.equal(
    adopt({ id: 42, url: "https://example.test/path" }, "https://example.test/path"),
    false
  );
  assert.equal(adopt({ id: 42, url: marked }, marked + "x"), false, "receipt must match exactly");
  assert.equal(
    adopt({ id: 42, url: "https://other.test/next" }, marked),
    false,
    "cross-origin redirects never inherit ownership"
  );
  assert.equal(
    adopt(
      { id: 42, url: "https://example.test/#mcp-tab=short" },
      "https://example.test/#mcp-tab=short"
    ),
    false
  );
});

test("tab marker receipts survive Safari service-worker restarts", () => {
  assert.match(background, /const _TAB_MARKERS_KEY = "mcpOwnedTabMarkers"/);
  assert.match(background, /browser\.storage\.session\.get\(\[_OWNED_TABS_KEY, _TAB_MARKERS_KEY\]\)/);
  assert.match(background, /\[_TAB_MARKERS_KEY\]: markers/);
  assert.match(background, /const _TAB_RECEIPTS_KEY = "mcpOwnedTabReceipts"/);
  assert.match(background, /browser\.storage\.local\.get\(_TAB_RECEIPTS_KEY\)/);
  assert.match(background, /\[_TAB_RECEIPTS_KEY\]: receipts/);
  assert.match(background, /const _markerOwnershipOrigins = new Map\(\)/);
  const handler = background.slice(
    background.indexOf("async function handleCommand("),
    background.indexOf("// ========== TAB OWNERSHIP GUARD")
  );
  assert.ok(
    handler.indexOf("await _hydrateOwnedTabs();") < handler.indexOf("await getTargetTab("),
    "receipts must hydrate before target resolution"
  );
});

test("new_tab returns ownership before a slow page finishes loading", () => {
  const newTabCase = background.slice(
    background.indexOf('case "new_tab":'),
    background.indexOf('case "close_tab":')
  );
  assert.doesNotMatch(newTabCase, /await waitForTabLoad\(newTab\.id/);
  assert.doesNotMatch(newTabCase, /await browser\.tabs\.get\(newTab\.id\)/);
  assert.match(newTabCase, /url: "about:blank",\s+active: false/);
  assert.match(newTabCase, /_addOwnedTab\(sessionId, newTab\.id, payload\.url\)/);
  assert.match(newTabCase, /browser\.tabs\.update\(newTab\.id, \{ url: payload\.url \}\)\.catch/);
  assert.doesNotMatch(newTabCase, /await browser\.tabs\.update/);
});

test("switch_tab proves the destination tab before registering a redirected URL", () => {
  const switchTabCase = background.slice(
    background.indexOf('case "switch_tab":'),
    background.indexOf('// --- Scroll ---')
  );
  assert.match(switchTabCase, /_isTabOwnedBySession\(sessionId, target\.id\)/);
  assert.match(switchTabCase, /_canAdoptMarkedOwnedTab\(target, payload\.tabUrl\)/);
  assert.match(switchTabCase, /owned: true/);
  assert.match(
    background,
    /type !== "new_tab" && type !== "switch_tab" && !_readOnlyCommands\.has\(type\)/
  );
  assert.match(index, /if \(result\.owned === true\) _addOwnedURL\(result\.url\)/);
  assert.match(index, /includes\("Tab safety:"\)\) throw err/);
});

test("switch_tab forwards a durable marked URL for stateless callers", () => {
  const switchTabTool = index.slice(
    index.indexOf('"safari_switch_tab"'),
    index.indexOf("// ========== WAIT ==========", index.indexOf('"safari_switch_tab"'))
  );
  assert.match(
    switchTabTool,
    /url:\s*z\.string\(\)\.optional\(\)/,
    "the public tool schema must accept the exact marked URL returned by list_tabs"
  );
  assert.match(switchTabTool, /async \(\{ index, url \}\) =>/);
  assert.match(switchTabTool, /_isURLOwned\(url\)/);
  assert.match(switchTabTool, /extensionOrFallback\(\s*"list_tabs"/);
  assert.doesNotMatch(
    switchTabTool,
    /await safari\.listTabs\(\)/,
    "named-profile switching must inspect tabs through the extension, not AppleScript"
  );
  assert.match(
    switchTabTool,
    /"switch_tab",\s*url \? \{ index, tabUrl: url \} : \{ index \}/,
    "the durable receipt must reach the extension adoption guard"
  );
});
