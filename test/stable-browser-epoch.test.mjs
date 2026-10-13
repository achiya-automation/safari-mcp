#!/usr/bin/env node
/**
 * #143: receipts from `safari_new_tab` stopped resolving within minutes while Safari kept
 * running.
 *
 * The extension named the browser session with a value kept in `storage.session`, and Safari
 * gives every worker instance its own. So the epoch rotated with each worker succession,
 * instances alive together held different ones, and the first tab removal afterwards made
 * every instance rewrite the shared receipt envelope under its own epoch, dropping what the
 * others had stored. Three changes, each pinned here:
 *
 *   1. the daemon names the session (the Safari process identity) and the epoch derives
 *      from it, so every instance agrees and only a Safari restart changes it;
 *   2. only the worker holding the daemon's lease writes the shared envelopes;
 *   3. a receipt this instance has never seen is looked up in the shared envelope again
 *      before it is refused.
 *
 * Run:  node --test test/stable-browser-epoch.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

/** Source of a top-level `function name(` / `async function name(` declaration. */
function fnSource(name) {
  const start = background.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} should exist in extension/background.js`);
  const end = background.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} should be a top-level declaration`);
  return background.slice(start, end + 2);
}
const constLine = (name) => {
  const m = background.match(new RegExp(`^const ${name} = .*;$`, "m"));
  assert.ok(m, `${name} should be a one-line module constant`);
  return m[0];
};

const HINT_A = "4242:Mon Oct 12 07:51:21 2026";
const HINT_B = "9001:Tue Oct 13 09:00:00 2026";
const HOUR = 60 * 60 * 1000;

/**
 * One worker instance. `local` is shared between instances (storage.local is); `session`
 * is private to each (the defect). The real epoch functions run over them.
 */
function worker({ local = new Map(), session = new Map(), minted = [] } = {}) {
  const queue = [...minted];
  const body = `
    "use strict";
    ${constLine("_SERVER_EPOCH_KEY")}
    ${constLine("_SERVER_EPOCH_MAX_AGE_MS")}
    ${constLine("_SERVER_EPOCH_REFRESH_MS")}
    const _BROWSER_SESSION_EPOCH_KEY = "mcpBrowserSessionEpochV1";
    const _browserSessionStorageAvailable = true;
    let _browserSessionEpoch = "";
    let _browserEpochInitializationPromise = null;
    let _browserEpochGeneration = 0;
    let _browserEpochStorageTail = Promise.resolve();
    let _serverBrowserEpoch = "";
    let _serverEpochStoredAt = 0;
    let _serverEpochRestorePromise = null;
    let _ownedTabsHydrated = true;
    ${fnSource("_withBrowserEpochStorageLock")}
    ${fnSource("_adoptBrowserSessionEpoch")}
    ${fnSource("_deriveServerEpoch")}
    ${fnSource("_storeServerEpoch")}
    ${fnSource("_restoreServerEpoch")}
    ${fnSource("_noteBrowserEpochHint")}
    ${fnSource("_ensureBrowserSessionEpoch")}
    return {
      ensure: _ensureBrowserSessionEpoch,
      note: _noteBrowserEpochHint,
      state: () => ({
        epoch: _browserSessionEpoch,
        server: _serverBrowserEpoch,
        generation: _browserEpochGeneration,
        hydrated: _ownedTabsHydrated,
      }),
    };`;
  const area = (store) => ({
    get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
    set: async (patch) => { for (const [k, v] of Object.entries(patch)) store.set(k, v); },
  });
  return {
    local,
    session,
    ...new Function("browser", "_mintMcpTabMarker", body)(
      { storage: { local: area(local), session: area(session) } },
      () => queue.shift() ?? "f".repeat(36)
    ),
  };
}

test("instances with a private storage.session each mint their own epoch: the defect", async () => {
  const a = worker({ minted: ["a".repeat(36)] });
  const b = worker({ minted: ["b".repeat(36)] });
  assert.notEqual(await a.ensure(), await b.ensure());
});

test("once the daemon names the session, every instance agrees on the epoch", async () => {
  const local = new Map();
  const a = worker({ local, minted: ["a".repeat(36)] });
  const b = worker({ local, minted: ["b".repeat(36)] });
  await a.note(HINT_A);
  await b.note(HINT_A);
  const epoch = await a.ensure();
  assert.match(epoch, /^[a-f0-9]{36}$/);
  assert.equal(await b.ensure(), epoch, "two instances, two private storage.session areas, one epoch");
});

