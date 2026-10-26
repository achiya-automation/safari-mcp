#!/usr/bin/env node
/**
 * With SAFARI_MCP_TAB_EVENTS=1 a session's tab that the page or the user closed is named on the
 * session's next tool result, instead of surfacing later as a stale-receipt error. The extension
 * queues the close, it rides on the reply to the session's next command, and the server appends
 * it to that tool's result and forgets the tab. Runs the real code from background.js (queue,
 * onRemoved listener, executeAndReply) and index.js (delivery, tool wrapper) with the browser and
 * the bridge stubbed.
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
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
};

const R1 = "Receipt_1".padEnd(32, "0");
const R2 = "Receipt_2".padEnd(32, "0");

/** background.js with the browser stubbed: the closed-tab queue, the onRemoved listener and
 *  executeAndReply. `commands` maps a command type to its handler; `timers` holds the 1s window. */
function makeExtension({ commands = {} } = {}) {
  let onRemoved;
  const timers = [];
  const posted = [];
  const owned = new Map(); // sessionId -> Set<tabId>
  const tokenByTabId = new Map();
  const harness = Function(
    "browser", "chrome", "setTimeout", "console", "AbortSignal", "HTTP_URL",
    "handleCommand", "_bridgeFetch", "_withReceiptMutationLock", "_hydrateOwnedTabs",
    "_persistOwnedTabs", "_sessionOwnedTabs", "_sessionTabCache", "_tokenByTabId", "_receiptByToken",
    `${between(BACKGROUND, "async function executeAndReply(", "// ========== COMMAND HANDLERS")}
     ${between(BACKGROUND, "// A session hears about its tabs", "browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {\n  if (!changeInfo.url)")}
     return { executeAndReply, _queueTabEvent, _drainTabEvents };`
  )(
    { tabs: { onRemoved: { addListener: (fn) => { onRemoved = fn; } } } }, {},
    (fn, ms) => timers.push({ fn, ms }), { warn() {} }, AbortSignal, "http://127.0.0.1:9224",
    async (type, payload) => commands[type] ? commands[type](payload) : "ok",
    async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
    (operation) => operation(), async () => {}, async () => {},
    owned, new Map(), tokenByTabId, new Map()
  );
  return {
    ...harness,
    posted,
    timers,
    own: (sessionId, tabId, receipt) => {
      owned.set(sessionId, (owned.get(sessionId) || new Set()).add(tabId));
      if (receipt) tokenByTabId.set(tabId, receipt);
    },
    /** The user (or a page) closes a tab; resolves once the listener has finished. */
    userCloses: async (tabId) => { onRemoved(tabId); await new Promise((r) => setImmediate(r)); },
    /** Let the 1-second window after an MCP close_tab pass. */
    elapseWindow: () => { for (const t of timers.splice(0)) t.fn(); },
    reply: (sessionId, type = "list_tabs") =>
      harness.executeAndReply({ id: `c${posted.length}`, type, payload: { sessionId } }).then(() => posted.at(-1)),
  };
}

test("a tab the user closes rides on that session's next reply, once; other sessions hear nothing", async () => {
  const ext = makeExtension();
  ext.own("s1", 11, R1);
  ext.own("s2", 22, R2);
  await ext.userCloses(11);
  assert.deepEqual((await ext.reply("s2")).events, undefined, "another session's reply is untouched");
  assert.deepEqual((await ext.reply("s1")).events, { sessionId: "s1", items: [{ kind: "closed", receipt: R1 }] });
  assert.equal((await ext.reply("s1")).events, undefined, "delivered once");
});

test("a tab no session owns is not reported", async () => {
  const ext = makeExtension();
  ext.own("s1", 11, R1);
  await ext.userCloses(99);
  assert.equal((await ext.reply("s1")).events, undefined);
});

test("the queue is bounded at 20 events per session", () => {
  const ext = makeExtension();
  for (let i = 0; i < 30; i++) ext._queueTabEvent("s1", { kind: "closed", receipt: `R${i}` });
  assert.equal(ext._drainTabEvents("s1").items.length, 20);
});

test("KNOWN LIMITATION: a user close during an MCP close_tab, and for 1s after, is dropped", async () => {
  // The user closes tab 11 while this session's close_tab of tab 12 is still running. The
  // extension cannot tell that close from the command's own, so it reports neither.
  let finishClose;
  const ext = makeExtension({ commands: { close_tab: () => new Promise((r) => { finishClose = r; }) } });
  ext.own("s1", 11, R1);
  ext.own("s1", 12, R2);
  const closing = ext.reply("s1", "close_tab");
  await new Promise((r) => setImmediate(r));
  await ext.userCloses(11);
  finishClose("closed");
  assert.equal((await closing).events, undefined, "the user's close during close_tab is not reported");

  ext.own("s1", 13, "Receipt_3".padEnd(32, "0"));
  await ext.userCloses(13);
  assert.equal((await ext.reply("s1")).events, undefined, "still inside the 1s window after close_tab");

  ext.elapseWindow();
  ext.own("s1", 14, "Receipt_4".padEnd(32, "0"));
  await ext.userCloses(14);
  assert.equal((await ext.reply("s1")).events.items[0].receipt, "Receipt_4".padEnd(32, "0"), "reporting resumes after the window");
});

