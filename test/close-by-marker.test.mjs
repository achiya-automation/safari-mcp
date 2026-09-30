#!/usr/bin/env node
/**
 * A close proves its tab by the session's marker in the same AppleScript that closes it. Default
 * mode only (no SAFARI_PROFILE): a named profile never closes a tab through AppleScript.
 *
 * Found on 29–30.9.26, by the review of the window-pinning fix and by a peer session's review of
 * its tab tracking: closeTab() found its tab with one script (the marker scan), counted the
 * window's tabs with a second and closed `tab N of front window` with a third. index.js's tab cap,
 * memory sweep and shutdown cleanup did the same through findTabByMarker() and closeTab(N), with
 * more awaits in between. A close in between (another eviction, the extension, the user, a popup)
 * renumbers the window, and another front window renames it, so by the time the close ran the
 * index could name the user's tab. closeTabByMarker() finds the marked tab and closes it, or blanks
 * the window's last tab, in one script. That script is still two Apple events, the marker check and
 * the close, so a close another process lands between them can still shift the index: a gap one
 * event wide instead of several scripts. This fake runs the script as one step and does not show it.
 *
 * safari.js's closeTabByMarker(), closeTab() and closeOwnTab(), and index.js's _closeTrackedTab()
 * and _cleanupTabs(), run for real over a fake Safari with two windows.
 *
 * Run:  node --test test/close-by-marker.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const MINE = 11; // the window the session's tabs are in
const THEIRS = 22; // the user's other window
const MARKER = "MCP_sess0001_mine";

// ---------- a Safari with two windows ----------

// Each window is { id, tabs }; tab i is tabs[i - 1], and a tab is { url, marker } with `marker` its
// window.name. Page scripts run for real against that; the marker scan and the one-script close are
// answered here, as Safari runs them. `closed` keeps every tab a script closed, `afterScript` runs
// after every script.
function safari() {
  const tab = (url, marker = "") => ({ url, marker });
  const app = {
    front: MINE, closed: [], scripts: [], afterScript: null, tab,
    windows: [
      { id: MINE, tabs: [tab("https://mail.example.com/"), tab("https://docs.example.com/"), tab("https://a.example.org/", MARKER), tab("https://bank.example.com/")] },
      { id: THEIRS, tabs: [tab("https://news.example.com/"), tab("https://shop.example.com/"), tab("https://photos.example.com/")] },
    ],
  };
  const windowOf = (ref) => {
    const w = ref === "front window" ? app.windows.find((x) => x.id === app.front) : app.windows.find((x) => `window id ${x.id}` === ref);
    if (!w) throw new Error(`Safari got an error: Can’t get ${ref}. (-1728)`);
    return w;
  };
  const answer = (script) => {
    const closing = /close tab i of w/.test(script) && script.match(/window\.name==='([^']*)'/);
    if (closing) {
      const w = windowOf(script.match(/set w to (front window|window id \d+)/)[1]);
      const at = w.tabs.findIndex((t) => t.marker === closing[1]);
      if (at < 0) return "";
      if (w.tabs.length === 1) {
        w.tabs[0].url = "about:blank";
        return "blanked";
      }
      app.closed.push(...w.tabs.splice(at, 1));
      return "closed";
    }
    const scan = script.match(/window\.name==='([^']*)'/);
    if (scan) {
      const w = windowOf(script.match(/set w to (front window|window id \d+)/)[1]);
      const i = w.tabs.findIndex((t) => t.marker === scan[1]) + 1;
      return `${w.id}:${i}`;
    }
    const page = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in tab (\d+) of (front window|window id \d+)$/);
    if (page) {
      const t = windowOf(page[3]).tabs[Number(page[2]) - 1];
      const win = { name: t.marker };
      try {
        return String(vm.runInNewContext(page[1].replace(/\\(["\\])/g, "$1"), { window: win, document: {}, location: { href: t.url } }) ?? "");
      } finally {
        t.marker = win.name;
      }
    }
    const count = script.match(/count of tabs of (front window|window id \d+)\)?$/);
    if (count) return String(windowOf(count[1]).tabs.length);
    const close = script.match(/^tell application "Safari" to close tab (\d+) of (front window|window id \d+)$/);
    if (close) return void app.closed.push(...windowOf(close[2]).tabs.splice(Number(close[1]) - 1, 1));
    throw new Error(`the fake Safari does not answer this AppleScript:\n${script}`);
  };
  app.run = async (script) => {
    app.scripts.push(script);
    try {
      return answer(script);
    } finally {
      const hook = app.afterScript;
      app.afterScript = null;
      hook?.(script);
    }
  };
  app.urls = (id) => app.windows.find((w) => w.id === id).tabs.map((t) => t.url);
  return app;
}

// ---------- safari.js and index.js, for real ----------

const safariParts = [
  between(safariSource, "const _sessions = new Map();", "\n// ========== DIAGNOSTIC LOG"),
  between(safariSource, "export function getActiveTabIndex()", "\n// ========== FAST OSASCRIPT"),
  between(safariSource, "async function _provenOwnTabIndex()", "\nexport async function switchTab("),
].join("\n");
const safariExports = [...safariParts.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

function loadSafari(app) {
  return new Function(
    "currentSessionId", "randomUUID", "osascript", "osascriptFast", "getTargetWindowRef", "refreshTargetWindow", "console",
    `${safariParts.replace(/^export /gm, "")}\nreturn { _st, ${safariExports.join(", ")} };`
  )(() => "s1", () => "sess0001-0000-4000-8000-000000000000", app.run, app.run, () => "front window", async () => {}, { error() {} });
}

// The session's tab is tab 3 of MINE, between two of the user's tabs.
function session() {
  const app = safari();
  const s = loadSafari(app);
  Object.assign(s._st(), { hasOwnedTab: true, activeTabIndex: 3, activeTabURL: "https://a.example.org/", activeTabMarker: MARKER });
  return { app, s };
}

// index.js's close paths for tabs this process tracked, over the same safari.js.
const indexParts = [
  between(indexSource, "async function _closeTrackedTab(info) {", "\n// Per-session tab cap"),
  between(indexSource, "async function _cleanupTabs() {", "\n// Periodic memory check"),
].join("\n");
function loadServer(safari, opened) {
  const _openedTabs = new Map(opened.map((info, i) => [`k${i}`, info]));
  const deps = {
    safari, _openedTabs, process: { env: {} }, console: { error() {} }, _receiptToken: (r) => r || "",
    _extensionConnected: false, _preferAppleScript: false, _profileExtensionVerified: false,
    sendToExtension: async () => assert.fail("no extension"), _commandTimeouts: {},
  };
  return new Function(...Object.keys(deps), `${indexParts}\nreturn { _closeTrackedTab, _cleanupTabs };`)(...Object.values(deps));
}

// ---------- 1. closeTab() ----------

// What the user does right after the first script of the close.
const USER = [
  { name: "closes their tab to the left of the session's", act: (app) => app.windows[0].tabs.shift() },
  { name: "brings their other window to the front", act: (app) => { app.front = THEIRS; } },
];
for (const user of USER) {
  test(`closeTab() closes the session's tab when the user ${user.name} right after the close starts`, async () => {
    const { app, s } = session();
    app.afterScript = () => user.act(app);
    assert.equal(await s.closeTab(), "Tab closed");
    assert.deepEqual(app.closed.map((t) => t.marker), [MARKER], "closeTab() closed another tab than the session's");
    assert.ok(app.urls(MINE).includes("https://bank.example.com/"), "the user's tab to the right was closed");
    assert.deepEqual(app.urls(THEIRS), ["https://news.example.com/", "https://shop.example.com/", "https://photos.example.com/"]);
    assert.equal(app.scripts.length, 1, "the close took more than the one script that proves the tab");
    assert.deepEqual([s._st().activeTabMarker, s._st().activeTabIndex], [null, null]);
  });
}

test("closeOwnTab(index) closes the tab it names only as the tab carrying the session's marker", async () => {
  const { app, s } = session();
  await assert.rejects(s.closeOwnTab(4), /Tab safety/);
  assert.deepEqual(app.closed, []);
  assert.equal(await s.closeOwnTab(3), "Tab closed");
  assert.deepEqual(app.closed.map((t) => t.marker), [MARKER]);
});

test("the window's last tab is blanked, not closed", async () => {
  const { app, s } = session();
  app.windows[0].tabs = [app.tab("https://a.example.org/", MARKER)];
  assert.match(await s.closeTab(), /last tab blanked/);
  assert.deepEqual(app.urls(MINE), ["about:blank"]);
  assert.deepEqual(app.closed, []);
});

test("closeTab() closes nothing when no tab carries the session's marker", async () => {
  const { app, s } = session();
  app.windows[0].tabs[2].marker = ""; // a site took window.name over
  await assert.rejects(s.closeTab(), /Tab tracking lost/);
  assert.deepEqual(app.closed, []);
});

test("closeTabByMarker never closes a tab adopted from the user", async () => {
  const { app, s } = session();
  const adopted = "MCP_Asess0001_mine";
  app.windows[0].tabs[0].marker = adopted;
  assert.equal(await s.closeTabByMarker(adopted), null);
  assert.equal(await s.closeTabByMarker(""), null);
  assert.deepEqual(app.scripts, [], "a close went to Safari for a marker no close accepts");
});

// ---------- 2. index.js: the tab cap, the memory sweep and shutdown cleanup ----------

test("the tab cap closes the tracked tab by its marker while the user's tabs renumber", async () => {
  const { app, s } = session();
  const server = loadServer(s, [{ url: "https://a.example.org/", marker: MARKER, receipt: "" }]);
  app.afterScript = () => app.windows[0].tabs.shift();
  assert.equal(await server._closeTrackedTab({ url: "https://a.example.org/", marker: MARKER, receipt: "" }), "closed");
  assert.deepEqual(app.closed.map((t) => t.marker), [MARKER]);
  assert.equal(await server._closeTrackedTab({ url: "https://gone.example.org/", marker: "MCP_sess0001_gone", receipt: "" }), "lost");
});

test("the tab cap counts a tab it could only blank as lost, not as closed", async () => {
  const { app, s } = session();
  // The session's tab is the only tab of its window: it is blanked, and no marker names it any more.
  app.windows[0].tabs = [app.tab("https://a.example.org/", MARKER)];
  const server = loadServer(s, []);
  assert.equal(await server._closeTrackedTab({ url: "https://a.example.org/", marker: MARKER, receipt: "" }), "lost");
  assert.deepEqual(app.urls(MINE), ["about:blank"]);
});

test("shutdown cleanup closes each tracked tab by its marker, and only those", async () => {
  const { app, s } = session();
  app.windows[1].tabs.push(app.tab("https://b.example.org/", "MCP_sess0001_b"));
  const opened = [
    { url: "https://a.example.org/", marker: MARKER },
    { url: "https://b.example.org/", marker: "MCP_sess0001_b" },
    { url: "https://c.example.org/", marker: "" }, // unproven: stays open
  ];
  const server = loadServer(s, opened);
  // Each close renumbers the window; the user brings their window forward after the first.
  app.afterScript = () => { app.front = THEIRS; };
  await server._cleanupTabs();
  assert.deepEqual(app.closed.map((t) => t.marker), [MARKER, "MCP_sess0001_b"]);
  assert.deepEqual(app.urls(MINE), ["https://mail.example.com/", "https://docs.example.com/", "https://bank.example.com/"]);
  assert.deepEqual(app.urls(THEIRS), ["https://news.example.com/", "https://shop.example.com/", "https://photos.example.com/"]);
});
