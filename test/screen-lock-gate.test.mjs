#!/usr/bin/env node
/**
 * The screen-lock gate in front of every OS-level (CGEvent) input path.
 *
 * On a locked screen (the lid shut on an awake Mac, or the lock screen up) CGEvent clicks and
 * keys land on loginwindow — keystrokes even in its password field — while native_click /
 * native_type used to report "clicked"/"typed", and a native file-dialog upload reported
 * "Uploaded" with input.files=0. The gate turns all of that into one clear SCREEN_LOCKED error
 * that names the in-page tools, which keep working while locked.
 *
 * The gate itself is tested with an injected probe; a source check pins that every raw CGEvent
 * sender (and the file dialog, before it restyles the page's input) goes through it — a new
 * native path added without the gate fails here.
 *
 * Run:  node --test test/screen-lock-gate.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assertScreenUnlocked, SCREEN_LOCKED_MSG } from "../safari.js";

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "safari.js"), "utf8");

/** @param {string} name */
function bodyOf(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in safari.js`);
  return SOURCE.slice(start, SOURCE.indexOf("\n}\n", start));
}

test("locked screen → SCREEN_LOCKED error that points at the in-page tools", async () => {
  await assert.rejects(assertScreenUnlocked(async () => true), (/** @type {Error} */ err) => {
    assert.match(err.message, /^SCREEN_LOCKED:/);
    assert.match(err.message, /safari_click/);
    assert.match(err.message, /safari_fill/);
    return true;
  });
});

test("unlocked screen → the gate is transparent", async () => {
  await assert.doesNotReject(assertScreenUnlocked(async () => false));
});

test("the message is a single line (tool errors are shown inline)", () => {
  assert.doesNotMatch(SCREEN_LOCKED_MSG, /\n/);
});

test("every raw CGEvent sender is gated before it talks to the helper", () => {
  for (const name of ["_helperNativeClickRaw", "_helperNativeHover", "_helperNativeKeyboardRaw"]) {
    const body = bodyOf(name);
    const gate = body.indexOf("await assertScreenUnlocked()");
    assert.ok(gate >= 0, `${name} must call assertScreenUnlocked()`);
    assert.ok(gate < body.indexOf("_withHelperLock("), `${name} must gate before queueing the CGEvent`);
  }
});

test("screen-lock probe reads both lock keys and fails closed when the probe fails", async () => {
  // Reads the function's own source, so the real ioreg never runs here.
  const body = bodyOf("isScreenLocked").replace(/^function /, "async function ") + "\n}";
  for (const [stdout, expected] of [
    ["<key>CGSSessionScreenIsLocked</key><true/>", true],
    ["<key>CGSSessionScreenIsLocked</key><false/>", false],
    ["<key>IOConsoleLocked</key><true/>", true],
    ["<key>IOConsoleLocked</key><false/>", false],
    ["<key>CGSSessionScreenIsLocked</key><false/><key>IOConsoleLocked</key><true/>", true],
    ["<plist><dict></dict></plist>", false],
    ["<key>CGSSessionScreenIsLocked</key><string>unknown</string>", true],
  ]) {
    const probe = new Function("execFileAsync", `${body}\nreturn isScreenLocked;`)(async () => ({ stdout }));
    assert.equal(await probe(), expected, stdout);
  }
  const failed = new Function("execFileAsync", `${body}\nreturn isScreenLocked;`)(async () => { throw new Error("ioreg unavailable"); });
  assert.equal(await failed(), true);
});

test("the native file dialog is gated before it restyles the page's input", () => {
  const body = bodyOf("_nativeFileUpload");
  assert.ok(body.indexOf("await assertScreenUnlocked()") >= 0, "_nativeFileUpload must be gated");
  assert.ok(
    body.indexOf("await assertScreenUnlocked()") < body.indexOf("data-mcp-oldstyle"),
    "gate must come before the input is turned into an invisible overlay"
  );
});

test("a file dialog that never opened is an error, not an upload", () => {
  const body = bodyOf("_nativeFileUpload");
  assert.match(body, /sheet=false/);
  assert.match(body, /never opened/);
});
