#!/usr/bin/env node
/**
 * A session whose tabs the Safari extension opened fails closed the way one whose tabs
 * AppleScript opened does: once it has lost track of its tab, the AppleScript fallback refuses
 * to run instead of running in the tab the user is looking at. Default mode only (no
 * SAFARI_PROFILE): a named profile never falls back to AppleScript.
 *
 * Found by code reading on 28.9.26. Every fail-closed branch in safari.js keys on
 * `hasOwnedTab`, and only its own AppleScript newTab()/switchTab() set it, so for a session
 * whose tabs the extension opened it stayed false. Closing the current tab through the
 * extension then left the fallback aimed at the user's tab:
 *   - safari_close_tab left safari.js tracking the closed tab by index and URL. The URL no
 *     longer matched any tab, and the index named the tab that shifted into its place.
 *   - run_script closeTab cleared the index and URL, and runJS fell back to the front document.
 * The next call without a receipt whose extension attempt failed (a timeout, a CSP-blocked
 * evaluate) ran its JavaScript there. The identity guard runJS prefixes did not stop it: with
 * no marker of its own, the session refuses only tabs another MCP session marked.
 *
 * Both sides are the real code: extensionOrFallback with its ownership guard, the tool
 * handlers and run_script actions, and safari.js's session state and runJS, over a fake
 * Safari window that runs the identity guard the way Safari would.
 *
 * Run:  node --test test/extension-tab-fail-closed.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-failclosed-"));
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

const USER_URL = "https://mail.example.com/inbox"; // the tab the user is looking at
const USER2_URL = "https://docs.example.org/draft"; // a tab the user opens meanwhile
const A_URL = "https://a.example.com/start";
const B_URL = "https://b.example.com/work";

// ---------- a Safari window that answers safari.js's AppleScript ----------

// Tab i is tabs[i - 1]; the front document is the user's current tab. `name` is the tab's
// window.name. `ran` records the URL of every tab a script ran in.
function safariWindow(tabs) {
  const ran = [];
  const url = (i) => tabs[i - 1]?.url || "";
  const run = async (script) => {
    const js = script.match(/^tell application "Safari" to do JavaScript "([\s\S]*)" in (?:tab (\d+) of front window|front document)$/);
    if (js) {
      const tab = js[2] ? tabs[Number(js[2]) - 1] : tabs.find((t) => t.front);
      if (!tab) throw new Error(`AppleScript error: Safari got an error: Can’t get tab ${js[2]} of window 1. (-1728)`);
      // The identity guard: the tab must carry the session's marker; with none, it must not
      // carry another MCP session's.
      const marker = js[1].match(/window\.name!=='([^']*)'/);
      if (marker ? tab.name !== marker[1] : tab.name.startsWith("MCP_")) {
        throw new Error(`AppleScript error: ${marker ? "MCP_WRONG_TAB" : "MCP_FOREIGN_TAB"}`);
      }
      ran.push(tab.url);
      return tab.url;
    }
    const prefix = script.match(/starts with "([^"]*)"/);
    if (prefix) {
      // resolveActiveTab's URL strategy: the cached index, a URL prefix right to left, then the
      // domain (answered as a negative index), else "0:<tab count>".
      const cached = Number(script.match(/if tabCount >= (\d+) then/)?.[1]);
      if (cached && url(cached).startsWith(prefix[1])) return String(cached);
      for (let i = tabs.length; i >= 1; i--) if (url(i).startsWith(prefix[1])) return String(i);
      const domain = script.match(/contains "([^"]*)"/)[1];
      for (let i = tabs.length; i >= 1; i--) if (url(i).includes(domain)) return String(-i);
      return `0:${tabs.length}`;
    }
    throw new Error(`the fake window does not answer this AppleScript:\n${script}`);
  };
  return { tabs, ran, run };
}

// The extension's end of the bridge: it opens and closes tabs in that window, and every other
// command fails in a way that sends index.js to its AppleScript fallback — an evaluate comes
// back CSP-blocked, anything else times out.
function extension(window) {
  const byReceipt = new Map();
  return async (type, payload) => {
    if (type === "new_tab") {
      const tab = { url: payload.url, name: "" };
      const receipt = `Receipt${byReceipt.size}_${"r".repeat(24)}`;
      byReceipt.set(receipt, tab);
      window.tabs.push(tab);
      return { title: "", safeUrl: payload.url, receipt, tabIndex: window.tabs.length };
    }
    if (type === "close_tab") {
      const tab = byReceipt.get(payload.receipt);
      if (!tab) throw new Error("Tab safety: receipt did not resolve to a live tab");
      window.tabs.splice(window.tabs.indexOf(tab), 1);
      return "Tab closed";
    }
    if (type === "evaluate") return "Error: CSP blocked all strategies. Falling back to AppleScript";
    throw new Error(`Timeout waiting for the extension (${type})`);
  };
}

// ---------- safari.js, for real ----------

// The per-session tab state and its accessors, resolveActiveTab() and runJS().
const safariParts = [
  between(safariSource, "const _sessions = new Map();", "\n// ========== DIAGNOSTIC LOG"),
  between(safariSource, "function _assertNotFallingBackToUserTab(", "\n// ========== TAB IDENTITY MARKER"),
  between(safariSource, "export function getActiveTabIndex()", "\n// ========== FAST OSASCRIPT"),
  between(safariSource, "function _tabIdentityGuard(", "\n// Run large JavaScript via temp file"),
].join("\n");
const safariExports = [...safariParts.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);

function loadSafari(window) {
  const safari = new Function(
    "currentSessionId", "randomUUID", "osascript", "osascriptFast", "getTargetWindowRef",
    "refreshTargetWindow", "SAFARI_PROFILE", "console",
    `${safariParts.replace(/^export /gm, "")}\nreturn { _st, runJS, ${safariExports.join(", ")} };`
  )(
    () => "s1", () => "sess0001-0000-4000-8000-000000000000", window.run, window.run,
    () => "front window", async () => {}, null, { error() {} }
  );
  // What else index.js calls on these paths: focus bookkeeping around each extension command,
  // and the AppleScript fallbacks, which run their JavaScript in the session's tab through runJS.
  return Object.assign(safari, {
    saveFrontmostApp: async () => null,
    setFocusGuard() {},
    restoreFocusIfStolen: async () => {},
    readPage: () => safari.runJS("document.body.innerText"),
    evaluate: ({ script }) => safari.runJS(script),
  });
}

// ---------- index.js, for real ----------

// The receipt helpers, extensionOrFallback with its ownership guard, and run_script's actions.
const indexParts = [
  between(index, "function _originOf(", "\nfunction _isBatchSemanticFailure"),
  between(index, "function _untrackClosedTab(", "\n// Close all MCP-opened tabs on process exit"),
  between(index, "const _noOwnershipCheck = new Set([", "\n// run_script action names"),
  between(index, "async function _runExtensionBatchAction(", "\n// The cookie / localStorage / sessionStorage tools"),
].join("\n");

// The handler a server.tool(...) call registers.
function toolHandler(name) {
  const at = index.indexOf(`server.tool(\n  "${name}",`);
  assert.ok(at >= 0, `no ${name} tool`);
  const from = index.indexOf("async (", at);
  return index.slice(from, index.indexOf("\n);\n", from));
}

function loadServer(safari, sendToExtension) {
  const deps = {
    safari, sendToExtension, SESSION_ID: "daemon", currentSessionId: () => "s1",
    process: { env: {} }, console: { error() {} }, textResult, errorResult,
    _evictOldestTab: async () => null, _trackTab: own._trackTab, _untrackTab: own._untrackTab,
    _openedTabs: own._openedTabs, _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL,
    _markBlankTabOpened: own._markBlankTabOpened, _isURLOwned: own._isURLOwned,
    _isAdoptedURL: own._isAdoptedURL, BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    // The default mode, with the extension connected.
    _preferAppleScript: false, _extensionConnected: true, _commandTimeouts: {},
  };
  return new Function(
    ...Object.keys(deps),
    `${indexParts}
    return {
      run: _runExtensionBatchAction,
      safari_new_tab: ${toolHandler("safari_new_tab")},
      safari_close_tab: ${toolHandler("safari_close_tab")},
    };`
  )(...Object.values(deps));
}

// ---------- the session: the extension opened A, then B ----------

// Tab 1 is the user's current tab. The session opens A and then B through the extension, and
// the user opens a tab of their own after B.
async function session(open) {
  const window = safariWindow([{ url: USER_URL, name: "", front: true }]);
  const server = loadServer(loadSafari(window), extension(window));
  await open(server, A_URL);
  await open(server, B_URL);
  window.tabs.push({ url: USER2_URL, name: "" });
  return { window, server };
}

const CLOSES = [
  {
    name: "safari_close_tab", opener: "safari_new_tab",
    open: (s, url) => s.safari_new_tab({ url }), close: (s) => s.safari_close_tab({}),
  },
  {
    name: "run_script closeTab", opener: "run_script newTab",
    open: (s, url) => s.run("newTab", { url }), close: (s) => s.run("closeTab", {}),
  },
];
// Calls without a receipt. A read skips index.js's ownership guard; an evaluate passes it
// while the session still has another tab (A).
const CALLS = [
  { name: "a read", call: (s) => s.run("readPage", {}) },
  { name: "a CSP-blocked evaluate", call: (s) => s.run("evaluate", { script: "document.title" }) },
];

for (const path of CLOSES) {
  test(`a tab ${path.opener} opened through the extension is where a failed call falls back to`, async () => {
    const { window, server } = await session(path.open);
    assert.equal(await server.run("readPage", {}), B_URL);
    assert.deepEqual(window.ran, [B_URL]);
  });

  for (const call of CALLS) {
    test(`after ${path.name} closes the extension's tab, ${call.name} does not fall back to the user's tab`, async () => {
      const { window, server } = await session(path.open);
      await path.close(server);
      assert.deepEqual(window.tabs.map((t) => t.url), [USER_URL, A_URL, USER2_URL], "the extension closed B");
      await assert.rejects(call.call(server), /Tab tracking lost/);
      assert.deepEqual(window.ran, [], "the fallback ran in a tab the session does not own");
    });
  }
}

test("a session that never opened a tab still reads the page the user is looking at", async () => {
  const window = safariWindow([{ url: USER_URL, name: "", front: true }, { url: USER2_URL, name: "" }]);
  const server = loadServer(loadSafari(window), extension(window));
  assert.equal(await server.run("readPage", {}), USER_URL);
  assert.deepEqual(window.ran, [USER_URL]);
});
