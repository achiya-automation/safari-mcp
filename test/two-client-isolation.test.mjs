#!/usr/bin/env node
/**
 * Session isolation, end to end on the server side (#84): two MCP clients and the user share one
 * Safari window, and each client reads and acts only in the tabs it opened, never in the other
 * client's and never in the user's.
 *
 * The README promises this for several agents on one daemon (SAFARI_MCP_HTTP=1): one node process,
 * one set of ownership state, many sessions. The pieces that keep it true each have their own test
 * (the extension's routing in multi-session-isolation, the per-session cap in close-by-marker and
 * fresh-session-tab-guard, the matching rules in ownership-match). This file runs them together, as
 * two clients take turns, so a change to any one of them that lets a session's command land in a
 * tab it does not own fails here.
 *
 * Default mode (no SAFARI_PROFILE) with the extension absent, so every command goes through the
 * AppleScript fallback, where the server itself, not the extension, has to find the session's tab.
 * Both sides are the real code, lifted from index.js and safari.js the way
 * test/fresh-session-tab-guard.test.mjs lifts them, over a fake Safari window that runs each page
 * script against its tab. Each session mints its own marker id, as in a real process.
 *
 * What this does not cover: the head of the identity chain the issue names (agent, runner, MCP
 * client, Mcp-Session-Id). Here the session id is given; test/transport-http.test.mjs covers how
 * the daemon assigns one.
 *
 * Run:  node --test test/two-client-isolation.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import {
  answerCloseByMarker, answerCreationScript, answerMarkerScan, answerTabScript, isCloseByMarker, isMarkerScan, isTabScript,
} from "./fake-safari-scripts.mjs";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-isolation-"));
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
  sid = "";
});

const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

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
  // Page JavaScript in `tab`, recorded in `ran` unless `keep(value)` says the page refused it.
  const runIn = (tab, js, keep = () => true) => {
    const entry = { tab: tabs.indexOf(tab) + 1, js };
    w.ran.push(entry);
    const win = { name: tab.marker || "", __mcpTabMarker: tab.pageMarker };
    const document = { title: "", readyState: "complete", body: { innerText: `text of ${tab.url}` }, addEventListener() {} };
    let value;
    try {
      const performance = { timeOrigin: tab.born ?? 0 };
      value = String(vm.runInNewContext(js, { window: win, document, location: { href: tab.url }, performance }) ?? "");
      return value;
    } finally {
      tab.marker = win.name || null;
      tab.pageMarker = win.__mcpTabMarker;
      if (value !== undefined && !keep(value)) w.ran.splice(w.ran.indexOf(entry), 1);
    }
  };
  // A new page: __mcpTabMarker goes with the old one, and window.name too across sites.
  const loadInto = (tab, next) => {
    if (site(tab.url) !== site(next)) tab.marker = null;
    tab.pageMarker = undefined;
    w.ran.push({ tab: tabs.indexOf(tab) + 1, navigate: next });
    tab.url = next;
    tab.born = Date.now(); // the new document's performance.timeOrigin
  };
  const answer = (script) => {
    const page = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in (tab \d+ of (?:front window|window id 1)|front document)$/);
    if (page) {
      const i = tabOf(page[2]);
      const tab = tabs[i - 1];
      if (!tab) throw new Error(`Safari got an error: Can't get tab ${i} of window 1.`);
      return runIn(tab, page[1].replace(/\\(["\\])/g, "$1"));
    }
    // A load step's script in the tab it proved (safari.js _inTab), whose selected tab is `front`.
    if (isTabScript(script)) {
      return answerTabScript(script, {
        windowId: 1, tabs, pageOf, run: (tab, js) => runIn(tab, js, (v) => v.startsWith("MCP_OK:")), setURL: loadInto,
        urlOf: (t) => t.url, visibleOf: (t) => tabs.indexOf(t) + 1 === front,
      });
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
    if (load) return void loadInto(tabs[tabOf(load[1]) - 1], load[2]);
    if (/make new tab/.test(script)) {
      // newTab() opens a background tab: the user's tab stays in front. The script that makes it
      // reports where it is and stamps it (fake-safari-scripts.mjs).
      const url = script.match(/URL:"([^"]*)"/)?.[1] || "about:blank";
      const tab = { url: redirects[url] || url, marker: null, born: Date.now() };
      tabs.push(tab);
      return answerCreationScript(script, {
        windowId: 1, tabs, tab, run: (t, js) => runIn(t, js),
        urlOf: (t) => t.url, visibleOf: (t) => tabs.indexOf(t) + 1 === front,
      });
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
    () => sid, () => `${sid.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-000000000000`, window.run, window.run,
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

// The extension is absent, which sends every command to its AppleScript fallback.
const NO_EXTENSION = { name: "no extension", connected: false };

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
// A client left with no tab of its own is refused either way, by the guard or by the lost marker.
const REFUSED_ANYWHERE = /Tab safety|Tab tracking lost/;

const A = "clientA";
const B = "clientB";
const USER_FRONT = "https://mail.example.com/inbox"; // the tab the user is looking at
const USER_OTHER = "https://bank.example.com/account"; // another tab of the user's
const A_URL = "https://a.example.net/work";
const B_URL = "https://b.example.org/work";

// Run `call` as client `who`.
async function as(who, call) {
  const was = sid;
  sid = who;
  try {
    return await outcome(call);
  } finally {
    sid = was;
  }
}

// The user's two tabs (tab 1 in front), then A's tab (3) and B's tab (4), each opened by its client.
async function sharedWindow() {
  const window = safariWindow([{ url: USER_FRONT, marker: null }, { url: USER_OTHER, marker: null }]);
  const safari = loadSafari(window);
  const server = loadServer(safari);
  assert.doesNotMatch(await as(A, () => server.safari_new_tab({ url: A_URL })), REFUSED);
  assert.doesNotMatch(await as(B, () => server.safari_new_tab({ url: B_URL })), REFUSED);
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_FRONT, USER_OTHER, A_URL, B_URL]);
  return { window, safari, server, userTabs: window.tabs.slice(0, 2).map((t) => ({ ...t })) };
}

// The user's tabs saw nothing of either client: same URL, no marker, no page script ran in them.
function assertUserTabsUntouched(window, userTabs) {
  for (const [k, before] of userTabs.entries()) {
    assert.equal(window.tabs[k].url, before.url, `the user's tab ${k + 1} was navigated`);
    assert.equal(window.tabs[k].marker, before.marker, `the user's tab ${k + 1} was stamped`);
  }
  assert.deepEqual(window.ranIn(1), [], "something ran in the tab the user is looking at");
  assert.deepEqual(window.ranIn(2), [], "something ran in the user's other tab");
}

// A page script tagged with the client that sent it, so the fake window records who reached where.
const tag = (who) => `/*from:${who}*/1`;
const reached = (window, i) =>
  [...new Set(window.ranIn(i).map((r) => /\/\*from:(\w+)\*\//.exec(r.js || "")?.[1]).filter(Boolean))];

const WRITES = [
  { name: "safari_click", call: (s) => s.safari_click({ selector: "#send" }), mark: "/*page:click*/" },
  { name: "safari_fill", call: (s) => s.safari_fill({ selector: "#to", value: "x" }), mark: "/*page:fill*/" },
  { name: "safari_select_option", call: (s) => s.safari_select_option({ selector: "#c", value: "IL" }), mark: "/*page:select*/" },
  { name: "safari_native_click", call: (s) => s.safari_native_click({ x: 5, y: 5 }), mark: "/*page:native*/" },
  { name: "run_script click", call: (s) => s.safari_run_script({ steps: [{ action: "click", args: { selector: "#send" } }] }), mark: "/*page:click*/" },
];

// ---------- 1. each client's commands land in its own tab ----------

test("two clients taking turns each evaluate only in the tab they opened", async () => {
  const { window, server, userTabs } = await sharedWindow();
  for (let round = 0; round < 3; round++) {
    for (const who of [A, B]) {
      assert.doesNotMatch(await as(who, () => server.safari_evaluate({ script: tag(who) })), REFUSED);
    }
  }
  assert.deepEqual(reached(window, 3), [A], "B's evaluate reached A's tab, or A's never did");
  assert.deepEqual(reached(window, 4), [B], "A's evaluate reached B's tab, or B's never did");
  assertUserTabsUntouched(window, userTabs);
});

for (const write of WRITES) {
  test(`${write.name} from each client runs in that client's tab and nowhere else`, async () => {
    const { window, server, userTabs } = await sharedWindow();
    for (const who of [A, B, A, B]) assert.doesNotMatch(await as(who, () => write.call(server)), REFUSED);
    const count = (i) => window.ranIn(i).filter((r) => r.js?.endsWith(write.mark)).length;
    assert.equal(count(3), 2, "A's two calls did not both reach A's tab");
    assert.equal(count(4), 2, "B's two calls did not both reach B's tab");
    assertUserTabsUntouched(window, userTabs);
  });
}

