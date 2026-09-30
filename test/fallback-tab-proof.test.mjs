#!/usr/bin/env node
/**
 * The AppleScript fallback never closes or claims a tab it cannot prove is the one the call
 * named. Default mode only (no SAFARI_PROFILE): a named profile never falls back to AppleScript.
 *
 * Found by code reading on 28.9.26. AppleScript proves a tab by one thing, the identity marker
 * stamped on it (window.name), and the tab cap and shutdown cleanup already close nothing else
 * (#112: "No proof of identity means no close"). The close and switch paths did not hold to it:
 *   1. closeTab() found its tab through resolveActiveTab(). With no marker — a tab the extension
 *      opened never has one — that answered with a URL-prefix match, a domain match or the bare
 *      index: the user's tab on that URL or domain, or whichever tab had shifted into place.
 *   2. safari_close_tab with another tab's receipt fell back to closing the session's current tab.
 *   3. run_script closeTab {index} handed the caller's index to closeTab() as `explicitIndex`,
 *      which skips the proof, while the ownership guard checked the current tab, not that one.
 *   4. A switch by receipt alone fell back to switchTab(undefined): it claimed tab NaN, under a
 *      fresh marker stamped on no tab.
 *   5. A switch by index claimed whatever tab sat there, the user's included: switchTab() stamped
 *      the session's marker on it, and from then on the marker made it the session's own tab. The
 *      step came with no check from run_script, and after only a URL check from safari_switch_tab,
 *      which the user's tab on a page the session also opened passes. Now the tab has to carry a
 *      marker of the session's already, unless safari_switch_tab adopts it (#92).
 *   6. An adoption was recorded by the tab's URL, while the adopted tab carried the same marker as
 *      the session's own tabs. Once it navigated to a URL the session owns, the close refusal let
 *      it through and closeTab() closed the user's tab by that marker; and the adopted URL made the
 *      session's own tab on it unclosable, in every session of the process. Found by a code review
 *      probe on 29.9.26. An adopted tab now carries a marker family of its own, MCP_A<markerId>_,
 *      which no close accepts and every later switch keeps.
 * Without SAFARI_PROFILE, safari_run_script runs its steps through safari.runScript(), which is
 * AppleScript only, and that is where 3, 4 and 5 were live. _runExtensionBatchAction serves named
 * profiles, whose extensionOrFallback never falls back; its AppleScript fallback runs here only
 * so that it keeps the same rules. The same closeTab step also wrote a string index into its
 * AppleScript as it came (`do shell script` included), and closed a tab adopted from the user.
 *
 * Both sides are the real code: index.js's tool handlers, run_script's step guard and batch
 * actions, and extensionOrFallback with its ownership guard; safari.js's session state,
 * resolveActiveTab(), navigate(), closeTab(), switchTab() and runScript(), over a fake Safari
 * window that runs their page JavaScript for real.
 *
 * Run:  node --test test/fallback-tab-proof.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { answerCloseByMarker, answerMarkerScan, isCloseByMarker, isMarkerScan } from "./fake-safari-scripts.mjs";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-proof-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
const { textResult, errorResult } = await import("../response.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
});

const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const SESSION = "daemon:s1";
const USER_URL = "https://mail.example.com/inbox"; // the tab the user is looking at
const A_URL = "https://a.example.com/start"; // opened through AppleScript
const A_MARKER = "MCP_sess0001_a";
const B_URL = "https://b.example.com/work"; // opened by the extension
const RECEIPT_B = "ReceiptB_" + "b".repeat(24);

// ---------- a Safari window that answers safari.js's AppleScript ----------

// Tab i is tabs[i - 1]; closing one renumbers every tab after it, as Safari does. `marker` is
// the tab's window.name. A script for one tab runs its page JavaScript for real, against that
// tab's window, whose page has always finished loading; the marker scans, which loop over every
// tab in AppleScript, are answered here. `scripts` keeps every AppleScript it was handed,
// `afterScript` runs once after the next one, and with `failReads` the page throws when a script
// reads its title, as a page mid-crash can.
function safariWindow(tabs) {
  const w = { tabs, scripts: [], failReads: false, afterScript: null };
  const url = (i) => tabs[i - 1]?.url || "";
  const site = (u) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return u; } };
  const answer = (script) => {
    const page = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in tab (\d+) of (?:front window|window id 1)$/);
    if (page) {
      const tab = tabs[Number(page[2]) - 1];
      if (!tab) throw new Error(`Safari got an error: Can't get tab ${page[2]} of window 1.`);
      const win = { name: tab.marker || "", __mcpTabMarker: tab.pageMarker };
      const document = w.failReads ? { get title() { throw new Error("the page broke"); } } : { title: "", readyState: "complete" };
      try {
        return String(vm.runInNewContext(page[1].replace(/\\"/g, '"'), { window: win, document, location: { href: tab.url } }) ?? "");
      } finally {
        tab.marker = win.name || null;
        tab.pageMarker = win.__mcpTabMarker;
      }
    }
    // The marker scan and the one-script close, run as Safari runs them over the one window
    // (`window id 1`): their marker check reads each tab's page.
    const pageOf = (t) => ({ name: t.marker || "", __mcpTabMarker: t.pageMarker });
    if (isCloseByMarker(script)) {
      return answerCloseByMarker(script, {
        tabs, pageOf, close: (i) => tabs.splice(i - 1, 1), blank: (i) => { tabs[i - 1].url = "about:blank"; },
      });
    }
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
    const load = script.match(/^tell application "Safari" to set URL of tab (\d+) of (?:front window|window id 1) to "([^"]*)"$/);
    if (load) {
      // A new page: __mcpTabMarker goes with the old one, and window.name too across sites (Safari
      // clears it), until navigate() stamps the marker again.
      const tab = tabs[Number(load[1]) - 1];
      if (site(tab.url) !== site(load[2])) tab.marker = null;
      tab.pageMarker = undefined;
      return void (tab.url = load[2]);
    }
    const close = script.match(/close tab (\d+) of/);
    if (close) return void tabs.splice(Number(close[1]) - 1, 1);
    if (/count of tabs/.test(script)) return String(tabs.length);
    throw new Error(`the fake window does not answer this AppleScript:\n${script}`);
  };
  w.run = async (script) => {
    w.scripts.push(script);
    try {
      return answer(script);
    } finally {
      const hook = w.afterScript;
      w.afterScript = null;
      hook?.();
    }
  };
  return w;
}

// The extension's end of the bridge: it opens tabs, with a receipt for an http(s) page and none
// for a blank one. Given the tabs it opened for the session, it also switches to them by index, and
// refuses any other tab, as _switchTabForSession does. Every other command times out, which sends
// index.js to its AppleScript fallback.
function extension(window, opened = []) {
  return async (type, payload) => {
    if (type === "new_tab") {
      window.tabs.push({ url: payload.url || "about:blank", marker: null });
      return { title: "", safeUrl: payload.url, ...(payload.url ? { receipt: RECEIPT_B } : {}), tabIndex: window.tabs.length };
    }
    if (type === "switch_tab" && opened.length) {
      const tab = window.tabs[payload.index - 1];
      if (!opened.includes(tab)) throw new Error(`\u26a0\ufe0f Tab safety: refusing "switch_tab" to tab ${payload.index} \u2014 not opened by this MCP session.`);
      return { title: "", safeUrl: tab.url, receipt: RECEIPT_B, tabIndex: payload.index, owned: true };
    }
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
}

// ---------- safari.js, for real ----------

// The per-session tab state, its accessors, the marker stamp, findTabByMarker(),
// resolveActiveTab(), runJS(), navigate(), closeTab(), switchTab() and runScript().
const safariParts = [
  between(safariSource, "const _sessions = new Map();", "\n// ========== DIAGNOSTIC LOG"),
  between(safariSource, "function _assertNotFallingBackToUserTab(", "\n// ========== TAB IDENTITY MARKER"),
  between(safariSource, "function _buildStampJS(", "\n// Quick JS execution"),
  between(safariSource, "export function getActiveTabIndex()", "\n// ========== FAST OSASCRIPT"),
  between(safariSource, "function _tabIdentityGuard(", "\n// ========== NAVIGATION =========="),
  between(safariSource, "export async function navigate(url) {", "\n// Poll document.readyState from the Node side"),
  between(safariSource, "async function _provenOwnTabIndex()", "\n// ========== WAIT"),
  between(safariSource, "export async function runScript(", "\n// ========== ACCESSIBILITY SNAPSHOT"),
].join("\n");
const safariExports = [...safariParts.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

// runScript's action table names every safari.js action. Only closeTab and switchTab run here;
// the rest just have to exist, so each name becomes a parameter left undefined. A function the
// extracted parts declare under the same name replaces its parameter (sloppy-mode functions).
const actionTable = between(safariSource, "const actions = {", "\n      };")
  .slice("const actions = {".length)
  .replace(/\/\/.*$/gm, "");
const tableNames = [...new Set([
  ...[...actionTable.matchAll(/=> (\w+)\(/g)].map((m) => m[1]),
  ...actionTable.split("\n").filter((l) => !l.includes(":")).flatMap((l) => l.split(",")),
].map((name) => name.trim()).filter(Boolean))];

// `id` is the session's marker id: another one is another MCP session in the same process.
function loadSafari(window, id = "sess0001") {
  const safari = new Function(
    "currentSessionId", "randomUUID", "osascript", "osascriptFast", "getTargetWindowRef",
    "refreshTargetWindow", "console", "SAFARI_PROFILE", "raiseWindowForShow", "_injectHelpersfast", ...tableNames,
    `${safariParts.replace(/^export /gm, "")}\nreturn { _st, resolveActiveTab, ${safariExports.join(", ")} };`
  )(
    () => "s1", () => `${id}-0000-4000-8000-000000000000`, window.run, window.run,
    () => "front window", async () => {},
    { error() {} }, null, async () => {}, async () => {}
  );
  // What else index.js calls on these paths: focus bookkeeping around each extension command,
  // and list_tabs' AppleScript fallback (safari_switch_tab looks its target up first).
  return Object.assign(safari, {
    saveFrontmostApp: async () => null,
    setFocusGuard() {},
    restoreFocusIfStolen: async () => {},
    listTabs: async () => JSON.stringify(window.tabs.map((t, i) => ({ index: i + 1, title: "", url: t.url }))),
    listWindowTabs: async () => ({ win: "window id 1", tabs: window.tabs.map((t, i) => ({ index: i + 1, title: "", url: t.url })) }),
  });
}

// ---------- index.js, for real ----------

// The receipt helpers, the tab-ownership sets, extensionOrFallback with its guard, and
// run_script's batch actions.
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

function loadServer(safari, sendToExtension) {
  const deps = {
    safari, sendToExtension, SESSION_ID: "daemon", currentSessionId: () => "s1",
    process: { env: {} }, console: { error() {} }, textResult, errorResult,
    _evictOldestTab: async () => null, _trackTab: own._trackTab, _untrackTab: own._untrackTab,
    _openedTabs: own._openedTabs, _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL,
    _removeOwnedURL: own._removeOwnedURL, _markBlankTabOpened: own._markBlankTabOpened, _isURLOwned: own._isURLOwned,
    _trackedAtIndex: own._trackedAtIndex, allowUserTabs: own.allowUserTabs,
    BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    // The default mode, with the extension connected.
    _preferAppleScript: false, _extensionConnected: true, _commandTimeouts: {},
  };
  return new Function(
    ...Object.keys(deps),
    `${indexParts}
    return {
      run: _runExtensionBatchAction,
      safari_new_tab: ${toolHandler("safari_new_tab")},
      safari_navigate: ${toolHandler("safari_navigate")},
      safari_close_tab: ${toolHandler("safari_close_tab")},
      safari_switch_tab: ${toolHandler("safari_switch_tab")},
      safari_wait_for_new_tab: ${toolHandler("safari_wait_for_new_tab")},
      safari_run_script: ${toolHandler("safari_run_script")},
    };`
  )(...Object.values(deps));
}

// A refusal comes back as a thrown error, or — from a run_script step — as that step's error.
async function outcome(call) {
  try {
    return JSON.stringify(await call());
  } catch (err) {
    return err.message;
  }
}
const REFUSED = /Tab safety|Tab tracking lost|switchTab needs/;
const urls = (window) => window.tabs.map((t) => t.url);

// ---------- 1. a tab the extension opened carries no marker ----------

// Tab 1 is the user's. The extension opens B (tab 2) for the session; then the page moves B off
// the URL it was opened on, or the user rearranges their tabs, and a tab of theirs sits where
// the fallback used to look.
const GUESSES = [
  {
    name: "a user's tab on the URL the session's tab left", url: B_URL,
    after: (tabs) => { tabs[1].url = "https://sso.example.net/login"; tabs.push({ url: B_URL, marker: null }); },
  },
  {
    name: "a user's tab on the domain the session's tab left", url: B_URL,
    after: (tabs) => { tabs[1].url = "https://sso.example.net/login"; tabs.push({ url: "https://b.example.com/settings", marker: null }); },
  },
  {
    name: "the user's tab that shifted into the session's index", url: "",
    after: (tabs) => { tabs.push({ url: "https://docs.example.org/draft", marker: null }); tabs.splice(0, 1); },
  },
];
const CLOSES = [
  { name: "safari_close_tab", close: (s) => s.safari_close_tab({}) },
  { name: "run_script closeTab", close: (s) => s.safari_run_script({ steps: [{ action: "closeTab" }] }) },
  { name: "_runExtensionBatchAction closeTab", close: (s) => s.run("closeTab", {}) },
];

for (const guess of GUESSES) {
  for (const path of CLOSES) {
    test(`${path.name} through AppleScript never closes ${guess.name}`, async () => {
      const window = safariWindow([{ url: USER_URL, marker: null }]);
      const server = loadServer(loadSafari(window), extension(window));
      await server.safari_new_tab({ url: guess.url });
      guess.after(window.tabs);
      const before = urls(window);
      const result = await outcome(() => path.close(server));
      assert.deepEqual(urls(window), before, "a tab the session could not prove was closed");
      assert.match(result, REFUSED);
    });
  }
}

// ---------- 2–4. AppleScript opened A; the extension opened B ----------

// Tab 1 is the user's, A (tab 2) is the session's current tab, opened through AppleScript and
// tracked by its marker, and B (tab 3) is a tab the extension opened for it earlier.
function session() {
  const window = safariWindow([
    { url: USER_URL, marker: null }, { url: A_URL, marker: A_MARKER }, { url: B_URL, marker: null },
  ]);
  const safari = loadSafari(window);
  Object.assign(safari._st(), {
    activeTabIndex: 2, activeTabURL: A_URL, activeTabMarker: A_MARKER, hasOwnedTab: true,
  });
  own._trackTab(2, A_URL, SESSION, A_MARKER, "");
  own._trackTab(3, B_URL, SESSION, "", RECEIPT_B);
  return { window, safari, server: loadServer(safari, extension(window)) };
}

// The session still works in A, and no tab took a marker.
function assertStillOnA({ window, safari }) {
  assert.equal(safari._st().activeTabIndex, 2);
  assert.equal(safari._st().activeTabMarker, A_MARKER);
  assert.deepEqual(window.tabs.map((t) => t.marker), [null, A_MARKER, null]);
}

const BY_RECEIPT = [
  { name: "safari_close_tab", call: (s) => s.safari_close_tab({ receipt: RECEIPT_B }) },
  { name: "run_script closeTab", call: (s) => s.safari_run_script({ steps: [{ action: "closeTab", args: { receipt: RECEIPT_B } }] }) },
  { name: "_runExtensionBatchAction closeTab", call: (s) => s.run("closeTab", { receipt: RECEIPT_B }) },
];
for (const path of BY_RECEIPT) {
  test(`${path.name} by B's receipt does not fall back to closing the current tab`, async () => {
    const s = session();
    assert.match(await outcome(() => path.call(s.server)), REFUSED);
    assert.deepEqual(urls(s.window), [USER_URL, A_URL, B_URL]);
    assertStillOnA(s);
  });
}

const BY_INDEX = [
  { name: "run_script closeTab", call: (s, i) => s.safari_run_script({ steps: [{ action: "closeTab", args: { index: i } }] }) },
  { name: "_runExtensionBatchAction closeTab", call: (s, i) => s.run("closeTab", { index: i }) },
];
for (const path of BY_INDEX) {
  test(`${path.name} {index} through AppleScript refuses a tab that does not carry the session's marker`, async () => {
    const s = session();
    assert.match(await outcome(() => path.call(s.server, 1)), REFUSED);
    assert.deepEqual(urls(s.window), [USER_URL, A_URL, B_URL], "the user's tab was closed");
  });

  test(`${path.name} {index} through AppleScript still closes the session's own marked tab`, async () => {
    const s = session();
    await path.call(s.server, 2);
    assert.deepEqual(urls(s.window), [USER_URL, B_URL]);
  });
}

// B's receipt, alone or with B's index. Only the extension can tell which tab a receipt names,
// and the extension goes by the receipt, not the index.
const SWITCH_BY_RECEIPT = [
  { name: "safari_switch_tab", call: (s, args) => s.safari_switch_tab(args) },
  { name: "run_script switchTab", call: (s, args) => s.safari_run_script({ steps: [{ action: "switchTab", args }] }) },
  { name: "_runExtensionBatchAction switchTab", call: (s, args) => s.run("switchTab", args) },
];
for (const path of SWITCH_BY_RECEIPT) {
  for (const [how, args] of [["alone", { receipt: RECEIPT_B }], ["with an index", { index: 3, receipt: RECEIPT_B }]]) {
    test(`${path.name} by receipt ${how} claims no tab through AppleScript`, async () => {
      const s = session();
      assert.match(await outcome(() => path.call(s.server, args)), REFUSED);
      assertStillOnA(s);
    });
  }
}

test("a run_script switchTab that names no tab stops the batch before its next step", async () => {
  const s = session();
  const steps = [{ action: "switchTab" }, { action: "closeTab" }];
  assert.match(await outcome(() => s.server.safari_run_script({ steps })), REFUSED);
  assert.deepEqual(urls(s.window), [USER_URL, A_URL, B_URL], "the closeTab meant for another tab closed A");
  assertStillOnA(s);
});

test("switchTab() claims no tab without an index", async () => {
  const s = session();
  await assert.rejects(s.safari.switchTab(undefined), /switchTab needs/);
  assertStillOnA(s);
});

test("a run_script closeTab index never reaches AppleScript as written", async () => {
  const s = session();
  const index = '2 of front window\ndo shell script "echo INJECTED"\n--';
  const steps = [{ action: "closeTab", args: { index } }];
  assert.match(await outcome(() => s.server.safari_run_script({ steps })), REFUSED);
  assert.ok(!s.window.scripts.some((script) => script.includes("do shell script")), "the index ran as AppleScript");
  assert.deepEqual(urls(s.window), [USER_URL, A_URL, B_URL]);
});

test("closeTab() refuses an explicit index that is not a tab number", async () => {
  const s = session();
  await assert.rejects(s.safari.closeTab("2 of front window"), /positive integer/);
  assert.deepEqual(s.window.scripts, []);
});

test("run_script closeTab refuses a tab adopted from the user, as safari_close_tab does", async () => {
  const flag = process.env.SAFARI_MCP_ALLOW_USER_TABS;
  process.env.SAFARI_MCP_ALLOW_USER_TABS = "1";
  try {
    const s = session();
    // The session adopts the user's tab (#92). With the extension down, AppleScript claims it
    // and stamps the session's marker on it, so from here on the marker proves it.
    await s.server.safari_switch_tab({ index: 1 });
    assert.equal(s.window.tabs[0].marker, s.safari._st().activeTabMarker);
    assert.match(await outcome(() => s.server.safari_run_script({ steps: [{ action: "closeTab" }] })), REFUSED);
    assert.deepEqual(urls(s.window), [USER_URL, A_URL, B_URL], "the adopted user tab was closed");
  } finally {
    if (flag === undefined) delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
    else process.env.SAFARI_MCP_ALLOW_USER_TABS = flag;
  }
});

test("safari_close_tab's AppleScript fallback still closes the marked tab after the user shifts it", async () => {
  const s = session();
  s.window.tabs.splice(0, 1); // the user closes their tab: A is tab 1 now
  await s.server.safari_close_tab({});
  assert.deepEqual(urls(s.window), [B_URL]);
  assert.deepEqual([...own._openedTabs.values()].map((t) => t.url), [B_URL], "A's record went with it");
});

// ---------- 5. a switch by index claims only a tab the session can show is its own ----------

// switchTab() claims the tab at an index by stamping the session's marker on it, and from then on
// that marker is what makes the tab the session's own: writes go there, and closeTab() closes the
// tab carrying it. run_script switchTab got there with no check at all, and safari_switch_tab's
// fallback after a check of the target's URL, which the user's tab on a URL the session had opened
// passes. Here the user's tab 1 sits on the URL of the session's tab A.
function sameUrlSession() {
  const s = session();
  Object.assign(s.window.tabs[0], { url: A_URL, user: true });
  return s;
}
const userTabOpen = (window) => window.tabs.some((t) => t.user);

async function withUserTabs(fn) {
  const flag = process.env.SAFARI_MCP_ALLOW_USER_TABS;
  process.env.SAFARI_MCP_ALLOW_USER_TABS = "1";
  try {
    return await fn();
  } finally {
    if (flag === undefined) delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
    else process.env.SAFARI_MCP_ALLOW_USER_TABS = flag;
  }
}

const SWITCH_BY_INDEX = [
  { name: "safari_switch_tab", call: (s, index) => s.safari_switch_tab({ index }) },
  { name: "run_script switchTab", call: (s, index) => s.safari_run_script({ steps: [{ action: "switchTab", args: { index } }] }) },
  { name: "_runExtensionBatchAction switchTab", call: (s, index) => s.run("switchTab", { index }) },
];
for (const path of SWITCH_BY_INDEX) {
  test(`${path.name} by index does not claim the user's tab on the URL of the session's tab`, async () => {
    const s = sameUrlSession();
    assert.match(await outcome(() => path.call(s.server, 1)), REFUSED);
    assertStillOnA(s);
    // What the claim led to: the close through AppleScript took the tab carrying the marker.
    await s.server.safari_close_tab({});
    assert.ok(userTabOpen(s.window), "the user's tab was closed");
  });

  test(`${path.name} by index still claims the session's own tabs, wherever the user moved them`, async () => {
    const s = session();
    s.window.tabs[2].marker = "MCP_sess0001_b"; // the extension marked B when AppleScript first needed it
    s.window.tabs.splice(0, 1); // the user closes their tab: A is tab 1 now, B tab 2
    await path.call(s.server, 2);
    assert.equal(await s.safari.resolveActiveTab(), 2);
    // Back to A, which carries an earlier marker of the session's, not the current one.
    await path.call(s.server, 1);
    assert.equal(await s.safari.resolveActiveTab(), 1);
  });
}

test("run_script switchTab does not claim a tab the extension opened and never marked", async () => {
  const s = session();
  // B is the session's, but only the extension can tell: its receipt names it, and it carries no marker.
  const steps = [{ action: "switchTab", args: { index: 3 } }];
  assert.match(await outcome(() => s.server.safari_run_script({ steps })), REFUSED);
  assertStillOnA(s);
});

test("run_script switchTab does not claim a tab another MCP session marked", async () => {
  const s = session();
  s.window.tabs[0].marker = "MCP_othr0002_x"; // the prefix is per session, not "MCP_" (#76)
  const steps = [{ action: "switchTab", args: { index: 1 } }];
  assert.match(await outcome(() => s.server.safari_run_script({ steps })), REFUSED);
  assert.equal(s.window.tabs[0].marker, "MCP_othr0002_x");
  assert.equal(s.safari._st().activeTabMarker, A_MARKER);
});

test("a refused run_script switchTab stops the batch before its next step", async () => {
  const s = session();
  const steps = [{ action: "switchTab", args: { index: 1 } }, { action: "closeTab" }];
  assert.match(await outcome(() => s.server.safari_run_script({ steps })), REFUSED);
  assert.deepEqual(urls(s.window), [USER_URL, A_URL, B_URL], "the closeTab meant for tab 1 closed A");
});

test("with SAFARI_MCP_ALLOW_USER_TABS, safari_switch_tab adopts the user's tab on the session's URL, and close_tab refuses it", async () => {
  await withUserTabs(async () => {
    const s = sameUrlSession();
    const reply = JSON.parse((await s.server.safari_switch_tab({ index: 1 })).content[0].text);
    assert.equal(reply.note, "(user tab, opted-in)");
    assert.equal(s.window.tabs[0].marker, s.safari._st().activeTabMarker, "the session does not work in the adopted tab");
    assert.match(await outcome(() => s.server.safari_close_tab({})), REFUSED);
    assert.ok(userTabOpen(s.window), "the adopted user tab was closed");
  });
});

test("run_script switchTab adopts nothing, even with SAFARI_MCP_ALLOW_USER_TABS: only safari_switch_tab adopts (#92)", async () => {
  await withUserTabs(async () => {
    const s = session();
    const steps = [{ action: "switchTab", args: { index: 1 } }];
    assert.match(await outcome(() => s.server.safari_run_script({ steps })), REFUSED);
    assertStillOnA(s);
  });
});

test("safari_wait_for_new_tab still claims the tab it saw open", async () => {
  const s = session();
  const popup = { url: "https://sso.example.net/authorize", marker: null };
  setTimeout(() => s.window.tabs.push(popup), 50);
  await s.server.safari_wait_for_new_tab({ timeout: 3000 });
  assert.equal(popup.marker, s.safari._st().activeTabMarker);
});

test("with SAFARI_MCP_ALLOW_USER_TABS, switching to the session's own tab adopts nothing", async () => {
  await withUserTabs(async () => {
    const s = session();
    const reply = JSON.parse((await s.server.safari_switch_tab({ index: 2 })).content[0].text);
    assert.equal(reply.note, undefined);
    assert.equal(s.safari.isActiveTabAdopted(), false);
  });
});

test("run_script switchTab asks the extension about a tab only the extension can prove", async () => {
  const s = session();
  // The extension opened B and knows it by its id; AppleScript sees a tab with no marker.
  const server = loadServer(s.safari, extension(s.window, [s.window.tabs[2]]));
  const switchTo = (index) => server.safari_run_script({ steps: [{ action: "switchTab", args: { index } }] });
  assert.doesNotMatch(await outcome(() => switchTo(3)), REFUSED);
  assert.equal(s.safari._st().tabFromExtension, true, "the session is not on B");
  assert.equal(s.window.tabs[2].marker, null, "AppleScript stamped a tab it could not prove");
  // The extension refuses what it did not open.
  assert.match(await outcome(() => switchTo(1)), REFUSED);
  assert.equal(s.window.tabs[0].marker, null);
});

test("a switch that fails while it reads the tab leaves no marker there and the session where it was", async () => {
  await withUserTabs(async () => {
    const s = sameUrlSession();
    s.window.failReads = true;
    await assert.rejects(s.server.safari_switch_tab({ index: 1 }));
    s.window.failReads = false;
    assertStillOnA(s);
    await s.server.safari_close_tab({});
    assert.ok(userTabOpen(s.window), "the user's tab was closed");
  });
});

test("a switch claims the tab it proved, even when the tabs shift right after the proof", async () => {
  const s = session();
  // The user closes their tab just after the first script Safari runs for the switch: B moves
  // into index 2, where A was.
  s.window.afterScript = () => s.window.tabs.splice(0, 1);
  await s.server.safari_run_script({ steps: [{ action: "switchTab", args: { index: 2 } }] });
  assert.equal(s.window.tabs[1].marker, null, "B was stamped in A's place");
  assert.equal(await s.safari.resolveActiveTab(), 1, "the session is not on A");
});

test("switchTab() runs no AppleScript for an index that is not a tab number", async () => {
  const s = session();
  await assert.rejects(s.safari.switchTab('1 of front window\ndo shell script "echo INJECTED"\n--'), /switchTab needs/);
  assert.deepEqual(s.window.scripts, []);
});

// ---------- 6. a tab adopted from the user is never closable, whatever it shows ----------

// Adoption (#92) was recorded by URL, and the close refusal asked whether the current URL was one
// adopted from the user. closeTab() proves a tab by the marker the adoption stamped on it, the same
// kind of marker the session's own tabs carry. Once the adopted tab showed a URL the session owns
// (safari_navigate registers every destination as owned), the refusal let the close through and
// AppleScript closed the user's tab. The adopted URL also left every tab showing it unclosable, the
// session's own included, in every session of the process.
for (const path of CLOSES) {
  test(`${path.name} never closes a tab adopted from the user, even once it shows a URL the session owns`, async () => {
    await withUserTabs(async () => {
      const s = session();
      s.window.tabs[0].user = true;
      await s.server.safari_switch_tab({ index: 1 });
      await s.server.safari_navigate({ url: A_URL });
      assert.equal(s.window.tabs[0].url, A_URL, "the adopted tab did not navigate");
      assert.match(await outcome(() => path.close(s.server)), REFUSED);
      assert.ok(userTabOpen(s.window), "the adopted user tab was closed");
      assert.equal(s.window.tabs.length, 3, "a tab was closed in its place");
    });
  });
}

test("adopting the user's tab on the session's URL leaves the session's own tab there closable", async () => {
  await withUserTabs(async () => {
    const s = sameUrlSession();
    await s.server.safari_switch_tab({ index: 1 });
    await s.server.safari_switch_tab({ index: 2 }); // back to A, the session's own tab on that URL
    await s.server.safari_close_tab({});
    assert.deepEqual(urls(s.window), [A_URL, B_URL], "the session's own tab A was not closed");
    assert.ok(userTabOpen(s.window), "the user's tab was closed in A's place");
  });
});

test("one session's adoption leaves another session's tab on the same URL closable", async () => {
  await withUserTabs(async () => {
    const s = session();
    s.window.tabs[0].user = true;
    await s.server.safari_switch_tab({ index: 1 });
    // Another MCP session of the same process (the HTTP daemon) has its own tab on that page.
    const other = loadSafari(s.window, "sess0002");
    s.window.tabs.push({ url: USER_URL, marker: "MCP_sess0002_c" });
    Object.assign(other._st(), { activeTabIndex: 4, activeTabURL: USER_URL, activeTabMarker: "MCP_sess0002_c", hasOwnedTab: true });
    own._trackTab(4, USER_URL, "daemon:s2", "MCP_sess0002_c", "");
    await loadServer(other, extension(s.window)).safari_close_tab({});
    assert.deepEqual(urls(s.window), [USER_URL, A_URL, B_URL], "the other session's tab was not closed");
    assert.ok(userTabOpen(s.window), "the adopted user tab was closed");
  });
});

// A switch stamps a fresh marker on a tab adopted from the user, and it has to stay an adoption marker,
// or switching away and back would turn the tab into one of the session's own, which closes. The
// user's tab shows the session's URL here, so no URL check refuses the close either.
for (const path of SWITCH_BY_INDEX) {
  test(`${path.name} back to a tab adopted from the user keeps it unclosable`, async () => {
    await withUserTabs(async () => {
      const s = sameUrlSession();
      await s.server.safari_switch_tab({ index: 1 });
      await s.server.safari_switch_tab({ index: 2 });
      await path.call(s.server, 1);
      assert.equal(s.window.tabs[0].marker, s.safari._st().activeTabMarker, "the session is not back on the adopted tab");
      assert.match(await outcome(() => s.server.safari_close_tab({})), REFUSED);
      assert.ok(userTabOpen(s.window), "the adopted user tab was closed");
    });
  });
}

test("safari_wait_for_new_tab does not take a tab adopted from the user for one the session opened", async () => {
  await withUserTabs(async () => {
    const s = session();
    s.window.tabs[0].user = true;
    await s.server.safari_switch_tab({ index: 1 });
    // While it waits, the adopted tab moves on to another page and a new tab opens right after it
    // on the page the adopted tab left. Tabs are told apart by URL alone, so the new one stands in
    // for the adopted tab and the adopted tab looks new: the one case that still reaches adopt()'s
    // guard for an adopted tab. If tab identity improves and this stops claiming it, rewrite the
    // test on purpose rather than let it pass on a TIMEOUT.
    setTimeout(() => {
      s.window.tabs[0].url = "https://mail.example.com/sent";
      s.window.tabs.splice(1, 0, { url: USER_URL, marker: null });
    }, 50);
    const reply = await s.server.safari_wait_for_new_tab({ timeout: 3000 });
    assert.match(reply.content[0].text, /Found new tab/);
    assert.equal(s.window.tabs[0].marker, s.safari._st().activeTabMarker, "the wait did not land on the adopted tab");
    assert.equal(s.safari.isActiveTabAdopted(), true, "the claim turned the adopted tab into one the session opened");
    assert.ok(
      ![...own._openedTabs.values()].some((t) => t.url === "https://mail.example.com/sent"),
      "the adopted tab was recorded among the tabs the session opened, which the tab cap and shutdown close"
    );
    const onUserPage = (u) => u.startsWith("https://mail.example.com");
    assert.ok(![...own._ownedTabURLs].some(onUserPage), "the adopted URL is owned by every session of the process");
    assert.ok(!own._loadOwnershipFile().some((e) => onUserPage(e.url)), "the adopted URL reached owned-tabs.json");
    assert.match(await outcome(() => s.server.safari_close_tab({})), REFUSED);
    assert.ok(userTabOpen(s.window), "the adopted user tab was closed");
  });
});

test("closeTab() and closeOwnTab() refuse a tab adopted from the user on their own", async () => {
  await withUserTabs(async () => {
    const s = sameUrlSession();
    await s.server.safari_switch_tab({ index: 1 });
    await assert.rejects(s.safari.closeTab(), /Tab safety/);
    await assert.rejects(s.safari.closeOwnTab(1), /Tab safety/);
    assert.ok(userTabOpen(s.window), "the adopted user tab was closed");
  });
});

test("adoption records the user's tab only in the session: no owned URL, nothing in owned-tabs.json", async () => {
  await withUserTabs(async () => {
    const s = session();
    await s.server.safari_switch_tab({ index: 1 });
    assert.equal(s.safari.isActiveTabAdopted(), true);
    const onUserPage = (u) => u.startsWith("https://mail.example.com");
    assert.ok(![...own._ownedTabURLs].some(onUserPage), "the adopted URL is owned by every session of the process");
    assert.ok(!own._loadOwnershipFile().some((e) => onUserPage(e.url)), "the adopted URL reached owned-tabs.json");
  });
});
