#!/usr/bin/env node
/**
 * A session's tab that the page or the user closed is reported on the session's next tool
 * result, instead of surfacing later as a stale-receipt error. The extension queues the close,
 * it rides on the reply to the session's next command, and the server appends it to that tool's
 * result and forgets the tab. Runs the real code: background.js's queue and index.js's delivery.
 *
 * Run:  node --test test/tab-events.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const INDEX = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const BACKGROUND = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
};

test("the extension queues closes per session and drains them once", () => {
  const ext = Function(
    "_DEFAULT_SESSION",
    `${between(BACKGROUND, "const _sessionTabEvents = new Map();", "browser.tabs.onRemoved.addListener((tabId) => {\n  _withReceiptMutationLock")}
     return { _queueTabEvent, _drainTabEvents };`
  )("__default__");
  ext._queueTabEvent("s1", { kind: "closed", receipt: "R1" });
  ext._queueTabEvent("s2", { kind: "closed", receipt: "R2" });
  assert.deepEqual(ext._drainTabEvents("s1"), { sessionId: "s1", items: [{ kind: "closed", receipt: "R1" }] });
  assert.equal(ext._drainTabEvents("s1"), null, "drained once");
  assert.equal(ext._drainTabEvents("s2").items[0].receipt, "R2", "another session's events stay its own");
  for (let i = 0; i < 30; i++) ext._queueTabEvent("s3", { kind: "closed", receipt: `R${i}` });
  assert.equal(ext._drainTabEvents("s3").items.length, 20, "the queue is bounded");
});

test("closes by an MCP close_tab are not reported; other closes of owned tabs are", () => {
  const removed = between(BACKGROUND, "browser.tabs.onRemoved.addListener((tabId) => {\n  _withReceiptMutationLock", "// Clean up any session");
  assert.match(removed, /if \(!_closeCommandsInFlight\)/);
  assert.match(removed, /_queueTabEvent\(sid, \{ kind: "closed", receipt: _tokenByTabId\.get\(tabId\)/);
  const reply = between(BACKGROUND, "async function executeAndReply(", "\n}\n");
  assert.match(reply, /if \(isClose\) _closeCommandsInFlight\+\+;/);
  assert.match(reply, /finally \{[\s\S]*?_closeCommandsInFlight--/, "released even when the close throws");
  assert.match(reply, /response\.events = events/);
});

test("events are queued only from a reply the server accepted, and a dead session's are dropped", () => {
  assert.match(INDEX, /accepted = _handleExtensionResponse\(msg, respondingWorkerId\);\s*if \(accepted\) _queueTabEvents\(msg\.events\);/);
  assert.match(between(INDEX, "async function _closeSessionTabs(", "\n}\n"), /_tabEventsBySession\.delete\(`\$\{SESSION_ID\}:\$\{sessionId\}`\)/);
});

test("a close reaches only its own session's next result, which forgets the tab", () => {
  const untracked = [];
  const api = Function(
    "SESSION_ID", "currentSessionId", "_receiptToken", "_untrackClosedTab",
    `${between(INDEX, "const _tabEventsBySession = new Map();", "// safari_snapshot diff mode.")}
     return { _queueTabEvents, _withTabEvents };`
  )(
    "daemon", () => "s1",
    (value) => (/^[A-Za-z0-9_-]{24,}$/.test(String(value || "")) ? value : ""),
    (info) => untracked.push(info),
  );
  const R = "Receipt_3".padEnd(32, "0");
  api._queueTabEvents({ sessionId: "daemon:other", items: [{ kind: "closed", receipt: "Receipt_9".padEnd(32, "0") }] });
  api._queueTabEvents({ sessionId: "daemon:s1", items: [{ kind: "closed", receipt: R }] });
  const result = api._withTabEvents({ content: [{ type: "text", text: "clicked" }] });
  assert.equal(result.content.length, 2);
  assert.equal(result.content[1].text, `Tab events: your tab with receipt ${R} was closed by the page or the user.`);
  assert.deepEqual(untracked, [{ receipt: R }]);
  const plain = { content: [{ type: "text", text: "next" }] };
  assert.equal(api._withTabEvents(plain), plain, "delivered once");
});
