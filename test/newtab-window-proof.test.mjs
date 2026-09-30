#!/usr/bin/env node
/**
 * A tab AppleScript opens, and one it navigates, stays the session's own when the user brings
 * another Safari window to the front while its page loads. Default mode only (no SAFARI_PROFILE),
 * where every AppleScript used to address `front window`, which Safari resolves again for each
 * script.
 *
 * Found on 29.9.26 by an adversarial review of the run_script newTab ownership fix:
 *   1. newTab() made the tab in one script, read `count of tabs of front window` in a second, and
 *      while the page loaded polled it, stamped the session's identity marker on it and read its
 *      URL in more, all by that index and without the marker check (the page carried none yet).
 *      A window the user brought forward meanwhile took the probes, the marker and the URL read
 *      into the tab at that index in their window. resolveActiveTab() then found the marker there,
 *      and later writes (click, fill, evaluate, navigate) ran in the user's tab.
 *   2. A tab the user opened between the first two scripts made the count name their tab.
 *   3. navigate(), reload(), goBack(), goForward(), navigateAndRead() and clickAndWait() prove the
 *      tab once by its marker, then act on its index across several scripts (`set URL`, the load
 *      polls, the re-stamp), each against `front window` again.
 * Now the script that makes the tab reports its window's id and its index there, the marker scan
 * reports the window it scanned, and every later script of the step addresses `window id N`.
 *
 * safari.js runs for real: the session state, the marker scan, resolveActiveTab(), runJS(), the
 * marker stamp, newTab(), navigate(), reload(), goBack(), goForward(), navigateAndRead(),
 * clickAndWait() and the helper injection, over a fake Safari with two windows that runs their page
 * JavaScript against each tab and records every script that reached a tab.
 *
 * Run:  node --test test/newtab-window-proof.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { escAppleScriptString } from "../injected-escape.js";
import { answerMarkerScan, isMarkerScan, scriptWindowRef } from "./fake-safari-scripts.mjs";

const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const MINE = 11; // the window the session's tab is in
const THEIRS = 22; // the window the user brings to the front
const START = "https://dest.example.org/start";
const DEST = "https://dest.example.org/page";
const NEXT = "https://next.example.net/other";
const BLOCKED = "http://old.example.org/"; // Safari cannot open it over https

// ---------- a Safari with several windows ----------

// Each window is { id, tabs }, and tab i is tabs[i - 1]. A tab is { url, name, marker, spoof, ran }:
// `name` is its window.name, `marker` its window.__mcpTabMarker, `spoof` the visibility spoof, and
// `ran` every page script that reached it, reads included. A load keeps showing the old page until
// `loads` more scripts have reached the tab, then the new page: __mcpTabMarker, the spoof and
// anything else a script left go with the old one, and window.name too across sites (Safari
// clears it). `hooks.afterScript(script)` runs after every script, so a test can move the user's
// windows and tabs between two of them. The scripts that report where a tab is are answered only
// in the exact form safari.js writes them, so a report that loses its window id reads as one.
function safari(windows, front) {
  const app = { windows, front, scripts: [], hooks: {}, report: true, blockedOnce: [] };
  const site = (u) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return u; } };
  const tab = (url, extra = {}) => ({ url, name: "", marker: undefined, spoof: false, ran: [], back: [], forward: [], ...extra });
  app.tab = tab;
  const windowOf = (ref) => {
    if (ref === "front window") {
      const w = windows.find((x) => x.id === app.front);
      if (!w) throw new Error("Safari got an error: Can’t get window 1. Invalid index. (-1719)");
      return w;
    }
    const w = windows.find((x) => `window id ${x.id}` === ref);
    if (!w) throw new Error(`Safari got an error: Can’t get ${ref}. (-1728)`);
    return w;
  };
  const tabOf = (w, i) => {
    const t = w.tabs[i - 1];
    if (!t) throw new Error(`Safari got an error: Can’t get tab ${i} of window id ${w.id}. Invalid index. (-1719)`);
    return t;
  };
  const arrive = (t) => {
    if (site(t.url) !== site(t.next)) t.name = "";
    Object.assign(t, { url: t.next, marker: undefined, spoof: false, helpers: undefined, written: undefined, next: undefined });
  };
  const load = (t, url, loads = 2) => Object.assign(t, { next: url, loads });
  const visit = (t, url) => {
    if (t.stuck) return void t.stuck--; // a `set URL` that silently had no effect
    t.back.push(t.url);
    t.forward = [];
    load(t, url);
  };
  const runPage = (t, js) => {
    t.ran.push(js);
    if (t.next && --t.loads <= 0) arrive(t);
    const page = { name: t.name, __mcpTabMarker: t.marker, __mcpVisSpoof: t.spoof ? 1 : undefined, __mcpHelpers: t.helpers, __written: t.written };
    let move = null;
    const link = { tagName: "A", textContent: "go", scrollIntoView() {}, click() { move = "click"; } };
    const document = {
      title: app.blockedOnce.includes(t.url) ? "Safari cannot open the page" : `title of ${t.url}`,
      readyState: "complete", body: { innerText: `text of ${t.url}` }, addEventListener() {},
      querySelector: (sel) => (sel === "#go" ? link : null),
      scrollingElement: { scrollTop: 0, scrollBy() {} }, createTreeWalker: () => ({ nextNode: () => false }),
    };
    const location = { href: t.url, reload() { move = "reload"; } };
    const history = { back() { move = "back"; }, forward() { move = "forward"; } };
    try {
      return String(vm.runInNewContext(js, { window: page, document, location, history, NodeFilter: { SHOW_TEXT: 4 } }) ?? "");
    } finally {
      Object.assign(t, { name: page.name, marker: page.__mcpTabMarker, spoof: !!page.__mcpVisSpoof, helpers: page.__mcpHelpers, written: page.__written });
      if (move === "reload") load(t, t.url, 1);
      if (move === "click") visit(t, t.link);
      if (move === "back" && t.back.length) { t.forward.push(t.url); load(t, t.back.pop(), 1); }
      if (move === "forward" && t.forward.length) { t.back.push(t.url); load(t, t.forward.pop(), 1); }
    }
  };
  // The creation script's report of the tab it made, read off `t` inside a try.
  const report = (script, w) => {
    const expr = /\n\s*try\n\s*return ([^\n]*)\n\s*end try\n\s*return ""\nend tell$/.exec(script)?.[1];
    if (!expr) return "";
    if (expr !== '((id of w) as text) & ":" & ((index of t) as text)') throw new Error(`the fake Safari does not evaluate ${expr}`);
    return app.report ? `${w.id}:${w.tabs.length}` : ""; // Safari failing inside the try reports ""
  };
  const answer = (script) => {
    const page = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in (?:tab (\d+) of (front window|window id \d+)|front document)$/);
    if (page) {
      const w = windowOf(page[3] || "front window");
      return runPage(tabOf(w, page[2] ? Number(page[2]) : 1), page[1].replace(/\\(["\\])/g, "$1"));
    }
    if (isMarkerScan(script)) {
      // A marker scan of one window, run as Safari runs it: its marker check reads each tab's page.
      const w = windowOf(scriptWindowRef(script));
      return answerMarkerScan(script, { windowId: w.id, tabs: w.tabs, pageOf: (t) => ({ name: t.name, __mcpTabMarker: t.marker }) });
    }
    const made = script.match(/set w to (front window|window id \d+)\n[\s\S]*make new tab(?: with properties \{URL:"([^"]*)"\})?\n/);
    if (made) {
      // A background tab: the user's current tab stays current.
      const w = windowOf(made[1]);
      const t = tab("about:blank");
      if (made[2]) load(t, made[2]);
      w.tabs.push(t);
      return report(script, w);
    }
    const doc = script.match(/make new document(?: with properties \{URL:"([^"]*)"\})?\n/);
    if (doc) {
      // No window to open a tab in: a new window in front, whose one tab is the page.
      const w = { id: 33, tabs: [tab("about:blank")] };
      if (doc[1]) load(w.tabs[0], doc[1]);
      windows.push(w);
      app.front = w.id;
      return report(script, w);
    }
    const nav = script.match(/^tell application "Safari" to set URL of (?:tab (\d+) of (front window|window id \d+)|front document) to "([^"]*)"$/);
    if (nav) {
      const w = windowOf(nav[2] || "front window");
      return void visit(tabOf(w, nav[1] ? Number(nav[1]) : 1), nav[3]);
    }
    const count = script.match(/count of tabs of (front window|window id \d+)$/);
    if (count) return String(windowOf(count[1]).tabs.length);
    throw new Error(`the fake Safari does not answer this AppleScript:\n${script}`);
  };
  app.run = async (script) => {
    app.scripts.push(script);
    try {
      return answer(script);
    } finally {
      app.hooks.afterScript?.(script);
    }
  };
  return app;
}

// ---------- safari.js, for real ----------

// The per-session tab state and its accessors, the marker stamp, the marker scan,
// resolveActiveTab(), runJS(), the load steps, the helper injection and newTab().
const safariParts = [
  between(safariSource, "const _sessions = new Map();", "\n// ========== DIAGNOSTIC LOG"),
  between(safariSource, "function _assertNotFallingBackToUserTab(", "\n// ========== TAB IDENTITY MARKER"),
  between(safariSource, "function _buildStampJS(", "\n// Quick JS execution"),
  between(safariSource, "export function getActiveTabIndex()", "\n// ========== FAST OSASCRIPT"),
  between(safariSource, "function _tabIdentityGuard(", "\n// ========== NAVIGATION =========="),
  between(safariSource, "const RAISE_ON_NAVIGATE", "\n// ========== PAGE INFO =========="),
  between(safariSource, "async function _injectHelpersfast()", "\n// Ensure helpers are injected"),
  between(safariSource, "export async function newTab(", "\n// A tab index this session can prove it owns"),
  between(safariSource, "export async function navigateAndRead(", "\n// Full page analysis"),
  between(safariSource, "export async function scrollToElement(", "\n// ========== COMBO TOOLS"),
].join("\n");
const safariExports = [...safariParts.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

// `fast` stands in for the persistent helper (osascriptFast), `app.run` for the osascript subprocess.
function loadSafari(app, { fast = app.run } = {}) {
  // Timers fire at once: the load polls wait on nothing here.
  const setTimeout = (fn) => setImmediate(fn);
  // runJSLarge() writes its AppleScript to a file and runs it with the osascript binary.
  const files = new Map();
  const io = {
    writeFile: async (path, text) => { files.set(path, text); },
    unlink: async (path) => { files.delete(path); },
    execFileAsync: async (_cmd, [path]) => ({ stdout: await app.run(files.get(path)) }),
    tmpdir: () => "/tmp", join: (...parts) => parts.join("/"),
    _focusGuardActive: true, _helperGetFrontApp: async () => null, restoreFocusIfStolen: async () => {},
  };
  return new Function(
    "currentSessionId", "randomUUID", "osascript", "osascriptFast", "getTargetWindowRef",
    "refreshTargetWindow", "console", "SAFARI_PROFILE", "escAppleScriptString", "escJsSingleQuote",
    "_HELPERS_ESCAPED", "setTimeout", "fillForm", ...Object.keys(io),
    `${safariParts.replace(/^export /gm, "")}\nreturn { _st, runJS, runJSLarge, _stampTab, _injectHelpersfast, ${safariExports.join(", ")} };`
  )(
    () => "s1", () => "sess0001-0000-4000-8000-000000000000", app.run, fast, () => "front window",
    async () => {}, { error() {} }, null, escAppleScriptString, (s) => String(s).replace(/'/g, "\\'"),
    "window.__mcpHelpers=1", setTimeout, async () => "filled", ...Object.values(io)
  );
}

// The user's windows: MINE in front with their tab 1, THEIRS behind it with two tabs, so tab 2 of
// the front window is a tab of theirs once THEIRS comes to the front.
function userWindows() {
  const app = safari([], MINE);
  app.windows.push(
    { id: MINE, tabs: [app.tab("https://mail.example.com/inbox")] },
    { id: THEIRS, tabs: [app.tab("https://docs.example.com/draft"), app.tab("https://bank.example.com/transfer")] },
  );
  return app;
}
const tabsOf = (app, id) => app.windows.find((w) => w.id === id)?.tabs || [];
const userTabs = (app, ours) => app.windows.flatMap((w) => w.tabs).filter((t) => !ours.includes(t));
// A user's tab untouched: no script reached it, no `set URL` either, it carries no marker, spoof
// or helpers, and it shows its page.
function assertUntouched(app, ours, urlsBefore) {
  for (const t of userTabs(app, ours)) {
    assert.deepEqual(t.ran, [], `a script reached the user's tab on ${t.url}:\n${t.ran.join("\n")}`);
    assert.equal(t.next, undefined, `the user's tab on ${t.url} was sent to ${t.next}`);
    assert.equal(t.name, "", `the user's tab on ${t.url} got the marker ${t.name}`);
    assert.equal(t.marker, undefined, `the user's tab on ${t.url} got a marker`);
    assert.equal(t.spoof, false, `the user's tab on ${t.url} got the visibility spoof`);
    assert.equal(t.helpers, undefined, `the user's tab on ${t.url} got the click helpers`);
  }
  assert.deepEqual(userTabs(app, ours).map((t) => t.url).sort(), [...urlsBefore].sort(), "a user's tab was navigated away");
}
const bring = (app, id) => { app.front = id; };
// The user brings their window forward right after the first script that `after` matches.
function bringAfter(app, after) {
  let done = false;
  app.hooks.afterScript = (script) => {
    if (!done && after.test(script)) { done = true; bring(app, THEIRS); }
  };
}
async function outcome(call) {
  try {
    return JSON.stringify(await call());
  } catch (err) {
    return err.message;
  }
}

// ---------- 1. newTab() ----------

// `after`: the script after which the user brings their other window forward. The first probe of
// the new tab is its readyState read.
const NEW_TABS = [
  { when: "right after the tab is made", url: DEST, after: /make new tab/ },
  { when: "mid-load", url: DEST, after: /"document\.readyState" in tab 2 of window id/ },
  { when: "right after a blank tab is made", url: "", after: /make new tab/ },
];
for (const c of NEW_TABS) {
  test(`newTab${c.url ? "" : " (blank)"} probes, marks and reads its own tab when another window comes to the front ${c.when}`, async () => {
    const app = userWindows();
    const s = loadSafari(app);
    const before = userTabs(app, []).map((t) => t.url);
    bringAfter(app, c.after);
    let heard = null;
    const info = JSON.parse(await s.newTab(c.url, { onMarker: (m) => { heard = m; } }));
    const ours = tabsOf(app, MINE)[1];
    assert.equal(app.front, THEIRS, "the test never brought the user's window to the front");
    assertUntouched(app, [ours], before);
    assert.equal(ours.url, c.url || "about:blank");
    assert.ok(heard && ours.name === heard, `the new tab carries ${ours.name}, not the marker newTab reported (${heard})`);
    assert.equal(s._st().activeTabMarker, heard);
    assert.ok(ours.spoof, "the new tab did not get the visibility spoof");
    assert.deepEqual([info.url, info.tabIndex, s._st().activeTabIndex], [c.url || "about:blank", 2, 2], "newTab reported another tab");

    // A later write looks for the marker in the front window, the user's: it refuses rather than
    // run in their tab 2.
    app.hooks.afterScript = null;
    assert.match(await outcome(() => s.runJS("window.__written=1")), /Tab tracking lost/);
    assert.match(await outcome(() => s.navigate(NEXT)), /Tab tracking lost/);
    assertUntouched(app, [ours], before);
  });
}

test("newTab marks the tab it made, not a tab the user opens right after it", async () => {
  const app = userWindows();
  const s = loadSafari(app);
  let theirs = null;
  app.hooks.afterScript = (script) => {
    if (!/make new tab/.test(script)) return;
    // The user opens a tab of their own in the same window, between the script that made the
    // session's tab and the next one.
    theirs = app.tab("https://news.example.com/");
    tabsOf(app, MINE).push(theirs);
  };
  const before = userTabs(app, []).map((t) => t.url);
  const info = JSON.parse(await s.newTab(DEST));
  const ours = tabsOf(app, MINE)[1];
  assert.ok(theirs, "the user's tab was never opened");
  assertUntouched(app, [ours], [...before, "https://news.example.com/"]);
  assert.equal(ours.name, s._st().activeTabMarker, "the tab newTab made does not carry the session's marker");
  assert.equal(info.tabIndex, 2);
  assert.equal(s._st().activeTabIndex, 2, "the session tracks the user's tab, not the one it made");
  await s.runJS("window.__written=1");
  assert.equal(ours.written, 1, "a write after newTab missed the session's tab");
  assertUntouched(app, [ours], [...before, "https://news.example.com/"]);
});

test("newTab with no Safari window open marks the tab of the window it opens", async () => {
  const app = safari([], 0);
  const s = loadSafari(app);
  const info = JSON.parse(await s.newTab(DEST));
  const [w] = app.windows;
  assert.equal(w.tabs[0].url, DEST);
  assert.equal(w.tabs[0].name, s._st().activeTabMarker, "the new window's tab does not carry the session's marker");
  assert.deepEqual([info.url, info.tabIndex], [DEST, 1]);
});

// ---------- 2. the steps that load a page in the session's tab ----------

// The session's tab is tab 2 of MINE, marked by an earlier newTab, with a page to go back to; the
// user's other window has a tab 2 too.
const MARKER = "MCP_sess0001_mine";
function withOwnTab(extra = {}) {
  const app = userWindows();
  const s = loadSafari(app);
  const ours = app.tab(DEST, { name: MARKER, back: [START], link: NEXT, ...extra });
  tabsOf(app, MINE).push(ours);
  Object.assign(s._st(), { hasOwnedTab: true, activeTabIndex: 2, activeTabURL: DEST, activeTabMarker: MARKER });
  return { app, s, ours, before: userTabs(app, [ours]).map((t) => t.url) };
}

// `after`: the script after which the user brings their other window forward. Right after the
// marker scan (`set wid to`) leaves every later script of the step to its pin. `stamps`: the step
// re-stamps the page it loaded.
const LOADS = [
  { name: "navigate", when: "right after the marker scan", after: /set wid to/, run: (s) => s.navigate(NEXT), lands: NEXT, stamps: true },
  { name: "navigate", when: "before it sets the URL", after: /"location\.href"/, run: (s) => s.navigate(NEXT), lands: NEXT, stamps: true },
  { name: "navigate", when: "once the load has started", after: /set URL of/, run: (s) => s.navigate(NEXT), lands: NEXT, stamps: true },
  // The fast `set URL` has no effect, so navigate() sets it again through the subprocess.
  { name: "navigate", when: "before its retried `set URL`", after: /set wid to/, run: (s) => s.navigate(NEXT), lands: NEXT, stamps: true, extra: { stuck: 1 } },
  // Safari cannot open the page over https the first time, so navigate() loads it again as http.
  { name: "navigate", when: "before its http retry", after: /set wid to/, run: (s) => s.navigate(BLOCKED), lands: BLOCKED, stamps: true, blocked: true },
  { name: "reload", when: "right after the marker scan", after: /set wid to/, run: (s) => s.reload(), lands: DEST, stamps: true },
  { name: "reload", when: "once the load has started", after: /location\.reload\(\)/, run: (s) => s.reload(), lands: DEST, stamps: true },
  { name: "goBack", when: "right after the marker scan", after: /set wid to/, run: (s) => s.goBack(), lands: START },
  { name: "goForward", when: "right after the marker scan", after: /set wid to/, run: (s) => s.goForward(), lands: NEXT, extra: { forward: [NEXT] } },
  // The page never leaves DEST, so navigate() re-reads the URL before it gives up.
  { name: "navigate", when: "before it re-reads a URL that never changed", after: /set wid to/, run: (s) => s.navigate(NEXT), lands: DEST, extra: { stuck: 2 }, rejects: /navigate failed: page stayed on/ },
  { name: "navigateAndRead", when: "right after the marker scan", after: /set wid to/, run: (s) => s.navigateAndRead(NEXT), lands: NEXT, ran: /window\.onbeforeunload=null/ },
  { name: "clickAndWait", when: "right after the marker scan", after: /set wid to/, run: (s) => s.clickAndWait({ selector: "#go" }), lands: NEXT },
  { name: "clickAndWait", when: "while it waits for an element", after: /set wid to/, run: (s) => s.clickAndWait({ selector: "#go", waitFor: "#go" }), lands: NEXT, ran: /document\.querySelector\('#go'\)\?'1':''/ },
  { name: "fillAndSubmit", when: "right after it submits", after: /if\(el\)el\.click\(\)/, run: (s) => s.fillAndSubmit({ fields: {}, submitSelector: "#go" }), lands: NEXT },
  { name: "scrollToElement", when: "right after the marker scan", after: /set wid to/, run: (s) => s.scrollToElement({ text: "nowhere" }), lands: DEST, ran: /SCROLL:/ },
];
for (const step of LOADS) {
  test(`${step.name} keeps its steps in the session's tab when another window comes to the front ${step.when}`, async () => {
    const { app, s, ours, before } = withOwnTab(step.extra);
    bringAfter(app, step.after);
    if (step.blocked) {
      // The blocked page shows until navigate() sets the URL a second time.
      app.blockedOnce = [BLOCKED];
      const bringing = app.hooks.afterScript;
      app.hooks.afterScript = (script) => {
        bringing(script);
        if (app.scripts.filter((x) => /set URL of/.test(x)).length === 2) app.blockedOnce = [];
      };
    }
    if (step.rejects) await assert.rejects(step.run(s), step.rejects);
    else await step.run(s);
    assert.equal(app.front, THEIRS, "the test never brought the user's window to the front");
    assertUntouched(app, [ours], before);
    assert.equal(ours.url, step.lands);
    if (step.ran) assert.ok(ours.ran.some((js) => step.ran.test(js)), `the step's own script never reached the session's tab`);
    assert.equal(s._st().activeTabMarker, MARKER, "the step dropped the session's marker");
    if (step.stamps) {
      assert.equal(ours.name, MARKER, "the session's tab lost its marker");
      assert.ok(ours.spoof, "the session's tab was not re-stamped after the load");
    }
  });
}

test("navigate keeps its steps in the session's tab after the scan found it at a new index", async () => {
  const { app, s, ours, before } = withOwnTab();
  // The user closes their tab to the left of the session's, so the marker scan finds the session's
  // tab by its loop rather than at the index it remembered; then the user's window comes forward.
  tabsOf(app, MINE).shift();
  bringAfter(app, /set wid to/);
  await s.navigate(NEXT);
  assert.equal(s._st().activeTabIndex, 1);
  assertUntouched(app, [ours], before.filter((u) => u !== "https://mail.example.com/inbox"));
  assert.equal(ours.url, NEXT);
  assert.ok(ours.spoof, "the session's tab was not re-stamped after the load");
});

test("navigate injects the click helpers into its tab once the page carries the marker again", async () => {
  const { app, s, ours, before } = withOwnTab();
  await s.navigate(NEXT);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(ours.url, NEXT);
  assert.equal(s._st().activeTabMarker, MARKER, "the helper injection dropped the session's marker");
  assert.equal(ours.helpers, 1, "the click helpers never reached the session's tab");
  assertUntouched(app, [ours], before);
});

test("navigate's http retry re-marks the tab before the helper injection looks for the marker", async () => {
  // A page on another site that Safari cannot open the first time: its load clears window.name, and
  // navigate() loads the http URL again before it re-stamps.
  const { app, s, ours, before } = withOwnTab();
  const other = "http://old.example.com/";
  app.blockedOnce = [other];
  app.hooks.afterScript = () => {
    if (app.scripts.filter((x) => /set URL of/.test(x)).length === 2) app.blockedOnce = [];
  };
  await s.navigate(other);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(ours.url, other);
  assert.equal(ours.name, MARKER, "the http retry left the session's tab unmarked");
  assert.equal(s._st().activeTabMarker, MARKER, "the helper injection dropped the session's marker");
  assert.equal(ours.helpers, 1, "the click helpers never reached the session's tab");
  assertUntouched(app, [ours], before);
});

test("navigate's helper injection keeps the session's marker when another window comes to the front mid-load", async () => {
  const { app, s, ours, before } = withOwnTab();
  bringAfter(app, /set URL of/);
  await s.navigate(NEXT);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(s._st().activeTabMarker, MARKER, "the background helper injection dropped the session's marker");
  assert.equal(ours.helpers, 1, "the click helpers never reached the session's tab");
  assertUntouched(app, [ours], before);
  // Once the session's window is in front again, the next call finds its tab.
  app.front = MINE;
  await s.runJS("window.__written=1");
  assert.equal(ours.written, 1);
});

test("a write runs in the tab its scan proved when another window comes to the front in between", async () => {
  const { app, s, ours, before } = withOwnTab();
  // The marker scan finds the session's tab in its window; the user's window comes forward before
  // the write's own script runs.
  bringAfter(app, /window\.name===/);
  await s.runJS("window.__written=1");
  assert.equal(ours.written, 1, "the write missed the tab its scan proved");
  assertUntouched(app, [ours], before);
});

test("the helper injection runs in the tab its own scan proved when another window comes to the front in between", async () => {
  const { app, s, ours, before } = withOwnTab();
  bringAfter(app, /set wid to/);
  await s._injectHelpersfast();
  assert.equal(ours.helpers, 1, "the click helpers missed the tab the scan proved");
  assertUntouched(app, [ours], before);
});

test("newTab stamps its tab through the subprocess when the helper fails the stamp once", async () => {
  const app = userWindows();
  let failed = 0;
  const fast = async (script) => {
    if (/tabIndex:\d+\}\);\}\)\(\)" in tab /.test(script) && !failed++) throw new Error("safari-helper timeout");
    return app.run(script);
  };
  const s = loadSafari(app, { fast });
  const info = JSON.parse(await s.newTab(DEST));
  const ours = tabsOf(app, MINE)[1];
  assert.equal(failed, 1, "the helper never failed the stamp");
  assert.equal(ours.name, s._st().activeTabMarker, "the retried stamp did not mark the new tab");
  assert.equal(info.url, DEST);
});

test("a stamp without the window its tab was proven in marks nothing", async () => {
  const { app, s, ours } = withOwnTab();
  ours.name = "";
  await s._stampTab(2);
  assert.deepEqual(app.scripts, [], "a stamp went to the tab at that index in the front window");
});

// ---------- 3. a tab newTab cannot prove ----------

test("newTab marks nothing and fails when Safari does not report which tab it made", async () => {
  const { app, s, ours } = withOwnTab();
  app.report = false;
  const before = userTabs(app, [ours]).map((t) => t.url);
  let heard = null;
  assert.match(
    await outcome(() => s.newTab(NEXT, { onMarker: (m) => { heard = m; } })),
    /Tab tracking lost — Safari opened a new tab but did not report which one/
  );
  const made = tabsOf(app, MINE)[2];
  assert.deepEqual(app.scripts.filter((sc) => /do JavaScript/.test(sc)), [], "a script ran in some tab after all");
  assert.equal(made.name, "", "the unproven tab got a marker");
  assert.equal(heard, null, "newTab reported a marker for a tab it cannot prove");
  // The session's tab is still the one it had, and nothing moved to the unproven one.
  assert.deepEqual([s._st().activeTabMarker, s._st().activeTabIndex, s._st().hasOwnedTab], [MARKER, 2, true]);
  assertUntouched(app, [ours, made], before);
});

test("after newTab fails to prove its first tab, nothing falls back to the tab in front of the user", async () => {
  const app = userWindows();
  app.report = false;
  const s = loadSafari(app);
  const before = userTabs(app, []).map((t) => t.url);
  assert.match(await outcome(() => s.newTab(DEST)), /Tab tracking lost/);
  const made = tabsOf(app, MINE)[1];
  assert.match(await outcome(() => s.runJS("window.__written=1")), /Tab tracking lost/);
  assertUntouched(app, [made], before);
});

test("newTab marks nothing and fails when the window of its tab closes while the page loads", async () => {
  const app = userWindows();
  const s = loadSafari(app);
  const before = tabsOf(app, THEIRS).map((t) => t.url);
  let ours = null;
  let heard = null;
  // The user closes the window the new tab opened in once the tab's first probe has run.
  app.hooks.afterScript = () => {
    ours ||= tabsOf(app, MINE)[1];
    if (ours?.ran.length === 1 && tabsOf(app, MINE).length) {
      app.windows.splice(app.windows.findIndex((w) => w.id === MINE), 1);
      bring(app, THEIRS);
    }
  };
  const failed = await outcome(() => s.newTab(DEST, { onMarker: (m) => { heard = m; } }));
  assert.match(failed, /Tab tracking lost — the new tab could not be marked/);
  assert.match(failed, /Safari said: .*window id 11/, "the error hides what Safari said");
  for (const t of tabsOf(app, THEIRS)) {
    assert.deepEqual(t.ran, [], `a script reached the user's tab on ${t.url}`);
    assert.equal(t.name, "", `the user's tab on ${t.url} got the marker`);
  }
  assert.deepEqual(tabsOf(app, THEIRS).map((t) => t.url), before);
  // The tab exists, so the session's state already names it, by the marker newTab reported.
  assert.ok(heard);
  assert.deepEqual([s._st().activeTabMarker, s._st().activeTabIndex, s._st().activeTabURL], [heard, 2, DEST]);
});
