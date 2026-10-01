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
 * Found on 29-30.9.26 by the adversarial review of that fix: pinned to its window, the tab was still
 * a position in it. A tab opened, closed or moved before the session's tab mid-step shifted it, and
 * the next script's probe, stamp or `set URL` reached the tab at its old index. Every script of a
 * step now proves the tab again inside itself (safari.js _inTab): by the marker, where the tab is
 * or where it moved, or, when no tab carries the marker, by a document the step's own load brought
 * in a window whose fingerprint is unchanged. Section 4 opens, closes, selects and moves tabs at
 * each step; section 5 pins what proves the tab and what does not.
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
import {
  answerCreationScript, answerMarkerScan, answerTabScript, isMarkerScan, isTabScript, scriptWindowRef,
} from "./fake-safari-scripts.mjs";

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

// Each window is { id, tabs, current }, and tab i is tabs[i - 1]; `current` is its selected tab
// (the first one when unset). A tab is { url, name, marker, spoof, ran }: `name` is its window.name,
// `marker` its window.__mcpTabMarker, `spoof` the visibility spoof, and `ran` every page script that
// reached it, reads included — except a script the page refused before doing anything (it did not
// prove the tab), which only read the marker, as a marker scan does. A tab with `noScript` (the
// Start Page) runs no page script: Safari answers missing value. A load keeps showing the old page
// until `loads` more scripts have reached the tab, then the new page: __mcpTabMarker, the spoof and
// anything else a script left go with the old one, and window.name too across sites (Safari
// clears it). `hooks.afterScript(script)` runs after every script, so a test can move the user's
// windows and tabs between two of them. The scripts that report where a tab is are answered only
// in the exact form safari.js writes them, so a report that loses its window id reads as one.
function safari(windows, front) {
  const app = { windows, front, scripts: [], hooks: {}, report: true, blockedOnce: [], loadSteps: 2 };
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
  // A new document: `born` is its performance.timeOrigin (a tab the test makes is older than any step).
  // With `app.bfcache`, a history move brings back the document the tab left, as Safari's
  // back/forward cache does within one web process (a same-site move): its __mcpTabMarker, spoof and
  // age come back, and window.name is cleared when the origin changes.
  const origin = (u) => { try { return new URL(u).origin; } catch { return u; } };
  const arrive = (t) => {
    const kept = app.bfcache && t.restore ? t.docs?.[t.next] : null;
    if (kept) {
      if (origin(t.url) !== origin(t.next)) t.name = "";
      Object.assign(t, { url: t.next, marker: kept.marker, spoof: kept.spoof, helpers: undefined, written: undefined, next: undefined, born: kept.born, restore: false });
      return;
    }
    if (site(t.url) !== site(t.next)) t.name = "";
    Object.assign(t, { url: t.next, marker: undefined, spoof: false, helpers: undefined, written: undefined, next: undefined, born: Date.now(), restore: false });
  };
  const load = (t, url, loads = app.loadSteps) => {
    (t.docs ||= {})[t.url] = { marker: t.marker, spoof: t.spoof, born: t.born ?? 0 }; // the document it leaves
    Object.assign(t, { next: url, loads });
  };
  const visit = (t, url) => {
    if (t.stuck) return void t.stuck--; // a `set URL` that silently had no effect
    t.back.push(t.url);
    t.forward = [];
    load(t, url);
  };
  // `clock`: the script counts toward the load (the script that makes the tab stamps it before
  // anything could load). `keep(value)`: whether the script counts as having reached the tab.
  const runPage = (t, js, { clock = true, keep = () => true } = {}) => {
    if (t.noScript) return null;
    t.ran.push(js);
    if (clock && t.next && --t.loads <= 0) arrive(t);
    const page = { name: t.name, __mcpTabMarker: t.marker, __mcpVisSpoof: t.spoof ? 1 : undefined, __mcpHelpers: t.helpers, __written: t.written };
    let move = null;
    const link = { tagName: "A", textContent: "go", scrollIntoView() {}, click() { move = "click"; } };
    const document = {
      title: app.blockedOnce.includes(t.url) ? "Safari cannot open the page" : `title of ${t.url}`,
      readyState: "complete", body: { innerText: `text of ${t.url}` }, addEventListener() {},
      querySelector: (sel) => {
        if (sel === ":boom(") throw new Error("SyntaxError: ':boom(' is not a valid selector");
        return sel === "#go" ? link : null;
      },
      scrollingElement: { scrollTop: 0, scrollBy() {} }, createTreeWalker: () => ({ nextNode: () => false }),
    };
    const location = { href: t.url, reload() { move = "reload"; } };
    const history = { back() { move = "back"; }, forward() { move = "forward"; } };
    let value;
    try {
      const performance = { timeOrigin: t.born ?? 0 };
      value = String(vm.runInNewContext(js, { window: page, document, location, history, performance, NodeFilter: { SHOW_TEXT: 4 } }) ?? "");
      return value;
    } finally {
      if (value !== undefined && !keep(value)) t.ran.pop();
      Object.assign(t, { name: page.name, marker: page.__mcpTabMarker, spoof: !!page.__mcpVisSpoof, helpers: page.__mcpHelpers, written: page.__written });
      if (move === "reload") load(t, t.url, 1);
      if (move === "click") visit(t, t.link);
      if (move === "back" && t.back.length) { t.forward.push(t.url); load(t, t.back.pop(), 1); t.restore = true; }
      if (move === "forward" && t.forward.length) { t.back.push(t.url); load(t, t.forward.pop(), 1); t.restore = true; }
    }
  };
  const currentOf = (w) => (w.current && w.tabs.includes(w.current) ? w.current : w.tabs[0]);
  const windowWith = (t) => windows.find((w) => w.tabs.includes(t));
  // The creation script, answered as fake-safari-scripts.mjs reads it: the stamp it runs on the tab
  // it made counts toward no load (it runs before anything could load).
  const report = (script, w, t) => answerCreationScript(script, {
    windowId: w.id, tabs: w.tabs, tab: t, fails: !app.report,
    run: (tab, js) => runPage(app.stampLandsOn?.(w) ?? tab, js, { clock: false }),
    urlOf: (x) => x.url, visibleOf: (x) => currentOf(w) === x,
  });
  const answer = (script) => {
    const page = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in (?:tab (\d+) of (front window|window id \d+)|front document)$/);
    if (page) {
      const w = windowOf(page[3] || "front window");
      return runPage(tabOf(w, page[2] ? Number(page[2]) : 1), page[1].replace(/\\(["\\])/g, "$1")) ?? "";
    }
    if (isMarkerScan(script)) {
      // A marker scan of one window, run as Safari runs it: its marker check reads each tab's page.
      const w = windowOf(scriptWindowRef(script));
      return answerMarkerScan(script, { windowId: w.id, tabs: w.tabs, pageOf: (t) => ({ name: t.name, __mcpTabMarker: t.marker }) });
    }
    if (isTabScript(script)) {
      // A script of a step in the tab it proved (_inTab): run as Safari runs it. A page script the
      // page refused (it does not prove the tab) leaves nothing behind.
      const w = windowOf(scriptWindowRef(script));
      return answerTabScript(script, {
        windowId: w.id,
        tabs: w.tabs,
        pageOf: (t) => ({ name: t.name, __mcpTabMarker: t.marker }),
        run: (t, js) => runPage(t, js, { keep: (v) => v.startsWith("MCP_OK:") }),
        setURL: (t, url) => visit(t, url),
        urlOf: (t) => t.url,
        visibleOf: (t) => currentOf(w) === t,
      });
    }
    const made = script.match(/set w to (front window|window id \d+)\n[\s\S]*make new tab(?: with properties \{URL:"([^"]*)"\})?\n/);
    if (made) {
      // A background tab: the user's current tab stays current.
      const w = windowOf(made[1]);
      const t = tab("about:blank", { born: Date.now() });
      if (made[2] && made[2] !== "about:blank") load(t, made[2]);
      w.tabs.push(t);
      return report(script, w, t);
    }
    const doc = script.match(/make new document(?: with properties \{URL:"([^"]*)"\})?\n/);
    if (doc) {
      // No window to open a tab in: a new window in front, whose one tab is the page.
      const w = { id: 33, tabs: [tab("about:blank", { born: Date.now() })] };
      if (doc[1] && doc[1] !== "about:blank") load(w.tabs[0], doc[1]);
      windows.push(w);
      app.front = w.id;
      return report(script, w, w.tabs[0]);
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
  app.windowWith = windowWith;
  // A test's hook can land a pending load at once: the page the load brings replaces the old one.
  app.arrive = (t) => { if (t.next) arrive(t); };
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
    `${safariParts.replace(/^export /gm, "")}\nreturn { _st, runJS, runJSLarge, _stampTab, _injectHelpersfast, _provenTabJS, _inTab, ${safariExports.join(", ")} };`
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
// the new tab reads its readyState and URL.
const NEW_TABS = [
  { when: "right after the tab is made", url: DEST, after: /make new tab/ },
  { when: "mid-load", url: DEST, after: /String\(document\.readyState\+' '\+location\.href\)/ },
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
// marker scan (`set wid to`) leaves every later script of the step to its pin. Every step leaves
// the page it loaded stamped: its polls stamp a page a load brought, and `stamps` marks the steps
// that re-stamp the settled page too.
const LOADS = [
  { name: "navigate", when: "right after the marker scan", after: /set wid to/, run: (s) => s.navigate(NEXT), lands: NEXT, stamps: true },
  { name: "navigate", when: "before it sets the URL", after: /'MCP_OK:'\+String\(location\.href\)/, run: (s) => s.navigate(NEXT), lands: NEXT, stamps: true },
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
  { name: "fillAndSubmit", when: "right after the marker scan", after: /set wid to/, run: (s) => s.fillAndSubmit({ fields: {}, submitSelector: "#go" }), lands: NEXT },
  { name: "scrollToElement", when: "right after the marker scan", after: /set wid to/, run: (s) => s.scrollToElement({ text: "nowhere" }), lands: DEST, ran: /SCROLL:/, loads: false },
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
    if (!step.rejects) {
      // Across sites too (goForward, navigateAndRead, clickAndWait and fillAndSubmit land on
      // another site): the tab stays the session's for the next call.
      assert.equal(ours.name, MARKER, "the session's tab lost its marker");
      if (step.loads !== false) assert.ok(ours.spoof, "the session's tab was not re-stamped after the load");
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
    if (/String\(JSON\.stringify\(\{title:document\.title,url:location\.href\}\)\)/.test(script) && !failed++) throw new Error("safari-helper timeout");
    return app.run(script);
  };
  const s = loadSafari(app, { fast });
  const info = JSON.parse(await s.newTab(DEST));
  const ours = tabsOf(app, MINE)[1];
  assert.equal(failed, 1, "the helper never failed the stamp");
  assert.equal(ours.name, s._st().activeTabMarker, "the retried stamp did not mark the new tab");
  assert.equal(info.url, DEST);
});

test("a scan that answers without the window it scanned proves nothing", async () => {
  const { app, s, ours, before } = withOwnTab();
  // Every scan answer loses its window id; the user's window comes forward right after the scan.
  const bare = async (script) => {
    const answer = await app.run(script);
    return isMarkerScan(script) ? answer.split(":")[1] : answer;
  };
  const t = loadSafari(app, { fast: bare });
  Object.assign(t._st(), s._st());
  bringAfter(app, /set wid to/);
  await assert.rejects(t.navigate(NEXT), /Tab tracking lost/);
  assertUntouched(app, [ours], before);
  assert.equal(t._st().activeTabMarker, MARKER, "a scan that proved nothing dropped the marker");
});

test("a large payload runs in the tab its scan proved when another window comes to the front in between", async () => {
  const { app, s, ours, before } = withOwnTab();
  bringAfter(app, /set wid to/);
  await s.runJSLarge("window.__written=1");
  assert.equal(ours.written, 1, "the payload missed the tab its scan proved");
  assertUntouched(app, [ours], before);
});

test("a stamp without the window its tab was proven in marks nothing", async () => {
  const { app, s, ours } = withOwnTab();
  ours.name = "";
  await s._stampTab({ idx: 2, win: null, marker: MARKER, fp: null, op: "navigate" });
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
  // The script that made the tab stamps it only once it has reported where the tab is.
  assert.deepEqual(app.scripts.filter((sc) => /do JavaScript/.test(sc) && !/make new tab/.test(sc)), [], "a script ran in some tab after all");
  assert.deepEqual(made.ran, [], "a script reached the unproven tab");
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
  // The user closes the window the new tab opened in once the tab's first probe has run (the script
  // that made it stamped it first).
  app.hooks.afterScript = () => {
    ours ||= tabsOf(app, MINE)[1];
    if (ours?.ran.length === 2 && tabsOf(app, MINE).length) {
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

// ---------- 4. a tab opened, closed or moved before the session's tab mid-step ----------
//
// Pinning each script to `window id N` still left the session's tab a position in that window:
// a tab the user opens before it (a link opened in a new tab lands right after the tab it came
// from) or closes before it, or another session's tab cap closing its oldest tab, shifts it, and
// the next script's probe, stamp or `set URL` went to whatever tab had shifted into its index.
// Every script of a step now proves the tab again before it touches it (_inTab): by the marker,
// wherever the tab is now, or, right after a load cleared the marker, by the window looking as it
// did when a script last proved it.

const LINK = "https://news.example.com/story"; // a page the user opens from a link in their tab
// A tab of the user's that was open before the step began; `fresh` for one opened during it (its
// document is newer than the step's load).
const userTab = (app, url = LINK, { fresh = false } = {}) => app.tab(url, fresh ? { born: Date.now() } : {});
// The user's new tab from Cmd+T: selected, on the Start Page, which runs no page script.
function cmdT(app, id) {
  const t = app.tab(null, { noScript: true });
  const w = app.windows.find((x) => x.id === id);
  w.tabs.push(t);
  w.current = t;
  return t;
}
// Run `fn` once, right after the first script that `after` matches.
function once(app, after, fn) {
  let done = false;
  app.hooks.afterScript = (script) => {
    if (!done && after.test(script)) { done = true; fn(script); }
  };
}
const PROBE = /String\(document\.readyState\+' '\+location\.href\)/; // newTab's load probe

test("newTab follows its tab by the marker when the user opens a tab before it while the page loads", async () => {
  const app = userWindows();
  app.loadSteps = 4; // the page is still loading after the insert
  const s = loadSafari(app);
  let theirs = null;
  // A link the user opens in a new tab from their tab 1 lands right after it: before the new tab.
  once(app, PROBE, () => { theirs = userTab(app); tabsOf(app, MINE).splice(1, 0, theirs); });
  const before = [...userTabs(app, []).map((t) => t.url), LINK];
  const info = JSON.parse(await s.newTab(DEST));
  const ours = tabsOf(app, MINE)[2];
  assert.ok(theirs, "the user's tab was never opened");
  assertUntouched(app, [ours], before);
  assert.equal(ours.url, DEST);
  assert.equal(ours.name, s._st().activeTabMarker, "the new tab does not carry the session's marker");
  assert.deepEqual([info.tabIndex, s._st().activeTabIndex], [3, 3], "newTab reported the tab at its old index");
});

test("newTab fails closed when the user opens a tab before it right after its page cleared the marker", async () => {
  const app = userWindows();
  const s = loadSafari(app);
  let ours = null;
  // The new page arrives (a cross-site load: no marker on it yet), and before the next script the
  // user opens a tab from their tab 1, which lands where the new tab was.
  once(app, PROBE, () => {
    ours = tabsOf(app, MINE)[1];
    app.arrive(ours);
    tabsOf(app, MINE).splice(1, 0, userTab(app, LINK, { fresh: true }));
  });
  const before = [...userTabs(app, []).map((t) => t.url), LINK];
  let heard = null;
  const failed = await outcome(() => s.newTab(DEST, { onMarker: (m) => { heard = m; } }));
  assert.match(failed, /^Tab tracking lost — newTab could not prove the session's tab/);
  assertUntouched(app, [ours], before);
  // The marker stays off every tab, and the session's state names the new tab, by its marker.
  assert.equal(ours.name, "", "a tab no script could prove was stamped");
  assert.deepEqual([s._st().activeTabMarker, s._st().activeTabIndex, s._st().activeTabURL], [heard, 2, DEST]);
  assert.match(await outcome(() => s.runJS("window.__written=1")), /Tab tracking lost/);
  assertUntouched(app, [ours], before);
});

test("newTab fails closed when a tab to its left closes and another opens right after its page cleared the marker", async () => {
  const app = userWindows();
  const s = loadSafari(app);
  let ours = null;
  // The user closes their tab 1 and another session opens a tab (not selected) at the end: the
  // count is the same, but the new tab moved to 1, and tab 2 is the other session's, not yet marked.
  once(app, PROBE, () => {
    ours = tabsOf(app, MINE)[1];
    app.arrive(ours);
    tabsOf(app, MINE).shift();
    tabsOf(app, MINE).push(userTab(app, "https://other.example.org/", { fresh: true }));
  });
  const before = ["https://other.example.org/", ...tabsOf(app, THEIRS).map((t) => t.url)];
  assert.match(await outcome(() => s.newTab(DEST)), /Tab tracking lost/);
  assertUntouched(app, [ours], before);
  assert.equal(ours.name, "", "a tab no script could prove was stamped");
});

for (const moment of ["while its blank page still shows", "once its page has loaded"]) {
  test(`newTab keeps its tab when the user presses Cmd+T ${moment}`, async () => {
    const app = userWindows();
    if (moment.startsWith("while")) app.loadSteps = 3;
    const s = loadSafari(app);
    let opened = null;
    // Cmd+T appends a tab after the new one: nothing before the new tab moves, and its marker proves it.
    const after = moment.startsWith("while") ? PROBE : /String\(JSON\.stringify|document\.readyState\+' '/;
    let probes = 0;
    app.hooks.afterScript = (script) => {
      if (!after.test(script) || opened) return;
      if (moment.startsWith("once") && ++probes < 2) return;
      opened = cmdT(app, MINE);
    };
    const before = [...userTabs(app, []).map((t) => t.url), null];
    const info = JSON.parse(await s.newTab(DEST));
    const ours = tabsOf(app, MINE)[1];
    assert.ok(opened, "the user's tab was never opened");
    assertUntouched(app, [ours], before);
    assert.equal(ours.name, s._st().activeTabMarker, "the new tab does not carry the session's marker");
    assert.deepEqual([info.url, info.tabIndex], [DEST, 2]);
  });
}

test("navigate follows the session's tab by the marker when the user opens a tab before it right after the scan", async () => {
  const { app, s, ours, before } = withOwnTab();
  once(app, /set wid to/, () => tabsOf(app, MINE).splice(1, 0, userTab(app)));
  await s.navigate(NEXT);
  assertUntouched(app, [ours], [...before, LINK]);
  assert.equal(ours.url, NEXT);
  assert.deepEqual([ours.name, s._st().activeTabIndex], [MARKER, 3]);
});

test("navigate follows the session's tab when a tab to its left closes right after the scan", async () => {
  // Another session's tab cap closes its oldest tab, left of the session's: tab 2 is no more.
  const { app, s, ours, before } = withOwnTab();
  once(app, /set wid to/, () => tabsOf(app, MINE).shift());
  await s.navigate(NEXT);
  assertUntouched(app, [ours], before.filter((u) => u !== "https://mail.example.com/inbox"));
  assert.deepEqual([ours.url, ours.name, s._st().activeTabIndex], [NEXT, MARKER, 1]);
});

test("navigate sets no URL in the Start Page the user opens after closing the tab to its left", async () => {
  // The user closes their tab 1 and presses Cmd+T between the scan and `set URL`: the Start Page
  // takes index 2, and runs no page script, so Safari answers the marker check with missing value.
  const { app, s, ours } = withOwnTab();
  let start = null;
  once(app, /set wid to/, () => { tabsOf(app, MINE).shift(); start = cmdT(app, MINE); });
  const theirs = tabsOf(app, THEIRS).map((t) => t.url);
  await s.navigate(NEXT);
  assert.equal(start.next, undefined, "navigate loaded a URL into the user's Start Page");
  assert.equal(start.url, null);
  assertUntouched(app, [ours, start], theirs);
  assert.deepEqual([ours.url, ours.name, s._st().activeTabIndex], [NEXT, MARKER, 1]);
});

test("navigate fails closed when the user opens a tab before the session's right after its load cleared the marker", async () => {
  const { app, s, ours, before } = withOwnTab();
  once(app, /set URL of/, () => { app.arrive(ours); tabsOf(app, MINE).splice(1, 0, userTab(app, LINK, { fresh: true })); });
  assert.match(await outcome(() => s.navigate(NEXT)), /^Tab tracking lost — navigate could not prove the session's tab/);
  assertUntouched(app, [ours], [...before, LINK]);
  assert.equal(ours.name, "", "a tab no script could prove was stamped");
});

test("navigate fails closed when a tab to its left closes and another opens right after its load cleared the marker", async () => {
  // The count is back where it was, but the session's tab moved into the URLs the proof compares.
  const { app, s, ours, before } = withOwnTab();
  once(app, /set URL of/, () => {
    app.arrive(ours);
    tabsOf(app, MINE).shift();
    tabsOf(app, MINE).push(userTab(app, "https://other.example.org/", { fresh: true }));
  });
  assert.match(await outcome(() => s.navigate(NEXT)), /Tab tracking lost/);
  assertUntouched(app, [ours], [...before.filter((u) => u !== "https://mail.example.com/inbox"), "https://other.example.org/"]);
  assert.equal(ours.name, "");
});

test("navigate fails closed when the user closes the session's tab and a tab they open takes its place right after its load cleared the marker", async () => {
  // A link the user opens in a new tab (target=_blank) lands right after their tab 1 and is
  // selected. The tab count and the URLs before index 2 are as before; only the selected tab tells it
  // from the session's.
  const { app, s, ours, before } = withOwnTab();
  let theirs = null;
  once(app, /set URL of/, () => {
    app.arrive(ours);
    tabsOf(app, MINE).pop();
    theirs = userTab(app, LINK, { fresh: true });
    tabsOf(app, MINE).push(theirs);
    app.windows.find((w) => w.id === MINE).current = theirs;
  });
  assert.match(await outcome(() => s.navigate(NEXT)), /Tab tracking lost/);
  assertUntouched(app, [ours], [...before, LINK]);
});

test("navigate fails closed when the user closes the session's tab and presses Cmd+T right after its load cleared the marker", async () => {
  // The Start Page runs no page script, so no proof can hold in it.
  const { app, s, ours, before } = withOwnTab();
  let start = null;
  once(app, /set URL of/, () => {
    app.arrive(ours);
    tabsOf(app, MINE).pop();
    start = cmdT(app, MINE);
  });
  assert.match(await outcome(() => s.navigate(NEXT)), /Tab tracking lost/);
  assert.equal(start.next, undefined, "navigate loaded a URL into the user's Start Page");
  assertUntouched(app, [ours, start], before);
});

for (const [field, carries] of [["window.name", { name: "MCP_sess0002_other" }], ["__mcpTabMarker", { name: "page-state", marker: "MCP_sess0002_other" }]]) {
  test(`navigate never takes another session's tab for its own, with that session's marker in ${field}, even when the window looks unchanged`, async () => {
    // Right after the load cleared the marker, the user closes the session's tab, and another
    // session opens one in its place (a new document). Its marker is in window.name, or, on a page
    // that took window.name over, only in __mcpTabMarker.
    const { app, s, ours, before } = withOwnTab();
    let other = null;
    once(app, /set URL of/, () => {
      app.arrive(ours);
      tabsOf(app, MINE).pop();
      other = app.tab("https://other.example.org/", { ...carries, born: Date.now() });
      tabsOf(app, MINE).push(other);
    });
    assert.match(await outcome(() => s.navigate(NEXT)), /Tab tracking lost/);
    assert.deepEqual([other.name, other.marker, other.ran, other.next], [carries.name, carries.marker, [], undefined]);
    assertUntouched(app, [ours, other], before);
  });
}

test("the window's fingerprint compares URLs considering case", async () => {
  // Tabs before the session's differ only in case. A tab closed to the left and one opened at the end
  // shift them so that, ignoring case, the three URLs before tab 4 read as before.
  const app = userWindows();
  const s = loadSafari(app);
  tabsOf(app, MINE).splice(0, 1, app.tab("https://x.example.com/A"), app.tab("https://x.example.com/a"), app.tab("https://x.example.com/A"));
  const ours = app.tab(DEST, { name: MARKER, back: [START] });
  tabsOf(app, MINE).push(ours);
  Object.assign(s._st(), { hasOwnedTab: true, activeTabIndex: 4, activeTabURL: DEST, activeTabMarker: MARKER });
  const theirs = tabsOf(app, THEIRS).map((t) => t.url);
  let late = null;
  once(app, /set URL of/, () => {
    app.arrive(ours);
    tabsOf(app, MINE).shift();
    late = userTab(app, "https://late.example.org/", { fresh: true });
    tabsOf(app, MINE).push(late);
  });
  assert.match(await outcome(() => s.navigate("https://x.example.com/a")), /Tab tracking lost/);
  assert.deepEqual([late.ran, late.name, late.next], [[], "", undefined], "the tab that took index 4 was treated as the session's");
  assertUntouched(app, [ours], ["https://x.example.com/a", "https://x.example.com/A", "https://late.example.org/", ...theirs]);
});

test("navigate keeps its tab when the user presses Cmd+T while the old page still shows", async () => {
  // The marker proves the tab once the tab count changed, and the proof's fingerprint is the one
  // the poll right after the cross-site load compares.
  const { app, s, ours, before } = withOwnTab();
  let start = null;
  once(app, /set URL of/, () => { start = cmdT(app, MINE); });
  await s.navigate(NEXT);
  assertUntouched(app, [ours, start], before);
  assert.equal(start.next, undefined);
  assert.deepEqual([ours.url, ours.name, s._st().activeTabIndex], [NEXT, MARKER, 2]);
});

test("navigate's retried `set URL` follows the session's tab when the user opens a tab before it", async () => {
  // The fast `set URL` has no effect; before the retry, the user opens a tab from their tab 1.
  const { app, s, ours, before } = withOwnTab({ stuck: 1 });
  let polls = 0;
  app.hooks.afterScript = (script) => {
    if (/'MCP_OK:'\+String\(document\.readyState\)/.test(script) && ++polls === 80) tabsOf(app, MINE).splice(1, 0, userTab(app));
  };
  await s.navigate(NEXT);
  assertUntouched(app, [ours], [...before, LINK]);
  assert.deepEqual([ours.url, ours.name, s._st().activeTabIndex], [NEXT, MARKER, 3]);
});

test("navigate's http retry follows the session's tab when the user opens a tab before it", async () => {
  const { app, s, ours, before } = withOwnTab();
  app.blockedOnce = [BLOCKED];
  let inserted = false;
  app.hooks.afterScript = (script) => {
    const sets = app.scripts.filter((x) => /set URL of/.test(x)).length;
    // The blocked page is loaded and stamped again; the user opens a tab before the retry.
    if (!inserted && sets === 1 && /blocked:document\.title/.test(script) && ours.url === BLOCKED) {
      inserted = true;
      tabsOf(app, MINE).splice(1, 0, userTab(app));
    }
    if (sets === 2) app.blockedOnce = [];
  };
  await s.navigate(BLOCKED);
  assert.ok(inserted, "the user's tab was never opened");
  assertUntouched(app, [ours], [...before, LINK]);
  assert.deepEqual([ours.url, ours.name, s._st().activeTabIndex], [BLOCKED, MARKER, 3]);
});

// The load steps: `write` is the script that starts the step's load. Right after the scan, a tab
// the user opens before the session's is followed by the marker. Right after the load cleared the
// marker (a cross-site load), the step fails closed; across a load that keeps window.name (the
// same site), the marker still proves the tab and the step follows it.
const STEPS = [
  { name: "navigate", write: /set URL of/, run: (s) => s.navigate(NEXT), lands: NEXT },
  { name: "navigateAndRead", write: /set URL of/, run: (s) => s.navigateAndRead(NEXT), lands: NEXT },
  { name: "reload", write: /location\.reload\(\)/, run: (s) => s.reload(), lands: DEST, sameSite: true },
  { name: "goBack", write: /history\.back\(\)/, run: (s) => s.goBack(), lands: START, sameSite: true },
  { name: "goForward", write: /history\.forward\(\)/, run: (s) => s.goForward(), lands: NEXT, extra: { forward: [NEXT] } },
  { name: "clickAndWait", write: /el\.click\(\);/, run: (s) => s.clickAndWait({ selector: "#go" }), lands: NEXT },
  { name: "fillAndSubmit", write: /if\(el\)el\.click\(\)/, run: (s) => s.fillAndSubmit({ fields: {}, submitSelector: "#go" }), lands: NEXT },
  { name: "scrollToElement", write: null, run: (s) => s.scrollToElement({ text: "nowhere" }), lands: DEST },
];
for (const step of STEPS) {
  test(`${step.name} follows the session's tab by the marker when the user opens a tab before it right after the scan`, async () => {
    const { app, s, ours, before } = withOwnTab(structuredClone(step.extra));
    once(app, /set wid to/, () => tabsOf(app, MINE).splice(1, 0, userTab(app)));
    await step.run(s);
    assertUntouched(app, [ours], [...before, LINK]);
    assert.deepEqual([ours.url, ours.name, s._st().activeTabMarker], [step.lands, MARKER, MARKER]);
  });
  if (!step.write) continue;
  test(`${step.name} ${step.sameSite ? "follows the session's tab" : "fails closed"} when the user opens a tab before it right after its load replaced the page`, async () => {
    const { app, s, ours, before } = withOwnTab(structuredClone(step.extra));
    once(app, step.write, () => { app.arrive(ours); tabsOf(app, MINE).splice(1, 0, userTab(app, LINK, { fresh: true })); });
    const outcomeOf = await outcome(() => step.run(s));
    assertUntouched(app, [ours], [...before, LINK]);
    assert.equal(ours.url, step.lands);
    if (step.sameSite) {
      assert.doesNotMatch(outcomeOf, /Tab tracking lost/);
      assert.equal(ours.name, MARKER);
    } else {
      assert.match(outcomeOf, new RegExp(`^Tab tracking lost — ${step.name} could not prove the session's tab`));
      assert.equal(ours.name, "", "a tab no script could prove was stamped");
    }
  });
}

test("navigate sets no URL in a tab that took the session's place before its page loaded", async () => {
  // Right after the step's first script proved the tab, the user closes it, and a tab of theirs lands
  // in its place with the window otherwise as before. Before its load the page still carries the
  // marker, so only the marker may prove it: `set URL` does not fall back to the window's look.
  const { app, s, ours, before } = withOwnTab();
  let theirs = null;
  once(app, /window\.onbeforeunload=null/, () => {
    tabsOf(app, MINE).pop();
    theirs = userTab(app, "https://other.example.org/", { fresh: true });
    tabsOf(app, MINE).push(theirs);
  });
  assert.match(await outcome(() => s.navigate(NEXT)), /^Tab tracking lost — navigate could not prove the session's tab/);
  assertUntouched(app, [ours], [...before, "https://other.example.org/"]);
  assert.equal(theirs.next, undefined, "navigate loaded a URL into the tab that took the session's place");
});

test("newTab proves its tab by the window's look when its page replaced the stamp before the first probe", async () => {
  // The page arrives before the first probe runs: no marker on it yet, so the fingerprint the script
  // that made the tab read proves it, and the probe stamps it.
  const app = userWindows();
  app.loadSteps = 1;
  const s = loadSafari(app);
  const before = userTabs(app, []).map((t) => t.url);
  const info = JSON.parse(await s.newTab(DEST));
  const ours = tabsOf(app, MINE)[1];
  assertUntouched(app, [ours], before);
  assert.equal(ours.name, s._st().activeTabMarker, "the new tab does not carry the session's marker");
  assert.deepEqual([info.url, info.tabIndex], [DEST, 2]);
});

// ---------- 5. what proves the tab, and what does not ----------

test("the page script refuses before its payload runs, and proves only what it should", () => {
  const { _provenTabJS } = loadSafari(userWindows());
  const run = (page, { positional = false, since = 0, born = 0, throws = false } = {}) => {
    const hit = { ran: 0 };
    const js = _provenTabJS(MARKER, throws ? "(hit.ran++,JSON.parse('{'))" : "(hit.ran++,'v')", { positional, stamp: false, since });
    const answer = vm.runInNewContext(js, { window: page, hit, performance: { timeOrigin: born } });
    return [answer, hit.ran];
  };
  const now = Date.now();
  // The marker proves the page, in either field, whatever the window looks like.
  assert.deepEqual(run({ name: MARKER }), ["MCP_OK:v", 1]);
  assert.deepEqual(run({ name: "page-state", __mcpTabMarker: MARKER }), ["MCP_OK:v", 1]);
  // Without it, nothing runs unless the window's look proved the tab (P), and then only in a page
  // with no other session's marker, whose document the step's own load brought.
  assert.deepEqual(run({ name: "" }), ["MCP_TAB_UNPROVEN", 0]);
  assert.deepEqual(run({ name: "" }, { positional: true, since: now, born: now + 5 }), ["MCP_OK:v", 1]);
  assert.deepEqual(run({ name: "MCP_sess0002_x" }, { positional: true, since: now, born: now + 5 }), ["MCP_TAB_UNPROVEN", 0]);
  assert.deepEqual(run({ name: "state", __mcpTabMarker: "MCP_Asess0002_x" }, { positional: true, since: now, born: now + 5 }), ["MCP_TAB_UNPROVEN", 0]);
  assert.deepEqual(run({ name: "" }, { positional: true, since: now, born: now - 60000 }), ["MCP_TAB_UNPROVEN", 0]);
  // A payload that throws in the proven page answers as proven, once.
  assert.deepEqual(run({ name: MARKER }, { throws: true }), ["MCP_OK:", 1]);
});

test("a page script that throws in the session's tab runs once, and does not read as a lost tab", async () => {
  // An invalid selector makes querySelector throw in the page, and Safari answers such a script
  // with missing value.
  const { app, s, ours, before } = withOwnTab();
  const out = await outcome(() => s.clickAndWait({ selector: ":boom(", timeout: 50 }));
  assert.doesNotMatch(out, /Tab tracking lost/);
  assert.equal(ours.ran.filter((js) => js.includes(":boom(")).length, 1, "the click script ran more than once");
  assertUntouched(app, [ours], before);
});

test("a step keeps the marker its scan proved when a parallel call of the session clears the session's", async () => {
  // Another call of the same session moves it to a tab the extension picked while this step's scan
  // runs, and a tab the user opens lands before the session's tab. The step still proves its tab by
  // the marker the scan found: it never falls back to the index alone.
  const app = userWindows();
  let s = null;
  let raced = false;
  const fast = async (script) => {
    const answer = await app.run(script);
    if (!raced && isMarkerScan(script)) {
      raced = true;
      s.setActiveTabFromExtension(5, "https://picked.example.org/");
      tabsOf(app, MINE).splice(1, 0, userTab(app));
    }
    return answer;
  };
  s = loadSafari(app, { fast });
  const ours = app.tab(DEST, { name: MARKER, back: [START] });
  tabsOf(app, MINE).push(ours);
  Object.assign(s._st(), { hasOwnedTab: true, activeTabIndex: 2, activeTabURL: DEST, activeTabMarker: MARKER });
  const before = userTabs(app, [ours]).map((t) => t.url);
  await outcome(() => s.navigate(NEXT));
  assert.ok(raced, "the parallel call never ran");
  assertUntouched(app, [ours], [...before, LINK]);
  assert.equal(ours.url, NEXT, "the session's tab was not the one navigated");
});

test("a session that owns a tab never runs a step's script by index alone", async () => {
  // A tab with no marker or no window is a tab nothing proves: for a session that owns one, that is
  // a refusal, never the old by-index script or the front document.
  const { app, s } = withOwnTab();
  for (const tab of [{ idx: 2, win: "window id 11", marker: null }, { idx: 2, win: null, marker: MARKER }]) {
    assert.match(await outcome(() => s._inTab({ ...tab, fp: null, since: 0, op: "navigate" }, "window.__written=1")), /^Tab tracking lost/);
    assert.match(await outcome(() => s._inTab({ ...tab, fp: null, since: 0, op: "navigate" }, "''", { then: (t) => `set URL of ${t} to "${NEXT}"` })), /^Tab tracking lost/);
  }
  assert.deepEqual(app.scripts, [], "a script ran for a tab nothing proves");
});

test("a session that never owned a tab navigates the front document, as before", async () => {
  const app = userWindows();
  const s = loadSafari(app);
  await s.navigate(NEXT);
  const sets = app.scripts.filter((sc) => /set URL of/.test(sc));
  assert.deepEqual(sets, [`tell application "Safari" to set URL of front document to "${NEXT}"`]);
  assert.ok(!app.scripts.some((sc) => /on mcpFp/.test(sc)), "a session with no tab ran a script that proves one");
});

test("navigateAndRead sets no URL in a tab that took the session's place before its page loaded", async () => {
  const { app, s, ours, before } = withOwnTab();
  let theirs = null;
  once(app, /window\.onbeforeunload=null/, () => {
    tabsOf(app, MINE).pop();
    theirs = userTab(app, "https://other.example.org/", { fresh: true });
    tabsOf(app, MINE).push(theirs);
  });
  assert.match(await outcome(() => s.navigateAndRead(NEXT)), /^Tab tracking lost — navigateAndRead could not prove/);
  assertUntouched(app, [ours], [...before, "https://other.example.org/"]);
  assert.equal(theirs.next, undefined, "navigateAndRead loaded a URL into the tab that took the session's place");
});

test("scrollToElement scrolls no tab that took the session's place after its first step", async () => {
  const { app, s, ours, before } = withOwnTab();
  once(app, /SCROLL:/, () => {
    tabsOf(app, MINE).pop();
    tabsOf(app, MINE).push(userTab(app, "https://other.example.org/"));
  });
  assert.match(await outcome(() => s.scrollToElement({ text: "nowhere" })), /Tab tracking lost/);
  assertUntouched(app, [ours], [...before, "https://other.example.org/"]);
});

for (const [name, run, extra, blocked] of [
  ["retried `set URL`", (s) => s.navigate(NEXT), { stuck: 1 }, false],
  ["http retry's `set URL`", (s) => s.navigate(BLOCKED), {}, true],
]) {
  test(`navigate's ${name} sets no URL in a tab that took the session's place`, async () => {
    // The page still carries the marker when the retry runs, so only the marker may prove its tab.
    const { app, s, ours, before } = withOwnTab(extra);
    if (blocked) app.blockedOnce = [BLOCKED];
    let theirs = null;
    let reads = 0;
    app.hooks.afterScript = (script) => {
      if (theirs || !/blocked:document\.title/.test(script)) return;
      if (blocked ? ours.url !== BLOCKED : ++reads < 80) return;
      tabsOf(app, MINE).pop();
      theirs = userTab(app, "https://other.example.org/", { fresh: true });
      tabsOf(app, MINE).push(theirs);
    };
    assert.match(await outcome(() => run(s)), /Tab tracking lost/);
    assert.ok(theirs, "the user's tab never took the session's place");
    assert.deepEqual([theirs.next, theirs.back, theirs.name], [undefined, [], ""], "the retry loaded into the user's tab");
    assertUntouched(app, [ours, theirs], before);
  });
}

test("navigate re-marks its tab at the first poll after the load, so a Cmd+T after that poll is harmless", async () => {
  const { app, s, ours, before } = withOwnTab();
  app.loadSteps = 1; // the first poll after `set URL` meets the new page
  let start = null;
  once(app, /'MCP_OK:'\+String\(document\.readyState\)/, () => { start = cmdT(app, MINE); });
  await s.navigate(NEXT);
  assertUntouched(app, [ours, start], before);
  assert.deepEqual([ours.url, ours.name], [NEXT, MARKER]);
});

for (const [step, write, run, extra] of [
  ["navigate", /set URL of/, (s) => s.navigate(NEXT), {}],
  ["clickAndWait", /el\.click\(\);/, (s) => s.clickAndWait({ selector: "#go" }), {}],
]) {
  test(`${step} stops at the first script that cannot prove its tab`, async () => {
    // After the load, the user closes the session's tab: nothing proves it. A link they then open
    // in a background tab lands where it was, with the window looking as before; the step must not
    // take it, having stopped already.
    const { app, s, ours, before } = withOwnTab(extra);
    let theirs = null;
    let phase = 0;
    app.hooks.afterScript = (script) => {
      if (phase === 0 && write.test(script)) { phase = 1; app.arrive(ours); tabsOf(app, MINE).pop(); return; }
      if (phase === 1 && /MCP_OK:/.test(script)) {
        phase = 2;
        theirs = userTab(app, LINK, { fresh: true });
        tabsOf(app, MINE).push(theirs);
      }
    };
    assert.match(await outcome(() => run(s)), /Tab tracking lost/);
    assert.deepEqual([theirs?.name, theirs?.marker, theirs?.ran], ["", undefined, []], "the step went on into the user's tab");
    assertUntouched(app, [ours, theirs].filter(Boolean), before);
  });
}

test("newTab stops at the first probe that cannot prove its tab", async () => {
  const app = userWindows();
  app.loadSteps = 6;
  const s = loadSafari(app);
  let theirs = null;
  let phase = 0;
  app.hooks.afterScript = (script) => {
    if (phase === 0 && PROBE.test(script)) { phase = 1; tabsOf(app, MINE).pop(); return; }
    if (phase === 1 && PROBE.test(script)) {
      phase = 2;
      theirs = userTab(app, LINK, { fresh: true });
      tabsOf(app, MINE).push(theirs);
    }
  };
  assert.match(await outcome(() => s.newTab(DEST)), /Tab tracking lost/);
  assert.deepEqual([theirs?.name, theirs?.marker], ["", undefined], "newTab marked the user's tab");
});

test("a tab that was open before the step never proves the session's tab by the window's look", async () => {
  // Before the load arrives the user closes the session's tab, and a tab of theirs that was already
  // open lands in its place with the window looking as before: its document predates the step.
  const { app, s, ours, before } = withOwnTab();
  app.loadSteps = 6;
  let theirs = null;
  once(app, /'MCP_OK:'\+String\(document\.readyState\)/, () => {
    tabsOf(app, MINE).pop();
    theirs = userTab(app);
    tabsOf(app, MINE).push(theirs);
  });
  assert.match(await outcome(() => s.navigate(NEXT)), /Tab tracking lost/);
  assertUntouched(app, [ours], [...before, LINK]);
});

test("navigate works in a session tab whose page took window.name over", async () => {
  // The marker is only in __mcpTabMarker, and the load stays on the site, so window.name stays the
  // page's.
  const { app, s, ours, before } = withOwnTab();
  Object.assign(ours, { name: "spa-state", marker: MARKER });
  await s.navigate("https://dest.example.org/next");
  assertUntouched(app, [ours], before);
  assert.deepEqual([ours.url, ours.name], ["https://dest.example.org/next", MARKER]);
});

test("navigate fails closed when nothing proves its tab for the final re-stamp", async () => {
  const { app, s, ours, before } = withOwnTab();
  let start = null;
  once(app, /blocked:document\.title/, () => {
    // The settled page has been read; the user closes the session's tab and presses Cmd+T.
    tabsOf(app, MINE).pop();
    start = cmdT(app, MINE);
  });
  assert.match(await outcome(() => s.navigate(NEXT)), /Tab tracking lost/);
  assert.deepEqual([start.name, start.next], ["", undefined]);
  assertUntouched(app, [ours, start], before);
});

test("the stamp in the script that makes a tab takes only a page as fresh as the one it made", async () => {
  // `t` is a position: a tab that lands there before the stamp (here, the user's tab) must not
  // take the marker. The first probe then proves the new tab by the window's look and stamps it.
  const app = userWindows();
  app.stampLandsOn = (w) => w.tabs[0];
  const s = loadSafari(app);
  const inbox = tabsOf(app, MINE)[0];
  const info = JSON.parse(await s.newTab(DEST));
  const ours = tabsOf(app, MINE)[1];
  assert.deepEqual([inbox.name, inbox.marker, inbox.spoof], ["", undefined, false], "the creation stamp marked the user's tab");
  assert.equal(ours.name, s._st().activeTabMarker);
  assert.equal(info.tabIndex, 2);
});

test("goBack proves a page the back/forward cache restores by the marker the session left on it", async () => {
  // The session reached /2 through a plain click, so /2 never got __mcpTabMarker, then navigated to
  // another origin of the same site. Going back restores /2 as it was left, with its old document
  // (older than the step), and the restore clears window.name. The scripts that left /2 stamped it.
  const { app, s, ours, before } = withOwnTab();
  app.bfcache = true;
  Object.assign(ours, { url: "https://www.dest.example.org/2", back: ["https://www.dest.example.org/1"], marker: undefined });
  await s.navigate("https://docs.dest.example.org/x");
  assert.equal(ours.url, "https://docs.dest.example.org/x");
  await s.goBack();
  assert.deepEqual([ours.url, ours.name, ours.marker], ["https://www.dest.example.org/2", MARKER, MARKER]);
  assertUntouched(app, [ours], before);
});

test("a tab that does not answer to the right of the session's keeps the window's look from proving the tab", async () => {
  // The session's tab moved one place right past a tab of the user's, and it is slow to answer: the
  // search cannot tell it is there. The window looks as before (count, selection, URLs before N),
  // and the tab now at N has a fresh document; the script must not take it.
  const app = userWindows();
  const s = loadSafari(app);
  const ours = app.tab(DEST, { name: MARKER, marker: MARKER });
  const theirs = userTab(app, LINK, { fresh: true });
  tabsOf(app, MINE).push(ours, theirs);
  Object.assign(s._st(), { hasOwnedTab: true, activeTabIndex: 2, activeTabURL: DEST, activeTabMarker: MARKER });
  const baseline = `${MINE}|3|false|https://mail.example.com/inbox`;
  tabsOf(app, MINE).splice(1, 2, theirs, ours);
  ours.hung = true;
  const tab = { idx: 2, win: `window id ${MINE}`, marker: MARKER, fp: baseline, since: Date.now() - 10, op: "navigate" };
  const out = await outcome(() => s._inTab(tab, "document.readyState", { stamp: true }));
  assert.match(out, /did not answer/);
  assert.doesNotMatch(out, /Tab tracking lost/, "a busy tab is not a lost one: the polls retry it");
  assert.deepEqual([theirs.name, theirs.marker, theirs.ran], ["", undefined, []], "the window's look proved the user's tab");
});

test("a step whose tab at its index does not answer stops, without searching or loading anything", async () => {
  // Right after the scan, a tab of the user's that is stuck in a dialog lands before the session's
  // tab. Its `do JavaScript` times out: the script ends there, so nothing runs later in its place.
  const { app, s, ours, before } = withOwnTab();
  let stuck = null;
  once(app, /set wid to/, () => {
    stuck = userTab(app);
    stuck.hung = true;
    tabsOf(app, MINE).splice(1, 0, stuck);
  });
  const out = await outcome(() => s.navigate(NEXT));
  assert.match(out, /timed out/);
  assert.deepEqual([ours.url, stuck.next, stuck.ran], [DEST, undefined, []]);
  assertUntouched(app, [ours], [...before, LINK]);
});
