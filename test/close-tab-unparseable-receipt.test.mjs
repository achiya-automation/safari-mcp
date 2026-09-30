#!/usr/bin/env node
/**
 * A close that names a receipt the server cannot parse is refused, and closes no tab. It closed
 * the session's current tab instead.
 *
 * Found by code review on 30.9.26. safari_close_tab took its target from
 * `_receiptToken(supplied) || _getActiveReceipt()`, and run_script's closeTab step in a named
 * profile from the same expression. `_receiptToken` returns "" for a value that is not a receipt:
 * the "<old receipt>" of the refusal's getReceipt advice pasted as it is, a token cut to fewer than
 * 24 characters, one with whitespace or quotes around it, a page URL in the deprecated `url`
 * parameter. The close then fell through to the receipt of the session's current tab, and the
 * extension closed the tab the caller was still working in, not the one it named. The refusal
 * written for such a receipt ("Tab safety: invalid tab receipt") fired only when the current tab
 * had no receipt. safari_switch_tab and run_script switchTab already refused such a receipt.
 * Without SAFARI_PROFILE, run_script's closeTab refuses any receipt before it runs, as AppleScript
 * cannot tell which tab one names (test/fallback-tab-proof.test.mjs).
 *
 * Both sides are the real code: the extension's handleCommand preflight and close_tab case,
 * _resolveReceiptTab, _issueTabReceipt and _closeTabForSession over a fake Safari window;
 * index.js's safari_new_tab, safari_close_tab and safari_run_script handlers, with
 * extensionOrFallback and its guards.
 *
 * Run:  node --test test/close-tab-unparseable-receipt.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-close-receipt-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
const { textResult, errorResult } = await import("../response.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
  rmSync(own.OWNERSHIP_DIR, { recursive: true, force: true });
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
const DOCS = "https://docs.example/guide"; // the tab the caller means to close
const SHOP = "https://shop.example/cart"; // the session's current tab
const BLOG = "https://blog.example/post";
const digest = (url) => createHash("sha256").update(String(url || "")).digest("hex");

// ---------- the extension, for real, over a fake Safari window ----------

const extensionParts = [
  between(background, "function _safeTabUrl(", "\nasync function _listTabsForSession("),
  between(background, "function _isValidReceiptRecord(", "\n// Rebuild the per-session window map"),
  between(background, "function _extractMcpTabMarker(", "\nfunction _withReceiptMutationLock("),
  between(background, "async function _issueTabReceipt(", "\nasync function _refreshTabReceiptIdentity("),
  between(background, "async function _resolveReceiptTab(", "\nfunction _addOwnedTab("),
  between(background, "function _hasTabReceiptAuthority(", "\n// The browser-run epoch lives"),
  between(background, "const _readOnlyCommands = new Set([", "\n]);") + "\n]);",
  between(background, "async function _closeTabForSession(", "\nasync function _switchTabForSession("),
].join("\n");
// handleCommand from resolving its target tab through its write guard, and its close_tab case.
const preflight = between(background, "  // Receipt-based targeting depends on durable ownership state", "\n  switch (type) {");
const closeCase = between(background, '    case "close_tab": {', '\n\n    case "switch_tab": {');

function makeExtension() {
  const tabs = [{ id: 1, windowId: WINDOW, url: USER_URL, title: "", active: true }];
  const receipts = new Map(); // token → record: the extension's receipt registry
  const tokenByTab = new Map();
  const owned = new Map(); // sessionId → Set of tab ids
  const cached = new Map(); // sessionId → the tab id new_tab left as the session's tab
  const sent = []; // every command the server sent: its type, and the receipt it carried
  let nextId = 100;

  const live = (id) => tabs.find((tab) => tab.id === id);
  const withIndex = (tab) => ({ ...tab, index: tabs.indexOf(tab) });
  const anyOwner = (id) => [...owned.values()].some((set) => set.has(id));
  // A tab no session owns any more keeps no receipt (_removeOwnedTab, tabs.onRemoved).
  const revoke = (id) => {
    const token = tokenByTab.get(id);
    tokenByTab.delete(id);
    if (token) receipts.delete(token);
  };
  const addOwned = async (session, id) => {
    if (!owned.has(session)) owned.set(session, new Set());
    owned.get(session).add(id);
  };
  const browser = {
    tabs: {
      query: async (query = {}) => tabs
        .filter((tab) => query.windowId === undefined || tab.windowId === query.windowId)
        .map(withIndex),
      get: async (id) => {
        const tab = live(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return withIndex(tab);
      },
      remove: async (id) => {
        tabs.splice(tabs.indexOf(live(id)), 1);
        for (const set of owned.values()) set.delete(id);
        revoke(id);
      },
      update: async (id, props) => withIndex(Object.assign(live(id), props)),
    },
  };
  const ext = new Function(
    "browser", "_receiptByToken", "_tokenByTabId", "_digestTabUrl", "_persistOwnedTabs",
    "_withReceiptMutationLock", "_ensureBrowserSessionEpoch", "_isTabOwnedByAnySession",
    "_isTabOwnedBySession", "_addOwnedTab", "_removeOwnedTab", "_hydrateOwnedTabs",
    "_adoptWindowForSession", "_windowForSession", "_windowQuery", "getTargetTab",
    "_getReceiptTargetTab", "_DEFAULT_SESSION",
    `${extensionParts}
    return {
      _issueTabReceipt,
      async handleCommand(type, payload, pageCommand) {
        const sessionId = payload.sessionId || _DEFAULT_SESSION;
      ${preflight}
        switch (type) {
      ${closeCase}
          default: return pageCommand(type, payload, sessionId);
        }
      },
    };`
  )(
    browser, receipts, tokenByTab, async (url) => digest(url), async () => {},
    (operation) => operation(), async () => EPOCH, anyOwner,
    (session, id) => !!owned.get(session)?.has(id), addOwned,
    async (session, id) => {
      owned.get(session)?.delete(id);
      if (!anyOwner(id)) revoke(id);
    },
    async () => {}, () => {}, () => WINDOW, (windowId) => ({ windowId }),
    // getTargetTab without a receipt: the session's cached tab, else its newest live one, else the tab in front.
    async (_receipt, session) => live(cached.get(session))
      || [...(owned.get(session) || [])].reverse().map(live).find(Boolean)
      || tabs.find((tab) => tab.active),
    async () => assert.fail("no get_tab_receipt in this test"), "_default"
  );

  // new_tab, as _newTabForSession does it: a background tab the session owns, then its receipt.
  async function pageCommand(type, payload, sessionId) {
    if (type !== "new_tab") throw new Error(`the fake extension does not model "${type}"`);
    const tab = { id: nextId++, windowId: WINDOW, url: payload.url || "about:blank", title: "", active: false };
    tabs.push(tab);
    cached.set(sessionId, tab.id);
    await addOwned(sessionId, tab.id);
    const receipt = await ext._issueTabReceipt(tab);
    return { title: "", safeUrl: tab.url, receipt, tabIndex: tabs.indexOf(tab) + 1 };
  }

  return {
    urls: () => tabs.map((tab) => tab.url),
    types: () => sent.map((command) => command.type),
    lastSent: () => sent.at(-1),
    // The bridge. A payload is copied, as the wire would: handleCommand writes into it.
    async send(type, payload) {
      sent.push({ type, receipt: payload.receipt });
      return ext.handleCommand(type, { ...payload }, pageCommand);
    },
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

function toolHandler(name) {
  const at = index.indexOf(`server.tool(\n  "${name}",`);
  assert.ok(at >= 0, `no ${name} tool`);
  const from = index.indexOf("async (", at);
  return index.slice(from, index.indexOf("\n);\n", from));
}

const TOOLS = ["safari_new_tab", "safari_close_tab", "safari_run_script"];
const MODES = [
  { name: "without SAFARI_PROFILE", profile: "" },
  { name: "in a named profile", profile: "Work" },
];

// safari.js's per-session tab state. Every call that would reach AppleScript fails the test:
// with the extension connected, none of these closes may go there.
function fakeSafari() {
  const st = { url: null, index: null };
  const appleScript = (name) => async () => assert.fail(`AppleScript ${name} ran`);
  return {
    getActiveTabURL: () => st.url,
    setActiveTabURL: (url) => { st.url = url; },
    setActiveTabIndex: (i) => { st.index = i; },
    setActiveTabFromExtension: (_reported, url) => Object.assign(st, { index: null, url: url || null }),
    getActiveTabMarker: () => null,
    isActiveTabAdopted: () => false,
    saveFrontmostApp: async () => null,
    setFocusGuard() {},
    restoreFocusIfStolen: async () => {},
    newTab: appleScript("newTab"),
    closeTab: appleScript("closeTab"),
    closeOwnTab: appleScript("closeOwnTab"),
  };
}

function setup(mode) {
  const extension = makeExtension();
  const deps = {
    safari: fakeSafari(), SESSION_ID: "daemon", currentSessionId: () => "agent",
    process: { env: mode.profile ? { SAFARI_PROFILE: mode.profile } : {} },
    console: { error() {} }, textResult, errorResult,
    sendToExtension: (type, payload) => extension.send(type, payload),
    _evictOldestTab: async () => null, _evictionReport: () => ({}),
    _trackTab: own._trackTab, _untrackTab: own._untrackTab, _openedTabs: own._openedTabs,
    _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL, _markBlankTabOpened: own._markBlankTabOpened,
    _isURLOwned: own._isURLOwned, _sessionTabs: own._sessionTabs, BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    // A named profile is extension-only; without one, AppleScript is the fallback.
    _preferAppleScript: !!mode.profile, _extensionConnected: true, _profileExtensionVerified: true,
    _isExtensionHost: false, _commandTimeouts: {}, _nullMeansFailure: new Set(),
  };
  const server = new Function(
    ...Object.keys(deps),
    `${indexParts}
    return { ${TOOLS.map((name) => `${name}: ${toolHandler(name)}`).join(",\n")} };`
  )(...Object.values(deps));
  return { server, extension };
}

const text = (result) => result.content[0].text;
const json = (result) => JSON.parse(text(result));
// The tabs index.js counts as the session's, which the tab cap and the next close go by.
const tracked = () => [...own._openedTabs.values()].map((info) => info.url);

// What a caller passes that names a tab but is not a receipt.
const notReceipts = (receipt) => [
  { receipt: "<old receipt>" }, // the origin refusal's getReceipt advice, pasted as it is
  { receipt: receipt.slice(0, 12) }, // cut short
  { receipt: ` ${receipt}` },
  { receipt: `${receipt}\n` },
  { receipt: `"${receipt}"` },
  { url: DOCS }, // a page URL in the deprecated `url` parameter, which takes a legacy receipt URL
  { receipt: "", url: DOCS },
];

// The session opens DOCS, then SHOP, which is its current tab from then on.
async function twoTabs(server) {
  const docs = json(await server.safari_new_tab({ url: DOCS }));
  const shop = json(await server.safari_new_tab({ url: SHOP }));
  assert.match(docs.receipt ?? "", /^[A-Za-z0-9_-]{24,}$/, `no receipt: ${JSON.stringify(docs)}`);
  return { docs, shop };
}

for (const mode of MODES) {
  test(`${mode.name}: safari_close_tab refuses a receipt it cannot parse, and closes no tab`, async () => {
    const { server, extension } = setup(mode);
    const { docs, shop } = await twoTabs(server);

    for (const args of notReceipts(docs.receipt)) {
      const result = await server.safari_close_tab(args);
      assert.equal(result.isError, true, `${JSON.stringify(args)} closed a tab: ${text(result)}`);
      assert.match(text(result), /^Tab safety: invalid tab receipt/);
    }
    assert.deepEqual(extension.urls(), [USER_URL, DOCS, SHOP], "a tab was closed");
    assert.deepEqual(extension.types(), ["new_tab", "new_tab"], "a close reached the extension");
    assert.deepEqual(tracked(), [DOCS, SHOP], "a refused close forgot a tab");

    // The session is still on its current tab: a close that names none closes that one, by its receipt.
    assert.equal(text(await server.safari_close_tab({})), "Tab closed");
    assert.deepEqual(extension.lastSent(), { type: "close_tab", receipt: shop.receipt });
    assert.deepEqual(extension.urls(), [USER_URL, DOCS]);
    assert.deepEqual(tracked(), [DOCS]);
  });

  test(`${mode.name}: safari_close_tab closes the tab a receipt names, and the current tab when it names none`, async () => {
    const { server, extension } = setup(mode);
    const { docs, shop } = await twoTabs(server);
    const blog = json(await server.safari_new_tab({ url: BLOG })); // the current tab now

    assert.equal(text(await server.safari_close_tab({ receipt: docs.receipt })), "Tab closed");
    assert.deepEqual(extension.urls(), [USER_URL, SHOP, BLOG], "the receipt's tab closed, and only it");
    assert.deepEqual(tracked(), [SHOP, BLOG]);
    // The deprecated legacy receipt URL still names its tab.
    assert.equal(text(await server.safari_close_tab({ url: `${SHOP}#mcp-tab=${shop.receipt}` })), "Tab closed");
    assert.deepEqual(extension.urls(), [USER_URL, BLOG]);
    assert.deepEqual(tracked(), [BLOG]);
    // An empty receipt names no tab, as no receipt does: the current tab closes.
    assert.equal(text(await server.safari_close_tab({ receipt: "" })), "Tab closed");
    assert.deepEqual(extension.lastSent(), { type: "close_tab", receipt: blog.receipt });
    assert.deepEqual(extension.urls(), [USER_URL]);
    assert.deepEqual(tracked(), []);
  });
}

test("in a named profile, a run_script closeTab step whose receipt is not one is refused, and the batch stops there", async () => {
  const { server, extension } = setup(MODES[1]);
  const { docs, shop } = await twoTabs(server);

  // The step's args are free-form, so a receipt can also arrive as receiptUrl, or not as a string.
  for (const args of [...notReceipts(docs.receipt), { receiptUrl: DOCS }, { receipt: 12345 }, { index: 2, receipt: "<old receipt>" }]) {
    const steps = [{ action: "closeTab", args }, { action: "closeTab" }];
    const results = json(await server.safari_run_script({ steps }));
    assert.equal(results.length, 1, `the step after a refused close ran: ${JSON.stringify(results)}`);
    assert.match(results[0].error, /^Tab safety: closeTab requires an extension-issued receipt/, JSON.stringify(args));
  }
  assert.deepEqual(extension.urls(), [USER_URL, DOCS, SHOP], "a tab was closed");
  assert.deepEqual(extension.types(), ["new_tab", "new_tab"], "a close reached the extension");
  assert.deepEqual(tracked(), [DOCS, SHOP], "a refused close forgot a tab");

  // The session is still on its current tab.
  const results = json(await server.safari_run_script({ steps: [{ action: "closeTab" }] }));
  assert.deepEqual(results, [{ action: "closeTab", result: "Tab closed" }]);
  assert.deepEqual(extension.lastSent(), { type: "close_tab", receipt: shop.receipt });
  assert.deepEqual(extension.urls(), [USER_URL, DOCS]);
  assert.deepEqual(tracked(), [DOCS]);
});

test("in a named profile, a run_script closeTab step closes the tab its receipt names, and the current tab when it names none", async () => {
  const { server, extension } = setup(MODES[1]);
  const { docs } = await twoTabs(server);

  const steps = [{ action: "closeTab", args: { receipt: docs.receipt } }, { action: "closeTab" }];
  const results = json(await server.safari_run_script({ steps }));
  assert.deepEqual(results, [
    { action: "closeTab", result: "Tab closed" },
    { action: "closeTab", result: "Tab closed" },
  ]);
  assert.deepEqual(extension.urls(), [USER_URL], "DOCS by its receipt, then the current tab, SHOP");
  assert.deepEqual(tracked(), []);
});
