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
 * Without SAFARI_PROFILE, safari_run_script runs its steps through safari.runScript(), which is
 * AppleScript only, and that is where 3 and 4 were live. _runExtensionBatchAction serves named
 * profiles, whose extensionOrFallback never falls back; its AppleScript fallback runs here only
 * so that it keeps the same rules. The same closeTab step also wrote a string index into its
 * AppleScript as it came (`do shell script` included), and closed a tab adopted from the user.
 *
 * Both sides are the real code: index.js's tool handlers, run_script's step guard and batch
 * actions, and extensionOrFallback with its ownership guard; safari.js's session state,
 * resolveActiveTab(), closeTab(), switchTab() and runScript(), over a fake Safari window.
 *
 * Run:  node --test test/fallback-tab-proof.test.mjs
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
const { textResult, errorResult } = await import("../response.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
  own._adoptedTabURLs.clear();
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
// the tab's window.name. `scripts` keeps every AppleScript it was handed.
function safariWindow(tabs) {
  const scripts = [];
  const url = (i) => tabs[i - 1]?.url || "";
  const run = async (script) => {
    scripts.push(script);
    const stamp = script.match(/window\.name='([^']*)'/);
    if (stamp) {
      tabs[Number(script.match(/in tab (\d+) of/)[1]) - 1].marker = stamp[1];
      return "1";
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
    const close = script.match(/close tab (\d+) of/);
    if (close) return void tabs.splice(Number(close[1]) - 1, 1);
    if (/count of tabs/.test(script)) return String(tabs.length);
    throw new Error(`the fake window does not answer this AppleScript:\n${script}`);
  };
  return { tabs, run, scripts };
}

// The extension's end of the bridge: it opens tabs, with a receipt for an http(s) page and none
// for a blank one. Every other command times out, which sends index.js to its AppleScript fallback.
function extension(window) {
  return async (type, payload) => {
    if (type === "new_tab") {
      window.tabs.push({ url: payload.url || "about:blank", marker: null });
      return { title: "", safeUrl: payload.url, ...(payload.url ? { receipt: RECEIPT_B } : {}), tabIndex: window.tabs.length };
    }
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
}

// ---------- safari.js, for real ----------

// The per-session tab state, its accessors, the marker stamp, findTabByMarker(),
// resolveActiveTab(), closeTab(), switchTab() and runScript().
const safariParts = [
  between(safariSource, "const _sessions = new Map();", "\nconst RESOLVE_CACHE_MS"),
  between(safariSource, "function _buildStampJS(", "\n// Quick JS execution"),
  between(safariSource, "export function getActiveTabIndex()", "\n// ========== FAST OSASCRIPT"),
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

function loadSafari(window) {
  const safari = new Function(
    "currentSessionId", "randomUUID", "osascript", "osascriptFast", "getTargetWindowRef",
    "refreshTargetWindow", "runJS", "console", ...tableNames,
    `${safariParts.replace(/^export /gm, "")}\nreturn { _st, resolveActiveTab, ${safariExports.join(", ")} };`
  )(
    () => "s1", () => "sess0001-0000-4000-8000-000000000000", window.run, window.run,
    () => "front window", async () => {},
    // switchTab() reads the title and URL of the tab it claimed.
    async (_js, { tabIndex }) => JSON.stringify({ title: "", url: window.tabs[tabIndex - 1]?.url || "" }),
    { error() {} }
  );
  // What else index.js calls on these paths: focus bookkeeping around each extension command,
  // and list_tabs' AppleScript fallback (safari_switch_tab looks its target up first).
  return Object.assign(safari, {
    saveFrontmostApp: async () => null,
    setFocusGuard() {},
    restoreFocusIfStolen: async () => {},
    listTabs: async () => JSON.stringify(window.tabs.map((t, i) => ({ index: i + 1, title: "", url: t.url }))),
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
    _markBlankTabOpened: own._markBlankTabOpened, _isURLOwned: own._isURLOwned,
    _isAdoptedURL: own._isAdoptedURL, _trackedAtIndex: own._trackedAtIndex,
    allowUserTabs: own.allowUserTabs, _adoptUserTab: own._adoptUserTab,
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
      safari_close_tab: ${toolHandler("safari_close_tab")},
      safari_switch_tab: ${toolHandler("safari_switch_tab")},
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

test("run_script switchTab by index still claims that tab under a marker it stamps", async () => {
  const s = session();
  await s.server.safari_run_script({ steps: [{ action: "switchTab", args: { index: 3 } }] });
  assert.equal(s.window.tabs[2].marker, s.safari._st().activeTabMarker);
  assert.equal(await s.safari.resolveActiveTab(), 3);
});

test("safari_close_tab's AppleScript fallback still closes the marked tab after the user shifts it", async () => {
  const s = session();
  s.window.tabs.splice(0, 1); // the user closes their tab: A is tab 1 now
  await s.server.safari_close_tab({});
  assert.deepEqual(urls(s.window), [B_URL]);
  assert.deepEqual([...own._openedTabs.values()].map((t) => t.url), [B_URL], "A's record went with it");
});
