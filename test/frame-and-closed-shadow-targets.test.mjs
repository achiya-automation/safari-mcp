#!/usr/bin/env node
/**
 * Regression coverage for targets the persistent click bridge cannot see.
 *
 * A live audit on macOS 27 / Safari 27 (2026-09-15): `safari_snapshot` listed a button
 * inside a closed shadow root and one inside a same-origin iframe, yet `safari_click`
 * answered "Element not found" for both, by ref and by text. Two faults stacked:
 *
 *   1. The bridge (command-content.js) lives in the ISOLATED world of the top frame. It
 *      cannot see child documents, and a closed shadow root is reachable only from MAIN,
 *      through the getter content.js installs — so its miss has to fall through to the
 *      all-frame fallback, and that fallback has to look inside closed roots.
 *   2. The fallback never received its arguments. Safari's scripting.executeScript drops
 *      `undefined` entries from `args` and shifts the rest left, so a ref-only probe
 *      `(selector, text, ref)` got the ref as its selector. `safari_wait_for` by text was
 *      broken the same way.
 *
 * Checking the sibling tools turned up two more: `safari_type_text` resolved an iframe
 * field from the top frame and then typed with the TOP document's execCommand — into
 * whichever top-frame field last had focus — and `mcpFindRef` (the AppleScript-engine
 * finder behind `safari_select_option` refs) skipped closed roots and fell back to
 * coordinates, returning the shadow host.
 *
 * Live, the bridge can also be gone entirely (it is, in every tab that was open during an
 * extension update). sendContentCommand then scheduled a top-document-only action and
 * answered "Scheduled" before knowing whether it would find anything, so closed-root and
 * iframe clicks and fills did nothing while reporting success — the fallback never ran.
 *
 * The harness runs the real command cases from extension/background.js against jsdom,
 * with an executeScript fake that behaves like Safari: one run per frame, `undefined`
 * args dropped, and an ISOLATED world that cannot see the page's `__mcp*` globals.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const BACKGROUND = read("../extension/background.js");
const COMMAND_CONTENT = read("../extension/command-content.js");
const CONTENT = read("../extension/content.js");
const HELPERS = read("../mcp-helpers.js");

/** Top-level function source, or "" — a helper the cases still call fails loudly when missing. */
function fnSource(name) {
  const start = BACKGROUND.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  return start < 0 ? "" : BACKGROUND.slice(start, BACKGROUND.indexOf("\n}\n", start) + 2);
}

function commandCase(name, nextName) {
  const start = BACKGROUND.indexOf(`case "${name}":`);
  const end = BACKGROUND.indexOf(`case "${nextName}":`, start);
  assert.ok(start >= 0 && end > start, `${name} command case should exist`);
  return BACKGROUND.slice(start, end);
}

function stubLayout(win) {
  win.PointerEvent = win.PointerEvent || win.MouseEvent;
  win.document.elementFromPoint = () => null; // jsdom has no hit testing; callers fall back to the target itself
  win.Element.prototype.scrollIntoView = function () {};
  win.Element.prototype.getBoundingClientRect = function () {
    return { left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40, x: 10, y: 20 };
  };
}

