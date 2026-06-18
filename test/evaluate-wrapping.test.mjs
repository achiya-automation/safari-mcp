#!/usr/bin/env node
/**
 * Unit tests for _buildEvalExpr — the pure (no-Safari) wrapper builder behind safari_evaluate.
 * Locks the async-detection + return-injection behavior, and documents the regex gap that the
 * runtime "[object Promise]" fallback in evaluate() compensates for (the 2026-06-18 #2 fix).
 *
 * Run:  node --test test/evaluate-wrapping.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { _buildEvalExpr } from "../safari.js";

test("IIFE scripts pass through unchanged (sync)", () => {
  const r = _buildEvalExpr("(function(){return 1})()");
  assert.equal(r.isAsync, false);
  assert.equal(r.expr, "(function(){return 1})()");
});

test("a bare simple expression is used as-is (sync)", () => {
  const r = _buildEvalExpr("document.title");
  assert.equal(r.isAsync, false);
  assert.equal(r.expr, "document.title");
});

test("await marks the script async and wraps it in an async IIFE", () => {
  const r = _buildEvalExpr('await fetch("/x")');
  assert.equal(r.isAsync, true);
  assert.match(r.expr, /async function/);
});

test(".then() marks the script async", () => {
  const r = _buildEvalExpr("p.then(function(x){return x})");
  assert.equal(r.isAsync, true);
});

test("an un-awaited fetch is NOT async (fire-and-forget, returns undefined)", () => {
  const r = _buildEvalExpr('fetch("/x")');
  assert.equal(r.isAsync, false);
});

test("multi-statement script gets `return` prepended on the last value line", () => {
  const r = _buildEvalExpr("var x = 2;\nx + 1");
  assert.equal(r.isAsync, false);
  assert.match(r.expr, /return x \+ 1/);
  assert.match(r.expr, /^\(function\(\)\{/);
});

test("REGEX GAP: an async IIFE with no inner await is classified sync — the runtime [object Promise] fallback in evaluate() handles it (#2)", () => {
  const r = _buildEvalExpr("(async function(){ return 1 })()");
  // The static sniff can't see that this resolves to a Promise, so isAsync is false.
  // evaluate() detects the literal "[object Promise]" at runtime and re-runs via the poller.
  assert.equal(r.isAsync, false);
  assert.equal(r.expr, "(async function(){ return 1 })()");
});
