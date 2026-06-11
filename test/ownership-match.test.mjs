// Unit tests for the tab-ownership matching semantics (ownership-match.js).
// These lock the safety-critical behavior that decides whether a tool call may
// touch the currently active tab. CI-safe: pure logic, no Safari required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeURL, findOwnedMatch, pruneExpired } from "../ownership-match.js";

const SENTINEL = "__mcp-blank-tab__";

test("exact match returns the owned entry", () => {
  const owned = new Set(["https://example.com/page"]);
  assert.equal(findOwnedMatch("https://example.com/page", owned), "https://example.com/page");
});

test("query, fragment and trailing slashes are ignored", () => {
  const owned = new Set(["https://example.com/page"]);
  assert.equal(findOwnedMatch("https://example.com/page?utm=1#top", owned), "https://example.com/page");
  assert.equal(findOwnedMatch("https://example.com/page/", owned), "https://example.com/page");
  const ownedSlash = new Set(["https://example.com/page/"]);
  assert.equal(findOwnedMatch("https://example.com/page", ownedSlash), "https://example.com/page/");
});

test("same-origin deeper path (real redirect) matches", () => {
  const owned = new Set(["https://accounts.example.com/login"]);
  assert.equal(
    findOwnedMatch("https://accounts.example.com/login/device/select_account", owned),
    "https://accounts.example.com/login"
  );
});

test("path-segment boundary: owning /org must NOT own /org-evil", () => {
  const owned = new Set(["https://github.com/org"]);
  assert.equal(findOwnedMatch("https://github.com/org-evil/malicious-repo", owned), null);
  assert.equal(findOwnedMatch("https://github.com/org/repo", owned), "https://github.com/org");
});

test("same path on a different origin never matches", () => {
  const owned = new Set(["https://example.com/login"]);
  assert.equal(findOwnedMatch("https://evil.example.net/login", owned), null);
  assert.equal(findOwnedMatch("http://example.com/login/x", owned), null); // different scheme → different origin
});

test("the blank-tab sentinel never matches a real page", () => {
  const owned = new Set([SENTINEL]);
  assert.equal(findOwnedMatch("https://example.com/", owned), null);
  assert.equal(findOwnedMatch("about:blank", owned), null);
});

test("unparseable owned entries are skipped, parseable ones still match", () => {
  const owned = new Set([SENTINEL, "not a url", "https://ok.example.com/a"]);
  assert.equal(findOwnedMatch("https://ok.example.com/a/b", owned), "https://ok.example.com/a");
});

test("empty / missing url returns null", () => {
  const owned = new Set(["https://example.com/"]);
  assert.equal(findOwnedMatch("", owned), null);
  assert.equal(findOwnedMatch(null, owned), null);
});

test("pruneExpired removes only stale entries and reports change", () => {
  const now = 1_000_000;
  const ttl = 30 * 60 * 1000;
  const urls = new Set(["https://old.example.com/", "https://fresh.example.com/"]);
  const ts = new Map([
    ["https://old.example.com/", now - ttl - 1],
    ["https://fresh.example.com/", now - 1000],
  ]);
  assert.equal(pruneExpired(urls, ts, ttl, now), true);
  assert.deepEqual([...urls], ["https://fresh.example.com/"]);
  assert.deepEqual([...ts.keys()], ["https://fresh.example.com/"]);
});

test("pruneExpired with nothing stale reports no change", () => {
  const now = 1_000_000;
  const urls = new Set(["https://a.example.com/"]);
  const ts = new Map([["https://a.example.com/", now]]);
  assert.equal(pruneExpired(urls, ts, 1000, now), false);
  assert.equal(urls.size, 1);
});

test("touch-on-use pattern: refreshed timestamp survives the next prune", () => {
  const ttl = 1000;
  let now = 10_000;
  const urls = new Set(["https://a.example.com/"]);
  const ts = new Map([["https://a.example.com/", now]]);
  now += 900;
  ts.set("https://a.example.com/", now); // simulate _touchOwned on successful assert
  now += 900; // 1800 past original — would have expired without the touch
  assert.equal(pruneExpired(urls, ts, ttl, now), false);
  assert.equal(findOwnedMatch("https://a.example.com/", urls), "https://a.example.com/");
});

test("normalizeURL strips query/fragment/trailing slashes only", () => {
  assert.equal(normalizeURL("https://e.com/a/?q=1#f"), "https://e.com/a");
  assert.equal(normalizeURL("https://e.com"), "https://e.com");
});
