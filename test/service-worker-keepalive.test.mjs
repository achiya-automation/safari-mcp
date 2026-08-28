import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const content = readFileSync(new URL("../extension/command-content.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

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
    "\n\nbrowser.runtime.onMessage.addListener"
  );
}

function createContentHarness({
  visibility = "hidden",
  lease = null,
  enabled = true,
  deferFirstGet = false,
} = {}) {
  let now = 1_000_000;
  let timerId = 0;
  let randomByte = 0;
  const timers = new Map();
  const ports = [];
  const documentListeners = new Set();
  const storageListeners = new Set();
  let deferredGetUsed = false;
  let resolveDeferredGet = null;
  const store = {
    mcpEnabled: enabled,
    ...(lease ? { mcpContentKeepaliveLeaseV1: lease } : {}),
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
      runtime: { connect: () => makePort() },
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
    timers,
    runNextTimer,
    flush,
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
