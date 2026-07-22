#!/usr/bin/env node
/**
 * Every path that runs caller-supplied JS at a *tab index* must carry the atomic identity
 * guard. Regression test for #64.
 *
 * The guard is the only check independent of how the index was resolved, so the paths that
 * need it most are the retries — which run precisely when the index has already proven
 * wrong. Two of them shipped without it: the ghost-recovery retry in `runJS` dropped the
 * prefix, and `runJSLarge` (upload / paste-image — the largest payloads in the toolset)
 * never had one. Both failed open onto whatever tab the index happened to name.
 *
 * This is a source-level check on purpose: the failure is *omission* at a call site, which
 * no behavioural test over the existing sites can see. Only `current tab of` — the
 * deliberate front-document fallback for sessions that own no tab — is exempt.
 *
 * Run:  node --test test/tab-identity-guard.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../safari.js", import.meta.url), "utf8");

/** Every `do JavaScript` line that interpolates the caller's escaped script. */
function userScriptSites() {
  return src
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => line.includes("do JavaScript") && line.includes("${escaped}"));
}

test("the guard helper exists and is not inlined at a call site", () => {
  assert.match(
    src,
    /function _tabIdentityGuard\(/,
    "_tabIdentityGuard should own the guard string"
  );
  const inlined = src
    .split("\n")
    .filter(
      (l) =>
        l.includes("MCP_WRONG_TAB") && l.includes("throw new Error") && l.includes("window.name")
    );
  assert.equal(inlined.length, 1, "the guard literal should be built in exactly one place");
});

test("every tab-targeted user-script site carries the guard", () => {
  const sites = userScriptSites();
  assert.ok(
    sites.length >= 3,
    `expected to find the runJS/runJSLarge sites, found ${sites.length}`
  );

  for (const { line, n } of sites) {
    if (line.includes("current tab of")) continue; // documented no-owned-tab fallback
    assert.ok(
      /\$\{_guard\}|\$\{_tabIdentityGuard\(/.test(line),
      `safari.js:${n} runs caller JS at a tab index with no identity guard:\n  ${line}`
    );
  }
});

test("the guard is inert for an explicit tabIndex and absent marker", () => {
  const body = src.slice(src.indexOf("function _tabIdentityGuard("));
  assert.match(body, /if \(!marker \|\| explicitTabIndex\) return ''/, "both opt-outs must remain");
});

test("runJSLarge translates a tripped guard into a fail-closed error", () => {
  assert.match(src, /MCP_WRONG_TAB[\s\S]{0,400}Tab tracking lost during runJSLarge/);
});
