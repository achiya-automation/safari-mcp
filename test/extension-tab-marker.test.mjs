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
  own._adoptedTabURLs.clear();
});

const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

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
// first listing (a popup the page opens while safari_wait_for_new_tab polls). A tab with `next`
// is listed once at its `url` and at `next` after that: a popup opens on about:blank.
function safariWindow(tabs, later = []) {
  const url = (i) => tabs[i - 1]?.url || "";
  const run = async (script) => {
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
    for (const t of tabs) if (t.next) [t.url, t.next] = [t.next, undefined];
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

// AppleScript's newTab()/switchTab()/listTabs(), reduced to what they leave behind: the tab
// they open or claim carries a fresh marker, and the session tracks it by that marker.
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
    "BLANK_TAB_SENTINEL", "allowUserTabs", "_adoptUserTab",
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
    own._trackedAtIndex, own.BLANK_TAB_SENTINEL, own.allowUserTabs, own._adoptUserTab
  );
}

// background.js's own URL reduction: origin + path, no query string or fragment.
const safeTabUrl = new Function(
  `${between(background, "function _safeTabUrl(", "\nfunction _receiptOrigin")}\nreturn _safeTabUrl;`
)();

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
      const tab = window.tabs[target - 1];
      // _switchTabForSession refuses a tab this session did not open, and a refusal never falls back.
      if (tab.user) throw new Error(`⚠️ Tab safety: refusing "switch_tab" to tab ${target} (${safeTabUrl(tab.url)}) — not opened by this MCP session. Use safari_new_tab first.`);
      return { title: "", safeUrl: tab.url, receipt: RECEIPT_B, tabIndex: target, owned: true };
    },
    get_tab_receipt: () => ({ index: b(), safeUrl: B_URL, receipt: RECEIPT_B2 }),
    // _listTabsForSession: each tab's safeUrl, and no `url` at all.
    list_tabs: () => window.list().map(({ index: i, url }) => ({ index: i, title: "", safeUrl: safeTabUrl(url), active: false })),
  };
  return async (type, payload, fallback) => (types.includes(type) ? replies[type](payload) : fallback());
}

// ---------- the session: AppleScript opened tab A, then the extension's tab B ----------

// Tab 1 is the user's. A (tab 2) was opened through AppleScript, so safari.js tracks it by its
// marker. B becomes tab 3: the extension opens it (`opens`), the page pops it up while
// safari_wait_for_new_tab polls (`pops`, as `popup` when one is given), or the extension
// opened it earlier.
function session({ opens = false, pops = false, popup = { url: B_URL, marker: null } } = {}) {
  const b = popup;
  const window = safariWindow(
    [{ url: USER_URL, marker: null, user: true }, { url: A_URL, marker: A_MARKER }, ...(opens || pops ? [] : [b])],
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
    assert.equal(await safari.resolveActiveTab(), 3, "resolved to A — the tab AppleScript opened before");
  });
}

test("safari_close_tab's AppleScript fallback closes the tab the extension opened, and forgets that one", async () => {
  const { window, safari } = session({ opens: true });
  // The extension opens B, then fails the close, which falls over to AppleScript.
  const server = loadServer(safari, extension(window, ["new_tab"]));
  await server.safari_new_tab({ url: B_URL });
  await server.safari_close_tab({});
  assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, A_URL], "B closed; A and the user's tab still open");
  assert.deepEqual([...own._openedTabs.values()].map((t) => t.url), [A_URL], "B's record went with it, A's stayed");
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

// ---------- safari_wait_for_new_tab reads list_tabs in either shape ----------

// The extension's list_tabs reply names each tab by its safeUrl (origin + path) and has no
// `url`, while the AppleScript fallback's has the raw `url`. The handler read `url` alone: with
// the extension answering it keyed every tab `${index}:undefined`, never waited out a popup's
// about:blank, threw on urlContains, and reported and tracked the tab as "undefined". Served by
// AppleScript, the raw URL, query string included, reached the result and the ownership file.
const POPUP_URL = "https://login.example.com/oauth/authorize?client_id=app1&state=s3cr3t";
const POPUP_PAGE = "https://login.example.com/oauth/authorize";
const SOURCES = [
  { name: "the extension", uses: ["list_tabs", "switch_tab"] },
  { name: "AppleScript", uses: [] },
];

function popupSession(source, popup) {
  const { window, safari } = session({ pops: true, popup: { marker: null, ...popup } });
  appleScriptTabs(safari, window);
  return { window, safari, server: loadServer(safari, extension(window, source.uses)) };
}

for (const source of SOURCES) {
  test(`safari_wait_for_new_tab, tabs listed by ${source.name}: urlContains finds the popup, reported and tracked by origin + path`, async () => {
    const { window, safari, server } = popupSession(source, { url: POPUP_URL });
    const { content } = await server.safari_wait_for_new_tab({ timeout: 3000, urlContains: "/oauth/authorize" });
    assert.ok(content[0].text.endsWith(`(${POPUP_PAGE})`), content[0].text);
    assert.equal(safari.getActiveTabURL(), POPUP_PAGE);
    assert.deepEqual([...own._openedTabs.values()].map((t) => t.url), [A_URL, POPUP_PAGE]);
    assert.ok(![...own._ownedTabURLs].some((u) => u.includes("s3cr3t")), "the query string reached the ownership file");
    window.tabs.splice(0, 1); // the user closes their tab, so the popup is tab 2 now
    assert.equal(await safari.resolveActiveTab(), 2);
  });

  test(`safari_wait_for_new_tab, tabs listed by ${source.name}: a popup that opens on about:blank is reported at the page it loads`, async () => {
    const { server } = popupSession(source, { url: "about:blank", next: POPUP_URL });
    const { content } = await server.safari_wait_for_new_tab({ timeout: 3000 });
    assert.ok(content[0].text.endsWith(`(${POPUP_PAGE})`), content[0].text);
  });

  test(`safari_wait_for_new_tab, tabs listed by ${source.name}: urlContains never matches the query string`, async () => {
    const { server } = popupSession(source, { url: POPUP_URL });
    const { content } = await server.safari_wait_for_new_tab({ timeout: 600, urlContains: "state=s3cr3t" });
    assert.equal(content[0].text, "TIMEOUT: no new tab appeared");
  });
}

