#!/usr/bin/env node
/**
 * #143: the daemon names the browser session.
 *
 * A tab receipt is valid for one browser session. The extension named that session itself,
 * with a value kept in `storage.session`, and Safari gives every worker instance its own
 * `storage.session`: the value rotated with each worker succession, and the next tab removal
 * rewrote the shared receipt envelope under a different epoch. The daemon now sends the
 * identity of the running Safari process ("<pid>:<start time>") on every authenticated bridge
 * response; it is the same for every worker and changes only when Safari restarts.
 *
 * Run:  node --test test/safari-session-hint.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  formatSafariSessionHint,
  readSafariSessionHintSync,
  createSafariSessionHintReader,
} from "../safari-session-hint.js";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

test("a pid and a start time make one hint; anything malformed makes none", () => {
  assert.equal(formatSafariSessionHint("4242", "Mon Oct 12 07:51:21 2026"), "4242:Mon Oct 12 07:51:21 2026");
  assert.equal(formatSafariSessionHint(" 17 ", "  Mon  Oct  5 07:51:21 2026\n"), "17:Mon Oct 5 07:51:21 2026", "ps pads the day and ends with a newline");
  for (const [pid, lstart] of [["", "Mon Oct 12 07:51:21 2026"], ["abc", "Mon Oct 12 07:51:21 2026"], ["42", ""], ["42", "x"], ["42", "é".repeat(12)], [undefined, undefined]]) {
    assert.equal(formatSafariSessionHint(pid, lstart), "", `${JSON.stringify([pid, lstart])} names no session`);
  }
});

test("it asks for the oldest process named exactly Safari, then for that process's start time", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    return cmd.endsWith("pgrep") ? "4242\n9001\n" : "Mon Oct 12 07:51:21 2026\n";
  };
  assert.equal(readSafariSessionHintSync(run), "4242:Mon Oct 12 07:51:21 2026");
  assert.deepEqual(calls, [
    ["/usr/bin/pgrep", "-o", "-x", "Safari"],
    ["/bin/ps", "-o", "lstart=", "-p", "4242"],
  ]);
});

test("Safari not running is no hint, not an error", () => {
  const notRunning = () => { throw Object.assign(new Error("exit 1"), { status: 1 }); };
  assert.equal(readSafariSessionHintSync(notRunning), "");
  assert.equal(readSafariSessionHintSync(() => ""), "", "an empty pgrep answer is no pid");
});

test("the reader asks at most once per ttl and notices a relaunched Safari", () => {
  let t = 1_000_000;
  const answers = ["10:Mon Oct 12 07:51:21 2026", "10:Mon Oct 12 07:51:21 2026", "77:Tue Oct 13 09:00:00 2026"];
  let reads = 0;
  const current = createSafariSessionHintReader({ ttlMs: 1000, now: () => t, read: () => answers[reads++] });

  assert.equal(current(), answers[0]);
  assert.equal(current(), answers[0]);
  t += 999;
  assert.equal(current(), answers[0]);
  assert.equal(reads, 1, "polls from many workers inside one second share one process-table read");

  t += 1;
  assert.equal(current(), answers[1]);
  t += 5000;
  assert.equal(current(), answers[2], "a new process is a new hint on the first response after the ttl");
  assert.equal(reads, 3);
});

test("only an authenticated bridge response carries the hint, and the extension may read it", () => {
  const rejected = index.indexOf('res.writeHead(401);\n      res.end("Unauthorized");');
  const header = index.indexOf('res.setHeader("X-Safari-MCP-Browser-Epoch"');
  assert.ok(rejected > 0 && header > rejected, "the header is set after the 401 return for an unauthenticated bridge request");
  const block = index.slice(index.lastIndexOf("if (extensionBridgeEndpoint)", header), header + 300);
  assert.match(block, /if \(extensionBridgeEndpoint\) \{\s*const sessionHint = _safariSessionHint\(\);\s*if \(sessionHint\)/, "only bridge endpoints, only when there is a hint");
  assert.match(block, /Access-Control-Expose-Headers", "X-Safari-MCP-Browser-Epoch"/, "a cross-origin fetch cannot read a header that is not exposed");
});
