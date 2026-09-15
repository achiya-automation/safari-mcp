#!/usr/bin/env node
/**
 * A second connect() a few seconds after a successful one dropped whatever command the
 * worker had just been handed. Seen live 15.9.26 with diagnostic logging on the host:
 *
 *   10:25:39 verified worker a65e8e
 *   10:25:43 verified worker a65e8e (pending 1)
 *   10:26:12 list_tabs timed out: delivered 30s ago to worker a65e8e; last poll 4s ago,
 *            last heartbeat never
 *
 * The host sends its keepalive list_tabs 3s after a verification, and the command
 * reached the worker just before the duplicate connect: that connect invalidated the
 * poll loop holding it, the loop returned without running it, and the host waited out
 * 30s. The same window took any first command after an idle wake, which is how
 * safari_reload_extension kept timing out. The duplicate came from a reconnect timer
 * that a success never cancelled — the minute alarm schedules one when it finds the
 * worker not yet connected, even while the startup connect is still in flight.
 *
 * Run:  node --test test/reconnect-drops-command.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function sourceBetween(startNeedle, endNeedle) {
  const start = background.indexOf(startNeedle);
  const end = background.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `could not extract ${startNeedle}`);
  return background.slice(start, end);
}

const flush = async () => {
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeTimers() {
  const timers = new Map();
  let nextId = 0;
  return {
    setTimeout: (fire) => { nextId += 1; timers.set(nextId, fire); return nextId; },
    clearTimeout: (id) => { timers.delete(id); },
    elapse: () => { for (const [id, fire] of [...timers]) { timers.delete(id); fire(); } },
  };
}

test("a reconnect scheduled before a successful connect never runs after it", async () => {
  const timers = fakeTimers();
  let handshakes = 0;
  const polls = [];
  const harness = Function(
    "_bridgeFetch", "browser", "_storedReloadHandoffToken", "_verifyProfileMatch",
    "_discoverProfileWindow", "updateBadge", "_startHeartbeat", "_stopHeartbeat",
    "pollForCommands", "AbortSignal", "setTimeout", "clearTimeout",
    `const BRIDGE_PORTS = [9224];
     let HTTP_URL = "http://127.0.0.1:9224";
     let _enabled = true;
     let _bridgeWorkerSuperseded = false;
     let _bridgeWorkerRetiring = false;
     let pollAbort = null;
     let _pollLoopGeneration = 0;
     let isConnected = false;
     let _targetProfile = null;
     let _reconnectDelay = 3000;
     let _reconnectTimer = null;
     const _RECONNECT_MAX = 60000;
     const _BRIDGE_RELOAD_HANDOFF_KEY = "reload";
     let _commandExecutionTail = Promise.resolve();
     ${sourceBetween("let _connecting = false", "async function pollForCommands(")}
     return { connect, scheduleReconnect, state: () => ({ isConnected, generation: _pollLoopGeneration }) };`
  )(
    async (url) => {
      if (String(url).includes("/connect")) handshakes += 1;
      return { ok: true, status: 200, json: async () => ({ profile: null }) };
    },
    {
      storage: { local: { get: async () => ({}), remove: async () => {}, set: async () => {} } },
      alarms: { create: () => {} },
    },
    async () => "",
    async () => true,
    async () => {},
    () => {},
    () => {},
    () => {},
    (generation) => polls.push(generation),
    AbortSignal,
    timers.setTimeout,
    timers.clearTimeout
  );

  // The worker wakes: the alarm finds it not connected and schedules a retry, while the
  // startup connect is already on its way to a successful verification.
  harness.scheduleReconnect(3000);
  await harness.connect();
  assert.equal(harness.state().isConnected, true);

  timers.elapse(); // three seconds later
  await flush();
  assert.equal(handshakes, 1, "a connected worker must not hand-shake again");
  assert.deepEqual(polls, [1], "the healthy poll loop must stay the only generation");
});

test("the minute alarm leaves a connect that is already in flight alone", () => {
  const alarmSource = sourceBetween('browser.alarms.create("keepalive"', "// ========== STARTUP");
  const run = (connecting) => {
    let listener = null;
    let scheduled = 0;
    Function(
      "browser", "scheduleReconnect", "_startHeartbeat",
      `let isConnected = false;
       let _enabled = true;
       let _bridgeWorkerSuperseded = false;
       let _bridgeWorkerRetiring = false;
       let _reconnectTimer = null;
       let _heartbeatTimer = 1;
       let _connecting = ${connecting};
       ${alarmSource}`
    )(
      { alarms: { create: () => {}, onAlarm: { addListener: (fn) => { listener = fn; } } } },
      () => { scheduled += 1; },
      () => {}
    );
    listener({ name: "keepalive" });
    return scheduled;
  };
  assert.equal(run(true), 0, "a retry queued behind an in-flight connect becomes a duplicate connect");
  assert.equal(run(false), 1, "a worker that is really disconnected still gets a retry");
});

test("a command handed to a poll that a reconnect invalidated still runs", async () => {
  const timers = fakeTimers();
  const executed = [];
  let fetches = 0;
  let invalidate = null;
  const harness = Function(
    "_bridgeFetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "updateBadge", "_stopHeartbeat", "scheduleReconnect", "executeAndReply", "console",
    "_disconnectContentKeepalivePort", "AbortSignal",
    `let HTTP_URL = "http://127.0.0.1:9224";
     let isConnected = true;
     let _enabled = true;
     let _bridgeWorkerSuperseded = false;
     let _bridgeWorkerRetiring = false;
     let pollAbort = null;
     let _pollLoopGeneration = 1;
     let _commandExecutionTail = Promise.resolve();
     ${sourceBetween("async function pollForCommands(", "async function executeAndReply(")}
     return { run: pollForCommands, invalidate: () => { _pollLoopGeneration += 1; } };`
  )(
    async () => {
      fetches += 1;
      // The host has already marked this command dispatched to the worker when the
      // duplicate connect bumps the generation.
      invalidate();
      return { status: 200, json: async () => ({ id: "keepalive-list", type: "list_tabs", payload: {} }) };
    },
    timers.setTimeout,
    timers.clearTimeout,
    () => 1,
    () => {},
    () => {},
    () => {},
    () => {},
    async (msg) => { executed.push(msg.id); },
    { log: () => {} },
    () => {},
    AbortSignal
  );
  invalidate = harness.invalidate;

  await harness.run(1);
  assert.deepEqual(executed, ["keepalive-list"], "nobody else will ever run a command the host handed to this worker");
  assert.equal(fetches, 1, "an invalidated loop stops polling once that command is done");
});