test("each client navigates its own tab, and the other client's tab stays where it was", async () => {
  const { window, server, userTabs } = await sharedWindow();
  const A_NEXT = "https://a.example.net/next";
  const B_NEXT = "https://b.example.org/next";
  assert.doesNotMatch(await as(A, () => server.safari_navigate({ url: A_NEXT })), REFUSED);
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_FRONT, USER_OTHER, A_NEXT, B_URL]);
  assert.doesNotMatch(await as(B, () => server.safari_navigate({ url: B_NEXT })), REFUSED);
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_FRONT, USER_OTHER, A_NEXT, B_NEXT]);
  assertUserTabsUntouched(window, userTabs);
});

test("each client reads its own tab's page, not the other client's or the user's", async () => {
  const { window, server, userTabs } = await sharedWindow();
  const readA = await as(A, () => server.safari_read_page({}));
  const readB = await as(B, () => server.safari_read_page({}));
  assert.match(readA, new RegExp(`text of ${A_URL}`));
  assert.doesNotMatch(readA, new RegExp(`text of (${B_URL}|${USER_FRONT}|${USER_OTHER})`));
  assert.match(readB, new RegExp(`text of ${B_URL}`));
  assert.doesNotMatch(readB, new RegExp(`text of (${A_URL}|${USER_FRONT}|${USER_OTHER})`));
  assertUserTabsUntouched(window, userTabs);
});

