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
  assert.match(source, /hardCspBlock = typeof result === 'string' && result\.includes\('CSP blocked all strategies'\)/);
  // It must feed the same branch that already routes unsafe-eval/Trusted Types through
  // the fallback, or the marker becomes the tool's return value again.
  assert.match(source, /const isCspError = hardCspBlock \|\|/);
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
