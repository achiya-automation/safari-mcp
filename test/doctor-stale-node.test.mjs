#!/usr/bin/env node
/**
 * doctor warns when the server still runs a node binary that was deleted under it (a Homebrew
 * upgrade while a LaunchAgent daemon kept running), because no permission can be granted to it.
 *
 * Run:  node --test test/doctor-stale-node.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { staleNodeNote } from "../safari.js";

test("a node binary that still exists gets no warning", () => {
  assert.equal(staleNodeNote("/opt/homebrew/Cellar/node/26.11.0/bin/node", () => true), null);
});

test("a deleted node binary gets a one-line warning that says to restart", () => {
  const note = staleNodeNote("/opt/homebrew/Cellar/node/26.9.0/bin/node", () => false);
  assert.match(note, /26\.9\.0\/bin\/node, which no longer exists/);
  assert.match(note, /Restart the server on the current node/);
  assert.doesNotMatch(note, /\n/);
});

test("the running test process's own node exists, so the default check is quiet", () => {
  assert.equal(staleNodeNote(), null);
});
