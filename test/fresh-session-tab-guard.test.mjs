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
import { answerCloseByMarker, answerMarkerScan, isCloseByMarker, isMarkerScan } from "./fake-safari-scripts.mjs";

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
// and navigation with the tab it reached, reads included. A tab opened on a URL in `redirects`
// lands on its value.
function safariWindow(tabs, front = 1, redirects = {}) {
  const w = { tabs, ran: [] };
  const pageOf = (tab) => ({ name: tab.marker || "", __mcpTabMarker: tab.pageMarker });
  const url = (i) => tabs[i - 1]?.url || "";
  const site = (u) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return u; } };
  const tabOf = (target) => Number(/^tab (\d+) of (?:front window|window id 1)$/.exec(target)?.[1]) || front;
  const answer = (script) => {
    const page = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in (tab \d+ of (?:front window|window id 1)|front document)$/);
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
    // A marker scan, answered as Safari runs it (fake-safari-scripts.mjs), in `window id 1`.
    if (isMarkerScan(script)) return answerMarkerScan(script, { windowId: 1, tabs, pageOf });
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
    const load = script.match(/^tell application "Safari" to set URL of (tab \d+ of (?:front window|window id 1)|front document) to "([^"]*)"$/);
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
      const url = script.match(/URL:"([^"]*)"/)?.[1] || "about:blank";
      tabs.push({ url: redirects[url] || url, marker: null });
      return /index of t/.test(script) ? `1:${tabs.length}` : "";
    }
    const close = script.match(/close tab (\d+) of/);
    if (close) return void tabs.splice(Number(close[1]) - 1, 1);
    if (/count of tabs/.test(script)) return String(tabs.length);
    throw new Error(`the fake window does not answer this AppleScript:\n${script}`);
  };
  w.run = async (script) => {
    if (!isCloseByMarker(script)) return answer(script);
    // closeTabByMarker, answered as Safari runs it: one script, but two AppleEvents, the check that
    // finds the tab and `close tab i`. Another close can land between them, as in Safari.
    let at = -1;
    const answered = answerCloseByMarker(script, {
      tabs, pageOf, close: (i) => { at = i - 1; }, blank: (i) => { tabs[i - 1].url = "about:blank"; },
    });
    if (answered !== "closed") return answered;
    await new Promise((resolve) => setImmediate(resolve));
    tabs.splice(at, 1); // whichever tab is at that index by now
    return "closed";
  };
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

