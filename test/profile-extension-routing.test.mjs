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

test("duplicate URL resolution prefers the tab owned by the calling session", () => {
  const resolver = background.slice(
    background.indexOf("async function getTargetTab("),
    background.indexOf("async function getActiveTab(")
  );
  assert.match(
    resolver,
    /matches\.find\(t => _isTabOwnedBySession\(sessionId, t\.id\)\) \|\| matches\[0\]/
  );
  assert.match(resolver, /matches = all\.filter\(t => t\.url === tabUrl\)/);
  assert.doesNotMatch(resolver, /let match = all\.find\(/);
});

test("stateless callers can resume only an exactly-marked extension-owned tab", () => {
  const start = background.indexOf("function _canAdoptMarkedOwnedTab(");
  const end = background.indexOf("\n}", start);
  assert.ok(start > 0 && end > start, "marked-tab adoption helper should exist");
  const source = background.slice(start, end + 2);
  const adopt = Function(
    "_isTabOwnedByAnySession",
    `${source}; return _canAdoptMarkedOwnedTab;`
  )((id) => id === 42);

  const marked = "https://example.test/path#mcp-tab=meta_appeal_A1B2C3D4";
  assert.equal(adopt({ id: 42, url: marked }, marked), true);
  assert.equal(adopt({ id: 7, url: marked }, marked), false, "user tab is never adoptable");
  assert.equal(
    adopt({ id: 42, url: "https://example.test/path" }, "https://example.test/path"),
    false
  );
  assert.equal(adopt({ id: 42, url: marked }, marked + "x"), false, "URL must match exactly");
  assert.equal(
    adopt(
      { id: 42, url: "https://example.test/#mcp-tab=short" },
      "https://example.test/#mcp-tab=short"
    ),
    false
  );
});

test("new_tab returns ownership before a slow page finishes loading", () => {
  const newTabCase = background.slice(
    background.indexOf('case "new_tab":'),
    background.indexOf('case "close_tab":')
  );
  assert.doesNotMatch(newTabCase, /await waitForTabLoad\(newTab\.id/);
  assert.match(newTabCase, /_addOwnedTab\(sessionId, updated\.id\)/);
});
