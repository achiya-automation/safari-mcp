import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { jpegSize } from "../image-size.js";

// SOI, an APP0 segment, then SOF0 declaring 1718×3024 (a Retina Safari capture).
const jpeg = Buffer.from([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x06, 0xb6, 0x0b, 0xd0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);

test("jpegSize reads width/height from the SOF marker", () => {
  assert.deepEqual(jpegSize(jpeg), { width: 3024, height: 1718 });
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
});

test("safari_screenshot routes its image through the downscaler", () => {
  const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const tool = src.slice(src.indexOf('"safari_screenshot",'), src.indexOf('"safari_screenshot_element",'));
  assert.match(tool, /maxWidth/);
  assert.match(tool, /_downscaleJpeg\(base64, /);
});
