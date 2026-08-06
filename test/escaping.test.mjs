#!/usr/bin/env node
/**
 * Unit test for the string-escaping helpers (escJsSingleQuote, escAppleScriptString).
 * Locks each helper to the current recipe so a future edit can't silently flip the escaping
 * ORDER — which is security-relevant: backslash must be escaped before the quote, or the
 * backslash inserted in front of the quote gets doubled and the string breaks out.
 *
 * escJsSingleQuote recipe (in order):
 *   1. \\ → \\\\  (backslash — MUST be first)
 *   2. '  → \\'   (single quote)
 *   3. \r → \\r   (CR)
 *   4. \n → \\n   (LF)
 *   5. U+2028 → \\u2028  (ECMAScript LineTerminator — raw form is a SyntaxError in regex)
 *   6. U+2029 → \\u2029  (ECMAScript LineSeparator — same)
 *
 * NOTE: steps 3–6 are a deliberate behavior change — multiline values now round-trip as
 * escape sequences inside the single-quoted JS literal instead of being silently
 * space-flattened by runJS downstream.
 *
 * Run:  node test/escaping.test.mjs
 */
import assert from "node:assert";
import { escJsSingleQuote, escAppleScriptString } from "../safari.js";

// The EXACT current recipe for escJsSingleQuote. If the helper ever drifts from this, the
// loop below fails — intentional, because escaping order is security-relevant.
const inlineJs = (s) =>
  s.replace(/\\/g, "\\\\")
   .replace(/'/g, "\\'")
   .replace(/\r/g, "\\r")
   .replace(/\n/g, "\\n")
   .replace(/\u2028/g, "\\u2028")
   .replace(/\u2029/g, "\\u2029");
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
