#!/usr/bin/env node
/**
 * Unit tests for macosCompatNote() — the pure version-classification helper behind the
 * macOS line that doctor() prints. CGEvent.postToPid native clicks/keys can silently no-op
 * on macOS 26+ (Tahoe) even with Accessibility granted (issue #29), so doctor() surfaces the
 * OS version and flags the known-risky range. The parsing/decision logic is pure and lives
 * here under test; the sw_vers round-trip in doctor() is the only untested glue.
 *
 * Run:  node --test test/macos-compat.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { macosCompatNote } from "../safari.js";

test("macOS 26+ is flagged risky and references issue #29", () => {
  const r = macosCompatNote("26.5");
  assert.equal(r.major, 26);
  assert.equal(r.risky, true);
  assert.match(r.line, /26\.5/);
  assert.match(r.line, /#29/);
});

test("macOS 25 and below are reported as supported (not risky)", () => {
  for (const v of ["15.5", "14.7.2", "25.0", "13.0"]) {
    const r = macosCompatNote(v);
    assert.equal(r.risky, false, `${v} must not be risky`);
    assert.match(r.line, new RegExp(v.replace(/\./g, "\\.")));
    assert.doesNotMatch(r.line, /#29/, `${v} must not show the #29 warning`);
  }
});

test("future majors (27+) stay flagged risky", () => {
  assert.equal(macosCompatNote("27.0").risky, true);
  assert.equal(macosCompatNote("30.1.2").risky, true);
});

test("garbage / missing input degrades gracefully without throwing", () => {
  for (const bad of ["", "   ", undefined, null, "not-a-version", "abc.def"]) {
    const r = macosCompatNote(bad);
    assert.equal(r.risky, false, `${JSON.stringify(bad)} must not be risky`);
    assert.match(r.line, /unknown/i, `${JSON.stringify(bad)} should report unknown`);
  }
});

test("always returns a non-empty single-line string", () => {
  for (const v of ["26.5", "15.0", "", "garbage"]) {
    const r = macosCompatNote(v);
    assert.equal(typeof r.line, "string");
    assert.ok(r.line.trim().length > 0);
    assert.doesNotMatch(r.line, /\n/, "line must be single-line (doctor joins on \\n)");
  }
});