test("a worker that replaces another starts under the epoch the first one stored", async () => {
  const local = new Map();
  const first = worker({ local });
  await first.note(HINT_A);
  const epoch = await first.ensure();

  const cold = worker({ local, minted: ["c".repeat(36)] }); // no response from the daemon yet
  assert.equal(await cold.ensure(), epoch, "a tab event before its first poll is read under the same epoch");
  assert.equal(cold.state().generation, 0, "and nothing rotated");
});

test("the same hint again is not a rotation; a different Safari process is one", async () => {
  const w = worker();
  await w.note(HINT_A);
  const epochA = await w.ensure();
  const generationA = w.state().generation;

  await w.note(HINT_A);
  assert.equal(w.state().generation, generationA, "polls repeat the hint every few seconds");

  await w.note(HINT_B);
  const epochB = await w.ensure();
  assert.notEqual(epochB, epochA, "Safari restarted: tab ids mean nothing any more");
  assert.equal(w.state().generation, generationA + 1, "work stamped with the old epoch aborts instead of writing");
  assert.equal(w.state().hydrated, false, "the next hydration reads storage under the new epoch");
});

test("a hint that is not a process identity is ignored", async () => {
  const w = worker({ minted: ["a".repeat(36)] });
  const before = await w.ensure(); // the storage.session epoch, no daemon hint yet
  for (const junk of [null, undefined, "", "x", "abc:def", "42:", "42:short", `42:${"x".repeat(80)}`, "42:‮hidden‬ text", 12345]) {
    await w.note(junk);
  }
  assert.equal(w.state().server, "", "nothing was adopted");
  assert.equal(await w.ensure(), before);
});

test("a stored identity older than a day is not trusted by a cold worker", async () => {
  const local = new Map();
  const fresh = worker({ local });
  await fresh.note(HINT_A);
  const epoch = await fresh.ensure();

  local.set("mcpServerBrowserEpochV1", { epoch, at: Date.now() - 25 * HOUR });
  const cold = worker({ local, minted: ["d".repeat(36)] });
  assert.equal(await cold.ensure(), "d".repeat(36), "Safari has probably been relaunched since; fall back until the daemon speaks");
});

test("a storage.local that refuses the write does not stop the epoch being adopted", async () => {
  const w = worker();
  w.local.set = () => { throw new Error("quota"); };
  await assert.doesNotReject(w.note(HINT_A));
  assert.match(await w.ensure(), /^[a-f0-9]{36}$/);
});

