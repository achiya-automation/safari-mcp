#!/usr/bin/env node
/**
 * #143, second half: contexts Safari kept from an older app.
 *
 * Replacing the extension app does not stop the contexts Safari had already started. Each keeps
 * its own in-memory receipts, writes its own envelope, and becomes the daemon's lease holder
 * again every time it verifies, so a lease moving between an old context and a new one loses
 * the receipts the other minted (measured 13.10.26: an old context's envelope, under an epoch
 * of its own, replaced the new one's twice in ten minutes).
 *
 *   - the build stores its state under keys no older build touches;
 *   - it announces a build on /connect;
 *   - the daemon reloads a lease holder that announced none, once, when no command is in flight.
 *
 * Run:  node --test test/worker-upgrade.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createStaleWorkerPolicy, EXTENSION_BUILD } from "../worker-upgrade.js";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const idle = { build: "", active: true, busy: false };

test("a lease holder that announced no build is reloaded", () => {
  const policy = createStaleWorkerPolicy();
  assert.deepEqual(policy.check(idle), { reload: true, retry: false, reason: "no build announced" });
});

test("a worker that announced any build is left alone, so a newer extension survives an older daemon", () => {
  const policy = createStaleWorkerPolicy();
  assert.equal(policy.check({ ...idle, build: EXTENSION_BUILD }).reload, false);
  assert.equal(policy.check({ ...idle, build: "some-future-build" }).reload, false);
  assert.equal(policy.check({ ...idle, build: EXTENSION_BUILD }).retry, false, "nothing to wait for");
});

test("only the lease holder is reloaded; a command in flight delays it instead of cancelling it", () => {
  const policy = createStaleWorkerPolicy();
  assert.deepEqual(policy.check({ ...idle, active: false }), { reload: false, retry: false, reason: "not the lease holder" });
  assert.deepEqual(policy.check({ ...idle, busy: true }), { reload: false, retry: true, reason: "a command is in flight" });
  assert.equal(policy.check(idle).reload, true, "looking does not use up an attempt");
});

test("reloads are spaced, and bounded per window, in case a reload ever leaves the code unchanged", () => {
  let t = 1_000_000;
  const policy = createStaleWorkerPolicy({ now: () => t, minGapMs: 20_000, windowMs: 600_000, maxPerWindow: 3 });
  assert.equal(policy.check(idle).reload, true);
  policy.commit();
  t += 19_999;
  assert.deepEqual(policy.check(idle), { reload: false, retry: true, reason: "reloaded one a moment ago" });
  t += 1;
  assert.equal(policy.check(idle).reload, true);
  policy.commit();
  t += 20_000;
  assert.equal(policy.check(idle).reload, true);
  policy.commit();
  t += 20_000;
  assert.deepEqual(policy.check(idle), { reload: false, retry: false, reason: "reload limit reached" }, "three in the window, then no more");
  t += 600_000;
  assert.equal(policy.check(idle).reload, true, "the window moved on");
});

test("the extension and the daemon agree on the build name", () => {
  const sent = /const _EXTENSION_BUILD = "([^"]+)";/.exec(background)?.[1];
  assert.equal(sent, EXTENSION_BUILD);
  assert.match(background, /connect\?verifier=existing-tab-v1&protocol=popup-opener-lease-v2&build=\$\{_EXTENSION_BUILD\}/);
});

test("the daemon remembers the announced build and checks it when the worker takes the lease", () => {
  assert.match(index, /const announcedBuild = String\(connectUrl\.searchParams\.get\("build"\) \|\| ""\);/);
  assert.match(index, /\/\^\[A-Za-z0-9\._-\]\{1,40\}\$\/\.test\(announcedBuild\)/, "the value is validated before it is stored");
  assert.match(index, /_connectingHttpWorkers\.set\(workerId, \{ connectedAt: now, reloadHandoffToken, build \}\)/);
  const verified = index.slice(index.indexOf('req.url === "/extension-verified"'));
  const responded = verified.indexOf('res.end(JSON.stringify({ status: "verified" }));');
  const reloaded = verified.indexOf("_reloadStaleWorker(workerId, verifiedBuild);");
  assert.ok(responded > 0 && reloaded > responded, "the reload is decided after the worker has its answer");
  assert.match(index, /const verifiedBuild = connectingWorker\.build \|\| "";\s*_activeHttpWorkerId = workerId;/, "read before the connecting record is deleted");
});

test("the daemon decides inside the timer, keeps looking while the worker stays the lease holder, and prepares the same handoff the tool does", () => {
  const start = index.indexOf("function _reloadStaleWorker(");
  const body = stripComments(index.slice(start, index.indexOf("\n}\n", start)));
  assert.match(body, /SAFARI_MCP_NO_AUTO_UPGRADE === "1" \|\| build\) return;/, "it can be switched off, and a worker with a build is never looked at");
  const timer = body.slice(body.indexOf("setTimeout("));
  assert.match(timer, /_staleWorkerPolicy\.check\(\{[\s\S]*?busy: _pendingRequests\.size > 0,/, "decided when the timer fires, with the state of that moment");
  assert.match(timer, /if \(verdict\.retry && attempt < 20\) _reloadStaleWorker\(workerId, build, attempt \+ 1\);/, "a command in flight delays the reload, it does not cancel it");
  assert.ok(timer.indexOf("_staleWorkerPolicy.commit();") > timer.indexOf("if (!verdict.reload)"), "an attempt is recorded only when a reload is really going out");
  assert.match(timer, /handoff = _prepareReloadHttpWorkerHandoff\(\);/, "without a handoff the extension refuses to reload");
  assert.match(timer, /sendToExtension\("reload_extension", \{ reloadHandoff: handoff\.token \}, 30000\)/);
  assert.match(timer, /if \(handoff\) _cancelReloadHttpWorkerHandoff\(handoff\);/, "a failed reload gives the handoff back");
  assert.match(timer, /console\.error\(`\[Safari MCP\] reloading worker/, "a failure is logged, not swallowed");
});

test("this build's envelopes are stored under keys that no older build reads or writes", () => {
  assert.match(background, /const _TAB_RECEIPTS_KEY = "mcpOwnedTabReceiptsV4";/);
  assert.match(background, /const _OWNED_TABS_LOCAL_KEY = "mcpOwnedTabsLocalV2";/);
  const code = stripComments(background);
  assert.ok(!code.includes('"mcpOwnedTabReceiptsV3"'), "an older context keeps writing that key under an epoch of its own");
  assert.ok(!/"mcpOwnedTabsLocal"/.test(code), "likewise");
});
