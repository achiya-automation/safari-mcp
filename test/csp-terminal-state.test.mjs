#!/usr/bin/env node
/**
 * #106: on a page that refuses every injection strategy, safari_evaluate returned the
 * same thing as a script that legitimately returned nothing, so an agent read "no such
 * element" and kept building on a script that never ran.
 *
 * The extension's ladder already has a terminal marker for that state, and its text even
 * announces "Falling back to AppleScript" — but the server did not recognise it, so no
 * fallback ran and the marker reached the caller as the tool's value. These source
 * contracts keep the marker wired to a fallback and keep the exhausted case an error.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

/** The body of extensionOrFallback, where both paths meet. */
function fallbackFn() {
  const start = index.indexOf("async function extensionOrFallback");
  assert.ok(start >= 0, "extensionOrFallback should exist");
  const end = index.indexOf("\nasync function ", start + 1);
  return index.slice(start, end === -1 ? start + 12000 : end);
}

test("the extension still emits the terminal CSP marker the server matches on", () => {
  assert.match(background, /CSP blocked all strategies/);
});

test("the terminal CSP marker triggers the AppleScript fallback its own text promises", () => {
  const source = fallbackFn();
  assert.match(source, /hardCspBlock = extensionType === "evaluate" && typeof result === 'string' && result\.startsWith\('Error: CSP blocked all strategies'\)/);
  // It must feed the fallback branch, or the marker becomes the tool's return value again.
  assert.match(source, /\} else if \(hardCspBlock\) \{/);
});

test("an exhausted evaluate fails instead of looking like an empty return", () => {
  const source = fallbackFn();
  const throwAt = source.indexOf("this page refused every JavaScript injection strategy");
  assert.ok(throwAt >= 0, "the exhausted case must name what happened");
  const guard = source.slice(Math.max(0, throwAt - 300), throwAt);
  assert.match(guard, /hardCspBlock && \(result === undefined \|\| result === null\)/);
  // The error is only useful if it names a path that still works on such a page.
  assert.match(source.slice(throwAt, throwAt + 400), /safari_read_page/);
});

test("a legitimate empty return is still not an error", () => {
  // The guard must depend on the CSP marker, never on emptiness alone — `(() => {})()`
  // returning nothing is a correct result and must keep flowing through evalResult.
  const source = fallbackFn();
  const matches = [...source.matchAll(/result === undefined \|\| result === null/g)];
  for (const m of matches) {
    const before = source.slice(Math.max(0, m.index - 60), m.index);
    assert.match(before, /hardCspBlock &&/, "emptiness alone must never raise");
  }
});

// ---------- extensionOrFallback, for real ----------
// The slices of index.js the routing tests run (test/close-tab-unparseable-receipt.test.mjs),
// over a bridge that answers every command with one fixed result, and an AppleScript fallback
// that only counts its calls.

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { after } = await import("node:test");
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-csp-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));

function between(start, end) {
  const from = index.indexOf(start);
  const to = index.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return index.slice(from, to);
}

const routing = [
  between("async function _waitForVerifiedProfileExtension(", "\n// ========== EXTENSION BRIDGE"),
  between("function _untrackClosedTab(", "\n// Close all MCP-opened tabs on process exit"),
  between("const _nullMeansFailure = new Set([", "\n// Operations that don't need tab ownership"),
  between("const _noOwnershipCheck = new Set([", "\n// Origin of a URL"),
  between("function _originOf(", "\nasync function _runExtensionBatchAction("),
  between("async function _runExtensionBatchAction(", "\n// The cookie / localStorage / sessionStorage tools"),
].join("\n");

const RECEIPT = "r".repeat(36);
const MARKER = "Error: CSP blocked all strategies - the script did not run. Falling back to AppleScript.";

/** extensionOrFallback with a bridge that answers `reply`; `appleScript` counts fallback runs. */
function route({ profile, reply, fallbackValue = "via AppleScript" }) {
  const appleScript = { calls: 0 };
  const safari = new Proxy(
    { getActiveTabURL: () => null, isActiveTabAdopted: () => false, hasOwnedTab: () => true, saveFrontmostApp: async () => null },
    { get: (target, key) => (key in target ? target[key] : () => {}) }
  );
  const deps = {
    safari, SESSION_ID: "daemon", currentSessionId: () => "agent",
    process: { env: profile ? { SAFARI_PROFILE: profile } : {} }, console: { error() {}, warn() {} },
    sendToExtension: async () => reply,
    _trackTab: own._trackTab, _untrackTab: own._untrackTab, _openedTabs: own._openedTabs,
    _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL, _markBlankTabOpened: own._markBlankTabOpened,
    _isURLOwned: own._isURLOwned, _sessionTabs: own._sessionTabs, BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    _preferAppleScript: !!profile, _extensionConnected: true, _profileExtensionVerified: true,
    _isExtensionHost: false, _commandTimeouts: {},
  };
  const extensionOrFallback = new Function(...Object.keys(deps), `${routing}\nreturn extensionOrFallback;`)(...Object.values(deps));
  const call = (type) => extensionOrFallback(type, { receipt: RECEIPT, script: "document.body.innerText" }, async () => {
    appleScript.calls++;
    return fallbackValue;
  });
  return { call, appleScript };
}

const MODES = [
  { name: "in a named profile", profile: "Work" },
  { name: "without SAFARI_PROFILE", profile: "" },
];

for (const mode of MODES) {
  test(`${mode.name}: a page that writes about CSP is read, not taken for a blocked command`, async () => {
    // A docs page, a security blog, this project's own CHANGELOG: page text that names the
    // very words the server once matched anywhere in a result.
    for (const words of ["Trusted Types", "trusted-types", "Content Security Policy", "unsafe-eval",
      "CSP blocked all strategies", "__SCREENSHOT_PERMISSION_DENIED__"]) {
      const page = JSON.stringify({ title: "CSP guide", url: "https://docs.example/csp", text: `About ${words} on this page.` });
      for (const type of ["read_page", "get_source", "snapshot", "evaluate"]) {
        const { call, appleScript } = route({ profile: mode.profile, reply: page });
        assert.equal(await call(type), page, `${type} of a page that mentions ${words} was not returned`);
        assert.equal(appleScript.calls, 0, `${type} of a page that mentions ${words} ran again through AppleScript`);
      }
    }
  });
}

test("in a named profile, an evaluate the page's CSP refused names the CSP, not a dead extension", async () => {
  const { call, appleScript } = route({ profile: "Work", reply: MARKER });
  await assert.rejects(call("evaluate"), (error) => {
    assert.match(error.message, /Content-Security-Policy refused every way to run a script string/);
    assert.match(error.message, /safari_read_page/);
    assert.doesNotMatch(error.message, /extension unavailable/);
    return true;
  });
  assert.equal(appleScript.calls, 0, "a profile session must never fall back to AppleScript");
});

test("without SAFARI_PROFILE, the CSP marker still hands the evaluate to AppleScript once", async () => {
  const ran = route({ profile: "", reply: MARKER, fallbackValue: "42" });
  assert.equal(await ran.call("evaluate"), "42");
  assert.equal(ran.appleScript.calls, 1);
  const empty = route({ profile: "", reply: MARKER, fallbackValue: null });
  await assert.rejects(empty.call("evaluate"), /refused every JavaScript injection strategy/);
});
