#!/usr/bin/env node
/**
 * Regression coverage for profile-scoped extension routing.
 *
 * A worker once persisted `wrong:אוטומציות — Start Page` while a different profile
 * happened to own port 9224. That raw verdict permanently rejected the correct worker,
 * forcing every tool through Apple Events; when TCC returned -1743 the whole MCP died.
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const BROWSER_EPOCH = "e".repeat(36);
const manifest = JSON.parse(
  readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")
);
const xcodeProject = readFileSync(
  new URL("../xcode/Safari MCP/Safari MCP.xcodeproj/project.pbxproj", import.meta.url),
  "utf8"
);

function extractedCanonicalizer() {
  const start = background.indexOf("function _canonicalProfileName(");
  const end = background.indexOf("\n}", start);
  assert.ok(start > 0 && end > start, "profile canonicalizer should exist");
  const source = background.slice(start, end + 2);
  return Function(`${source}; return _canonicalProfileName;`)();
}

test("legacy wrong:<profile> window verdicts migrate to a stable profile identity", () => {
  const canonical = extractedCanonicalizer();
  assert.equal(canonical("wrong:אוטומציות — עמוד הפתיחה"), "אוטומציות");
  assert.equal(canonical("wrong:עבודה — Meta Business Suite"), "עבודה");
  assert.equal(canonical("מחקר אנונימי"), "מחקר אנונימי");
  assert.equal(canonical("notfound"), "");
  assert.equal(canonical("__personal__"), "");
});

test("transient verification failures are not persisted as profile identities", () => {
  const verify = background.slice(
    background.indexOf("async function _verifyProfileMatch("),
    background.indexOf("async function _discoverProfileWindow(")
  );
  assert.match(verify, /detectedProfile === expected/);
  assert.match(verify, /remove\("mcpVerifiedProfile"\)/);
  assert.doesNotMatch(
    verify,
    /mcpVerifiedProfile:\s*result\.actualProfile\s*\|\|\s*"__personal__"/,
    "notfound/error must not poison all future reconnects"
  );
});

test("profile verification never creates or closes a temporary browser tab", () => {
  const verify = background.slice(
    background.indexOf("async function _verifyProfileMatch("),
    background.indexOf("async function _discoverProfileWindow(")
  );
  assert.doesNotMatch(verify, /browser\.tabs\.create\(/);
  assert.doesNotMatch(verify, /browser\.tabs\.remove\(/);
  assert.match(verify, /browser\.scripting\.executeScript\(/);
  assert.match(verify, /document\.title === marker/);
  assert.match(verify, /rejecting without opening a tab/);
});

test("the server rejects stale workers before they can run the visible-tab verifier", () => {
  assert.match(background, /connect\?verifier=existing-tab-v1&protocol=popup-opener-lease-v2/);
  assert.match(index, /searchParams\.get\("verifier"\) !== "existing-tab-v1"/);
  assert.match(index, /searchParams\.get\("protocol"\) !== EXTENSION_BRIDGE_PROTOCOL/);
  assert.match(index, /const EXTENSION_BRIDGE_PROTOCOL = "popup-opener-lease-v2"/);
  assert.match(index, /res\.writeHead\(426/);
  assert.match(index, /status: "upgrade_required"/);
  const connectRoute = index.slice(
    index.indexOf('req.method === "POST" && req.url.startsWith("/connect")'),
    index.indexOf('// POST /extension-verified')
  );
  assert.ok(
    connectRoute.indexOf("_rememberConnectingHttpWorker(workerId") >
      connectRoute.indexOf('connectUrl.searchParams.get("protocol") !== EXTENSION_BRIDGE_PROTOCOL'),
    "a rejected stale worker must not enter the profile-verification handshake"
  );
});

test("the healthy-worker lease also protects an unscoped bridge", () => {
  const connectRoute = index.slice(
    index.indexOf('req.method === "POST" && req.url.startsWith("/connect")'),
    index.indexOf('// POST /heartbeat')
  );
  const unscoped = connectRoute.slice(connectRoute.indexOf("if (!process.env.SAFARI_PROFILE)"));
  assert.match(unscoped, /_mayReplaceActiveHttpWorker\(workerId, reloadHandoffToken\)/);
  assert.match(unscoped, /status: "worker_lease_held"/);
  assert.match(unscoped, /if \(workerChanged\) \{[\s\S]*_extensionConnectionGeneration \+= 1/);
});

test("a healthy HTTP worker keeps its lease unless reload grants an exact one-shot handoff", () => {
  const helperSource = index.slice(
    index.indexOf("function _prepareReloadHttpWorkerHandoff("),
    index.indexOf("function _requireActiveHttpWorker(")
  );
  const harness = Function("randomBytes", `
    const baseNow = Date.now();
    let _activeHttpWorkerId = "worker-a";
    let _extensionConnected = true;
    let _extensionLastPollTime = baseNow;
    let _extensionLastHeartbeat = 0;
    let _reloadHttpWorkerHandoff = null;
    const _pendingRequests = new Map();
    const _HTTP_RELOAD_HANDOFF_TTL_MS = 30_000;
    ${helperSource}
    return {
      mayReplace: (id, token, now) => _mayReplaceActiveHttpWorker(id, token, now),
      prepare: _prepareReloadHttpWorkerHandoff,
      arm: _armReloadHttpWorkerHandoff,
      cancel: _cancelReloadHttpWorkerHandoff,
      now: baseNow,
      touch: (now) => { _extensionLastPollTime = now; },
      expirePrepared: () => { _reloadHttpWorkerHandoff.expiresAt = baseNow - 1; },
      track: (handoff) => _pendingRequests.set("reload", { reloadHandoff: handoff }),
      untrack: () => _pendingRequests.clear(),
    };
  `)(() => ({ toString: () => "handoff_token_abcdefghijklmnop" }));

  assert.equal(harness.mayReplace("worker-b", "", harness.now + 1), false);
  const handoff = harness.prepare();
  assert.throws(() => harness.prepare(), /already in progress/, "concurrent reload must not replace the first token");
  harness.track(handoff);
  harness.expirePrepared();
  assert.throws(
    () => harness.prepare(),
    /already in progress/,
    "an in-flight command must keep the same handoff object even beyond the successor TTL"
  );
  assert.equal(
    harness.mayReplace("worker-b", handoff.token, harness.now + 1),
    false,
    "a prepared handoff must pin the old worker through a transient liveness gap"
  );
  harness.untrack();
  assert.equal(harness.mayReplace("worker-b", handoff.token, harness.now + 2), false, "prepared is not armed");
  assert.equal(harness.arm(handoff), true);
  assert.equal(harness.mayReplace("worker-b", "wrong_token_abcdefghijklmnop", harness.now + 3), false);
  assert.equal(harness.mayReplace("worker-b", handoff.token, harness.now + 3), true);
  handoff.expiresAt = harness.now - 1;
  assert.equal(harness.mayReplace("worker-a", handoff.token, harness.now + 1), true);
  const retryHandoff = harness.prepare();
  assert.notEqual(retryHandoff, handoff, "an expired armed handoff must not block a same-worker reload retry");
  harness.cancel(retryHandoff);
  const staleTimer = index.slice(
    index.indexOf("const _staleHttpTimer = setInterval("),
    index.indexOf("_staleHttpTimer.unref()")
  );
  assert.match(staleTimer, /pending\.reloadHandoff === _reloadHttpWorkerHandoff/);
  assert.ok(
    staleTimer.indexOf("pending.reloadHandoff === _reloadHttpWorkerHandoff") <
      staleTimer.indexOf("_reloadHttpWorkerHandoff = null"),
    "stale detection must not clear a handoff still owned by a pending reload"
  );
});

test("reload occurs only after the host accepts the result acknowledgement", async () => {
  const executeSource = background.slice(
    background.indexOf("async function executeAndReply("),
    background.indexOf("// ========== COMMAND HANDLERS")
  );
  const events = [];
  let reloadCallback;
  let releaseAck;
  const ack = new Promise((resolve) => { releaseAck = resolve; });
  const harness = Function(
    "handleCommand", "_bridgeFetch", "browser", "chrome", "setTimeout", "HTTP_URL", "console",
    "_stopHeartbeat", "scheduleReconnect",
    `let isConnected = true;
     let _bridgeWorkerRetiring = false;
     let _pollLoopGeneration = 1;
     const connect = () => events.push("connect");
     ${executeSource}; return {
      execute: executeAndReply,
      connected: () => isConnected,
      retiring: () => _bridgeWorkerRetiring,
      generation: () => _pollLoopGeneration,
    };`
  )(
    async () => ({ reloaded: true }),
    async () => { events.push("result-posted"); return ack; },
    { runtime: { reload: () => events.push("reload") } },
    { runtime: { reload: () => events.push("chrome-reload") } },
    (callback) => { events.push("reload-scheduled"); reloadCallback = callback; },
    "http://127.0.0.1:9224",
    { warn: () => {} },
    () => events.push("heartbeat-stopped"),
    () => events.push("reconnect-scheduled")
  );

  const pending = harness.execute({ id: "command-1", type: "reload_extension", payload: {} });
  while (!events.includes("result-posted")) await Promise.resolve();
  assert.deepEqual(events, ["result-posted"], "runtime.reload must wait for the host ACK");
  assert.equal(harness.connected(), true);
  releaseAck({ ok: true, status: 200 });
  await pending;
  assert.equal(harness.connected(), false, "the poll loop must stop before runtime.reload yields");
  assert.equal(harness.retiring(), true, "the old worker must reject reconnects during the reload handoff");
  assert.equal(harness.generation(), 2, "reload retirement must invalidate any waiting connect generation");
  assert.deepEqual(events, ["result-posted", "heartbeat-stopped", "reload-scheduled"]);
  reloadCallback();
  assert.deepEqual(events, ["result-posted", "heartbeat-stopped", "reload-scheduled", "reload"]);
});

test("a rejected reload result never reloads the worker", async () => {
  const executeSource = background.slice(
    background.indexOf("async function executeAndReply("),
    background.indexOf("// ========== COMMAND HANDLERS")
  );
  let reloads = 0;
  const harness = Function(
    "handleCommand", "_bridgeFetch", "browser", "chrome", "setTimeout", "HTTP_URL", "console",
    "_stopHeartbeat", "scheduleReconnect",
    `let isConnected = true; ${executeSource}; return {
      execute: executeAndReply,
      connected: () => isConnected,
    };`
  )(
    async () => ({ reloaded: true }),
    async () => ({ ok: false, status: 409 }),
    { runtime: { reload: () => { reloads += 1; } } },
    { runtime: { reload: () => { reloads += 1; } } },
    (callback) => callback(),
    "http://127.0.0.1:9224",
    { warn: () => {} },
    () => {},
    () => {}
  );
  await harness.execute({ id: "command-2", type: "reload_extension", payload: {} });
  assert.equal(reloads, 0);
  assert.equal(harness.connected(), true, "a rejected ACK must leave the old worker polling");
});

test("the host arms a reload handoff before resolving and acknowledging its result", () => {
  const handlerSource = index.slice(
    index.indexOf("function _handleExtensionResponse("),
    index.indexOf("// Send command to extension")
  );
  const events = [];
  const pending = {
    timer: null,
    reloadHandoff: { token: "handoff" },
    resolve: () => events.push("resolved"),
    reject: () => events.push("rejected"),
  };
  const requests = new Map([["command-1", pending]]);
  const handle = Function(
    "_pendingRequests", "_armReloadHttpWorkerHandoff", "_cancelReloadHttpWorkerHandoff",
    `${handlerSource}; return _handleExtensionResponse;`
  )(
    requests,
    () => { events.push("armed"); return true; },
    () => events.push("cancelled")
  );

  assert.equal(handle({ type: "response", id: "command-1", result: { reloaded: true } }), true);
  assert.deepEqual(events, ["armed", "resolved"]);
  assert.equal(requests.size, 0);
  assert.match(index, /res\.writeHead\(accepted \? 200 : 409\)/);
});

test("lease-held workers retry, while only a poll-time takeover is terminal", () => {
  const connect = background.slice(
    background.indexOf("async function connect("),
    background.indexOf("function scheduleReconnect(")
  );
  const leaseHeld = connect.slice(
    connect.indexOf("verifiedResponse?.status === 423"),
    connect.indexOf("continue;", connect.indexOf("verifiedResponse?.status === 423"))
  );
  assert.match(leaseHeld, /scheduleReconnect\(\)/);
  assert.match(leaseHeld, /_stopHeartbeat\(\)/);
  assert.doesNotMatch(leaseHeld, /_bridgeWorkerSuperseded = true/);

  const polling = background.slice(
    background.indexOf("async function pollForCommands("),
    background.indexOf("async function executeAndReply(")
  );
  assert.match(polling, /res\.status === 423[\s\S]*_bridgeWorkerSuperseded = true/);
  assert.match(polling, /res\.status === 423[\s\S]*_stopHeartbeat\(\)/);
  assert.match(background, /if \(_enabled && !_bridgeWorkerSuperseded && !_bridgeWorkerRetiring && !_heartbeatTimer\) _startHeartbeat\(\)/);
});

test("reconnecting invalidates the old poll loop and clears its exact timeout", async () => {
  const polling = background.slice(
    background.indexOf("async function pollForCommands("),
    background.indexOf("async function executeAndReply(")
  );
  const timers = new Set();
  let timerSequence = 0;
  let fetchCalls = 0;
  const bridgeFetch = async (_url, { signal }) => {
    fetchCalls += 1;
    return await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  const harness = Function(
    "_bridgeFetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "updateBadge", "_stopHeartbeat", "scheduleReconnect", "executeAndReply", "console",
    `let HTTP_URL = "http://127.0.0.1:9224";
     let isConnected = true;
     let _enabled = true;
     let _bridgeWorkerSuperseded = false;
     let _bridgeWorkerRetiring = false;
     let pollAbort = null;
     let _pollLoopGeneration = 1;
     let _commandExecutionTail = Promise.resolve();
     ${polling}
     return {
       run: pollForCommands,
       replace: () => {
         _pollLoopGeneration += 1;
         isConnected = false;
         const previous = pollAbort;
         if (previous) previous.abort();
         isConnected = true;
         return _pollLoopGeneration;
       },
       stop: () => {
         _pollLoopGeneration += 1;
         isConnected = false;
         if (pollAbort) pollAbort.abort();
       },
     };`
  )(
    bridgeFetch,
    () => { const id = ++timerSequence; timers.add(id); return id; },
    (id) => timers.delete(id),
    () => 1,
    () => {},
    () => {},
    () => {},
    () => {},
    async () => {},
    { log: () => {} }
  );

  const oldLoop = harness.run(1);
  while (fetchCalls < 1) await Promise.resolve();
  const nextGeneration = harness.replace();
  const newLoop = harness.run(nextGeneration);
  await oldLoop;
  while (fetchCalls < 2) await Promise.resolve();
  assert.equal(fetchCalls, 2, "the intentional abort must not spawn another old-generation poll");
  assert.equal(timers.size, 1, "only the current fetch may retain a safety timeout");
  harness.stop();
  await newLoop;
  assert.equal(timers.size, 0, "stopping must clear the current fetch timeout too");
});

test("a dequeued command keeps one bridge endpoint and serial execution across generations", () => {
  const polling = background.slice(
    background.indexOf("async function pollForCommands("),
    background.indexOf("async function executeAndReply(")
  );
  const execute = background.slice(
    background.indexOf("async function executeAndReply("),
    background.indexOf("// ========== COMMAND HANDLERS")
  );
  const connect = background.slice(
    background.indexOf("async function connect("),
    background.indexOf("function scheduleReconnect(")
  );
  assert.match(polling, /const bridgeUrl = HTTP_URL/);
  assert.ok(
    polling.indexOf("_commandExecutionTail = previousExecution") < polling.indexOf("await res.json()"),
    "a 200 response must publish its execution claim before body parsing yields"
  );
  assert.match(polling, /`\$\{bridgeUrl\}\/heartbeat`/);
  assert.match(polling, /executeAndReply\(msg, bridgeUrl\)/);
  assert.match(polling, /_commandExecutionTail = previousExecution\.catch\(\(\) => \{\}\)\.then/);
  assert.match(execute, /async function executeAndReply\(msg, bridgeUrl = HTTP_URL\)/);
  assert.match(execute, /`\$\{bridgeUrl\}\/result`/);
  assert.match(connect, /await _commandExecutionTail\.catch\(\(\) => \{\}\)/);
  assert.match(connect, /_bridgeWorkerRetiring/);
});

test("a claimed 200 response blocks reconnect before its JSON body resolves", async () => {
  const polling = background.slice(
    background.indexOf("async function pollForCommands("),
    background.indexOf("async function executeAndReply(")
  );
  let jsonStarted = false;
  let releaseJson;
  const harness = Function(
    "_bridgeFetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "updateBadge", "_stopHeartbeat", "scheduleReconnect", "executeAndReply", "console", "_releaseJson",
    `let HTTP_URL = "http://127.0.0.1:9224";
     let isConnected = true;
     let _enabled = true;
     let _bridgeWorkerSuperseded = false;
     let _bridgeWorkerRetiring = false;
     let pollAbort = null;
     let _pollLoopGeneration = 1;
     let _commandExecutionTail = Promise.resolve();
     ${polling}
     return {
       run: () => pollForCommands(1),
       tail: () => _commandExecutionTail,
       stopWith: (value) => { isConnected = false; _releaseJson(value); },
     };`
  )(
    async () => ({
      status: 200,
      json: async () => {
        jsonStarted = true;
        return await new Promise((resolve) => { releaseJson = resolve; });
      },
    }),
    () => 1,
    () => {},
    () => 1,
    () => {},
    () => {},
    () => {},
    () => {},
    async () => {},
    { log: () => {} },
    (value) => releaseJson(value)
  );
  const loop = harness.run();
  for (let attempt = 0; attempt < 20 && !jsonStarted; attempt += 1) await Promise.resolve();
  assert.equal(jsonStarted, true);
  const settledBeforeJson = await Promise.race([
    harness.tail().then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(settledBeforeJson, false, "connect must observe a pending claim while JSON is unresolved");
  harness.stopWith(null);
  await loop;
  await harness.tail();
});

test("OFF→ON during connect starts one fresh generation after prior command execution", async () => {
  const connectSource = background.slice(
    background.indexOf("let _connecting = false"),
    background.indexOf("function scheduleReconnect(")
  );
  let releaseHandshake;
  let releaseOldCommand;
  let fetchCalls = 0;
  const pollGenerations = [];
  // Wall-clock deadline, not a fixed turn count: the successor's remaining steps are
  // all microtasks, but a loaded parallel suite can starve this loop of scheduler turns
  // long enough for a small fixed budget to expire before they run.
  const waitUntil = async (predicate, message) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(message);
  };
  const bridgeFetch = async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return await new Promise((resolve) => { releaseHandshake = resolve; });
    }
    return { ok: true, json: async () => ({ profile: null }) };
  };
  const harness = Function(
    "_bridgeFetch", "browser", "_storedReloadHandoffToken", "_verifyProfileMatch",
    "_discoverProfileWindow", "updateBadge", "_startHeartbeat", "_stopHeartbeat",
    "scheduleReconnect", "pollForCommands", "AbortSignal",
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
     const _BRIDGE_RELOAD_HANDOFF_KEY = "reload";
     let _commandExecutionTail = new Promise((resolve) => { globalThis.__releaseOldCommand = resolve; });
     ${connectSource}
     return {
       connect,
       offOn: () => {
         _enabled = false;
         _pollLoopGeneration += 1;
         isConnected = false;
         _enabled = true;
         connect();
       },
       state: () => ({ isConnected, generation: _pollLoopGeneration, connecting: _connecting, enabled: _enabled }),
     };`
  )(
    bridgeFetch,
    { storage: { local: {
      get: async () => ({}),
      remove: async () => {},
      set: async () => {},
    } } },
    async () => "",
    async () => true,
    async () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    (generation) => pollGenerations.push(generation),
    AbortSignal
  );
  releaseOldCommand = globalThis.__releaseOldCommand;
  delete globalThis.__releaseOldCommand;

  const first = harness.connect();
  await waitUntil(() => !!releaseHandshake, "the first handshake must start");
  harness.offOn();
  releaseHandshake({ ok: true, json: async () => ({ profile: null }) });
  await first;
  await waitUntil(() => fetchCalls >= 2, "the invalidated attempt must start a fresh handshake");
  assert.deepEqual(pollGenerations, [], "the successor must not poll while an old command still owns execution");
  releaseOldCommand();
  await waitUntil(
    () => pollGenerations.length > 0,
    `the successor must poll after old execution settles: ${JSON.stringify(harness.state())}`
  );
  assert.ok(
    pollGenerations.length > 0,
    `the successor must poll after old execution settles: ${JSON.stringify(harness.state())}`
  );
  assert.equal(fetchCalls, 2, "the dropped ON call must be replaced by one fresh handshake");
  assert.equal(pollGenerations[0], harness.state().generation);
  assert.equal(harness.state().isConnected, true);
});

test("extension reload bypasses all target-tab and receipt resolution", () => {
  const handler = background.slice(
    background.indexOf("async function handleCommand("),
    background.indexOf("// ========== DOM HELPERS")
  );
  const reloadAt = handler.indexOf('if (type === "reload_extension")');
  const receiptAt = handler.indexOf("const suppliedReceipt");
  assert.ok(reloadAt >= 0 && receiptAt > reloadAt);
  assert.match(handler.slice(reloadAt, receiptAt), /_refreshAllReceiptIdentities/);
  assert.match(handler.slice(reloadAt, receiptAt), /_BRIDGE_RELOAD_HANDOFF_KEY/);
  assert.match(handler.slice(reloadAt, receiptAt), /browser\.storage\.local\.set/);
  assert.doesNotMatch(handler.slice(receiptAt), /case "reload_extension"/);

  const routing = index.slice(
    index.indexOf("async function extensionOrFallback("),
    index.indexOf("// Read version from package.json")
  );
  assert.match(
    routing,
    /\["new_tab", "list_tabs", "switch_tab", "reload_extension"\]\.includes\(extensionType\)/,
    "reload must never inherit a stale active-tab receipt"
  );
});

test("a verified profile extension may bypass denied Apple Events", () => {
  assert.match(
    index,
    /_extensionConnected && \(!_preferAppleScript \|\| _profileExtensionVerified\)/,
    "extension routing must unlock only after profile verification"
  );
  const verificationRoute = index.slice(
    index.indexOf('// POST /extension-verified'),
    index.indexOf('// POST /verify-profile')
  );
  assert.match(verificationRoute, /_profileExtensionVerified = true/);
  assert.match(verificationRoute, /profile-verified/);
});

test("new_tab recreates a closed verified-profile window through WebExtension APIs", () => {
  const newTabCase = background.slice(
    background.indexOf("async function _newTabForSession("),
    background.indexOf("async function _closeTabForSession(")
  );
  assert.match(newTabCase, /browser\.windows\.getAll\(\)/);
  assert.match(newTabCase, /browser\.windows\.create\(\{ url: "about:blank", focused: false \}\)/);
  assert.doesNotMatch(index, /SAFARI_PROFILE_WINDOW_OPENER|PROFILE_WINDOW_OPENER/);
  assert.match(index, /_waitForVerifiedProfileExtension\(30000\)/);
  assert.match(index, /refusing AppleScript fallback/);
  const verifier = background.slice(
    background.indexOf("async function _verifyProfileMatch("),
    background.indexOf("async function _discoverProfileWindow(")
  );
  assert.match(verifier, /if \(!allWindows\.length\) return !!expected && storedProfile === expected/);
});

test("a proxy new_tab also restores a closed profile window on the extension host", () => {
  const proxyHandler = index.slice(
    index.indexOf('if (req.method === "POST" && req.url === "/proxy-command")'),
    index.indexOf('res.writeHead(404)')
  );
  const recoveryAt = proxyHandler.indexOf('if (type === "new_tab") await _waitForVerifiedProfileExtension(30000);');
  const sendAt = proxyHandler.indexOf('await sendToExtension(type, commandPayload, timeout)');
  assert.ok(recoveryAt >= 0, "proxy handler must wait for the profile worker for new_tab");
  assert.ok(sendAt > recoveryAt, "profile worker recovery must happen before proxying new_tab");
});

test("profile commands allow a suspended Safari worker to wake", () => {
  const timeouts = index.slice(
    index.indexOf("const _commandTimeouts ="),
    index.indexOf("const _nullMeansFailure")
  );
  for (const command of ["click", "fill", "list_tabs", "new_tab", "close_tab", "press_key"]) {
    assert.match(timeouts, new RegExp(`${command}: 30000`), `${command} must survive Safari's worker wake delay`);
  }
});

test("named-profile commands never fall back to AppleScript", () => {
  const routing = index.slice(
    index.indexOf("async function extensionOrFallback("),
    index.indexOf("// Read version from package.json")
  );
  assert.match(routing, /if \(_preferAppleScript\) throw new Error/);
  assert.match(routing, /if \(_preferAppleScript\) \{[\s\S]*refusing AppleScript fallback/);
  assert.match(routing, /const savedApp = _preferAppleScript \? null/);
  assert.match(
    routing,
    /if \(_preferAppleScript && \(!_extensionConnected \|\| !_profileExtensionVerified\)\) \{[\s\S]*_waitForVerifiedProfileExtension\(30000\)/,
    "a suspended profile worker must get a safe reconnect window before the command is sent"
  );
});

test("secondary instances proxy only to a host with the same Safari profile", () => {
  assert.match(index, /proxy-check\?profile=\$\{profile\}/);
  assert.match(index, /profile !== hostProfile/);
  assert.match(index, /profile: process\.env\.SAFARI_PROFILE \|\| ""/);
});

test("profile workers discover separate bridge ports instead of racing for 9224", () => {
  assert.match(background, /const BRIDGE_PORTS = \[9224, 9228, 9232, 9236\]/);
  assert.match(background, /mcpBridgeUrl/);
  assert.match(background, /trying next bridge/);
  assert.match(index, /SAFARI_MCP_BRIDGE_PORT/);
  assert.match(index, /SAFARI_MCP_BRIDGE_WS_PORT/);
  for (const port of [9224, 9228, 9232, 9236]) {
    assert.match(
      manifest.content_security_policy.extension_pages,
      new RegExp(`http://127\\.0\\.0\\.1:${port}(?:\\s|$)`),
      `extension CSP must allow profile bridge ${port}`
    );
  }
});

test("the isolated command bridge is shipped in both extension targets", () => {
  const commandEntry = manifest.content_scripts.find((entry) =>
    entry.js.includes("command-content.js")
  );
  assert.ok(commandEntry, "manifest must load the isolated command bridge");
  assert.equal(commandEntry.world, undefined, "command bridge must not run in the MAIN page world");
  assert.equal(
    (xcodeProject.match(/command-content\.js in Resources/g) || []).length,
    4,
    "the file needs two build-file declarations and one resource entry per platform target"
  );
});

test("same-tab link clicks navigate from the worker without losing the command result", () => {
  const clickCase = background.slice(
    background.indexOf('case "click":'),
    background.indexOf('case "double_click":')
  );
  assert.match(clickCase, /return "__MCP_NAVIGATE__:" \+ href/);
  assert.match(clickCase, /execInTabIsolated/);
  assert.match(clickCase, /result\.startsWith\("__MCP_NAVIGATE__:"\)/);
  assert.match(clickCase, /await browser\.tabs\.update\(tabId, \{ url: href \}\)/);
  assert.match(clickCase, /await waitForTabLoad\(tabId/);
  assert.match(clickCase, /let from = document\.elementFromPoint\(cx, cy\)/);
  assert.match(clickCase, /const notPrevented = from\.dispatchEvent\(clickEvent\)/);
  assert.match(clickCase, /if \(href && notPrevented && location\.href === beforeUrl/);
  assert.doesNotMatch(clickCase, /location\.href = href/);
  assert.match(background, /world: "ISOLATED"/);
});

test("isolated tab commands retry only Safari's transient access denial", () => {
  const start = background.indexOf("async function execInTabIsolated(");
  const end = background.indexOf("\n}\n\n// Execute in ALL frames", start);
  assert.ok(start > 0 && end > start, "isolated executor should exist");
  const source = background.slice(start, end + 2);
  assert.match(source, /does not have access to this tab/);
  assert.match(source, /Invalid call to scripting\.executeScript/);
  assert.match(source, /if \(!accessIsStillSettling\) throw initialError/);
  assert.match(source, /await sleep\(250\)/);
  assert.equal(
    (source.match(/results = await execute\(\)/g) || []).length,
    2,
    "the executor should make at most one retry"
  );
});

test("target resolution never treats a URL as an ownership capability", () => {
  const resolver = background.slice(
    background.indexOf("async function getTargetTab("),
    background.indexOf("async function getActiveTab(")
  );
  assert.match(resolver, /const ownedIds = _sessionOwnedTabs\.get/);
  assert.match(resolver, /browser\.tabs\.query\(\{ active: true, windowId: winId \}\)/);
  assert.doesNotMatch(resolver, /tabUrl/);
  assert.doesNotMatch(resolver, /\.url\s*===/);
  assert.doesNotMatch(resolver, /Adopt|adopt.*Url|MarkedOwned/i);
  assert.doesNotMatch(background, /function _canAdoptMarkedOwnedTab\(/);
});

test("opaque receipts resolve by token, digest, and original origin and fail closed", async () => {
  const validStart = background.indexOf("function _isValidReceiptRecord(");
  const validEnd = background.indexOf("\n}", validStart);
  const resolveStart = background.indexOf("async function _resolveReceiptTab(");
  const resolveEnd = background.indexOf("\n}\n\nfunction _addOwnedTab", resolveStart);
  assert.ok(validStart > 0 && validEnd > validStart, "receipt record validator should exist");
  assert.ok(resolveStart > 0 && resolveEnd > resolveStart, "receipt resolver should exist");
  const validSource = background.slice(validStart, validEnd + 2);
  const resolveSource = background.slice(resolveStart, resolveEnd + 2);

  const token = "receipt_token_abcdefghijklmnopqrstuvwxyz";
  const digest = "a".repeat(64);
  const makeResolver = ({ tabs, tabId = 42, origin = "https://example.test", owned = false }) => {
    const receiptByToken = new Map([[token, {
      token,
      tabId,
      windowId: 7,
      browserEpoch: BROWSER_EPOCH,
      receiptOrigin: origin,
      identityDigest: digest,
      issuedAt: Date.now(),
    }]]);
    const tokenByTabId = new Map([[tabId, token]]);
    let replacements = 0;
    const resolve = Function(
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
      `${resolveSource}; return _resolveReceiptTab;`
    )(
      receiptByToken,
      Function(`${validSource}; return _isValidReceiptRecord;`)(),
      { tabs: { query: async () => tabs } },
      async () => digest,
      tokenByTabId,
      () => owned,
      async () => {},
      (url) => new URL(url).origin,
      (operation) => operation(),
      async () => BROWSER_EPOCH
    );
    return { resolve, get replacements() { return replacements; } };
  };

  const ownedTab = {
    id: 42,
    windowId: 7,
    url: "https://example.test/path?signature=synthetic#app/route",
  };
  const direct = makeResolver({ tabs: [ownedTab] });
  assert.equal(await direct.resolve(token), ownedTab);
  assert.equal(await direct.resolve("forged_receipt_abcdefghijklmnopqrstuvwxyz"), null);

  const redirected = makeResolver({
    tabs: [{ ...ownedTab, url: "https://other.test/redirected" }],
  });
  assert.equal(await redirected.resolve(token), null, "cross-origin mutation authority must fail");
  assert.equal(
    (await redirected.resolve(token, { allowOriginChange: true }))?.id,
    42,
    "origin changes are allowed only for the locator-only receipt rotation path"
  );

  const ambiguous = makeResolver({
    tabs: [
      { id: 84, windowId: 7, url: "https://example.test/same" },
      { id: 85, windowId: 8, url: "https://example.test/same" },
    ],
  });
  assert.equal(await ambiguous.resolve(token), null, "two digest matches must never be guessed");
  assert.equal(ambiguous.replacements, 0, "ambiguous receipts must not rebind ownership");
});

test("V3 receipts persist with a browser epoch and survive worker suspension safely", () => {
  assert.match(background, /const _TAB_RECEIPTS_KEY = "mcpOwnedTabReceiptsV3"/);
  assert.match(background, /const _TAB_RECEIPTS_VERSION = 3/);
  assert.match(background, /const _BROWSER_SESSION_EPOCH_KEY = "mcpBrowserSessionEpochV1"/);
  const hydrate = background.slice(
    background.indexOf("async function _hydrateOwnedTabs("),
    background.indexOf("async function _persistOwnedTabs(")
  );
  assert.match(hydrate, /browser\.storage\.local\.get\(_TAB_RECEIPTS_KEY\)/);
  assert.match(hydrate, /receiptEnvelope\.version === _TAB_RECEIPTS_VERSION/);
  assert.match(hydrate, /receiptEnvelope\.browserEpoch === browserEpoch/);
  assert.match(hydrate, /_resolveHydratedReceiptTab\(/);
  assert.match(hydrate, /if \(!resolved\) continue/);
  assert.match(hydrate, /const claimedTabIds = new Set\(\)/);
  assert.match(hydrate, /validatedIds\.get\(oldId\)/);

  const persist = background.slice(
    background.indexOf("async function _persistOwnedTabs("),
    background.indexOf("function _extractMcpTabMarker(")
  );
  assert.match(persist, /version: _TAB_RECEIPTS_VERSION/);
  assert.match(persist, /browserEpoch/);
  assert.match(persist, /records: \[\.\.\._receiptByToken\.values\(\)\]/);
  assert.match(persist, /browser\.storage\.local\.set\(\{/);
  assert.match(persist, /\[_TAB_RECEIPTS_KEY\]: receiptEnvelope/);

  const handler = background.slice(
    background.indexOf("async function handleCommand("),
    background.indexOf("// ========== TAB OWNERSHIP GUARD")
  );
  assert.ok(
    handler.indexOf("await _hydrateOwnedTabs();") < handler.indexOf("await getTargetTab("),
    "receipt records must hydrate before any target is selected"
  );

  const ensureEpoch = background.slice(
    background.indexOf("async function _ensureBrowserSessionEpoch("),
    background.indexOf("async function _hydrateOwnedTabs(")
  );
  assert.match(ensureEpoch, /browser\.storage\.session\.get\(_BROWSER_SESSION_EPOCH_KEY\)/);
  assert.match(ensureEpoch, /browser\.storage\.session\.set\(\{ \[_BROWSER_SESSION_EPOCH_KEY\]: epoch \}\)/);
  assert.doesNotMatch(ensureEpoch, /browser\.storage\.local/);
  assert.doesNotMatch(background, /runtime\.onStartup\.addListener/);
});

test("new_tab navigates with the caller's exact raw URL and returns only safe metadata", async () => {
  const newTabCase = background.slice(
    background.indexOf("async function _newTabForSession("),
    background.indexOf("async function _closeTabForSession(")
  );
  assert.doesNotMatch(newTabCase, /await waitForTabLoad\(newTab\.id/);
  assert.match(newTabCase, /await _waitForNavigatedTab\(newTab\.id\)/);
  assert.match(newTabCase, /const rawNavigationUrl = String\(payload\.url \|\| ""\)/);
  assert.match(newTabCase, /_issueTabReceipt\(receiptTab, \{/);
  assert.match(newTabCase, /await browser\.tabs\.update\(newTab\.id, \{ url: rawNavigationUrl \}\)\.catch/);

  let navigatedUrl = null;
  let ownedTabId = null;
  let rejectNavigation = false;
  let receiptCalls = 0;
  const issuedReceipt = "issued_receipt_abcdefghijklmnopqrstuvwxyz";
  const newTabForSession = Function(
    "_DEFAULT_SESSION",
    "_sessionWindowIds",
    "_windowForSession",
    "browser",
    "_profileWindowId",
    "_adoptWindowForSession",
    "_setSessionTab",
    "_addOwnedTab",
    "_issueTabReceipt",
    "_waitForNavigatedTab",
    "_receiptOrigin",
    "_safeTabUrl",
    `${newTabCase}; return _newTabForSession;`
  )(
    "default",
    new Map([["session-a", 7]]),
    () => 7,
    {
      windows: {
        get: async () => ({ id: 7 }),
        getAll: async () => [{ id: 7 }],
        create: async () => { throw new Error("unexpected window creation"); },
      },
      tabs: {
        create: async (options) => ({
          id: 42,
          index: 2,
          windowId: options.windowId,
          url: options.url,
          title: "",
        }),
        update: async (_tabId, options) => {
          if (rejectNavigation) throw new Error("navigation rejected");
          navigatedUrl = options.url;
          return { id: 42, index: 2, windowId: 7, url: options.url, title: "" };
        },
        query: async () => [],
      },
      storage: { local: { set: async () => {} } },
    },
    7,
    () => {},
    () => {},
    async (_sessionId, tabId) => { ownedTabId = tabId; },
    async () => { receiptCalls += 1; return issuedReceipt; },
    async () => ({ id: 42, index: 2, windowId: 7, url: exactUrl, title: "" }),
    (url) => new URL(url).origin,
    (url) => {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname;
    }
  );
  const exactUrl = "https://example.test/p?X-Signature=ab%2fCD%2Bef&x=a%20b&dup=1&dup=2#/route?next=%2F";
  const result = await newTabForSession("session-a", { url: exactUrl });
  await Promise.resolve();
  assert.equal(navigatedUrl, exactUrl, "signed query and application fragment bytes must be untouched");
  assert.equal(ownedTabId, 42);
  assert.deepEqual(result, {
    title: "",
    safeUrl: "https://example.test/p",
    receipt: issuedReceipt,
    tabIndex: 3,
  });
  assert.equal("url" in result, false);
  assert.equal("requestedUrl" in result, false);
  assert.equal(receiptCalls, 1);

  rejectNavigation = true;
  await assert.rejects(
    newTabForSession("session-a", { url: "https://example.test/rejected" }),
    /did not accept the new tab navigation/
  );
  assert.equal(receiptCalls, 1, "a rejected nonblank navigation must not publish an about:blank receipt");
});

test("new_tab waits out Safari's transient about:blank before minting a receipt", async () => {
  const helperSource = background.slice(
    background.indexOf("async function _waitForNavigatedTab("),
    background.indexOf("async function _newTabForSession(")
  );
  const reads = [
    { id: 42, windowId: 7, url: "about:blank" },
    { id: 42, windowId: 7, url: "https://example.test/path?private=value" },
  ];
  const waitForNavigatedTab = Function(
    "browser", "_receiptOrigin", "setTimeout",
    `${helperSource}; return _waitForNavigatedTab;`
  )(
    { tabs: { get: async () => reads.shift() || null } },
    (url) => {
      if (url === "about:blank") return "about:blank";
      try { return new URL(url).origin; } catch { return ""; }
    },
    (callback) => { callback(); return 1; }
  );

  const live = await waitForNavigatedTab(42, 100);
  assert.equal(live.url, "https://example.test/path?private=value");
  assert.equal(reads.length, 0, "a live read, not tabs.update's optimistic object, must bind the receipt");
});

test("switch_tab resolves a valid receipt globally and ignores a stale window-local index", async () => {
  const switchTabCase = background.slice(
    background.indexOf("async function _switchTabForSession("),
    background.indexOf("let _enabled", background.indexOf("async function _switchTabForSession("))
  );
  assert.match(switchTabCase, /target = targetTab/);
  assert.match(switchTabCase, /receipt is the authority/);
  assert.match(switchTabCase, /await _addOwnedTab\(sessionId, target\.id\)/);
  assert.match(switchTabCase, /safeUrl: _safeTabUrl\(target\.url\)/);
  assert.match(switchTabCase, /tabIndex: target\.index \+ 1/);
  assert.doesNotMatch(switchTabCase, /browser\.tabs\.update|browser\.windows\.update/);
  assert.doesNotMatch(switchTabCase, /_issueTabReceipt/);
  assert.doesNotMatch(switchTabCase, /\burl:\s*target\.url/);

  const makeSwitch = (tabs, additions, queries = []) => Function(
    "_receiptTokenFromPayload",
    "_windowForSession",
    "_windowQuery",
    "browser",
    "_isTabOwnedBySession",
    "_addOwnedTab",
    "_safeTabUrl",
    "_adoptWindowForSession",
    "_setSessionTab",
    "_receiptForOwnedTab",
    `${switchTabCase}; return _switchTabForSession;`
  )(
    (payload) => payload.receipt || "",
    () => 7,
    (windowId) => ({ windowId }),
    { tabs: { query: async (query) => { queries.push(query); return tabs; } } },
    () => false,
    async (_sessionId, tabId) => additions.push(tabId),
    (url) => {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname;
    },
    () => {},
    () => {},
    () => "rotated_receipt_abcdefghijklmnopqrstuvwxyz"
  );

  const receiptTab = {
    id: 42,
    index: 0,
    windowId: 9,
    title: "Owned",
    url: "https://example.test/path?private=value#app",
  };
  const additions = [];
  const switchValid = makeSwitch([receiptTab], additions);
  const result = await switchValid("session-a", receiptTab, {
    index: 1,
    receipt: "receipt_token_abcdefghijklmnopqrstuvwxyz",
  });
  assert.deepEqual(additions, [42]);
  assert.deepEqual(result, {
    title: "Owned",
    safeUrl: "https://example.test/path",
    receipt: "rotated_receipt_abcdefghijklmnopqrstuvwxyz",
    tabIndex: 1,
    owned: true,
  });
  assert.equal("url" in result, false);

  const crossWindowQueries = [];
  const switchAcrossWindows = makeSwitch([{ ...receiptTab, id: 99 }], [], crossWindowQueries);
  const crossWindowResult = await switchAcrossWindows("session-a", receiptTab, {
    index: 7,
    receipt: "receipt_token_abcdefghijklmnopqrstuvwxyz",
  });
  assert.equal(crossWindowResult.safeUrl, "https://example.test/path");
  assert.deepEqual(crossWindowQueries, [], "receipt switching must not reinterpret index in any window");
});

test("getReceipt prefers the session's exact owned tab across windows after redirect", async () => {
  const helper = background.slice(
    background.indexOf("async function _getReceiptTargetTab("),
    background.indexOf("async function getTargetTab(", background.indexOf("async function _getReceiptTargetTab("))
  );
  assert.match(helper, /_isTabOwnedBySession\(sid, cache\.tabId\)/);
  assert.match(helper, /browser\.tabs\.get\(cache\.tabId\)/);
  assert.match(helper, /_adoptWindowForSession\(sid, cached\.windowId\)/);
  assert.doesNotMatch(helper, /_addOwnedTab|_issueTabReceipt|tabs\.query|url\s*===/);

  const cache = {
    tabId: 88,
    tabUrl: "https://accounts.example.test/chooser",
    time: 1,
  };
  const owned = new Set([11, 88]);
  const adopted = [];
  const targeted = [];
  let fallbackCalls = 0;
  const getReceiptTarget = Function(
    "_DEFAULT_SESSION",
    "_getSessionCache",
    "_isTabOwnedBySession",
    "browser",
    "_adoptWindowForSession",
    "_setSessionTab",
    "_sessionOwnedTabs",
    "getTargetTab",
    `${helper}; return _getReceiptTargetTab;`
  )(
    "__default__",
    () => cache,
    (sessionId, tabId) => sessionId === "session-a" && owned.has(tabId),
    {
      tabs: {
        get: async (tabId) => ({
          id: tabId,
          windowId: tabId === 88 ? 9 : 7,
          url: tabId === 88
            ? "https://affiliate.example.test/oauth/callback?private=1"
            : "https://affiliate.example.test/form",
        }),
      },
    },
    (_sessionId, windowId) => adopted.push(windowId),
    (_sessionId, tabId) => targeted.push(tabId),
    new Map([["session-a", owned]]),
    async () => { fallbackCalls += 1; return null; }
  );

  const result = await getReceiptTarget("session-a");
  assert.equal(result.id, 88);
  assert.equal(result.windowId, 9, "the already-owned OAuth tab may live outside the old window");
  assert.deepEqual(adopted, [9]);
  assert.deepEqual(targeted, [88]);
  assert.equal(fallbackCalls, 0, "an owned session tab must win over current/active-window fallback");

  const handle = background.slice(
    background.indexOf("async function handleCommand("),
    background.indexOf("// ========== HELPERS ==========", background.indexOf("async function handleCommand("))
  );
  assert.match(handle, /type === "get_tab_receipt"[\s\S]*_getReceiptTargetTab\(sessionId\)/);
});

test("public switch_tab forwards an opaque receipt and sanitizes extension output", () => {
  const switchTabTool = index.slice(
    index.indexOf('"safari_switch_tab"'),
    index.indexOf("// ========== WAIT ==========", index.indexOf('"safari_switch_tab"'))
  );
  assert.match(switchTabTool, /index:\s*z\.coerce\.number\(\)\.optional\(\)/);
  assert.match(switchTabTool, /receipt:\s*z\.string\(\)\.optional\(\)/);
  assert.match(switchTabTool, /async \(\{ index, receipt, url \}\) =>/);
  assert.match(switchTabTool, /const token = _receiptToken\(supplied\)/);
  assert.match(switchTabTool, /"switch_tab", token \? \{ \.\.\.\(index \? \{ index \} : \{\}\), receipt: token \} : \{ index \}/);
  assert.match(switchTabTool, /const safeResult = _sanitizeTabResult\(result\)/);
  assert.match(switchTabTool, /safeResult\?\.tabIndex \|\| index/);
  assert.doesNotMatch(switchTabTool, /tabUrl:/);
});
