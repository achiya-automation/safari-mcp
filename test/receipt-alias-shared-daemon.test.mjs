#!/usr/bin/env node
/**
 * A call that names no receipt follows a rotation another client of the same daemon made, and a
 * rotation aliases only the receipt it rotated.
 *
 * Found by code review on 30.9.26. In HTTP-daemon mode (SAFARI_MCP_HTTP) one process serves every
 * MCP client: _activeReceipts, each client's current receipt, is keyed per client session, while
 * _receiptAliases, which keeps a rotated receipt resolving to the one that replaced it, is shared
 * by the whole process. _setActiveReceipt resolved aliases when it stored a receipt, and
 * _getActiveReceipt() returned it as stored. Once one client rotated a tab's receipt R to N (a
 * cross-origin safari_navigate, run_script getReceipt), the extension retired R, and a second
 * client that held R as its current receipt had every call that named no receipt refused ("this
 * extension has no record of that receipt"): extensionOrFallback attached the stored R, and so did
 * the mark_tab hook safari.js's AppleScript fallback asks to find the tab, and safari_close_tab
 * closed nothing. The same client's calls that passed R worked, because _explicitReceipt follows
 * the alias.
 *
 * Reading the current receipt through the aliases makes an alias as good as the receipt it
 * replaces for every client that held that receipt, so an alias may only ever join two receipts
 * of one tab. Both rotations named no receipt when their caller passed none, and extensionOrFallback
 * then attached the session's receipt as it stood after its own awaits: a call running alongside
 * that named another tab got that tab's receipt re-minted, and the alias sent every holder of the
 * first tab's receipt to the second tab, which none of them ever held a receipt for.
 * safari_navigate also read the receipt it rotates only once the page had loaded, so a call
 * alongside during the load got its own tab rotated, and that tab's receipt handed back as the
 * navigated tab's.
 *
 * Each rotation added one link to the alias chain, and _receiptToken follows at most eight: after
 * a handful of cross-origin navigations in one tab, the receipt the tab was opened with stopped
 * resolving, for the client that kept passing it and for every client holding it as its current one.
 *
 * A call reads the receipt it names when it starts, and may then wait for the profile's worker.
 * Another client's rotation in that time retired the receipt: extensionOrFallback now looks it up
 * again when it sends the command, and a rotation aliases the receipt it actually sent.
 *
 * Both sides are the real code: the extension's handleCommand preflight, its get_tab_receipt
 * handler, _resolveReceiptTab and _issueTabReceipt over a fake Safari window; index.js's tool
 * handlers, extensionOrFallback with its guards, the batch actions and the mark_tab hook. Two
 * MCP sessions of one daemon share the module state, as they do in the HTTP daemon.
 *
 * Run:  node --test test/receipt-alias-shared-daemon.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-alias-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
const { textResult, errorResult } = await import("../response.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));

// The MCP session the next call comes from (currentSessionId() in index.js). "agent" and
// "subagent" are two clients of one daemon. Calls that run at the same time name their session
// through `as`, as transport.js runs each request in its own AsyncLocalStorage context.
let sid = "";
const client = new AsyncLocalStorage();
const session = () => client.getStore() ?? sid;
const as = (name, call) => client.run(name, call);
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
  rmSync(own.OWNERSHIP_DIR, { recursive: true, force: true });
  sid = "agent";
});

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

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
const DOCS = "https://docs.example/";
const LOGIN = "https://login.example/sso";
const THIRD = "https://third.example/";
const RECEIPT = /^[A-Za-z0-9_-]{24,}$/;
const digest = (url) => createHash("sha256").update(String(url || "")).digest("hex");

// ---------- the extension, for real, over a fake Safari window ----------

const extensionParts = [
  between(background, "function _safeTabUrl(", "\nasync function _listTabsForSession("),
  between(background, "function _isValidReceiptRecord(", "\n// Rebuild the per-session window map"),
  between(background, "function _receiptForOwnedTab(", "\nfunction _withReceiptMutationLock("),
  between(background, "async function _issueTabReceipt(", "\nasync function _refreshTabReceiptIdentity("),
  between(background, "async function _resolveReceiptTab(", "\nfunction _addOwnedTab("),
  between(background, "function _hasTabReceiptAuthority(", "\n// The browser-run epoch lives"),
  between(background, "const _readOnlyCommands = new Set([", "\n]);") + "\n]);",
  between(background, "async function _getReceiptTargetTab(", "\nasync function getTargetTab("),
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
  const ran = []; // every command that reached a page
  const hooks = {};
  let nextId = 100;

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
    "_adoptWindowForSession", "_windowForSession", "getTargetTab", "_hydrateOwnedTabs",
    "_extractMcpTabMarker", "_DEFAULT_SESSION",
    `${extensionParts}
    return {
      _issueTabReceipt,
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
    () => {}, () => WINDOW,
    // getTargetTab without a receipt: the session's cached tab, else the tab in front.
    async (_receipt, session) => live(cache(session).tabId) || tabs.find((tab) => tab.active),
    async () => {}, () => "", "_default"
  );

  // What the commands this test does not model through the real handlers do.
  async function pageCommand(type, payload, sessionId, target) {
    switch (type) {
      case "new_tab": {
        const tab = { id: nextId++, windowId: WINDOW, url: payload.url || "about:blank", title: "", active: false };
        tabs.push(tab);
        setSessionTab(sessionId, tab.id, tab.url);
        await addOwned(sessionId, tab.id);
        const receipt = await ext._issueTabReceipt(tab);
        return { tabIndex: tabs.indexOf(tab) + 1, url: tab.url, receipt };
      }
      case "navigate":
        live(target.id).url = payload.url;
        setSessionTab(sessionId, target.id, payload.url);
        ran.push({ type, tabId: target.id, url: payload.url });
        await hooks.loading; // the page is still loading until the test says otherwise
        hooks.afterNavigate?.();
        return { title: "", url: payload.url };
      case "navigate_and_read":
        live(target.id).url = payload.url;
        setSessionTab(sessionId, target.id, payload.url);
        ran.push({ type, tabId: target.id, url: payload.url });
        // The real handler answers with the page as a JSON string.
        return JSON.stringify({ title: "", url: payload.url, text: "page" });
      case "click":
        ran.push({ type, tabId: target.id, url: live(target.id).url });
        return "Clicked";
      case "mark_tab":
        ran.push({ type, tabId: target.id, marker: payload.marker });
        return true;
      case "close_tab":
        // The tab goes, and with it its receipt and every session's claim on it.
        tabs.splice(tabs.indexOf(live(target.id)), 1);
        receipts.delete(tokenByTab.get(target.id));
        tokenByTab.delete(target.id);
        for (const set of owned.values()) set.delete(target.id);
        return "Tab closed";
      default:
        throw new Error(`the fake extension does not model "${type}"`);
    }
  }

  const sent = []; // every command that reached the extension
  return {
    tabs, ran, hooks, sent,
    // The page moves its tab by itself: nothing rotates the receipt.
    pageMoves(id, url) { live(id).url = url; },
    receiptsOf: (id) => [...receipts.values()].filter((record) => record.tabId === id),
    // The bridge. A payload is copied, as the wire would: handleCommand writes into it.
    send(type, payload) {
      sent.push(type);
      return ext.handleCommand(type, { ...payload }, pageCommand);
    },
  };
}

// ---------- safari.js, as index.js sees it ----------

function fakeSafari() {
  const appleScript = []; // every call that reached AppleScript
  const viaAppleScript = (name) => async () => {
    appleScript.push(name);
    return `${name} ok`;
  };
  // safari.js keeps the current tab per MCP session.
  const states = new Map();
  const st = () => {
    if (!states.has(session())) states.set(session(), { url: null, index: null, owned: false });
    return states.get(session());
  };
  let markTab = null; // the hook index.js registers for the AppleScript fallback
  return {
    appleScript,
    // What safari.js does when AppleScript first needs the session's current tab.
    markTab: (marker) => markTab(marker),
    setExtensionTabMarker(fn) { markTab = fn; },
    getActiveTabURL: () => st().url,
    setActiveTabURL: (url) => { st().url = url; },
    setActiveTabIndex: (i) => { st().index = i; },
    setActiveTabFromExtension: (_reported, url) => Object.assign(st(), { index: null, url: url || null, owned: true }),
    hasOwnedTab: () => st().owned,
    getActiveTabMarker: () => null,
    isActiveTabAdopted: () => false,
    saveFrontmostApp: async () => null,
    setFocusGuard() {},
    restoreFocusIfStolen: async () => {},
    newTab: viaAppleScript("newTab"),
    navigate: viaAppleScript("navigate"),
    click: viaAppleScript("click"),
    closeTab: viaAppleScript("closeTab"),
  };
}

// ---------- index.js, for real ----------

const indexParts = [
  between(index, "async function _waitForVerifiedProfileExtension(", "\n// ========== EXTENSION BRIDGE"),
  between(index, "function _untrackClosedTab(", "\n// Close all MCP-opened tabs on process exit"),
  between(index, "const _noOwnershipCheck = new Set([", "\n// Origin of a URL"),
  between(index, "function _originOf(", "\nasync function _runExtensionBatchAction("),
  between(index, "async function _runExtensionBatchAction(", "\n// The cookie / localStorage / sessionStorage tools"),
  between(index, "safari.setExtensionTabMarker(async", "\n// Read version from package.json"),
].join("\n");

// The handler a server.tool(...) call registers.
function toolHandler(name) {
  const at = index.indexOf(`server.tool(\n  "${name}",`);
  assert.ok(at >= 0, `no ${name} tool`);
  const from = index.indexOf("async (", at);
  return index.slice(from, index.indexOf("\n);\n", from));
}

const TOOLS = ["safari_new_tab", "safari_click", "safari_navigate", "safari_navigate_and_read", "safari_close_tab", "safari_run_script"];
const MODES = [
  { name: "without SAFARI_PROFILE", profile: "" },
  { name: "in a named profile", profile: "Work" },
];

function setup(mode) {
  const extension = makeExtension();
  const safari = fakeSafari();
  const deps = {
    safari, SESSION_ID: "daemon", currentSessionId: session,
    process: { env: mode.profile ? { SAFARI_PROFILE: mode.profile } : {} },
    console: { error() {} }, textResult, errorResult,
    sendToExtension: (type, payload) => extension.send(type, payload),
    _evictOldestTab: async () => null, _trackTab: own._trackTab, _untrackTab: own._untrackTab,
    _openedTabs: own._openedTabs, _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL,
    _removeOwnedURL: own._removeOwnedURL, _markBlankTabOpened: own._markBlankTabOpened,
    _isURLOwned: own._isURLOwned, _trackedAtIndex: own._trackedAtIndex, _sessionTabs: own._sessionTabs,
    allowUserTabs: own.allowUserTabs, BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    // A named profile is extension-only; without one, AppleScript is the fallback.
    _preferAppleScript: !!mode.profile, _extensionConnected: true, _profileExtensionVerified: true,
    _primaryHasExtension: false, _isExtensionHost: false, _commandTimeouts: {}, _nullMeansFailure: new Set(),
  };
  const server = new Function(
    ...Object.keys(deps),
    `${indexParts}
    return {
      // Safari restarted the profile's worker: calls wait until it has verified again.
      setVerified(value) { _profileExtensionVerified = value; },
      ${TOOLS.map((name) => `${name}: ${toolHandler(name)}`).join(",\n")}
    };`
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
const CLICKED = JSON.stringify(textResult("Clicked"));
// Long enough for the fake extension's promises to settle, far shorter than the 250ms in which
// a call that waits for the profile's worker checks on it again.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// The agent opens a tab and hands its receipt to the subagent, which works in the tab with it:
// that receipt becomes the subagent's current one.
async function sharedTab(server, extension) {
  const { receipt } = json(await server.safari_new_tab({ url: SHOP }));
  const shop = extension.tabs.at(-1);
  sid = "subagent";
  assert.equal(await outcome(() => server.safari_click({ selector: "#add", receipt })), CLICKED);
  sid = "agent";
  return { receipt, shop };
}

// ...and goes on in another tab, from which it sends the shared tab elsewhere by its receipt.
async function sharedTabAgentLeft(server, extension) {
  const shared = await sharedTab(server, extension);
  await server.safari_new_tab({ url: DOCS });
  return shared;
}

// ---------- 1. the other client's calls that name no receipt ----------

// The ways a client rotates a tab's receipt: every navigation it asks for to another origin, and
// the getReceipt step the origin refusal advises once the page itself has taken the tab there.
// safari_navigate_and_read and run_script's navigate steps used to hand back no receipt, and the
// tab's next call was refused ("not valid for this origin"). Without SAFARI_PROFILE, run_script
// runs safari.js's AppleScript actions, which leave receipts alone.
const ROTATIONS = [
  {
    name: "safari_navigate to another origin",
    modes: MODES,
    async rotate(server, extension, tab, receipt, url) {
      return json(await server.safari_navigate({ url, receipt })).receipt;
    },
  },
  {
    name: "safari_navigate_and_read to another origin",
    modes: MODES,
    async rotate(server, extension, tab, receipt, url) {
      const page = json(await server.safari_navigate_and_read({ url, receipt }));
      assert.equal(page.text, "page", "the page went missing from the result");
      return page.receipt;
    },
  },
  ...["navigate", "navigateAndRead"].map((action) => ({
    name: `a run_script ${action} step to another origin`,
    modes: [MODES[1]],
    async rotate(server, extension, tab, receipt, url) {
      // The step navigates the session's current tab: the one this receipt names.
      await server.safari_click({ selector: "#here", receipt });
      const [{ result, error }] = json(await server.safari_run_script({ steps: [{ action, args: { url } }] }));
      assert.equal(error, undefined, `${action} failed: ${error}`);
      return result.receipt;
    },
  })),
  {
    name: "run_script getReceipt",
    modes: [MODES[1]],
    async rotate(server, extension, tab, receipt, url) {
      extension.pageMoves(tab.id, url);
      const [{ result, error }] = json(await server.safari_run_script({ steps: [{ action: "getReceipt", args: { receipt } }] }));
      assert.equal(error, undefined, `getReceipt failed: ${error}`);
      return result.receipt;
    },
  },
];

for (const rotation of ROTATIONS) {
  for (const mode of rotation.modes) {
    test(`${mode.name}: after another client's ${rotation.name}, a call that names no receipt still reaches the tab`, async () => {
      const { server, extension, safari } = setup(mode);
      const { receipt, shop } = await sharedTabAgentLeft(server, extension);

      const fresh = await rotation.rotate(server, extension, shop, receipt, LOGIN);
      assert.match(fresh ?? "", RECEIPT, "the rotation handed back no receipt");
      assert.notEqual(fresh, receipt, "a rotation mints a new receipt");
      // Presented to the extension as it is, the receipt the subagent holds is gone.
      await assert.rejects(extension.send("click", { receipt, sessionId: "daemon:subagent" }), /no record of that receipt/);

      sid = "subagent";
      assert.equal(await outcome(() => server.safari_click({ selector: "#continue" })), CLICKED);
      assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: shop.id, url: LOGIN });

      // Every later rotation chains on.
      sid = "agent";
      await rotation.rotate(server, extension, shop, fresh, THIRD);
      sid = "subagent";
      assert.equal(await outcome(() => server.safari_click({ selector: "#next" })), CLICKED);
      assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: shop.id, url: THIRD });
      assert.deepEqual(safari.appleScript, [], "AppleScript touched a tab");
    });
  }
}

for (const mode of MODES) {
  test(`${mode.name}: a receipt keeps resolving however often another client has rotated it since`, async () => {
    const { server, extension } = setup(mode);
    const { receipt, shop } = await sharedTabAgentLeft(server, extension);
    // A crawl through one tab: every origin it leaves rotates the tab's receipt. The agent keeps
    // passing the first receipt it saw, as callers do.
    const sites = Array.from({ length: 12 }, (_, i) => `https://site${i}.example/`);
    for (const url of sites) {
      const landed = json(await server.safari_navigate({ url, receipt }));
      assert.match(landed.receipt ?? "", RECEIPT, `the navigation to ${url} handed back no receipt`);
    }
    assert.equal(extension.receiptsOf(shop.id).length, 1);

    sid = "subagent";
    assert.equal(await outcome(() => server.safari_click({ selector: "#continue" })), CLICKED);
    assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: shop.id, url: sites.at(-1) });
  });
}

test("without SAFARI_PROFILE, the AppleScript fallback of a client whose receipt another client rotated still gets its tab marked", async () => {
  const { server, extension, safari } = setup(MODES[0]);
  const { receipt, shop } = await sharedTabAgentLeft(server, extension);
  await server.safari_navigate({ url: LOGIN, receipt });

  // AppleScript acts on a tab the extension opened only once the extension has written the
  // session's marker into it, and the extension finds that tab by the session's current receipt.
  sid = "subagent";
  assert.equal(await safari.markTab("MCP_subagent_1"), true, "the extension marked no tab");
  assert.deepEqual(extension.ran.at(-1), { type: "mark_tab", tabId: shop.id, marker: "MCP_subagent_1" });
});

for (const mode of MODES) {
  test(`${mode.name}: after another client rotated the receipt, safari_close_tab without a receipt closes the tab and forgets it`, async () => {
    const { server, extension, safari } = setup(mode);
    const { receipt, shop } = await sharedTabAgentLeft(server, extension);
    await server.safari_navigate({ url: LOGIN, receipt });

    sid = "subagent";
    assert.equal(await outcome(() => server.safari_close_tab({})), JSON.stringify(textResult("Tab closed")));
    assert.ok(!extension.tabs.includes(shop), "the tab is still open");
    // The agent's record of the tab goes too, so the tab cap stops counting it.
    assert.deepEqual([...own._openedTabs.values()].map((info) => info.url), [DOCS]);
    // It was the subagent's current tab, and the subagent has none now: there is no tab to mark,
    // so nothing is sent. (The extension would refuse the closed tab's receipt with the same false.)
    const before = extension.sent.length;
    assert.equal(await safari.markTab("MCP_subagent_2"), false);
    assert.deepEqual(extension.sent.slice(before), [], "the subagent still holds the closed tab's receipt as its current one");
    assert.deepEqual(safari.appleScript, [], "AppleScript touched a tab");
  });
}

// ---------- 2. an alias joins two receipts of one tab ----------

// A rotation that names no receipt re-mints the receipt of the session's current tab. While it
// waits for the profile's worker, a call alongside names another tab of the same session, which
// makes that tab the current one. Whatever it names, the rotation has to re-mint the receipt it
// aliases: another client that holds the old receipt follows the alias, and must land on the tab
// it held a receipt for, never on the other one.

test("in a named profile, run_script getReceipt that names no receipt aliases the receipt it re-minted, whatever a call alongside names", async () => {
  const { server, extension } = setup(MODES[1]);
  const { receipt: docsReceipt } = json(await server.safari_new_tab({ url: DOCS }));
  const docs = extension.tabs.at(-1);
  const { shop } = await sharedTab(server, extension); // the agent's current tab
  extension.pageMoves(shop.id, LOGIN);

  server.setVerified(false);
  const rotation = server.safari_run_script({ steps: [{ action: "getReceipt" }] });
  const alongside = outcome(() => server.safari_click({ selector: "#read", receipt: docsReceipt }));
  server.setVerified(true);
  const [{ result, error }] = json(await rotation);
  const read = await alongside;

  sid = "subagent";
  const continued = await outcome(() => server.safari_click({ selector: "#continue" }));
  assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: shop.id, url: LOGIN },
    `the subagent's call did not reach the tab it held a receipt for: ${continued}`);
  assert.equal(error, undefined, `getReceipt failed: ${error}`);
  assert.equal(read, CLICKED);
  assert.equal(result.safeUrl, LOGIN, "getReceipt rotated another tab");
  assert.deepEqual(extension.receiptsOf(shop.id).map((r) => r.token), [result.receipt]);
  assert.deepEqual(extension.receiptsOf(docs.id).map((r) => r.token), [docsReceipt], "the docs tab's receipt was re-minted");
});

test("in a named profile, safari_navigate's rotation aliases the receipt of the tab it navigated, whatever a call alongside names", async () => {
  const { server, extension } = setup(MODES[1]);
  const { receipt: docsReceipt } = json(await server.safari_new_tab({ url: DOCS }));
  const docs = extension.tabs.at(-1);
  const { shop } = await sharedTab(server, extension); // the agent's current tab

  // Safari suspends the profile's worker as the page finishes loading: the rotation that follows
  // the navigation waits for it to verify again.
  extension.hooks.afterNavigate = () => server.setVerified(false);
  const navigation = server.safari_navigate({ url: LOGIN });
  await settle();
  extension.hooks.afterNavigate = null;
  const alongside = outcome(() => server.safari_click({ selector: "#read", receipt: docsReceipt }));
  server.setVerified(true);
  const landed = json(await navigation);
  const read = await alongside;

  sid = "subagent";
  const continued = await outcome(() => server.safari_click({ selector: "#continue" }));
  assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: shop.id, url: LOGIN },
    `the subagent's call did not reach the tab it held a receipt for: ${continued}`);
  assert.equal(read, CLICKED);
  assert.deepEqual(extension.receiptsOf(shop.id).map((r) => r.token), [landed.receipt], "navigate handed back another tab's receipt");
  assert.deepEqual(extension.receiptsOf(docs.id).map((r) => r.token), [docsReceipt], "the docs tab's receipt was re-minted");
});

for (const mode of MODES) {
  test(`${mode.name}: safari_navigate rotates and hands back the receipt of the tab it navigated, whatever a call alongside names while the page loads`, async () => {
    const { server, extension } = setup(mode);
    const { receipt: docsReceipt } = json(await server.safari_new_tab({ url: DOCS }));
    const docs = extension.tabs.at(-1);
    const { shop } = await sharedTab(server, extension); // the agent's current tab

    let loaded;
    extension.hooks.loading = new Promise((resolve) => { loaded = resolve; });
    const navigation = server.safari_navigate({ url: LOGIN });
    await settle();
    // While the page loads, a call alongside works in the docs tab, which makes it the current one.
    const read = await outcome(() => server.safari_click({ selector: "#read", receipt: docsReceipt }));
    extension.hooks.loading = null;
    loaded();
    const landed = json(await navigation);

    sid = "subagent";
    const continued = await outcome(() => server.safari_click({ selector: "#continue" }));
    assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: shop.id, url: LOGIN },
      `the subagent's call did not reach the tab it held a receipt for: ${continued}`);
    assert.deepEqual(extension.receiptsOf(shop.id).map((r) => r.token), [landed.receipt], "navigate handed back another tab's receipt");
    assert.deepEqual(extension.receiptsOf(docs.id).map((r) => r.token), [docsReceipt], "the docs tab's receipt was re-minted");
    assert.equal(read, CLICKED);
  });
}

// ---------- 3. a receipt named when a call starts, rotated while it waits ----------

// Both clients' calls wait for the profile's worker, which Safari suspended; when it is back, the
// one that started first runs first.

test("in a named profile, a navigate that names no receipt follows a rotation another client made while it waited for the extension", async () => {
  const { server, extension } = setup(MODES[1]);
  const { receipt, shop } = await sharedTab(server, extension); // the agent's current tab
  extension.pageMoves(shop.id, LOGIN);

  server.setVerified(false);
  const rotation = as("subagent", () => server.safari_run_script({ steps: [{ action: "getReceipt" }] }));
  const navigation = as("agent", () => server.safari_navigate({ url: THIRD }));
  server.setVerified(true);
  const [{ result, error }] = json(await rotation);
  assert.equal(error, undefined, `getReceipt failed: ${error}`);
  const navigated = await navigation.then(json, (err) => ({ error: err.message }));
  assert.equal(navigated.error, undefined, `the navigation was refused: ${navigated.error}`);
  assert.deepEqual(extension.ran.at(-1), { type: "navigate", tabId: shop.id, url: THIRD });
  assert.deepEqual(extension.receiptsOf(shop.id).map((r) => r.token), [navigated.receipt]);
  assert.notEqual(navigated.receipt, result.receipt);

  // Both clients, and the receipt the tab was opened with, still reach the tab.
  for (const [name, args] of [["subagent", {}], ["agent", {}], ["agent", { receipt }]]) {
    assert.equal(await as(name, () => outcome(() => server.safari_click({ selector: "#go", ...args }))), CLICKED, `${name} ${JSON.stringify(args)}`);
    assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: shop.id, url: THIRD });
  }
});

test("in a named profile, a getReceipt that waited for the extension rotates the receipt the tab has by then, and the client that rotated it first keeps working", async () => {
  const { server, extension } = setup(MODES[1]);
  const { receipt, shop } = await sharedTab(server, extension); // the agent's current tab
  extension.pageMoves(shop.id, LOGIN);

  server.setVerified(false);
  const first = as("agent", () => server.safari_run_script({ steps: [{ action: "getReceipt" }] }));
  const second = as("subagent", () => server.safari_run_script({ steps: [{ action: "getReceipt" }] }));
  server.setVerified(true);
  const [a] = json(await first);
  const [b] = json(await second);
  assert.equal(a.error, undefined, `the agent's getReceipt failed: ${a.error}`);
  assert.equal(b.error, undefined, `the subagent's getReceipt failed: ${b.error}`);
  assert.deepEqual(extension.receiptsOf(shop.id).map((r) => r.token), [b.result.receipt]);

  // Every receipt the tab has had still reaches it, and so does each client's current one.
  for (const [name, args] of [["agent", {}], ["subagent", {}], ["agent", { receipt }], ["agent", { receipt: a.result.receipt }]]) {
    assert.equal(await as(name, () => outcome(() => server.safari_click({ selector: "#go", ...args }))), CLICKED, `${name} ${JSON.stringify(args)}`);
    assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: shop.id, url: LOGIN });
  }
});

// The navigation carries the receipt as it resolves when it is sent, so whether it left that
// receipt's origin is judged by that receipt, not by the one the call started with.
for (const { name, url, rotates } of [
  { name: "returns to the origin of the receipt it started with", url: "https://shop.example/checkout", rotates: true },
  { name: "stays on the origin of the receipt it sent", url: "https://login.example/done", rotates: false },
]) {
  test(`in a named profile, a navigate that names no receipt and ${name} after another client rotated it ${rotates ? "rotates" : "keeps"} the receipt it sent`, async () => {
    const { server, extension } = setup(MODES[1]);
    const { receipt, shop } = await sharedTab(server, extension); // the agent's current tab
    extension.pageMoves(shop.id, LOGIN);

    server.setVerified(false);
    const rotation = as("subagent", () => server.safari_run_script({ steps: [{ action: "getReceipt" }] }));
    const navigation = as("agent", () => server.safari_navigate({ url }));
    server.setVerified(true);
    const [{ result, error }] = json(await rotation);
    assert.equal(error, undefined, `getReceipt failed: ${error}`);
    const navigated = await navigation.then(json, (err) => ({ error: err.message }));
    assert.equal(navigated.error, undefined, `the navigation was refused: ${navigated.error}`);
    assert.equal(extension.sent.filter((type) => type === "get_tab_receipt").length, rotates ? 2 : 1);
    const current = rotates ? navigated.receipt : result.receipt;
    assert.equal(navigated.receipt, rotates ? current : undefined);
    assert.deepEqual(extension.receiptsOf(shop.id).map((r) => [r.token, r.receiptOrigin]), [[current, new URL(url).origin]]);

    for (const [who, args] of [["subagent", {}], ["agent", {}], ["agent", { receipt }]]) {
      assert.equal(await as(who, () => outcome(() => server.safari_click({ selector: "#go", ...args }))), CLICKED, `${who} ${JSON.stringify(args)}`);
      assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: shop.id, url });
    }
  });
}
