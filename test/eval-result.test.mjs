#!/usr/bin/env node
/**
 * Unit tests for `evalResult` — the response envelope behind safari_evaluate / safari_eval_file.
 *
 * The form it replaced was `(typeof r === 'string' ? r : JSON.stringify(r)) || "(no return value)"`,
 * a falsy check standing in for an existence check. It reported an empty-string return as
 * "(no return value)", which is the same text a script that returned nothing produces — and the
 * same text a CSP-blocked injection that never ran produces. Observed live on 2026-09-11:
 * `(() => "")()` on example.com printed "(no return value)" while `(() => 0)()` printed "0",
 * because "0" is a truthy string and "" is not.
 *
 * Run:  node --test test/eval-result.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evalResult } from "../response.js";

const text = (r) => evalResult(r).content[0].text;

test("a script that returned nothing says so", () => {
  assert.equal(text(undefined), "(no return value)");
});

test("an empty string is a value, not an absent one", () => {
  assert.equal(text(""), '""');
  assert.notEqual(text(""), text(undefined));
});

test("falsy values that are real results survive", () => {
  assert.equal(text(0), "0");
  assert.equal(text(false), "false");
  assert.equal(text(null), "null");
  assert.equal(text(NaN), "null"); // JSON has no NaN; documenting the existing behaviour
});

test("non-empty strings pass through byte-identically", () => {
  assert.equal(text("hello"), "hello");
  assert.equal(text("(no return value)"), "(no return value)"); // AppleScript fallback's own string
});

test("objects and arrays are JSON-stringified, not [object Object]", () => {
  assert.equal(text({ a: "", b: 0 }), '{"a":"","b":0}');
  assert.equal(text([]), "[]");
  assert.equal(text([1, 2]), "[1,2]");
});

test("values JSON cannot represent report no return rather than crashing", () => {
  assert.equal(text(() => {}), "(no return value)");
  assert.equal(text(Symbol("x")), "(no return value)");
});

test("the envelope shape matches every other tool response", () => {
  const r = evalResult("x");
  assert.deepEqual(Object.keys(r), ["content"]);
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, "text");
});
