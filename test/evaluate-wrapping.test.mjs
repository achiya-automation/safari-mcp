#!/usr/bin/env node
/**
 * Unit tests for _buildEvalExpr and _buildSyncEvalJs — the pure (no-Safari) wrapper builders
 * behind safari_evaluate's AppleScript engine. Locks the async-detection + return-injection
 * behavior, the regex gap the sync wrapper compensates for (the 2026-06-18 #2 fix), and that
 * neither wrapper ever runs a script a second time.
 *
 * Run:  node --test test/evaluate-wrapping.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { _buildEvalExpr, _buildSyncEvalJs } from "../safari.js";

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

test("REGEX GAP: an async IIFE with no inner await is classified sync — the sync wrapper awaits its value (#2)", () => {
  const r = _buildEvalExpr("(async function(){ return 1 })()");
  // The static sniff can't see that this resolves to a Promise, so isAsync is false.
  // _buildSyncEvalJs sees the thenable at runtime and awaits it into a slot.
  assert.equal(r.isAsync, false);
  assert.equal(r.expr, "(async function(){ return 1 })()");
});

/** A page for the wrapper: `posts` counts the script's side effects. */
function page(extra = {}) {
  const posts = [];
  const ctx = vm.createContext({ __post: () => posts.push(1), ...extra });
  ctx.window = ctx;
  return { posts, ctx, run: (js) => vm.runInContext(js, ctx) };
}

test("a thenable value is awaited in place — the script is not evaluated a second time", async () => {
  // The old evaluate() saw "[object Promise]" come back and ran the whole script again
  // through the async poller: a fire-and-forget POST went out twice.
  const { expr } = _buildEvalExpr("(async function(){ __post(); return 1 })()");
  const p = page();
  assert.equal(p.run(_buildSyncEvalJs(expr, "window.__mcpEval_t")), "__MCP_EVAL_PENDING__");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(p.ctx.__mcpEval_t.done, true);
  assert.equal(p.ctx.__mcpEval_t.val, "1");
  assert.equal(p.posts.length, 1);
});

test("a plain value still comes straight back from the sync wrapper", () => {
  const { expr } = _buildEvalExpr("__post();\n6 * 7");
  const p = page();
  assert.equal(p.run(_buildSyncEvalJs(expr, "window.__mcpEval_t")), 42);
  assert.equal(p.posts.length, 1);
});

test("a multi-statement script that throws is reported, not run again as a plain body", () => {
  // The eval fallback re-ran the body on ANY error, meant only for a CSP that refuses eval.
  const { expr } = _buildEvalExpr('__post();\nthrow new Error("boom")');
  const p = page();
  assert.equal(p.run(_buildSyncEvalJs(expr, "window.__mcpEval_t")), "Error: boom");
  assert.equal(p.posts.length, 1);
});

test("where the page refuses eval, the plain body is the fallback — and runs once", () => {
  const { expr } = _buildEvalExpr("__post();\nvar x = 1");
  const p = page({ eval: () => { throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval'"); } });
  p.run(_buildSyncEvalJs(expr, "window.__mcpEval_t"));
  assert.equal(p.posts.length, 1);
});
