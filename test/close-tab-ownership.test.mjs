#!/usr/bin/env node
/**
 * `safari_close_tab` must never fall back to the tab the user is looking at. Regression
 * test for #68.
 *
 * The read paths deliberately allow an unmarked front document — "read the page I'm on"
 * has to keep working for a session that never opened a tab, and a wrong read costs
 * information. A wrong *close* costs the user their work, so the destructive path gets no
 * such fallback: it closes a tab this session can prove it owns, or it throws.
 *
 * The same fail-open existed in all three layers, with one shape — "no ownership recorded"
 * read as permission rather than as refusal:
 *   1. safari.js closeTab()  — `close current tab of window` when the index was unknown
 *   2. index.js              — "close_tab" sat in _noOwnershipCheck as tab management
 *   3. extension/background  — the "no tabs owned yet → allow" backward-compat branch
 * A re-initialised session (transport drop) reports exactly that state while its own tab
 * is still open, so all three agreed to close the user's tab.
 *
 * Source-level on purpose, like tab-identity-guard: the defect is a missing refusal on a
 * path that only runs after state is already lost, which no behavioural test over the
 * healthy paths can reach.
 *
 * Run:  node --test test/close-tab-ownership.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const safari = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const BROWSER_EPOCH = "e".repeat(36);

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `could not extract ${startNeedle}`);
  return source.slice(start, end).trim();
}

const resolveReceiptSource = sourceBetween(
  background,
  "async function _resolveReceiptTab(",
  "\nfunction _addOwnedTab("
);

function makeReceiptResolver({ records = new Map(), tabs = [] } = {}) {
  const tokenByTabId = new Map();
  const ownedTabIds = new Set();
  const resolveReceipt = new Function(
    "_receiptByToken",
    "_isValidReceiptRecord",
    "browser",
    "_digestTabUrl",
    "_tokenByTabId",
    "_isTabOwnedByAnySession",
    "_persistOwnedTabs",
    "_receiptOrigin",
    "_withReceiptMutationLock",
    "_ensureBrowserSessionEpoch",
    `"use strict"; return (${resolveReceiptSource});`
  )(
    records,
    (token, record) => !!record && record.token === token,
    { tabs: { query: async () => tabs } },
    async (url) => `digest:${url}`,
    tokenByTabId,
    (tabId) => ownedTabIds.has(tabId),
    async () => {},
    (url) => {
      try { return new URL(url).origin; } catch { return ""; }
    },
    (operation) => operation(),
    async () => BROWSER_EPOCH
  );
  return { resolveReceipt, tokenByTabId, ownedTabIds };
}

/** Comments discuss the fallback by name; only code may be asserted against. */
const stripComments = (s) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const closeTabBody = (() => {
  const start = safari.indexOf("export async function closeTab(");
  assert.ok(start > 0, "closeTab should exist in safari.js");
  const end = safari.indexOf("\nexport async function", start + 1);
  return safari.slice(start, end === -1 ? undefined : end);
})();

test("no AppleScript in closeTab targets the front document", () => {
  // The refusal message names the fallback in prose, so match the commands, not the text.
  const commands = stripComments(closeTabBody)
    .split("\n")
    .filter((l) => l.includes('tell application "Safari"'));
  assert.ok(commands.length >= 3, `expected the count + close + blank commands, got ${commands.length}`);
  for (const line of commands) {
    assert.ok(
      !/current tab of/.test(line),
      "closeTab must not fall back to `current tab of window` — that is the user's active " +
        `tab whenever this session's index is unknown (#68):\n  ${line.trim()}`
    );
  }
});

test("closeTab refuses when it cannot prove which tab is its own", () => {
  assert.match(
    closeTabBody,
    /const idx = explicitIndex \|\| \(await _provenOwnTabIndex\(\)\)/,
    "the target must come from an explicit index or from proven ownership"
  );
  assert.match(
    closeTabBody,
    /if \(!idx\)[\s\S]{0,200}throw new Error/,
    "an unprovable target must throw, not fall through to a close"
  );
});

