// Behavioral tests for ownership-state.js — the STATEFUL tab-ownership layer
// (in-memory sets, on-disk persistence, TTL, blank-tab sentinel, tab tracking).
// ownership-match.test.mjs covers the pure matching/pruning functions; this file
// locks the stateful wrappers that index.js (and future src/tools/* modules) rely
// on to keep the MCP session off the user's tabs.
//
// HOME is redirected to a throwaway dir BEFORE importing the module so its file I/O
// (~/.safari-mcp/owned-tabs.json) never touches the real user's ownership state.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "smcp-ownership-"));
process.env.HOME = tmpHome;

const own = await import("../ownership-state.js");
const { OWNERSHIP_FILE, OWNERSHIP_TTL_MS, BLANK_TAB_SENTINEL } = own;

after(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

// Clean module state before each test (the module is a process-wide singleton).
beforeEach(() => {
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
  own._openedTabs.clear();
});

test("add → isOwned → remove roundtrip (exact URL)", () => {
  own._addOwnedURL("https://example.com/a");
  assert.equal(own._isURLOwned("https://example.com/a"), true);
  own._removeOwnedURL("https://example.com/a");
  assert.equal(own._isURLOwned("https://example.com/a"), false);
});

test("about:blank and favorites:// are never owned", () => {
  own._addOwnedURL("about:blank");
  own._addOwnedURL("favorites://");
  assert.equal(own._ownedTabURLs.size, 0);
});

test("null / empty url is never owned", () => {
  assert.equal(own._isURLOwned(null), false);
  assert.equal(own._isURLOwned(""), false);
  assert.equal(own._isURLOwned(undefined), false);
});

test("path-segment boundary: owning /org must NOT own /org-evil", () => {
  own._addOwnedURL("https://host.com/org");
  // same origin, deeper real path under /org → owned
  assert.equal(own._isURLOwned("https://host.com/org/page"), true);
  // sibling that merely shares the /org prefix → NOT owned (the tab-safety hole)
  assert.equal(own._isURLOwned("https://host.com/org-evil"), false);
});

test("blank-tab sentinel: marked, persisted, and never matches a real URL", () => {
  own._markBlankTabOpened();
  assert.equal(own._ownedTabURLs.has(BLANK_TAB_SENTINEL), true);
  // the sentinel is not a real URL and must not own a user's page
  assert.equal(own._isURLOwned("https://example.com/anything"), false);
  // idempotent — marking again doesn't duplicate
  own._markBlankTabOpened();
  assert.equal([...own._ownedTabURLs].filter((u) => u === BLANK_TAB_SENTINEL).length, 1);
});

test("trackTab owns the URL + records the tab; untrackTab reverses both", () => {
  own._trackTab(3, "https://example.com/page");
  assert.equal(own._openedTabs.has(3), true);
  assert.equal(own._isURLOwned("https://example.com/page"), true);
  own._untrackTab(3);
  assert.equal(own._openedTabs.has(3), false);
  assert.equal(own._isURLOwned("https://example.com/page"), false);
});

test("ownership persists to owned-tabs.json on disk (atomic write)", () => {
  own._addOwnedURL("https://persisted.example/x");
  assert.equal(existsSync(OWNERSHIP_FILE), true);
  const data = JSON.parse(readFileSync(OWNERSHIP_FILE, "utf8"));
  assert.ok(Array.isArray(data));
  assert.ok(data.some((e) => e.url === "https://persisted.example/x" && typeof e.ts === "number"));
});

test("TTL: an entry older than OWNERSHIP_TTL_MS is pruned and no longer matches", () => {
  own._addOwnedURL("https://stale.example/y");
  // backdate its timestamp past the TTL window
  own._ownedTabTimestamps.set("https://stale.example/y", Date.now() - (OWNERSHIP_TTL_MS + 1000));
  own._pruneExpiredOwnership();
  assert.equal(own._ownedTabURLs.has("https://stale.example/y"), false);
  assert.equal(own._isURLOwned("https://stale.example/y"), false);
});

test("touch-on-use: asserting against an entry refreshes its timestamp (keeps it alive)", () => {
  own._addOwnedURL("https://fresh.example/z");
  // age it to just under the TTL, then assert → should refresh and survive
  const nearExpiry = Date.now() - (OWNERSHIP_TTL_MS - 1000);
  own._ownedTabTimestamps.set("https://fresh.example/z", nearExpiry);
  assert.equal(own._isURLOwned("https://fresh.example/z"), true);
  assert.ok(own._ownedTabTimestamps.get("https://fresh.example/z") > nearExpiry);
});