// The receipt helpers, the tab tracking (the per-session cap, a close forgetting its tab, shutdown
// cleanup), the tab-ownership sets, run_script's batch actions, and extensionOrFallback with its guard.
const indexParts = [
  between(index, "function _originOf(", "\nfunction _isBatchSemanticFailure"),
  between(index, "async function _closeTrackedTab(info) {", "\n// Periodic memory check"),
  between(index, "async function _closeOldestMCPTab(", "\nfunction _startMemoryMonitor("),
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
    MAX_TABS: 6, _sessionTabs: own._sessionTabs, _trackTab: own._trackTab, _untrackTab: own._untrackTab,
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
      cleanupTabs: _cleanupTabs,
      closeOldestMCPTab: _closeOldestMCPTab,
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

// run_script's newTab step claimed nothing for the tab it opened, where safari_new_tab claims its
// URL. safari.newTab() makes that URL the session's current one, so the step after newTab{url} was
// refused on the session's own tab: "current tab (...) was not opened by this MCP session"
// (29.9.26). A blank tab passed only because it has no URL to check. Once it has opened the tab,
// the step now claims the URL it asked for and keeps it as the session's current URL, wherever the
// page then redirected, as safari_new_tab does.
const NEXT_STEPS = [
  {
    step: { action: "navigate", args: { url: DEST } },
    ranInNewTab: (window) => window.tabs[1].url === DEST,
  },
  {
    step: { action: "click", args: { selector: "#send" } },
    ranInNewTab: (window) => window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")),
  },
];

for (const { step, ranInNewTab } of NEXT_STEPS) {
  test(`run_script opens a tab on a URL, and its ${step.action} step runs in that tab`, async () => {
    const { window, server } = await machine("clean");
    const steps = [{ action: "newTab", args: { url: OTHER_URL } }, step];
    const result = await outcome(() => server.safari_run_script({ steps }));
    assert.doesNotMatch(result, REFUSED);
    assert.doesNotMatch(result, /error/i);
    assert.ok(ranInNewTab(window), `${step.action} did not reach the tab newTab opened`);
    assert.deepEqual(window.ranIn(1), []);
  });

  test(`run_script's ${step.action} step runs in the tab newTab opened, after the page redirected`, async () => {
    const landed = "https://login.example.com/start"; // another origin, as a sign-in redirect lands
    const window = safariWindow([{ url: USER_URL, marker: null }], 1, { [OTHER_URL]: landed });
    const server = loadServer(loadSafari(window));
    const steps = [{ action: "newTab", args: { url: OTHER_URL } }, step];
    const result = await outcome(() => server.safari_run_script({ steps }));
    assert.doesNotMatch(result, REFUSED);
    assert.doesNotMatch(result, /error/i);
    assert.ok(ranInNewTab(window), `${step.action} did not reach the tab newTab opened`);
    assert.deepEqual(window.ranIn(1), []);
    // Like safari_new_tab, the step claims the URL it asked for. The site chose where the redirect
    // went, so that URL stays unclaimed: owned-tabs.json would vouch for any tab on it.
    assert.ok(own._ownedTabURLs.has(OTHER_URL));
    assert.ok(!own._ownedTabURLs.has(landed), "the step claimed a URL the site chose");
  });
}

test("a newTab step claims a URL with no scheme in its https:// form too, as a navigate step does", async () => {
  const { window, server } = await machine("clean");
  const steps = [
    { action: "newTab", args: { url: "dest.example.net/page" } },
    { action: "click", args: { selector: "#send" } },
  ];
  assert.doesNotMatch(await outcome(() => server.safari_run_script({ steps })), REFUSED);
  assert.ok(window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")));
  assert.ok(own._ownedTabURLs.has("dest.example.net/page"));
  assert.ok(own._ownedTabURLs.has("https://dest.example.net/page"));
});

test("a navigate step claims a URL with no scheme in its https:// form, which is what it loads", async () => {
  const { window, server } = await machine("clean");
  const steps = [
    { action: "newTab" },
    { action: "navigate", args: { url: "dest.example.net/page" } },
    { action: "click", args: { selector: "#send" } },
  ];
  assert.doesNotMatch(await outcome(() => server.safari_run_script({ steps })), REFUSED);
  assert.equal(window.tabs[1].url, "https://dest.example.net/page");
  assert.ok(window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")));
});

test("a newTab step claims its tab only once the tab exists", async () => {
  const window = safariWindow([{ url: USER_URL, marker: null }]);
  let open = false;
  const server = loadServer(loadSafari({
    ...window,
    run: async (script) => {
      if (!open && /make new (tab|document)/.test(script)) throw new Error("Safari got an error: AppleEvent timed out.");
      return window.run(script);
    },
  }));
  for (const args of [{}, { url: DEST }]) {
    const steps = [{ action: "newTab", args }, { action: "click", args: { selector: "#send" } }];
    assert.match(await outcome(() => server.safari_run_script({ steps })), REFUSED);
  }
  assert.equal(window.tabs.length, 1);
  assert.deepEqual([...own._ownedTabURLs], [], "a newTab step that opened no tab claimed one");
  assert.deepEqual(window.ranIn(1), []);
  // Once Safari opens it, a blank tab is claimed the way safari_new_tab claims one.
  open = true;
  assert.doesNotMatch(await outcome(() => server.safari_run_script({ steps: [{ action: "newTab" }] })), REFUSED);
  assert.ok(own._ownedTabURLs.has(own.BLANK_TAB_SENTINEL));
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

// ---------- 4. the tabs run_script opens are the session's to count, close and release ----------

// Without SAFARI_PROFILE, run_script's newTab step opened its tab through safari.newTab() and tracked
// nothing, where safari_new_tab tracks every tab it opens (29.9.26). The per-session tab cap counted
// none of a batch's tabs, so seven newTab steps and a safari_new_tab left eight tabs where seven
// safari_new_tab calls leave six. Shutdown cleanup and the memory sweep close only tracked tabs, so a
// batch's tabs outlived the MCP process, and a closeTab step released nothing: the URL its newTab had
// claimed stayed in owned-tabs.json. When safari.newTab() threw after the tab existed, neither
// safari_new_tab nor the step claimed or tracked the tab, though safari.js had already made it the
// session's current one: the next write was refused in it ("not opened by this MCP session"), and in
// run_script that refusal replaced the newTab step's own error.

const SESSION = "daemon:fresh"; // SESSION_ID:currentSessionId() for the session under test
const pageUrl = (n) => `https://dest.example.net/page${n}`;
const PAGES = [1, 2, 3, 4, 5, 6, 7].map(pageUrl);
const sessionTabUrls = () => own._sessionTabs(SESSION).map(([, info]) => info.url);

// A batch's step results.
async function batch(server, steps) {
  return JSON.parse((await server.safari_run_script({ steps })).content[0].text);
}

const OPENERS = [
  {
    name: "a run_script batch of seven newTab steps",
    open: (server) => batch(server, PAGES.map((url) => ({ action: "newTab", args: { url } }))),
  },
  {
    name: "seven run_script calls of one newTab step",
    open: async (server) => { for (const url of PAGES) await batch(server, [{ action: "newTab", args: { url } }]); },
  },
  {
    name: "seven safari_new_tab calls",
    open: async (server) => { for (const url of PAGES) await server.safari_new_tab({ url }); },
  },
];

for (const opener of OPENERS) {
  test(`${opener.name}, then safari_new_tab, leave the session six tabs, closing the oldest first`, async () => {
    const { window, server } = await machine("clean");
    await opener.open(server);
    assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, ...PAGES.slice(1)]);
    await server.safari_new_tab({ url: OTHER_URL });
    assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, ...PAGES.slice(2), OTHER_URL]);
    assert.deepEqual(sessionTabUrls(), [...PAGES.slice(2), OTHER_URL]);
  });
}

test("a newTab step that closed the session's oldest tab says so, as safari_new_tab does", async () => {
  const { server } = await machine("clean");
  const results = await batch(server, PAGES.map((url) => ({ action: "newTab", args: { url } })));
  assert.ok(results.every((r) => !r.error), JSON.stringify(results));
  assert.ok(results.slice(0, 6).every((r) => !r.result.evictedTab), "a step below the cap reported a closed tab");
  assert.deepEqual(results[6].result.evictedTab, { safeUrl: pageUrl(1) });
  assert.match(results[6].result.note, /Tab cap 6\/session reached — your oldest tab \(opened on https:\/\/dest\.example\.net\/page1\) was closed/);
  assert.equal(results[6].result.tabIndex, 7, "the step's own result is still there");
});

test("shutdown cleanup closes the tabs run_script opened, and only those", async () => {
  const { window, server } = await machine("clean");
  await batch(server, [{ action: "newTab", args: { url: OTHER_URL } }, { action: "newTab" }]);
  assert.equal(window.tabs.length, 3);
  await server.cleanupTabs();
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL]);
});

