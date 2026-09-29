#!/usr/bin/env node
/**
 * `safari_switch_tab` refuses any index whose tab is not ours. A tab we opened may
 * redirect off the URL we registered (/dashboard -> /login), so the URL alone stops
 * being proof — but a *recorded index* is not proof either: Safari renumbers every
 * index whenever any tab closes, so a stale one can point straight at one of the user's
 * tabs. The pre-check must therefore require the recorded index AND the origin we
 * opened it on.
 *
 * The AppleScript fallback also needs the session's marker on the tab it claims, since
 * a URL cannot tell the session's tab from the user's (test/fallback-tab-proof.test.mjs).
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
  // The adoption opt-in (#92) adds a conjunct to the refusal; the pairing this test
  // exists for — tracked index AND matching origin — must survive it unchanged.
  const guard = /const trackedOrigin = _originOf\(_trackedAtIndex\(index\)\?\.url\);\s*\n\s*const isTrackedRedirect = !!trackedOrigin && trackedOrigin === _originOf\(target\.url\);\s*\n\s*if \(!isBlankOwned && !isTrackedRedirect(?: && !?allowUserTabs\(\))? *\) \{/;
  assert.match(
    src,
    guard,
    "switch_tab must not fall back to a bare recorded-index check — Safari renumbers indices"
  );
  assert.doesNotMatch(
    src,
    /const isTrackedIndex = _openedTabs\.has\(index\);/,
    "a bare tracked-index check would let a stale index reach a user's tab"
  );
});

test("adopting an unowned tab is reachable only from safari_switch_tab, behind the opt-in flag", () => {
  // Without the flag the pre-check refuses, and every switchTab(…, { adopt: true }) sits right
  // behind an allowUserTabs() check inside safari_switch_tab. Otherwise the opt-in would be
  // decoration and the guard would be gone (#92).
  assert.match(
    src,
    /if \(!isBlankOwned && !isTrackedRedirect && !allowUserTabs\(\)\) \{[\s\S]{0,600}?return errorResult\(msg\);/,
    "without the flag, switch_tab's pre-check must refuse a tab the session did not open"
  );
  const adoptCalls = [...src.matchAll(/switchTab\([^)]*\{ adopt: true \}\)/g)];
  assert.ok(adoptCalls.length > 0, "switch_tab should be able to adopt when opted in");
  const from = src.indexOf('server.tool(\n  "safari_switch_tab"');
  const to = src.indexOf("\n);\n", from);
  for (const m of adoptCalls) {
    assert.ok(m.index > from && m.index < to, "only safari_switch_tab adopts (#92)");
    const gate = src.lastIndexOf("allowUserTabs()", m.index);
    assert.ok(gate > from && m.index - gate < 400, "a switchTab adopt call escaped the allowUserTabs() check");
  }
});
