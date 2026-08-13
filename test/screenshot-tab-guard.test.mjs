#!/usr/bin/env node
/**
 * Window screenshots only capture Safari's selected tab. Both screenshot tools must
 * temporarily select the MCP-owned tab and restore the user's selection afterwards.
 * Regression test for the background-tab capture bug found on 2026-08-13.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync(new URL("../safari.js", import.meta.url), "utf8");

function exportedFunctionBody(name, nextName) {
  const start = src.indexOf(`export async function ${name}(`);
  const end = src.indexOf(`export async function ${nextName}(`, start + 1);
  assert.ok(start >= 0, `${name} export should exist`);
  assert.ok(end > start, `${nextName} should follow ${name}`);
  return src.slice(start, end);
}

test("viewport and full-page screenshots front the MCP-owned tab", () => {
  const body = exportedFunctionBody("screenshot", "screenshotElement");
  assert.match(
    body,
    /return\s+(?:await\s+)?_withTargetTabFronted\s*\(/,
    "screenshot must capture inside the select-and-restore guard"
  );
  assert.doesNotMatch(
    body,
    /skipScreencapture|isBackgroundTab/,
    "background tabs must be selected temporarily, not sent to the broken async canvas fallback"
  );
});

test("element screenshots front the MCP-owned tab before window capture and crop", () => {
  const body = exportedFunctionBody("screenshotElement", "scroll");
  assert.match(
    body,
    /return\s+(?:await\s+)?_withTargetTabFronted\s*\(/,
    "screenshotElement must crop a capture of the owned tab, never the user's selected tab"
  );
});