test("a closeTab step releases what its tab's newTab step claimed, and the tab stops counting", async () => {
  const { window, server } = await machine("clean");
  const results = await batch(server, [
    { action: "newTab", args: { url: OTHER_URL } },
    { action: "newTab", args: { url: DEST } },
    { action: "closeTab" },
  ]);
  assert.ok(results.every((r) => !r.error), JSON.stringify(results));
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, OTHER_URL]);
  assert.ok(!own._ownedTabURLs.has(DEST), "the closed tab's URL is still claimed");
  assert.ok(own._ownedTabURLs.has(OTHER_URL), "the tab still open lost its claim");
  assert.deepEqual(sessionTabUrls(), [OTHER_URL]);
});

test("safari_close_tab releases a tab run_script opened", async () => {
  const { window, server } = await machine("clean");
  await batch(server, [{ action: "newTab", args: { url: OTHER_URL } }]);
  assert.doesNotMatch(await outcome(() => server.safari_close_tab({})), REFUSED_ANYWHERE);
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL]);
  assert.ok(!own._ownedTabURLs.has(OTHER_URL));
  assert.deepEqual(sessionTabUrls(), []);
});

// safari.newTab() ends by reading the new tab's title and URL. Here that read runs, but its answer
// never comes back, as when the AppleEvent times out: by then the tab exists, and safari.js has made
// it the session's current tab.
function lastReadTimesOut(window) {
  return {
    ...window,
    run: async (script) => {
      const answer = await window.run(script);
      if (/title:document\.title,url:location\.href,tabIndex:/.test(script)) {
        throw new Error("Safari got an error: AppleEvent timed out.");
      }
      return answer;
    },
  };
}

test("a newTab step that fails after opening its tab: the batch goes on there and keeps the step's error", async () => {
  const window = safariWindow([{ url: USER_URL, marker: null }]);
  const server = loadServer(loadSafari(lastReadTimesOut(window)));
  const result = await outcome(() => server.safari_run_script({ steps: [
    { action: "newTab", args: { url: OTHER_URL } },
    { action: "click", args: { selector: "#send" } },
  ] }));
  assert.doesNotMatch(result, REFUSED);
  assert.match(result, /AppleEvent timed out/, "the newTab step's own error was lost");
  assert.ok(window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")), "the click did not reach the new tab");
  assert.deepEqual(window.ranIn(1), []);
  // The tab is the session's like any other it opened: claimed, counted, closed at shutdown.
  assert.ok(own._ownedTabURLs.has(OTHER_URL));
  assert.deepEqual(sessionTabUrls(), [OTHER_URL]);
  await server.cleanupTabs();
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL]);
});

test("safari_new_tab that fails after opening its tab: the session's next write goes to that tab", async () => {
  const window = safariWindow([{ url: USER_URL, marker: null }]);
  const server = loadServer(loadSafari(lastReadTimesOut(window)));
  assert.match(await outcome(() => server.safari_new_tab({ url: OTHER_URL })), /AppleEvent timed out/);
  assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#send" })), REFUSED);
  assert.ok(window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")), "the click did not reach the new tab");
  assert.deepEqual(window.ranIn(1), []);
  assert.deepEqual(sessionTabUrls(), [OTHER_URL]);
  await server.cleanupTabs();
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL]);
});

test("a newTab step that opened no tab claims and tracks nothing, in a session that already has a tab", async () => {
  const window = safariWindow([{ url: USER_URL, marker: null }]);
  let open = true;
  const server = loadServer(loadSafari({
    ...window,
    run: async (script) => {
      if (!open && /make new (tab|document)/.test(script)) throw new Error("Safari got an error: AppleEvent timed out.");
      return window.run(script);
    },
  }));
  await batch(server, [{ action: "newTab", args: { url: OTHER_URL } }]);
  open = false;
  const results = await batch(server, [{ action: "newTab", args: { url: DEST } }]);
  assert.match(results[0].error, /AppleEvent timed out/);
  assert.equal(window.tabs.length, 2);
  assert.ok(!own._ownedTabURLs.has(DEST), "a newTab step that opened no tab claimed its URL");
  assert.deepEqual(sessionTabUrls(), [OTHER_URL], "the session's tab was re-recorded under the URL of a tab that never opened");
});

test("a newTab step claims nothing when the session's tab closed while it failed to open one", async () => {
  // Two calls of one session in parallel: safari_close_tab closes the session's tab while the newTab
  // step's AppleEvent is still out, and that AppleEvent then fails. The session's marker changed during
  // the step, to none; no tab was opened, so there is nothing to claim or track.
  const window = safariWindow([{ url: USER_URL, marker: null }]);
  let answerCreation;
  const creation = new Promise((resolve) => { answerCreation = resolve; });
  let hold = false;
  const server = loadServer(loadSafari({
    ...window,
    run: async (script) => {
      if (hold && /make new (tab|document)/.test(script)) {
        await creation;
        throw new Error("Safari got an error: AppleEvent timed out.");
      }
      return window.run(script);
    },
  }));
  await batch(server, [{ action: "newTab", args: { url: OTHER_URL } }]);
  hold = true;
  const opening = batch(server, [{ action: "newTab", args: { url: DEST } }]);
  await new Promise((resolve) => setImmediate(resolve)); // the step is waiting on its AppleEvent
  assert.doesNotMatch(await outcome(() => server.safari_close_tab({})), REFUSED_ANYWHERE);
  answerCreation();
  const [step] = await opening;
  assert.match(step.error, /AppleEvent timed out/);
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL]);
  assert.ok(!own._ownedTabURLs.has(DEST), "a newTab step that opened no tab claimed its URL");
  assert.deepEqual(sessionTabUrls(), []);
});

