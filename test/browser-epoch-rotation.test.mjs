#!/usr/bin/env node
/**
 * #105: the first `safari_new_tab` after a daemon restart could mint a receipt the
 * extension rejected a minute later, and `getReceipt` could not rotate it.
 *
 * `_ensureBrowserSessionEpoch()` cached the browser-session epoch in the worker and then
 * short-circuited on that value for the life of the worker. `browser.storage.session` is
 * the authority for it, so once the stored epoch rotated under a worker that stayed
 * alive, every receipt minted afterwards was stamped with the *old* epoch and handed to
 * the client as valid. The next cold `_hydrateOwnedTabs()` does read storage, found every
 * stored record stamped with the previous epoch, and dropped the whole array at once —
 * which is why two tabs minted five seconds apart died together.
 *
 * `_browserEpochGeneration` was written to catch exactly that, and it was compared at six
 * sites and assigned at none: the counter never moved, so the three bare comparisons
 * inside `_ensureBrowserSessionEpoch` could not fire and the three compound ones survived
 * only on their other clause. A counter that is compared but never written is an omission
 * defect, which no behavioural test over the existing paths can see — hence the source
 * contract below alongside the behavioural ones.
 *
 * Run:  node --test test/browser-epoch-rotation.test.mjs
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

const EPOCH_A = "a".repeat(36);
const EPOCH_B = "b".repeat(36);
const KEY = "mcpBrowserSessionEpochV1";

/**
 * Re-create the epoch module state around the real functions. The functions reassign
 * module-level `let`s, so they have to be evaluated inside one scope that owns those
 * bindings rather than receive them as parameters.
 */
function harness({ initial = EPOCH_A, minted = [] } = {}) {
  const store = new Map(initial ? [[KEY, initial]] : []);
  const queue = [...minted];
  const body = `
    "use strict";
    let _browserSessionEpoch = "";
    let _browserEpochInitializationPromise = null;
    let _browserEpochGeneration = 0;
    let _browserEpochStorageTail = Promise.resolve();
    const _browserSessionStorageAvailable = true;
    const _BROWSER_SESSION_EPOCH_KEY = ${JSON.stringify(KEY)};
    ${fnSource("_withBrowserEpochStorageLock")}
    ${fnSource("_adoptBrowserSessionEpoch")}
    ${fnSource("_ensureBrowserSessionEpoch")}
    return {
      ensure: _ensureBrowserSessionEpoch,
      generation: () => _browserEpochGeneration,
      cached: () => _browserSessionEpoch,
    };`;
  return {
    store,
    ...new Function("browser", "_mintMcpTabMarker", body)(
      {
        storage: {
          session: {
            get: async (key) => (store.has(key) ? { [key]: store.get(key) } : {}),
            set: async (patch) => {
              for (const [k, v] of Object.entries(patch)) store.set(k, v);
            },
          },
        },
      },
      () => queue.shift() ?? "f".repeat(36)
    ),
  };
}

test("the stored epoch is the authority on every call, not just the first", async () => {
  const h = harness();
  assert.equal(await h.ensure(), EPOCH_A);

  // The stored epoch rotates while this worker stays alive — a Safari session teardown
  // or a racing worker start. Before #105 the cached value was returned forever here.
  h.store.set(KEY, EPOCH_B);
  assert.equal(await h.ensure(), EPOCH_B, "a rotated epoch must be adopted, not ignored");
  assert.equal(h.cached(), EPOCH_B);
});

test("adopting a rotated epoch bumps the generation the guards compare against", async () => {
  const h = harness();
  await h.ensure();
  const before = h.generation();

  h.store.set(KEY, EPOCH_B);
  await h.ensure();
  assert.equal(h.generation(), before + 1, "the rotation must be visible to in-flight work");
});

test("an unchanged epoch does not bump the generation", async () => {
  const h = harness();
  await h.ensure();
  const before = h.generation();
  await h.ensure();
  await h.ensure();
  assert.equal(h.generation(), before, "re-reading the same value is not a rotation");
});

test("a cleared session store mints a fresh epoch and counts it as a rotation", async () => {
  const h = harness({ minted: [EPOCH_B] });
  assert.equal(await h.ensure(), EPOCH_A);
  const before = h.generation();

  h.store.delete(KEY); // Safari cleared storage.session under a live worker
  assert.equal(await h.ensure(), EPOCH_B);
  assert.equal(h.store.get(KEY), EPOCH_B, "the fresh epoch must be persisted");
  assert.equal(h.generation(), before + 1);
});

test("the first resolution is not a rotation", async () => {
  const h = harness();
  assert.equal(h.generation(), 0);
  await h.ensure();
  assert.equal(h.generation(), 0, "adopting into an empty cache is initialization");
});

test("concurrent callers share one resolution and agree on the epoch", async () => {
  const h = harness();
  const [a, b, c] = await Promise.all([h.ensure(), h.ensure(), h.ensure()]);
  assert.equal(a, EPOCH_A);
  assert.equal(b, EPOCH_A);
  assert.equal(c, EPOCH_A);
});

test("no cache short-circuit returns the epoch without consulting storage", () => {
  const source = fnSource("_ensureBrowserSessionEpoch");
  assert.doesNotMatch(
    source,
    /if\s*\([^)]*test\(_browserSessionEpoch\)\s*\)\s*return\s+_browserSessionEpoch/,
    "returning the cached epoch without reading storage is the #105 defect"
  );
});

// The generalized form of the defect: `_browserEpochGeneration` was compared at six sites
// and assigned at exactly one — its own declaration. Any counter that is snapshotted and
// compared has to be written somewhere, or every guard built on it is decoration.
test("every generation counter that is compared is also written", () => {
  const declarations = [...background.matchAll(/^let (_\w*[Gg]eneration) = \d+;$/gm)].map((m) => m[1]);
  assert.ok(declarations.length > 0, "background.js should declare at least one generation counter");

  for (const name of declarations) {
    const compared = [...background.matchAll(new RegExp(`!==\\s*${name}\\b`, "g"))].length;
    if (!compared) continue;
    const mutations = [...background.matchAll(new RegExp(`${name}\\s*(?:\\+\\+|--|[-+]=)`, "g"))].length;
    assert.ok(
      mutations > 0,
      `${name} is compared at ${compared} sites but never incremented — those guards cannot fire`
    );
  }
});
