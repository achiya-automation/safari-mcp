import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const content = readFileSync(new URL("../extension/command-content.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(
  readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8")
);

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function keepaliveSource() {
  return sourceBetween(
    content,
    "(() => {\n  const previousKeepaliveState = globalThis.__mcpKeepaliveState;",
    "\n\n(() => {\n  const previousCommandState = globalThis.__mcpContentCommandState;"
  );
}

test("Safari uses a wakeable nonpersistent background page", () => {
  assert.deepEqual(manifest.background, {
    scripts: ["background.js"],
    persistent: false,
  });
  assert.equal(Object.hasOwn(manifest.background, "service_worker"), false);
});

function createContentHarness({
  visibility = "hidden",
  lease = null,
  enabled = true,
  deferFirstGet = false,
  runtimeMessageMode = "resolve",
  wakeToken = "",
  bridgeUrl = "",
} = {}) {
  let now = 1_000_000;
  let timerId = 0;
  let randomByte = 0;
  const timers = new Map();
  const ports = [];
  const runtimeMessages = [];
  const wakeRequests = [];
  const wakeResolvers = [];
  const documentListeners = new Set();
  const storageListeners = new Set();
  let deferredGetUsed = false;
  let resolveDeferredGet = null;
  const store = {
    mcpEnabled: enabled,
    ...(lease ? { mcpContentKeepaliveLeaseV1: lease } : {}),
    ...(wakeToken ? { mcpContentWakeTokenV1: wakeToken } : {}),
    ...(bridgeUrl ? { mcpBridgeUrl: bridgeUrl } : {}),
  };
  const document = {
    visibilityState: visibility,
    addEventListener(type, listener) {
      if (type === "visibilitychange") documentListeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "visibilitychange") documentListeners.delete(listener);
    },
  };
  const window = {};
  window.top = window;

  function emitStorage(changes) {
    for (const listener of [...storageListeners]) listener(changes, "local");
  }

  function storageGet(keys) {
    const requested = Array.isArray(keys) ? keys : [keys];
    const result = Object.fromEntries(
      requested.filter((key) => Object.hasOwn(store, key)).map((key) => [key, store[key]])
    );
    if (deferFirstGet && !deferredGetUsed) {
      deferredGetUsed = true;
      return new Promise((resolve) => {
        resolveDeferredGet = () => resolve(result);
      });
    }
    return Promise.resolve(result);
  }

  function makePort() {
    const disconnectListeners = [];
    const messages = [];
    let disconnected = false;
    const port = {
      messages,
      onDisconnect: {
        addListener(listener) {
          disconnectListeners.push(listener);
        },
      },
      postMessage(message) {
        if (disconnected) throw new Error("disconnected");
        messages.push(message);
      },
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        for (const listener of disconnectListeners) listener();
      },
      drop() {
        if (disconnected) return;
        disconnected = true;
        for (const listener of disconnectListeners) listener();
      },
    };
    ports.push(port);
    return port;
  }

  const math = Object.create(Math);
  math.random = () => 0;
  const context = vm.createContext({
    browser: {
      runtime: {
        connect: () => makePort(),
        sendMessage(message) {
          runtimeMessages.push(message);
          if (runtimeMessageMode === "throw") throw new Error("runtime invalidated");
          if (runtimeMessageMode === "reject") return Promise.reject(new Error("tab unavailable"));
          return Promise.resolve({ ok: true });
        },
      },
      storage: {
        local: {
          get: storageGet,
          async set(values) {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
              changes[key] = { oldValue: store[key], newValue: value };
              store[key] = value;
            }
            emitStorage(changes);
          },
          async remove(key) {
            if (!Object.hasOwn(store, key)) return;
            const oldValue = store[key];
            delete store[key];
            emitStorage({ [key]: { oldValue, newValue: undefined } });
          },
        },
        onChanged: {
          addListener(listener) {
            storageListeners.add(listener);
          },
          removeListener(listener) {
            storageListeners.delete(listener);
          },
        },
      },
    },
    crypto: {
      getRandomValues(bytes) {
        randomByte += 1;
        bytes.fill(randomByte);
        return bytes;
      },
    },
    Uint8Array,
    Array,
    Number,
    Math: math,
    Date: { now: () => now },
    Promise,
    URL,
    AbortController,
    fetch(url, init) {
      wakeRequests.push({ url, init });
      return new Promise((resolve) => wakeResolvers.push(resolve));
    },
    document,
    window,
    setTimeout(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, delay, dueAt: now + Number(delay || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });

  function runNextTimer() {
    const next = [...timers.entries()].sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
    assert.ok(next, "expected a scheduled timer");
    timers.delete(next[0]);
    now = next[1].dueAt;
    next[1].fn();
    return next[1].delay;
  }

  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    context,
    document,
    documentListeners,
    storageListeners,
    store,
    ports,
    runtimeMessages,
    wakeRequests,
    timers,
    runNextTimer,
    flush,
    resolveWake(status = 204) {
      const resolve = wakeResolvers.shift();
      assert.ok(resolve, "expected a pending content wake request");
      resolve({ status });
    },
    resolveDeferredGet() {
      assert.ok(resolveDeferredGet, "expected a deferred storage read");
      const resolve = resolveDeferredGet;
      resolveDeferredGet = null;
      resolve();
    },
    setVisibility(value) {
      document.visibilityState = value;
      for (const listener of [...documentListeners]) listener();
    },
    setEnabled(value) {
      const oldValue = store.mcpEnabled;
      store.mcpEnabled = value;
      emitStorage({ mcpEnabled: { oldValue, newValue: value } });
    },
  };
}

