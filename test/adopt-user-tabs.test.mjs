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
 * (3) lives in index.js's _assertTabOwnership, which needs the whole server to run, so it
 * is asserted at source level like close-tab-ownership.test.mjs. (1) and (2) are real
 * behaviour against the module.
 *
 * Run:  node --test test/adopt-user-tabs.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

const OWN = "https://example.test/report?id=7";

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

test("adoption refuses without the flag, and grants ownership with it", async () => {
  const m = await freshModule();
  const previous = process.env.SAFARI_MCP_ALLOW_USER_TABS;
  try {
    delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
    assert.equal(m._adoptUserTab(OWN), false, "no flag → no adoption");
    assert.equal(m._isURLOwned(OWN), false, "a refused adoption must not own anything");

    process.env.SAFARI_MCP_ALLOW_USER_TABS = "1";
    assert.equal(m._adoptUserTab(OWN), true);
    assert.equal(m._isURLOwned(OWN), true, "an adopted tab is the session's target");
    assert.equal(m._isAdoptedURL(OWN), true);
    // The tool layer hands callers origin+pathname; both spellings must resolve to the
    // same adopted document or close_tab's refusal can be walked around.
    assert.equal(m._isAdoptedURL("https://example.test/report"), true);
    assert.equal(m._isAdoptedURL("https://elsewhere.test/report"), false);

    // Blank/placeholder tabs carry no identity to adopt.
    for (const junk of ["", null, "about:blank", "missing value"]) {
      assert.equal(m._adoptUserTab(junk), false, `${JSON.stringify(junk)} is not adoptable`);
    }
  } finally {
    if (previous === undefined) delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
    else process.env.SAFARI_MCP_ALLOW_USER_TABS = previous;
  }
});

test("an adopted URL is never written to the shared ownership file", async () => {
  // Point the module at a throwaway HOME so this exercises the real write path instead of
  // re-deriving the filter, and without touching the user's ~/.safari-mcp.
  const home = mkdtempSync(join(tmpdir(), "safari-mcp-adopt-"));
  const previousHome = process.env.HOME;
  const previousFlag = process.env.SAFARI_MCP_ALLOW_USER_TABS;
  try {
    process.env.HOME = home;
    process.env.SAFARI_MCP_ALLOW_USER_TABS = "1";
    const m = await freshModule();

    m._adoptUserTab(OWN);
    // A real save, triggered the way any later tool call would trigger it.
    m._addOwnedURL("https://ours.test/opened-by-us");

    const persisted = m._loadOwnershipFile().map((e) => e.url);
    assert.ok(persisted.includes("https://ours.test/opened-by-us"), "a tab we opened is persisted");
    assert.ok(!persisted.includes(OWN), "an adopted user tab must never reach owned-tabs.json");
    assert.ok(m._ownedTabURLs.has(OWN), "…while still being owned in memory for this session");
  } finally {
    process.env.HOME = previousHome;
    if (previousFlag === undefined) delete process.env.SAFARI_MCP_ALLOW_USER_TABS;
    else process.env.SAFARI_MCP_ALLOW_USER_TABS = previousFlag;
    rmSync(home, { recursive: true, force: true });
  }
});

test("_saveOwnershipFile skips adopted URLs at the one place that writes", () => {
  const state = readFileSync(new URL("../ownership-state.js", import.meta.url), "utf8");
  assert.match(
    state,
    /for \(const url of urls\) \{[\s\S]{0,400}?if \(_adoptedTabURLs\.has\(url\)\) continue;/,
    "the write loop must skip adopted URLs — _pruneExpiredOwnership saves too"
  );
});

test("close_tab is refused on an adopted tab even with the flag on", () => {
  assert.match(
    index,
    /if \(opType === "close_tab" && _isAdoptedURL\(safari\.getActiveTabURL\(\)\)\) \{/,
    "close_tab must refuse an adopted tab (#68) — adoption grants writes, not closes"
  );
  const guardStart = index.indexOf('function _assertTabOwnership(');
  const closeGuard = index.indexOf('opType === "close_tab" && _isAdoptedURL', guardStart);
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
