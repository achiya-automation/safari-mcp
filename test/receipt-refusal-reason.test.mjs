#!/usr/bin/env node
/**
 * A refused receipt has to say which check refused it.
 *
 * `_resolveReceiptTab` has five separate ways to refuse: the extension holds no record of
 * the token, the record is from an earlier browser session, its tab is closed, the tab
 * shows a different page that nobody owns, or the tab has left the receipt's origin. All
 * five came back as one sentence — "receipt is forged, stale, ambiguous, or not valid for
 * this origin". The server matches "not valid for this origin" and appends "Likely cause:
 * the tab moved to another origin … Rotate it with getReceipt" to every one of them.
 *
 * Observed 15.9.26: a receipt minted at 09:34:38 was refused after a daemon restart at
 * 09:35:27. The tab was still open on the same page, so the advice pointed the wrong way,
 * and getReceipt was refused with the same sentence. "ambiguous" sent the investigation
 * to a second tab open at the same URL, but that cannot make a receipt ambiguous: since
 * 62644b9 a receipt resolves by its tab id and no URL is compared across tabs.
 * Two identical-URL tabs are resolved below to show it.
 *
 * Run:  node --test test/receipt-refusal-reason.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

const EPOCH = "e".repeat(36);
const TOKEN = "Receipt_ABCDEF1234567890abcdef";
const OTHER_TOKEN = "Receipt_ZYXWVU0987654321fedcba";
const URL_A = "https://example.com/?receipt-restart=1";
const digest = (url) => createHash("sha256").update(url).digest("hex");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const resolveSource = between(background, "async function _resolveReceiptTab(", "\nfunction _addOwnedTab(");
const validSource = between(background, "function _isValidReceiptRecord(", "\n// Rebuild the per-session window map");
const originSource = between(background, "function _receiptOrigin(", "\nfunction _receiptTokenFromPayload(");

function record(overrides = {}) {
  return {
    token: TOKEN,
    tabId: 42,
    windowId: 7,
    browserEpoch: EPOCH,
    receiptOrigin: "https://example.com",
    identityDigest: digest(URL_A),
    issuedAt: Date.now(),
    ...overrides,
  };
}

/** The real resolver and record validator over fake tabs. */
function resolver({ records = [record()], tabs = [], owned = [] } = {}) {
  const receiptByToken = new Map(records.map((r) => [r.token, r]));
  const tokenByTabId = new Map(records.map((r) => [r.tabId, r.token]));
  const ownedIds = new Set(owned);
  return Function(
    "_receiptByToken", "_tokenByTabId", "browser", "_digestTabUrl", "_isTabOwnedByAnySession",
    "_persistOwnedTabs", "_withReceiptMutationLock", "_ensureBrowserSessionEpoch",
    `${validSource}\n${originSource}\n${resolveSource}\nreturn _resolveReceiptTab;`
  )(
    receiptByToken,
    tokenByTabId,
    { tabs: { query: async () => tabs } },
    async (url) => digest(url),
    (tabId) => ownedIds.has(tabId),
    async () => {},
    (operation) => operation(),
    async () => EPOCH
  );
}

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error.message;
  }
  assert.fail("the receipt was expected to be refused");
}

const liveTab = { id: 42, windowId: 7, url: URL_A };

const cases = {
  unknown: () => resolver({ records: [], tabs: [liveTab] })(TOKEN),
  earlierSession: () => resolver({ records: [record({ browserEpoch: "f".repeat(36) })], tabs: [liveTab] })(TOKEN),
  tabClosed: () => resolver({ tabs: [{ ...liveTab, id: 43 }] })(TOKEN),
  differentPage: () => resolver({ tabs: [{ ...liveTab, url: "https://example.com/elsewhere" }] })(TOKEN),
  otherOrigin: () => resolver({ tabs: [{ ...liveTab, url: "https://other.example/" }], owned: [42] })(TOKEN),
};

test("each refusal names the check that failed", async () => {
  assert.match(await refusal(cases.unknown()), /no record of that receipt/);
  assert.match(await refusal(cases.earlierSession()), /earlier browser session/);
  assert.match(await refusal(cases.tabClosed()), /tab is closed/);
  assert.match(await refusal(cases.differentPage()), /different page/);
  assert.match(await refusal(cases.otherOrigin()), /not valid for this origin/);
});

test("the server's getReceipt advice lands only on the origin refusal", async () => {
  const hint = index.indexOf("Likely cause: the tab moved to another origin");
  assert.ok(hint > 0, "the origin advice should still exist in index.js");
  const guard = index.slice(index.lastIndexOf("if (/", hint), hint).match(/if \(\/(.+?)\/\.test\(err\.message\)\)/);
  assert.ok(guard, "the advice should be guarded by a message test");
  const decorates = new RegExp(guard[1]);

  for (const [name, run] of Object.entries(cases)) {
    const message = await refusal(run());
    assert.match(message, /^Tab safety: /, `${name}: the server must keep treating it as a safety refusal`);
    assert.equal(
      decorates.test(message),
      name === "otherOrigin",
      `${name}: "${message}" ${name === "otherOrigin" ? "should" : "must not"} get the origin-change advice`
    );
    assert.doesNotMatch(message, /ambiguous/, `${name}: no refusal path compares URLs, so none is ambiguous`);
    assert.ok(!message.includes(TOKEN), `${name}: a refusal must not echo the bearer receipt`);
  }
});

test("two tabs at the same URL each resolve to their own receipt", async () => {
  const twin = { id: 43, windowId: 7, url: URL_A };
  const resolve = resolver({
    records: [record(), record({ token: OTHER_TOKEN, tabId: 43 })],
    tabs: [liveTab, twin],
  });
  assert.equal((await resolve(TOKEN)).id, 42);
  assert.equal((await resolve(OTHER_TOKEN)).id, 43);
});

test("getReceipt may still follow its tab across an origin change", async () => {
  const resolve = resolver({ tabs: [{ ...liveTab, url: "https://other.example/" }], owned: [42] });
  assert.equal((await resolve(TOKEN, { allowOriginChange: true })).id, 42);
});

test("the command path no longer replaces the named refusal with one combined sentence", () => {
  assert.ok(!background.includes("forged, stale, ambiguous"), "the combined refusal sentence is gone");
  const preflight = between(background, "async function handleCommand(", "// ========== TAB OWNERSHIP GUARD");
  assert.ok(
    preflight.indexOf("await _resolveReceiptTab(suppliedReceipt") < preflight.indexOf("receiptResolved = true"),
    "a receipt is trusted only after the resolver returned its tab"
  );
});
