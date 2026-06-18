#!/usr/bin/env node
/**
 * Injection-safety tests for the escaping helpers — the security-critical boundary where
 * agent-supplied selectors/text/keys become embedded JS (single-quoted) or AppleScript
 * (double-quoted) string literals. A breakout here = arbitrary code execution in the page
 * or in AppleScript. We prove containment by building the real literal shape, evaluating it,
 * and asserting (a) it parses, (b) no injected statement runs, (c) the payload round-trips.
 *
 * Run:  node --test test/injection-safety.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { escJsSingleQuote, escAppleScriptString } from "../safari.js";

// Quote/backslash breakout vectors (the real JS-injection risk). Raw newlines are NOT here:
// they can't execute code (just truncate the literal) and are flattened to spaces by runJS
// before the script is ever sent — escJsSingleQuote only owns the quote/backslash vector.
const JS_BREAKOUT = [
  "'; globalThis.__PWNED = true; '",
  "') ; globalThis.__PWNED = true ; ('",
  "\\'); globalThis.__PWNED = true; ('",
  "back\\slash",
  '"double" quotes are fine inside single',
  "}); globalThis.__PWNED = true; ({",
  "normal-selector #id .class[attr='v']",
];

test("escJsSingleQuote: breakout payloads stay contained as a string literal", () => {
  for (const payload of JS_BREAKOUT) {
    globalThis.__PWNED = false;
    const built = `var sel = '${escJsSingleQuote(payload)}'; return sel;`;
    let fn;
    assert.doesNotThrow(() => { fn = new Function(built); }, `must parse as valid JS: ${JSON.stringify(payload)}`);
    const out = fn();
    assert.equal(globalThis.__PWNED, false, `payload must NOT execute: ${JSON.stringify(payload)}`);
    assert.equal(out, payload, `payload must round-trip as data: ${JSON.stringify(payload)}`);
  }
  delete globalThis.__PWNED;
});

test("escJsSingleQuote: embedded in a realistic querySelector IIFE — no injected statements run", () => {
  const payload = "#x'); globalThis.__PWNED = true; (function(){return document.querySelector('";
  globalThis.__PWNED = false;
  const stubDoc = { querySelector: () => null };
  const iife = `(function(){ var el = null; try { el = document.querySelector('${escJsSingleQuote(payload)}'); } catch(e){} return 'ok'; })()`;
  let r;
  assert.doesNotThrow(() => { r = new Function("document", "return " + iife)(stubDoc); });
  assert.equal(globalThis.__PWNED, false);
  assert.equal(r, "ok");
  delete globalThis.__PWNED;
});

test("escAppleScriptString: strips CR/LF (injection guard) and escapes quotes + backslashes", () => {
  const out = escAppleScriptString('he said "hi"\nthen \\ left\r\n');
  assert.ok(!/[\r\n]/.test(out), "CR/LF must be stripped (a raw newline would close the AppleScript string)");
  assert.ok(out.includes('\\"'), "double-quotes must be backslash-escaped");
  assert.ok(out.includes("\\\\"), "backslashes must be escaped");
  // Embedded in a double-quoted AppleScript literal, every quote is escaped → no unbalanced quote.
  const unescapedQuotes = (out.match(/(^|[^\\])"/g) || []).length;
  assert.equal(unescapedQuotes, 0, "no unescaped double-quote may remain");
});
