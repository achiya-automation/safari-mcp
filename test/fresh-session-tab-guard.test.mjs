#!/usr/bin/env node
/**
 * A session with no tab of its own never writes to the tab the user is looking at. Default
 * mode (no SAFARI_PROFILE), with the extension absent or failing, so the AppleScript fallback runs.
 *
 * Found by code reading on 29.9.26. The extension already holds this line: its write guard
 * refuses "a cold or brand-new session" that presents no receipt (handleCommand in
 * extension/background.js). The guard in index.js, the one in front of the AppleScript
 * fallback, did not:
 *   1. _assertTabOwnership() asked whether a tab had been opened yet of _ownedTabURLs and
 *      _openedTabs. Both are process-wide, and _ownedTabURLs is loaded from the machine-wide
 *      ~/.safari-mcp/owned-tabs.json, so any session's tab counted: another client of the
 *      daemon, another stdio process, the session itself before a reconnect or restart. It then
 *      checked the session's current tab only if it had one, and a session that never opened or
 *      claimed a tab has none.
 *   2. safari_navigate registered its destination as owned before that guard ran, so the guard
 *      could not refuse it even on a clean machine.
 *   3. For a session that never owned a tab, safari.js targets "front document": the tab the user
 *      is looking at. That is deliberate, for reads.
 * So a session's first safari_navigate navigated the user's tab, and click, fill, evaluate and
 * native input from a session with no tab ran in it whenever anything was owned on the machine.
 *
 * Both sides are the real code: index.js's tool handlers, run_script's step guard, and
 * extensionOrFallback with its ownership guard; safari.js's session state, resolveActiveTab(),
 * runJS(), navigate(), newTab(), switchTab(), readPage(), evaluate() and runScript(), over a fake
 * Safari window that runs each page script for real against its tab. click and fill stand in as
 * one page script each, run through the real runJS(): which tab they run in is the point here,
 * not what they do in it.
 *
 * Run:  node --test test/fresh-session-tab-guard.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-fresh-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
const { textResult, errorResult, evalResult } = await import("../response.js");
const { escJsSingleQuote, escAppleScriptString } = await import("../injected-escape.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));

// The MCP session the next call comes from (currentSessionId() in both modules).
let sid = "";
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
  rmSync(own.OWNERSHIP_DIR, { recursive: true, force: true });
  sid = "fresh";
});

const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const USER_URL = "https://mail.example.com/inbox"; // the tab the user is looking at
const OTHER_URL = "https://other.example.org/work"; // a tab some other session opened
const DEST = "https://dest.example.net/page"; // where a caller navigates
const RECEIPT = "ReceiptR_" + "r".repeat(24);

// ---------- a Safari window that answers safari.js's AppleScript ----------

// Tab i is tabs[i - 1], and tab `front` is the one the user is looking at: AppleScript's
// "front document". `marker` is the tab's window.name. A script for one tab runs its page
// JavaScript for real against that tab's window, whose page has always finished loading; the
// scans that loop over every tab in AppleScript are answered here. `ran` keeps every page script
// and navigation with the tab it reached, reads included.
function safariWindow(tabs, front = 1) {
  const w = { tabs, ran: [] };
  const url = (i) => tabs[i - 1]?.url || "";
  const site = (u) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return u; } };
  const tabOf = (target) => Number(/^tab (\d+) of front window$/.exec(target)?.[1]) || front;
  const answer = (script) => {
    const page = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in (tab \d+ of front window|front document)$/);
    if (page) {
      const i = tabOf(page[2]);
      const tab = tabs[i - 1];
      if (!tab) throw new Error(`Safari got an error: Can't get tab ${i} of window 1.`);
      const js = page[1].replace(/\\(["\\])/g, "$1");
      w.ran.push({ tab: i, js });
      const win = { name: tab.marker || "", __mcpTabMarker: tab.pageMarker };
      const document = { title: "", readyState: "complete", body: { innerText: `text of ${tab.url}` } };
      try {
        return String(vm.runInNewContext(js, { window: win, document, location: { href: tab.url } }) ?? "");
      } finally {
        tab.marker = win.name || null;
        tab.pageMarker = win.__mcpTabMarker;
      }
    }
    const marker = script.match(/window\.name==='([^']*)'/);
    if (marker) {
      // A marker scan: the cached index first when there is one, then right to left.
      const has = (i) => tabs[i - 1]?.marker === marker[1];
      const cached = Number(script.match(/in tab (\d+) of w\) is "1"/)?.[1]);
      if (has(cached)) return String(cached);
      for (let i = tabs.length; i >= 1; i--) if (has(i)) return String(i);
      return "0";
    }
    const prefix = script.match(/starts with "([^"]*)"/);
    if (prefix) {
      // resolveActiveTab's URL strategy: the cached index, a URL prefix right to left, then the
      // domain (answered as a negative index), else "0:<tab count>".
      const cached = Number(script.match(/if tabCount >= (\d+) then/)?.[1]);
      if (cached && url(cached).startsWith(prefix[1])) return String(cached);
      for (let i = tabs.length; i >= 1; i--) if (url(i).startsWith(prefix[1])) return String(i);
      const domain = script.match(/contains "([^"]*)"/)[1];
      for (let i = tabs.length; i >= 1; i--) if (url(i).includes(domain)) return String(-i);
      return `0:${tabs.length}`;
    }
    const load = script.match(/^tell application "Safari" to set URL of (tab \d+ of front window|front document) to "([^"]*)"$/);
    if (load) {
      // A new page: __mcpTabMarker goes with the old one, and window.name too across sites.
      const i = tabOf(load[1]);
      const tab = tabs[i - 1];
      if (site(tab.url) !== site(load[2])) tab.marker = null;
      tab.pageMarker = undefined;
      w.ran.push({ tab: i, navigate: load[2] });
      return void (tab.url = load[2]);
    }
    if (/make new tab/.test(script)) {
      // newTab() opens a background tab: the user's tab stays in front.
      tabs.push({ url: script.match(/URL:"([^"]*)"/)?.[1] || "about:blank", marker: null });
      return "";
    }
    const close = script.match(/close tab (\d+) of/);
    if (close) return void tabs.splice(Number(close[1]) - 1, 1);
    if (/count of tabs/.test(script)) return String(tabs.length);
    throw new Error(`the fake window does not answer this AppleScript:\n${script}`);
  };
  w.run = async (script) => answer(script);
  // Everything that reached tab i: page scripts, reads included, and navigations.
  w.ranIn = (i) => w.ran.filter((r) => r.tab === i);
  return w;
}

// ---------- safari.js, for real ----------

// Session state and its accessors, resolveActiveTab(), the marker stamp and the identity guard,
// runJS(), navigate(), readPage(), newTab(), closeTab(), switchTab(), evaluate() and runScript().
const safariParts = [
  between(safariSource, "const _sessions = new Map();", "\n// ========== DIAGNOSTIC LOG"),
  between(safariSource, "function _assertNotFallingBackToUserTab(", "\n// ========== TAB IDENTITY MARKER"),
  between(safariSource, "function _buildStampJS(", "\n// Quick JS execution"),
  between(safariSource, "export function getActiveTabIndex()", "\n// ========== FAST OSASCRIPT"),
  between(safariSource, "function _tabIdentityGuard(", "\n// Run large JavaScript via temp file"),
  between(safariSource, "const RAISE_ON_NAVIGATE", "\n// Poll document.readyState from the Node side"),
  between(safariSource, "export async function readPage(", "\nexport async function getPageSource("),
  between(safariSource, "async function _injectHelpersfast()", "\n// Ensure helpers are injected"),
  between(safariSource, "export async function newTab(", "\n// A tab index this session can prove it owns"),
  between(safariSource, "async function _provenOwnTabIndex()", "\n// ========== WAIT"),
  between(safariSource, "// ========== EVALUATE ==========", "\n// ========== ELEMENT INFO"),
  between(safariSource, "export async function runScript(", "\n// ========== ACCESSIBILITY SNAPSHOT"),
].join("\n");
const safariExports = [...safariParts.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

// runScript's action table names every safari.js action; each name the parts above do not
// declare becomes a parameter, left undefined unless a step below needs it (sloppy-mode
// function declarations replace their parameter).
const actionTable = between(safariSource, "const actions = {", "\n      };")
  .slice("const actions = {".length)
  .replace(/\/\/.*$/gm, "");
const tableNames = [...new Set([
  ...[...actionTable.matchAll(/=> (\w+)\(/g)].map((m) => m[1]),
  ...actionTable.split("\n").filter((l) => !l.includes(":")).flatMap((l) => l.split(",")),
].map((name) => name.trim()).filter(Boolean))];

function loadSafari(window) {
  const safari = new Function(
    "currentSessionId", "randomUUID", "osascript", "osascriptFast", "getTargetWindowRef",
    "refreshTargetWindow", "console", "SAFARI_PROFILE", "escAppleScriptString", "escJsSingleQuote",
    "_HELPERS_ESCAPED", "fakeWindow", "setTimeout", ...tableNames,
    `${safariParts.replace(/^export /gm, "")}
    // click, fill, select and native input: one page script each, through the real runJS().
    click = async () => runJS("/*page:click*/");
    fill = async () => runJS("/*page:fill*/");
    selectOption = async () => runJS("/*page:select*/");
    nativeClick = nativeHover = nativeKeyboard = nativeType = async () => runJS("/*page:native*/");
    listTabs = async () => JSON.stringify(fakeWindow.tabs.map((t, i) => ({ index: i + 1, title: "", url: t.url })));
    return { _st, runJS, click, fill, selectOption, nativeClick, nativeHover, nativeKeyboard, nativeType, listTabs,
      ${safariExports.join(", ")} };`
  )(
    () => sid, () => "sess0001-0000-4000-8000-000000000000", window.run, window.run,
    () => "front window", async () => {}, { error() {} }, null, escAppleScriptString, escJsSingleQuote,
    // The fake page has always finished loading, so the page-load polls need not wait.
    "/*mcp helpers*/", window, (fn) => setImmediate(fn)
  );
  // What else index.js calls on these paths: focus bookkeeping around each command.
  return Object.assign(safari, {
    saveFrontmostApp: async () => null,
    setFocusGuard() {},
    restoreFocusIfStolen: async () => {},
  });
}

// ---------- index.js, for real ----------

// The receipt helpers, the tab-ownership sets, run_script's batch actions, and
// extensionOrFallback with its guard.
const indexParts = [
  between(index, "function _originOf(", "\nfunction _isBatchSemanticFailure"),
  between(index, "function _untrackClosedTab(", "\n// Close all MCP-opened tabs on process exit"),
  between(index, "const _noOwnershipCheck = new Set([", "\n// Origin of a URL"),
  between(index, "async function _runExtensionBatchAction(", "\n// The cookie / localStorage / sessionStorage tools"),
].join("\n");

// The handler a server.tool(...) call registers.
function toolHandler(name) {
  const at = index.indexOf(`server.tool(\n  "${name}",`);
  assert.ok(at >= 0, `no ${name} tool`);
  const from = index.indexOf("async (", at);
  return index.slice(from, index.indexOf("\n);\n", from));
}

const TOOLS = [
  "safari_navigate", "safari_navigate_and_read", "safari_click", "safari_fill", "safari_evaluate",
  "safari_select_option", "safari_native_click", "safari_native_hover", "safari_native_keyboard",
  "safari_native_type", "safari_read_page", "safari_new_tab", "safari_switch_tab", "safari_close_tab",
  "safari_run_script",
];

// The extension is absent, or it fails before the command reaches a page, which sends every
// command to its AppleScript fallback.
const NO_EXTENSION = { name: "no extension", connected: false };
const FAILING_EXTENSION = {
  name: "an extension that fails",
  connected: true,
  send: async (type) => {
    throw Object.assign(new Error(`Timeout waiting for the extension (${type})`), { dispatched: false });
  },
};

// `commands` keeps what the extension was asked.
function loadServer(safari, extension = NO_EXTENSION) {
  const commands = [];
  const deps = {
    safari, SESSION_ID: "daemon", currentSessionId: () => sid,
    process: { env: {} }, console: { error() {} }, textResult, errorResult, evalResult,
    sendToExtension: async (type, payload) => {
      commands.push({ type, payload });
      return extension.send(type, payload);
    },
    _evictOldestTab: async () => null, _trackTab: own._trackTab, _untrackTab: own._untrackTab,
    _openedTabs: own._openedTabs, _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL,
    _removeOwnedURL: own._removeOwnedURL, _markBlankTabOpened: own._markBlankTabOpened,
    _isURLOwned: own._isURLOwned, _trackedAtIndex: own._trackedAtIndex,
    allowUserTabs: own.allowUserTabs, BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    // The default mode.
    _preferAppleScript: false, _extensionConnected: extension.connected, _profileExtensionVerified: false,
    _commandTimeouts: {}, _nullMeansFailure: new Set(),
  };
  const server = new Function(
    ...Object.keys(deps),
    `${indexParts}
    return {
      assertTabOwnership: _assertTabOwnership,
      ${TOOLS.map((name) => `${name}: ${toolHandler(name)}`).join(",\n")}
    };`
  )(...Object.values(deps));
  return Object.assign(server, { commands });
}

// A refusal comes back as a thrown error, or as an error result.
async function outcome(call) {
  try {
    return JSON.stringify(await call());
  } catch (err) {
    return err.message;
  }
}
const REFUSED = /Tab safety/;
const REFUSED_ANYWHERE = /Tab safety|Tab tracking lost/;

// The user's tab is tab 1, in front. The session under test ("fresh") has not opened or claimed a
// tab. What else is on the machine:
//   clean     — nothing
//   daemon    — another client of the same daemon opened tab 2 (safari_new_tab through AppleScript)
//   persisted — owned-tabs.json lists a tab: another process opened it, or this session did
//               before a restart
async function machine(state, extension = NO_EXTENSION) {
  const window = safariWindow([{ url: USER_URL, marker: null }]);
  const safari = loadSafari(window);
  const server = loadServer(safari, extension);
  if (state === "daemon") {
    sid = "other";
    await server.safari_new_tab({ url: OTHER_URL });
    sid = "fresh";
  }
  if (state === "persisted") own._addOwnedURL(OTHER_URL);
  return { window, safari, server };
}

const WRITES = [
  { name: "safari_navigate", call: (s) => s.safari_navigate({ url: DEST }) },
  { name: "safari_navigate_and_read", call: (s) => s.safari_navigate_and_read({ url: DEST }) },
  { name: "safari_click", call: (s) => s.safari_click({ selector: "#send" }) },
  { name: "safari_fill", call: (s) => s.safari_fill({ selector: "#to", value: "someone" }) },
  { name: "safari_evaluate", call: (s) => s.safari_evaluate({ script: "document.title='changed'" }) },
  { name: "safari_select_option", call: (s) => s.safari_select_option({ selector: "#country", value: "IL" }) },
  { name: "run_script navigate", call: (s) => s.safari_run_script({ steps: [{ action: "navigate", args: { url: DEST } }] }) },
  { name: "run_script click", call: (s) => s.safari_run_script({ steps: [{ action: "click", args: { selector: "#send" } }] }) },
];

// ---------- 1. a session with no tab writes nowhere ----------

for (const state of ["clean", "daemon", "persisted"]) {
  for (const extension of [NO_EXTENSION, FAILING_EXTENSION]) {
    for (const write of WRITES) {
      test(`${write.name} from a session with no tab (${state} machine, ${extension.name}) leaves the user's tab alone`, async () => {
        const { window, server } = await machine(state, extension);
        const result = await outcome(() => write.call(server));
        assert.deepEqual(window.ranIn(1), [], "it ran in the tab the user is looking at");
        assert.equal(window.tabs[0].url, USER_URL);
        assert.match(result, REFUSED);
        assert.ok(!own._ownedTabURLs.has(DEST), "a refused navigation registered its destination as owned");
      });
    }
  }
}

