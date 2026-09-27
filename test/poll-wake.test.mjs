import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

// The extension's GET /poll long-poll used to re-check the queue on a 5ms setInterval, which kept
// each daemon at ~200 wake-ups a second while idle. It now waits in _httpPollWaiters and is woken
// by events, so every place that makes a poll answerable must call _wakeHttpPolls() — a missed
// one delays delivery to the 5s long-poll timeout instead of failing loudly.
test("/poll waits on events, not a timer loop", () => {
  const start = index.indexOf("// GET /poll");
  assert.ok(start > 0);
  const handler = index.slice(start, index.indexOf("// POST /result", start));
  assert.doesNotMatch(handler, /setInterval\(/);
  assert.match(handler, /_httpPollWaiters\.add\(check\)/);
  assert.match(handler, /_httpPollWaiters\.delete\(check\)/);
});

test("queueing a command wakes the open polls", () => {
  const pushes = [...index.matchAll(/_commandQueue\.push\(/g)];
  assert.ok(pushes.length > 0);
  for (const m of pushes) {
    assert.match(index.slice(m.index, m.index + 120), /_wakeHttpPolls\(\)/, "a queued command must wake the polls");
  }
});

test("switching or dropping the active worker wakes the open polls", () => {
  const sets = [...index.matchAll(/^\s*_activeHttpWorkerId = /gm)];
  assert.ok(sets.length >= 4);
  for (const m of sets) {
    assert.match(index.slice(m.index, m.index + 360), /_wakeHttpPolls\(\)/, "a superseded worker's poll must answer 423 without waiting 5s");
  }
});

test("profile navigate refuses URLs the extension cannot issue a receipt for", () => {
  const start = index.indexOf('"safari_navigate",');
  const nav = index.slice(start, index.indexOf("_addOwnedURL(url);", start));
  assert.match(nav, /process\.env\.SAFARI_PROFILE && !\/\^https\?:\\\/\\\/\/i\.test\(url\.trim\(\)\)/);
});
