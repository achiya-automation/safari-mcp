#!/usr/bin/env node
/**
 * Safari does not load the extension's scripts as UTF-8: it decodes them in the system's
 * legacy text encoding (Mac Hebrew on the machine where this was found, Mac Roman on an
 * English one). Read from inside the running worker on 2026-09-20 (#109), the literal
 * " — " in `_canonicalProfileName` had the char codes 20 5d2 20ac 201d 20 — so the em
 * dash in a window title never matched, a stored identity like
 * "אוטומציות — עמוד הפתיחה" was never reduced to "אוטומציות", and that profile's worker
 * rejected its own host forever ("Safari profile extension unavailable" for one profile
 * while the other three worked). Non-ASCII in code therefore has to be written as
 * escapes; comments may say what they like.
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const SCRIPTS = ["background.js", "content.js", "command-content.js"];
const sources = Object.fromEntries(
  SCRIPTS.map((name) => [name, readFileSync(new URL(`../extension/${name}`, import.meta.url), "utf8")]),
);

// Code lines only: block comments and `//` tails are dropped before looking for non-ASCII.
function nonAsciiCodeLines(source) {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  const hits = [];
  withoutBlocks.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    if (/[^\x20-\x7e\t]/.test(code)) hits.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return hits;
}

// What a legacy single-byte decoder does to UTF-8 source: every non-ASCII character
// becomes two or three unrelated characters. Escapes are ASCII and survive untouched.
function legacyDecoded(source) {
  return Buffer.from(source, "utf8").toString("latin1");
}

function extractCanonicalizer(source) {
  const start = source.indexOf("function _canonicalProfileName(");
  const end = source.indexOf("\n}", start);
  assert.ok(start > 0 && end > start, "profile canonicalizer should exist");
  return source.slice(start, end + 2);
}

for (const name of SCRIPTS) {
  test(`extension/${name} carries no raw non-ASCII character outside comments`, () => {
    assert.deepEqual(nonAsciiCodeLines(sources[name]), [], "write it as \\uXXXX — Safari will not decode this file as UTF-8");
  });
}

test("the profile canonicalizer still strips the window-title suffix when its own source is decoded in a legacy encoding", () => {
  const fnSource = extractCanonicalizer(sources["background.js"]);
  const asShipped = Function(`${fnSource}; return _canonicalProfileName;`)();
  const asSafariLoadsIt = Function(`${legacyDecoded(fnSource)}; return _canonicalProfileName;`)();
  for (const [stored, bare] of [
    ["אוטומציות — עמוד הפתיחה", "אוטומציות"],
    ["wrong:עבודה — mcp-profile-check-1789887891948", "עבודה"],
    ["מחקר אנונימי", "מחקר אנונימי"],
  ]) {
    assert.equal(asShipped(stored), bare);
    assert.equal(asSafariLoadsIt(stored), bare, `legacy-decoded source must still reduce ${JSON.stringify(stored)}`);
  }
});

test("the same function with a raw em dash literal is exactly the bug: it passes as shipped and fails as Safari loads it", () => {
  const rawLiteral = extractCanonicalizer(sources["background.js"]).replace('indexOf(" \\u2014 ")', 'indexOf(" — ")');
  assert.notEqual(rawLiteral, extractCanonicalizer(sources["background.js"]), "the shipped source uses the escape");
  const asShipped = Function(`${rawLiteral}; return _canonicalProfileName;`)();
  const asSafariLoadsIt = Function(`${legacyDecoded(rawLiteral)}; return _canonicalProfileName;`)();
  assert.equal(asShipped("אוטומציות — עמוד הפתיחה"), "אוטומציות", "Node reads UTF-8, so the raw literal works here");
  assert.equal(asSafariLoadsIt("אוטומציות — עמוד הפתיחה"), "אוטומציות — עמוד הפתיחה", "and never in Safari");
});
