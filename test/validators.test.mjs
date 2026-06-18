#!/usr/bin/env node
/**
 * Behavioral tests for the iOS/WebKit validation injected scripts, run under jsdom against
 * fixture HTML. The exact strings that ship (imported from injected-validators.js, the same
 * module safari.js uses) are exercised here — no drift between tested and shipped code.
 *
 * Fidelity note: jsdom is NOT WebKit. The CSS-engine paths (env() resolution, CSS.supports)
 * are verified LIVE against real Safari during development; here they are smoke-tested (valid
 * JSON, expected shape). The DOM-parsing paths (viewport meta, PWA <meta>/<link>) ARE faithful.
 *
 * Run:  node --test test/validators.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  VIEWPORT_SCRIPT,
  SAFE_AREA_SCRIPT,
  PWA_SCRIPT,
  WEBKIT_COMPAT_SCRIPT,
} from "../injected-validators.js";

function runInDom(html, script) {
  const dom = new JSDOM(html);
  const { window } = dom;
  const fn = new Function("document", "window", "getComputedStyle", "CSS", "return " + script);
  const raw = fn(
    window.document,
    window,
    window.getComputedStyle ? window.getComputedStyle.bind(window) : undefined,
    window.CSS
  );
  return JSON.parse(raw);
}

const GOOD_HEAD =
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';

test("VIEWPORT: a well-formed viewport meta passes with no issues", () => {
  const r = runInDom(`<!doctype html><html><head>${GOOD_HEAD}</head><body></body></html>`, VIEWPORT_SCRIPT);
  assert.equal(r.ok, true);
  assert.equal(r.errors, 0);
  assert.equal(r.attrs.width, "device-width");
  assert.equal(r.attrs["viewport-fit"], "cover");
});

test("VIEWPORT: missing viewport meta is an error", () => {
  const r = runInDom(`<!doctype html><html><head></head><body></body></html>`, VIEWPORT_SCRIPT);
  assert.equal(r.ok, false);
  assert.ok(r.errors >= 1);
  assert.match(r.issues[0].message, /No viewport meta tag/);
});

test("VIEWPORT: disabled zoom is flagged as a WCAG error", () => {
  const head = '<meta name="viewport" content="width=device-width, user-scalable=no">';
  const r = runInDom(`<!doctype html><html><head>${head}</head><body></body></html>`, VIEWPORT_SCRIPT);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.severity === "error" && /WCAG/.test(i.message)));
});

test("PWA: a fully configured page passes all 6 checks", () => {
  const head = `
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#0a0a0a">
    <link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png">
    <link rel="manifest" href="/manifest.json">
    <link rel="apple-touch-startup-image" href="/splash.png">`;
  const r = runInDom(`<!doctype html><html><head>${head}</head><body></body></html>`, PWA_SCRIPT);
  assert.equal(r.total, 6);
  assert.equal(r.passed, 6);
});

test("PWA: a bare page passes none of the 6 checks", () => {
  const r = runInDom(`<!doctype html><html><head></head><body></body></html>`, PWA_SCRIPT);
  assert.equal(r.total, 6);
  assert.equal(r.passed, 0);
});

test("SAFE_AREA: returns the expected shape; viewport-fit detected from meta (DOM path)", () => {
  const html = `<!doctype html><html><head>${GOOD_HEAD}
    <style>.x{padding-top:env(safe-area-inset-top,0px)}</style></head><body></body></html>`;
  const r = runInDom(html, SAFE_AREA_SCRIPT);
  assert.ok(r.insets && "top" in r.insets, "has insets shape");
  // viewport-fit=cover is read from the meta tag (reliable in jsdom).
  assert.equal(r.viewportFitCover, true);
  // env()-in-stylesheet detection depends on the CSS engine; jsdom drops unknown env() decls,
  // so only assert the shape here — the true-value path is verified LIVE against real Safari.
  assert.equal(typeof r.usedInCSS, "boolean");
});

test("WEBKIT_COMPAT: runs without throwing and returns the expected shape (engine paths live-tested in Safari)", () => {
  const html = `<!doctype html><html><head><style>.s{position:sticky;top:0}</style></head><body></body></html>`;
  const r = runInDom(html, WEBKIT_COMPAT_SCRIPT);
  assert.equal(typeof r.totalProperties, "number");
  assert.ok(Array.isArray(r.unsupported));
  assert.ok(Array.isArray(r.needsPrefix));
  assert.ok(Array.isArray(r.quirks));
});
