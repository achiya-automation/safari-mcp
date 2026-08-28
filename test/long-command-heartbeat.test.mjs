#!/usr/bin/env node
/**
 * Regression coverage for commands that outlive the 30s stale threshold.
 *
 * The extension executes each command *inside* its poll loop (`await executeAndReply`),
 * so while a command runs, `/poll` goes silent. On a heavy DOM — facebook.com,
 * business.facebook.com — a single read_page/snapshot passes 30s, the server's stale
 * timer declared "HTTP poll timeout", and `_drainOnDisconnect` rejected the very request
 * the worker was still executing. Every subsequent tool call then failed with
 * "Safari profile extension unavailable", and the session fell back to AppleScript.
 *
 * The fix is a mid-command heartbeat: the extension beats while busy, the server treats
 * that as liveness and re-arms in-flight deadlines, bounded by a hard ceiling so a worker
 * that beats forever still cannot hang the caller.
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

test("extension beats while a command occupies the poll loop", () => {
  const loop = background.slice(
    background.indexOf("async function pollForCommands("),
    background.indexOf("// ========== SHARED: Execute command and send response")
  );
  assert.ok(loop.includes("/heartbeat"), "poll loop must beat while executing");
  assert.match(loop, /setInterval\(/, "beat must repeat, not fire once");
  assert.match(
    loop,
    /finally\s*\{\s*clearInterval/,
    "beat must stop even when the command throws, or it leaks forever"
  );
  const beatIdx = loop.indexOf("/heartbeat");
  const execIdx = loop.indexOf("executeAndReply(msg)");
  assert.ok(beatIdx < execIdx, "beat must start before the blocking command, not after");
});

test("server exposes /heartbeat and treats it as liveness", () => {
  assert.ok(index.includes('req.url === "/heartbeat"'), "server must accept /heartbeat");
  const route = index.slice(index.indexOf("// POST /heartbeat"), index.indexOf("// POST /extension-verified"));
  assert.ok(route.includes("_extensionLastPollTime"), "beat must refresh the stale clock");
  assert.ok(route.includes("armTimer"), "beat must re-arm in-flight deadlines");
  assert.ok(route.includes("hardDeadline"), "re-arming must respect the ceiling");
});

test("stale detector spares a worker that is mid-command", () => {
  const timer = index.slice(index.indexOf("const _staleHttpTimer"), index.indexOf("_staleHttpTimer.unref()"));
  assert.ok(
    timer.includes("_pendingRequests.size") && timer.includes("_extensionLastHeartbeat"),
    "stale detector must check for in-flight work backed by a recent beat"
  );
  assert.ok(
    timer.indexOf("return") < timer.indexOf("_drainOnDisconnect"),
    "the in-flight guard must short-circuit before draining"
  );
});

// Behavioural: rebuild the deadline mechanism exactly as index.js arms it, and prove
// the three properties that matter. Anything that changes the shape below fails here.
function makeDeadline(timeoutMs, now = () => Date.now()) {
  const hardDeadline = now() + Math.max(timeoutMs * 4, 180000);
  return {
    hardDeadline,
    remaining: () => Math.min(timeoutMs, Math.max(0, hardDeadline - now())),
    canExtend: () => now() < hardDeadline,
  };
}

test("a beat extends a slow command past the old 30s cliff", () => {
  let clock = 0;
  const d = makeDeadline(30000, () => clock);
  clock = 29000; // a facebook.com read_page is still running
  assert.ok(d.canExtend(), "must still be extendable at 29s");
  assert.equal(d.remaining(), 30000, "a beat buys another full window");
  clock = 100000; // ~100s in, still beating
  assert.ok(d.canExtend(), "a beating worker survives well past 30s");
});

test("the ceiling stops an endlessly beating worker", () => {
  let clock = 0;
  const d = makeDeadline(30000, () => clock);
  clock = 180001;
  assert.ok(!d.canExtend(), "past the ceiling the command must be allowed to fail");
  assert.equal(d.remaining(), 0, "no time may be granted past the ceiling");
});

test("a session keeps its tab for longer than the gap between two MCP calls", () => {
  // TAB_CACHE_MS was 3s — shorter than the pause between two tool calls in real use.
  // Once it lapsed, getTargetTab fell through to "active tab of the profile window",
  // so whatever the user (or a parallel session) fronted became the target, and the
  // ownership guard then rejected the command as "not opened by this MCP session".
  const m = background.match(/const TAB_CACHE_MS = (\d+)/);
  assert.ok(m, "TAB_CACHE_MS must exist");
  assert.ok(
    Number(m[1]) >= 300000,
    `TAB_CACHE_MS is ${m[1]}ms — far too short to survive an interactive session`
  );
});

test("cache expiry is not what makes tab targeting safe", () => {
  // Extending the cache is only sound because these two checks run on every lookup.
  const p1 = background.slice(
    background.indexOf("// PRIORITY 1"),
    background.indexOf("// PRIORITY 2")
  );
  assert.ok(p1.includes("browser.tabs.get("), "a closed tab must drop out of the cache");
  // The window check now resolves per session (winId = _windowForSession(sessionId)),
  // because one profile can hold several windows. The guard itself is unchanged.
  assert.ok(/cached\.windowId === winId/.test(p1), "a tab outside the session's window must be rejected");
});

test("the proxy envelope outlives a heartbeat-extended command", () => {
  // A secondary instance reaches the extension through the host. The host extends a
  // command's deadline on every beat, so a proxy envelope of timeoutMs+5s abandoned
  // heavy-DOM commands at ~35s while the host was still waiting — the same visible
  // failure ("Extension timeout") the heartbeat was added to remove.
  const fn = index.slice(
    index.indexOf("async function _proxyToExtension"),
    index.indexOf("// Beats while the extension is busy executing a command")
  );
  assert.ok(fn.includes("AbortSignal.timeout"), "proxy must still bound the wait");
  assert.ok(
    /Math\.max\(timeoutMs \* 4, 180000\)/.test(fn),
    "proxy envelope must use the same ceiling as sendToExtension, not timeoutMs"
  );
});

test("a silent worker still fails fast", () => {
  // No beat means no re-arm: the original timeout stands and the caller is not left hanging.
  let clock = 0;
  const d = makeDeadline(30000, () => clock);
  assert.equal(d.remaining(), 30000, "first arm is the plain timeout, not the ceiling");
  assert.ok(d.hardDeadline >= 180000, "ceiling must be generous enough for real heavy pages");
});
