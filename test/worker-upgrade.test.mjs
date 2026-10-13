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
  const decide = createStaleWorkerPolicy();
  assert.deepEqual(decide(idle), { reload: true, reason: "no build announced" });
});

test("a worker that announced any build is left alone, so a newer extension survives an older daemon", () => {
  const decide = createStaleWorkerPolicy();
  assert.equal(decide({ ...idle, build: EXTENSION_BUILD }).reload, false);
  assert.equal(decide({ ...idle, build: "some-future-build" }).reload, false);
});

test("only the lease holder is reloaded, and never while a command is in flight", () => {
  const decide = createStaleWorkerPolicy();
  assert.match(decide({ ...idle, active: false }).reason, /not the lease holder/);
  assert.match(decide({ ...idle, busy: true }).reason, /command is in flight/);
  assert.equal(decide(idle).reload, true, "the skipped looks did not use up an attempt");
});

test("reloads are spaced, and bounded per window, in case a reload ever leaves the code unchanged", () => {
  let t = 1_000_000;
  const decide = createStaleWorkerPolicy({ now: () => t, minGapMs: 20_000, windowMs: 600_000, maxPerWindow: 3 });
  assert.equal(decide(idle).reload, true);
  t += 19_999;
  assert.match(decide(idle).reason, /a moment ago/);
  t += 1;
  assert.equal(decide(idle).reload, true);
  t += 20_000;
  assert.equal(decide(idle).reload, true);
  t += 20_000;
  assert.match(decide(idle).reason, /limit reached/, "three in the window, then no more");
  t += 600_000;
  assert.equal(decide(idle).reload, true, "the window moved on");
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

test("the reload goes through the same command as safari_reload_extension, and looks again before it runs", () => {
  const start = index.indexOf("function _reloadStaleWorker(");
  const body = stripComments(index.slice(start, index.indexOf("\n}\n", start)));
  assert.match(body, /SAFARI_MCP_NO_AUTO_UPGRADE === "1"\) return;/, "it can be switched off");
  assert.match(body, /busy: _pendingRequests\.size > 0/);
  const timer = body.slice(body.indexOf("setTimeout("));
  assert.match(timer, /workerId !== _activeHttpWorkerId \|\| _pendingRequests\.size > 0\) return;/, "nobody queued a command while it waited");
  assert.match(timer, /sendToExtension\("reload_extension", \{\}, 30000\)/);
});

test("this build's envelopes are stored under keys that no older build reads or writes", () => {
  assert.match(background, /const _TAB_RECEIPTS_KEY = "mcpOwnedTabReceiptsV4";/);
  assert.match(background, /const _OWNED_TABS_LOCAL_KEY = "mcpOwnedTabsLocalV2";/);
  const code = stripComments(background);
  assert.ok(!code.includes('"mcpOwnedTabReceiptsV3"'), "an older context keeps writing that key under an epoch of its own");
  assert.ok(!/"mcpOwnedTabsLocal"/.test(code), "likewise");
});
