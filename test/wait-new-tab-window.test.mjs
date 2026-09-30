#!/usr/bin/env node
/**
 * safari_wait_for_new_tab's AppleScript fallback watches one window and claims the new tab there.
 * Default mode only (no SAFARI_PROFILE).
 *
 * Found on 29.9.26 by the review of the window-pinning fix: the handler listed `every tab of front
 * window` before the wait and at every poll, took the first `index:url` it had not seen once a poll
 * had more tabs, and claimed it with switchTab(i, { claim: true }), which stamps the session's own
 * marker on `tab i of front window`. When the user brought a window with more tabs to the front
 * while it waited, one of their tabs looked new and became the session's tab: later writes went
 * there, and every close path would close it. A listing from the extension compared with one from
 * AppleScript did the same across two ways of numbering tabs.
 * Now AppleScript lists the window its first listing read, by id, and claims in that window; a
 * listing from the other source starts the comparison over; and AppleScript never claims a tab
 * only the extension's listing saw.
 *
 * Found on 30.9.26 by the review of the switchTab marker fix: inside the pinned window too, the
 * first `index:url` pair not seen before was often a tab of the user's that had navigated during
 * the wait, or a tab that slid into the index of a popup still on about:blank. Now a new tab is one
 * on a URL no tab showed before, with every tab from before still there on its URL, in order. A
 * listing whose new tab cannot be told apart from an old one becomes the baseline instead of being
 * held against the older one, where the first of the two to navigate looked new; a URL any
 * baseline showed is never new; and a tab AppleScript listed is claimed through AppleScript at once.
 *
 * Both sides are the real code: index.js's safari_wait_for_new_tab handler and extensionOrFallback,
 * and safari.js's session state, listWindowTabs() and switchTab(), over a fake Safari with two
 * windows, on a clock the waits advance.
 *
 * Run:  node --test test/wait-new-tab-window.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-wait-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
const { textResult, errorResult } = await import("../response.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
});

const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const MINE = 11; // the session's window
const THEIRS = 22; // the user's other window
const OURS = "MCP_sess0001_mine";
const POPUP = "https://sso.example.net/authorize";

// ---------- a Safari with two windows ----------

// Each window is { id, tabs }; tab i is tabs[i - 1], and a tab is { url, marker } with `marker` its
// window.name. The listing and the claim run as Safari runs them; `afterListing(n)` runs after the
// n-th listing, so a test can move the user's windows while the wait polls.
function safari() {
  const tab = (url, marker = "") => ({ url, marker });
  const app = {
    front: MINE, listings: 0, pages: 0, afterListing: () => {}, tab,
    windows: [
      { id: MINE, tabs: [tab("https://mail.example.com/"), tab("https://app.example.org/login", OURS)] },
      { id: THEIRS, tabs: [tab("https://docs.example.com/"), tab("https://bank.example.com/"), tab("https://shop.example.com/")] },
    ],
  };
  const windowOf = (ref) => {
    const w = ref === "front window" ? app.windows.find((x) => x.id === app.front) : app.windows.find((x) => `window id ${x.id}` === ref);
    if (!w) throw new Error(`Safari got an error: Can’t get ${ref}. (-1728)`);
    return w;
  };
  const answer = (script) => {
    const listing = script.match(/set w to (front window|window id \d+)\n\s*set output to \(id of w\) as text\n/);
    if (listing) {
      // The id it reports and the tabs it walks must be the same window's.
      const walks = script.match(/repeat with t in every tab of (.+)\n/)?.[1];
      if (walks !== "w") throw new Error(`the fake Safari lists the window \`set w\` names, not ${walks}:\n${script}`);
      const w = windowOf(listing[1]);
      return [String(w.id), ...w.tabs.map((t, i) => `${i + 1}\t\t${t.url}`)].join("\n");
    }
    const legacy = script.match(/repeat with t in every tab of (front window|window id \d+)\n/);
    if (legacy) return windowOf(legacy[1]).tabs.map((t, i) => `${i + 1}\t\t${t.url}`).join("\n");
    const page = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in tab (\d+) of (front window|window id \d+)$/);
    if (page) {
      app.pages++;
      const t = windowOf(page[3]).tabs[Number(page[2]) - 1];
      if (!t) throw new Error(`Safari got an error: Can’t get tab ${page[2]}. (-1719)`);
      const win = { name: t.marker };
      try {
        return String(vm.runInNewContext(page[1].replace(/\\(["\\])/g, "$1"), { window: win, document: { title: "" }, location: { href: t.url } }) ?? "");
      } finally {
        t.marker = win.name;
      }
    }
    throw new Error(`the fake Safari does not answer this AppleScript:\n${script}`);
  };
  app.run = async (script) => {
    const result = answer(script);
    if (/every tab of/.test(script)) app.afterListing(++app.listings);
    return result;
  };
  return app;
}

// ---------- safari.js, for real ----------

const safariParts = [
  between(safariSource, "const _sessions = new Map();", "\n// ========== DIAGNOSTIC LOG"),
  between(safariSource, "function _buildStampJS(", "\n// Quick JS execution"),
  between(safariSource, "export function getActiveTabIndex()", "\n// ========== FAST OSASCRIPT"),
  between(safariSource, "export async function listTabs(", "\n// `onMarker(marker)` hears"),
  between(safariSource, "export async function switchTab(", "\n// ========== WAIT"),
].join("\n");
const safariExports = [...safariParts.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

function loadSafari(app) {
  const s = new Function(
    "currentSessionId", "randomUUID", "osascript", "osascriptFast", "getTargetWindowRef",
    "refreshTargetWindow", "console",
    `${safariParts.replace(/^export /gm, "")}\nreturn { _st, ${safariExports.join(", ")} };`
  )(() => "s1", () => "sess0001-0000-4000-8000-000000000000", app.run, app.run, () => "front window", async () => {}, { error() {} });
  // The session's tab is tab 2 of MINE, opened through AppleScript.
  Object.assign(s._st(), { hasOwnedTab: true, activeTabIndex: 2, activeTabURL: "https://app.example.org/login", activeTabMarker: OURS });
  return Object.assign(s, { saveFrontmostApp: async () => null, setFocusGuard() {}, restoreFocusIfStolen: async () => {} });
}

// ---------- index.js, for real ----------

const indexParts = [
  between(index, "function _originOf(", "\nfunction _isBatchSemanticFailure"),
  between(index, "function _untrackClosedTab(", "\n// Close all MCP-opened tabs on process exit"),
  between(index, "const _noOwnershipCheck = new Set([", "\n// Origin of a URL"),
  between(index, "async function _runExtensionBatchAction(", "\n// The cookie / localStorage / sessionStorage tools"),
].join("\n");

function toolHandler(name) {
  const at = index.indexOf(`server.tool(\n  "${name}",`);
  assert.ok(at >= 0, `no ${name} tool`);
  const from = index.indexOf("async (", at);
  return index.slice(from, index.indexOf("\n);\n", from));
}

// `extension` answers extension commands; by default every one times out, which sends index.js
// to its AppleScript fallback. The waits advance a clock instead of real time.
function loadServer(safari, extension = async (type) => { throw new Error(`Timeout waiting for the extension (${type})`); }) {
  const clock = { now: 0 };
  const deps = {
    safari, sendToExtension: extension, SESSION_ID: "daemon", currentSessionId: () => "s1",
    process: { env: {} }, console: { error() {} }, textResult, errorResult,
    _evictOldestTab: async () => null, _trackTab: own._trackTab, _untrackTab: own._untrackTab,
    _openedTabs: own._openedTabs, _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL,
    _removeOwnedURL: own._removeOwnedURL, _markBlankTabOpened: own._markBlankTabOpened, _isURLOwned: own._isURLOwned,
    _trackedAtIndex: own._trackedAtIndex, allowUserTabs: own.allowUserTabs, BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    _preferAppleScript: false, _extensionConnected: true, _commandTimeouts: {},
    setTimeout: (fn, ms) => { clock.now += ms; setImmediate(fn); },
    Date: { now: () => clock.now },
  };
  return new Function(
    ...Object.keys(deps),
    `${indexParts}\nreturn { safari_wait_for_new_tab: ${toolHandler("safari_wait_for_new_tab")}, _getActiveReceipt, _setActiveReceipt };`
  )(...Object.values(deps));
}

const userTabs = (app) => app.windows.flatMap((w) => w.tabs).filter((t) => t.marker !== OURS && t.url !== POPUP);
function assertUserTabsUnmarked(app) {
  for (const t of userTabs(app)) assert.equal(t.marker, "", `the user's tab on ${t.url} got the marker ${t.marker}`);
}
const text = (reply) => reply.content[0].text;

// ---------- the tests ----------

test("while it waits, the user's other window coming forward makes none of their tabs the session's", async () => {
  const app = safari();
  const s = loadSafari(app);
  app.afterListing = (n) => { if (n === 1) app.front = THEIRS; };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.equal(text(reply), "TIMEOUT: no new tab appeared");
  assertUserTabsUnmarked(app);
  assert.equal(s._st().activeTabMarker, OURS, "the session moved to a tab it did not open");
  assert.deepEqual([...own._openedTabs.values()], [], "a tab of the user's was recorded as one the session opened");
});

test("a tab that opens in the session's window is claimed there while the user's window is in front", async () => {
  const app = safari();
  const s = loadSafari(app);
  app.afterListing = (n) => {
    if (n !== 1) return;
    app.front = THEIRS;
    app.windows[0].tabs.push(app.tab(POPUP));
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  const popup = app.windows[0].tabs[2];
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assert.equal(s._st().activeTabIndex, 3);
  assertUserTabsUnmarked(app);
});

test("a listing from the extension is not compared with one from AppleScript", async () => {
  const app = safari();
  const s = loadSafari(app);
  // The extension answers the first listing with its own view (the session's tab alone), then
  // stops answering: AppleScript lists MINE, which has one tab more than that view.
  let listed = 0;
  const extension = async (type) => {
    if (type === "list_tabs" && listed++ === 0) return [{ index: 1, title: "", safeUrl: "https://app.example.org/login" }];
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
  const reply = await loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 });
  assert.equal(text(reply), "TIMEOUT: no new tab appeared", "a listing with more tabs from the other source read as a tab opening");
  assertUserTabsUnmarked(app);
  assert.equal(s._st().activeTabMarker, OURS);
});

test("AppleScript does not claim a tab only the extension's listing saw", async () => {
  const app = safari();
  const s = loadSafari(app);
  // The extension lists a new tab at 3, then cannot switch to it.
  let listed = 0;
  const extension = async (type) => {
    if (type === "list_tabs") {
      const tabs = [{ index: 1, title: "", safeUrl: "https://x.example/" }, { index: 2, title: "", safeUrl: "https://y.example/" }];
      return listed++ === 0 ? tabs : [...tabs, { index: 3, title: "", safeUrl: POPUP }];
    }
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
  app.front = THEIRS; // tab 3 of the front window is the user's shop tab
  await assert.rejects(loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 }), (err) => {
    assert.match(err.message, /^Tab safety: a new tab opened, but the Safari extension could not switch to it/);
    // A new wait starts from a listing that already has the tab, so it can only time out.
    assert.doesNotMatch(err.message, /Retry safari_wait_for_new_tab/);
    return true;
  });
  assert.equal(app.pages, 0, "AppleScript ran a claim in a tab of the window in front");
  assertUserTabsUnmarked(app);
  assert.equal(s._st().activeTabMarker, OURS);
});

// The user's tab on https://mail.example.com/ is tab 1 of the session's window, the session's tab 2.
const INBOX = "https://mail.example.com/inbox/2";
const openedURLs = () => [...own._openedTabs.values()].map((t) => t.url);

test("a tab of the user's that navigated earlier in the wait is not the one that opened", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  app.afterListing = (n) => {
    if (n === 1) mine[0].url = INBOX;
    if (n === 2) mine.push(app.tab(POPUP));
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(mine[2].marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assertUserTabsUnmarked(app);
  assert.deepEqual(openedURLs(), [POPUP]);
});

test("a tab of the user's that navigates in the poll a tab opens in makes neither the session's", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  app.afterListing = (n) => {
    if (n !== 1) return;
    mine[0].url = INBOX;
    mine.push(app.tab(POPUP));
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  // A tab opened and stays open unclaimed: a new wait would not report it.
  assert.match(text(reply), /^TIMEOUT: a tab opened during the wait/);
  assertUserTabsUnmarked(app);
  assert.equal(s._st().activeTabMarker, OURS);
  assert.deepEqual(openedURLs(), []);
});

// The session's tab first, the user's mail tab after it: a new tab opens on the mail page, next to
// the session's tab or after the user's, and then one of the two moves on. By URL, either could be
// the new one, whichever moves first.
const SAME_PAGE = [
  { name: "the new one moves first", at: 1, moves: "popup" },
  { name: "the user's moves first", at: 1, moves: "user" },
  { name: "it opens after the user's tab, and the user's moves first", at: 2, moves: "user" },
];
for (const c of SAME_PAGE) {
  test(`a tab that opens on the page a tab of the user's shows makes neither the session's: ${c.name}`, async () => {
    const app = safari();
    const s = loadSafari(app);
    const mine = app.windows[0].tabs;
    mine.reverse();
    s._st().activeTabIndex = 1;
    const user = mine[1];
    const popup = app.tab(user.url);
    app.afterListing = (n) => {
      if (n === 1) mine.splice(c.at, 0, popup);
      if (n === 3) (c.moves === "popup" ? popup : user).url = c.moves === "popup" ? POPUP : INBOX;
    };
    const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
    assert.match(text(reply), /TIMEOUT/);
    assert.equal(user.marker, "", "the user's tab got the session's marker");
    assert.equal(popup.marker, "", "a tab no listing could tell apart was claimed");
    assert.equal(s._st().activeTabMarker, OURS);
    assert.deepEqual(openedURLs(), []);
  });
}

test("a popup still on about:blank is claimed where it went when a tab to its left closes, not the tab that slid into its place", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  mine.push(app.tab("https://news.example.com/")); // the user's tab 3
  const popup = app.tab("about:blank");
  app.afterListing = (n) => {
    if (n === 1) mine.splice(2, 0, popup); // opens as tab 3, before the user's news tab
    if (n === 2) mine.shift(); // the user closes their mail tab: news is tab 3 now
    if (n === 4) popup.url = POPUP;
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assertUserTabsUnmarked(app);
  assert.deepEqual(openedURLs(), [POPUP]);
});

test("a popup that opens on about:blank is claimed once it shows its URL", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const popup = app.tab("about:blank");
  app.afterListing = (n) => {
    if (n === 1) mine.push(popup);
    if (n === 3) popup.url = POPUP;
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assertUserTabsUnmarked(app);
  assert.deepEqual(openedURLs(), [POPUP]);
});

test("a tab of the user's that navigates while one opens on a page the window shows makes neither the session's", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  app.afterListing = (n) => {
    if (n !== 1) return;
    mine[0].url = INBOX;
    mine.push(app.tab(mine[1].url)); // a new tab on the session's page: the count of old URLs still adds up
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /TIMEOUT/);
  assertUserTabsUnmarked(app);
  assert.equal(s._st().activeTabMarker, OURS);
  assert.deepEqual(openedURLs(), []);
});

test("a tab another session opened meanwhile, which the claim refuses, does not end the wait", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  // Another session's new tab carries that session's marker: switchTab's claim refuses it
  // (`otherSession`) and stamps nothing.
  const theirs = app.tab("https://other.example.com/", "MCP_sess0002_theirs");
  app.afterListing = (n) => {
    if (n === 1) mine.push(theirs);
    if (n === 3) mine.push(app.tab(POPUP));
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(mine[3].marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assert.equal(theirs.marker, "MCP_sess0002_theirs", "the other session's tab lost its marker");
  for (const t of userTabs(app).filter((t) => t !== theirs)) assert.equal(t.marker, "", `the user's tab on ${t.url} got a marker`);
  assert.deepEqual(openedURLs(), [POPUP]);
});


// ---------- the user's tab after the session's ----------

function sessionFirst() {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  mine.reverse(); // the session's tab 1, the user's mail tab 2
  s._st().activeTabIndex = 1;
  return { app, s, mine, user: mine[1] };
}

test("a tab of the user's after the session's that navigates in the poll a tab opens in makes neither the session's", async () => {
  const { app, s, mine, user } = sessionFirst();
  app.afterListing = (n) => {
    if (n !== 1) return;
    user.url = INBOX;
    mine.push(app.tab(POPUP));
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /TIMEOUT/);
  assertUserTabsUnmarked(app);
  assert.deepEqual(openedURLs(), []);
});

test("a tab of the user's after the session's that navigates while one opens on the session's page makes neither the session's", async () => {
  const { app, s, mine, user } = sessionFirst();
  app.afterListing = (n) => {
    if (n !== 1) return;
    user.url = INBOX;
    mine.push(app.tab(mine[0].url));
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /TIMEOUT/);
  assertUserTabsUnmarked(app);
  assert.deepEqual(openedURLs(), []);
});

test("a tab of the user's that navigates while one opens elsewhere on the page it left makes neither the session's", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const user = mine[0];
  const left = user.url;
  // By URL alone the new tab could have been the user's, which moved to the end: the old URLs are
  // all still there, but not in their order, so this claims nothing rather than guess.
  app.afterListing = (n) => {
    if (n !== 1) return;
    user.url = INBOX;
    mine.push(app.tab(left));
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /TIMEOUT/);
  assertUserTabsUnmarked(app);
  assert.deepEqual(openedURLs(), []);
});

test("a tab of the user's that navigates while a popup loads is never taken for the popup", async () => {
  const { app, s, mine, user } = sessionFirst();
  const popup = app.tab("about:blank");
  app.afterListing = (n) => {
    if (n === 1) mine.push(popup);
    if (n === 2) user.url = INBOX;
    if (n === 3) popup.url = POPUP;
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assert.equal(user.marker, "", "the user's tab got the session's marker");
  assert.deepEqual(openedURLs(), [POPUP]);
});

test("a popup that opens after a tab of the user's closed is claimed", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  mine.push(app.tab("https://news.example.com/"));
  app.afterListing = (n) => {
    if (n === 1) mine.pop();
    if (n === 2) mine.push(app.tab(POPUP));
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(mine[2].marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assert.deepEqual(openedURLs(), [POPUP]);
});

// A tab of the user's leaves the window and comes back (closed by accident and reopened, or dragged
// out and in again): on the page it showed when the wait began, or on one it moved to meanwhile.
const COMES_BACK = [
  { name: "on the page it showed", moves: false },
  { name: "on the page it moved to while the wait ran", moves: true },
];
for (const c of COMES_BACK) {
  test(`a tab of the user's that closes and comes back ${c.name} is not the one that opened, and a popup after it is`, async () => {
    const app = safari();
    const s = loadSafari(app);
    const mine = app.windows[0].tabs;
    const user = mine[0];
    const steps = [
      ...(c.moves ? [() => { user.url = INBOX; }] : []),
      () => mine.shift(),
      () => mine.unshift(user),
      () => {},
      () => mine.push(app.tab(POPUP)),
    ];
    app.afterListing = (n) => steps[n - 1]?.();
    const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 4000 });
    assert.match(text(reply), /Found new tab/);
    assert.equal(user.marker, "", "the user's tab that came back got the session's marker");
    assert.equal(mine[2].marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
    assert.deepEqual(openedURLs(), [POPUP]);
  });
}

test("an AppleScript listing that does not say which window it read claims nothing", async () => {
  const app = safari();
  const run = app.run;
  app.run = async (script) => {
    const out = await run(script);
    return /set output to \(id of w\)/.test(script) ? out.replace(/^\d+/, "missing value") : out;
  };
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  app.afterListing = (n) => { if (n === 1) mine.push(app.tab(POPUP)); };
  await assert.rejects(loadServer(s).safari_wait_for_new_tab({ timeout: 3000 }), (err) => {
    assert.match(err.message, /^Tab safety: AppleScript did not say which window it listed/);
    assert.doesNotMatch(err.message, /Retry safari_wait_for_new_tab/);
    return true;
  });
  assert.equal(mine[2].marker, "", "a tab was claimed in a window no listing named");
  assert.equal(s._st().activeTabMarker, OURS);
});

test("urlContains skips new tabs on other pages, and one still on about:blank, in the same poll", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const [blank, ad, popup] = [app.tab("about:blank"), app.tab("https://ads.example.com/"), app.tab(POPUP)];
  app.afterListing = (n) => { if (n === 1) mine.push(blank, ad, popup); };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000, urlContains: "sso.example.net" });
  assert.match(text(reply), /Found new tab/);
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assert.equal(ad.marker, "", "a tab urlContains rules out was claimed");
  assert.equal(blank.marker, "", "a tab still on about:blank was claimed");
});

// ---------- the extension's listings ----------

// An extension that lists `tabs()` as the real one does (`safeUrl`, no `url`) and switches to
// whatever index it is asked for, recording it: the real one switches only to a tab the session
// owns (one it opened), and refuses a popup the page opened, as a test below shows.
function listingExtension(tabs) {
  const switched = [];
  const extension = async (type, payload) => {
    if (type === "list_tabs") return tabs().map((u, i) => ({ index: i + 1, title: "", safeUrl: u }));
    if (type === "switch_tab") {
      switched.push(payload.index);
      return { title: "", safeUrl: tabs()[payload.index - 1], receipt: "Receipt_" + "p".repeat(24), tabIndex: payload.index, owned: true };
    }
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
  return { extension, switched };
}
const X = "https://x.example/", Y = "https://y.example/";

test("the extension's listings are compared by safeUrl, and urlContains reads it", async () => {
  const s = loadSafari(safari());
  let listed = 0;
  const { extension, switched } = listingExtension(() => (listed++ < 1 ? [X, Y] : [X, Y, POPUP]));
  const reply = await loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000, urlContains: "sso.example.net" });
  assert.match(text(reply), /Found new tab: .*\(https:\/\/sso\.example\.net\/authorize\)/);
  assert.deepEqual(switched, [3]);
});

test("a tab the extension lists between two others is the one it switches to", async () => {
  const s = loadSafari(safari());
  let listed = 0;
  const { extension, switched } = listingExtension(() => (listed++ < 1 ? [X, Y] : [X, POPUP, Y]));
  await loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 });
  assert.deepEqual(switched, [2]);
});

test("a tab the extension lists on about:blank is switched to once it shows its URL", async () => {
  const s = loadSafari(safari());
  let listed = 0;
  const { extension, switched } = listingExtension(() => [X, Y, ...(listed++ < 1 ? [] : [listed < 4 ? "about:blank" : POPUP])]);
  const reply = await loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /sso\.example\.net/);
  assert.deepEqual(switched, [3]);
});

test("a tab AppleScript listed is claimed through AppleScript, without asking the extension first", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  // The extension does not answer list_tabs but would answer switch_tab: its switch goes by its
  // own window's numbering, and a busy worker kept the claim waiting for it.
  const switched = [];
  const extension = async (type, payload) => {
    if (type === "switch_tab") {
      switched.push(payload.index);
      return { title: "", safeUrl: POPUP, receipt: "Receipt_" + "p".repeat(24), tabIndex: payload.index, owned: true };
    }
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
  app.afterListing = (n) => { if (n === 1) mine.push(app.tab(POPUP)); };
  const reply = await loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.deepEqual(switched, [], "the extension was asked to switch to an index AppleScript listed");
  assert.equal(mine[2].marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
});

test("a claim whose index another tab slid under is refused, and the wait claims the popup where it went", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const popup = app.tab(POPUP);
  const news = app.tab("https://news.example.com/");
  // The listing sees the popup at 3; before the claim runs, the user opens a tab to its left, so
  // tab 3 is theirs by then. The claim names the URL the listing saw and refuses (`moved`).
  app.afterListing = (n) => {
    if (n === 1) mine.push(popup);
    if (n === 2) mine.splice(2, 0, news);
  };
  const claims = [];
  const claim = s.switchTab;
  s.switchTab = async (i, opts) => {
    claims.push([i, opts.expectUrl]);
    return claim(i, opts);
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000, urlContains: "sso.example.net" });
  assert.match(text(reply), /Found new tab/);
  assert.deepEqual(claims, [[3, POPUP], [4, POPUP]], "the claim did not name the URL the listing saw, or was not refused");
  assert.equal(news.marker, "", "the user's tab that slid under the index got the session's marker");
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assertUserTabsUnmarked(app);
  assert.deepEqual(openedURLs(), [POPUP]);
});

// AppleScript answers the first listing, which pins the session's window, and the extension the
// rest: it lists a new tab, first on about:blank or not, and then cannot switch to it.
for (const blankFirst of [false, true]) {
  test(`a tab the extension listed after AppleScript pinned the window is not claimed through AppleScript${blankFirst ? ", from about:blank" : ""}`, async () => {
    const app = safari();
    const s = loadSafari(app);
    app.afterListing = (n) => { if (n === 1) app.windows[0].tabs.push(app.tab("https://news.example.com/")); };
    let listed = 0;
    const extension = async (type) => {
      if (type === "list_tabs" && listed++ > 0) {
        const rows = [{ index: 1, title: "", safeUrl: X }, { index: 2, title: "", safeUrl: Y }];
        if (listed > 2) rows.push({ index: 3, title: "", safeUrl: blankFirst && listed === 3 ? "about:blank" : POPUP });
        return rows;
      }
      throw new Error(`Timeout waiting for the extension (${type})`);
    };
    await assert.rejects(loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 }), /Tab safety: a new tab opened, but the Safari extension could not switch to it/);
    assert.equal(app.listings, 1, "AppleScript did not answer the first listing, so it pinned no window");
    assert.equal(app.pages, 0, "AppleScript ran a claim in the pinned window");
    assertUserTabsUnmarked(app);
    assert.equal(s._st().activeTabMarker, OURS);
  });
}

// ---------- a new tab not claimed yet, while other tabs change ----------

const AUTH_START = "https://app.example.org/auth/start";

test("a popup urlContains rules out for now stays new while a tab of the user's navigates, and is claimed once it matches", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const popup = app.tab(AUTH_START);
  app.afterListing = (n) => {
    if (n === 1) mine.push(popup);
    if (n === 3) mine[0].url = INBOX;
    if (n === 5) popup.url = POPUP;
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 5000, urlContains: "sso.example.net" });
  assert.match(text(reply), /Found new tab/);
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assertUserTabsUnmarked(app);
  assert.deepEqual(openedURLs(), [POPUP]);
});

test("a popup still on about:blank stays new while the session's own tab navigates", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const popup = app.tab("about:blank");
  app.afterListing = (n) => {
    if (n === 1) mine.push(popup);
    if (n === 2) mine[1].url = "https://app.example.org/login?pending=1";
    if (n === 3) popup.url = POPUP;
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assertUserTabsUnmarked(app);
});

test("a popup on about:blank that a tab of the user's joins on about:blank cannot be told apart, and nothing is claimed", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const popup = app.tab("about:blank");
  app.afterListing = (n) => {
    if (n === 1) mine.push(popup);
    if (n === 2) mine[0].url = "about:blank";
    if (n === 3) popup.url = POPUP;
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /^TIMEOUT: a tab opened during the wait/);
  assertUserTabsUnmarked(app);
  assert.equal(popup.marker, "");
  assert.deepEqual(openedURLs(), []);
});

test("a popup that closes as a tab of the user's lands on its URL leaves the user's tab old", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const user = mine[0];
  app.afterListing = (n) => {
    if (n === 1) mine.push(app.tab(AUTH_START));
    if (n === 2) {
      mine.pop(); // the popup closes
      user.url = AUTH_START; // as the user's tab lands on the page it showed
    }
    if (n === 3) user.url = POPUP; // and then moves on to a page urlContains matches
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000, urlContains: "sso.example.net" });
  assert.match(text(reply), /TIMEOUT/);
  assert.equal(user.marker, "", "the user's tab got the session's marker");
  assert.deepEqual(openedURLs(), []);
});

// ---------- what a claim records ----------

test("a claim through AppleScript records the popup by its marker and clears the receipt of the tab before", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const popup = app.tab(POPUP);
  app.afterListing = (n) => { if (n === 1) mine.push(popup); };
  const server = loadServer(s);
  server._setActiveReceipt("Receipt_" + "o".repeat(24));
  await server.safari_wait_for_new_tab({ timeout: 3000 });
  assert.deepEqual(
    [...own._openedTabs].map(([key, t]) => [key, t.marker, t.receipt, t.sessionId, t.url]),
    [[popup.marker, popup.marker, "", "daemon:s1", POPUP]]
  );
  assert.equal(server._getActiveReceipt(), "", "the receipt of the tab before still names the session's tab");
});

test("a claim the extension serves records the tab by its receipt and leaves its URL unknown", async () => {
  const s = loadSafari(safari());
  let listed = 0;
  const { extension } = listingExtension(() => (listed++ < 1 ? [X, Y] : [X, Y, POPUP]));
  const server = loadServer(s, extension);
  await server.safari_wait_for_new_tab({ timeout: 3000 });
  const receipt = "Receipt_" + "p".repeat(24);
  assert.deepEqual([...own._openedTabs].map(([key, t]) => [key, t.marker, t.receipt]), [[receipt, "", receipt]]);
  assert.equal(server._getActiveReceipt(), receipt);
  assert.equal(s.getActiveTabURL(), null);
});

// ---------- the extension's switch ----------

test("the extension's refusal of a popup the page opened ends the wait, with no AppleScript claim", async () => {
  const app = safari();
  const s = loadSafari(app);
  let listed = 0;
  const asked = [];
  const extension = async (type, payload) => {
    if (type === "list_tabs") return (listed++ < 1 ? [X, Y] : [X, Y, POPUP]).map((u, i) => ({ index: i + 1, title: "", safeUrl: u }));
    if (type === "switch_tab") {
      asked.push(payload.index);
      throw new Error("⚠️ Tab safety: refusing \"switch_tab\" to tab 104 (https://sso.example.net/authorize) — not opened by this MCP session. Use safari_new_tab first.");
    }
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
  await assert.rejects(loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 }), /not opened by this MCP session/);
  assert.deepEqual(asked, [3]);
  assert.equal(app.pages, 0, "AppleScript ran a claim");
  assert.deepEqual(openedURLs(), []);
});

for (const [name, wrong] of [
  ["answers that no tab is there", "Tab not found at index 3"],
  ["switches to another tab of the session's", { title: "", safeUrl: "https://older.example.com/", receipt: "Receipt_" + "q".repeat(24), tabIndex: 3, owned: true }],
]) {
  test(`an extension switch that ${name} is not taken for the new tab`, async () => {
    const s = loadSafari(safari());
    let listed = 0;
    const receipt = "Receipt_" + "p".repeat(24);
    const answers = [];
    const extension = async (type, payload) => {
      if (type === "list_tabs") return (listed++ < 1 ? [X, Y] : [X, Y, POPUP]).map((u, i) => ({ index: i + 1, title: "", safeUrl: u }));
      if (type === "switch_tab") {
        answers.push(payload.index);
        return answers.length === 1 ? wrong : { title: "", safeUrl: POPUP, receipt, tabIndex: payload.index, owned: true };
      }
      throw new Error(`Timeout waiting for the extension (${type})`);
    };
    const reply = await loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 });
    assert.match(text(reply), /Found new tab/);
    assert.deepEqual(answers, [3, 3], "the first switch was taken for the new tab");
    assert.deepEqual([...own._openedTabs.keys()], [receipt], "the switch that went wrong was recorded");
  });
}

test("a popup still on about:blank stays new through two changes of other tabs in a row", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const popup = app.tab("about:blank");
  app.afterListing = (n) => {
    if (n === 1) mine.push(popup);
    if (n === 2) mine[0].url = INBOX;
    if (n === 3) mine[1].url = "https://app.example.org/login?pending=1";
    if (n === 4) popup.url = POPUP;
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assertUserTabsUnmarked(app);
});

test("a claim refused because a tab to the popup's left closed is made again where the popup went", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const news = app.tab("https://news.example.com/");
  mine.push(news);
  const popup = app.tab(POPUP);
  app.afterListing = (n) => {
    if (n === 1) mine.splice(2, 0, popup); // listed next as tab 3, before the user's news tab
    if (n === 2) mine.shift(); // and before the claim runs, the user's mail tab closes: news is tab 3
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(news.marker, "", "the user's tab that slid under the index got the session's marker");
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assert.deepEqual(openedURLs(), [POPUP]);
});

test("a tab that opens but that urlContains never matches ends in the reply that a tab opened", async () => {
  const app = safari();
  const s = loadSafari(app);
  app.afterListing = (n) => { if (n === 1) app.windows[0].tabs.push(app.tab("https://ads.example.com/")); };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000, urlContains: "sso.example.net" });
  assert.match(text(reply), /^TIMEOUT: a tab opened during the wait/);
  assertUserTabsUnmarked(app);
});

test("a popup still on about:blank stays new when a tab of the user's closes and then another navigates", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const news = app.tab("https://news.example.com/");
  mine.push(news);
  const popup = app.tab("about:blank");
  app.afterListing = (n) => {
    if (n === 1) mine.splice(2, 0, popup);
    if (n === 2) mine.shift(); // the user's mail tab closes
    if (n === 3) news.url = "https://news.example.com/story";
    if (n === 4) popup.url = POPUP;
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /Found new tab/);
  assert.equal(popup.marker, s._st().activeTabMarker, "the popup does not carry the session's marker");
  assertUserTabsUnmarked(app);
});

test("a popup that closes as a tab of the user's lands on its URL and another tab opens leaves the user's tab old", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const user = mine[0];
  app.afterListing = (n) => {
    if (n === 1) mine.push(app.tab(AUTH_START));
    if (n === 2) {
      mine.pop(); // the popup closes,
      user.url = AUTH_START; // the user's tab lands on the page it showed,
      mine.push(app.tab("https://ads.example.com/")); // and a tab opens: as many tabs as before
    }
    if (n === 3) user.url = POPUP;
  };
  const reply = await loadServer(s).safari_wait_for_new_tab({ timeout: 3000, urlContains: "sso.example.net" });
  assert.match(text(reply), /TIMEOUT/);
  assert.equal(user.marker, "", "the user's tab got the session's marker");
  assert.deepEqual(openedURLs(), []);
});

test("a popup seen in AppleScript's listing is taken into the baseline when the extension takes over the listing", async () => {
  const app = safari();
  const s = loadSafari(app);
  const mine = app.windows[0].tabs;
  const popup = app.tab("about:blank");
  let listed = 0;
  const extension = async (type, payload) => {
    if (type === "list_tabs") {
      // AppleScript answers the first two listings, the extension the rest; the popup loads just
      // after the extension first lists it, still on about:blank.
      if (++listed <= 2) throw new Error("Timeout waiting for the extension (list_tabs)");
      const rows = mine.map((t, i) => ({ index: i + 1, title: "", safeUrl: t.url }));
      if (listed === 3) popup.url = POPUP;
      return rows;
    }
    if (type === "switch_tab") return { title: "", safeUrl: mine[payload.index - 1].url, receipt: "Receipt_" + "p".repeat(24), tabIndex: payload.index, owned: true };
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
  app.afterListing = (n) => { if (n === 1) mine.push(popup); };
  const reply = await loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 });
  // The two sources number and name tabs differently: a tab one of them saw as new starts over as old.
  assert.match(text(reply), /TIMEOUT/);
  assert.equal(app.listings, 2);
  assert.deepEqual(openedURLs(), []);
});

