#!/usr/bin/env node
/**
 * safari_snapshot diff:true returns only the lines that changed since that tab's previous
 * snapshot (idea from PR #201 by @fahadjibransheikh). Lines compare without refs, which every
 * snapshot renumbers in page order.
 *
 * Run:  node --test test/snapshot-diff.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { diffSnapshots, createSnapshotMemory } from "../snapshot-diff.js";

test("renumbered refs are no change; an added line keeps its fresh ref", () => {
  const before = '<h1>Inbox</h1>\n<button ref="4_1">Compose</button>\n<li><a ref="4_2" href="/m/1">Hello</a></li>';
  const after = '<h1>Inbox</h1>\n<button ref="5_1">Compose</button>\n<li><a ref="5_2" href="/m/1">Hello</a></li><li><a ref="5_3" href="/m/2">New mail</a></li>';
  const out = diffSnapshots(before, after);
  assert.match(out, /\(1 added, 0 removed\)/);
  assert.match(out, /^\+ <li><a ref="5_3" href="\/m\/2">New mail<\/a><\/li>$/m);
  assert.doesNotMatch(out, /Compose|Hello/);
});

test("a removed line is shown without its dead ref, AppleScript refs included", () => {
  const out = diffSnapshots('ref=2_1 button "Save"\nref=2_2 link "Old"', 'ref=3_1 button "Save"');
  assert.match(out, /\(0 added, 1 removed\)/);
  assert.match(out, /^- link "Old"$/m);
  assert.equal(diffSnapshots("<p>same</p>", "<p>same</p>"), "No changes since the previous snapshot.");
});

test("an element inserted at the top changes one line, not every line after it", () => {
  const rows = (first) => Array.from({ length: 5 }, (_, i) => `<li><a ref="1_${first + i}" href="/r/${i}">Row ${i}</a></li>`).join("");
  const out = diffSnapshots(`<ul>${rows(1)}</ul>`, `<div role="alert" ref="2_1">Saved</div>\n<ul>${rows(2)}</ul>`);
  assert.match(out, /\(1 added, 0 removed\)/);
});

test("removed lines past 50 are counted, not listed", () => {
  const before = Array.from({ length: 60 }, (_, i) => `<p>line ${i}</p>`).join("\n");
  const out = diffSnapshots(before, "<p>line 0</p>");
  assert.match(out, /\(0 added, 59 removed\)/);
  assert.match(out, /- … 9 more removed lines$/);
});

test("the memory returns the previous snapshot and keeps the newest 50 keys", () => {
  const memory = createSnapshotMemory();
  assert.equal(memory.swap("a", "one"), undefined);
  assert.equal(memory.swap("a", "two"), "one");
  for (let i = 0; i < 60; i++) memory.swap(`k${i}`, "x");
  assert.equal(memory.size, 50);
  assert.ok(!memory.has("a") && memory.has("k59"));
});

test("safari_snapshot remembers every string snapshot and diffs only when asked", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const begin = source.indexOf('  "safari_snapshot",');
  const handler = source.slice(begin, source.indexOf("server.tool(", begin));
  assert.match(handler, /const previous = _lastSnapshots\.swap\([^;]+;\s*if \(!args\.diff\) return textResult\(result\);/);
});
