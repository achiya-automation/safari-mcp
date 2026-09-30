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

test("an explicit tabIndex is the only way to opt out of the guard", () => {
  const body = src.slice(src.indexOf("function _tabIdentityGuard("));
  assert.match(body, /if \(explicitTabIndex\) return ''/, "naming a tab stays an explicit opt-out");
  assert.doesNotMatch(
    body.slice(0, body.indexOf("MCP_WRONG_TAB")),
    /if \(!marker[^)]*\) return ''/,
    "an absent marker must NOT drop the guard: a session re-initialised after a transport " +
      "drop reports no marker while already owning a tab, and the unguarded fallback is the " +
      "user's front document (#64)"
  );
});

test("a markerless session refuses a front document that carries a foreign MCP marker", () => {
  const body = src.slice(src.indexOf("function _tabIdentityGuard("));
  const noMarkerBranch = body.slice(0, body.indexOf("MCP_WRONG_TAB"));
  assert.match(
    noMarkerBranch,
    /window\.name\.indexOf\('MCP_'\)\s*===\s*0[\s\S]{0,80}MCP_FOREIGN_TAB/,
    "the no-marker branch must throw MCP_FOREIGN_TAB on any MCP-marked tab"
  );
});

test("both run paths translate a foreign-tab trip into a terminal fail-closed error", () => {
  for (const where of ["runJS", "runJSLarge"]) {
    assert.ok(
      src.includes(`_foreignTabError('${where}'`),
      `${where} must map MCP_FOREIGN_TAB to the fail-closed error`
    );
  }
  // Terminal on purpose: with no marker there is nothing to re-resolve to, so neither path
  // may retry after this guard trips.
  const runJSBody = src.slice(src.indexOf("async function runJS("), src.indexOf("async function runJSLarge("));
  const foreignAt = runJSBody.indexOf("MCP_FOREIGN_TAB");
  const wrongAt = runJSBody.indexOf("MCP_WRONG_TAB', ");
  assert.ok(foreignAt > 0, "runJS must handle MCP_FOREIGN_TAB");
  assert.ok(
    wrongAt === -1 || foreignAt < wrongAt,
    "the foreign-tab check must run before the re-resolve-and-retry branch"
  );
});

test("runJSLarge translates a tripped guard into a fail-closed error", () => {
  assert.match(src, /MCP_WRONG_TAB[\s\S]{0,400}Tab tracking lost during runJSLarge/);
});

// The steps that act on a tab they proved once, in later scripts (a load's probes and re-stamp,
// `set URL`, a click or a history move), prove it again inside each script: every page script
// _inTab() runs is built by _provenTabJS(), which checks the tab before anything else runs, or is
// the marker check itself. See test/newtab-window-proof.test.mjs for the behaviour.
const bodyOf = (head) => {
  const from = src.indexOf(head);
  assert.ok(from >= 0, `could not find ${head}`);
  const to = src.indexOf("\n}\n", from);
  return src.slice(from, to);
};

test("every page script a step runs in the tab it proved checks the tab first", () => {
  const inTab = bodyOf("async function _inTab(");
  const sites = [...inTab.matchAll(/do JavaScript "\$\{/g)].map((m) => inTab.slice(m.index + 17, m.index + 17 + 90));
  assert.ok(sites.length >= 4, `expected _inTab's page scripts, found ${sites.length}`);
  for (const site of sites) {
    assert.ok(
      site.startsWith("byMarker}") ||
        site.startsWith("_doJSLiteral(_markerCheckJS(tab.marker))}") ||
        site.startsWith("_doJSLiteral(_provenTabJS(tab.marker, js, { positional: true, stamp, since: tab.since }))}"),
      `_inTab runs a page script that does not prove the tab first: ${site}`
    );
  }
  assert.match(inTab, /const byMarker = _doJSLiteral\(_provenTabJS\(tab\.marker, js, \{ positional: false, stamp: stamp \|\| markerOnly \}\)\);/);
  const proven = bodyOf("function _provenTabJS(");
  const check = proven.indexOf("if(!own&&(!P||");
  assert.ok(check > 0 && check < proven.indexOf("return 'MCP_OK:'"), "_provenTabJS must refuse before it runs the script");
});

test("the load steps act on their tab only through _inTab", () => {
  for (const head of [
    "export async function navigate(url)", "export async function goBack(", "export async function goForward(",
    "export async function reload(", "async function _pollReadyAndRead(", "export async function navigateAndRead(",
    "export async function clickAndWait(", "export async function fillAndSubmit(",
  ]) {
    const body = bodyOf(head);
    assert.doesNotMatch(body, /runJS\([^;]*tabIndex:/, `${head} runs JS at an index it does not prove again`);
    assert.doesNotMatch(body, /osascript(?:Fast)?\(\s*`tell application "Safari" to set URL/, `${head} sets a URL at an index it does not prove again`);
  }
  const newTab = bodyOf("export async function newTab(");
  assert.doesNotMatch(newTab, /do JavaScript "\$\{js/, "newTab runs page scripts at an index it does not prove again");
});
