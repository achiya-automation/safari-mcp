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

test("content keepalive uses an authority-free Port inside Safari's idle window", () => {
  const keepalive = sourceBetween(
    content,
    'const _MCP_KEEPALIVE_PORT_NAME = "mcp-content-keepalive-v1";',
    "browser.runtime.onMessage.addListener"
  );

  assert.match(keepalive, /const _MCP_KEEPALIVE_INTERVAL_MS = 10000/);
  assert.match(keepalive, /browser\.runtime\.connect\(\{ name: _MCP_KEEPALIVE_PORT_NAME \}\)/);
  assert.match(keepalive, /port\.postMessage\(\{ type: "ping" \}\)/);
  assert.match(keepalive, /port\.onDisconnect\.addListener/);
  assert.match(keepalive, /const _MCP_KEEPALIVE_RECONNECT_MS = 1500/);
  assert.doesNotMatch(keepalive, /location|document|receipt|session|tabId|url:/i);
});

test("content keepalive reconnects after a dropped worker and respects OFF", async () => {
  const keepalive = sourceBetween(
    content,
    'const _MCP_KEEPALIVE_PORT_NAME = "mcp-content-keepalive-v1";',
    "browser.runtime.onMessage.addListener"
  );
  const intervals = [];
  const timeouts = [];
  const ports = [];
  let enabled = true;

  function makePort() {
    let disconnectListener = null;
    const messages = [];
    const port = {
      messages,
      onDisconnect: { addListener(listener) { disconnectListener = listener; } },
      postMessage(message) { messages.push(message); },
      disconnect() { if (disconnectListener) disconnectListener(); },
      drop() { if (disconnectListener) disconnectListener(); },
    };
    ports.push(port);
    return port;
  }

  const context = {
    browser: {
      runtime: { connect: () => makePort() },
      storage: { local: { get: async () => ({ mcpEnabled: enabled }) } },
    },
    setInterval(fn, delay) { intervals.push({ fn, delay }); return intervals.length; },
    setTimeout(fn, delay) { timeouts.push({ fn, delay }); return timeouts.length; },
    clearTimeout() {},
  };
  vm.runInNewContext(keepalive, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ports.length, 1);
  assert.equal(JSON.stringify(ports[0].messages), JSON.stringify([{ type: "ping" }]));
  assert.equal(intervals[0].delay, 10000);

  ports[0].drop();
  assert.equal(timeouts.at(-1).delay, 1500);
  timeouts.at(-1).fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ports.length, 2);
  assert.equal(JSON.stringify(ports[1].messages), JSON.stringify([{ type: "ping" }]));

  enabled = false;
  await intervals[0].fn();
  assert.equal(ports.length, 2, "OFF must not open another keepalive Port");
});

test("background accepts keepalive only from an exact named content-script tab", () => {
  const listenerSource = sourceBetween(
    background,
    'const _CONTENT_KEEPALIVE_PORT_NAME = "mcp-content-keepalive-v1";',
    "// ========== BADGE =========="
  );
  let onConnect;
  const context = {
    browser: {
      runtime: { onConnect: { addListener(listener) { onConnect = listener; } } },
    },
    Number,
  };
  vm.runInNewContext(listenerSource, context);

  const makePort = (name, sender) => {
    const listeners = [];
    return {
      name,
      sender,
      onMessage: { addListener(listener) { listeners.push(listener); } },
      listeners,
    };
  };

  const valid = makePort("mcp-content-keepalive-v1", { tab: { id: 42 } });
  onConnect(valid);
  assert.equal(valid.listeners.length, 1);
  assert.equal(valid.listeners[0]({ type: "ping", receipt: "must-be-ignored" }), undefined);

  const wrongName = makePort("other", { tab: { id: 42 } });
  onConnect(wrongName);
  assert.equal(wrongName.listeners.length, 0);

  const extensionPage = makePort("mcp-content-keepalive-v1", {});
  onConnect(extensionPage);
  assert.equal(extensionPage.listeners.length, 0);
});