test("keepalive uses one authority-free Port inside Safari's idle window", () => {
  const keepalive = keepaliveSource();
  assert.match(keepalive, /const _MCP_KEEPALIVE_LEASE_MS = 26000/);
  assert.match(keepalive, /const _MCP_KEEPALIVE_RENEW_MS = 18000/);
  assert.match(keepalive, /const _MCP_KEEPALIVE_PING_MS = 8000/);
  assert.match(keepalive, /window\.top === window/);
  assert.match(keepalive, /document\.visibilityState === "visible"/);
  assert.match(keepalive, /browser\.runtime\.connect\(\{ name: _MCP_KEEPALIVE_PORT_NAME \}\)/);
  assert.match(keepalive, /port\.postMessage\(\{ type: "ping" \}\)/);
  assert.match(
    keepalive,
    /browser\.runtime\.sendMessage\(\{ action: "mcpContentKeepalivePingV1" \}\)/
  );
  assert.doesNotMatch(keepalive, /location\.|receiptUrl|sessionId|tabId/);
});

test("a hidden non-leader opens no Port, then visible safely preempts a hidden lease", async () => {
  const harness = createContentHarness({
    visibility: "hidden",
    lease: { id: "a".repeat(24), expiresAt: 1_020_000, visible: false },
  });
  vm.runInContext(keepaliveSource(), harness.context);
  await harness.flush();
  assert.equal(harness.ports.length, 0, "hidden non-leader must not create a Port");

  harness.setVisibility("visible");
  await harness.flush();
  harness.runNextTimer(); // immediate visible-priority claim
  await harness.flush();
  harness.runNextTimer(); // settle the storage election
  await harness.flush();

  assert.equal(harness.ports.length, 1);
  assert.equal(JSON.stringify(harness.ports[0].messages), JSON.stringify([{ type: "ping" }]));
  assert.equal(
    JSON.stringify(harness.runtimeMessages),
    JSON.stringify([{ action: "mcpContentKeepalivePingV1" }]),
    "the elected page must also wake Safari's worker with an authority-free message"
  );
  assert.equal(harness.store.mcpContentKeepaliveLeaseV1.visible, true);

  harness.ports[0].drop();
  assert.equal(harness.runNextTimer(), 1500, "a dropped worker Port must reconnect promptly");
  await harness.flush();
  assert.equal(harness.ports.length, 2);
  assert.equal(JSON.stringify(harness.ports[1].messages), JSON.stringify([{ type: "ping" }]));
});

test("a stale startup read cannot overwrite a newer OFF event", async () => {
  const harness = createContentHarness({ visibility: "visible", deferFirstGet: true });
  vm.runInContext(keepaliveSource(), harness.context);
  await harness.flush();
  harness.setEnabled(false);
  harness.resolveDeferredGet();
  await harness.flush();

  assert.equal(harness.ports.length, 0);
  assert.equal(harness.timers.size, 0);
});

