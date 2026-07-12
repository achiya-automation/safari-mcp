#!/usr/bin/env node
/**
 * Behavioral tests for mcpClick's event dispatch, run under jsdom against the SHIPPED
 * mcp-helpers.js (no copy, no drift).
 *
 * These pin down two regressions that silently turned a click into a navigation on
 * Meta Business Suite (rel="dialog" links) and on SPA routers generally:
 *
 *   1. The event must be dispatched from the LEAF under the click point, so that
 *      `event.target` is the inner node — as it is for a real click — and not the
 *      actionable <a>/<button>. Handlers that gate on e.target reject the latter,
 *      and the click silently degrades into a plain navigation.
 *   2. The forced `location.href = href` must NOT run when a handler called
 *      preventDefault: that handler owns the click (it just opened a dialog or pushed
 *      a route) and navigating would tear it down.
 *
 * jsdom has no layout engine, so getBoundingClientRect and elementFromPoint are stubbed;
 * elementFromPoint returns the deepest node at the pixel, which is what a real browser
 * does and is precisely the behaviour under test. jsdom also refuses real navigation, so
 * an attempted one surfaces as a "Not implemented: navigation" jsdomError — which is
 * exactly the signal we assert on.
 *
 * Run:  node --test test/click-dispatch.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HELPERS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "mcp-helpers.js"),
  "utf8"
);

const START_URL = "http://localhost/start";

function domWithHelpers(html) {
  // jsdom reports a blocked navigation as a jsdomError; that is our "did it navigate?" probe.
  const navAttempts = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => {
    if (/Not implemented: navigation/i.test(err.message || "")) navAttempts.push(err.message);
  });

  const dom = new JSDOM(`<body>${html}</body>`, {
    url: START_URL,
    pretendToBeVisual: true,
    // Gives window.eval a real in-page realm, so the helpers see the browser globals
    // they expect (window, MutationObserver, PointerEvent, ...). "outside-only" runs
    // only what we hand it — the fixture HTML has no <script> of its own.
    runScripts: "outside-only",
    virtualConsole,
  });
  const { window } = dom;

  // No layout engine in jsdom: give every element a non-zero box so mcpIsVisible passes.
  window.Element.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40, x: 0, y: 0,
  });
  // A real elementFromPoint returns the DEEPEST node at the pixel. That is the whole point
  // of the fix, so model it faithfully.
  window.document.elementFromPoint = () => window.document.querySelector("[data-leaf]");

  window.eval(HELPERS);
  return { window, navAttempts };
}

test("CLICK: event is dispatched from the leaf — event.target is the inner node, not the <a>", () => {
  const { window } = domWithHelpers(
    `<a href="/target" id="link"><div data-leaf>Ask a Question</div></a>`
  );
  const link = window.document.getElementById("link");
  const leaf = window.document.querySelector("[data-leaf]");

  let seenTarget = null;
  let seenCurrentTarget = null;
  link.addEventListener("click", (e) => {
    seenTarget = e.target;
    seenCurrentTarget = e.currentTarget;
    e.preventDefault(); // stands in for Meta's rel="dialog" gate
  });

  window.mcpClick(link);

  // The regression: dispatching straight at the <a> made target === the <a>, which is
  // exactly the shape Meta's dialog gate rejects.
  assert.equal(seenTarget, leaf, "event.target must be the leaf <div>, not the <a>");
  assert.equal(seenCurrentTarget, link, "event.currentTarget must still be the <a>");
});

test("CLICK: preventDefault suppresses the forced navigation (dialog/SPA route survives)", () => {
  const { window, navAttempts } = domWithHelpers(
    `<a href="/target" id="link"><div data-leaf>Open dialog</div></a>`
  );
  const link = window.document.getElementById("link");

  // A dialog/router handler: claims the click and opens something instead of navigating.
  link.addEventListener("click", (e) => e.preventDefault());

  window.mcpClick(link);

  assert.deepEqual(
    navAttempts,
    [],
    "must not navigate after preventDefault — the forced location.href destroyed the dialog"
  );
});

test("CLICK: an unclaimed anchor still navigates (the fix must not break plain links)", () => {
  const { window, navAttempts } = domWithHelpers(
    `<a href="/target" id="link"><div data-leaf>Plain link</div></a>`
  );
  const link = window.document.getElementById("link");
  // No handler at all — nobody claims the click, so the anchor must still be followed.

  window.mcpClick(link);

  assert.ok(
    navAttempts.length > 0,
    "an unclaimed anchor must still navigate — the guard must not swallow ordinary links"
  );
});
