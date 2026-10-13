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
import { createStaleWorkerPolicy, EXTENSION_BUILD, leaseBuildVerdict, LEASE_BUILD_PREFERENCE_MS } from "../worker-upgrade.js";

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
  assert.match(index, /_connectingHttpWorkers\.set\(workerId, \{ connectedAt: now, reloadHandoffToken, build, origin \}\)/);
  const verified = index.slice(index.lastIndexOf('req.url === "/extension-verified"')); // the handler; the first hit is the auth list
  const activated = verified.indexOf("_activeHttpWorkerId = workerId;");
  const remembered = verified.indexOf("_activeHttpWorkerBuild = connectingWorker.build || \"\";");
  assert.ok(activated > 0 && remembered > activated, "remembered as the worker becomes the lease holder");
  assert.ok(remembered < verified.indexOf("_connectingHttpWorkers.delete(workerId);", activated), "read before the connecting record is deleted");
  assert.match(index, /_activeHttpWorkerId = workerId;\s*_activeHttpWorkerBuild = build;/, "also where a worker is activated without a profile");
});

test("builds alone settle who may lead: older never while a current one is around, current always over older", () => {
  const v = (candidateBuild, holderBuild, hasHolder, currentSeenRecently) =>
    leaseBuildVerdict({ candidateBuild, holderBuild, hasHolder, currentSeenRecently });
  const B = EXTENSION_BUILD;
  assert.equal(v("", "", false, true), "deny", "even with nobody holding the lease");
  assert.equal(v("", B, true, true), "deny");
  assert.equal(v("", "", true, true), "deny");
  assert.equal(v("", "", false, false), "ordinary", "no current context around: the usual rule");
  assert.equal(v("", "", true, false), "ordinary");
  assert.equal(v(B, "", true, true), "take", "a current context replaces an older holder");
  assert.equal(v(B, "", true, false), "take");
  assert.equal(v(B, B, true, true), "ordinary", "two current contexts follow the usual rule");
  assert.equal(v(B, "", false, true), "ordinary", "nobody holds it: nothing to take");
  assert.ok(LEASE_BUILD_PREFERENCE_MS >= 5 * 60_000, "long enough to outlast a context parked between its alarms");
});

// The lease rule itself, run from the daemon's source with its other rules (a command in flight, a
// reload handoff, the freshness window) in place.
function leaseHarness() {
  const helperSource = index.slice(
    index.indexOf("function _prepareReloadHttpWorkerHandoff("),
    index.indexOf("function _requireActiveHttpWorker("),
  );
  return Function("randomBytes", "leaseBuildVerdict", `
    const baseNow = Date.now();
    let _activeHttpWorkerId = "";
    let _activeHttpWorkerBuild = "";
    let _currentBuildSeen = false;
    let _extensionConnected = true;
    let _extensionLastPollTime = baseNow;
    let _extensionLastHeartbeat = 0;
    let _reloadHttpWorkerHandoff = null;
    const _currentBuildWorkerSeenRecently = () => _currentBuildSeen;
    const _pendingRequests = new Map();
    const _HTTP_RELOAD_HANDOFF_TTL_MS = 30_000;
    const _HTTP_WORKER_SUCCESSOR_GRACE_MS = 20_000;
    ${helperSource}
    return {
      hold: (id, build) => { _activeHttpWorkerId = id; _activeHttpWorkerBuild = build; },
      currentSeen: (seen) => { _currentBuildSeen = seen; },
      mayReplace: (id, build, now = baseNow) => _mayReplaceActiveHttpWorker(id, "", now, build),
      fresh: () => { _extensionLastPollTime = baseNow; },
      quietFor: (ms) => { _extensionLastPollTime = baseNow - ms; },
      dispatchedTo: (id) => _pendingRequests.set("click", { dispatchedWorkerId: id }),
      pendingHandoff: () => { _reloadHttpWorkerHandoff = { armed: true, expiresAt: baseNow + 30_000, fromWorkerId: _activeHttpWorkerId, token: "handoff_token_abcdefghijklmnop" }; },
    };
  `)(() => ({ toString: () => "handoff_token_abcdefghijklmnop" }), leaseBuildVerdict);
}
const NEW = EXTENSION_BUILD;

