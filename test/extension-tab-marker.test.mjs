#!/usr/bin/env node
/**
 * A tab the Safari extension opens or picks is the tab the AppleScript fallback acts on —
 * not the last tab AppleScript opened itself. Default mode only (no SAFARI_PROFILE): a named
 * profile never falls back to AppleScript.
 *
 * Found by code reading on 28.9.26. safari.js finds the session's tab by an identity marker
 * (window.name) before its index or URL, and only its own AppleScript newTab()/switchTab()
 * mint one. When the extension served safari_new_tab — or safari_switch_tab,
 * safari_wait_for_new_tab, run_script newTab/switchTab/getReceipt — index.js synced the
 * index (and sometimes the URL), but the marker still named the tab AppleScript had opened
 * before. The next call without a receipt whose extension attempt failed ran its AppleScript
 * fallback on that older tab, and safari_close_tab's fallback closed it.
 *
 * Such a tab carries no marker until the extension writes one into it (mark_tab), and
 * safari.js acts on it only where it finds that marker — see extension-tab-proof.test.mjs.
 *
 * Both sides are the real code: index.js's tool handlers and run_script actions, fed the
 * reply the extension sends, and safari.js's session state, resolveActiveTab() and
 * closeTab(), over a fake Safari window that answers their AppleScript.
 *
 * Run:  node --test test/extension-tab-marker.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-marker-"));
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
const USER_URL = "https://mail.example.com/inbox";
const A_URL = "https://a.example.com/start";
const A_MARKER = "MCP_sess0001_a";
const B_URL = "https://b.example.com/work";
const RECEIPT_B = "ReceiptB_" + "b".repeat(24);
const RECEIPT_B2 = "ReceiptB2_" + "c".repeat(24);

// ---------- a Safari window that answers safari.js's AppleScript ----------

// Tab i is tabs[i - 1]; closing one renumbers every tab after it, as Safari does. `marker` is
// what an AppleScript stamp left in the tab's window.name. `later` tabs open right after the
// first listing (a popup the page opens while safari_wait_for_new_tab polls).
function safariWindow(tabs, later = []) {
  const url = (i) => tabs[i - 1]?.url || "";
  const run = async (script) => {
    const closing = /close tab i of w/.test(script) && script.match(/window\.name==='([^']*)'/);
    if (closing) {
      // closeTabByMarker: the tab carrying the marker, found and closed in one script (blanked
      // when it is the window's only tab).
      const at = tabs.findIndex((t) => t.marker === closing[1]);
      if (at < 0) return "";
      if (tabs.length === 1) {
        tabs[0].url = "about:blank";
        return "blanked";
      }
      tabs.splice(at, 1);
      return "closed";
    }
    const marker = script.match(/window\.name==='([^']*)'/);
    if (marker) {
      // resolveActiveTab's marker scan: the cached index first, then right to left.
      const has = (i) => tabs[i - 1]?.marker === marker[1];
      const cached = Number(script.match(/in tab (\d+) of w\) is "1"/)?.[1]);
      if (has(cached)) return String(cached);
      for (let i = tabs.length; i >= 1; i--) if (has(i)) return String(i);
      return "0";
    }
    const prefix = script.match(/starts with "([^"]*)"/);
    if (prefix) {
      // Its URL strategy: the cached index, a URL prefix right to left, then the domain
      // (answered as a negative index), else "0:<tab count>".
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
  const list = () => {
    const listed = tabs.map((t, i) => ({ index: i + 1, url: t.url }));
    tabs.push(...later.splice(0));
    return listed;
  };
  return { tabs, run, list };
}

// ---------- safari.js, for real ----------

// The per-session tab state, its accessors, resolveActiveTab() and closeTab().
const safariParts = [
  between(safariSource, "const _sessions = new Map();", "\nconst RESOLVE_CACHE_MS"),
  between(safariSource, "export function getActiveTabIndex()", "\n// ========== FAST OSASCRIPT"),
  between(safariSource, "async function _provenOwnTabIndex()", "\nexport async function switchTab("),
].join("\n");
const safariExports = [...safariParts.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

function loadSafari(window) {
  return new Function(
    "currentSessionId", "randomUUID", "osascript", "osascriptFast", "getTargetWindowRef",
    "refreshTargetWindow", "console",
    `${safariParts.replace(/^export /gm, "")}\nreturn { _st, resolveActiveTab, ${safariExports.join(", ")} };`
  )(
    () => "s1", () => "sess0001-0000-4000-8000-000000000000", window.run, window.run,
    () => "front window", async () => {}, { error() {} }
  );
}

// AppleScript's newTab(), switchTab(), listTabs() and listWindowTabs(), reduced to what they leave
// behind: the tab they open or claim carries a fresh marker, and the session tracks it by that marker.
function appleScriptTabs(safari, window) {
  let minted = 0;
  const claim = (i) => {
    const tab = window.tabs[i - 1];
    tab.marker = `MCP_sess0001_new${++minted}`;
    Object.assign(safari._st(), {
      activeTabIndex: i, activeTabURL: tab.url, activeTabMarker: tab.marker, hasOwnedTab: true,
    });
    return { title: "", url: tab.url };
  };
  safari.newTab = async (url) => {
    window.tabs.push({ url, marker: null });
    return JSON.stringify({ ...claim(window.tabs.length), tabIndex: window.tabs.length });
  };
  safari.switchTab = async (i) => JSON.stringify(claim(Number(i)));
  safari.listTabs = async () => JSON.stringify(window.list());
  safari.listWindowTabs = async () => ({ win: "window id 1", tabs: window.list() });
}

// ---------- index.js, for real ----------

const indexParts = [
  between(index, "function _originOf(", "\nfunction _isBatchSemanticFailure"),
  between(index, "function _untrackClosedTab(", "\n// Close all MCP-opened tabs on process exit"),
  between(index, "async function _runExtensionBatchAction(", "\n// Tab-ownership assertion"),
].join("\n");

// The handler a server.tool(...) call registers.
function toolHandler(name) {
  const at = index.indexOf(`server.tool(\n  "${name}",`);
  assert.ok(at >= 0, `no ${name} tool`);
  const from = index.indexOf("async (", at);
  return index.slice(from, index.indexOf("\n);\n", from));
}

function loadServer(safari, extensionOrFallback) {
  return new Function(
    "safari", "extensionOrFallback", "SESSION_ID", "currentSessionId", "process", "console",
    "textResult", "errorResult", "_evictOldestTab", "_trackTab", "_untrackTab", "_openedTabs",
    "_ownedTabURLs", "_addOwnedURL", "_markBlankTabOpened", "_isURLOwned", "_trackedAtIndex",
    "BLANK_TAB_SENTINEL", "allowUserTabs",
    `${indexParts}
    return {
      run: _runExtensionBatchAction,
      safari_new_tab: ${toolHandler("safari_new_tab")},
      safari_switch_tab: ${toolHandler("safari_switch_tab")},
      safari_wait_for_new_tab: ${toolHandler("safari_wait_for_new_tab")},
      safari_close_tab: ${toolHandler("safari_close_tab")},
    };`
  )(
    safari, extensionOrFallback, "daemon", () => "s1", { env: {} }, { error() {} },
    textResult, errorResult, async () => null, own._trackTab, own._untrackTab, own._openedTabs,
    own._ownedTabURLs, own._addOwnedURL, own._markBlankTabOpened, own._isURLOwned,
    own._trackedAtIndex, own.BLANK_TAB_SENTINEL, own.allowUserTabs
  );
}

// extensionOrFallback with the extension answering `types` as background.js does. Every other
// type fails over to the AppleScript function index.js passes in.
function extension(window, types) {
  const b = () => window.tabs.findIndex((t) => t.url === B_URL) + 1;
  const replies = {
    new_tab: ({ url }) => {
      window.tabs.push({ url, marker: null });
      return { title: "", safeUrl: url, receipt: RECEIPT_B, tabIndex: window.tabs.length };
    },
    switch_tab: ({ index: i }) => {
      const target = i || b();
      return { title: "", safeUrl: window.tabs[target - 1].url, receipt: RECEIPT_B, tabIndex: target, owned: true };
    },
    get_tab_receipt: () => ({ index: b(), safeUrl: B_URL, receipt: RECEIPT_B2 }),
    list_tabs: () => window.list().map(({ index: i, url }) => ({ index: i, title: "", safeUrl: url, active: false })),
  };
  return async (type, payload, fallback) => (types.includes(type) ? replies[type](payload) : fallback());
}

// ---------- the session: AppleScript opened tab A, then the extension's tab B ----------

// Tab 1 is the user's. A (tab 2) was opened through AppleScript, so safari.js tracks it by its
// marker. B becomes tab 3: the extension opens it (`opens`), the page pops it up while
// safari_wait_for_new_tab polls (`pops`), or the extension opened it earlier.
function session({ opens = false, pops = false } = {}) {
  const b = { url: B_URL, marker: null };
  const window = safariWindow(
    [{ url: USER_URL, marker: null }, { url: A_URL, marker: A_MARKER }, ...(opens || pops ? [] : [b])],
    pops ? [b] : []
  );
  const safari = loadSafari(window);
  Object.assign(safari._st(), {
    activeTabIndex: 2, activeTabURL: A_URL, activeTabMarker: A_MARKER, hasOwnedTab: true,
  });
  own._trackTab(2, A_URL, SESSION, A_MARKER, "");
  if (!opens && !pops) own._trackTab(3, B_URL, SESSION, "", RECEIPT_B);
  return { window, safari };
}

const PATHS = [
  { name: "safari_new_tab", opens: true, uses: ["new_tab"], call: (s) => s.safari_new_tab({ url: B_URL }) },
  { name: "run_script newTab", opens: true, uses: ["new_tab"], call: (s) => s.run("newTab", { url: B_URL }) },
  { name: "safari_switch_tab", uses: ["list_tabs", "switch_tab"], call: (s) => s.safari_switch_tab({ index: 3 }) },
  { name: "run_script switchTab", uses: ["switch_tab"], call: (s) => s.run("switchTab", { index: 3 }) },
  { name: "run_script getReceipt", uses: ["get_tab_receipt"], call: (s) => s.run("getReceipt", { receipt: RECEIPT_B }) },
  { name: "safari_wait_for_new_tab", pops: true, uses: ["list_tabs", "switch_tab"], call: (s) => s.safari_wait_for_new_tab({ timeout: 3000 }) },
];

for (const path of PATHS) {
  test(`${path.name} served by the extension: the AppleScript fallback targets that tab`, async () => {
    const { window, safari } = session(path);
    await path.call(loadServer(safari, extension(window, path.uses)));
    assert.equal(window.tabs[2].url, B_URL);
    // The extension, which knows B by id, writes the session's marker into it.
    safari.setExtensionTabMarker(async (marker) => {
      window.tabs.find((t) => t.url === B_URL).marker = marker;
      return true;
    });
    assert.equal(await safari.resolveActiveTab(), 3, "resolved to A — the tab AppleScript opened before");
  });
}

test("safari_close_tab's AppleScript fallback leaves the tab the extension opened to the extension", async () => {
  const { window, safari } = session({ opens: true });
  // The extension opens B, then fails the close. B's receipt names it, and only the extension
  // can tell which tab a receipt names, so AppleScript closes nothing (fallback-tab-proof.test).
  const server = loadServer(safari, extension(window, ["new_tab"]));
  await server.safari_new_tab({ url: B_URL });
  await assert.rejects(server.safari_close_tab({}), /Tab safety/);
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, A_URL, B_URL], "no tab closed");
  assert.deepEqual([...own._openedTabs.values()].map((t) => t.url), [A_URL, B_URL], "both records kept");
});

// The same paths with the extension down: AppleScript opens or claims the tab and stamps a
// fresh marker, which has to survive the sync — without it the tab is lost as soon as it
// redirects to another origin and the user shifts its index.
for (const path of PATHS.filter((p) => p.name !== "run_script getReceipt")) {
  test(`${path.name} served by AppleScript keeps the marker it stamped`, async () => {
    const { window, safari } = session(path);
    appleScriptTabs(safari, window);
    await path.call(loadServer(safari, extension(window, [])));
    window.tabs[2].url = "https://login.other.example/sso";
    window.tabs.splice(0, 1);
    assert.equal(await safari.resolveActiveTab(), 2);
  });
}
