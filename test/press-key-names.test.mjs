#!/usr/bin/env node
/**
 * safari_press_key documents short names ("down", "enter"). The extension dispatches `key`
 * as given and pages compare it to the DOM value, so the server has to translate them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { domKeyName } from "../safari.js";

test("documented short names become DOM key values", () => {
  for (const [name, value] of [
    ["enter", "Enter"], ["tab", "Tab"], ["escape", "Escape"], ["space", " "], ["delete", "Backspace"],
    ["up", "ArrowUp"], ["down", "ArrowDown"], ["left", "ArrowLeft"], ["right", "ArrowRight"], ["DOWN", "ArrowDown"],
  ]) assert.equal(domKeyName(name), value);
});

test("DOM values and single characters pass through unchanged", () => {
  for (const key of ["ArrowDown", "Enter", "a", "A", "1", "/", " "]) assert.equal(domKeyName(key), key);
});

test("every path to the extension's press_key translates the name", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const sends = source.match(/"press_key", \{ key: [^,]+,/g);
  assert.equal(sends.length, 2);
  for (const send of sends) assert.match(send, /key: safari\.domKeyName\(args\.key\),/);
});
