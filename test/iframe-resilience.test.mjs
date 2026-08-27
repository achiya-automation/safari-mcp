#!/usr/bin/env node
/**
 * Regression coverage for cross-origin iframe reads/actions and extension reloads.
 *
 * PartnerStack renders its application modal in a child frame.  The old snapshot and
 * get_element paths inspected only the top document, then index.js mislabeled the
 * resulting `Element not found` as an extension disconnect.  The all-frame helpers
 * were also unbounded, so one heavy child frame could consume the whole command
 * deadline.  These source-contract tests keep those paths aligned with the shipped
 * WebExtension implementation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function commandCase(name, nextName) {
  const start = background.indexOf(`case "${name}":`);
  const end = background.indexOf(`case "${nextName}":`, start);
  assert.ok(start >= 0 && end > start, `${name} command case should exist`);
  return background.slice(start, end);
}

test("snapshot emits unique, actionable refs from every frame", () => {
  const source = commandCase("snapshot", "double_click");
  assert.match(source, /execTextAcrossFrames/);
  assert.match(source, /__mcpFrameRefNamespace/);
  assert.match(source, /window !== top/);
  assert.doesNotMatch(source, /return await execInTab\(/);
  const escapeAt = source.indexOf("const esc =");
  const walkAt = source.indexOf("function walk(");
  assert.ok(escapeAt >= 0 && escapeAt < walkAt, "frame URL escaping must be in the injected function scope, not nested inside walk()");
  assert.match(source, /frameUrl\.origin \+ frameUrl\.pathname/);
  assert.doesNotMatch(source, /location\.href\.substring/);
});

test("get_element and wait_for inspect child frames", () => {
  const getElement = commandCase("get_element", "query_all");
  assert.match(getElement, /execInAllFrames/);

  const waitFor = commandCase("wait_for", "hover");
  assert.match(waitFor, /execInAllFrames/);
  assert.match(waitFor, /while \(Date\.now\(\) < deadline\)/);
});

test("a snapshot ref can be clicked inside a child frame", () => {
  const click = commandCase("click", "click_and_read");
  const iframeFallback = click.slice(click.indexOf("Fallback: if element not found in main frame"));
  assert.match(iframeFallback, /execInFirstMatchingFrameMutating/);
  assert.match(iframeFallback, /\(selector, text, ref\)/);
  assert.match(iframeFallback, /data-mcp-ref/);
  assert.match(iframeFallback, /payload\.selector, payload\.text, payload\.ref/);
  assert.ok((iframeFallback.match(/host\.shadowRoot/g) || []).length >= 2, "both iframe click probe and dispatch must traverse open shadow roots");
  assert.match(iframeFallback, /if \(value &&/);
  assert.match(iframeFallback, /if \(t &&/);
});

test("mutating iframe fallbacks target one proven frame and never auto-retry", () => {
  for (const [name, nextName] of [["click", "click_and_read"], ["fill", "type_text"], ["type_text", "press_key"]]) {
    assert.match(commandCase(name, nextName), /execInFirstMatchingFrameMutating/);
  }

  const start = background.indexOf("async function execInFirstMatchingFrameMutating(");
  const end = background.indexOf("function _isFrameMiss(", start);
  assert.ok(start >= 0 && end > start, "single-frame mutating executor should exist");
  const source = background.slice(start, end);
  assert.match(source, /_executeAllFrames\(matchFunc/);
  assert.match(source, /frameIds: \[match\.frameId\]/);
  assert.match(source, /world: "ISOLATED"/);
  assert.match(source, /refusing automatic retry/);
  assert.equal(
    (source.match(/browser\.scripting\.executeScript/g) || []).length,
    1,
    "the mutating dispatch must occur exactly once"
  );
});

test("type_text does not type into a top-frame field when an iframe ref is missing there", () => {
  const source = commandCase("type_text", "press_key");
  assert.match(source, /if \(!el\) return "Element not found: " \+ selector/);
  assert.match(source, /result\.startsWith\("Element not found"\)/);
  assert.match(source, /return !!deepQuery\(selector\)/);
  assert.match(source, /selector \? deepQuery\(selector\) : document\.activeElement/);
  assert.ok((source.match(/host\.shadowRoot/g) || []).length >= 2, "type_text probe and dispatch must traverse open shadow roots");
});

test("all-frame injection has a deadline and MAIN-to-ISOLATED fallback", () => {
  const start = background.indexOf("async function _executeAllFrames(");
  const end = background.indexOf("async function waitForTabLoad(", start);
  assert.ok(start >= 0 && end > start, "shared all-frame executor should exist");
  const source = background.slice(start, end);
  assert.match(source, /_withInjectionDeadline/);
  assert.match(source, /execute\("MAIN"\)/);
  assert.match(source, /execute\("ISOLATED"\)/);

  for (const helper of ["execInAllFrames", "execAcrossFrames", "execTextAcrossFrames"]) {
    assert.match(source, new RegExp(`async function ${helper}\\(`));
    assert.match(source, new RegExp(`${helper}[\\s\\S]*_executeAllFrames`));
  }
});

test("background page text falls back when WebKit innerText is empty", () => {
  const readPage = commandCase("read_page", "get_source");
  assert.match(readPage, /document\.body\?\.innerText \|\| document\.body\?\.textContent \|\| ""/);
  assert.match(readPage, /frameResult !== null && frameResult !== undefined/);
});

test("fill can use a snapshot ref inside an iframe shadow root", () => {
  const fill = commandCase("fill", "type_text");
  assert.match(fill, /localDeepQuery/);
  assert.ok((fill.match(/host\.shadowRoot/g) || []).length >= 2, "fill probe and dispatch must traverse open shadow roots");
});

test("a semantic element miss is not reported as an unavailable profile extension", () => {
  const routing = index.slice(
    index.indexOf("async function extensionOrFallback("),
    index.indexOf("// Read version from package.json")
  );
  assert.match(routing, /const isElementMiss/);
  assert.match(routing, /_preferAppleScript && isElementMiss/);
  assert.match(routing, /semantic miss/);
  assert.match(routing, /usedExtension = true/);
});

test("reload waits for a newer verified extension generation", () => {
  assert.match(index, /let _extensionConnectionGeneration = 0/);
  assert.match(index, /async function _waitForExtensionGeneration\(/);
  const connectRoute = index.slice(
    index.indexOf('req.method === "POST" && req.url.startsWith("/connect")'),
    index.indexOf('req.method === "POST" && req.url === "/heartbeat"')
  );
  assert.match(connectRoute, /if \(!process\.env\.SAFARI_PROFILE\) \{[\s\S]*_extensionConnectionGeneration \+= 1/);

  const proxy = index.slice(
    index.indexOf('if (req.method === "POST" && req.url === "/proxy-command")'),
    index.indexOf("res.writeHead(404)")
  );
  assert.match(proxy, /type === "reload_extension"/);
  assert.match(proxy, /_waitForExtensionGeneration/);
  assert.ok(
    proxy.indexOf("await sendToExtension(type, payload, timeout)") < proxy.indexOf("const reloadGeneration = _extensionConnectionGeneration"),
    "proxy reload baseline must be captured after the old worker replies"
  );

  const tool = index.slice(
    index.indexOf('"safari_reload_extension"'),
    index.indexOf('"safari_new_tab"')
  );
  assert.match(tool, /_waitForExtensionGeneration/);
  assert.ok(
    tool.indexOf("await extensionOrFallback(") < tool.indexOf("const reloadGeneration = _extensionConnectionGeneration"),
    "direct reload baseline must be captured after the old worker replies"
  );
});
