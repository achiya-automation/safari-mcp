#!/usr/bin/env node
/**
 * The AppleScript fallback acts on a tab the Safari extension opened or picked only where it
 * finds this session's identity marker, and closes no tab without that proof. Default mode (no
 * SAFARI_PROFILE); a named profile never falls back to AppleScript.
 *
 * Found by code reading on 28.9.26. safari.js tracked such a tab by the index and URL the
 * extension reported (setActiveTabFromExtension), without the marker its own AppleScript tabs
 * carry, and resolving it guessed:
 *   1. With no URL to go by (a blank safari_new_tab), resolveActiveTab() returned that index
 *      unchecked. A tab the user closes to its left, or a front window other than the one the
 *      extension opened the tab in, puts one of the user's tabs at that index, and runJS,
 *      runJSLarge, navigate and closeTab acted on it: safari_close_tab's fallback closed it.
 *   2. With a URL, any tab whose URL starts with it matched (every page under a site root), then
 *      any tab whose URL merely contains its domain. Holding no marker, the session had only the
 *      guard that refuses tabs another MCP session marked, so nothing checked the tab when the
 *      script ran.
 * Now the extension, which knows the tab by its id, writes the session's marker into it
 * (mark_tab, or evaluate on an extension built before it) when AppleScript first needs the tab,
 * and safari.js acts only on the tab a scan finds carrying that marker.
 *
 * Both sides are the real code: index.js's tool handlers, extensionOrFallback and its marker
 * hook, and safari.js's session state, resolveActiveTab(), runJS(), runJSLarge(), navigate(),
 * closeTab() and the tab fronting that native input uses, over fake Safari windows that answer
 * their AppleScript and run the identity guard the way Safari would.
 *
 * Run:  node --test test/extension-tab-proof.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-proof-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
const { textResult, errorResult, evalResult } = await import("../response.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
  sid = "s1";
});

const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

// The MCP session the calls arrive on. A reconnect re-initialises it under a new id.
let sid = "s1";
const currentSessionId = () => sid;

const USER_URL = "https://mail.example.com/inbox";
const USER2_URL = "https://news.example.net/today";
const USER3_URL = "https://docs.example.org/draft";
const A_URL = "https://a.example.com/start";
const B_URL = "https://b.example.com/work";

const tab = (url, extra = {}) => ({ url, name: "", ...extra });

// ---------- Safari, answering safari.js's AppleScript ----------

// Safari's windows, the front one first, each a list of tabs. A tab's `name` is its window.name
// and `current` marks the tab selected in its window. `ran` records every tab a script ran in;
// `navigated` and `closed` every tab AppleScript loaded a URL into or closed.
function safariApp(...windows) {
  const ran = [], navigated = [], closed = [];
  const front = () => windows[0];
  const selected = () => front().find((t) => t.current) || front()[0];
  const site = (url) => { try { return new URL(url).hostname.split(".").slice(-2).join("."); } catch { return url; } };
  const run = async (script) => {
    const js = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in (?:tab (\d+) of front window|front document)$/);
    if (js) {
      const target = js[2] ? front()[Number(js[2]) - 1] : selected();
      if (!target) throw new Error(`AppleScript error: Safari got an error: Can’t get tab ${js[2]} of window 1. (-1728)`);
      // The identity guard runJS prefixes: the tab must carry the session's marker, or, when the
      // session holds none, must not carry another session's.
      const marker = js[1].match(/^if\(window\.name!=='([^']*)'/);
      if (marker ? target.name !== marker[1] : /^if\(typeof window\.name/.test(js[1]) && target.name.startsWith("MCP_")) {
        throw new Error(`AppleScript error: ${marker ? "MCP_WRONG_TAB" : "MCP_FOREIGN_TAB"}`);
      }
      const stamp = js[1].match(/window\.name='(MCP_\w+)'/); // navigate() re-stamping its tab
      if (stamp) return void (target.name = stamp[1]);
      ran.push(target);
      if (js[1].includes("document.readyState")) return "complete";
      if (js[1].includes("JSON.stringify({title:document.title,url:location.href")) return JSON.stringify({ title: "", url: target.url });
      return target.url;
    }
    const closing = /close tab i of w/.test(script) && script.match(/window\.name==='([^']*)'/);
    if (closing) {
      // closeTabByMarker: the front window's tab carrying the marker, found and closed in one
      // script (blanked when it is the window's only tab).
      const at = front().findIndex((t) => t.name === closing[1]);
      if (at < 0) return "";
      if (front().length === 1) {
        front()[0].url = "about:blank";
        return "blanked";
      }
      closed.push(...front().splice(at, 1));
      return "closed";
    }
    const scan = script.match(/window\.name==='([^']*)'/);
    if (scan) {
      // A marker scan of the front window: the hinted tab first, then right to left.
      const has = (i) => front()[i - 1]?.name === scan[1];
      const hint = Number(script.match(/in tab (\d+) of w\) is "1"/)?.[1]);
      if (has(hint)) return String(hint);
      for (let i = front().length; i >= 1; i--) if (has(i)) return String(i);
      return "0";
    }
    const prefix = script.match(/starts with "([^"]*)"/);
    if (prefix) {
      // resolveActiveTab's URL lookup, which every session used before a marker was required:
      // the tracked index, then a URL prefix right to left, then the domain anywhere in a URL
      // (answered as a negative index), else "0:<tab count>".
      const url = (i) => front()[i - 1]?.url || "";
      const cached = Number(script.match(/if tabCount >= (\d+) then/)?.[1]);
      if (cached && url(cached).startsWith(prefix[1])) return String(cached);
      for (let i = front().length; i >= 1; i--) if (url(i).startsWith(prefix[1])) return String(i);
      const domain = script.match(/contains "([^"]*)"/)[1];
      for (let i = front().length; i >= 1; i--) if (url(i).includes(domain)) return String(-i);
      return `0:${front().length}`;
    }
    const nav = script.match(/^tell application "Safari" to set URL of tab (\d+) of front window to "([^"]*)"$/);
    if (nav) {
      const target = front()[Number(nav[1]) - 1];
      if (site(target.url) !== site(nav[2])) target.name = ""; // Safari clears window.name on a cross-site load
      target.url = nav[2];
      navigated.push(target);
      return "";
    }
    if (/return \(count of tabs of front window\)$/.test(script)) return String(front().length);
    const close = script.match(/^tell application "Safari" to close tab (\d+) of front window$/);
    if (close) return void closed.push(...front().splice(Number(close[1]) - 1, 1));
    if (/to return \(index of current tab\) as text$/.test(script)) return String(front().indexOf(selected()) + 1);
    const select = script.match(/to set current tab to tab (\d+)$/);
    if (select) return void front().forEach((t, i) => { t.current = i === Number(select[1]) - 1; });
    throw new Error(`the fake Safari does not answer this AppleScript:\n${script}`);
  };
  return { windows, front, ran, navigated, closed, run };
}

// ---------- the extension's end of the bridge ----------

// It opens tabs in `home`, its own window, which need not be Safari's front one, and knows every
// tab by identity: a receipt names one tab, and a command without one goes to the session's
// current tab. It can script only http(s) pages. `marks` is how it can write a marker: with
// mark_tab (the default), only with evaluate (an extension built before mark_tab), or not at all
// (such an extension on a page whose CSP refuses evaluate); a mark_tab answers once `gate` has
// settled. It serves the commands in `serves`; every other one fails the way that sends index.js
// to its AppleScript fallback: an evaluate comes back CSP-blocked, anything else times out.
function extension(browser, { home = browser.windows[0], marks = "mark_tab", serves = [], gate } = {}) {
  const receipts = new Map();
  let current = null;
  const target = ({ receipt }) => {
    const found = receipt ? receipts.get(receipt) : current;
    if (!found || !browser.windows.some((w) => w.includes(found))) {
      throw new Error("Tab safety: that tab is not open, or not this session's");
    }
    if (!/^https?:/.test(found.url)) throw new Error("Cannot access contents of the page");
    return found;
  };
  return async (type, payload) => {
    if (type === "new_tab") {
      const opened = tab(payload.url || "favorites://");
      home.push(opened);
      current = opened;
      // Only an http(s) page gets a receipt.
      const receipt = payload.url ? `Receipt${receipts.size}_${"r".repeat(24)}` : "";
      if (receipt) receipts.set(receipt, opened);
      return { title: "", ...(payload.url ? { safeUrl: payload.url } : {}), ...(receipt ? { receipt } : {}), tabIndex: home.length };
    }
    if (type === "mark_tab") {
      if (marks !== "mark_tab") throw new Error("Unknown command: mark_tab");
      const marked = target(payload);
      await gate;
      marked.name = payload.marker;
      return true;
    }
    if (type === "evaluate") {
      const marker = String(payload.script).match(/^\(window\.name=window\.__mcpTabMarker="(MCP_\w+)",'1'\)$/);
      if (marker && marks === "evaluate") {
        target(payload).name = marker[1];
        return "1";
      }
      return "Error: CSP blocked all strategies - the script did not run. Falling back to AppleScript.";
    }
    if (type === "navigate" && serves.includes("navigate")) {
      const navigated = payload.receipt ? receipts.get(payload.receipt) : current;
      navigated.url = payload.url;
      navigated.name = "";
      return { title: "", url: payload.url };
    }
    throw new Error(`Extension timeout after 30000ms (${type})`);
  };
}

// ---------- safari.js, for real ----------

// The per-session tab state, its accessors and resolveActiveTab(), runJS() and runJSLarge(),
// navigate() and the stamp it re-applies after a load, closeTab(), and the tab fronting that
// native input and screenshots go through.
const safariParts = [
  between(safariSource, "const _sessions = new Map();", "\n// ========== DIAGNOSTIC LOG"),
  between(safariSource, "function _assertNotFallingBackToUserTab(", "\n// ========== TAB IDENTITY MARKER"),
  between(safariSource, "function _buildStampJS(marker) {", "\n// Quick JS execution"),
  between(safariSource, "export function getActiveTabIndex()", "\n// ========== FAST OSASCRIPT"),
  between(safariSource, "const NATIVE_TAB_SETTLE_MS", "\n// Atomic tab-identity guard"),
  between(safariSource, "function _tabIdentityGuard(", "\n// ========== NAVIGATION =========="),
  between(safariSource, "export async function navigate(url) {", "\n// Poll document.readyState from the Node side"),
  between(safariSource, "async function _provenOwnTabIndex()", "\nexport async function switchTab("),
].join("\n");
const safariExports = [...safariParts.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

function loadSafari(browser) {
  // runJSLarge hands its AppleScript to osascript through a temp file.
  const files = new Map();
  const deps = {
    currentSessionId, randomUUID: () => "sess0001-0000-4000-8000-000000000000",
    osascript: browser.run, osascriptFast: browser.run, getTargetWindowRef: () => "front window",
    refreshTargetWindow: async () => {}, SAFARI_PROFILE: null, console: { error() {} },
    raiseWindowForShow: async () => {}, _injectHelpersfast: async () => {},
    writeFile: async (file, content) => void files.set(file, content), unlink: async () => {},
    execFileAsync: async (_cmd, [file]) => ({ stdout: String((await browser.run(files.get(file))) ?? "") }),
    tmpdir: () => "/tmp", join: (...parts) => parts.join("/"),
    _helperGetFrontApp: async () => null, restoreFocusIfStolen: async () => {}, _focusGuardActive: false,
  };
  const safari = new Function(
    ...Object.keys(deps),
    `${safariParts.replace(/^export /gm, "")}
    return { _st, runJS, runJSLarge, resolveActiveTab, _withTargetTabFronted, ${safariExports.join(", ")} };`
  )(...Object.values(deps));
  // What else index.js calls on these paths: focus bookkeeping around each extension command,
  // and the AppleScript fallbacks, which run their JavaScript in the session's tab through runJS.
  return Object.assign(safari, {
    saveFrontmostApp: async () => null,
    setFocusGuard() {},
    readPage: () => safari.runJS("document.body.innerText"),
    evaluate: ({ script }) => safari.runJS(script),
  });
}

// ---------- index.js, for real ----------

// The receipt helpers, extensionOrFallback with its ownership guard, and the hook that has the
// extension mark its tab for safari.js.
const indexParts = [
  between(index, "function _originOf(", "\nfunction _isBatchSemanticFailure"),
  between(index, "function _untrackClosedTab(", "\n// Close all MCP-opened tabs on process exit"),
  between(index, "const _nullMeansFailure = new Set([", "\n// run_script action names"),
  between(index, "// Tab-ownership assertion", "\n// The cookie / localStorage / sessionStorage tools"),
  between(index, "// safari.js lets AppleScript act only on a tab", "\n// Read version from package.json"),
].join("\n");

// The handler a server.tool(...) call registers.
function toolHandler(name) {
  const at = index.indexOf(`server.tool(\n  "${name}",`);
  assert.ok(at >= 0, `no ${name} tool`);
  const from = index.indexOf("async (", at);
  return index.slice(from, index.indexOf("\n);\n", from));
}

function loadServer(safari, sendToExtension) {
  const deps = {
    safari, sendToExtension, SESSION_ID: "daemon", currentSessionId,
    process: { env: {} }, console: { error() {} }, textResult, errorResult, evalResult,
    _evictOldestTab: async () => null, _trackTab: own._trackTab, _untrackTab: own._untrackTab,
    _openedTabs: own._openedTabs, _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL,
    _removeOwnedURL: own._removeOwnedURL, _markBlankTabOpened: own._markBlankTabOpened,
    _isURLOwned: own._isURLOwned, BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    // The default mode, with the extension connected.
    _preferAppleScript: false, _extensionConnected: true, _primaryHasExtension: false,
    _profileExtensionVerified: true, _commandTimeouts: {},
  };
  return new Function(
    ...Object.keys(deps),
    `${indexParts}
    return {
      safari_new_tab: ${toolHandler("safari_new_tab")},
      safari_close_tab: ${toolHandler("safari_close_tab")},
      safari_navigate: ${toolHandler("safari_navigate")},
      safari_read_page: ${toolHandler("safari_read_page")},
      safari_evaluate: ${toolHandler("safari_evaluate")},
    };`
  )(...Object.values(deps));
}

function session(browser, options) {
  const safari = loadSafari(browser);
  return { safari, server: loadServer(safari, extension(browser, options)) };
}

const receiptOf = (result) => JSON.parse(result.content[0].text).receipt;
const refused = /Tab tracking lost|Tab safety/;

// ---------- 1. an index proves nothing ----------

// Tab 1 is the user's current tab and tab 2 another of theirs. The extension opens the session's
// tab as tab 3; the user then opens a tab after it and closes their first one, so the session's
// tab moves to 2 and tab 3 is the user's new one.
async function afterUserShift(url, options) {
  const browser = safariApp([tab(USER_URL, { current: true }), tab(USER2_URL)]);
  const { safari, server } = session(browser, options);
  await server.safari_new_tab(url ? { url } : {});
  const mine = browser.front()[2];
  browser.front().push(tab(USER3_URL));
  browser.front().shift();
  assert.equal(browser.front()[2].url, USER3_URL, "tab 3 is the user's now");
  return { browser, safari, server, mine };
}

test("a failed read or evaluate runs in the tab the extension opened, found by its marker after the user shifted the tabs", async () => {
  const { browser, server, mine } = await afterUserShift(A_URL);
  await server.safari_read_page({});
  await server.safari_evaluate({ script: "document.title" });
  assert.deepEqual(browser.ran, [mine, mine]);
  assert.match(mine.name, /^MCP_/, "the extension marked its tab");
});

test("a blank tab the extension opened cannot be marked, so the fallbacks refuse instead of using the user's tab at its index", async () => {
  const { browser, safari, server } = await afterUserShift("");
  await assert.rejects(server.safari_read_page({}), refused);
  await assert.rejects(server.safari_evaluate({ script: "document.title" }), refused);
  await assert.rejects(server.safari_navigate({ url: B_URL }), refused);
  await assert.rejects(safari.runJSLarge("document.title"), refused);
  await assert.rejects(safari._withTargetTabFronted(async () => assert.fail("the native event ran")), refused);
  assert.deepEqual([browser.ran, browser.navigated], [[], []], "a user tab was read or navigated");
  assert.deepEqual(browser.front().map((t) => t.current || false), [false, false, false], "the selection moved");
});

test("native input, runJSLarge and navigate act on the proven tab, not on the user's tab at its old index", async () => {
  const { browser, safari, server, mine } = await afterUserShift(A_URL);
  let fronted = null;
  await safari._withTargetTabFronted(async () => { fronted = browser.front().find((t) => t.current); });
  assert.equal(fronted, mine, "the native event went to another tab");
  assert.equal(browser.front().find((t) => t.current)?.url, USER2_URL, "the user's selected tab was not given back");
  assert.deepEqual(await safari.runJSLarge("document.title"), A_URL);
  await server.safari_navigate({ url: B_URL });
  assert.deepEqual(browser.navigated, [mine]);
  assert.equal(mine.url, B_URL);
  // navigate() re-stamps its marker after the cross-site load cleared window.name.
  await server.safari_read_page({});
  assert.equal(browser.ran.at(-1), mine);
});

test("safari_close_tab's AppleScript fallback closes the tab a read proved, never the user's tab at its old index", async () => {
  // A blank tab the extension then loaded a page into: the session's tab has no receipt, so a
  // failed close falls back to AppleScript.
  const { browser, server, mine } = await afterUserShift("", { serves: ["navigate"] });
  await server.safari_navigate({ url: A_URL });
  await server.safari_read_page({});
  await server.safari_close_tab({});
  assert.deepEqual(browser.closed, [mine]);
  assert.deepEqual(browser.front().map((t) => t.url), [USER2_URL, USER3_URL]);
});

test("safari_close_tab's AppleScript fallback closes nothing when the extension's tab cannot be proven", async () => {
  const { browser, server } = await afterUserShift("");
  await assert.rejects(server.safari_close_tab({}), refused);
  assert.deepEqual(browser.closed, []);
  assert.deepEqual(browser.front().map((t) => t.url), [USER2_URL, "favorites://", USER3_URL]);
});

test("a tab the extension opened in another window is not the front window's tab at the same index", async () => {
  // The user works in the front window; the extension opens the session's tab in its own window.
  const front = [tab(USER_URL, { current: true }), tab(USER2_URL)];
  const browser = safariApp(front, [tab(USER3_URL)]);
  const { server } = session(browser, { home: browser.windows[1] });
  await server.safari_new_tab({ url: A_URL }); // tab 2 of the extension's window
  await assert.rejects(server.safari_read_page({}), refused);
  await assert.rejects(server.safari_evaluate({ script: "document.title" }), refused);
  assert.deepEqual(browser.ran, [], "the fallback ran in the front window's tab 2");
});

// ---------- 2. a URL proves nothing ----------

for (const { name, mine, users } of [
  { name: "a page under the same site root", mine: "https://github.com/", users: ["https://github.com/achiya/safari-mcp/issues"] },
  { name: "a page whose URL contains the domain", mine: B_URL, users: ["https://tracker.example.org/?ref=b.example.com"] },
]) {
  test(`after the user closed the extension's tab, the fallback does not run in their tab on ${name}`, async () => {
    const browser = safariApp([tab(USER_URL, { current: true }), ...users.map((u) => tab(u))]);
    const { server } = session(browser);
    await server.safari_new_tab({ url: mine });
    browser.front().pop(); // the user closes it
    await assert.rejects(server.safari_evaluate({ script: "document.cookie" }), refused);
    await assert.rejects(server.safari_read_page({}), refused);
    assert.deepEqual(browser.ran, []);
  });
}

// ---------- the marker ----------

test("once a load cleared the marker, the extension marks its tab again", async () => {
  const { browser, server, mine } = await afterUserShift(A_URL);
  await server.safari_read_page({});
  const first = mine.name;
  mine.url = "https://login.other.example/sso"; // the page redirected across sites…
  mine.name = ""; // …which cleared window.name
  await server.safari_read_page({});
  assert.deepEqual(browser.ran, [mine, mine]);
  assert.match(mine.name, /^MCP_/);
  assert.notEqual(mine.name, first);
});

test("parallel calls share one marking, so neither scans for a marker the other replaced", async () => {
  const { browser, server, mine } = await afterUserShift(A_URL);
  await Promise.all([server.safari_read_page({}), server.safari_evaluate({ script: "document.title" })]);
  assert.deepEqual(browser.ran, [mine, mine]);
});

test("a marker the extension writes after the session moved to another tab does not stand for the new one", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const browser = safariApp([tab(USER_URL, { current: true })]);
  const { server } = session(browser, { gate });
  await server.safari_new_tab({ url: A_URL });
  const reading = server.safari_read_page({}); // the extension starts marking A…
  await new Promise((resolve) => setImmediate(resolve));
  await server.safari_new_tab({ url: B_URL }); // …the session moves to B…
  release(); // …and only then does A's marker land.
  await assert.rejects(reading, refused);
  await server.safari_read_page({});
  assert.deepEqual(browser.ran.map((t) => t.url), [B_URL], "a read meant for B ran in A");
});

test("an extension built before mark_tab marks through evaluate; where a strict CSP refuses that too, the fallback refuses", async () => {
  const lax = await afterUserShift(A_URL, { marks: "evaluate" });
  await lax.server.safari_read_page({});
  assert.deepEqual(lax.browser.ran, [lax.mine]);

  const strict = await afterUserShift(A_URL, { marks: "none" });
  await assert.rejects(strict.server.safari_read_page({}), refused);
  assert.deepEqual(strict.browser.ran, []);
});

// ---------- a receipt names the tab ----------

test("a receipt that names another tab moves the fallback there", async () => {
  const browser = safariApp([tab(USER_URL, { current: true })]);
  const { server } = session(browser);
  const a = receiptOf(await server.safari_new_tab({ url: A_URL }));
  await server.safari_new_tab({ url: B_URL });
  await server.safari_evaluate({ script: "document.title", receipt: a });
  assert.deepEqual(browser.ran.map((t) => t.url), [A_URL], "the fallback ran in the session's previous tab");
});

test("a session re-initialised after a reconnect that passes its receipt: the fallback runs in that tab, not the front document", async () => {
  const browser = safariApp([tab(USER_URL, { current: true })]);
  const { server } = session(browser);
  const a = receiptOf(await server.safari_new_tab({ url: A_URL }));
  sid = "s2"; // the transport dropped; the client re-initialised with its receipt in hand
  await server.safari_evaluate({ script: "document.title", receipt: a });
  await server.safari_read_page({ receipt: a });
  assert.deepEqual(browser.ran.map((t) => t.url), [A_URL, A_URL], "the fallback ran in the user's tab");
});

// ---------- a session that never opened a tab ----------

test("a session that never opened a tab still reads the page the user is looking at", async () => {
  const browser = safariApp([tab(USER_URL, { current: true }), tab(USER2_URL)]);
  const { server } = session(browser);
  await server.safari_read_page({});
  assert.deepEqual(browser.ran.map((t) => t.url), [USER_URL]);
});