test("native input from a session with no tab is refused while another session owns a tab", async () => {
  const { window, server } = await machine("daemon");
  for (const call of [
    () => server.safari_native_click({ x: 10, y: 10 }),
    () => server.safari_native_hover({ x: 10, y: 10 }),
    () => server.safari_native_keyboard({ key: "enter" }),
    () => server.safari_native_type({ value: "someone" }),
  ]) assert.match(await outcome(call), REFUSED);
  assert.ok(!window.ran.some((r) => r.js?.endsWith("/*page:native*/")));
});

// A receipt gets a call past the guard: it names a tab for a caller with no state of its own.
// Only the extension can tell which tab that is, so with the extension absent or failing the
// AppleScript fallback must still stay out of the tab in front.
const RECEIPT_WRITES = [
  { name: "safari_navigate", call: (s) => s.safari_navigate({ url: DEST, receipt: RECEIPT }) },
  { name: "safari_navigate_and_read", call: (s) => s.safari_navigate_and_read({ url: DEST, receipt: RECEIPT }) },
  { name: "safari_click", call: (s) => s.safari_click({ selector: "#send", receipt: RECEIPT }) },
  { name: "safari_fill", call: (s) => s.safari_fill({ selector: "#to", value: "someone", receipt: RECEIPT }) },
  { name: "safari_evaluate", call: (s) => s.safari_evaluate({ script: "document.title='changed'", receipt: RECEIPT }) },
  { name: "safari_select_option", call: (s) => s.safari_select_option({ selector: "#country", value: "IL", receipt: RECEIPT }) },
];
for (const extension of [NO_EXTENSION, FAILING_EXTENSION]) {
  for (const write of RECEIPT_WRITES) {
    test(`${write.name} with a receipt, from a session with no tab (${extension.name}), leaves the user's tab alone`, async () => {
      const { window, server } = await machine("clean", extension);
      const result = await outcome(() => write.call(server));
      assert.deepEqual(window.ranIn(1), [], "it ran in the tab the user is looking at");
      assert.equal(window.tabs[0].url, USER_URL);
      assert.match(result, REFUSED_ANYWHERE);
    });
  }
}

