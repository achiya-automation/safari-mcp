#!/usr/bin/env node
/**
 * After safari_switch_tab picks a tab whose page took it somewhere the session never registered,
 * the session keeps working in that tab, with or without SAFARI_PROFILE.
 *
 * Found by code review on 30.9.26. After a switch the Safari extension served, safari_switch_tab
 * handed safari.js the URL the extension reported for the tab. A page moves its tab by itself (a
 * login bounce, a redirect, a clicked link), so that URL can be one the session never registered,
 * and for a tab on another origin the extension returns no receipt: _receiptForOwnedTab keeps a
 * receipt on the origin it was minted on, which left the session's receipt empty.
 * _assertTabOwnership judges a write by that URL: without SAFARI_PROFILE always, and in a named
 * profile when the session holds no receipt, as after a switch to a tab on another origin. So click,
 * fill, evaluate and navigate were refused ("current tab (…) was not opened by this MCP session"),
 * and in a named profile so was the argument-free run_script getReceipt, the documented recovery
 * after a redirect, although the extension had just proven by the tab's id that the session owns
 * the tab. run_script's switchTab already leaves the URL unknown for this reason, and
 * safari_switch_tab now does too. A switch that AppleScript served still records the page AppleScript
 * read, and the extension still refuses a tab the session does not own.
 *
 * An adversarial review of that fix found that safari_navigate decided whether to rotate a receipt
 * by the same URL: an unknown one counted as an origin change, so every navigate after such a switch
 * retired the tab's receipt, and after nine even this process could not use the one it kept. The
 * URL was also another tab's when a call names its tab by receipt, and stale after a navigation the
 * extension served. safari_navigate now rotates by the origin the receipt is valid on.
 *
 * Both sides are the real code: the extension's handleCommand preflight, its get_tab_receipt
 * handler, _resolveReceiptTab, _issueTabReceipt, _getReceiptTargetTab and _switchTabForSession
 * over a fake Safari window; index.js's tool handlers, extensionOrFallback with its ownership
 * guard and the profile-mode run_script; and safari.js's per-session tab state.
 *
 * Run:  node --test test/switch-tab-redirected-tab.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-switch-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
const { textResult, errorResult, evalResult } = await import("../response.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));

// The MCP session the next call comes from (currentSessionId() in index.js and safari.js).
let sid = "";
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
  rmSync(own.OWNERSHIP_DIR, { recursive: true, force: true });
  sid = "agent";
});

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const EPOCH = "e".repeat(36);
const WINDOW = 7;
const USER_URL = "https://mail.example/inbox"; // the tab the user is looking at
const SHOP = "https://shop.example/cart";
const LOGIN = "https://login.example/sso?session=s3cr3t"; // where the shop bounces its tab
const CHECKOUT = "https://shop.example/checkout?step=2"; // the same site, a page the session never opened
const DOCS = "https://docs.example/guide";
const digest = (url) => createHash("sha256").update(String(url || "")).digest("hex");

// ---------- the extension, for real, over a fake Safari window ----------

const extensionParts = [
  between(background, "function _safeTabUrl(", "\nasync function _listTabsForSession("),
  between(background, "async function _listTabsForSession(", "\n// 2s was a happy-path budget"),
  between(background, "function _isValidReceiptRecord(", "\n// Rebuild the per-session window map"),
  between(background, "function _receiptForOwnedTab(", "\nfunction _withReceiptMutationLock("),
  between(background, "async function _issueTabReceipt(", "\nasync function _refreshTabReceiptIdentity("),
  between(background, "async function _resolveReceiptTab(", "\nfunction _addOwnedTab("),
  between(background, "function _hasTabReceiptAuthority(", "\n// The browser-run epoch lives"),
  between(background, "const _readOnlyCommands = new Set([", "\n]);") + "\n]);",
  between(background, "async function _getReceiptTargetTab(", "\nasync function getTargetTab("),
  between(background, "async function _switchTabForSession(", "\nlet _enabled = true;"),
].join("\n");
// handleCommand from resolving its target tab through its write guard, and the get_tab_receipt
// handler: which tab a command acts on, and whether its receipt lets it.
const preflight = between(background, "  // Receipt-based targeting depends on durable ownership state", "\n  switch (type) {");
const getTabReceiptCase = between(background, '    case "get_tab_receipt": {', "\n\n    // Which WINDOW holds");

function makeExtension() {
  const tabs = [{ id: 1, windowId: WINDOW, url: USER_URL, title: "", active: true }];
  const receipts = new Map(); // token → record: the extension's receipt registry
  const tokenByTab = new Map();
  const owned = new Map(); // sessionId → Set of tab ids
  const caches = new Map(); // sessionId → { tabId, tabUrl }
  const ran = []; // every command that reached a page: { type, tabId, url }
  let nextId = 100;
  let down = false;

  const live = (id) => tabs.find((tab) => tab.id === id);
  const withIndex = (tab) => ({ ...tab, index: tabs.indexOf(tab) });
  const cache = (session) => {
    if (!caches.has(session)) caches.set(session, { tabId: null, tabUrl: null });
    return caches.get(session);
  };
  const setSessionTab = (session, tabId, url) => Object.assign(cache(session), { tabId, tabUrl: url });
  const ownedBy = (session, id) => !!owned.get(session)?.has(id);
  const addOwned = async (session, id) => {
    if (!owned.has(session)) owned.set(session, new Set());
    owned.get(session).add(id);
  };
  const open = (url) => {
    const tab = { id: nextId++, windowId: WINDOW, url: url || "about:blank", title: "", active: false };
    tabs.push(tab);
    return tab;
  };

  const browser = {
    tabs: {
      query: async () => tabs.map(withIndex),
      get: async (id) => {
        const tab = live(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return withIndex(tab);
      },
    },
  };
  const ext = new Function(
    "browser", "_receiptByToken", "_tokenByTabId", "_digestTabUrl", "_persistOwnedTabs",
    "_withReceiptMutationLock", "_ensureBrowserSessionEpoch", "_isTabOwnedByAnySession",
    "_isTabOwnedBySession", "_addOwnedTab", "_sessionOwnedTabs", "_getSessionCache", "_setSessionTab",
    "_adoptWindowForSession", "_windowForSession", "_windowQuery", "getTargetTab", "_hydrateOwnedTabs",
    "_extractMcpTabMarker", "_DEFAULT_SESSION",
    `${extensionParts}
    return {
      _issueTabReceipt, _listTabsForSession, _switchTabForSession,
      async handleCommand(type, payload, pageCommand) {
        const sessionId = payload.sessionId || _DEFAULT_SESSION;
      ${preflight}
        switch (type) {
      ${getTabReceiptCase}
          default: return pageCommand(type, payload, sessionId, targetTab);
        }
      },
    };`
  )(
    browser, receipts, tokenByTab, async (url) => digest(url), async () => {},
    (operation) => operation(), async () => EPOCH, (id) => [...owned.values()].some((set) => set.has(id)),
    ownedBy, addOwned, owned, cache, setSessionTab,
    () => {}, () => WINDOW, (windowId) => ({ windowId }),
    // getTargetTab without a receipt: the session's cached tab, else the tab in front.
    async (_receipt, session) => live(cache(session).tabId) || tabs.find((tab) => tab.active),
    async () => {}, () => "", "_default"
  );

  // What the commands this test does not model through the real handlers do.
  async function pageCommand(type, payload, sessionId, target) {
    switch (type) {
      case "new_tab": {
        const tab = open(payload.url);
        setSessionTab(sessionId, tab.id, tab.url);
        await addOwned(sessionId, tab.id);
        const receipt = await ext._issueTabReceipt(tab);
        return { tabIndex: tabs.indexOf(tab) + 1, url: tab.url, receipt };
      }
      case "list_tabs":
        return ext._listTabsForSession(sessionId);
      case "switch_tab":
        return ext._switchTabForSession(sessionId, target, payload);
      case "navigate":
        live(target.id).url = payload.url;
        setSessionTab(sessionId, target.id, payload.url);
        ran.push({ type, tabId: target.id, url: payload.url });
        return { title: "", url: payload.url };
      case "click":
      case "fill":
      case "evaluate":
        ran.push({ type, tabId: target.id, url: live(target.id).url });
        return { click: "Clicked", fill: "Filled", evaluate: "Sign in" }[type];
      default:
        throw new Error(`the fake extension does not model "${type}"`);
    }
  }

  return {
    tabs, ran, open,
    // The page moves its tab by itself: nothing rotates the receipt.
    pageMoves(id, url) { live(id).url = url; },
    receiptsOf: (id) => [...receipts.values()].filter((record) => record.tabId === id),
    set down(value) { down = value; },
    // The bridge. A payload is copied, as the wire would: handleCommand writes into it.
    async send(type, payload) {
      if (down) throw Object.assign(new Error("Extension timeout after 30000ms"), { dispatched: false });
      return ext.handleCommand(type, { ...payload }, pageCommand);
    },
  };
}

// ---------- safari.js: its per-session tab state for real, its AppleScript as stubs ----------

const stateSource = [
  between(safariSource, "const _sessions = new Map();", "\nconst RESOLVE_CACHE_MS"),
  between(safariSource, "export function getActiveTabIndex()", "\n// How index.js has the Safari extension put a marker"),
].join("\n");
const stateExports = [...stateSource.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);

function loadSafari(extension) {
  const state = new Function(
    "currentSessionId", "randomUUID",
    `${stateSource.replace(/^export /gm, "")}\nreturn { _st, ${stateExports.join(", ")} };`
  )(() => sid, () => "sess0001-0000-4000-8000-000000000000");
  const appleScript = []; // every call that reached AppleScript
  // AppleScript's newTab() and switchTab(), reduced to what they leave behind: the tab they open,
  // or prove by a marker of this session, gets a fresh marker, and the session tracks it by that
  // marker and by the URL its page reports.
  let minted = 0;
  const claim = (tab) => {
    tab.marker = `MCP_${state._st().markerId}_${++minted}`;
    Object.assign(state._st(), {
      activeTabIndex: extension.tabs.indexOf(tab) + 1, activeTabURL: tab.url, activeTabMarker: tab.marker,
      hasOwnedTab: true, tabFromExtension: false,
    });
    return { title: "", url: tab.url };
  };
  const viaAppleScript = (name, result) => async () => {
    appleScript.push(name);
    return result;
  };
  return {
    ...state, appleScript,
    // Like safari.newTab(), it names the new tab's marker (onMarker) as soon as the tab exists.
    newTab: async (url, { onMarker } = {}) => {
      appleScript.push("newTab");
      const tab = extension.open(url);
      const page = claim(tab);
      onMarker?.(tab.marker);
      return JSON.stringify({ ...page, tabIndex: extension.tabs.indexOf(tab) + 1 });
    },
    switchTab: async (tabIndex) => {
      appleScript.push("switchTab");
      const tab = extension.tabs[tabIndex - 1];
      if (!String(tab?.marker || "").startsWith(`MCP_${state._st().markerId}_`)) {
        throw Object.assign(new Error(`Tab safety: refusing to switch to tab ${tabIndex} — it carries no marker of this session`), { unproven: true });
      }
      return JSON.stringify(claim(tab));
    },
    listTabs: async () => {
      appleScript.push("listTabs");
      return JSON.stringify(extension.tabs.map((tab, i) => ({ index: i + 1, title: "", url: tab.url })));
    },
    click: viaAppleScript("click", "Clicked"),
    fill: viaAppleScript("fill", "Filled"),
    evaluate: viaAppleScript("evaluate", "Sign in"),
    navigate: viaAppleScript("navigate", "{}"),
    saveFrontmostApp: async () => null,
    setFocusGuard() {},
    restoreFocusIfStolen: async () => {},
  };
}

// ---------- index.js, for real ----------

const indexParts = [
  between(index, "async function _waitForVerifiedProfileExtension(", "\n// ========== EXTENSION BRIDGE"),
  between(index, "function _untrackClosedTab(", "\n// Close all MCP-opened tabs on process exit"),
  between(index, "const _noOwnershipCheck = new Set([", "\n// Origin of a URL"),
  between(index, "function _originOf(", "\nasync function _runExtensionBatchAction("),
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
  "safari_new_tab", "safari_switch_tab", "safari_click", "safari_fill", "safari_evaluate",
  "safari_navigate", "safari_run_script",
];
const MODES = [
  { name: "without SAFARI_PROFILE", profile: "" },
  { name: "in a named profile", profile: "Work" },
];

function setup(mode) {
  const extension = makeExtension();
  const safari = loadSafari(extension);
  const deps = {
    safari, SESSION_ID: "daemon", currentSessionId: () => sid,
    process: { env: mode.profile ? { SAFARI_PROFILE: mode.profile } : {} },
    console: { error() {} }, textResult, errorResult, evalResult,
    sendToExtension: (type, payload) => extension.send(type, payload),
    _evictOldestTab: async () => null, _trackTab: own._trackTab, _untrackTab: own._untrackTab,
    _openedTabs: own._openedTabs, _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL,
    _removeOwnedURL: own._removeOwnedURL, _markBlankTabOpened: own._markBlankTabOpened,
    _isURLOwned: own._isURLOwned, _trackedAtIndex: own._trackedAtIndex, _sessionTabs: own._sessionTabs,
    allowUserTabs: own.allowUserTabs, BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    // A named profile is extension-only; without one, AppleScript is the fallback.
    _preferAppleScript: !!mode.profile, _extensionConnected: true, _profileExtensionVerified: true,
    _isExtensionHost: false, _commandTimeouts: {}, _nullMeansFailure: new Set(),
  };
  const server = new Function(
    ...Object.keys(deps),
    `${indexParts}
    return { ${TOOLS.map((name) => `${name}: ${toolHandler(name)}`).join(",\n")} };`
  )(...Object.values(deps));
  return { server, extension, safari };
}

// A refusal comes back as a thrown error, or as an error result.
async function outcome(call) {
  try {
    return JSON.stringify(await call());
  } catch (err) {
    return err.message;
  }
}
const json = (result) => JSON.parse(result.content[0].text);
const text = (result) => result.content[0].text;

// The session opens a shop tab, then a docs tab, which becomes its current one. Then the shop's
// page takes its tab to `movesTo`, and nothing tells the session.
async function movedShopTab(server, extension, movesTo) {
  const { receipt } = json(await server.safari_new_tab({ url: SHOP }));
  const tab = extension.tabs.at(-1);
  await server.safari_new_tab({ url: DOCS });
  extension.pageMoves(tab.id, movesTo);
  return { receipt, tab, index: extension.tabs.indexOf(tab) + 1 };
}

// The writes the review found refused, each on the page the tab shows then. Returns what the
// navigate answered.
async function writeThere(server) {
  assert.equal(text(await server.safari_click({ selector: "#continue" })), "Clicked");
  assert.equal(text(await server.safari_fill({ selector: "#code", value: "123456" })), "Filled");
  assert.equal(text(await server.safari_evaluate({ script: "document.title" })), "Sign in");
  const landed = json(await server.safari_navigate({ url: SHOP }));
  assert.equal(landed.url, SHOP);
  return landed;
}

for (const mode of MODES) {
  test(`${mode.name}: after a switch by index to its tab that a redirect took to another origin, the session writes there`, async () => {
    const { server, extension, safari } = setup(mode);
    const shop = await movedShopTab(server, extension, LOGIN);

    const switched = json(await server.safari_switch_tab({ index: shop.index }));
    assert.equal(switched.owned, true);
    assert.equal(switched.safeUrl, "https://login.example/sso", "the tab where it is now, without its query");
    assert.equal(switched.receipt, undefined, "a receipt bound to the shop's origin came back for the login page");
    // Neither the reported page nor the previous tab's, which the guard would judge the writes by.
    assert.equal(safari.getActiveTabURL(), null);

    await writeThere(server);
    assert.deepEqual(extension.ran, [
      { type: "click", tabId: shop.tab.id, url: LOGIN },
      { type: "fill", tabId: shop.tab.id, url: LOGIN },
      { type: "evaluate", tabId: shop.tab.id, url: LOGIN },
      { type: "navigate", tabId: shop.tab.id, url: SHOP },
    ]);
    assert.deepEqual(safari.appleScript, [], "AppleScript touched a tab");
  });

  test(`${mode.name}: after a switch by receipt to its tab that moved to another page of the same site, the session writes there`, async () => {
    const { server, extension, safari } = setup(mode);
    const shop = await movedShopTab(server, extension, CHECKOUT);

    const switched = json(await server.safari_switch_tab({ receipt: shop.receipt }));
    assert.equal(switched.safeUrl, "https://shop.example/checkout");
    assert.equal(switched.receipt, shop.receipt, "the tab is still on the receipt's origin");
    assert.equal(safari.getActiveTabURL(), null);

    const landed = await writeThere(server);
    assert.equal(landed.receipt, undefined, "a navigate within the receipt's origin handed back a fresh one");
    assert.deepEqual(extension.receiptsOf(shop.tab.id).map((record) => record.token), [shop.receipt]);
    assert.deepEqual(extension.ran, [
      { type: "click", tabId: shop.tab.id, url: CHECKOUT },
      { type: "fill", tabId: shop.tab.id, url: CHECKOUT },
      { type: "evaluate", tabId: shop.tab.id, url: CHECKOUT },
      { type: "navigate", tabId: shop.tab.id, url: SHOP },
    ]);
    assert.deepEqual(safari.appleScript, []);
  });

  // safari_navigate rotated a receipt when the tab's origin changed, judged by the URL safari.js held
  // before the navigation. After a switch the extension served that URL is unknown, and an unknown
  // origin counted as a change: every navigate retired the tab's receipt, however kept by another
  // process or across a daemon restart, and past eight rotations even this process lost it.
  test(`${mode.name}: after a switch, safari_navigate hands back a fresh receipt only when the tab leaves the receipt's origin`, async () => {
    const { server, extension } = setup(mode);
    const { receipt } = json(await server.safari_new_tab({ url: SHOP }));
    const tab = extension.tabs.at(-1);
    await server.safari_new_tab({ url: DOCS });
    await server.safari_switch_tab({ index: extension.tabs.indexOf(tab) + 1 });
    const receiptsNow = () => extension.receiptsOf(tab.id).map((record) => [record.token, record.receiptOrigin]);

    for (const page of ["https://shop.example/cart/items", "https://shop.example/checkout"]) {
      assert.equal(json(await server.safari_navigate({ url: page, receipt })).receipt, undefined, `a navigate to ${page} rotated the receipt`);
    }
    assert.deepEqual(receiptsNow(), [[receipt, "https://shop.example"]]);

    const off = json(await server.safari_navigate({ url: LOGIN, receipt }));
    assert.match(off.receipt ?? "", /^[A-Za-z0-9_-]{24,}$/, "no fresh receipt for the login origin");
    const within = json(await server.safari_navigate({ url: "https://login.example/sso/verify", receipt }));
    assert.equal(within.receipt, undefined, "a navigate within the new origin rotated the fresh receipt");
    assert.deepEqual(receiptsNow(), [[off.receipt, "https://login.example"]]);
  });

  // The same check judged a navigate that names its tab by the receipt by the URL of whichever tab
  // was current: the pattern safari_new_tab documents, one receipt kept per tab, rotated each time.
  test(`${mode.name}: a navigate that names its tab by the receipt keeps that receipt within its origin while another tab is current`, async () => {
    const { server, extension } = setup(mode);
    const { receipt } = json(await server.safari_new_tab({ url: SHOP }));
    const tab = extension.tabs.at(-1);
    await server.safari_new_tab({ url: DOCS });

    assert.equal(json(await server.safari_navigate({ url: "https://shop.example/cart/items", receipt })).receipt, undefined);
    assert.deepEqual(extension.receiptsOf(tab.id).map((record) => record.token), [receipt]);
  });

  test(`${mode.name}: the extension still refuses a switch to a tab the session does not own, and the session stays on its tab`, async () => {
    const { server, extension } = setup(mode);
    await movedShopTab(server, extension, LOGIN);
    const docs = extension.tabs.at(-1);

    assert.match(await outcome(() => server.safari_switch_tab({ index: 1 })), /Tab safety: refusing "switch_tab" to tab 1 .*not opened by this MCP session/);
    assert.equal(text(await server.safari_click({ selector: "#read" })), "Clicked");
    assert.deepEqual(extension.ran, [{ type: "click", tabId: docs.id, url: DOCS }], "a write reached the user's tab");
  });
}

test("in a named profile, a getReceipt that names no receipt rotates the tab a switch by index picked, once a redirect took it to another origin", async () => {
  const { server, extension } = setup(MODES[1]);
  const shop = await movedShopTab(server, extension, LOGIN);
  await server.safari_switch_tab({ index: shop.index });

  const [step] = json(await server.safari_run_script({ steps: [{ action: "getReceipt" }] }));
  assert.equal(step.error, undefined, `getReceipt failed: ${step.error}`);
  assert.equal(step.result.safeUrl, "https://login.example/sso");
  assert.match(step.result.receipt, /^[A-Za-z0-9_-]{24,}$/);
  assert.deepEqual(
    extension.receiptsOf(shop.tab.id).map((record) => [record.token, record.receiptOrigin]),
    [[step.result.receipt, "https://login.example"]],
    "the shop tab's receipt was not rotated to the login origin"
  );

  // The fresh receipt names the tab, and so does the session's current tab, now that it has one.
  assert.equal(text(await server.safari_click({ selector: "#continue", receipt: step.result.receipt })), "Clicked");
  assert.equal(text(await server.safari_click({ selector: "#continue" })), "Clicked");
  assert.deepEqual(extension.ran, [
    { type: "click", tabId: shop.tab.id, url: LOGIN },
    { type: "click", tabId: shop.tab.id, url: LOGIN },
  ]);
});

// The receipt's origin comes before the URL safari.js holds, which a navigation the extension
// served leaves on the page the tab left (without a profile the guard then refuses the next call).
test("in a named profile, a receipt a cross-origin safari_navigate handed back is not rotated again on its own origin", async () => {
  const { server, extension } = setup(MODES[1]);
  const { receipt } = json(await server.safari_new_tab({ url: SHOP }));
  const tab = extension.tabs.at(-1);

  const off = json(await server.safari_navigate({ url: LOGIN, receipt }));
  assert.match(off.receipt ?? "", /^[A-Za-z0-9_-]{24,}$/, "no fresh receipt for the login origin");
  const within = json(await server.safari_navigate({ url: "https://login.example/sso/verify", receipt }));
  assert.equal(within.receipt, undefined, "a navigate within the new origin rotated the fresh receipt");
  assert.deepEqual(extension.receiptsOf(tab.id).map((record) => [record.token, record.receiptOrigin]), [[off.receipt, "https://login.example"]]);
});

test("without SAFARI_PROFILE, a switch AppleScript served still records the page AppleScript read, and the guard still judges writes by it", async () => {
  const { server, extension, safari } = setup(MODES[0]);
  extension.down = true; // every command falls back to AppleScript
  const shop = await movedShopTab(server, extension, CHECKOUT);

  await server.safari_switch_tab({ index: shop.index });
  assert.ok(safari.appleScript.includes("switchTab"), "the switch did not go through AppleScript");
  assert.equal(safari.getActiveTabMarker(), shop.tab.marker, "the switch lost the marker that proves the tab");

  assert.match(
    await outcome(() => server.safari_click({ selector: "#pay" })),
    /Tab safety: refusing "click" — current tab \(https:\/\/shop\.example\/checkout\)/
  );
  assert.ok(!safari.appleScript.includes("click"), "the click ran on a page the session never opened");
});
