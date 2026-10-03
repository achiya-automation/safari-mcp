#!/usr/bin/env node
/**
 * safari_upload_file and safari_paste_image in a named profile with several windows
 * (Google Business Profile, 2.10.26).
 *
 * 1. Neither tool took a receipt, so a caller whose MCP session was re-initialised could not name
 *    its tab, as every other tool that bypasses extensionOrFallback can (safari_select_option).
 * 2. Their AppleScript looked for the session's tab only in the profile's first window, while the
 *    extension had opened it in another: "Tab tracking lost during runJSLarge", even right after
 *    safari_new_tab. They now ask the extension which window holds the tab (_locusWindows), only
 *    once the first window missed; the marker still proves the tab (extension-tab-proof.test.mjs).
 * 3. verifyPreview counted img/video/background-image previews only. GBP draws its preview as
 *    <svg role=img><image href="blob:…">, so a real upload read as a ghost pickup and was escalated
 *    to a native dialog that added a second copy.
 *
 * Run:  node --test test/upload-file-receipt.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");

function toolBlock(name) {
  const at = index.indexOf(`server.tool(\n  "${name}",`);
  assert.ok(at >= 0, `no ${name} tool`);
  return index.slice(at, index.indexOf("\n);\n", at));
}

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

for (const [tool, op] of [["safari_upload_file", "upload_file"], ["safari_paste_image", "paste_image"]]) {
  test(`${tool} takes a receipt, shows it to the ownership guard, and lets AppleScript ask the extension for the tab's window`, () => {
    const block = toolBlock(tool);
    assert.match(block, /receipt: z\.string\(\)\.optional\(\)/, "no receipt in the schema");
    const guard = block.indexOf(`_assertTabOwnership("${op}", _explicitReceipt(`);
    assert.ok(guard >= 0, "the guard does not see the receipt");
    const call = block.indexOf("locate: _tabLocusFromExtension");
    assert.ok(call > guard, "the engine call does not get the extension's locus, or runs before the guard");
  });
}

// ---------- _locusWindows ----------

function locusWindows(pin) {
  return new Function("_pinWindowFromLocus", `${between(safariSource, "function _locusWindows(", "\n// Like _withTargetTabFronted")}\nreturn _locusWindows;`)(pin);
}

test("the extension is asked once, and its locus becomes the window to scan", async () => {
  let asked = 0, pinned = 0;
  const locusOf = locusWindows(async (locus) => { pinned++; return { winRef: `window id ${locus.w}`, winId: locus.w, tabIndex: 2 }; });
  const elsewhere = locusOf(async () => { asked++; return { w: 7, index: 2 }; });
  assert.deepEqual(await elsewhere(), ["window id 7"]);
  assert.deepEqual(await elsewhere(), ["window id 7"]);
  assert.deepEqual([asked, pinned], [1, 1]);
});

test("no locus, no matching window, or a failing extension leave the scan as it was", async () => {
  const locusOf = locusWindows(async () => null);
  assert.equal(locusOf(null), null);
  assert.deepEqual(await locusOf(async () => null)(), []);
  assert.deepEqual(await locusOf(async () => ({ index: 1 }))(), []);
  assert.deepEqual(await locusOf(async () => { throw new Error("Extension timeout"); })(), []);
});

// ---------- the preview count ----------

const PREVIEW_COUNT_JS = (() => {
  const m = /const _PREVIEW_COUNT_JS = `([\s\S]*?)`;/.exec(safariSource);
  assert.ok(m, "no _PREVIEW_COUNT_JS");
  return m[1];
})();

// A page with the given <img>/<video> sources, inline background images and SVG <image> hrefs.
function page({ imgs = [], backgrounds = [], svgHrefs = [] } = {}) {
  const XLINK = "http://www.w3.org/1999/xlink";
  const document = {
    querySelectorAll(sel) {
      if (sel.startsWith("img[")) return imgs.filter((s) => /^(blob:|data:image)/.test(s));
      if (sel === "div,span,a,figure") return backgrounds.map((b) => ({ style: { backgroundImage: b } }));
      if (sel === "image") {
        return svgHrefs.map(({ href = null, xlink = null }) => ({
          getAttribute: (name) => (name === "href" ? href : null),
          getAttributeNS: (ns, name) => (ns === XLINK && name === "href" ? xlink : null),
        }));
      }
      throw new Error(`unexpected selector ${sel}`);
    },
  };
  return vm.runInNewContext(`(${PREVIEW_COUNT_JS})()`, { document });
}

test("an SVG <image> preview counts, by href or xlink:href, as GBP draws it", () => {
  assert.equal(page(), 0);
  assert.equal(page({ svgHrefs: [{ href: "blob:https://business.google.com/1f2e" }] }), 1);
  assert.equal(page({ svgHrefs: [{ xlink: "blob:https://business.google.com/1f2e" }] }), 1);
  assert.equal(page({ svgHrefs: [{ href: "data:image/png;base64,AAAA" }] }), 1);
  assert.equal(page({ svgHrefs: [{ href: "https://lh3.googleusercontent.com/logo.png" }] }), 0, "an icon is not a preview");
  assert.equal(page({ imgs: ["blob:x"], backgrounds: ["url(blob:y)"], svgHrefs: [{ href: "blob:z" }] }), 3);
});

test("the upload script and the Node-side recount share one counter", () => {
  const upload = between(safariSource, "export async function uploadFile(", "\n// ========== NATIVE FILE UPLOAD");
  assert.match(upload, /var __mcpPreviewCount = \$\{_PREVIEW_COUNT_JS\};/);
  assert.match(upload, /runJS\(`\(\$\{_PREVIEW_COUNT_JS\}\)\(\)`, \{ elsewhere \}\)/);
  // The upload script is flattened onto one line: a // comment inside it would swallow the rest.
  assert.doesNotMatch(PREVIEW_COUNT_JS, /(^|[^:])\/\//);
});