test("a session with no tab cannot switch onto the user's blank tab and write to it", async () => {
  const window = safariWindow([{ url: "about:blank", marker: null }]);
  const server = loadServer(loadSafari(window));
  assert.match(await outcome(() => server.safari_switch_tab({ index: 1 })), REFUSED);
  assert.match(await outcome(() => server.safari_navigate({ url: DEST })), REFUSED);
  assert.equal(window.tabs[0].url, "about:blank");
  assert.equal(window.tabs[0].marker, null);
});

test("a session whose current tab shows a page no MCP session opened is refused", async () => {
  const { window, safari, server } = await machine("clean");
  await server.safari_new_tab({ url: OTHER_URL });
  // The session's tab is on a page nobody registered (it went somewhere no call sent it).
  safari.setActiveTabURL("https://elsewhere.example.com/");
  assert.match(await outcome(() => server.safari_click({ selector: "#send" })), /was not opened by this MCP session/);
  assert.ok(!window.ran.some((r) => r.js?.endsWith("/*page:click*/")));
});

// ---------- 2. what a session with no tab still does ----------

test("a session with no tab still reads the page the user is looking at", async () => {
  const { window, server } = await machine("daemon");
  const read = await outcome(() => server.safari_read_page({}));
  assert.match(read, new RegExp(`text of ${USER_URL}`));
  const batch = await outcome(() => server.safari_run_script({ steps: [{ action: "readPage" }] }));
  assert.match(batch, new RegExp(`text of ${USER_URL}`));
  assert.equal(window.ranIn(1).length, 2);
});