test("a tab the extension opens is not recorded under the marker of the session's AppleScript tab", async () => {
  // safari.js keeps the marker of the tab AppleScript opened last. Recorded for a tab the extension
  // opened, it names that earlier tab, and cleanup or the cap would close it in the new one's place.
  let opened = 0;
  const extension = {
    name: "an extension that fails once",
    connected: true,
    send: async (type, payload) => {
      if (type !== "new_tab") return `${type} done`;
      if (++opened === 1) throw Object.assign(new Error("Timeout waiting for the extension (new_tab)"), { dispatched: false });
      return { title: "", safeUrl: payload.url, receipt: RECEIPT, tabIndex: 3 };
    },
  };
  const { server } = await machine("clean", extension);
  await server.safari_new_tab({ url: OTHER_URL }); // through AppleScript: the session holds its marker
  await server.safari_new_tab({ url: DEST }); // through the extension
  const [[, first], [key, second]] = own._sessionTabs(SESSION);
  assert.match(first.marker, /^MCP_/);
  assert.deepEqual([key, second.marker], [RECEIPT, ""]);
});

// ---------- 5. parallel calls of one session ----------

// A session's calls can run at once (subagents share its connection), and each changes the session's
// tab state in safari.js. Opening a tab and closing one both reach it.

const BANK = "https://bank.example.com/transfer"; // a tab of the user's, right behind the session's oldest

// SAFARI_MCP_ALLOW_USER_TABS: a switch of the same session that adopts the user's tab while a newTab is
// out changes the session's marker too, to the adoption marker (MCP_A...). The opener took that for its
// own tab's marker and recorded the user's tab, which the cap, the memory sweep and cleanup close.
const ADOPTION_RACES = [
  { when: "the tab's creation fails", hold: /make new tab/, fails: true },
  { when: "its page is still loading", hold: /"document\.readyState"/, fails: false },
];
const OPENS = [
  { name: "a run_script newTab step", open: (server) => server.safari_run_script({ steps: [{ action: "newTab", args: { url: DEST } }] }) },
  { name: "safari_new_tab", open: (server) => server.safari_new_tab({ url: DEST }) },
];
for (const race of ADOPTION_RACES) {
  for (const opener of OPENS) {
    test(`${opener.name} records nothing of the user's tab that a parallel switch adopted while ${race.when}`, async () => {
      const flag = process.env.SAFARI_MCP_ALLOW_USER_TABS;
      process.env.SAFARI_MCP_ALLOW_USER_TABS = "1";
      try {
        const window = safariWindow([{ url: USER_URL, marker: null }]);
        let answer;
        const held = new Promise((resolve) => { answer = resolve; });
        let holding = true; // the first matching AppleEvent only
        const server = loadServer(loadSafari({
          ...window,
          run: async (script) => {
            if (holding && race.hold.test(script)) {
              holding = false;
              await held;
              if (race.fails) throw new Error("Safari got an error: AppleEvent timed out.");
            }
            return window.run(script);
          },
        }));
        const opening = outcome(() => opener.open(server));
        await new Promise((resolve) => setImmediate(resolve)); // the opener waits on its AppleEvent
        assert.match(await outcome(() => server.safari_switch_tab({ index: 1 })), /user tab, opted-in/);
        answer();
        await opening;
        assert.deepEqual(own._sessionTabs(SESSION).filter(([, info]) => info.marker.startsWith("MCP_A")), [], "the adopted tab was recorded");
        if (race.fails) assert.ok(!own._ownedTabURLs.has(DEST), "a tab that never opened had its URL claimed");
        await server.cleanupTabs();
        assert.equal(window.tabs[0].url, USER_URL, "cleanup closed the user's tab");
      } finally {
        if (flag === undefined) delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
        else process.env.SAFARI_MCP_ALLOW_USER_TABS = flag;
      }
    });
  }
}

// Nothing records an adopted tab among the tabs a session opened; should one get there anyway, the
// paths that close those tabs still leave it open.
const ADOPTED = "MCP_Asess0001_adopted";
for (const path of [
  { name: "the memory sweep", run: (server) => server.closeOldestMCPTab() },
  { name: "the tab cap", run: async (server) => { for (const url of PAGES.slice(0, 6)) await server.safari_new_tab({ url }); } },
  { name: "shutdown cleanup", run: (server) => server.cleanupTabs() },
]) {
  test(`${path.name} never closes a tab that carries an adoption marker`, async () => {
    const { window, server } = await machine("clean");
    window.tabs[0].marker = ADOPTED;
    own._trackTab(1, USER_URL, SESSION, ADOPTED); // the oldest record of the session
    await path.run(server);
    assert.equal(window.tabs[0].url, USER_URL, `${path.name} closed the adopted tab`);
    assert.equal(window.tabs[0].marker, ADOPTED);
  });
}

