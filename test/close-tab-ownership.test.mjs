#!/usr/bin/env node
/**
 * `safari_close_tab` must never fall back to the tab the user is looking at. Regression
 * test for #68.
 *
 * The read paths deliberately allow an unmarked front document — "read the page I'm on"
 * has to keep working for a session that never opened a tab, and a wrong read costs
 * information. A wrong *close* costs the user their work, so the destructive path gets no
 * such fallback: it closes a tab this session can prove it owns, or it throws.
 *
 * The same fail-open existed in all three layers, with one shape — "no ownership recorded"
 * read as permission rather than as refusal:
 *   1. safari.js closeTab()  — `close current tab of window` when the index was unknown
 *   2. index.js              — "close_tab" sat in _noOwnershipCheck as tab management
 *   3. extension/background  — the "no tabs owned yet → allow" backward-compat branch
 * A re-initialised session (transport drop) reports exactly that state while its own tab
 * is still open, so all three agreed to close the user's tab.
 *
 * Source-level on purpose, like tab-identity-guard: the defect is a missing refusal on a
 * path that only runs after state is already lost, which no behavioural test over the
 * healthy paths can reach.
 *
 * Run:  node --test test/close-tab-ownership.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const safari = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

/** Comments discuss the fallback by name; only code may be asserted against. */
const stripComments = (s) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const closeTabBody = (() => {
  const start = safari.indexOf("export async function closeTab(");
  assert.ok(start > 0, "closeTab should exist in safari.js");
  const end = safari.indexOf("\nexport async function", start + 1);
  return safari.slice(start, end === -1 ? undefined : end);
})();

test("no AppleScript in closeTab targets the front document", () => {
  // The refusal message names the fallback in prose, so match the commands, not the text.
  const commands = stripComments(closeTabBody)
    .split("\n")
    .filter((l) => l.includes('tell application "Safari"'));
  assert.ok(commands.length >= 3, `expected the count + close + blank commands, got ${commands.length}`);
  for (const line of commands) {
    assert.ok(
      !/current tab of/.test(line),
      "closeTab must not fall back to `current tab of window` — that is the user's active " +
        `tab whenever this session's index is unknown (#68):\n  ${line.trim()}`
    );
  }
});

test("closeTab refuses when it cannot prove which tab is its own", () => {
  assert.match(
    closeTabBody,
    /const idx = explicitIndex \|\| \(await _provenOwnTabIndex\(\)\)/,
    "the target must come from an explicit index or from proven ownership"
  );
  assert.match(
    closeTabBody,
    /if \(!idx\)[\s\S]{0,200}throw new Error/,
    "an unprovable target must throw, not fall through to a close"
  );
});

test("both destructive AppleScript verbs are pinned to the proven index", () => {
  const verbs = closeTabBody
    .split("\n")
    .filter((l) => /close tab|set URL of/.test(l) && l.includes("Safari"));
  assert.equal(verbs.length, 2, `expected the close and the blank-instead-of-close, got ${verbs.length}`);
  for (const line of verbs) {
    assert.ok(
      line.includes("tab ${idx} of"),
      `a destructive verb targets something other than the proven index:\n  ${line}`
    );
  }
});

test("the proven-ownership helper fails closed to null", () => {
  const start = safari.indexOf("async function _provenOwnTabIndex(");
  assert.ok(start > 0, "_provenOwnTabIndex should own this decision in one place");
  const body = safari.slice(start, safari.indexOf("\n}", start));
  assert.match(
    body,
    /resolveActiveTab\(\)/,
    "ownership is proven by re-resolving the identity marker, not by trusting a stale index"
  );
  assert.match(body, /\|\| null/, "an unresolved tab must read as null, never as an index");
});

test("close_tab is not exempt from the shared tab-ownership assertion", () => {
  const start = index.indexOf("const _noOwnershipCheck = new Set([");
  const exempt = stripComments(index.slice(start, index.indexOf("]);", start)));
  assert.ok(
    !/"close_tab"/.test(exempt),
    "close_tab destroys a user tab — it does not belong in a set of read-only and " +
      "tab-management ops (#68)"
  );
  // The other three tab-management entries stay exempt: new_tab creates, list_tabs reads,
  // and switch_tab carries its own ownership check at the tool.
  for (const safe of ["new_tab", "list_tabs", "switch_tab"]) {
    assert.ok(exempt.includes(`"${safe}"`), `${safe} should remain exempt`);
  }
});

test("internal cleanup names its tab instead of mutating shared active-tab state", () => {
  assert.ok(
    !/setActiveTabIndex\([^)]*\);\s*\n\s*await safari\.closeTab\(\)/.test(index),
    "cleanup should pass the index to closeTab directly, so the refusal above stays " +
      "meaningful for every other caller"
  );
});

test("the extension denies a close to a session that owns nothing", () => {
  assert.match(
    background,
    /_destructiveTabCommands\s*=\s*new Set\(\["close_tab"\]\)/,
    "close_tab must be marked destructive in the extension engine too"
  );
  const guard = background.slice(
    background.indexOf("TAB OWNERSHIP GUARD"),
    background.indexOf("switch (type)")
  );
  assert.match(
    guard,
    /_destructiveTabCommands\.has\(type\)[\s\S]{0,300}throw new Error/,
    "the 'no tabs owned yet' leniency must not extend to a destructive close"
  );
});

test("the extension checks the tab it actually closes when given an index", () => {
  const handler = background.slice(
    background.indexOf('case "close_tab"'),
    background.indexOf('case "switch_tab"')
  );
  const removeAt = handler.indexOf("browser.tabs.remove(target.id)");
  const checkAt = handler.indexOf("_isTabOwnedBySession(sessionId, target.id)");
  assert.ok(checkAt > 0, "the index-resolved target needs its own ownership check");
  assert.ok(checkAt < removeAt, "the check must run before the removal");
});