test("both destructive AppleScript verbs are pinned to the proven index", () => {
  const verbs = closeTabBody
    .split("\n")
    .filter((l) => /close tab|set URL of/.test(l) && l.includes("Safari"));
  assert.equal(verbs.length, 2, `expected the close and the blank-instead-of-close, got ${verbs.length}`);
  for (const line of verbs) {
    assert.ok(
      line.includes("tab ${idx} of"),
      `a destructive verb targets something other than the proven index:\n  ${line}`
    );
  }
});

test("the proven-ownership helper fails closed to null", () => {
  const start = safari.indexOf("async function _provenOwnTabIndex(");
  assert.ok(start > 0, "_provenOwnTabIndex should own this decision in one place");
  const body = safari.slice(start, safari.indexOf("\n}", start));
  assert.match(
    body,
    /resolveActiveTab\(\)/,
    "ownership is proven by re-resolving the identity marker, not by trusting a stale index"
  );
  assert.match(body, /\|\| null/, "an unresolved tab must read as null, never as an index");
});

test("close_tab is not exempt from the shared tab-ownership assertion", () => {
  const start = index.indexOf("const _noOwnershipCheck = new Set([");
  const exempt = stripComments(index.slice(start, index.indexOf("]);", start)));
  assert.ok(
    !/"close_tab"/.test(exempt),
    "close_tab destroys a user tab — it does not belong in a set of read-only and " +
      "tab-management ops (#68)"
  );
  // The other three tab-management entries stay exempt: new_tab creates, list_tabs reads,
  // and switch_tab carries its own ownership check at the tool.
  for (const safe of ["new_tab", "list_tabs", "switch_tab"]) {
    assert.ok(exempt.includes(`"${safe}"`), `${safe} should remain exempt`);
  }
});

test("public close accepts an opaque receipt and never treats a full URL as authority", () => {
  const start = index.indexOf('server.tool(\n  "safari_close_tab"');
  const end = index.indexOf('\n);', start);
  assert.ok(start > 0 && end > start, "safari_close_tab tool should exist");
  const tool = index.slice(start, end + 3);
  assert.match(tool, /receipt: z\.string\(\)\.optional\(\)/);
  assert.match(tool, /const supplied = receipt \|\| url \|\| ""/);
  assert.match(tool, /const token = _receiptToken\(supplied\) \|\| _getActiveReceipt\(\)/);
  assert.match(tool, /if \(supplied && !token\) return errorResult\("Tab safety: invalid tab receipt"\)/);
  assert.match(tool, /"close_tab",\s*token \? \{ receipt: token \} : \{\}/);
  assert.match(tool, /_setActiveReceipt\(""\)/, "a closed tab's receipt must be forgotten");
  assert.doesNotMatch(tool, /_isExactURLOwned|tabUrl|serverOwnedReceipt/);

  const routingStart = index.indexOf("async function extensionOrFallback(");
  const routingEnd = index.indexOf("// Read version from package.json", routingStart);
  const routing = index.slice(routingStart, routingEnd);
  assert.ok(
    routing.indexOf("...extensionPayload") < routing.indexOf("sessionId: `${SESSION_ID}:${currentSessionId()}`"),
    "an explicit receipt may select its exact tab, but never override the server-owned session id"
  );
});