test("_bridgeFetch hands the daemon's header to the epoch before the caller sees the response", () => {
  const body = fnSource("_bridgeFetch");
  const read = body.indexOf('response.headers.get("X-Safari-MCP-Browser-Epoch")');
  const ret = body.lastIndexOf("return response;");
  assert.ok(read > 0 && ret > read, "the header is read, and awaited, before the response is returned");
  assert.match(body, /await _noteBrowserEpochHint\(/);
  assert.match(body, /catch \{\}/, "a failure to adopt must never take the bridge down");
});

// ---- 2. only the lease holder writes ----

function persistHarness(flags) {
  const localWrites = [];
  const body = `
    "use strict";
    ${constLine("_TAB_RECEIPTS_VERSION")}
    ${constLine("_TAB_RECEIPTS_KEY")}
    ${constLine("_OWNED_TABS_LOCAL_KEY")}
    ${constLine("_OWNED_TABS_KEY")}
    const _ENVELOPE_WRITER = "0123abcd";
    let isConnected = ${flags.isConnected};
    let _enabled = ${flags.enabled ?? true};
    let _bridgeWorkerSuperseded = ${flags.superseded ?? false};
    let _bridgeWorkerRetiring = ${flags.retiring ?? false};
    let _browserSessionEpoch = ${JSON.stringify("e".repeat(36))};
    let _browserEpochGeneration = 0;
    let _browserEpochStorageTail = Promise.resolve();
    const _sessionOwnedTabs = new Map([["s", new Set([7])]]);
    const _receiptByToken = new Map([["t".repeat(32), { token: "t".repeat(32), tabId: 7 }]]);
    async function _ensureBrowserSessionEpoch() { return _browserSessionEpoch; }
    ${fnSource("_withBrowserEpochStorageLock")}
    ${fnSource("_mayPersistOwnership")}
    ${fnSource("_persistOwnedTabs")}
    return _persistOwnedTabs;`;
  const persist = new Function("browser", body)({
    storage: {
      local: { set: async (items) => { localWrites.push(items); } },
      session: { set: async () => {} },
    },
  });
  return { persist, localWrites };
}

test("a connected lease holder writes the shared envelopes", async () => {
  const { persist, localWrites } = persistHarness({ isConnected: true });
  await persist();
  assert.equal(localWrites.length, 1);
});

test("a superseded, retiring, disabled or disconnected worker writes nothing on a tab event", async () => {
  for (const flags of [
    { isConnected: true, superseded: true },
    { isConnected: true, retiring: true },
    { isConnected: true, enabled: false },
    { isConnected: false },
  ]) {
    const { persist, localWrites } = persistHarness(flags);
    assert.deepEqual(await persist(), [], JSON.stringify(flags));
    assert.equal(localWrites.length, 0, `${JSON.stringify(flags)} must not replace the live worker's receipts`);
  }
});

test("a command's durable write is allowed while connecting, and refused only once superseded", async () => {
  const mid = persistHarness({ isConnected: false });
  await mid.persist(true);
  assert.equal(mid.localWrites.length, 1, "a receipt minted by the command that is running right now must be stored");

  const dormant = persistHarness({ isConnected: true, superseded: true });
  await assert.rejects(dormant.persist(true), /no longer holds the bridge lease/);
  assert.equal(dormant.localWrites.length, 0);
});

// ---- 3. a miss reads the shared envelope again ----

const OTHER_TOKEN = "o".repeat(32);
const EPOCH = "e".repeat(36);
const DIGEST = "d".repeat(64);

function resolver({ envelopeHas }) {
  const receiptByToken = new Map();
  const state = { hydrations: 0 };
  const tab = { id: 5, windowId: 3, url: "https://example.com/page" };
  const body = `
    "use strict";
    let _ownedTabsHydrated = true;
    let _ownedTabsHydrationPromise = null;
    ${fnSource("_isValidReceiptRecord")}
    ${fnSource("_resolveReceiptTab")}
    return _resolveReceiptTab;`;
  const resolve = new Function(
    "_receiptByToken", "browser", "_digestTabUrl", "_tokenByTabId", "_isTabOwnedByAnySession",
    "_persistOwnedTabs", "_receiptOrigin", "_withReceiptMutationLock", "_ensureBrowserSessionEpoch",
    "_hydrateOwnedTabs",
    body
  )(
    receiptByToken,
    { tabs: { query: async () => [tab] } },
    async () => DIGEST,
    new Map([[tab.id, OTHER_TOKEN]]),
    () => true,
    async () => {},
    (url) => new URL(url).origin,
    (operation) => operation(),
    async () => EPOCH,
    async () => {
      state.hydrations++;
      if (envelopeHas) {
        receiptByToken.set(OTHER_TOKEN, {
          token: OTHER_TOKEN, tabId: tab.id, windowId: tab.windowId, browserEpoch: EPOCH,
          identityDigest: DIGEST, receiptOrigin: "https://example.com", issuedAt: 1,
        });
      }
    }
  );
  return { resolve, state, tab };
}

test("a receipt another instance minted after this one hydrated is found in the shared envelope", async () => {
  const { resolve, state, tab } = resolver({ envelopeHas: true });
  assert.equal((await resolve(OTHER_TOKEN)).id, tab.id);
  assert.equal(state.hydrations, 1);
});

test("a receipt nobody ever stored still fails closed, after one more look", async () => {
  const { resolve, state } = resolver({ envelopeHas: false });
  await assert.rejects(resolve(OTHER_TOKEN), /no record of that receipt/);
  assert.equal(state.hydrations, 1);
});

test("a string that is not a receipt never causes a storage read", async () => {
  const { resolve, state } = resolver({ envelopeHas: true });
  await assert.rejects(resolve("short"), /no record of that receipt/);
  assert.equal(state.hydrations, 0);
});
