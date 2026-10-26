#!/usr/bin/env node
/**
 * #187: an element with display:contents has no box (a 0x0 rect), and the extension's
 * snapshot walk stopped at it, so everything inside such a root was left out and a page
 * mounted in one returned an empty snapshot. Runs the extension's own snapshot page
 * function under jsdom.
 *
 * Run:  node --test test/snapshot-display-contents.test.mjs
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
  const dom = new JSDOM(`<body>${body}</body>`, { url: "http://127.0.0.1/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  // No layout in jsdom: a display:contents element gets the empty rect a browser gives it,
  // everything else a real box.
  window.Element.prototype.getBoundingClientRect = function () {
    return window.getComputedStyle(this).display === "contents"
      ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
      : { left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 };
  };
  return window.eval(`(${pageFunction()})(null, 0)`);
}

test("children of a display:contents root are in the snapshot", () => {
  const out = String(snapshotOf(
    `<div id="root" style="display:contents"><h1>Heading inside</h1><button id="go">Go</button></div>`
  ));
  assert.match(out, /Heading inside/);
  assert.match(out, /<button ref="[^"]+"[^>]*>Go<\/button>/);
});

test("display:none still hides its subtree", () => {
  const out = String(snapshotOf(`<div style="display:none"><button>Hidden</button></div><p>Shown</p>`));
  assert.doesNotMatch(out, /Hidden/);
  assert.match(out, /Shown/);
});