test("same-context reinjection replaces keepalive state instead of duplicating it", async () => {
  const harness = createContentHarness({ visibility: "visible", deferFirstGet: true });
  const source = keepaliveSource();
  vm.runInContext(source, harness.context);
  await harness.flush();
  vm.runInContext(source, harness.context);
  await harness.flush();

  assert.equal(harness.documentListeners.size, 1);
  assert.equal(harness.storageListeners.size, 1);
  assert.equal(harness.ports.length, 0);

  harness.runNextTimer();
  await harness.flush();
  harness.runNextTimer();
  await harness.flush();
  assert.equal(harness.ports.length, 1, "only the replacement leader may own a Port");
  assert.equal(harness.runtimeMessages.length, 1, "only the replacement leader may send a wakeup");
  const successorLease = JSON.stringify(harness.store.mcpContentKeepaliveLeaseV1);

  // The first execution's startup read resolves only after cleanup and after the
  // successor owns the lease. Its disposed continuation must remain inert.
  harness.resolveDeferredGet();
  await harness.flush();
  assert.equal(harness.documentListeners.size, 1);
  assert.equal(harness.storageListeners.size, 1);
  assert.equal(harness.ports.length, 1);
  assert.equal(JSON.stringify(harness.store.mcpContentKeepaliveLeaseV1), successorLease);
});

for (const runtimeMessageMode of ["throw", "reject"]) {
  test(`runtime wakeup ${runtimeMessageMode} does not stop Port ping or scheduling`, async () => {
    const harness = createContentHarness({ visibility: "visible", runtimeMessageMode });
    vm.runInContext(keepaliveSource(), harness.context);
    await harness.flush();
    harness.runNextTimer();
    await harness.flush();
    harness.runNextTimer();
    await harness.flush();

    assert.equal(harness.runtimeMessages.length, 1);
    assert.equal(harness.ports.length, 1);
    assert.equal(JSON.stringify(harness.ports[0].messages), JSON.stringify([{ type: "ping" }]));
    assert.equal(
      [...harness.timers.values()].filter(({ delay }) => delay === 8000).length,
      1,
      "one future runtime/Port ping must remain scheduled"
    );
  });
}

test("the elected page holds one authenticated network wake poll without URL authority", async () => {
  const wakeToken = "b".repeat(64);
  const harness = createContentHarness({
    visibility: "visible",
    wakeToken,
    bridgeUrl: "http://127.0.0.1:9224",
  });
  vm.runInContext(keepaliveSource(), harness.context);
  await harness.flush();
  harness.runNextTimer();
  await harness.flush();
  harness.runNextTimer();
  await harness.flush();

  assert.equal(harness.wakeRequests.length, 1);
  assert.equal(harness.wakeRequests[0].url, "http://127.0.0.1:9224/content-wakeup");
  assert.equal(harness.wakeRequests[0].init.headers["X-Safari-MCP-Wakeup"], wakeToken);
  assert.equal(harness.wakeRequests[0].init.method, undefined);
  assert.equal(harness.runtimeMessages.length, 1, "the initial leader ping is still singular");

  harness.resolveWake();
  await harness.flush();
  assert.equal(harness.runtimeMessages.length, 2, "network completion wakes the background");
  assert.equal(harness.wakeRequests.length, 2, "the next long poll starts without a page timer");
});