test("the close_tab window is released even when close_tab throws", async () => {
  const ext = makeExtension({ commands: { close_tab: async () => { throw new Error("refused"); } } });
  ext.own("s1", 11, R1);
  assert.equal((await ext.reply("s1", "close_tab")).error, "refused");
  ext.elapseWindow();
  await ext.userCloses(11);
  assert.equal((await ext.reply("s1")).events.items[0].receipt, R1);
});

/** index.js: the server's queue and delivery, with the env flag as given. */
function makeServerSide(flag) {
  const untracked = [];
  const api = Function(
    "SESSION_ID", "currentSessionId", "_receiptToken", "_untrackClosedTab", "process",
    `${between(INDEX, "const TAB_EVENTS_ENABLED", "// One tab close at a time in this process.")}
     return { TAB_EVENTS_ENABLED, _queueTabEvents, _withTabEvents };`
  )(
    "daemon", () => "s1",
    (value) => (/^[A-Za-z0-9_-]{24,}$/.test(String(value || "")) ? value : ""),
    (info) => untracked.push(info),
    { env: flag === undefined ? {} : { SAFARI_MCP_TAB_EVENTS: flag } }
  );
  return { ...api, untracked };
}

test("a close reaches only its own session's next result, which forgets the tab", () => {
  const api = makeServerSide("1");
  api._queueTabEvents({ sessionId: "daemon:other", items: [{ kind: "closed", receipt: R2 }] });
  api._queueTabEvents({ sessionId: "daemon:s1", items: [{ kind: "closed", receipt: R1 }] });
  const result = api._withTabEvents({ content: [{ type: "text", text: "clicked" }] });
  assert.equal(result.content.length, 2);
  assert.equal(result.content[1].text, `Tab events: your tab with receipt ${R1} was closed by the page or the user.`);
  assert.deepEqual(api.untracked, [{ receipt: R1 }]);
  const plain = { content: [{ type: "text", text: "next" }] };
  assert.equal(api._withTabEvents(plain), plain, "delivered once");
});

test("malformed events are ignored", () => {
  const api = makeServerSide("1");
  for (const bad of [undefined, null, {}, { sessionId: "daemon:s1" }, { sessionId: 5, items: [{}] }, { sessionId: "daemon:s1", items: [] }]) {
    api._queueTabEvents(bad);
  }
  const plain = { content: [{ type: "text", text: "x" }] };
  assert.equal(api._withTabEvents(plain), plain);
});

test("the flag is off by default: nothing is queued and tools are not wrapped; =1 wraps every tool", async () => {
  assert.equal(makeServerSide().TAB_EVENTS_ENABLED, false);
  assert.equal(makeServerSide("0").TAB_EVENTS_ENABLED, false);
  assert.equal(makeServerSide("1").TAB_EVENTS_ENABLED, true);
  // The /result route queues events only for an accepted reply, and only when the flag is on.
  assert.match(INDEX, /accepted = _handleExtensionResponse\(msg, respondingWorkerId\);\s*if \(accepted && TAB_EVENTS_ENABLED\) _queueTabEvents\(msg\.events\);/);

  const wrapperSource = between(INDEX, "if (TAB_EVENTS_ENABLED) {\n  // Every tool's result", "\n}\n");
  const wrap = (enabled) => {
    const registered = [];
    const server = { tool: (...args) => registered.push(args) };
    const originalTool = server.tool;
    Function("server", "TAB_EVENTS_ENABLED", "_withTabEvents", `${wrapperSource}\n}`)(
      server, enabled, (r) => ({ ...r, wrapped: true })
    );
    return { server, registered, originalTool };
  };
  const off = wrap(false);
  assert.equal(off.server.tool, off.originalTool, "flag off: server.tool is untouched");
  const on = wrap(true);
  assert.notEqual(on.server.tool, on.originalTool);
  on.server.tool("safari_x", "desc", {}, async () => ({ content: [] }));
  const [name, desc, schema, handler] = on.registered[0];
  assert.deepEqual([name, desc, schema], ["safari_x", "desc", {}]);
  assert.deepEqual(await handler({}), { content: [], wrapped: true });
});
