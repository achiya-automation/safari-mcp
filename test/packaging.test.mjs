#!/usr/bin/env node
/**
 * Packaging guard — every relative import in a published file must ALSO be published.
 *
 * Regression test for #50: `transport.js` was imported by index.js but missing from the
 * package.json `files` allowlist, so every tarball since 2.14.0 failed on a clean install
 * with ERR_MODULE_NOT_FOUND. This test walks the published JS files, resolves their static
 * relative imports, and asserts each target is covered by `files` — catching the whole class
 * of "imported but not shipped", not just this one file.
 *
 * Run:  node --test test/packaging.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const files = pkg.files;

// A path ships if it's listed verbatim or sits under a listed directory (entry ending in "/").
function isPublished(rel) {
  rel = normalize(rel);
  if (files.includes(rel)) return true;
  return files.some((f) => f.endsWith("/") && rel.startsWith(normalize(f) + "/"));
}

// Static relative specifiers: import ... from "./x", import "./x", export ... from "./x".
function relativeImports(src) {
  const re = /(?:from|import)\s*["'](\.[^"']+)["']/g;
  const out = [];
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

// Node ESM resolution for a bare relative specifier → try as-is, then .js.
function resolveSpecifier(fromRel, spec) {
  const base = join(dirname(fromRel), spec);
  for (const cand of [base, base + ".js", base + ".mjs", join(base, "index.js")]) {
    const abs = join(root, cand);
    try {
      readFileSync(abs);
      return normalize(cand);
    } catch {
      /* try next */
    }
  }
  return normalize(base); // report the un-suffixed path in the failure
}

test("every relative import in a published JS file is also published", () => {
  const jsEntries = files.filter((f) => /\.(js|mjs|cjs)$/.test(f));
  const missing = [];
  for (const entry of jsEntries) {
    const src = readFileSync(join(root, entry), "utf8");
    for (const spec of relativeImports(src)) {
      const target = resolveSpecifier(entry, spec);
      if (!isPublished(target))
        missing.push(`${entry} imports ${spec} → ${target} (not in files[])`);
    }
  }
  assert.deepEqual(missing, [], `unpublished imports:\n${missing.join("\n")}`);
});