// The session has six tabs and the user has a tab right behind the oldest: [USER, page1, BANK,
// page2..page6]. Each closer below closes page1: an opener through the tab cap, the memory sweep as
// the oldest tab, cleanup with the rest. A close found page1 by its marker at index 2 and closed
// index 2 a few AppleEvents later, and a parallel close in between had moved BANK there.
async function sessionAtTheCap() {
  const machineState = await machine("clean");
  for (const url of PAGES.slice(0, 6)) await machineState.server.safari_new_tab({ url });
  machineState.window.tabs.splice(2, 0, { url: BANK, marker: null });
  return machineState;
}
const CLOSERS = [
  { name: "a run_script newTab step", run: (server) => batch(server, [{ action: "newTab", args: { url: OTHER_URL } }]) },
  { name: "safari_new_tab", run: (server) => server.safari_new_tab({ url: DEST }) },
  { name: "the memory sweep", run: (server) => server.closeOldestMCPTab() },
  { name: "shutdown cleanup", run: (server) => server.cleanupTabs() },
];
for (const [i, first] of CLOSERS.entries()) {
  for (const second of CLOSERS.slice(i)) {
    if (first === second && first.name === "shutdown cleanup") continue;
    test(`${first.name} and ${second.name} at once close the session's oldest tab, never the user's behind it`, async () => {
      const { window, server } = await sessionAtTheCap();
      // An opener can still fail here: closes renumber the window under newTab(), which finds its new
      // tab by index. The user's tab is the point.
      await Promise.allSettled([first.run(server), second.run(server)]);
      assert.ok(window.tabs.some((t) => t.url === BANK), "a close landed on the user's tab");
      assert.ok(!window.tabs.some((t) => t.url === pageUrl(1)), "the session's oldest tab is still open");
    });
  }
}

// The current tab sits before the oldest, so closing it moves the oldest, and the tab behind it.
for (const close of [
  { name: "safari_close_tab", run: (server) => server.safari_close_tab({}) },
  { name: "a run_script closeTab step", run: (server) => batch(server, [{ action: "closeTab" }]) },
]) {
  test(`${close.name} on the current tab and an eviction at once leave the user's tab open`, async () => {
    const { window, server } = await sessionAtTheCap();
    window.tabs.splice(1, 0, ...window.tabs.splice(3, 1)); // [USER, page2, page1, BANK, page3..page6]
    await server.safari_switch_tab({ index: 2 });
    await Promise.allSettled([close.run(server), server.safari_new_tab({ url: DEST })]);
    assert.ok(window.tabs.some((t) => t.url === BANK), "a close landed on the user's tab");
    assert.ok(!window.tabs.some((t) => t.url === pageUrl(1) || t.url === pageUrl(2)), "a close did not happen");
  });
}

// ---------- 6. a URL two tabs share ----------

