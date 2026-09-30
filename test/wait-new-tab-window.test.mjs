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
    front: MINE, listings: 0, afterListing: () => {}, tab,
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
      const w = windowOf(listing[1]);
      return [String(w.id), ...w.tabs.map((t, i) => `${i + 1}\t\t${t.url}`)].join("\n");
    }
    const legacy = script.match(/repeat with t in every tab of (front window|window id \d+)\n/);
    if (legacy) return windowOf(legacy[1]).tabs.map((t, i) => `${i + 1}\t\t${t.url}`).join("\n");
    const page = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in tab (\d+) of (front window|window id \d+)$/);
    if (page) {
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
    `${indexParts}\nreturn { safari_wait_for_new_tab: ${toolHandler("safari_wait_for_new_tab")} };`
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
  assert.match(text(reply), /TIMEOUT/);
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
    if (type === "list_tabs" && listed++ === 0) return [{ index: 1, title: "", url: "https://app.example.org/login" }];
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
  const reply = await loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 });
  assert.match(text(reply), /TIMEOUT/);
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
      const tabs = [{ index: 1, title: "", url: "https://x.example/" }, { index: 2, title: "", url: "https://y.example/" }];
      return listed++ === 0 ? tabs : [...tabs, { index: 3, title: "", url: POPUP }];
    }
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
  app.front = THEIRS; // tab 3 of the front window is the user's shop tab
  await assert.rejects(loadServer(s, extension).safari_wait_for_new_tab({ timeout: 3000 }), /Tab safety/);
  assertUserTabsUnmarked(app);
  assert.equal(s._st().activeTabMarker, OURS);
});
