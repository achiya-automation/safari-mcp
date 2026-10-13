#!/usr/bin/env node
/**
 * #143: receipts from `safari_new_tab` stop resolving within minutes while Safari keeps
 * running. On 2026-10-13 the profile's storage.local history showed four browser-session
 * epochs in five minutes, and four envelopes written in the same millisecond under four
 * different epochs. That reads as several live worker instances, each with its own
 * storage.session, but an envelope did not say which worker wrote it, so the history
 * could not prove it.
 *
 * Both ownership envelopes now carry `writer`, the prefix of `_bridgeWorkerId` that the
 * daemon log prints for a worker. It is diagnostic only: hydration must never trust it.
 *
 * Run:  node --test test/envelope-writer.test.mjs
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

const WORKER_ID = "0123abcd" + "e".repeat(24);
const EPOCH = "a".repeat(36);
const TOKEN = "t".repeat(32);

function harness() {
  const writerLine = background.match(/^const _ENVELOPE_WRITER = .*;$/m);
  assert.ok(writerLine, "_ENVELOPE_WRITER should be a module-level constant");
  const localWrites = [];
  const sessionWrites = [];
  const browser = {
    storage: {
      local: { set: async (items) => { localWrites.push(items); } },
      session: { set: async (items) => { sessionWrites.push(items); } },
    },
  };
  const persist = new Function("browser", `
    "use strict";
    const _bridgeWorkerId = ${JSON.stringify(WORKER_ID)};
    ${writerLine[0]}
    const _TAB_RECEIPTS_VERSION = 3;
    const _TAB_RECEIPTS_KEY = "mcpOwnedTabReceiptsV3";
    const _OWNED_TABS_LOCAL_KEY = "mcpOwnedTabsLocal";
    const _OWNED_TABS_KEY = "mcpSessionOwnedTabs";
    let _browserSessionEpoch = ${JSON.stringify(EPOCH)};
    let _browserEpochGeneration = 0;
    let _browserEpochStorageTail = Promise.resolve();
    const _sessionOwnedTabs = new Map([["session-a", new Set([7])]]);
    const _receiptByToken = new Map([[${JSON.stringify(TOKEN)}, { token: ${JSON.stringify(TOKEN)}, tabId: 7 }]]);
    async function _ensureBrowserSessionEpoch() { return _browserSessionEpoch; }
    function _mayPersistOwnership() { return true; } // this worker holds the lease (see stable-browser-epoch.test.mjs)
    ${fnSource("_withBrowserEpochStorageLock")}
    ${fnSource("_persistOwnedTabs")}
    return _persistOwnedTabs;
  `)(browser);
  return { persist, localWrites, sessionWrites };
}

test("_ENVELOPE_WRITER is the worker-id prefix the daemon log prints", () => {
  const declared = background.search(/^const _bridgeWorkerId = /m);
  const writer = background.search(/^const _ENVELOPE_WRITER = _bridgeWorkerId\.slice\(0, 8\);$/m);
  assert.ok(declared >= 0, "_bridgeWorkerId should be a module-level constant");
  assert.ok(writer > declared, "_ENVELOPE_WRITER must be derived after _bridgeWorkerId exists");
});

test("both ownership envelopes name the worker that wrote them", async () => {
  const { persist, localWrites } = harness();
  await persist(true);
  assert.equal(localWrites.length, 1);
  const receipts = localWrites[0].mcpOwnedTabReceiptsV3;
  const owners = localWrites[0].mcpOwnedTabsLocal;
  assert.equal(receipts.writer, "0123abcd");
  assert.equal(owners.writer, "0123abcd");
  // The fields hydration does read are unchanged.
  assert.equal(receipts.version, 3);
  assert.equal(receipts.browserEpoch, EPOCH);
  assert.equal(typeof receipts.at, "number");
  assert.deepEqual(receipts.records.map((record) => record.tabId), [7]);
  assert.equal(owners.browserEpoch, EPOCH);
  assert.deepEqual(owners.tabs, { "session-a": [7] });
});

test("hydration never reads the writer stamp", () => {
  const hydrate = background.slice(
    background.indexOf("async function _hydrateOwnedTabs("),
    background.indexOf("async function _persistOwnedTabs(")
  );
  assert.ok(hydrate.length > 0, "_hydrateOwnedTabs should precede _persistOwnedTabs");
  assert.doesNotMatch(hydrate, /writer|_ENVELOPE_WRITER/);
});