test("closing one of two tabs on the same URL leaves the other one writable", async () => {
  const { window, server } = await machine("clean");
  const result = await outcome(() => server.safari_run_script({ steps: [
    { action: "newTab", args: { url: DEST } },
    { action: "newTab", args: { url: DEST } },
    { action: "closeTab" },
    { action: "switchTab", args: { index: 2 } },
    { action: "click", args: { selector: "#send" } },
  ] }));
  assert.doesNotMatch(result, REFUSED);
  assert.ok(window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")), "the click did not reach the tab left open");
  assert.ok(own._ownedTabURLs.has(DEST));
});

test("another session closing its tab on a URL leaves this session's tab on it writable", async () => {
  const { window, server } = await machine("clean");
  await server.safari_new_tab({ url: DEST });
  sid = "other";
  await batch(server, [{ action: "newTab", args: { url: DEST } }, { action: "closeTab" }]);
  sid = "fresh";
  assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#send" })), REFUSED);
  assert.ok(window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")));
});

for (const via of [
  { name: "a closeTab step", open: (s, url) => batch(s, [{ action: "newTab", args: { url } }]), close: (s) => batch(s, [{ action: "closeTab" }]) },
  { name: "safari_close_tab", open: (s, url) => s.safari_new_tab({ url }), close: (s) => s.safari_close_tab({}) },
]) {
  test(`${via.name} releases both forms a tab opened on a URL with no scheme claimed`, async () => {
    const { window, server } = await machine("clean");
    await via.open(server, "dest.example.net/page");
    assert.ok(own._ownedTabURLs.has("https://dest.example.net/page"));
    await via.close(server);
    assert.equal(window.tabs.length, 1);
    assert.deepEqual([...own._ownedTabURLs], []);
  });
}

test("safari_close_tab waiting behind another close keeps the tab that was current when it was called recorded", async () => {
  // A close waits for its turn (_oneCloseAtATime), and the session's current tab can change meanwhile.
  // closeTab() closes the tab current when the turn comes, so that is the marker to forget: the one
  // current at the call is still open, and forgetting it let it escape the cap and cleanup.
  const window = safariWindow([{ url: USER_URL, marker: null }]);
  let answer;
  const held = new Promise((resolve) => { answer = resolve; });
  let hold = false;
  const server = loadServer(loadSafari({
    ...window,
    run: async (script) => {
      if (hold && /window\.name==='/.test(script)) { hold = false; await held; } // the sweep's marker scan
      return window.run(script);
    },
  }));
  for (const url of PAGES.slice(0, 3)) await server.safari_new_tab({ url }); // page3 is current
  hold = true;
  const sweeping = server.closeOldestMCPTab(); // page1, waiting on its scan
  await new Promise((resolve) => setImmediate(resolve));
  const closing = server.safari_close_tab({}); // waits for the sweep
  await new Promise((resolve) => setImmediate(resolve));
  await server.safari_switch_tab({ index: 3 }); // page2 becomes current meanwhile
  answer();
  await Promise.all([sweeping, closing]);
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, pageUrl(3)]);
  // The switch kept page2's marker (section 7), so the close forgot page2, and only page2.
  assert.deepEqual(sessionTabUrls(), [pageUrl(3)], "the close forgot the tab still open, or not the one it closed");
});

test("safari_close_tab waiting behind another close keeps the tab the session switched to meanwhile current", async () => {
  // Closing by the receipt that was current when the call came, it clears the session's current
  // receipt only if that tab is still the current one when the close runs.
  const receipts = ["ReceiptO_", "ReceiptA_", "ReceiptB_"].map((r) => r + "x".repeat(24));
  const [RO, RA, RB] = receipts;
  let opened = 0;
  let answerClose;
  const heldClose = new Promise((resolve) => { answerClose = resolve; });
  const extension = {
    name: "a working extension",
    connected: true,
    send: async (type, payload) => {
      if (type === "new_tab") return { title: "", safeUrl: payload.url, receipt: receipts[opened++], tabIndex: 1 + opened };
      if (type === "switch_tab") {
        const at = receipts.indexOf(payload.receipt);
        return { title: "", safeUrl: PAGES[at], receipt: payload.receipt, tabIndex: 2 + at, owned: true };
      }
      if (type === "close_tab" && payload.receipt === RO) await heldClose; // the sweep's close, still out
      return `${type} done`;
    },
  };
  const { server } = await machine("clean", extension);
  for (const url of PAGES.slice(0, 3)) await server.safari_new_tab({ url });
  await server.safari_switch_tab({ receipt: RA });
  const sweeping = server.closeOldestMCPTab(); // the oldest tab, RO
  await new Promise((resolve) => setImmediate(resolve));
  const closing = server.safari_close_tab({}); // RA, the current tab when called
  await new Promise((resolve) => setImmediate(resolve));
  await server.safari_switch_tab({ receipt: RB }); // meanwhile the session moves on to RB
  answerClose();
  await Promise.all([sweeping, closing]);
  await server.safari_click({ selector: "#send" });
  const closes = server.commands.filter((c) => c.type === "close_tab").map((c) => c.payload.receipt);
  assert.deepEqual(closes, [RO, RA]);
  assert.equal(server.commands.at(-1).payload.receipt, RB, "the session lost the receipt of its current tab");
});

// ---------- 7. a tab the session switches to keeps the marker it is recorded by ----------

// The server records a tab AppleScript opened by the marker stamped on it then, and finds it by that
// marker to close it: the tab cap, the memory sweep, shutdown cleanup, and a close forgetting the tab
// it closed. A switch by index stamped a fresh marker on the tab even when it already carried one of
// the session's own (30.9.26), so nothing found the tab by its record any more. Cleanup left it open,
// the cap and the sweep dropped it from the count as gone and left it open too, and a close forgot
// nothing, so the record stayed and the URL the tab was opened on stayed claimed.

const SWITCHES = [
  { name: "safari_switch_tab", to: (server, index) => server.safari_switch_tab({ index }) },
  { name: "a run_script switchTab step", to: (server, index) => batch(server, [{ action: "switchTab", args: { index } }]) },
];

// The session opens OTHER_URL (tab 2), then DEST (tab 3), and switches back to tab 2.
async function switchedBack(sw) {
  const state = await machine("clean");
  await state.server.safari_new_tab({ url: OTHER_URL });
  await state.server.safari_new_tab({ url: DEST });
  assert.doesNotMatch(await outcome(() => sw.to(state.server, 2)), REFUSED_ANYWHERE);
  assert.equal(state.safari.getActiveTabMarker(), state.window.tabs[1].marker, "the switch did not land on tab 2");
  return state;
}

for (const sw of SWITCHES) {
  test(`shutdown cleanup closes a tab the session moved back to with ${sw.name}`, async () => {
    const { window, server } = await switchedBack(sw);
    await server.cleanupTabs();
    assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL]);
  });

  test(`the memory sweep closes the session's oldest tab after ${sw.name} moved to it`, async () => {
    const { window, server } = await switchedBack(sw);
    await server.closeOldestMCPTab();
    assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, DEST]);
    assert.deepEqual(sessionTabUrls(), [DEST]);
  });

  test(`the tab cap closes the session's oldest tab after ${sw.name} moved to it`, async () => {
    const { window, safari, server } = await machine("clean");
    for (const url of PAGES.slice(0, 6)) await server.safari_new_tab({ url });
    await sw.to(server, 2); // page1, the oldest
    assert.equal(safari.getActiveTabMarker(), window.tabs[1].marker, "the switch did not land on page1");
    await server.safari_new_tab({ url: OTHER_URL });
    assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, ...PAGES.slice(1, 6), OTHER_URL]);
    assert.deepEqual(sessionTabUrls(), [...PAGES.slice(1, 6), OTHER_URL]);
  });

  for (const close of [
    { name: "safari_close_tab", run: (server) => server.safari_close_tab({}) },
    { name: "a run_script closeTab step", run: (server) => batch(server, [{ action: "closeTab" }]) },
  ]) {
    test(`${close.name} after ${sw.name} forgets the tab it closed and releases its URL`, async () => {
      const { window, server } = await switchedBack(sw);
      assert.doesNotMatch(await outcome(() => close.run(server)), REFUSED_ANYWHERE);
      assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, DEST]);
      assert.deepEqual(sessionTabUrls(), [DEST], "the closed tab is still recorded");
      assert.ok(!own._ownedTabURLs.has(OTHER_URL), "the closed tab's URL is still claimed");
      assert.ok(own._ownedTabURLs.has(DEST));
    });
  }
}