test("safari_wait_for_new_tab, tabs listed by the extension: a popup that reports no URL is not matched by urlContains", async () => {
  // Safari withholds tab.url from the extension on a site it has no permission for.
  const { server } = popupSession(SOURCES[0], { url: undefined });
  const { content } = await server.safari_wait_for_new_tab({ timeout: 600, urlContains: "/oauth/authorize" });
  assert.equal(content[0].text, "TIMEOUT: no new tab appeared");
});

// ---------- safari_switch_tab checks the tab list in either shape ----------

// Its ownership pre-check read `url`, which only the AppleScript fallback's list_tabs reply has:
// with the extension answering, the check never ran. The extension still refuses a tab this
// session did not open, but when its switch_tab failed for any other reason (a timeout, a worker
// restart) the AppleScript fallback, which checks nothing itself, claimed whatever tab sat at that
// index. And SAFARI_MCP_ALLOW_USER_TABS (#92) never adopted a tab while the extension listed them.
const LISTERS = [
  { name: "the extension", uses: ["list_tabs"] },
  { name: "AppleScript", uses: [] },
];

// What the MCP client receives: the SDK reports a thrown error as an isError result.
const clientSees = (call) => call.catch((e) => ({ isError: true, content: [{ type: "text", text: e.message }] }));

function switchSession(uses, { optIn = false } = {}) {
  if (optIn) process.env.SAFARI_MCP_ALLOW_USER_TABS = "1";
  else delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
  const { window, safari } = session();
  appleScriptTabs(safari, window);
  return { window, safari, server: loadServer(safari, extension(window, uses)) };
}
after(() => delete process.env.SAFARI_MCP_ALLOW_USER_TABS);

for (const lister of LISTERS) {
  test(`safari_switch_tab, tabs listed by ${lister.name}: the AppleScript switch refuses a tab this session did not open`, async () => {
    const { window, safari, server } = switchSession(lister.uses);
    const { isError, content } = await clientSees(server.safari_switch_tab({ index: 1 }));
    assert.ok(isError, "switched to the user's tab");
    assert.match(content[0].text, /refusing switch_tab to index 1 \(https:\/\/mail\.example\.com\/inbox\)/);
    assert.equal(window.tabs[0].marker, null, "AppleScript stamped the user's tab");
    assert.equal(await safari.resolveActiveTab(), 2, "the session's tab is still A");
  });

  test(`safari_switch_tab, tabs listed by ${lister.name}: with SAFARI_MCP_ALLOW_USER_TABS the AppleScript switch adopts the user's tab`, async () => {
    const { server } = switchSession(lister.uses, { optIn: true });
    const { content } = await server.safari_switch_tab({ index: 1 });
    assert.equal(JSON.parse(content[0].text).note, "(user tab, opted-in)", content[0].text);
    assert.ok(own._isAdoptedURL(USER_URL));
  });
}

test("safari_switch_tab, tabs listed by the extension: the AppleScript switch refuses a tab listed without a URL", async () => {
  // Safari withholds tab.url from an extension on a site it has no permission for.
  const { window, server } = switchSession(["list_tabs"]);
  window.tabs[0].url = undefined;
  assert.ok((await clientSees(server.safari_switch_tab({ index: 1 }))).isError, "switched to a tab of unknown ownership");
  assert.equal(window.tabs[0].marker, null);
});

test("safari_switch_tab switched by the extension: a user's tab it refuses is not adopted, and the refusal says why the opt-in did not apply", async () => {
  const { window, server } = switchSession(["list_tabs", "switch_tab"], { optIn: true });
  const { isError, content } = await clientSees(server.safari_switch_tab({ index: 1 }));
  assert.ok(isError);
  assert.match(content[0].text, /refusing "switch_tab"[\s\S]*SAFARI_MCP_ALLOW_USER_TABS/);
  assert.equal(own._isAdoptedURL(USER_URL), false, "adopted a tab the switch never reached");
  assert.equal(window.tabs[0].marker, null);
});

test("safari_switch_tab switched by the extension: a tab it opened stays reachable after redirecting to another origin", async () => {
  // The extension owns the tab by its id. The server never registered the new URL, and that is no
  // reason to refuse a switch the extension itself allows.
  const { window, server } = switchSession(["list_tabs", "switch_tab"]);
  window.tabs[2].url = "https://login.other.example/sso";
  const { isError, content } = await clientSees(server.safari_switch_tab({ index: 3 }));
  assert.ok(!isError, content[0].text);
  assert.equal(JSON.parse(content[0].text).tabIndex, 3);
});
