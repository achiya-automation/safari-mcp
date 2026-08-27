#!/usr/bin/env node
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const safari = readFileSync(new URL("../safari.js", import.meta.url), "utf8");

function extract(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

test("new tabs pass the caller's raw URL unchanged and keep receipts out of page state", () => {
  const batch = extract(index, "async function _runExtensionBatchAction(", "\n// Try the profile-verified extension first");
  const newTab = extract(background, "async function _newTabForSession(", "\nasync function _closeTabForSession");

  assert.ok(batch.includes('"new_tab", { url: requestedUrl }'));
  assert.ok(batch.includes("safari.newTab(requestedUrl)"));
  assert.ok(!batch.includes("_withMcpTabReceipt"));

  assert.ok(newTab.includes('const rawNavigationUrl = String(payload.url || "")'));
  assert.ok(newTab.includes("browser.tabs.update(newTab.id, { url: rawNavigationUrl })"));
  assert.ok(newTab.includes("_issueTabReceipt(receiptTab"));
  assert.ok(
    newTab.indexOf("browser.tabs.update(newTab.id, { url: rawNavigationUrl })") <
      newTab.indexOf("_issueTabReceipt(receiptTab"),
    "the receipt must bind to the URL Safari accepted, not the bootstrap about:blank"
  );
  assert.ok(!newTab.includes("searchParams"));
  assert.ok(!newTab.includes("history.replaceState"));
  assert.ok(!newTab.includes("mcp-tab="));
});

test("run_script dispatches through the extension path and never safari.runScript for named profiles", () => {
  const block = extract(
    index,
    'server.tool(\n  "safari_run_script"',
    "\n// ========== CONSOLE =========="
  );
  assert.ok(block.includes("_runExtensionBatchAction"));
  const profileGuard = block.indexOf("if (!process.env.SAFARI_PROFILE)");
  const legacyCall = block.indexOf("safari.runScript(");
  const extensionLoop = block.indexOf("_runExtensionBatchAction", legacyCall + 1);
  assert.ok(profileGuard >= 0 && legacyCall > profileGuard, "legacy batch must be gated to non-profile mode");
  assert.ok(extensionLoop > legacyCall, "named profiles must reach the extension-only dispatcher");
  assert.ok(block.includes("break;"), "a failed mutating step must stop the batch");
});

test("batch tab actions carry an opaque receipt, never a synthetic receipt URL", () => {
  const helper = extract(index, "async function _runExtensionBatchAction(", "\n// Try the profile-verified extension first");
  const switchCase = extract(helper, 'case "switchTab":', '\n\n    case "listTabs"');
  const receiptCase = extract(helper, 'case "getReceipt":', '\n\n    case "closeTab"');

  assert.ok(helper.includes('"new_tab", { url: requestedUrl }'));
  assert.ok(switchCase.includes("receipt ? { index, receipt } : { index }"));
  assert.ok(!switchCase.includes("tabUrl:"));
  assert.ok(receiptCase.includes('"get_tab_receipt"'));
  assert.ok(receiptCase.includes("_sanitizeTabResult"));
  assert.ok(!helper.includes("_withMcpTabReceipt"));
});

test("non-profile legacy batches adapt object args to positional functions", () => {
  const runScript = extract(safari, "export async function runScript(", "\n// ========== ACCESSIBILITY SNAPSHOT");
  assert.ok(runScript.includes("navigate: (a) => navigate(a.url)"));
  assert.ok(runScript.includes("newTab: (a) => newTab(a.url || \"\")"));
  assert.ok(runScript.includes("switchTab: (a) => switchTab(a.index)"));
  assert.ok(runScript.includes("navigateAndRead: (a) => navigateAndRead(a.url, a)"));
});

test("partial form misses and zero-effect mutations stop a batch", () => {
  const source = extract(index, "function _isBatchSemanticFailure(", "\nasync function _runExtensionBatchAction");
  const failed = Function(`${source}; return _isBatchSemanticFailure;`)();
  assert.equal(failed("Filled: #field1\nNot found: #field2"), true);
  assert.equal(failed("No click target"), true);
  assert.equal(failed("Typed 0 chars"), true);
  assert.equal(failed({ ok: false, error: "missing" }), true);
  assert.equal(failed("Filled: #field1\nFilled: #field2"), false);
});

test("new/list/switch/getReceipt results strip query and hash while preserving the opaque receipt", () => {
  const source = extract(index, "function _safeUrlForOutput(", "\nfunction _isBatchSemanticFailure");
  const sanitize = Function(`${source}; return _sanitizeTabResult;`)();
  const receipt = "Receipt_ABCDEF123456789012345678";
  const value = sanitize({
    index: 3,
    title: "callback",
    url: "https://example.test/oauth/callback?code=oauth-code&state=sensitive#/app?token=secret",
    receipt,
    active: true,
  });

  assert.deepEqual(value, {
    index: 3,
    title: "callback",
    safeUrl: "https://example.test/oauth/callback",
    receipt,
    active: true,
  });
  assert.equal(Object.hasOwn(value, "url"), false);
  assert.equal(JSON.stringify(value).includes("oauth-code"), false);
  assert.equal(JSON.stringify(value).includes("secret"), false);
});

test("list_tabs never reveals one session's receipt to another or after an origin change", () => {
  const source = extract(background, "function _receiptForOwnedTab(", "\nfunction _mintMcpTabMarker");
  const token = "Receipt_ABCDEF123456789012345678";
  const tokenByTabId = new Map([[42, token]]);
  const receiptByToken = new Map([[token, {
    tabId: 42,
    receiptOrigin: "https://example.test",
  }]]);
  const receiptForOwned = Function(
    "_isTabOwnedBySession",
    "_tokenByTabId",
    "_receiptByToken",
    "_receiptOrigin",
    `${source}; return _receiptForOwnedTab;`
  )(
    (sessionId, tabId) => sessionId === "session-a" && tabId === 42,
    tokenByTabId,
    receiptByToken,
    (url) => new URL(url).origin
  );

  assert.equal(receiptForOwned("session-a", { id: 42, url: "https://example.test/app?secret=1" }), token);
  assert.equal(receiptForOwned("session-b", { id: 42, url: "https://example.test/app" }), "");
  assert.equal(receiptForOwned("session-a", { id: 42, url: "https://redirected.test/app" }), "");
});

test("receipt resolution rejects forged, cross-origin, stale, and changed-tab-id capabilities", async () => {
  const source = extract(background, "async function _resolveReceiptTab(", "\nfunction _addOwnedTab");
  const token = "Receipt_ABCDEF123456789012345678";
  const makeResolver = (record, tabs, options = {}) => {
    const receiptByToken = new Map(record ? [[token, record]] : []);
    const tokenByTabId = new Map(options.bindings || []);
    const replacements = [];
    let persists = 0;
    const resolve = Function(
      "_receiptByToken",
      "_tokenByTabId",
      "_isValidReceiptRecord",
      "browser",
      "_digestTabUrl",
      "_isTabOwnedByAnySession",
      "_receiptOrigin",
      "_persistOwnedTabs",
      "_withReceiptMutationLock",
      `${source}; return _resolveReceiptTab;`
    )(
      receiptByToken,
      tokenByTabId,
      (_candidateToken, candidateRecord) => !!candidateRecord,
      { tabs: { query: async () => tabs } },
      async (url) => `digest:${url}`,
      (tabId) => options.ownedIds?.has(tabId) || false,
      (url) => new URL(url).origin,
      async () => { persists += 1; },
      (operation) => operation()
    );
    return { resolve, receiptByToken, tokenByTabId, replacements, persists: () => persists };
  };

  const forged = makeResolver(null, []);
  assert.equal(await forged.resolve(token), null);

  const validUrl = "https://a.test/path?sig=1#app";
  const direct = makeResolver({
    tabId: 42,
    receiptOrigin: "https://a.test",
    identityDigest: `digest:${validUrl}`,
  }, [{ id: 42, windowId: 7, url: validUrl }]);
  assert.equal((await direct.resolve(token)).id, 42);

  const redirectedUrl = "https://b.test/callback?code=sensitive#route";
  const redirected = makeResolver({
    tabId: 42,
    receiptOrigin: "https://a.test",
    identityDigest: `digest:${redirectedUrl}`,
  }, [{ id: 42, windowId: 7, url: redirectedUrl }]);
  assert.equal(await redirected.resolve(token), null, "old-origin receipt cannot authorize mutation after redirect");
  assert.equal(
    (await redirected.resolve(token, { allowOriginChange: true })).id,
    42,
    "getReceipt may use the old receipt as a locator before rotating it"
  );

  const duplicateUrl = "https://a.test/same";
  const changedId = makeResolver({
    tabId: 99,
    receiptOrigin: "https://a.test",
    identityDigest: `digest:${duplicateUrl}`,
  }, [
    { id: 51, windowId: 7, url: duplicateUrl },
    { id: 52, windowId: 7, url: duplicateUrl },
  ]);
  assert.equal(await changedId.resolve(token), null);
  assert.deepEqual(changedId.replacements, []);

  const uniqueButChangedId = makeResolver({
    tabId: 99,
    receiptOrigin: "https://a.test",
    identityDigest: `digest:${duplicateUrl}`,
  }, [{ id: 52, windowId: 7, url: duplicateUrl }]);
  assert.equal(await uniqueButChangedId.resolve(token), null, "digest-only rebinding must fail closed even when unique");
  assert.deepEqual(uniqueButChangedId.replacements, []);
  assert.equal(uniqueButChangedId.tokenByTabId.has(52), false);
  assert.equal(uniqueButChangedId.persists(), 0);
});

test("receipt rotation is durable before publication and rolls back on persistence failure", async () => {
  const source = extract(background, "async function _issueTabReceipt(", "\nasync function _refreshTabReceiptIdentity");
  const tab = { id: 42, windowId: 7, url: "https://a.test/app?secret=1#route" };
  const oldToken = "OldReceipt_ABCDEF123456789012345";
  const newToken = "NewReceipt_ABCDEF123456789012345";
  const oldRecord = { token: oldToken, tabId: 42, windowId: 7, receiptOrigin: "https://a.test", identityDigest: "old" };
  const receiptByToken = new Map([[oldToken, oldRecord]]);
  const tokenByTabId = new Map([[42, oldToken]]);
  let failPersistence = true;
  const issue = Function(
    "_receiptOrigin",
    "_digestTabUrl",
    "_mintMcpTabMarker",
    "_tokenByTabId",
    "_receiptByToken",
    "_persistOwnedTabs",
    "_withReceiptMutationLock",
    `${source}; return _issueTabReceipt;`
  )(
    (url) => new URL(url).origin,
    async (url) => `digest:${url}`,
    () => newToken,
    tokenByTabId,
    receiptByToken,
    async (strict) => {
      assert.equal(strict, true);
      if (failPersistence) throw new Error("storage unavailable");
    },
    (operation) => operation()
  );

  await assert.rejects(issue(tab), /storage unavailable/);
  assert.equal(tokenByTabId.get(42), oldToken);
  assert.equal(receiptByToken.get(oldToken), oldRecord);
  assert.equal(receiptByToken.has(newToken), false);

  failPersistence = false;
  assert.equal(await issue(tab), newToken);
  assert.equal(tokenByTabId.get(42), newToken);
  assert.equal(receiptByToken.has(oldToken), false);
});

test("receipt rotation is globally serialized across failed and successful persistence", async () => {
  const lockSource = extract(background, "function _withReceiptMutationLock(", "\nasync function _issueTabReceipt(");
  const issueSource = extract(background, "async function _issueTabReceipt(", "\nasync function _refreshTabReceiptIdentity");
  const oldToken = "OldReceipt_ABCDEF123456789012345";
  const tokens = [
    "Receipt_A_ABCDEF123456789012345",
    "Receipt_B_ABCDEF123456789012345",
  ];
  const receiptByToken = new Map([[oldToken, {
    token: oldToken,
    tabId: 42,
    windowId: 7,
    receiptOrigin: "https://a.test",
    identityDigest: "old",
  }]]);
  const tokenByTabId = new Map([[42, oldToken]]);
  let rejectFirst;
  let persistenceCalls = 0;
  const issue = Function(
    "_receiptMutationTail",
    "_receiptOrigin",
    "_digestTabUrl",
    "_mintMcpTabMarker",
    "_tokenByTabId",
    "_receiptByToken",
    "_persistOwnedTabs",
    `${lockSource}\n${issueSource}; return _issueTabReceipt;`
  )(
    Promise.resolve(),
    (url) => new URL(url).origin,
    async (url) => `digest:${url}`,
    () => tokens.shift(),
    tokenByTabId,
    receiptByToken,
    async (strict) => {
      assert.equal(strict, true);
      persistenceCalls += 1;
      if (persistenceCalls === 1) {
        await new Promise((_resolve, reject) => { rejectFirst = reject; });
      }
    }
  );

  const tab = { id: 42, windowId: 7, url: "https://a.test/app" };
  const first = issue(tab);
  while (!rejectFirst) await Promise.resolve();
  const second = issue(tab);
  await Promise.resolve();
  assert.equal(persistenceCalls, 1, "the newer rotation must wait for the older write");
  rejectFirst(new Error("first write failed"));
  await assert.rejects(first, /first write failed/);
  assert.equal(await second, "Receipt_B_ABCDEF123456789012345");
  assert.equal(persistenceCalls, 2);
  assert.equal(tokenByTabId.get(42), "Receipt_B_ABCDEF123456789012345");
  assert.equal(receiptByToken.has(oldToken), false, "the failed older rotation must not resurrect its predecessor");
});

test("receipt rotation prevents an older successful write from landing after a newer one", async () => {
  const lockSource = extract(background, "function _withReceiptMutationLock(", "\nasync function _issueTabReceipt(");
  const issueSource = extract(background, "async function _issueTabReceipt(", "\nasync function _refreshTabReceiptIdentity");
  const tokenByTabId = new Map();
  const receiptByToken = new Map();
  const tokens = [
    "Receipt_A_ABCDEF123456789012345",
    "Receipt_B_ABCDEF123456789012345",
  ];
  const persisted = [];
  let releaseFirst;
  const issue = Function(
    "_receiptMutationTail", "_receiptOrigin", "_digestTabUrl", "_mintMcpTabMarker",
    "_tokenByTabId", "_receiptByToken", "_persistOwnedTabs",
    `${lockSource}\n${issueSource}; return _issueTabReceipt;`
  )(
    Promise.resolve(),
    (url) => new URL(url).origin,
    async (url) => `digest:${url}`,
    () => tokens.shift(),
    tokenByTabId,
    receiptByToken,
    async () => {
      persisted.push(tokenByTabId.get(42));
      if (persisted.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    }
  );

  const tab = { id: 42, windowId: 7, url: "https://a.test/app" };
  const first = issue(tab);
  while (!releaseFirst) await Promise.resolve();
  const second = issue(tab);
  await Promise.resolve();
  assert.deepEqual(persisted, ["Receipt_A_ABCDEF123456789012345"]);
  releaseFirst();
  await first;
  await second;
  assert.deepEqual(persisted, [
    "Receipt_A_ABCDEF123456789012345",
    "Receipt_B_ABCDEF123456789012345",
  ]);
});

test("receipt persistence serializes full-envelope refreshes across different tabs", async () => {
  const lockSource = extract(background, "function _withReceiptMutationLock(", "\nasync function _issueTabReceipt(");
  const refreshSource = extract(background, "async function _refreshTabReceiptIdentity(", "\nasync function _refreshAllReceiptIdentities");
  const tokenA = "Receipt_A_ABCDEF123456789012345";
  const tokenB = "Receipt_B_ABCDEF123456789012345";
  const recordA = { windowId: 7, identityDigest: "digest:old-a" };
  const recordB = { windowId: 8, identityDigest: "digest:old-b" };
  const receiptByToken = new Map([[tokenA, recordA], [tokenB, recordB]]);
  let releaseFirst;
  let persistenceCalls = 0;
  const persistedEnvelopes = [];
  const refresh = Function(
    "_receiptMutationTail", "_tokenByTabId", "_receiptByToken", "_digestTabUrl", "_persistOwnedTabs",
    `${lockSource}\n${refreshSource}; return _refreshTabReceiptIdentity;`
  )(
    Promise.resolve(),
    new Map([[41, tokenA], [42, tokenB]]),
    receiptByToken,
    async (url) => `digest:${url}`,
    async (strict) => {
      assert.equal(strict, true);
      persistenceCalls += 1;
      persistedEnvelopes.push([recordA.identityDigest, recordB.identityDigest]);
      if (persistenceCalls === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    }
  );

  const first = refresh({ id: 41, windowId: 7, url: "new-a" });
  while (!releaseFirst) await Promise.resolve();
  const second = refresh({ id: 42, windowId: 8, url: "new-b" });
  await Promise.resolve();
  assert.equal(persistenceCalls, 1, "the second tab must not start a competing envelope write");
  assert.equal(recordB.identityDigest, "digest:old-b", "the queued mutation itself must wait");
  releaseFirst();
  await first;
  await second;
  assert.deepEqual(persistedEnvelopes, [
    ["digest:new-a", "digest:old-b"],
    ["digest:new-a", "digest:new-b"],
  ]);
});

test("worker rehydration requires the same tab id, exact URL identity, and global uniqueness", () => {
  const helper = extract(background, "function _resolveHydratedReceiptTab(", "\nasync function _hydrateOwnedTabs");
  const resolveHydrated = Function(`${helper}; return _resolveHydratedReceiptTab;`)();
  const record = { tabId: 42, identityDigest: "digest:a" };

  const direct = { id: 42, windowId: 7, url: "a" };
  const duplicate = { id: 43, windowId: 7, url: "a" };
  assert.equal(resolveHydrated(
    [direct], new Map([[42, direct]]), new Map([[42, "digest:a"]]), new Set(), record
  ), direct);
  assert.equal(resolveHydrated(
    [direct, duplicate],
    new Map([[42, direct], [43, duplicate]]),
    new Map([[42, "digest:a"], [43, "digest:a"]]),
    new Set(),
    record
  ), null, "a matching direct id is still ambiguous when another tab has the same digest");
  assert.equal(resolveHydrated(
    [duplicate], new Map([[43, duplicate]]), new Map([[43, "digest:a"]]), new Set(), record
  ), null, "a unique digest must not rebind a missing tab id");
  assert.equal(resolveHydrated(
    [direct, duplicate],
    new Map([[42, direct], [43, duplicate]]),
    new Map([[42, "digest:b"], [43, "digest:a"]]),
    new Set(),
    record
  ), null, "a recycled id with a different digest must not jump to the old URL elsewhere");

  const hydrate = extract(background, "async function _hydrateOwnedTabs(", "\nasync function _persistOwnedTabs");
  assert.ok(hydrate.includes("browser.storage.local.get(_TAB_RECEIPTS_KEY)"));
  assert.ok(hydrate.includes("receiptEnvelope.version === _TAB_RECEIPTS_VERSION"));
  assert.ok(hydrate.includes("_resolveHydratedReceiptTab("));
  assert.ok(hydrate.includes("const resolvedId = validatedIds.get(oldId)"));
  assert.ok(hydrate.indexOf("_recoverSessionWindowsFromOwnedTabs(liveTabsById)") > hydrate.indexOf("for (const [sid, oldIds] of storedOwners)"));
});

test("worker hydration retries after live-tab or durable-storage read failures", async () => {
  const source = extract(background, "async function _hydrateOwnedTabs(", "\nasync function _persistOwnedTabs");
  const makeHarness = (browser) => Function("browser", `
    let _ownedTabsHydrated = false;
    let _ownedTabsHydrationPromise = null;
    const _OWNED_TABS_KEY = "owners-session";
    const _OWNED_TABS_LOCAL_KEY = "owners-local";
    const _TAB_RECEIPTS_KEY = "receipts";
    const _OWNED_TABS_TTL_MS = 1000;
    ${source}
    return { hydrate: _hydrateOwnedTabs, state: () => ({ hydrated: _ownedTabsHydrated, pending: _ownedTabsHydrationPromise }) };
  `)(browser);

  let tabQueries = 0;
  const tabsFailure = makeHarness({
    tabs: { query: async () => { tabQueries += 1; throw new Error("transient tabs failure"); } },
  });
  await assert.rejects(tabsFailure.hydrate(), /Could not verify live tabs/);
  await assert.rejects(tabsFailure.hydrate(), /Could not verify live tabs/);
  assert.equal(tabQueries, 2, "a failed hydration must retry rather than cache an empty success");
  assert.deepEqual(tabsFailure.state(), { hydrated: false, pending: null });

  let localReads = 0;
  const storageFailure = makeHarness({
    tabs: { query: async () => [] },
    storage: {
      session: { get: async () => ({}) },
      local: { get: async () => { localReads += 1; throw new Error("transient storage failure"); } },
    },
  });
  await assert.rejects(storageFailure.hydrate(), /Could not load durable tab ownership/);
  await assert.rejects(storageFailure.hydrate(), /Could not load durable tab ownership/);
  assert.equal(localReads, 2);
  assert.deepEqual(storageFailure.state(), { hydrated: false, pending: null });
});

test("cold-worker tab events hydrate durable state before mutating or persisting it", () => {
  const removed = extract(
    background,
    "browser.tabs.onRemoved.addListener((tabId) => {",
    "\nbrowser.tabs.onUpdated.addListener("
  );
  const hydrateAt = removed.indexOf("await _hydrateOwnedTabs()");
  assert.ok(hydrateAt >= 0);
  assert.ok(hydrateAt < removed.indexOf("_sessionOwnedTabs"));
  assert.ok(hydrateAt < removed.indexOf("_persistOwnedTabs"));

  const updated = extract(
    background,
    "browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {",
    "\n// Verify this extension instance"
  );
  assert.ok(updated.indexOf("_hydrateOwnedTabs()") < updated.indexOf("_tokenByTabId.has(tabId)"));
});

test("receipt identity refresh requires durable persistence and rolls memory back on failure", async () => {
  const source = extract(background, "async function _refreshTabReceiptIdentity(", "\nasync function _refreshAllReceiptIdentities");
  const token = "Receipt_ABCDEF123456789012345678";
  const record = { windowId: 7, identityDigest: "digest:old" };
  const refresh = Function(
    "_tokenByTabId", "_receiptByToken", "_digestTabUrl", "_persistOwnedTabs", "_withReceiptMutationLock",
    `${source}; return _refreshTabReceiptIdentity;`
  )(
    new Map([[42, token]]),
    new Map([[token, record]]),
    async (url) => `digest:${url}`,
    async (strict) => {
      assert.equal(strict, true);
      throw new Error("storage unavailable");
    },
    (operation) => operation()
  );

  await assert.rejects(
    refresh({ id: 42, windowId: 9, url: "https://new.test/path" }),
    /storage unavailable/
  );
  assert.deepEqual(record, { windowId: 7, identityDigest: "digest:old" });
});

test("closing a tab durably revokes its receipt before the browser tab is removed", async () => {
  const source = extract(background, "function _removeOwnedTab(", "\nfunction _isTabOwnedBySession");
  const token = "Receipt_ABCDEF123456789012345678";
  const record = { token, tabId: 42 };
  const owned = new Map([["session-a", new Set([42])]]);
  const tokenByTabId = new Map([[42, token]]);
  const receiptByToken = new Map([[token, record]]);
  let failPersistence = true;
  const removeOwned = Function(
    "_DEFAULT_SESSION", "_sessionOwnedTabs", "_tokenByTabId", "_receiptByToken",
    "_isTabOwnedByAnySession", "_persistOwnedTabs", "_withReceiptMutationLock",
    `${source}; return _removeOwnedTab;`
  )(
    "default",
    owned,
    tokenByTabId,
    receiptByToken,
    (tabId) => [...owned.values()].some((ids) => ids.has(tabId)),
    async (strict) => {
      assert.equal(strict, true);
      if (failPersistence) throw new Error("storage unavailable");
    },
    (operation) => operation()
  );

  await assert.rejects(removeOwned("session-a", 42), /storage unavailable/);
  assert.equal(owned.get("session-a").has(42), true);
  assert.equal(tokenByTabId.get(42), token);
  assert.equal(receiptByToken.get(token), record);

  failPersistence = false;
  await removeOwned("session-a", 42);
  assert.equal(owned.get("session-a").has(42), false);
  assert.equal(tokenByTabId.has(42), false);
  assert.equal(receiptByToken.has(token), false);
});

test("getReceipt requires a verified receipt or ownership in the exact session", () => {
  const source = extract(background, "function _hasTabReceiptAuthority(", "\n// Commands that destroy a tab");
  const authority = Function("_isTabOwnedBySession", `${source}; return _hasTabReceiptAuthority;`)(
    (sessionId, tabId) => sessionId === "session-a" && tabId === 42
  );
  assert.equal(authority("fresh-session", 42, false), false);
  assert.equal(authority("session-a", 42, false), true);
  assert.equal(authority("fresh-session", 42, true), true);

  const handler = extract(background, "async function handleCommand(", "\n// ========== HELPERS ==========");
  assert.ok(handler.includes('type === "get_tab_receipt" && !_hasTabReceiptAuthority(sessionId, tabId, receiptResolved)'));
});

test("getReceipt is locator-only rotation and never mutates or returns the live URL", () => {
  const block = extract(background, 'case "get_tab_receipt":', '\n    // Which WINDOW holds this session');
  assert.ok(block.includes("browser.tabs.get(tabId)"));
  assert.ok(block.includes("_issueTabReceipt(liveTab"));
  assert.ok(block.includes("safeUrl: _safeTabUrl(liveTab.url)"));
  assert.ok(!block.includes("execInTab"));
  assert.ok(!block.includes("executeScript"));
  assert.ok(!block.includes("history.replaceState"));
  assert.ok(!block.includes("url: liveTab.url"));

  const handler = extract(background, "async function handleCommand(", "\n// ========== HELPERS ==========");
  assert.ok(handler.includes('const allowReceiptOriginChange = type === "get_tab_receipt"'));
  assert.ok(handler.includes("allowOriginChange: allowReceiptOriginChange"));

  const batch = extract(index, "async function _runExtensionBatchAction(", "\n// Try the profile-verified extension first");
  const receiptCase = extract(batch, 'case "getReceipt":', '\n\n    case "closeTab"');
  assert.ok(receiptCase.includes("_sanitizeTabResult"));
  assert.ok(!receiptCase.includes("safari.setActiveTabURL(value.url)"));
  assert.ok(!receiptCase.includes("_addOwnedURL(value.url)"));
});