test("an older context never takes the lease while a current one is around, fresh holder or not", () => {
  const lease = leaseHarness();
  assert.equal(lease.mayReplace("old-1", ""), true, "sanity: with nobody holding it and no current context around it passes");
  lease.currentSeen(true);
  lease.hold("new-1", NEW);
  lease.quietFor(60_000);
  assert.equal(lease.mayReplace("old-1", ""), false, "not even from a holder that has been quiet for a minute");
  lease.hold("", "");
  assert.equal(lease.mayReplace("old-1", ""), false, "not even when nobody holds it");
});

test("with no current context around, the usual rule decides for an older one", () => {
  const lease = leaseHarness();
  lease.hold("old-1", "");
  lease.fresh();
  assert.equal(lease.mayReplace("old-2", ""), false, "a polling holder keeps it");
  lease.quietFor(21_000);
  assert.equal(lease.mayReplace("old-2", ""), true, "a quiet one loses it");
});

test("a current context takes the lease from an older holder at once, unless the holder is mid-command or a handoff is pending", () => {
  const lease = leaseHarness();
  lease.currentSeen(true);
  lease.hold("old-1", "");
  lease.fresh();
  assert.equal(lease.mayReplace("new-1", NEW), true, "the older holder is still polling and still loses it");
  lease.dispatchedTo("old-1");
  assert.equal(lease.mayReplace("new-1", NEW), false, "a mutation already delivered to the holder is never cut off");
  const pending = leaseHarness();
  pending.hold("old-1", "");
  pending.fresh();
  pending.pendingHandoff();
  assert.equal(pending.mayReplace("new-1", NEW), false, "only the reload's own successor may use the handoff");
});

test("two current contexts follow the usual rule, and the holder itself is always let through", () => {
  const lease = leaseHarness();
  lease.currentSeen(true);
  lease.hold("new-1", NEW);
  lease.fresh();
  assert.equal(lease.mayReplace("new-2", NEW), false);
  assert.equal(lease.mayReplace("new-1", NEW), true);
  lease.quietFor(21_000);
  assert.equal(lease.mayReplace("new-2", NEW), true);
  const old = leaseHarness();
  old.currentSeen(true);
  old.hold("old-1", "");
  assert.equal(old.mayReplace("old-1", ""), true, "re-verifying never evicts the holder itself");
});

test("both places that grant the lease note a current context first, pass the build, and log the change", () => {
  const verified = index.slice(index.lastIndexOf('req.url === "/extension-verified"'));
  const noted = verified.indexOf("_noteCurrentBuildWorker(connectingWorker.build);");
  const decided = verified.indexOf("_mayReplaceActiveHttpWorker(workerId, connectingWorker.reloadHandoffToken, Date.now(), connectingWorker.build || \"\")");
  assert.ok(noted > 0 && decided > noted, "a current context that is turned away still proves one is around");
  assert.match(verified, /if \(workerChanged\) _logLeaseChange\(_activeHttpWorkerId, workerId, connectingWorker\.build, connectingWorker\.origin\);\s*_activeHttpWorkerId = workerId;/, "logged while the old holder is still known");
  const connect = index.slice(index.indexOf("// When SAFARI_PROFILE is set, don't mark as connected"), index.indexOf("// POST /heartbeat"));
  assert.ok(connect.indexOf("_noteCurrentBuildWorker(build);") < connect.indexOf("_mayReplaceActiveHttpWorker(workerId, reloadHandoffToken, Date.now(), build)"));
  assert.match(connect, /if \(workerChanged\) _logLeaseChange\(_activeHttpWorkerId, workerId, build, originId\);\s*_activeHttpWorkerId = workerId;/);
});

test("reloading is only the fallback: it is skipped while a current context is around", () => {
  const start = index.indexOf("async function _reloadStaleWorker(");
  const body = stripComments(index.slice(start, index.indexOf("\n}\n", start)));
  assert.ok(body.indexOf("_currentBuildWorkerSeenRecently()") > body.indexOf("_activeHttpWorkerBuild) return;"));
  assert.ok(body.indexOf("_currentBuildWorkerSeenRecently()") < body.indexOf("_staleWorkerPolicy.check("), "before the rate limit is consulted, so nothing is used up");
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