test("extension resolves the opaque receipt to one concrete tab before close", () => {
  const start = background.indexOf("async function handleCommand(");
  const end = background.indexOf("// ========== TAB OWNERSHIP GUARD", start);
  assert.ok(start > 0 && end > start, "handleCommand receipt preflight should exist");
  const preflight = background.slice(start, end);
  const resolveAt = preflight.indexOf("await _resolveReceiptTab(suppliedReceipt");
  const rejectAt = preflight.indexOf("if (!targetTab)");
  const bindAt = preflight.indexOf("payload._receiptTabId = targetTab.id");
  assert.ok(resolveAt > 0, "receipt must be resolved by the extension's durable registry");
  assert.ok(resolveAt < rejectAt && rejectAt < bindAt, "resolution must succeed before its tab id is trusted");

  const closeCase = background.slice(
    background.indexOf('case "close_tab"'),
    background.indexOf('case "switch_tab"')
  );
  assert.match(closeCase, /_closeTabForSession\(sessionId, targetTab, payload\)/);

  const handler = background.slice(
    background.indexOf("async function _closeTabForSession("),
    background.indexOf("async function _switchTabForSession(")
  );
  assert.match(handler, /payload\._receiptTabId && target\.id !== payload\._receiptTabId/);
  assert.match(handler, /browser\.tabs\.remove\(targetTab\.id\)/);
  assert.doesNotMatch(handler, /targetTab\.url\s*===|searchParams|getAttribute\(['"]href/);
});

test("forged, stale, and cross-origin receipts fail closed", async () => {
  const token = "opaque_receipt_token_1234567890";
  const originalUrl = "https://owned.example/app?private=one#route";

  const forged = makeReceiptResolver({
    tabs: [{ id: 42, windowId: 3, url: originalUrl }],
  });
  assert.equal(await forged.resolveReceipt(token), null, "an unissued bearer token must prove nothing");

  const stale = makeReceiptResolver({
    records: new Map([[token, {
      token,
      tabId: 42,
      windowId: 3,
      browserEpoch: BROWSER_EPOCH,
      receiptOrigin: "https://owned.example",
      identityDigest: `digest:${originalUrl}`,
    }]]),
    tabs: [{ id: 42, windowId: 3, url: "https://owned.example/different?private=two#other" }],
  });
  assert.equal(await stale.resolveReceipt(token), null, "a receipt whose tab identity no longer matches must fail closed");

  const crossOriginUrl = "https://other.example/app?private=three#route";
  const crossOrigin = makeReceiptResolver({
    records: new Map([[token, {
      token,
      tabId: 42,
      windowId: 3,
      browserEpoch: BROWSER_EPOCH,
      receiptOrigin: "https://owned.example",
      identityDigest: `digest:${crossOriginUrl}`,
    }]]),
    tabs: [{ id: 42, windowId: 3, url: crossOriginUrl }],
  });
  assert.equal(await crossOrigin.resolveReceipt(token), null, "a receipt must not authorize a different origin");

  const preflight = background.slice(
    background.indexOf("async function handleCommand("),
    background.indexOf("// ========== TAB OWNERSHIP GUARD")
  );
  assert.match(
    preflight,
    /if \(!targetTab\)\s*\{\s*throw new Error\("Tab safety: receipt is forged, stale, ambiguous, or not valid for this origin"\)/,
    "the command path must turn a failed lookup into a refusal"
  );
  assert.doesNotMatch(preflight, /\$\{suppliedReceipt\}/, "the refusal must not echo the bearer receipt");
});

test("receipt close removes only the resolved tab and returns no URL", async () => {
  const safeUrlSource = sourceBetween(background, "function _safeTabUrl(", "\nfunction _receiptOrigin(");
  const safeTabUrl = new Function(`"use strict"; return (${safeUrlSource});`)();
  const closeSource = sourceBetween(
    background,
    "async function _closeTabForSession(",
    "\nasync function _switchTabForSession("
  );
  const removed = [];
  const ownershipEvents = [];
  const owned = new Set();
  const tabs = [
    { id: 42, index: 0, windowId: 3, url: "https://owned.example/app?private=one#route" },
    { id: 99, index: 1, windowId: 3, url: "https://user.example/work?draft=secret#cursor" },
  ];
  const close = new Function(
    "_windowForSession",
    "browser",
    "_windowQuery",
    "_isTabOwnedBySession",
    "_addOwnedTab",
    "_removeOwnedTab",
    "_safeTabUrl",
    `"use strict"; return (${closeSource});`
  )(
    () => 3,
    {
      tabs: {
        query: async () => tabs,
        remove: async (id) => { removed.push(id); },
        update: async () => { throw new Error("unexpected last-tab blank"); },
      },
    },
    (windowId) => ({ windowId }),
    (_sessionId, id) => owned.has(id),
    async (_sessionId, id) => { ownershipEvents.push(`adopt:${id}`); owned.add(id); },
    async (_sessionId, id) => { ownershipEvents.push(`release:${id}`); owned.delete(id); },
    safeTabUrl
  );

  const result = await close("fresh-session", tabs[0], { _receiptTabId: 42 });
  assert.equal(result, "Tab closed");
  assert.deepEqual(removed, [42], "the exact receipt-resolved tab, never the neighbouring user tab, is removed");
  assert.deepEqual(ownershipEvents, ["adopt:42", "release:42"]);
  assert.doesNotMatch(result, /[?#]|private=|draft=/, "close output must not expose URL query or fragment data");
});

test("close refusal redacts query and fragment data from its error", async () => {
  const safeUrlSource = sourceBetween(background, "function _safeTabUrl(", "\nfunction _receiptOrigin(");
  const safeTabUrl = new Function(`"use strict"; return (${safeUrlSource});`)();
  const closeSource = sourceBetween(
    background,
    "async function _closeTabForSession(",
    "\nasync function _switchTabForSession("
  );
  const sensitiveUrl = "https://user.example/work/item?draft=secret#cursor";
  const tabs = [
    { id: 42, index: 0, windowId: 3, url: "https://owned.example/app" },
    { id: 99, index: 1, windowId: 3, url: sensitiveUrl },
  ];
  const close = new Function(
    "_windowForSession",
    "browser",
    "_windowQuery",
    "_isTabOwnedBySession",
    "_addOwnedTab",
    "_removeOwnedTab",
    "_safeTabUrl",
    `"use strict"; return (${closeSource});`
  )(
    () => 3,
    {
      tabs: {
        query: async () => tabs,
        remove: async () => { throw new Error("must not remove an unowned tab"); },
        update: async () => { throw new Error("must not blank an unowned tab"); },
      },
    },
    (windowId) => ({ windowId }),
    () => false,
    async () => {},
    async () => {},
    safeTabUrl
  );

  await assert.rejects(
    () => close("fresh-session", tabs[0], { index: 2 }),
    (error) => {
      assert.match(error.message, /https:\/\/user\.example\/work\/item/);
      assert.doesNotMatch(error.message, /[?#]|draft=|secret|cursor/);
      return true;
    }
  );
});

test("internal cleanup names its tab instead of mutating shared active-tab state", () => {
  assert.ok(
    !/setActiveTabIndex\([^)]*\);\s*\n\s*await safari\.closeTab\(\)/.test(index),
    "cleanup should pass the index to closeTab directly, so the refusal above stays " +
      "meaningful for every other caller"
  );
});

test("the extension denies every mutation to a session that owns nothing", () => {
  const guard = background.slice(
    background.indexOf("TAB OWNERSHIP GUARD"),
    background.indexOf("switch (type)")
  );
  assert.match(
    guard,
    /if \(receiptResolved\)[\s\S]*else \{[\s\S]{0,350}throw new Error/,
    "a session without ownership or a valid receipt must fail closed for every write"
  );
  assert.doesNotMatch(guard, /No tabs owned yet|_destructiveTabCommands/);
});

test("the extension checks the tab it actually closes when given an index", () => {
  const handler = background.slice(
    background.indexOf("async function _closeTabForSession("),
    background.indexOf("async function _switchTabForSession(")
  );
  const removeAt = handler.indexOf("browser.tabs.remove(target.id)");
  const checkAt = handler.indexOf("_isTabOwnedBySession(sessionId, target.id)");
  assert.ok(checkAt > 0, "the index-resolved target needs its own ownership check");
  assert.ok(checkAt < removeAt, "the check must run before the removal");
});
