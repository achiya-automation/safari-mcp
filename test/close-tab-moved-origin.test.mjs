#!/usr/bin/env node
/**
 * A receipt closes its tab after the page moved the tab to another origin.
 *
 * Found on 6.10.26 (geo-audit): a tab opened on claude.ai/new left that origin within four
 * seconds. safari_close_tab with its receipt was refused ("receipt is not valid for this
 * origin"), and the getReceipt rotation the refusal suggests was refused too ("Cannot issue a
 * receipt for this tab URL"): getReceipt mints only for an http(s) origin or about:blank. The tab
 * stayed open with nothing able to close it. handleCommand let only get_tab_receipt follow a
 * receipt across origins; close_tab, which runs nothing in the page either, now does as well.
 *
 * The extension's code is the real one: handleCommand's preflight, _resolveReceiptTab,
 * _issueTabReceipt, _closeTabForSession and the ownership helpers, over a fake Safari window.
 *
 * Run:  node --test test/close-tab-moved-origin.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const EPOCH = "e".repeat(36);
const WINDOW = 7;
const USER_URL = "https://mail.example/inbox";
const digest = (url) => createHash("sha256").update(String(url || "")).digest("hex");

const extensionParts = [
  between(background, "function _safeTabUrl(", "\nasync function _listTabsForSession("),
  between(background, "async function _closeTabForSession(", "\nasync function _switchTabForSession("),
  between(background, "function _isValidReceiptRecord(", "\n// Rebuild the per-session window map"),
  between(background, "async function _issueTabReceipt(", "\nasync function _refreshTabReceiptIdentity("),
  // _resolveReceiptTab, _addOwnedTab, _removeOwnedTab and the ownership predicates.
  between(background, "async function _resolveReceiptTab(", "\n// The browser-run epoch lives"),
  between(background, "const _readOnlyCommands = new Set([", "\n]);") + "\n]);",
].join("\n");
const preflight = between(background, "  // Receipt-based targeting depends on durable ownership state", "\n  switch (type) {");

function makeExtension() {
  const tabs = [{ id: 1, windowId: WINDOW, url: USER_URL, active: true }];
  const receipts = new Map();
  const tokenByTab = new Map();
  const owned = new Map();
  const ran = [];
  let nextId = 100;
  const live = (id) => tabs.find((tab) => tab.id === id);
  const withIndex = (tab) => ({ ...tab, index: tabs.indexOf(tab) });
  const browser = {
    tabs: {
      query: async (q = {}) => tabs.filter((tab) => !q.windowId || tab.windowId === q.windowId).map(withIndex),
      get: async (id) => {
        const tab = live(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return withIndex(tab);
      },
      remove: async (id) => { tabs.splice(tabs.indexOf(live(id)), 1); },
      update: async (id, { url }) => { live(id).url = url; },
    },
  };
  const ext = new Function(
    "browser", "_receiptByToken", "_tokenByTabId", "_sessionOwnedTabs", "_digestTabUrl",
    "_persistOwnedTabs", "_withReceiptMutationLock", "_ensureBrowserSessionEpoch", "_mintMcpTabMarker",
    "_setSessionTab", "_adoptWindowForSession", "_windowForSession", "_windowQuery", "getTargetTab",
    "_getReceiptTargetTab", "_hydrateOwnedTabs", "_extractMcpTabMarker", "_DEFAULT_SESSION",
    `${extensionParts}
    return {
      _issueTabReceipt, _addOwnedTab,
      async handleCommand(type, payload, ran) {
        const sessionId = payload.sessionId || _DEFAULT_SESSION;
      ${preflight}
        if (type === "close_tab") return _closeTabForSession(sessionId, targetTab, payload);
        ran.push({ type, tabId });
        return "ran";
      },
    };`
  )(
    browser, receipts, tokenByTab, owned, async (url) => digest(url),
    async () => {}, (operation) => operation(), async () => EPOCH, () => randomBytes(18).toString("hex"),
    () => {}, () => {}, () => WINDOW, (windowId) => (windowId ? { windowId } : {}),
    async () => tabs.find((tab) => tab.active), async () => null, async () => {}, () => "", "_default"
  );
  return {
    tabs, ran, live,
    async open(sessionId, url) {
      const tab = { id: nextId++, windowId: WINDOW, url, active: false };
      tabs.push(tab);
      await ext._addOwnedTab(sessionId, tab.id);
      return { id: tab.id, receipt: await ext._issueTabReceipt(tab) };
    },
    send: (type, payload) => ext.handleCommand(type, { ...payload }, ran),
  };
}

for (const [where, movedTo] of [
  ["another https origin", "https://login.example/sso"],
  ["a URL with no http(s) origin", "claude://claude.ai/new"],
  ["a URL Safari does not show the extension", undefined],
]) {
  test(`close_tab closes its receipt's tab after the page moved it to ${where}`, async () => {
    const ext = makeExtension();
    const { id, receipt } = await ext.open("geo", "https://claude.ai/new");
    ext.live(id).url = movedTo;

    // The tab still takes no page command on its new origin.
    await assert.rejects(ext.send("click", { receipt, sessionId: "geo" }), /not valid for this origin/);
    assert.deepEqual(ext.ran, []);

    assert.equal(await ext.send("close_tab", { receipt, sessionId: "geo" }), "Tab closed");
    assert.equal(ext.live(id), undefined, "the moved tab is closed");
    assert.ok(ext.live(1), "the user's tab stays open");
    // The receipt ended with its tab.
    await assert.rejects(ext.send("close_tab", { receipt, sessionId: "geo" }), /no record of that receipt/);
  });
}

test("the same close works from another session that holds the receipt (a subagent, a reconnect)", async () => {
  const ext = makeExtension();
  const { id, receipt } = await ext.open("geo", "https://claude.ai/new");
  ext.live(id).url = "https://login.example/sso";
  assert.equal(await ext.send("close_tab", { receipt, sessionId: "daemon:subagent" }), "Tab closed");
  assert.equal(ext.live(id), undefined);
});

test("a receipt this extension never issued still closes nothing", async () => {
  const ext = makeExtension();
  const { id } = await ext.open("geo", "https://claude.ai/new");
  ext.live(id).url = "claude://claude.ai/new";
  await assert.rejects(
    ext.send("close_tab", { receipt: "f".repeat(36), sessionId: "geo" }),
    /no record of that receipt/
  );
  assert.equal(ext.tabs.length, 2, "both tabs stay open");
});
