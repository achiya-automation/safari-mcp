#!/usr/bin/env node
/**
 * `safari_screenshot_element` could never succeed in a profile session. The server routes
 * it to the extension as "screenshot_element" and both read-only command lists name it,
 * but the extension's command switch had no such case, so every call answered "Unknown
 * command: screenshot_element". A profile session refuses the AppleScript fallback by
 * design, so nothing else ran either. Found live on macOS 27 / Safari 27 (2026-09-15); a
 * code gap, not a Safari change.
 *
 * The extension now captures the tab the way "screenshot" does and crops the capture to
 * the element. The behavioural tests run that real code against fake tabs, a fake page and
 * a fake canvas; the routing test stops the next routed command from shipping unhandled.
 *
 * Run:  node --test test/screenshot-element-extension.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { imageResult } from "../response.js";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function sourceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `could not extract ${startNeedle}`);
  return source.slice(start, end);
}

/** A top-level function of background.js, up to its closing brace in column 0. */
const topLevelFunction = (declaration) => sourceBetween(background, declaration, "\n}\n") + "\n}";

const handleCommand = sourceBetween(background, "async function handleCommand(", "\n// ========== HELPERS ==========");

test("every command the server routes to the extension has a handler there", () => {
  const routed = new Set(
    [...index.matchAll(/(?:extensionOrFallback|sendToExtension)\(\s*"([a-z_]+)"/g)].map((m) => m[1])
  );
  const handled = new Set([
    ...[...handleCommand.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]),
    // Worker maintenance is answered before the switch (reload_extension).
    ...[...handleCommand.matchAll(/if \(type === "([a-z_]+)"\) \{/g)].map((m) => m[1]),
  ]);
  assert.ok(routed.has("screenshot") && routed.size > 30, "the scan must see the server's routed commands");
  const unhandled = [...routed].filter((type) => !handled.has(type));
  assert.deepEqual(unhandled, [], `routed to the extension with no handler: ${unhandled.join(", ")}`);
});

test("both screenshot commands select the tab through the same guard", () => {
  for (const type of ["screenshot", "screenshot_element"]) {
    const body = sourceBetween(handleCommand, `case "${type}":`, "\n    case ");
    assert.match(body, /_withTabSelected\(tabId,/, `"${type}" must capture inside the select-and-restore guard`);
  }
});

/**
 * The page behind execInTab: the element "#t" at `rect` in the viewport of its own
 * document — the top one, or a same-origin iframe at `frameOffset` with a 2px border.
 * Before scrollIntoView the element reports a position far below the fold.
 */
function fakePage({ rect, frameOffset = null }) {
  const top = { innerWidth: 1512, frameElement: null };
  const view = frameOffset
    ? { parent: top, frameElement: { getBoundingClientRect: () => frameOffset, clientLeft: 2, clientTop: 2 } }
    : top;
  const page = { window: top, document: { querySelector: () => null }, scrolledWith: null };
  const element = {
    ownerDocument: { defaultView: view },
    scrollIntoView(options) { page.scrolledWith = options; },
    getBoundingClientRect: () => (page.scrolledWith ? rect : { ...rect, top: rect.top + 5000 }),
  };
  top.__mcpDeepQuery = (selector) => (selector === "#t" ? element : null);
  return page;
}

const CAPTURE_BYTES = "PNG bytes of the tab capture";

/**
 * Runs the real "screenshot_element" case with its real helpers. Window 3 shows the user's
 * tab 7; the session's tab 42 waits in the background. The capture decodes to 3024×1718, a
 * 2× Retina shot of a 1512px-wide viewport. Every observable step is recorded in order.
 * `decode` replaces the bitmap decoder; `timers` replaces the decode deadline's clock.
 * @param {string} selector
 * @param {ReturnType<typeof fakePage>} page
 * @param {{ decode?: Function, timers?: { setTimeout: Function, clearTimeout: Function } }} [options]
 */
async function screenshotElement(selector, page, { decode = null, timers = { setTimeout, clearTimeout } } = {}) {
  const events = [];
  const tabs = [
    { id: 7, windowId: 3, active: true },
    { id: 42, windowId: 3, active: false },
  ];
  const browser = {
    tabs: {
      get: async (id) => ({ ...tabs.find((tab) => tab.id === id) }),
      query: async ({ active, windowId }) => tabs.filter((tab) => tab.active === active && tab.windowId === windowId),
      update: async (id, { active }) => {
        events.push(`select ${id}`);
        for (const tab of tabs) tab.active = active && tab.id === id;
      },
      captureVisibleTab: async (windowId, { format }) => {
        events.push(`capture window ${windowId} as ${format} showing tab ${tabs.find((tab) => tab.active).id}`);
        return `data:image/png;base64,${Buffer.from(CAPTURE_BYTES).toString("base64")}`;
      },
    },
  };
  const execInTab = async (func, args, tabId) => {
    events.push(`measure in tab ${tabId}`);
    const inPage = new Function("window", "document", "setTimeout", `"use strict"; return (${func});`);
    return inPage(page.window, page.document, (resolve) => resolve())(...args);
  };
  // No Image here on purpose: an <img> never finished loading the capture in Safari's
  // extension background page, so the crop must decode the bytes itself.
  const createImageBitmap = decode || (async (blob) => {
    assert.equal(Buffer.from(await blob.arrayBuffer()).toString(), CAPTURE_BYTES, "the crop must decode the capture it was given");
    return { width: 3024, height: 1718 };
  });
  const document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = {
        getContext: () => ({
          drawImage: (_image, ...rect) => events.push(`crop ${rect.join(" ")} into ${canvas.width}x${canvas.height}`),
        }),
        toDataURL: (type) => { events.push(`encode ${type}`); return "data:image/jpeg;base64,/9j/CROPPED"; },
      };
      return canvas;
    },
  };

  const withTabSelected = new Function(
    "browser", "_profileWindowId",
    `"use strict"; return (${topLevelFunction("async function _withTabSelected(")});`
  )(browser, null);
  const withDeadline = new Function(
    "MAIN_WORLD_INJECT_MS", "setTimeout", "clearTimeout",
    `"use strict"; return (${topLevelFunction("function _withInjectionDeadline(")});`
  )(3000, timers.setTimeout, timers.clearTimeout);
  const cropCapture = new Function(
    "createImageBitmap", "document", "_withInjectionDeadline",
    `"use strict"; return (${topLevelFunction("async function _cropCapture(")});`
  )(createImageBitmap, document, withDeadline);
  const caseBody = sourceBetween(handleCommand, 'case "screenshot_element":', "\n    case ");
  const run = new Function(
    "browser", "execInTab", "_withTabSelected", "_cropCapture", "tabId", "payload",
    // The newline keeps a trailing `//` comment in the extracted body from eating the braces.
    `"use strict"; return (async () => { switch ("screenshot_element") { ${caseBody}\n} })();`
  );
  const result = await run(browser, execInTab, withTabSelected, cropCapture, 42, { selector });
  return { result, events };
}

