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
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
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

// ========== /proxy-command local-token gate ==========
// The token is the only thing stopping an unrelated local process (a malicious npm
// postinstall, say) from driving the browser through the bridge. It is compared on
// every request, so the comparison itself is part of the boundary: a short-circuiting
// `!==` turns reply latency into a byte-at-a-time oracle for the token.
// _tokenMatches is module-private in index.js (importing it would boot a server), so we
// lift the real source and run it against a stand-in token.
const indexSrc = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function loadTokenMatcher(token) {
  const start = indexSrc.indexOf("function _tokenMatches(");
  assert.ok(start !== -1, "_tokenMatches must exist in index.js");
  const end = indexSrc.indexOf("\n}", start) + 2;
  const body = indexSrc.slice(start, end);
  return new Function("PROXY_TOKEN", "timingSafeEqual", "Buffer", `${body}; return _tokenMatches;`)(
    token, timingSafeEqual, Buffer,
  );
}

test("the /proxy-command gate compares the token in constant time", () => {
  const gate = indexSrc.slice(
    indexSrc.indexOf('req.url === "/proxy-command"'),
    indexSrc.indexOf('req.url === "/proxy-command"') + 400,
  );
  assert.ok(
    !/x-local-token"\]\s*!==/.test(gate),
    "the gate must not short-circuit on !== — that leaks the matching prefix length",
  );
  assert.ok(gate.includes("_tokenMatches("), "the gate must route through the constant-time comparator");
  assert.ok(
    /timingSafeEqual\(a, b\)/.test(indexSrc),
    "_tokenMatches must use crypto.timingSafeEqual, not a byte loop",
  );
});

test("_tokenMatches accepts only the exact token and fails closed on non-strings", () => {
  const TOKEN = "a".repeat(63) + "b"; // 64 hex chars, same shape as randomBytes(32).toString("hex")
  const matches = loadTokenMatcher(TOKEN);

  assert.equal(matches(TOKEN), true, "the exact token must be accepted");

  // Near-misses: right length, wrong content — including a full-length matching prefix.
  assert.equal(matches("a".repeat(64)), false, "a 63-byte matching prefix must still be rejected");
  assert.equal(matches("b".repeat(64)), false);
  assert.equal(matches(TOKEN.slice(0, 63) + "c"), false, "a one-byte difference must be rejected");

  // Length mismatches must be rejected, not thrown — timingSafeEqual throws on unequal
  // lengths, so an unguarded call would 500 instead of 403 and take the server path with it.
  for (const bad of ["", TOKEN.slice(0, 32), TOKEN + "a"]) {
    assert.doesNotThrow(() => matches(bad));
    assert.equal(matches(bad), false, `wrong-length token ${JSON.stringify(bad.slice(0, 8))}… must be rejected`);
  }

  // A header sent twice arrives as an array; absent arrives as undefined. Both fail closed.
  for (const bad of [undefined, null, [TOKEN], [TOKEN, TOKEN], 0, {}, Buffer.from(TOKEN)]) {
    assert.doesNotThrow(() => matches(bad));
    assert.equal(matches(bad), false, `non-string ${Object.prototype.toString.call(bad)} must be rejected`);
  }
});