// Both clients opened a tab on the same URL. Ownership by URL cannot tell the two tabs apart, so
// what keeps them apart is the marker each session stamped on its own tab.
test("two clients on the same URL still each act only in their own tab", async () => {
  const window = safariWindow([{ url: USER_FRONT, marker: null }]);
  const server = loadServer(loadSafari(window));
  await as(A, () => server.safari_new_tab({ url: A_URL }));
  await as(B, () => server.safari_new_tab({ url: A_URL }));
  assert.notEqual(window.tabs[1].marker, window.tabs[2].marker, "both clients stamped the same marker");
  for (const who of [B, A, B]) assert.doesNotMatch(await as(who, () => server.safari_evaluate({ script: tag(who) })), REFUSED);
  assert.deepEqual(reached(window, 2), [A]);
  assert.deepEqual(reached(window, 3), [B]);
  assert.deepEqual(window.ranIn(1), []);
});

// ---------- 2. a client cannot take a tab it does not own ----------

for (const target of [
  { name: "the other client's tab", index: 4 },
  { name: "the user's tab in front", index: 1 },
  { name: "the user's other tab", index: 2 },
]) {
  test(`a client cannot switch onto ${target.name}, and keeps working in its own`, async () => {
    const { window, server, userTabs } = await sharedWindow();
    const markers = window.tabs.map((t) => t.marker);
    assert.match(await as(A, () => server.safari_switch_tab({ index: target.index })), REFUSED);
    assert.deepEqual(window.tabs.map((t) => t.marker), markers, "a refused switch stamped a tab");
    assert.doesNotMatch(await as(A, () => server.safari_evaluate({ script: tag(A) })), REFUSED);
    assert.deepEqual(reached(window, 3), [A], "after the refused switch A's evaluate left its tab");
    assert.deepEqual(reached(window, 4), [], "A reached B's tab");
    assertUserTabsUntouched(window, userTabs);
  });
}

test("a run_script switchTab onto another client's tab is refused and the batch writes nowhere", async () => {
  const { window, server, userTabs } = await sharedWindow();
  const result = await as(A, () => server.safari_run_script({ steps: [
    { action: "switchTab", args: { index: 4 } },
    { action: "evaluate", args: { script: tag(A) } },
  ] }));
  assert.match(result, REFUSED);
  assert.deepEqual(reached(window, 4), [], "A's batch reached B's tab");
  assertUserTabsUntouched(window, userTabs);
});

// ---------- 3. closing and cleanup touch only the caller's tabs ----------

test("a client's safari_close_tab closes its own tab, leaving the other client's and the user's", async () => {
  const { window, server } = await sharedWindow();
  assert.doesNotMatch(await as(A, () => server.safari_close_tab({})), REFUSED);
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_FRONT, USER_OTHER, B_URL]);
  // B still works in its tab, now tab 3.
  assert.doesNotMatch(await as(B, () => server.safari_evaluate({ script: tag(B) })), REFUSED);
  assert.deepEqual(reached(window, 3), [B]);
  // And A, with no tab left, cannot write anywhere.
  assert.match(await as(A, () => server.safari_evaluate({ script: tag(A) })), REFUSED_ANYWHERE);
  assert.deepEqual(reached(window, 3), [B], "A, with no tab left, reached B's tab");
  assert.deepEqual(window.ranIn(1), []);
  assert.deepEqual(window.ranIn(2), []);
});

test("one client at its tab cap closes its own oldest tab, never the other client's or the user's", async () => {
  const { window, server } = await sharedWindow();
  const pages = Array.from({ length: 6 }, (_, k) => `https://a.example.net/p${k + 1}`);
  for (const url of pages) await as(A, () => server.safari_new_tab({ url }));
  // A had seven tabs' worth of opens against a cap of six: its first tab went, nothing else did.
  const urls = window.tabs.map((t) => t.url);
  assert.ok(!urls.includes(A_URL), "A's oldest tab is still open");
  for (const kept of [USER_FRONT, USER_OTHER, B_URL, ...pages]) assert.ok(urls.includes(kept), `${kept} was closed`);
  // index.js records each tab under "<process>:<session>".
  assert.equal(own._sessionTabs(`daemon:${B}`).length, 1, "B's tab was dropped from its record");
  assert.equal(own._sessionTabs(`daemon:${A}`).length, 6);
});
