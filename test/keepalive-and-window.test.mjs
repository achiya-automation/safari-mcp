import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const safari = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

test("keepalive tab is opt-in, served by the bridge, and never created without a real window", () => {
  assert.match(index, /KEEPALIVE_TAB_ENABLED = process\.env\.SAFARI_MCP_KEEPALIVE_TAB === "1"/);
  assert.match(index, /=== "\/keepalive"\) \{\s*res\.writeHead\(200/);
  const body = index.slice(index.indexOf("async function _ensureKeepaliveTab"), index.indexOf("function _scheduleKeepaliveTab"));
  assert.match(body, /if \(!list\.length\) return;/, "a missing window must not be created by the keepalive path");
  assert.match(body, /startsWith\(KEEPALIVE_URL\)\)\) return;/, "an existing keepalive tab is reused");
  // Scheduled from both handshake completions.
  assert.equal((index.match(/_scheduleKeepaliveTab\(\);/g) || []).length, 2);
});

test("the profile-window opener is opt-in, waits for established absence, and is rate-limited", () => {
  const body = safari.slice(safari.indexOf("function _maybeOpenProfileWindow"), safari.indexOf("// Background verification"));
  assert.match(body, /if \(!OPEN_WINDOW_CMD \|\| !SAFARI_PROFILE \|\| _profileMisses < 3\) return;/);
  assert.match(body, /now - _lastOpenWindowAttempt < 120000/);
  assert.match(safari, /_profileMisses\+\+;\s*_maybeOpenProfileWindow\(\);/);
});

test("a content-script ping makes a backed-off worker retry the bridge at once", () => {
  const handler = background.slice(background.indexOf('msg?.action === "mcpContentKeepalivePingV1"'), background.indexOf('msg.action === "setEnabled"'));
  assert.match(handler, /if \(!isConnected && !_connecting\) \{[\s\S]*connect\(\);/);
});
