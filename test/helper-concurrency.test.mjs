import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The daemon used to answer commands strictly one at a time: handleLine() waited on the
// script's semaphore before reading the next line, so a single slow `do JavaScript` (a
// heavy or still-loading page holds Safari's main thread) stalled every later command for
// up to 30 seconds — including native ones that never touch Apple Events. A second Safari
// session looked completely dead for the duration.
//
// Replies now carry the caller's request id and may overtake each other. Two properties
// have to hold together, and the second is the dangerous one: an earlier attempt ran
// AppleScript on a concurrent queue and NSAppleScript — which is not thread-safe — handed
// a 3-second script the *next* script's result under its own id. Silent cross-talk.

const helper = join(dirname(fileURLToPath(import.meta.url)), "..", "safari-helper");
const darwin = process.platform === "darwin";
const skip = !darwin ? "macOS-only binary" : !existsSync(helper) ? "helper not built" : false;

function runHelper(commands, settleMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"] });
    const replies = [];
    const started = Date.now();
    let buf = "";

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          replies.push({ ...JSON.parse(line), atMs: Date.now() - started });
        } catch {
          reject(new Error(`helper emitted a non-JSON line (interleaved write?): ${line}`));
        }
      }
    });
    proc.on("error", reject);

    for (const { afterMs, ...payload } of commands) {
      setTimeout(() => proc.stdin.write(JSON.stringify(payload) + "\n"), afterMs || 0);
    }
    setTimeout(() => {
      proc.stdin.end();
      proc.kill();
      resolve(replies);
    }, settleMs);
  });
}

test("a fast command is not held behind a slow AppleScript", { skip }, async () => {
  const replies = await runHelper(
    [
      { id: "slow", script: 'delay 3\nreturn "SLOW"', afterMs: 0 },
      { id: "native", getFrontApp: {}, afterMs: 300 },
    ],
    5000,
  );

  const native = replies.find((r) => r.id === "native");
  const slow = replies.find((r) => r.id === "slow");
  assert.ok(native, "the native command must be answered");
  assert.ok(slow, "the slow script must still be answered");
  assert.ok(
    native.atMs < slow.atMs,
    `native must overtake the slow script, got native@${native.atMs}ms slow@${slow.atMs}ms`,
  );
  assert.ok(
    native.atMs < 2000,
    `native waited ${native.atMs}ms — it is queueing behind the 3s script again`,
  );
});

test("concurrent scripts never receive each other's results", { skip }, async () => {
  const replies = await runHelper(
    [
      { id: "slow", script: 'delay 2\nreturn "SLOW"', afterMs: 0 },
      { id: "fast", script: 'return "FAST"', afterMs: 200 },
    ],
    6000,
  );

  const byId = Object.fromEntries(replies.map((r) => [r.id, r.result]));
  assert.equal(byId.slow, "SLOW", "the slow script got another request's result — AppleScript cross-talk");
  assert.equal(byId.fast, "FAST", "the fast script got another request's result — AppleScript cross-talk");
});

test("every reply echoes the id it was sent with", { skip }, async () => {
  const commands = ["a", "b", "c"].map((id, i) => ({
    id,
    script: `return "${id.toUpperCase()}"`,
    afterMs: i * 50,
  }));
  const replies = await runHelper(commands, 3000);

  assert.equal(replies.length, 3, `expected 3 replies, got ${replies.length}`);
  for (const { id, result } of replies) {
    assert.equal(result, id.toUpperCase(), `reply ${id} carried ${result}`);
  }
});

// Replies are emitted asynchronously, so a caller that closes stdin right after writing
// — `echo '{"script":"…"}' | safari-helper`, which is how the AppleScript fallback and
// every ad-hoc probe invoke it — used to race the daemon's own exit and read nothing at
// all. Shutdown must drain work that is already running before it exits.
test("a one-shot invocation still gets its reply after stdin closes", { skip }, async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(helper, {
    input: JSON.stringify({ id: "oneshot", script: 'return "PONG"' }) + "\n",
    encoding: "utf8",
    timeout: 20000,
  });
  const reply = JSON.parse(out.trim().split("\n")[0]);
  assert.equal(reply.id, "oneshot", "the one-shot reply must echo its id");
  assert.equal(reply.result, "PONG", `expected PONG, got ${out.trim() || "(nothing — exited before replying)"}`);
});
