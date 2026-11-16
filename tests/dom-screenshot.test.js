import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// safari_screenshot on a locked Mac injects this browser build into the tab
// (safari.js domScreenshot). The package exports only module entries, so the file is
// found beside them; a version bump that moves it would break locked screenshots.
test("the html2canvas-pro browser build used for locked-screen screenshots is installed", () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(join(dirname(require.resolve("html2canvas-pro")), "html2canvas-pro.min.js"), "utf8");
  assert.match(source, /\.html2canvas=/);
  assert.ok(source.length > 100_000);
});