test("background accepts one exact named content-script Port and no authority", () => {
  const listenerSource = sourceBetween(
    background,
    'const _CONTENT_KEEPALIVE_PORT_NAME = "mcp-content-keepalive-v1";',
    "// ========== BADGE =========="
  );
  let onConnect;
  const context = {
    browser: {
      runtime: {
        onConnect: {
          addListener(listener) {
            onConnect = listener;
          },
        },
      },
    },
    Number,
    _enabled: true,
    _bridgeWorkerSuperseded: false,
    _bridgeWorkerRetiring: false,
  };
  vm.runInNewContext(
    `${listenerSource}\nglobalThis.__disconnectContentKeepalivePort = _disconnectContentKeepalivePort;`,
    context
  );

  const makePort = (name, sender) => {
    const messageListeners = [];
    const disconnectListeners = [];
    let disconnected = false;
    return {
      name,
      sender,
      onMessage: {
        addListener(listener) {
          messageListeners.push(listener);
        },
      },
      onDisconnect: {
        addListener(listener) {
          disconnectListeners.push(listener);
        },
      },
      disconnect() {
        disconnected = true;
        for (const listener of disconnectListeners) listener();
      },
      get disconnected() {
        return disconnected;
      },
      messageListeners,
    };
  };

  const first = makePort("mcp-content-keepalive-v1", { tab: { id: 42 } });
  onConnect(first);
  assert.equal(first.messageListeners.length, 1);
  assert.equal(first.messageListeners[0]({ type: "ping", receipt: "ignored" }), undefined);

  const duplicate = makePort("mcp-content-keepalive-v1", { tab: { id: 43 } });
  onConnect(duplicate);
  assert.equal(duplicate.disconnected, true);
  assert.equal(duplicate.messageListeners.length, 0);

  context.__disconnectContentKeepalivePort();
  assert.equal(first.disconnected, true, "retirement must release the old singleton Port");
  const successor = makePort("mcp-content-keepalive-v1", { tab: { id: 43 } });
  onConnect(successor);
  assert.equal(successor.messageListeners.length, 1);

  const wrongName = makePort("other", { tab: { id: 42 } });
  onConnect(wrongName);
  assert.equal(wrongName.messageListeners.length, 0);

  const extensionPage = makePort("mcp-content-keepalive-v1", {});
  onConnect(extensionPage);
  assert.equal(extensionPage.messageListeners.length, 0);

  context._enabled = false;
  const whileOff = makePort("mcp-content-keepalive-v1", { tab: { id: 44 } });
  onConnect(whileOff);
  assert.equal(whileOff.disconnected, true);
  assert.equal(whileOff.messageListeners.length, 0);
});

test("background accepts only a page-bound authority-free keepalive message", () => {
  const listenerSource = sourceBetween(
    background,
    "// Listen for messages from popup",
    "// A page-bound isolated content script sends an authority-free ping"
  );
  let onMessage;
  const context = {
    browser: {
      runtime: {
        onMessage: {
          addListener(listener) {
            onMessage = listener;
          },
        },
      },
    },
    Number,
    _enabled: true,
    _bridgeWorkerSuperseded: false,
    _bridgeWorkerRetiring: false,
    // The ping also nudges a backed-off worker to reconnect; a connected worker stays put.
    isConnected: true,
    _connecting: false,
    _reconnectTimer: null,
    connect() { throw new Error("connected worker must not reconnect on a ping"); },
  };
  vm.runInNewContext(listenerSource, context);

  let reply = null;
  const returned = onMessage(
    { action: "mcpContentKeepalivePingV1" },
    { tab: { id: 42 } },
    (value) => {
      reply = value;
    }
  );
  assert.equal(returned, false);
  assert.equal(JSON.stringify(reply), JSON.stringify({ ok: true }));

  reply = null;
  onMessage(
    { action: "mcpContentKeepalivePingV1", receipt: "forbidden" },
    { tab: { id: 42 } },
    (value) => {
      reply = value;
    }
  );
  assert.equal(reply, null, "keepalive messages with extra fields must be rejected");

  reply = null;
  onMessage({ action: "mcpContentKeepalivePingV1" }, {}, (value) => {
    reply = value;
  });
  assert.equal(reply, null, "extension pages must not use the page-bound keepalive path");

  context._bridgeWorkerRetiring = true;
  reply = null;
  onMessage({ action: "mcpContentKeepalivePingV1" }, { tab: { id: 42 } }, (value) => {
    reply = value;
  });
  assert.equal(reply, null, "retiring workers must reject keepalive messages");
});

test("a 423 superseded worker releases its content keepalive Port", () => {
  const polling = sourceBetween(
    background,
    "async function pollForCommands(",
    "// ========== SHARED: Execute command and send response"
  );
  const superseded = sourceBetween(polling, "if (res.status === 423)", "if (res.status === 401");
  assert.match(superseded, /_bridgeWorkerSuperseded = true/);
  assert.match(superseded, /_disconnectContentKeepalivePort\(\)/);
});