// ---------- 3. a session with a tab of its own works in it ----------

for (const extension of [NO_EXTENSION, FAILING_EXTENSION]) {
  test(`a session that opened a tab navigates, clicks and evaluates in it (${extension.name})`, async () => {
    const { window, server } = await machine("clean", extension);
    await server.safari_new_tab({ url: OTHER_URL });
    for (const call of [
      () => server.safari_navigate({ url: DEST }),
      () => server.safari_click({ selector: "#send" }),
      () => server.safari_fill({ selector: "#to", value: "someone" }),
      () => server.safari_evaluate({ script: "document.title='changed'" }),
    ]) assert.doesNotMatch(await outcome(call), REFUSED);
    assert.equal(window.tabs[1].url, DEST);
    const scripts = window.ranIn(2).map((r) => r.js || "");
    assert.ok(scripts.some((js) => js.endsWith("/*page:click*/")) && scripts.some((js) => js.endsWith("/*page:fill*/")));
    assert.ok(scripts.some((js) => js.includes("document.title='changed'")));
    assert.deepEqual(window.ranIn(1), []);
  });
}

test("run_script opens a tab and works in it, from a session that had none", async () => {
  const { window, server } = await machine("clean");
  const steps = [
    { action: "newTab" },
    { action: "navigate", args: { url: DEST } },
    { action: "click", args: { selector: "#send" } },
  ];
  const result = await outcome(() => server.safari_run_script({ steps }));
  assert.doesNotMatch(result, REFUSED);
  assert.doesNotMatch(result, /error/i);
  assert.equal(window.tabs[1].url, DEST);
  assert.ok(window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")));
  assert.deepEqual(window.ranIn(1), []);
});

test("SAFARI_MCP_ALLOW_USER_TABS: a session adopts the user's tab with safari_switch_tab and works in it", async () => {
  const flag = process.env.SAFARI_MCP_ALLOW_USER_TABS;
  process.env.SAFARI_MCP_ALLOW_USER_TABS = "1";
  try {
    const { window, server } = await machine("clean");
    const switched = await outcome(() => server.safari_switch_tab({ index: 1 }));
    assert.match(switched, /user tab, opted-in/);
    assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#send" })), REFUSED);
    assert.ok(window.ranIn(1).some((r) => r.js?.endsWith("/*page:click*/")));
  } finally {
    if (flag === undefined) delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
    else process.env.SAFARI_MCP_ALLOW_USER_TABS = flag;
  }
});

// A receipt is how a session with no state of its own — a subagent, or the same agent after a
// reconnect or restart — names a tab it holds. The extension resolves it; index.js must let the
// call through. The tab it names was opened on this machine, so its URL is in owned-tabs.json.
const WORKING_EXTENSION = {
  name: "a working extension",
  connected: true,
  send: async (type) => (type === "switch_tab"
    ? { title: "", safeUrl: OTHER_URL, receipt: RECEIPT, tabIndex: 2 }
    : `${type} done`),
};

test("a session with no tab passes a receipt, and the call reaches the extension", async () => {
  const { server } = await machine("clean", WORKING_EXTENSION);
  // First a close, which passes its receipt to the extension without making it the current tab.
  for (const call of [
    () => server.safari_close_tab({ receipt: RECEIPT }),
    () => server.safari_click({ selector: "#send", receipt: RECEIPT }),
    () => server.safari_select_option({ selector: "#country", value: "IL", receipt: RECEIPT }),
    () => server.safari_navigate_and_read({ url: DEST, receipt: RECEIPT }),
  ]) assert.doesNotMatch(await outcome(call), REFUSED);
  assert.deepEqual(server.commands.map((c) => [c.type, c.payload.receipt]),
    [["close_tab", RECEIPT], ["click", RECEIPT], ["select_option", RECEIPT], ["navigate_and_read", RECEIPT]]);
});

test("after closing its current tab, a session keeps working in the other tab it opened", async () => {
  let opened = 0;
  const extension = {
    name: "a working extension",
    connected: true,
    send: async (type, payload) => {
      if (type !== "new_tab") return `${type} done`;
      opened += 1;
      return { title: "", safeUrl: payload.url, receipt: RECEIPT + opened, tabIndex: 1 + opened };
    },
  };
  const { server } = await machine("clean", extension);
  await server.safari_new_tab({ url: OTHER_URL });
  await server.safari_new_tab({ url: DEST });
  assert.doesNotMatch(await outcome(() => server.safari_close_tab({})), REFUSED);
  assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#send" })), REFUSED);
  assert.deepEqual(server.commands.map((c) => c.type), ["new_tab", "new_tab", "close_tab", "click"]);
});

test("after a restart, a session re-anchors to its tab by receipt and keeps writing to it", async () => {
  // owned-tabs.json still lists the tab's URL, so the page the switch reports is recognized.
  const { server } = await machine("persisted", WORKING_EXTENSION);
  assert.doesNotMatch(await outcome(() => server.safari_switch_tab({ receipt: RECEIPT })), REFUSED);
  assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#send" })), REFUSED);
  const sent = server.commands.filter((c) => c.type !== "list_tabs"); // switch_tab looks its target up first
  assert.deepEqual(sent.map((c) => [c.type, c.payload.receipt]), [["switch_tab", RECEIPT], ["click", RECEIPT]]);
});
