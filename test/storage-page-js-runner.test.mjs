#!/usr/bin/env node
/**
 * The cookie / localStorage / sessionStorage tools run their page JavaScript through the
 * extension-first ladder (the runner index.js installs), not straight through AppleScript.
 *
 * 2026-09-20: safari_delete_cookies failed with `Safari profile "X" window not found`
 * while list_tabs, run_script and evaluate kept answering through the extension — the
 * storage tools were the only page-JS tools still bound to Apple Events.
 *
 * Run:  node --test test/storage-page-js-runner.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as safari from "../safari.js";

const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");

const STORAGE_FUNCTIONS = [
  "getCookies", "getLocalStorage", "setCookie", "deleteCookies",
  "getSessionStorage", "setSessionStorage", "setLocalStorage",
  "deleteLocalStorage", "deleteSessionStorage", "exportStorageState", "importStorageState",
];

function functionBody(name) {
  const start = safariSource.indexOf(`export async function ${name}(`);
  assert.ok(start > 0, `${name} should exist`);
  return safariSource.slice(start, safariSource.indexOf("\n}\n", start));
}

test("every storage function goes through pageJS, none calls runJS directly", () => {
  for (const name of STORAGE_FUNCTIONS) {
    const body = functionBody(name);
    assert.ok(body.includes("pageJS("), `${name} should use pageJS`);
    // importStorageState keeps runJS / runJSLarge only inside the fallback closure it hands to pageJS.
    const direct = body.replace(/pageJS\([^;]*\);/gs, "").match(/\brunJS(Large)?\(/g) || [];
    assert.deepEqual(direct, [], `${name} still calls AppleScript directly`);
  }
});

test("index.js installs the runner on the evaluate ladder", () => {
  assert.match(indexSource, /safari\.setPageJSRunner\(\(script, fallback\) => extensionOrFallback\("evaluate", \{ script \}, fallback\)\)/);
});

test("with a runner installed the storage tools hand it their script and an AppleScript fallback", async () => {
  const seen = [];
  safari.setPageJSRunner((script, fallback) => {
    seen.push({ script, fallback });
    return `via-runner:${script.length}`;
  });
  try {
    assert.equal(await safari.deleteCookies({ all: true }), "via-runner:" + seen[0].script.length);
    assert.match(seen[0].script, /document\.cookie/);
    assert.equal(typeof seen[0].fallback, "function");

    await safari.deleteCookies({ name: "it's" });
    assert.match(seen[1].script, /document\.cookie='it\\'s=;expires=/);

    await safari.getCookies();
    assert.equal(seen[2].script, "document.cookie");

    await safari.importStorageState({ state: { cookies: "a=1; b=2", localStorage: { k: "v" } } });
    assert.match(seen[3].script, /document\.cookie='a=1';document\.cookie='b=2';localStorage\.setItem\('k','v'\)/);
    assert.equal(typeof seen[3].fallback, "function");
  } finally {
    safari.setPageJSRunner(null);
  }
});

test("without a runner the fallback itself runs (AppleScript path), and a non-function clears the runner", async () => {
  let fallbackRan = false;
  safari.setPageJSRunner((_script, fallback) => { fallbackRan = true; return fallback(); });
  safari.setPageJSRunner("not a function");
  // deleteCookies without name/all throws before any page JS — proves the guard still runs first.
  await assert.rejects(safari.deleteCookies({}), /requires name or all:true/);
  assert.equal(fallbackRan, false);
});
