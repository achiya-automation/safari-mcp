#!/usr/bin/env node
/**
 * safari_snapshot spends its size on what an agent reads. On a table layout the bare
 * <table><tr><td><span> wrappers and the page's origin, repeated on every link, were most of
 * the snapshot (idea from PR #200 by @fahadjibransheikh). A layout element with nothing of
 * its own now collapses to its content, and a same-origin link is shown as its path. Runs
 * the extension's own snapshot page function under jsdom.
 *
 * Run:  node --test test/snapshot-compact.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const SOURCE = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function pageFunction() {
  const caseAt = SOURCE.indexOf('case "snapshot":');
  const begin = SOURCE.indexOf("(rootSelector, snapshotGen) => {", caseAt);
  const end = SOURCE.indexOf("}, [payload.selector || null", begin);
  assert.ok(caseAt >= 0 && begin > caseAt && end > begin, "the snapshot page function is where this test looks");
  return SOURCE.slice(begin, end + 1);
}

function snapshotOf(body) {
  const dom = new JSDOM(`<body>${body}</body>`, { url: "https://news.example.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  // No layout in jsdom: every element gets a real box, so the walk treats it as visible.
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 });
  return String(window.eval(`(${pageFunction()})(null, 0)`));
}

test("bare table cells and spans collapse to their text, and words stay apart", () => {
  const out = snapshotOf(
    `<table><tr><td><span>1.</span></td><td><span><a href="/item?id=1">First story</a></span></td></tr>` +
    `<tr><td><span><span>396 points</span> by <a href="/user?id=a">a</a></span></td></tr></table>`
  );
  assert.doesNotMatch(out, /<(table|tr|td|span)\b/, out);
  assert.match(out, /1\. +<a ref="[^"]+" href="\/item\?id=1">First story<\/a>/);
  assert.match(out, /396 points by/);
});

test("a same-origin link shows its path; another origin keeps the full URL", () => {
  const out = snapshotOf(`<p><a href="https://news.example.com/newest">new</a> <a href="https://other.example.org/x">x</a></p>`);
  assert.match(out, /href="\/newest"/);
  assert.match(out, /href="https:\/\/other\.example\.org\/x"/);
});

test("a wrapper with an id, a role or a label of its own is kept", () => {
  const out = snapshotOf(
    `<div id="app"><span role="status">Saved</span><div aria-label="Sign in"><input name="e"></div><div><span>plain</span></div></div>`
  );
  assert.match(out, /<div id="app">/);
  assert.match(out, /<span role="status">Saved<\/span>/);
  assert.match(out, /<div aria-label="Sign in"><input ref="[^"]+"/);
  assert.match(out, /plain/);
  assert.doesNotMatch(out, /<(div|span)>/, "a bare wrapper is left in");
});
