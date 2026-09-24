#!/usr/bin/env node
/**
 * Shutdown cleanup and tab eviction must resolve the tab they close by its identity
 * marker, never by the URL recorded when it was opened. Regression test for #112.
 *
 * The reported failure: the MCP tab is opened on /a and clicks through to /b, the user
 * still has a tab of their own on /a, and `_cleanupTabs()` matched `t.url === '/a'` —
 * closing the user's tab and leaving the MCP tab open. Two tabs on an identical URL fail
 * the same way without any navigation, because `find` returns the first (older) one.
 *
 * Source-level like close-tab-ownership (#68): these paths run at process exit and inside
 * the memory monitor, where no behavioural test over the healthy tool surface reaches them.
 *
 * Run:  node --test test/cleanup-tab-identity.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `could not extract ${startNeedle}`);
  return source.slice(start, end).trim();
}

const cleanupSource = sourceBetween(
  index,
  "async function _verifiedTabIndex(info) {",
  "\n// Periodic memory check"
);

// Build the extracted pair over a fake Safari. `tabs` is the live window: each entry is
// the index, the URL currently loaded, and the marker stamped on that tab (if any).
function makeCleanup({ opened, tabs, env = {} }) {
  const closed = [];
  const _openedTabs = new Map(opened.map((info, i) => [info.recordedIndex ?? i + 1, info]));
  const safari = {
    async findTabByMarker(marker) {
      if (!marker) return null;
      const hit = tabs.find(t => t.marker === marker);
      return hit ? hit.index : null;
    },
    async closeTab(index) {
      closed.push(index);
      const at = tabs.findIndex(t => t.index === index);
      assert.ok(at >= 0, `closeTab called with index ${index}, which is not an open tab`);
      tabs.splice(at, 1);
      // Safari renumbers: every tab after the closed one shifts down by one.
      for (const t of tabs) if (t.index > index) t.index -= 1;
    },
    async listTabs() {
      throw new Error("cleanup must not fall back to a URL lookup over listTabs()");
    },
  };
  const fn = new Function(
    "safari", "_openedTabs", "console", "process",
    `${cleanupSource}; return { _cleanupTabs, _verifiedTabIndex };`
  )(safari, _openedTabs, { error() {} }, { env });
  return { ...fn, closed, tabs, _openedTabs };
}

test("cleanup closes the marked MCP tab, not the user's tab on the original URL", async () => {
  // The exact report: MCP opened /a (recorded), then navigated to /b. The user's own tab
  // is still on /a and is the first match by URL.
  const c = makeCleanup({
    opened: [{ url: "https://example.com/a", marker: "MCP_s1_abc", openedAt: 1 }],
    tabs: [
      { index: 1, url: "https://example.com/a", marker: null },          // the user's tab
      { index: 2, url: "https://example.com/b", marker: "MCP_s1_abc" },  // ours, navigated
    ],
  });
  await c._cleanupTabs();
  assert.deepStrictEqual(c.closed, [2], "closed the marked tab");
  assert.deepStrictEqual(
    c.tabs.map(t => t.url),
    ["https://example.com/a"],
    "the user's tab survived shutdown"
  );
});

test("two tabs on the identical URL: only the marked one is closed", async () => {
  const c = makeCleanup({
    opened: [{ url: "https://example.com/a", marker: "MCP_s1_abc", openedAt: 1 }],
    tabs: [
      { index: 1, url: "https://example.com/a", marker: null },
      { index: 2, url: "https://example.com/a", marker: "MCP_s1_abc" },
    ],
  });
  await c._cleanupTabs();
  assert.deepStrictEqual(c.closed, [2]);
});

test("an unprovable tab is left open rather than guessed at", async () => {
  // Marker gone (tab already closed, or a site overwrote window.name) and a tab with no
  // marker recorded at all. Neither may fall back to the URL.
  const c = makeCleanup({
    opened: [
      { url: "https://example.com/a", marker: "MCP_s1_gone", openedAt: 1 },
      { url: "https://example.com/c", marker: "", openedAt: 2 },
    ],
    tabs: [
      { index: 1, url: "https://example.com/a", marker: null },
      { index: 2, url: "https://example.com/c", marker: null },
    ],
  });
  await c._cleanupTabs();
  assert.deepStrictEqual(c.closed, [], "closed nothing it could not prove");
  assert.strictEqual(c.tabs.length, 2);
  assert.strictEqual(c._openedTabs.size, 0, "tracking is still cleared");
});

test("closing several tabs re-resolves after each shift", async () => {
  const c = makeCleanup({
    opened: [
      { url: "https://example.com/a", marker: "MCP_s1_one", openedAt: 1 },
      { url: "https://example.com/b", marker: "MCP_s1_two", openedAt: 2 },
    ],
    tabs: [
      { index: 1, url: "https://example.com/user", marker: null },
      { index: 2, url: "https://example.com/a", marker: "MCP_s1_one" },
      { index: 3, url: "https://example.com/b", marker: "MCP_s1_two" },
    ],
  });
  await c._cleanupTabs();
  // Second close targets 2, not the stale 3 — the first closure renumbered the window.
  assert.deepStrictEqual(c.closed, [2, 2]);
  assert.deepStrictEqual(c.tabs.map(t => t.url), ["https://example.com/user"]);
});

test("a named profile still defers to extension-safe cleanup", async () => {
  const c = makeCleanup({
    opened: [{ url: "https://example.com/a", marker: "MCP_s1_abc", openedAt: 1 }],
    tabs: [{ index: 1, url: "https://example.com/a", marker: "MCP_s1_abc" }],
    env: { SAFARI_PROFILE: "Automation" },
  });
  await c._cleanupTabs();
  assert.deepStrictEqual(c.closed, []);
});

test("no close path resolves a tracked tab by URL any more", () => {
  // The three paths that close a tab this process opened earlier: shutdown cleanup, the
  // memory-monitor sweep, and the per-session tab cap. None may match on a recorded URL.
  for (const pattern of [
    /parsed\.find\(t => t\.url === url\)/,
    /parsed\.find\(t => t\.url === info\.url\)/,
  ]) {
    assert.ok(!pattern.test(index), `close-by-URL lookup is back: ${pattern}`);
  }
  assert.ok(
    /_trackTab\(tabIndex, url, sessionId = "", marker = ""\)/.test(
      readFileSync(new URL("../ownership-state.js", import.meta.url), "utf8")
    ),
    "_trackTab must record the identity marker for the close paths to use"
  );
  const evictionSource = sourceBetween(index, "Tab limit (${MAX_TABS}) reached", "_untrackTab(oldestIdx)");
  assert.ok(
    /_verifiedTabIndex/.test(evictionSource),
    "tab-cap eviction must re-prove the recorded index before closing"
  );
});