test("moving between the session's tabs by index keeps the marker each one is recorded by", async () => {
  const { window, safari, server } = await machine("clean");
  await server.safari_new_tab({ url: OTHER_URL });
  await server.safari_new_tab({ url: DEST });
  const recorded = own._sessionTabs(SESSION).map(([, info]) => info.marker);
  for (const index of [2, 3, 2]) {
    await server.safari_switch_tab({ index });
    assert.equal(safari.getActiveTabMarker(), recorded[index - 2]);
  }
  assert.deepEqual(window.tabs.map((t) => t.marker), [null, ...recorded]);
});

// A tab with no marker of the session's, which safari_wait_for_new_tab claims or safari_switch_tab
// adopts, gets a new one. Stamping the session's current marker there instead would have two tabs
// carry it, and a scan for it could find either.
test("a claim marks a tab that carries no marker with a fresh one, not one another tab carries", async () => {
  const { window, safari, server } = await machine("clean");
  await server.safari_new_tab({ url: OTHER_URL });
  window.tabs.push({ url: DEST, marker: null }); // a tab the session's page opened
  await safari.switchTab(3, { claim: true });
  const [, mine, claimed] = window.tabs.map((t) => t.marker);
  assert.equal(claimed, safari.getActiveTabMarker());
  assert.match(claimed, /^MCP_sess0001_\w+$/);
  assert.notEqual(claimed, mine);
});

// The page keeps the marker in window.__mcpTabMarker while it uses window.name for itself, until it
// loads its next page. The switch puts the marker back in window.name, which that load keeps.
test("a switch keeps the marker a page left in __mcpTabMarker after taking window.name over, and puts it back", async () => {
  const { window, server } = await machine("clean");
  await server.safari_new_tab({ url: OTHER_URL });
  await server.safari_new_tab({ url: DEST });
  const tab = window.tabs[1];
  const recorded = tab.marker;
  tab.marker = "app-state"; // the page wrote window.name for its own use
  assert.doesNotMatch(await outcome(() => server.safari_switch_tab({ index: 2 })), REFUSED_ANYWHERE);
  assert.equal(tab.marker, recorded);
  tab.pageMarker = undefined; // the page loads another page of its site: window.name survives, __mcpTabMarker does not
  await server.cleanupTabs();
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL]);
});

// The marker a switch keeps comes from the page, and every later marker scan writes it into
// AppleScript source, where a quote ends the string: a page that writes one after the session's
// prefix (which it can read in its own window.name) would have AppleScript of its own run.
// It ends in a word character, as a whole marker does, so only the ^ of each check stops it.
const INJECTED = 'MCP_sess0001_x" & (do shell script "echo INJECTED") & "x';

// A Safari window whose scripts are all kept, with the session and the server that drive it.
function recordedSession(answer = (script, window) => window.run(script)) {
  const window = safariWindow([{ url: USER_URL, marker: null }]);
  const scripts = [];
  const safari = loadSafari({ ...window, run: async (script) => { scripts.push(script); return answer(script, window); } });
  return { window, scripts, safari, server: loadServer(safari) };
}
const ranInjected = (scripts) => scripts.some((s) => s.includes("do shell script"));

test("a switch keeps the session's own marker, not a quoted one the page wrote after the session's prefix", async () => {
  const { window, scripts, safari, server } = recordedSession();
  await server.safari_new_tab({ url: OTHER_URL });
  await server.safari_new_tab({ url: DEST });
  const tab = window.tabs[1];
  const recorded = tab.marker;
  tab.marker = INJECTED; // __mcpTabMarker still holds the session's marker
  assert.doesNotMatch(await outcome(() => server.safari_switch_tab({ index: 2 })), REFUSED_ANYWHERE);
  assert.equal(safari.getActiveTabMarker(), recorded);
  assert.equal(tab.marker, recorded);
  assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#send" })), REFUSED_ANYWHERE);
  assert.ok(window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")));
  await server.cleanupTabs();
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL]);
  assert.ok(!ranInjected(scripts), "a marker the page wrote reached AppleScript");
});

// Its prefix is still the session's, and the switch takes the tab as it did before, with a marker
// the session mints for it.
test("a tab whose page wrote a quoted marker after the session's prefix gets a fresh one", async () => {
  const { window, scripts, safari, server } = recordedSession();
  await server.safari_new_tab({ url: OTHER_URL });
  await server.safari_new_tab({ url: DEST });
  Object.assign(window.tabs[1], { marker: INJECTED, pageMarker: undefined }); // nothing else of the session's on it
  assert.doesNotMatch(await outcome(() => server.safari_switch_tab({ index: 2 })), REFUSED_ANYWHERE);
  const marker = safari.getActiveTabMarker();
  assert.match(marker, /^MCP_sess0001_\w+$/);
  assert.equal(window.tabs[1].marker, marker);
  assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#send" })), REFUSED_ANYWHERE);
  assert.ok(window.ranIn(2).some((r) => r.js?.endsWith("/*page:click*/")));
  assert.ok(!ranInjected(scripts), "a marker the page wrote reached AppleScript");
});

