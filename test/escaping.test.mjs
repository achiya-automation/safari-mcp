#!/usr/bin/env node
/**
 * Unit test for the string-escaping helpers (escJsSingleQuote, escAppleScriptString) extracted in
 * the 2026-06-05 dedup pass. Locks each helper's output to the historical inline recipe it replaced,
 * so the dedup is provably behavior-preserving and a future edit can't silently flip the escaping
 * ORDER — which is security-relevant: backslash must be escaped before the quote, or the backslash
 * inserted in front of the quote gets doubled and the string breaks out.
 *
 * Run:  node test/escaping.test.mjs
 */
import assert from "node:assert";
import { escJsSingleQuote, escAppleScriptString } from "../safari.js";

// The EXACT inline patterns these helpers replaced across safari.js. If safari.js's helper ever
// drifts from this recipe, the loop below fails.
const inlineJs = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const inlineAs = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "");

const cases = [
  "plain text",
  "it's a quote",
  "back\\slash",
  "both ' and \\ mixed",
  "line1\nline2\r\nline3",
  "",
  "tab\tinside",
  "'; document.title='x'; '", // attempted JS-string breakout
  'a "double" quote',
  "\\'",                       // order-sensitive: a backslash directly followed by a quote
  "\\\\",                      // a double backslash
];

let pass = 0, fail = 0;
for (const s of cases) {
  try {
    assert.strictEqual(escJsSingleQuote(s), inlineJs(s), `escJsSingleQuote(${JSON.stringify(s)})`);
    assert.strictEqual(escAppleScriptString(s), inlineAs(s), `escAppleScriptString(${JSON.stringify(s)})`);
    console.log(`  ok   ${JSON.stringify(s)}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${e.message}`);
    fail++;
  }
}

// Order-sensitivity, asserted without hand-counting backslashes: the buggy quote-first order
// would double the backslash. Our helper must NOT produce the buggy output.
const buggyQuoteFirst = (s) => s.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
try {
  assert.notStrictEqual(escJsSingleQuote("\\'"), buggyQuoteFirst("\\'"), "escaping order must be backslash-first");
  // A raw newline must be stripped from an AppleScript literal (else it closes the string).
  assert.strictEqual(escAppleScriptString("a\nb"), "ab");
  assert.ok(!escAppleScriptString("x\r\ny").includes("\n"), "CR/LF must be stripped");
  console.log("  ok   order-sensitivity + CR/LF stripping");
  pass++;
} catch (e) {
  console.error(`  FAIL ${e.message}`);
  fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
