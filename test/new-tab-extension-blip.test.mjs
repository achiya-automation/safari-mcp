#!/usr/bin/env node
/**
 * safari_new_tab waits out a short extension drop-out instead of opening the tab through
 * AppleScript, and says so when it still has to.
 *
 * Seen on 24.10.26: Safari suspended the extension's worker for a few seconds between two calls.
 * A safari_new_tab with a URL landed in that gap and went to AppleScript. The tab came back as
 * {tabIndex, title, safeUrl} with no receipt and nothing saying why, and a few seconds later,
 * with the extension back, safari_switch_tab refused that tab as "not opened by this MCP session".
 * The session was left with a tab it could not reach.
 *
 * The wait is the real code, extracted from index.js and run against a stand-in for the bridge's
 * connection state; where it is called from, and the label on an AppleScript tab, are read from
 * the source. The other harnesses run safari_new_tab end to end with a stubbed bridge.
 *
 * Run:  node --test test/new-tab-extension-blip.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const helpers = between(index, "const EXTENSION_BLIP_WINDOW_MS", "async function extensionOrFallback(");

function bridge({ connected = false, lastUsedAgoMs = null } = {}) {
  const context = vm.createContext({ setTimeout, Date });
  vm.runInContext(
    `let _extensionConnected = ${connected};\n` +
      helpers +
      `\nglobalThis.api = {
        wait: _waitForExtensionBlip,
        connect() { _extensionConnected = true; },
        setLastUsed(ms) { _extensionLastUsedAt = ms; },
      };`,
    context
  );
  if (lastUsedAgoMs !== null) context.api.setLastUsed(Date.now() - lastUsedAgoMs);
  return context.api;
}

test("a connected extension is used at once", async () => {
  const api = bridge({ connected: true });
  const t0 = Date.now();
  assert.equal(await api.wait(5000), true);
  assert.ok(Date.now() - t0 < 100);
});

test("a session the extension never served falls back at once", async () => {
  const api = bridge();
  const t0 = Date.now();
  assert.equal(await api.wait(5000), false);
  assert.ok(Date.now() - t0 < 100);
});

test("an extension lost long ago is not waited for", async () => {
  const api = bridge({ lastUsedAgoMs: 10 * 60 * 1000 });
  const t0 = Date.now();
  assert.equal(await api.wait(5000), false);
  assert.ok(Date.now() - t0 < 100);
});

test("an extension that served the session a moment ago is waited for until it is back", async () => {
  const api = bridge({ lastUsedAgoMs: 5000 });
  setTimeout(() => api.connect(), 600);
  const t0 = Date.now();
  assert.equal(await api.wait(5000), true);
  const waited = Date.now() - t0;
  assert.ok(waited >= 500 && waited < 2000, `waited ${waited} ms`);
});

test("the wait is bounded when the extension stays away", async () => {
  const api = bridge({ lastUsedAgoMs: 5000 });
  const t0 = Date.now();
  assert.equal(await api.wait(600), false);
  const waited = Date.now() - t0;
  assert.ok(waited >= 600 && waited < 1500, `waited ${waited} ms`);
});

test("only a new_tab in the default mode waits, before anything is sent", () => {
  const fallback = between(index, "async function extensionOrFallback(", "\n}\n");
  const wait = fallback.indexOf("await _waitForExtensionBlip()");
  assert.ok(wait > 0 && wait < fallback.indexOf("sendToExtension("), "the wait comes before the extension is asked");
  assert.match(fallback, /if \(!_preferAppleScript && extensionType === "new_tab" && !_extensionConnected\) await _waitForExtensionBlip\(\);/);
});

test("safari_new_tab says when AppleScript opened the tab, and that it has no receipt", () => {
  const handler = between(index, '"safari_new_tab",', 'server.tool(\n  "safari_close_tab"');
  const label = between(handler, "if (viaAppleScript && safeResult", "\n    }\n");
  assert.match(label, /receipt: null/);
  assert.match(label, /via: "applescript"/);
  assert.match(label, /no receipt/);
  assert.ok(handler.indexOf(label) < handler.indexOf("_setActiveReceipt(safeResult.receipt)"), "labelled before it is tracked");
});

test("every command the extension serves refreshes the blip window", () => {
  const fallback = between(index, "async function extensionOrFallback(", "\n}\n");
  assert.match(fallback, /if \(usedExtension\) _extensionLastUsedAt = Date\.now\(\);\n\s*if \(!usedExtension\)/);
});