// An adopted tab keeps the adoption family, and the switch marks it with the session's own adoption
// marker: whatever marker the page answers with next to adopted: true is never used.
test("a switch whose page answers that it is adopted takes the session's adoption marker, never the page's", async () => {
  let forge = false;
  const { scripts, safari, server } = recordedSession((script, win) => (forge && /adopted:/.test(script)
    ? JSON.stringify({ title: "", url: OTHER_URL, adopted: true, marker: INJECTED })
    : win.run(script)));
  await server.safari_new_tab({ url: OTHER_URL });
  await server.safari_new_tab({ url: DEST });
  forge = true;
  for (const sw of SWITCHES) {
    await outcome(() => sw.to(server, 2));
    assert.match(safari.getActiveTabMarker(), /^MCP_Asess0001_\w+$/);
  }
  await outcome(() => server.safari_click({ selector: "#send" })); // no tab carries that marker: refused
  await server.cleanupTabs();
  assert.ok(!scripts.some((s) => s.includes(INJECTED)), "a marker the page answered with reached AppleScript");
});

// The switch's script runs in the page, which can answer anything.
for (const forged of [
  { name: "a quoted marker", marker: INJECTED },
  { name: "another session's marker", marker: "MCP_othr0002_x" }, // the prefix is per session (#76)
]) {
  test(`a switch refuses a tab whose page answers with ${forged.name}`, async () => {
    let forge = false;
    const { window, scripts, safari, server } = recordedSession((script, win) => (forge && /adopted:/.test(script)
      ? JSON.stringify({ title: "", url: OTHER_URL, adopted: false, marker: forged.marker })
      : win.run(script)));
    await server.safari_new_tab({ url: OTHER_URL });
    await server.safari_new_tab({ url: DEST });
    const current = safari.getActiveTabMarker();
    forge = true;
    for (const sw of SWITCHES) assert.match(await outcome(() => sw.to(server, 2)), REFUSED);
    assert.equal(safari.getActiveTabMarker(), current);
    await server.safari_click({ selector: "#send" });
    assert.ok(window.ranIn(3).some((r) => r.js?.endsWith("/*page:click*/")), "the session left its tab");
    assert.ok(!scripts.some((s) => s.includes(forged.marker)), "a marker the page answered with reached AppleScript");
  });
}

// safari_wait_for_new_tab claims the tab it saw open (switchTab with `claim`), and the claim stamped the
// session's own marker over one another MCP session had put there (30.9.26): that session lost its tab,
// and a tab it had adopted from the user lost the adoption marker that keeps it from being closed, so
// the claiming session's tab cap, sweep, cleanup or safari_close_tab could close the user's tab.
for (const other of [
  { name: "another session's tab", marker: "MCP_othr0002_x" },
  { name: "a tab another session adopted from the user", marker: "MCP_Aothr0002_x" },
]) {
  for (const where of [
    { name: "in window.name", tab: (m) => ({ marker: m, pageMarker: undefined }) }, // the page loaded another page of its site since
    { name: "in __mcpTabMarker", tab: (m) => ({ marker: "app-state", pageMarker: m }) }, // the page took window.name over
  ]) {
    test(`a claim does not take ${other.name}, its marker ${where.name}`, async () => {
      const { window, safari, server } = await machine("clean");
      await server.safari_new_tab({ url: OTHER_URL });
      const current = safari.getActiveTabMarker();
      const tab = { url: DEST, ...where.tab(other.marker) };
      window.tabs.push(tab);
      const before = { ...tab };
      // Flagged, so safari_wait_for_new_tab passes over the tab and keeps waiting for its own.
      await assert.rejects(safari.switchTab(3, { claim: true }),
        (err) => /Tab safety: refusing to claim tab 3/.test(err.message) && err.otherSession === true);
      assert.deepEqual(tab, before, "the claim changed the other session's tab");
      assert.equal(safari.getActiveTabMarker(), current, "the session moved to the tab it did not claim");
      // The session's own tab is still claimed, and keeps its marker.
      await safari.switchTab(2, { claim: true });
      assert.equal(safari.getActiveTabMarker(), current);
    });
  }
}

// safari_wait_for_new_tab claims the tab at the index its listing saw the new one at. A tab closing to
// its left in between slid another tab under that index, the user's included, and the claim stamped
// the session's marker on it (30.9.26). Given the URL the listing saw, the claim refuses first.
test("a claim refuses the tab at the index once it no longer shows the page the listing saw", async () => {
  const { window, safari, server } = await machine("clean");
  await server.safari_new_tab({ url: OTHER_URL });
  const current = safari.getActiveTabMarker();
  const popup = "https://sso.example.net/authorize";
  window.tabs.push({ url: popup, marker: null }, { url: BANK, marker: null }); // the listing saw the popup at 3
  window.tabs.splice(0, 1); // the user closes the tab to its left: their bank tab is at 3 now
  await assert.rejects(safari.switchTab(3, { claim: true, expectUrl: popup }),
    (err) => /Tab safety: refusing to claim tab 3/.test(err.message) && err.moved === true);
  assert.equal(window.tabs[2].marker, null, "the claim marked the user's tab");
  assert.equal(safari.getActiveTabMarker(), current);
  // At the index the popup is at now, the claim goes through.
  await safari.switchTab(2, { claim: true, expectUrl: popup });
  assert.equal(window.tabs[1].marker, safari.getActiveTabMarker());
});

test("a claim compares the page with a listed URL that has a quote and a backslash in it", async () => {
  const { window, safari, server } = await machine("clean");
  await server.safari_new_tab({ url: OTHER_URL });
  const listed = "https://sso.example.net/authorize?next=it's\\here";
  window.tabs.push({ url: listed, marker: null });
  await safari.switchTab(3, { claim: true, expectUrl: listed });
  assert.equal(window.tabs[2].marker, safari.getActiveTabMarker());
});
