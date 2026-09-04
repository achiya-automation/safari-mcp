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

test("a parked profile worker gets one alarm cycle before it counts as disconnected", () => {
  const grace = Number(index.match(/const _HTTP_WORKER_PARK_GRACE_MS = (\d+) \* 1000/)?.[1]);
  assert.ok(grace >= 60 + 10, "grace must cover Safari's 1-minute alarm plus margin");
  assert.match(index, /process\.env\.SAFARI_PROFILE && Date\.now\(\) - _extensionLastPollTime <= _HTTP_WORKER_PARK_GRACE_MS\) return;/);
});

test("a receipt rotated by navigate keeps working under its old name", () => {
  const source = index.slice(index.indexOf("const _receiptAliases"), index.indexOf("// A caller-supplied receipt is the documented way"));
  const ctx = {};
  const fn = new Function(`${source}; return { _aliasReceipt, _receiptToken };`);
  const { _aliasReceipt, _receiptToken } = fn.call(ctx);
  const a = "a".repeat(36), b = "b".repeat(36), c = "c".repeat(36);
  _aliasReceipt(a, b); _aliasReceipt(b, c);
  assert.equal(_receiptToken(a), c);
  assert.equal(_receiptToken(c), c);
  assert.equal(_receiptToken("short"), "");
  assert.match(index, /_aliasReceipt\(usedReceipt, fresh\.receipt\);/);
});

test("evicting a session's oldest tab is reported in the new_tab result", () => {
  const body = index.slice(index.indexOf('"safari_new_tab",'), index.indexOf('"safari_close_tab",'));
  assert.match(body, /evictedTab = oldestIdx;/);
  assert.match(body, /\{ \.\.\.safeResult, evictedTab, note:/);
});

test("the profile-window opener is opt-in, waits for established absence, and is rate-limited", () => {
  const body = safari.slice(safari.indexOf("function _maybeOpenProfileWindow"), safari.indexOf("// Background verification"));
  assert.match(body, /if \(!OPEN_WINDOW_CMD \|\| !SAFARI_PROFILE \|\| _profileMisses < 3\) return;/);
  assert.match(body, /now - _lastOpenWindowAttempt < 120000/);
  assert.match(safari, /_profileMisses\+\+;\s*_maybeOpenProfileWindow\(\);/);
  assert.match(body, /execFileAsync\("\/usr\/bin\/open", \["-g", "-a", "Safari"\]\)/, "Safari is launched in the background, never hidden, before the menu press");
});

test("a content-script ping makes a backed-off worker retry the bridge at once", () => {
  const handler = background.slice(background.indexOf('msg?.action === "mcpContentKeepalivePingV1"'), background.indexOf('msg.action === "setEnabled"'));
  assert.match(handler, /if \(!isConnected && !_connecting\) \{[\s\S]*connect\(\);/);
});
