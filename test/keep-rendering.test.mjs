// content.js keeps an owned tab's frames running while Safari withholds them (hidden tab,
// locked screen), and leaves every other tab on the native requestAnimationFrame.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/content.js", import.meta.url), "utf8");
const block = source.slice(source.indexOf("if (!window.__mcpKeepRendering)"));

function hiddenPage() {
  const listeners = [];
  const document = {};
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  const window = {
    requestAnimationFrame: () => 1, // a hidden page never runs the callback
    cancelAnimationFrame: () => {},
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
  };
  window.post = (data) => listeners.forEach((fn) => fn({ source: window, data }));
  vm.runInNewContext(block, { window, document, setTimeout, clearTimeout, performance, Map });
  return { window, document };
}

const tick = () => new Promise((r) => setTimeout(r, 120));

test("a tab nobody claimed keeps the native, frozen frames", async () => {
  const { window, document } = hiddenPage();
  let ran = 0;
  window.requestAnimationFrame(() => ran++);
  await tick();
  assert.equal(ran, 0);
  assert.equal(document.visibilityState, "hidden");
});

test("an owned tab runs pending and new frames and reads as visible", async () => {
  const { window, document } = hiddenPage();
  let ran = 0;
  window.requestAnimationFrame(() => ran++);
  window.post({ __mcp: "keep_rendering_v1" });
  window.requestAnimationFrame(() => ran++);
  const cancelled = window.requestAnimationFrame(() => ran++);
  window.cancelAnimationFrame(cancelled);
  await tick();
  assert.equal(ran, 2);
  assert.equal(document.visibilityState, "visible");
  assert.equal(document.hidden, false);
});
