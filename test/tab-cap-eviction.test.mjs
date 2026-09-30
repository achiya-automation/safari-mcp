#!/usr/bin/env node
/**
 * The per-session tab cap closes the session's OLDEST tab, found by the identity recorded
 * when it was opened — never by the position it had then.
 *
 * Found by code reading on 28.9.26 after the geo-audit morning skill's receipt→tab mapping
 * broke on 24.9.26 in the "מחקר אנונימי" profile: the cap closed the index recorded at
 * opening, and the close also carried the session's CURRENT receipt. The extension then
 * either refused ("receipt and requested index identify different tabs") while the server
 * still reported the oldest tab as closed, or — with no current receipt — closed whichever
 * session tab sat at that position by then. A later read came back from another query's tab.
 *
 * The extension side here is the real code — `_resolveReceiptTab` and `_closeTabForSession`
 * from extension/background.js — over a fake profile window. The server side is the real
 * eviction code from index.js over the real tab tracking of ownership-state.js.
 *
 * Run:  node --test test/tab-cap-eviction.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-evict-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
});

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const EPOCH = "e".repeat(36);
const WINDOW = 7;
const SESSION = "daemon:session-A";
const OTHER = "daemon:session-B";
const digest = (url) => createHash("sha256").update(String(url || "")).digest("hex");
const originOf = (url) => {
  try { return new URL(url).origin; } catch { return ""; }
};

// ---------- the extension, for real, over a fake profile window ----------

const extensionSource = [
  between(background, "function _receiptOrigin(", "\nfunction _receiptTokenFromPayload("),
  between(background, "function _isValidReceiptRecord(", "\n// Rebuild the per-session window map"),
  between(background, "async function _resolveReceiptTab(", "\nfunction _addOwnedTab("),
  between(background, "async function _closeTabForSession(", "\nasync function _switchTabForSession("),
].join("\n");

function makeProfile(userUrls = []) {
  const tabs = []; // in position order, as Safari numbers them
  const receipts = new Map(); // token → record: the extension's receipt registry
  const tokenByTab = new Map();
  const owned = new Map(); // sessionId → Set of tab ids
  const sent = []; // every command the server sent
  let nextId = 100;
  let nextToken = 0;

  const anyOwner = (id) => [...owned.values()].some((set) => set.has(id));
  const revoke = (id) => {
    const token = tokenByTab.get(id);
    tokenByTab.delete(id);
    if (token) receipts.delete(token);
  };
  // What the extension's tabs.onRemoved does for a tab that closed, whoever closed it.
  const forget = (id) => {
    for (const set of owned.values()) set.delete(id);
    revoke(id);
  };
  const mint = (tab) => {
    const token = `Receipt_${String(++nextToken).padStart(24, "0")}`;
    revoke(tab.id);
    receipts.set(token, {
      token, tabId: tab.id, windowId: WINDOW, browserEpoch: EPOCH,
      receiptOrigin: originOf(tab.url), identityDigest: digest(tab.url), issuedAt: Date.now(),
    });
    tokenByTab.set(tab.id, token);
    return token;
  };
  const browser = {
    tabs: {
      query: async () => tabs.map((tab, i) => ({ ...tab, index: i })),
      remove: async (id) => {
        tabs.splice(tabs.findIndex((tab) => tab.id === id), 1);
        forget(id);
      },
      update: async (id, props) => { Object.assign(tabs.find((tab) => tab.id === id), props); },
    },
  };
  const ext = Function(
    "browser", "_receiptByToken", "_tokenByTabId", "_digestTabUrl", "_isTabOwnedByAnySession",
    "_persistOwnedTabs", "_withReceiptMutationLock", "_ensureBrowserSessionEpoch",
    "_isTabOwnedBySession", "_addOwnedTab", "_removeOwnedTab",
    "_windowForSession", "_windowQuery", "_safeTabUrl",
    `${extensionSource}\nreturn { _resolveReceiptTab, _closeTabForSession };`
  )(
    browser, receipts, tokenByTab, async (url) => digest(url), anyOwner,
    async () => {}, (operation) => operation(), async () => EPOCH,
    (sid, id) => !!owned.get(sid)?.has(id),
    async (sid, id) => {
      if (!owned.has(sid)) owned.set(sid, new Set());
      owned.get(sid).add(id);
    },
    async (sid, id) => {
      owned.get(sid)?.delete(id);
      if (!anyOwner(id)) revoke(id);
    },
    () => WINDOW, (windowId) => ({ windowId }), (url) => String(url)
  );

  for (const url of userUrls) tabs.push({ id: nextId++, windowId: WINDOW, url });
  const find = (url) => {
    const tab = tabs.find((t) => t.url === url);
    assert.ok(tab, `no open tab on ${url}`);
    return tab;
  };

  return {
    sent,
    urls: () => tabs.map((tab) => tab.url),
    // The extension's new_tab: append, own, mint. Returns what index.js receives.
    open(sessionId, url) {
      const tab = { id: nextId++, windowId: WINDOW, url };
      tabs.push(tab);
      if (!owned.has(sessionId)) owned.set(sessionId, new Set());
      owned.get(sessionId).add(tab.id);
      return { tabIndex: tabs.length, receipt: mint(tab) };
    },
    // The user's hands, and a page that navigates by itself.
    userCloses(url) {
      const tab = find(url);
      tabs.splice(tabs.indexOf(tab), 1);
      forget(tab.id);
    },
    userMoves(url, position) {
      const tab = find(url);
      tabs.splice(tabs.indexOf(tab), 1);
      tabs.splice(position, 0, tab);
    },
    navigates(url, to) { find(url).url = to; },
    // handleCommand's preflight for the commands the server sends here.
    async send(type, payload) {
      sent.push({ type, ...payload });
      const sid = payload.sessionId;
      let target;
      if (payload.receipt) {
        target = await ext._resolveReceiptTab(payload.receipt, {
          allowOriginChange: type === "get_tab_receipt",
        });
        payload = { ...payload, _receiptTabId: target.id };
      } else {
        // getTargetTab without a receipt: the session's newest live tab.
        target = [...(owned.get(sid) || [])].reverse()
          .map((id) => tabs.find((tab) => tab.id === id)).find(Boolean);
      }
      if (type === "close_tab") return ext._closeTabForSession(sid, target, payload);
      if (type === "get_tab_receipt") return { receipt: mint(target) };
      throw new Error(`unexpected command ${type}`);
    },
  };
}

// ---------- the server's eviction code, for real ----------

const serverSource = [
  between(index, "const _receiptAliases", "// A caller-supplied receipt is the documented way"),
  /function _safeUrlForOutput\(rawUrl\) \{[\s\S]*?\n\}/.exec(index)[0],
  between(index, "async function _closeTrackedTab(info) {", "\n// Close all MCP-opened tabs on process exit"),
].join("\n");

function makeServer({ send, profile = true, extension = true, safari = {}, maxTabs = 6 }) {
  const deps = {
    sendToExtension: send,
    _extensionConnected: extension,
    _preferAppleScript: profile,
    _profileExtensionVerified: true,
    _commandTimeouts: { close_tab: 30000 },
    process: { env: profile ? { SAFARI_PROFILE: "מחקר אנונימי" } : {} },
    safari,
    MAX_TABS: maxTabs,
    console: { error() {} },
    _openedTabs: own._openedTabs,
    _untrackTab: own._untrackTab,
    _sessionTabs: own._sessionTabs,
  };
  return Function(
    ...Object.keys(deps),
    `${serverSource}\nreturn { _closeTrackedTab, _evictOldestTab, _evictionReport, _untrackClosedTab, _aliasReceipt };`
  )(...Object.values(deps));
}

// Open `count` tabs through the extension and track them the way safari_new_tab does.
function openTabs(profile, sessionId, count, prefix = "q") {
  const opened = [];
  for (let n = 1; n <= count; n++) {
    const url = `https://www.perplexity.ai/search?q=${prefix}${n}`;
    const { tabIndex, receipt } = profile.open(sessionId, url);
    own._trackTab(tabIndex, url, sessionId, "", receipt);
    opened.push({ url, receipt });
  }
  return opened;
}

const closes = (profile) => profile.sent.filter((c) => c.type === "close_tab");

test("after the user closed and moved tabs, the cap closes the oldest tab by its receipt", async () => {
  const p = makeProfile(["https://mail.example/inbox"]);
  const [q1, q2, q3, q4, q5, q6] = openTabs(p, SESSION, 6);
  // q1 was recorded at index 2. The user closes their own tab and moves q1 to the end:
  // index 2 is now q3, and q1 is at 6.
  p.userCloses("https://mail.example/inbox");
  p.userMoves(q1.url, 5);
  const server = makeServer({ send: (type, payload) => p.send(type, payload) });

  const evicted = await server._evictOldestTab(SESSION);

  assert.equal(evicted?.url, q1.url, "the oldest tab was the one closed");
  assert.deepEqual(p.urls(), [q2, q3, q4, q5, q6].map((q) => q.url), "every other tab is still open");
  assert.deepEqual(
    closes(p),
    [{ type: "close_tab", receipt: q1.receipt, sessionId: SESSION }],
    "one close, naming the oldest tab by its own receipt and carrying no position"
  );
  assert.equal(own._openedTabs.has(q1.receipt), false, "the closed tab is no longer counted");
  assert.equal(own._sessionTabs(SESSION).length, 5);
});

test("in a named profile the close carries the evicted tab's receipt, and other sessions' tabs are untouched", async () => {
  const p = makeProfile();
  const others = openTabs(p, OTHER, 3, "other"); // older than every tab of SESSION
  const [q1, , , , , q6] = openTabs(p, SESSION, 6);
  const server = makeServer({ send: (type, payload) => p.send(type, payload), profile: true });

  const evicted = await server._evictOldestTab(SESSION);

  assert.equal(evicted?.url, q1.url);
  const [close] = closes(p);
  assert.equal(close.receipt, q1.receipt, "the evicted tab's receipt, not the current one (q6)");
  assert.notEqual(close.receipt, q6.receipt);
  assert.equal("index" in close, false, "a recorded position is never sent");
  for (const other of others) assert.ok(p.urls().includes(other.url), `${other.url} belongs to another session`);
  assert.equal(own._sessionTabs(OTHER).length, 3);
});

test("the report names the closed tab by its receipt and the URL it was opened on", async () => {
  const p = makeProfile();
  const [q1] = openTabs(p, SESSION, 6);
  const server = makeServer({ send: (type, payload) => p.send(type, payload) });

  const report = server._evictionReport(await server._evictOldestTab(SESSION));

  assert.deepEqual(report.evictedTab, {
    receipt: q1.receipt,
    safeUrl: "https://www.perplexity.ai/search",
  });
  assert.match(report.note, /Tab cap 6\/session reached/);
  assert.match(report.note, /oldest tab \(opened on https:\/\/www\.perplexity\.ai\/search\) was closed/);
  assert.doesNotMatch(report.note, /#\d/, "no position: it is meaningless once tabs have moved");
  assert.doesNotMatch(JSON.stringify(report), /q=q1/, "the query string never leaves the server");
});

test("a tab the user already closed is only dropped from the count, and nothing is reported", async () => {
  const p = makeProfile();
  const [q1, ...rest] = openTabs(p, SESSION, 6);
  p.userCloses(q1.url); // the extension forgets its receipt
  const server = makeServer({ send: (type, payload) => p.send(type, payload) });

  const evicted = await server._evictOldestTab(SESSION);

  assert.equal(evicted, null, "nothing was closed, so nothing is reported as evicted");
  assert.deepEqual(p.urls(), rest.map((q) => q.url), "no live tab was closed in its place");
  assert.equal(own._sessionTabs(SESSION).length, 5);
});

test("a tab that moved to another origin is closed after its receipt is rotated", async () => {
  const p = makeProfile();
  const [q1, q2] = openTabs(p, SESSION, 6);
  p.navigates(q1.url, "https://news.example/story"); // a click-through; nobody rotated the receipt
  const server = makeServer({ send: (type, payload) => p.send(type, payload) });

  const evicted = await server._evictOldestTab(SESSION);

  assert.equal(evicted?.url, q1.url);
  assert.deepEqual(p.sent.map((c) => c.type), ["close_tab", "get_tab_receipt", "close_tab"]);
  assert.ok(!p.urls().includes("https://news.example/story"), "the moved tab is closed");
  assert.ok(p.urls().includes(q2.url));
});

test("a receipt rotated since the tab opened still names it", async () => {
  const p = makeProfile();
  const [q1] = openTabs(p, SESSION, 6);
  const server = makeServer({ send: (type, payload) => p.send(type, payload) });
  // What safari_navigate (cross-origin) and run_script getReceipt do: the extension mints a
  // new receipt and retires the old one; the server keeps the old name resolving.
  const { receipt: rotated } = await p.send("get_tab_receipt", { receipt: q1.receipt, sessionId: SESSION });
  server._aliasReceipt(q1.receipt, rotated);
  p.sent.length = 0;

  const evicted = await server._evictOldestTab(SESSION);

  assert.equal(evicted?.url, q1.url);
  assert.deepEqual(closes(p).map((c) => c.receipt), [rotated]);
  assert.equal(server._evictionReport(evicted).evictedTab.receipt, rotated, "reported under its current receipt");
});

test("a close that fails keeps the tab counted and closes the next oldest instead", async () => {
  const p = makeProfile();
  const [q1, q2] = openTabs(p, SESSION, 6);
  const send = async (type, payload) => {
    if (payload.receipt === q1.receipt) throw new Error("Extension timeout after 30000ms");
    return p.send(type, payload);
  };
  const server = makeServer({ send });

  const evicted = await server._evictOldestTab(SESSION);

  assert.equal(evicted?.url, q2.url, "the report names the tab that actually closed");
  assert.ok(p.urls().includes(q1.url) && !p.urls().includes(q2.url));
  assert.equal(own._openedTabs.has(q1.receipt), true, "q1 may still be open: it stays counted");
});

test("below the cap nothing is closed", async () => {
  const p = makeProfile();
  openTabs(p, SESSION, 5);
  const server = makeServer({ send: (type, payload) => p.send(type, payload) });
  assert.equal(await server._evictOldestTab(SESSION), null);
  assert.equal(p.sent.length, 0);
});

test("with the extension unavailable a receipt tab is kept, never guessed at through AppleScript", async () => {
  const p = makeProfile();
  const [q1] = openTabs(p, SESSION, 6);
  const safari = {
    closeTabByMarker: async () => assert.fail("AppleScript must not close a receipt tab"),
  };
  const server = makeServer({ send: () => assert.fail("not connected"), extension: false, profile: false, safari });

  assert.equal(await server._evictOldestTab(SESSION), null);
  assert.equal(own._openedTabs.has(q1.receipt), true);
});

test("AppleScript tabs are closed by the marker, wherever they moved", async () => {
  // Safari's window: the user's tab, then ours. Each of ours carries its marker.
  const window = [{ url: "https://user.example/", marker: null }];
  for (let n = 1; n <= 6; n++) {
    window.push({ url: `https://example.com/${n}`, marker: `MCP_s1_${n}` });
    own._trackTab(window.length, `https://example.com/${n}`, SESSION, `MCP_s1_${n}`);
  }
  window.splice(0, 1); // the user closes their tab: every recorded index is off by one
  window.push(window.splice(0, 1)[0]); // and moves the oldest to the end
  const safari = {
    // Finds the tab by its marker and closes it in one step, as the one AppleScript does.
    async closeTabByMarker(marker) {
      const at = window.findIndex((t) => t.marker === marker);
      if (at < 0) return null;
      window.splice(at, 1);
      return "closed";
    },
  };
  const server = makeServer({ send: () => assert.fail("no extension"), extension: false, profile: false, safari });

  const evicted = await server._evictOldestTab(SESSION);

  assert.equal(evicted?.marker, "MCP_s1_1");
  assert.deepEqual(window.map((t) => t.marker), ["MCP_s1_2", "MCP_s1_3", "MCP_s1_4", "MCP_s1_5", "MCP_s1_6"]);
});

test("an AppleScript close that fails stops the cap there, and keeps every tab tracked", async () => {
  // A page that never answers the marker check (a pending alert) makes each close time out: trying
  // every tracked tab in turn cost each one its own timeout on every safari_new_tab.
  for (let n = 1; n <= 6; n++) own._trackTab(n, `https://example.com/${n}`, SESSION, `MCP_s1_${n}`);
  let attempts = 0;
  const safari = {
    async closeTabByMarker() {
      attempts++;
      throw new Error("AppleScript error: Command failed (timed out)");
    },
  };
  const server = makeServer({ send: () => assert.fail("no extension"), extension: false, profile: false, safari });
  assert.equal(await server._evictOldestTab(SESSION), null);
  assert.equal(attempts, 1, "the cap tried the next tab after an AppleScript close failed");
  assert.equal(own._sessionTabs(SESSION).length, 6, "a tab the close may have left open was untracked");
});

test("a named profile never closes through AppleScript, even for a marked tab", async () => {
  own._trackTab(1, "https://example.com/1", SESSION, "MCP_s1_1");
  const safari = {
    closeTabByMarker: async () => assert.fail("no AppleScript close in a profile"),
  };
  const server = makeServer({ send: () => assert.fail("no receipt to send"), profile: true, safari, maxTabs: 1 });
  assert.equal(await server._evictOldestTab(SESSION), null);
});

test("a close by receipt forgets exactly that tab, under any of its names", async () => {
  const p = makeProfile();
  const [q1, q2, q3] = openTabs(p, SESSION, 3);
  const server = makeServer({ send: (type, payload) => p.send(type, payload) });
  const { receipt: rotated } = await p.send("get_tab_receipt", { receipt: q2.receipt, sessionId: SESSION });
  server._aliasReceipt(q2.receipt, rotated);

  server._untrackClosedTab({ receipt: rotated });
  assert.deepEqual(own._sessionTabs(SESSION).map(([, info]) => info.url), [q1.url, q3.url]);

  own._trackTab(4, "https://example.com/marked", SESSION, "MCP_s1_9");
  server._untrackClosedTab({ marker: "MCP_s1_9" });
  server._untrackClosedTab({}); // a close that named no tab forgets nothing
  assert.deepEqual(own._sessionTabs(SESSION).map(([, info]) => info.url), [q1.url, q3.url]);
});

test("every tracked tab records a marker only when AppleScript opened it", () => {
  // safari.js keeps the marker of the last tab AppleScript opened. After the extension opens
  // a tab, that marker names an EARLIER tab, and closing "by marker" would close that one.
  const calls = [...index.matchAll(/_trackTab\(([^;]*?)\);/g)].map((m) => m[1]);
  assert.ok(calls.length >= 3, "expected the new_tab, run_script and wait_for_new_tab call sites");
  for (const args of calls) {
    assert.match(args, /viaAppleScript \? safari\.getActiveTabMarker\(\) : ""/, `unguarded marker: ${args}`);
    assert.match(args, /receipt\)?$/, `the receipt must be recorded too: ${args}`);
  }
});

// ---------- receipt-less calls in a named profile ----------

const activeSource = between(index, "// The session's current tab: its receipt", "\nfunction _sanitizeTabResult(");

function makeActive({ profile = true } = {}) {
  const deps = {
    SESSION_ID: "daemon",
    currentSessionId: () => "session-A",
    _preferAppleScript: profile,
    _sessionTabs: own._sessionTabs,
  };
  const receiptSource = between(index, "const _receiptAliases", "// A caller-supplied receipt is the documented way");
  return Function(
    ...Object.keys(deps),
    `${receiptSource}\n${activeSource}\nreturn { _setActiveReceipt, _clearActiveReceipt, _getActiveReceipt, _refuseUnnamedTab };`
  )(...Object.values(deps));
}

test("a call that names no tab after the current one closed is refused while several remain", () => {
  const p = makeProfile();
  const [q1, q2, q3] = openTabs(p, SESSION, 3);
  const a = makeActive();
  a._setActiveReceipt(q3.receipt);
  assert.doesNotThrow(() => a._refuseUnnamedTab("read_page", {}), "a current tab is not ambiguous");

  a._clearActiveReceipt(); // safari_close_tab closed the current tab
  assert.throws(
    () => a._refuseUnnamedTab("read_page", {}),
    /Tab safety: this session's current tab was closed and 3 of its tabs are still open, so "read_page" does not say which one to use/
  );
  assert.throws(() => a._refuseUnnamedTab("evaluate", {}), /pass that tab's receipt|Pass that tab's receipt/);
  assert.throws(() => a._refuseUnnamedTab("close_tab", {}), /Tab safety/, "not even a close may guess");
  assert.doesNotThrow(() => a._refuseUnnamedTab("evaluate", { receipt: q1.receipt }), "a named tab is fine");
  for (const type of ["new_tab", "list_tabs", "switch_tab", "reload_extension"]) {
    assert.doesNotThrow(() => a._refuseUnnamedTab(type, {}), `${type} names no tab`);
  }

  a._setActiveReceipt(""); // switch_tab by index: a current tab without a receipt
  assert.doesNotThrow(() => a._refuseUnnamedTab("read_page", {}));
  a._setActiveReceipt(q2.receipt);
  assert.equal(a._getActiveReceipt(), q2.receipt);
});

test("one open tab, another session's tabs, and the default profile never make a call ambiguous", () => {
  const p = makeProfile();
  openTabs(p, OTHER, 5, "other");
  openTabs(p, SESSION, 1);
  const a = makeActive();
  a._clearActiveReceipt();
  assert.doesNotThrow(() => a._refuseUnnamedTab("read_page", {}), "one tab of its own is not ambiguous");

  openTabs(p, SESSION, 1, "second");
  assert.throws(() => a._refuseUnnamedTab("read_page", {}), /2 of its tabs are still open/);

  const defaultProfile = makeActive({ profile: false });
  defaultProfile._clearActiveReceipt();
  assert.doesNotThrow(() => defaultProfile._refuseUnnamedTab("read_page", {}), "only named profiles refuse");
});

test("closing another tab by its receipt leaves the current tab current", () => {
  const start = index.indexOf('server.tool(\n  "safari_close_tab"');
  const tool = index.slice(start, index.indexOf("\n);", start));
  assert.match(tool, /const closesCurrent = !token \|\| token === _getActiveReceipt\(\);/);
  // AppleScript closes only the tab carrying the session's marker: a close that names a
  // receipt never falls back to it (test/fallback-tab-proof.test.mjs).
  assert.match(tool, /_untrackClosedTab\(viaAppleScript \? \{ marker \} : \{ receipt: token \}\);/);
  assert.match(tool, /if \(viaAppleScript \|\| closesCurrent\) _clearActiveReceipt\(\);/);
  assert.doesNotMatch(tool, /_untrackTab\(activeIdx\)/, "an index names nothing once a tab has closed");

  const routing = between(index, "async function extensionOrFallback(", "_assertTabOwnership(extensionType, extensionPayload);");
  assert.match(routing, /_refuseUnnamedTab\(extensionType, extensionPayload\);/, "every extension command is checked");
});
