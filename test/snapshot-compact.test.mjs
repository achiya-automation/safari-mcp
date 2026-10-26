#!/usr/bin/env node
/**
 * safari_snapshot spends its size on what the agent reads, not on layout markup. On a table
 * layout (news.ycombinator.com, 2026-10-20) the <table><tr><td><span> wrappers and the origin
 * repeated on every link were most of a 24.7k-character snapshot. Runs the extension's real
 * snapshot page function in jsdom.
 *
 * Run:  node --test test/snapshot-compact.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const BACKGROUND = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function snapshotFunction() {
  const start = BACKGROUND.indexOf('case "snapshot":');
  const from = BACKGROUND.indexOf("(rootSelector, snapshotGen) => {", start);
  const to = BACKGROUND.indexOf("}, [payload.selector || null", from);
  assert.ok(start >= 0 && from > start && to > from, "snapshot page function should exist");
  return BACKGROUND.slice(from, to + 1);
}

function snapshot(html, url = "https://news.example.com/") {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  // jsdom has no layout: report every element as a 10x10 box so the walk sees it as visible.
  dom.window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 });
  return dom.window.eval(`(${snapshotFunction()})(null, 0)`);
}

test("layout wrappers collapse to their content, keeping words apart", () => {
  const out = snapshot(`<body><table><tr><td><span>1.</span></td><td><span>
    <a href="/item?id=1">First story</a></span></td></tr>
    <tr><td><span><span>396 points</span> by <a href="/user?id=ggcr">ggcr</a></span></td></tr></table></body>`);
  assert.doesNotMatch(out, /<(table|tr|td|span)\b/, `layout tags left in: ${out}`);
  assert.match(out, /<a ref="0_\d+" href="\/item\?id=1">First story<\/a>/);
  assert.match(out, /396 points by/);
  assert.match(out, /1\. +<a/, "cells of a row stay separated");
});

test("same-origin links lose the origin; other origins keep it", () => {
  const out = snapshot(`<body><p><a href="https://news.example.com/newest">new</a>
    <a href="https://github.com/x/y">gh</a></p></body>`);
  assert.match(out, /href="\/newest"/);
  assert.match(out, /href="https:\/\/github\.com\/x\/y"/);
});

test("a wrapper with attributes of its own is kept", () => {
  const out = snapshot(`<body><div role="dialog" aria-label="Sign in"><span>Email</span><input name="e"></div></body>`);
  assert.match(out, /<div role="dialog" aria-label="Sign in">/);
  assert.match(out, /<input ref="0_\d+"/);
});

test("a div with only an id and a span with only a role STAY; bare siblings collapse", () => {
  const out = snapshot(`<body><div id="app"><span role="status">Saved</span><div><span>plain</span></div></div></body>`);
  assert.match(out, /<div id="app">/, `id wrapper dropped: ${out}`);
  assert.match(out, /<span role="status">Saved<\/span>/, `role wrapper dropped: ${out}`);
  assert.match(out, /plain/);
  assert.doesNotMatch(out, /<(div|span)>/, `bare wrapper left in: ${out}`);
});

test("a display:contents wrapper collapses when bare and stays when it has an id", () => {
  const out = snapshot(`<body><div style="display:contents"><p>bare</p></div>
    <div id="keep" style="display:contents"><p>kept</p></div></body>`);
  assert.doesNotMatch(out, /<div>/, `bare display:contents wrapper left in: ${out}`);
  assert.match(out, /<div id="keep">/);
  assert.match(out, /bare/);
});
