#!/usr/bin/env node
/**
 * safari_snapshot diff:true returns only the lines that changed since the tab's previous
 * snapshot. Lines compare without their refs, which every snapshot renumbers in page order.
 * Runs index.js's real diff helpers.
 *
 * Run:  node --test test/snapshot-diff.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const INDEX = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const BACKGROUND = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
};

const diffApi = Function(
  `${between(INDEX, "const _lastSnapshots = new Map();", "function buildServer() {")}
   return { _snapshotDiff, _rememberSnapshot, _lastSnapshots };`
)();

test("diff ignores renumbered refs and reports only changed lines", () => {
  const before = '<h1>Inbox</h1>\n<button ref="4_1">Compose</button>\n<li><a ref="4_2" href="/m/1">Hello</a></li>';
  const after = '<h1>Inbox</h1>\n<button ref="5_1">Compose</button>\n<li><a ref="5_2" href="/m/1">Hello</a></li><li><a ref="5_3" href="/m/2">New mail</a></li>';
  const out = diffApi._snapshotDiff(before, after);
  assert.match(out, /1 added, 0 removed/);
  assert.match(out, /^\+ <li><a ref="5_3" href="\/m\/2">New mail<\/a><\/li>$/m, "added lines keep their new refs");
  assert.doesNotMatch(out, /Compose|Hello/, "lines that only got new refs are unchanged");
});

test("removed lines are shown without their dead refs; AppleScript refs compare too", () => {
  const out = diffApi._snapshotDiff('ref=2_1 button "Save"\nref=2_2 link "Old"', 'ref=3_1 button "Save"');
  assert.match(out, /0 added, 1 removed/);
  assert.match(out, /^- link "Old"$/m);
  assert.equal(diffApi._snapshotDiff("<p>same</p>", "<p>same</p>"), "No changes since the previous snapshot.");
});

test("the snapshot cache keeps the 50 most recent tabs", () => {
  for (let i = 0; i < 60; i++) diffApi._rememberSnapshot(`k${i}`, "x");
  assert.equal(diffApi._lastSnapshots.size, 50);
  assert.ok(!diffApi._lastSnapshots.has("k0") && diffApi._lastSnapshots.has("k59"));
});

test("safari_snapshot remembers every snapshot and diffs only when asked", () => {
  const handler = between(INDEX, '  "safari_snapshot",\n  "PREFERRED', "server.tool(");
  assert.match(handler, /_rememberSnapshot\(key, result\);\s*if \(!args\.diff\) return textResult\(result\);/);
});


test("an element inserted near the top does not make every later line differ", () => {
  const rows = (start) => Array.from({ length: 5 }, (_, i) => `<li><a ref="1_${start + i}" href="/r/${i}">Row ${i}</a></li>`).join("");
  const out = diffApi._snapshotDiff(`<ul>${rows(1)}</ul>`, `<div role="alert" ref="2_1">Saved</div>\n<ul>${rows(2)}</ul>`);
  assert.match(out, /1 added, 0 removed/);
  assert.match(out, /\+ <div role="alert" ref="2_1">Saved<\/div>/);
});
