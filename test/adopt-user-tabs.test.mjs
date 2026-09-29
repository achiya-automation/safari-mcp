#!/usr/bin/env node
/**
 * Opt-in tab adoption (#92): with SAFARI_MCP_ALLOW_USER_TABS set, an explicit
 * safari_switch_tab may adopt a tab the user already had open, and the session then acts
 * on it. Three properties make that safe, and each is easy to lose in a refactor:
 *
 *   1. Off by default. No flag, no adoption — the guards behave exactly as before.
 *   2. Session-local. owned-tabs.json is shared by every safari-mcp process on the machine
 *      and outlives this session; a persisted adoption would hand the user's tab to a
 *      process that has no record of it being adopted, and whose close_tab would allow.
 *   3. close_tab is never unlocked. Adoption makes a tab writable, not disposable (#68).
 *
 * The adoption itself is a marker family safari.js stamps on the tab (MCP_A<markerId>_) and
 * keeps in the session's own state: nothing is recorded by URL, so nothing reaches the shared
 * file or another session. test/fallback-tab-proof.test.mjs runs all three end to end —
 * adopting, navigating, switching away and back, and every close. This file locks the flag's
 * parsing, and, at source level like close-tab-ownership.test.mjs, where _assertTabOwnership
 * refuses the close.
 *
 * Run:  node --test test/adopt-user-tabs.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

async function freshModule() {
  // A cache-busting query gives each test its own module state without touching the
  // real ~/.safari-mcp file between assertions.
  return import(new URL(`../ownership-state.js?adopt-test=${Math.random()}`, import.meta.url));
}

test("the flag is off unless explicitly set, and accepts the usual truthy spellings", async () => {
  const m = await freshModule();
  const previous = process.env.SAFARI_MCP_ALLOW_USER_TABS;
  try {
    for (const off of [undefined, "", "0", "false", "no", "off", "maybe"]) {
      if (off === undefined) delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
      else process.env.SAFARI_MCP_ALLOW_USER_TABS = off;
      assert.equal(m.allowUserTabs(), false, `${JSON.stringify(off)} must not enable adoption`);
    }
    for (const on of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      process.env.SAFARI_MCP_ALLOW_USER_TABS = on;
      assert.equal(m.allowUserTabs(), true, `${JSON.stringify(on)} should enable adoption`);
    }
  } finally {
    if (previous === undefined) delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
    else process.env.SAFARI_MCP_ALLOW_USER_TABS = previous;
  }
});

test("close_tab is refused on an adopted tab even with the flag on", () => {
  // By the tab's adoption marker, not its URL: the adopted tab can navigate to a URL the
  // session owns, and another tab can show the adopted URL.
  assert.match(
    index,
    /if \(opType === "close_tab" && safari\.isActiveTabAdopted\(\)\) \{/,
    "close_tab must refuse an adopted tab (#68) — adoption grants writes, not closes"
  );
  const guardStart = index.indexOf('function _assertTabOwnership(');
  const closeGuard = index.indexOf('opType === "close_tab" && safari.isActiveTabAdopted()', guardStart);
  const earlyReturn = index.indexOf('if (_noOwnershipCheck.has(opType)) return;', guardStart);
  assert.ok(guardStart >= 0 && closeGuard > guardStart, "the refusal belongs inside _assertTabOwnership");
  assert.ok(
    closeGuard > earlyReturn && closeGuard - earlyReturn < 700,
    "the refusal must run before the ownership early-returns, so the batch action shares it"
  );
  assert.ok(
    !index.includes('_noOwnershipCheck = new Set([\n  "newTab", "switchTab", "listTabs", "closeTab"'),
    "close_tab must not be exempted from the ownership check"
  );
});

test("safari_doctor reports the flag state either way", () => {
  // doctor() itself needs the Apple Events grant to run, so lock the report line at source
  // level: "why did it touch my tab" must be answerable from doctor rather than from the
  // host's environment (#92, condition 3).
  const safari = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
  assert.match(safari, /import \{ allowUserTabs \} from "\.\/ownership-state\.js";/);
  assert.match(
    safari,
    /allowUserTabs\(\)\s*\n\s*\? "\u2139\uFE0F Tab adoption \(SAFARI_MCP_ALLOW_USER_TABS\): ON[^"]*"\s*\n\s*: "\u2139\uFE0F Tab adoption \(SAFARI_MCP_ALLOW_USER_TABS\): off \(default\)[^"]*"/,
    "doctor must print the flag state in both directions"
  );
});

test("a switch by index drops the previous tab's receipt instead of keeping it", () => {
  // switch_tab by index returns no receipt, and every later command auto-attaches the
  // session's active one. Keeping the previous tab's receipt made the switch report
  // owned:true and the next command fail with "receipt is … not valid for this origin",
  // with no way out but opening another tab. Reproduced live 2026-09-10 on a tab that had
  // navigated across origins.
  const tail = index.slice(index.indexOf('server.tool(\n  "safari_switch_tab"'));
  const body = tail.slice(0, tail.indexOf("\n);"));
  assert.match(
    body,
    /if \(safeResult\?\.receipt \|\| token\) _setActiveReceipt\(safeResult\?\.receipt \|\| token\);[\s\S]{0,700}?\n\s*else _setActiveReceipt\(""\);/,
    "a receipt-less switch must clear the stale active receipt"
  );
});
