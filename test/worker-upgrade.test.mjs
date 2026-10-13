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
  assert.deepEqual(policy.check(idle), { reload: true, reason: "no build announced" });
});

test("a worker that announced any build is left alone, so a newer extension survives an older daemon", () => {
  const policy = createStaleWorkerPolicy();
  assert.equal(policy.check({ ...idle, build: EXTENSION_BUILD }).reload, false);
  assert.equal(policy.check({ ...idle, build: "some-future-build" }).reload, false);
});

test("only the lease holder is reloaded; a command in flight only delays it", () => {
  const policy = createStaleWorkerPolicy();
  assert.deepEqual(policy.check({ ...idle, active: false }), { reload: false, reason: "not the lease holder" });
  assert.deepEqual(policy.check({ ...idle, busy: true }), { reload: false, reason: "a command is in flight" });
  assert.equal(policy.check(idle).reload, true, "looking does not use up an attempt");
});

test("reloads are spaced, and bounded per window, in case a reload ever leaves the code unchanged", () => {
  let t = 1_000_000;
  const policy = createStaleWorkerPolicy({ now: () => t, minGapMs: 20_000, windowMs: 600_000, maxPerWindow: 3 });
  assert.equal(policy.check(idle).reload, true);
  policy.commit();
  t += 19_999;
  assert.deepEqual(policy.check(idle), { reload: false, reason: "reloaded one a moment ago" });
  t += 1;
  assert.equal(policy.check(idle).reload, true);
  policy.commit();
  t += 20_000;
  assert.equal(policy.check(idle).reload, true);
  policy.commit();
  t += 20_000;
  assert.deepEqual(policy.check(idle), { reload: false, reason: "reload limit reached" }, "three in the window, then no more");
  t += 600_000;
  assert.equal(policy.check(idle).reload, true, "the window moved on");
});

test("the extension and the daemon agree on the build name", () => {
  const sent = /const _EXTENSION_BUILD = "([^"]+)";/.exec(background)?.[1];
  assert.equal(sent, EXTENSION_BUILD);
  assert.match(background, /connect\?verifier=existing-tab-v1&protocol=popup-opener-lease-v2&build=\$\{_EXTENSION_BUILD\}/);
});

test("the daemon remembers the build the lease holder announced, from the record it made at /connect", () => {
  assert.match(index, /const announcedBuild = String\(connectUrl\.searchParams\.get\("build"\) \|\| ""\);/);
  assert.match(index, /\/\^\[A-Za-z0-9\._-\]\{1,40\}\$\/\.test\(announcedBuild\)/, "the value is validated before it is stored");
  assert.match(index, /_connectingHttpWorkers\.set\(workerId, \{ connectedAt: now, reloadHandoffToken, build \}\)/);
  const verified = index.slice(index.lastIndexOf('req.url === "/extension-verified"')); // the handler; the first hit is the auth list
  const activated = verified.indexOf("_activeHttpWorkerId = workerId;");
  const remembered = verified.indexOf("_activeHttpWorkerBuild = connectingWorker.build || \"\";");
  assert.ok(activated > 0 && remembered > activated, "remembered as the worker becomes the lease holder");
  assert.ok(remembered < verified.indexOf("_connectingHttpWorkers.delete(workerId);", activated), "read before the connecting record is deleted");
  assert.match(index, /_activeHttpWorkerId = workerId;\s*_activeHttpWorkerBuild = build;/, "also where a worker is activated without a profile");
});

test("the daemon asks on every poll of the lease holder until it has been reloaded", () => {
  const pollAt = index.lastIndexOf('req.url === "/poll"'); // the handler; the first hit is the auth list
  const poll = index.slice(pollAt, index.indexOf('req.url === "/result"', pollAt));
  const asked = poll.indexOf("_reloadStaleWorker(pollingWorkerId);");
  assert.ok(asked > 0, "the poll handler asks");
  assert.ok(poll.indexOf("_requireActiveHttpWorker(req, res)") < asked, "only the worker that holds the lease is asked about");
  assert.ok(asked < poll.indexOf("_dequeueHttpCommand(pollingWorkerId)"), "before the dequeue, so the reload goes out in this very poll");
});

test("the reload prepares the same handoff safari_reload_extension does, and never runs twice at once", () => {
  const start = index.indexOf("async function _reloadStaleWorker(");
  const body = stripComments(index.slice(start, index.indexOf("\n}\n", start)));
  assert.match(body, /SAFARI_MCP_NO_AUTO_UPGRADE === "1" \|\| _staleReloadInFlight\) return;/, "it can be switched off, and does not overlap itself");
  assert.match(body, /workerId !== _activeHttpWorkerId \|\| _activeHttpWorkerBuild\) return;/, "a worker with a build, or one that lost the lease, is left alone");
  assert.match(body, /busy: _pendingRequests\.size > 0,/);
  assert.ok(body.indexOf("_staleWorkerPolicy.commit();") > body.indexOf("if (!verdict.reload) return;"), "an attempt is recorded only when a reload is really going out");
  assert.match(body, /handoff = _prepareReloadHttpWorkerHandoff\(\);/, "without a handoff the extension refuses to reload");
  assert.match(body, /sendToExtension\("reload_extension", \{ reloadHandoff: handoff\.token \}, 30000\)/);
  assert.match(body, /if \(handoff\) _cancelReloadHttpWorkerHandoff\(handoff\);/, "a failed reload gives the handoff back");
  assert.match(body, /console\.error\(`\[Safari MCP\] reloading worker/, "a failure is logged, not swallowed");
  assert.match(body, /\} finally \{\s*_staleReloadInFlight = false;/);
});

test("this build's envelopes are stored under keys that no older build reads or writes", () => {
  assert.match(background, /const _TAB_RECEIPTS_KEY = "mcpOwnedTabReceiptsV4";/);
  assert.match(background, /const _OWNED_TABS_LOCAL_KEY = "mcpOwnedTabsLocalV2";/);
  const code = stripComments(background);
  assert.ok(!code.includes('"mcpOwnedTabReceiptsV3"'), "an older context keeps writing that key under an epoch of its own");
  assert.ok(!/"mcpOwnedTabsLocal"/.test(code), "likewise");
});