test("the element is cut out of a capture of the session's tab, and the user's tab comes back", async () => {
  const page = fakePage({ rect: { left: 636, top: 369, width: 240, height: 120 } });
  const { result, events } = await screenshotElement("#t", page);

  assert.equal(result, "/9j/CROPPED");
  assert.equal(page.scrolledWith?.block, "center", "the element is scrolled into view before it is measured");
  assert.deepEqual(events, [
    "select 42",
    "measure in tab 42",
    "capture window 3 as png showing tab 42",
    "select 7",
    // CSS box × the capture's own 2× scale
    "crop 1272 738 480 240 0 0 480 240 into 480x240",
    "encode image/jpeg",
  ]);
});

test("a match inside a same-origin iframe is cropped where the frame shows it", async () => {
  const page = fakePage({ rect: { left: 10, top: 20, width: 100, height: 50 }, frameOffset: { left: 300, top: 400 } });
  const { events } = await screenshotElement("#t", page);
  // ((10 + 300 + 2) × 2, (20 + 400 + 2) × 2): frame position plus its border, then scale
  assert.ok(events.includes("crop 624 844 200 100 0 0 200 100 into 200x100"), events.join("\n"));
});

test("the part of an element outside the viewport is left out of the crop", async () => {
  const page = fakePage({ rect: { left: -20, top: 700, width: 200, height: 400 } });
  const { events } = await screenshotElement("#t", page);
  assert.ok(events.includes("crop 0 1400 360 318 0 0 360 318 into 360x318"), events.join("\n"));
});

test("a selector that matches nothing is a miss: nothing is captured", async () => {
  const { result, events } = await screenshotElement("#missing", fakePage({ rect: { left: 0, top: 0, width: 9, height: 9 } }));
  assert.equal(result, "Element not found: #missing");
  assert.deepEqual(events, ["select 42", "measure in tab 42", "select 7"]);
});

test("an element with nothing on screen is reported instead of returned as an empty image", async () => {
  const { result } = await screenshotElement("#t", fakePage({ rect: { left: 700, top: 400, width: 0, height: 0 } }));
  assert.equal(result, "Element has no visible area: #t");
});

test("a capture that never decodes fails the command instead of blocking the worker", async () => {
  // A command that never settles holds the worker's poll loop: every later command times
  // out until the 330s wedge guard. The decode deadline must end it as this command's error.
  const page = fakePage({ rect: { left: 636, top: 369, width: 240, height: 120 } });
  const fireAtOnce = { setTimeout: (fire) => { queueMicrotask(fire); return 0; }, clearTimeout: () => {} };
  await assert.rejects(
    screenshotElement("#t", page, { decode: () => new Promise(() => {}), timers: fireAtOnce }),
    /decoding the tab capture stalled/
  );
});

test("the tool labels image data by its own bytes and raises anything else as an error", () => {
  assert.equal(imageResult("/9j/4AAQSkZJRgABAQ").content[0].mimeType, "image/jpeg");
  assert.equal(imageResult("iVBORw0KGgoAAAANSUhEUg").content[0].mimeType, "image/png");
  // A miss sent as image bytes fails to decode on the client and its reason is lost.
  assert.throws(() => imageResult("Element not found: #missing"), { message: "Element not found: #missing" });
  const tool = sourceBetween(index, '"safari_screenshot_element"', "// ========== SCROLL ==========");
  assert.match(tool, /return imageResult\(/, "the element tool must answer through the checked envelope");
});