function harness({ bridge = "live" } = {}) {
  const dom = new JSDOM(
    '<body><button data-mcp-ref="2_2">Top button</button><closed-host></closed-host><iframe></iframe></body>',
    { url: "http://127.0.0.1:8765/", pretendToBeVisual: true, runScripts: "outside-only" }
  );
  const top = dom.window;
  const frame = /** @type {any} */ (top.document.querySelector("iframe")).contentWindow;
  const hits = [];
  const typed = [];
  for (const { label, win } of [{ label: "top", win: top }, { label: "frame", win: frame }]) {
    stubLayout(win);
    win.document.execCommand = (command, _ui, value) => {
      typed.push({ document: label, command, value });
      return true;
    };
  }

  // MAIN world at document_start: content.js captures closed roots before the page makes one.
  top.eval(CONTENT);
  top.eval(`customElements.define("closed-host", class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "closed" }).innerHTML =
        '<button data-mcp-ref="2_5">Shadow button</button><select data-mcp-ref="2_7"><option>A</option></select>';
    }
  });`);
  top.__mcpGetShadowRoot(top.document.querySelector("closed-host"))
    .querySelector("button").addEventListener("click", () => hits.push("closed"));
  top.document.querySelector('[data-mcp-ref="2_2"]').addEventListener("click", () => hits.push("top"));
  frame.document.body.innerHTML =
    '<button data-mcp-ref="2_ns_1">Inner frame button</button><input data-mcp-ref="2_ns_2">';
  frame.document.querySelector("button").addEventListener("click", () => hits.push("frame"));

  // ISOLATED world of the top frame: the persistent bridge.
  top.browser = {
    runtime: {
      connect: () => ({ postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} } }),
      onMessage: { addListener() {}, removeListener() {} },
    },
    storage: {
      local: { get: async () => ({ mcpEnabled: false }), set: async () => {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  top.eval(COMMAND_CONTENT);

  const frames = [{ frameId: 0, win: top }, { frameId: 7, win: frame }];
  const injections = [];
  const browser = {
    tabs: {
      // "dead": the listener is gone, as in every tab that was open during an extension
      // update — Safari then rejects at once and sendContentCommand takes its recovery path.
      sendMessage: async (_tabId, message) => new Promise((resolve, reject) => {
        if (bridge === "dead") return reject(new Error("Could not establish connection. Receiving end does not exist."));
        if (!top.__mcpContentCommandState.listener(message, {}, resolve)) resolve(undefined);
      }),
      update: async () => {},
      get: async (id) => ({ id, status: "complete", url: "http://127.0.0.1:8765/" }),
    },
    scripting: {
      async executeScript({ target, world, func, args = [] }) {
        injections.push({ world, frameIds: target.frameIds || null, allFrames: !!target.allFrames });
        const safariArgs = args.filter((value) => value !== undefined);
        const targets = target.allFrames
          ? frames
          : frames.filter(({ frameId }) => (target.frameIds || [0]).includes(frameId));
        return Promise.all(targets.map(async ({ frameId, win }) => {
          const view = world === "ISOLATED"
            ? new Proxy(win, { get: (real, key) => (String(key).startsWith("__mcp") ? undefined : Reflect.get(real, key)) })
            : win;
          try {
            const injected = win.eval(`(function (window) { return (${func.toString()}); })`)(view);
            return { frameId, result: await injected(...safariArgs) };
          } catch (error) {
            return { frameId, error: String(error?.message || error) };
          }
        }));
      },
    },
  };

  const helpers = [
    "_scriptArgs", "_withInjectionDeadline", "sendContentCommand", "execInTab", "execInTabIsolated",
    "_executeAllFrames", "execInFirstMatchingFrameMutating", "_clickFrameAction", "_isFrameMiss",
    "execInAllFrames", "_deepQueryScript",
  ].map(fnSource).join("\n");
  const cases = [
    commandCase("click", "click_open_popup"),
    commandCase("type_text", "press_key"),
    commandCase("wait_for", "hover"),
    commandCase("fill", "type_text"),
  ].join("\n");
  const deps = {
    browser,
    tabId: 1,
    targetTab: { id: 1, url: "http://127.0.0.1:8765/" },
    sessionId: "test",
    MAIN_WORLD_INJECT_MS: 3000,
    _helpersInjected: new Set(),
    waitForTabLoad: async () => {},
    _setSessionTab() {},
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getActiveTab: async () => ({ id: 1 }),
  };
  const handle = new Function(
    ...Object.keys(deps),
    `${helpers}\nreturn async (type, payload) => { switch (type) { ${cases} } };`
  )(...Object.values(deps));

  return {
    top,
    hits,
    typed,
    injections,
    run: (type, payload) => handle(type, payload),
    close() {
      try { top.__mcpContentCommandState?.cleanup?.(); } catch {}
      try { top.__mcpKeepaliveState?.cleanup?.(); } catch {}
      top.close();
    },
  };
}

async function withHarness(fn, options) {
  const h = harness(options);
  try { await fn(h); } finally { h.close(); }
}

const lastDispatch = (h) => h.injections.filter((call) => call.frameIds).at(-1);

test("a ref click reaches a button inside a closed shadow root, dispatched from MAIN", () => withHarness(async (h) => {
  const result = await h.run("click", { ref: "2_5" });
  assert.match(result, /^Clicked: BUTTON "Shadow button"/);
  assert.deepEqual(h.hits, ["closed"], "exactly one click on the closed-root button");
  assert.deepEqual(lastDispatch(h), { world: "MAIN", frameIds: [0], allFrames: false },
    "only MAIN can reach a closed root; the dispatch must go there once, in the top frame");
}));

test("a text click reaches a button inside a closed shadow root", () => withHarness(async (h) => {
  const result = await h.run("click", { text: "Shadow button" });
  assert.match(result, /^Clicked: BUTTON "Shadow button"/);
  assert.deepEqual(h.hits, ["closed"]);
}));

test("a ref click reaches a button inside a same-origin iframe, dispatched ISOLATED in that frame", () => withHarness(async (h) => {
  const result = await h.run("click", { ref: "2_ns_1" });
  assert.match(result, /^Clicked \(iframe\): BUTTON "Inner frame button"/);
  assert.deepEqual(h.hits, ["frame"]);
  assert.deepEqual(lastDispatch(h), { world: "ISOLATED", frameIds: [7], allFrames: false },
    "a target ISOLATED can reach keeps the ISOLATED dispatch");
}));

test("a text click reaches a button inside a same-origin iframe", () => withHarness(async (h) => {
  const result = await h.run("click", { text: "Inner frame button" });
  assert.match(result, /^Clicked \(iframe\): BUTTON "Inner frame button"/);
  assert.deepEqual(h.hits, ["frame"]);
}));

test("the bridge still owns ordinary clicks: no injected fallback runs", () => withHarness(async (h) => {
  const result = await h.run("click", { ref: "2_2" });
  assert.match(result, /^Clicked: BUTTON "Top button"/);
  assert.deepEqual(h.hits, ["top"]);
  assert.equal(h.injections.length, 0);
}));

test("type_text into an iframe field types inside that frame, never through the top document", () => withHarness(async (h) => {
  const result = await h.run("type_text", { text: "hello", selector: '[data-mcp-ref="2_ns_2"]' });
  assert.match(result, /iframe/);
  assert.deepEqual(h.typed, [{ document: "frame", command: "insertText", value: "hello" }]);
}));

test("wait_for by text alone receives its text argument", () => withHarness(async (h) => {
  assert.equal(await h.run("wait_for", { text: "Top button", timeout: 400 }), "Found text: Top button");
}));

test("mcpFindRef resolves a ref inside a closed shadow root instead of its host", () => withHarness(async (h) => {
  h.top.eval(HELPERS);
  assert.equal(h.top.mcpFindRef("2_7")?.tagName, "SELECT");
}));

test("with the bridge gone, a closed-root or iframe click reaches the fallback instead of being scheduled into nothing", () => withHarness(async (h) => {
  assert.match(await h.run("click", { ref: "2_5" }), /^Clicked: BUTTON "Shadow button"/);
  assert.match(await h.run("click", { text: "Inner frame button" }), /^Clicked \(iframe\): BUTTON "Inner frame button"/);
  assert.deepEqual(h.hits, ["closed", "frame"]);
}, { bridge: "dead" }));

test("with the bridge gone, a top-document click is still scheduled once", () => withHarness(async (h) => {
  assert.equal(await h.run("click", { ref: "2_2" }), "Scheduled mcp-content-click");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.hits, ["top"]);
  assert.equal(h.injections.filter((call) => call.allFrames).length, 0, "a found target must not fall through to the all-frame fallback");
}, { bridge: "dead" }));

test("with the bridge gone, fill reaches a field inside an iframe", () => withHarness(async (h) => {
  const result = await h.run("fill", { selector: '[data-mcp-ref="2_ns_2"]', value: "filled" });
  assert.notEqual(result, "Scheduled mcp-content-fill");
  const frameInput = h.top.document.querySelector("iframe").contentDocument.querySelector("input");
  assert.equal(frameInput.value, "filled");
}, { bridge: "dead" }));
