#!/usr/bin/env node
/**
 * `safari_switch_tab` refuses any index whose tab is not ours. A tab we opened may
 * redirect off the URL we registered (/dashboard -> /login), so the URL alone stops
 * being proof — but a *tracked index* is not proof either: `_openedTabs` is keyed by
 * index and Safari renumbers every index whenever any tab closes, so a stale key can
 * point straight at one of the user's tabs. The pre-check must therefore require the
 * tracked index AND the origin we opened it on.
 *
 * This matters most in the AppleScript fallback, which performs the switch with no
 * ownership check of its own — there this pre-check is the only guard standing.
 *
 * Regression test for the 21.08 working-tree patch that relaxed the pre-check to a
 * bare `_openedTabs.has(index)`.
 *
 * Run:  node --test test/switch-tab-origin-guard.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");

const originOf = Function(
  `${/function _originOf\(url\) \{[\s\S]*?\n\}/.exec(src)[0]}; return _originOf;`
)();

test("_originOf yields a comparable origin, and nothing comparable for non-URLs", () => {
  assert.equal(originOf("https://example.test/a?b=1#c"), "https://example.test");
  assert.equal(originOf("https://example.test/deep/path"), "https://example.test");
  assert.notEqual(originOf("https://example.test/a"), originOf("https://evil.test/a"));
  // A tab with no usable URL must never authorize anything: "" is falsy at the
  // call site, so two unparseable URLs can never match each other into ownership.
  for (const junk of ["", "missing value", undefined, null, "not a url"]) {
    assert.equal(originOf(junk), "", `${JSON.stringify(junk)} must yield no origin`);
  }
});

test("the switch_tab pre-check pairs the tracked index with an origin match", () => {
  const guard = /const trackedOrigin = _originOf\(_openedTabs\.get\(index\)\?\.url\);\s*\n\s*const isTrackedRedirect = !!trackedOrigin && trackedOrigin === _originOf\(target\.url\);\s*\n\s*if \(!isBlankOwned && !isTrackedRedirect\) \{/;
  assert.match(
    src,
    guard,
    "switch_tab must not fall back to a bare _openedTabs.has(index) — Safari renumbers indices"
  );
  assert.doesNotMatch(
    src,
    /const isTrackedIndex = _openedTabs\.has\(index\);/,
    "a bare tracked-index check would let a stale index reach a user's tab"
  );
});
