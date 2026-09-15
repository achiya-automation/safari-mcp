#!/usr/bin/env node
/**
 * safari_emulate device presets and the in-page navigator override.
 *
 * The presets were iPhone 14 / iOS 17 strings, an unknown name silently became a bare
 * 375×812 window, and the UA override was applied right before a reload that threw it away.
 * The values below were captured from Mobile Safari on the iOS/iPadOS 27.0 simulator.
 *
 * Run:  node --test test/emulate-devices.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import {
  EMULATION_DEVICES,
  resolveEmulation,
  buildNavigatorOverrideJS,
  RESET_NAVIGATOR_JS,
} from "../safari.js";

const IOS_27 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
const IPADOS_27 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";

test("iPhone presets carry what iOS 27 Safari actually sends", () => {
  const iphones = Object.keys(EMULATION_DEVICES).filter((k) => k.startsWith("iphone-"));
  assert.ok(iphones.includes("iphone-18-pro") && iphones.includes("iphone-air"));
  for (const name of iphones) {
    const d = resolveEmulation({ device: name });
    assert.equal(d.ua, IOS_27, name);
    assert.equal(d.platform, "iPhone", name);
    assert.equal(d.touchPoints, 5, name);
  }
  assert.deepEqual([EMULATION_DEVICES["iphone-18-pro"].width, EMULATION_DEVICES["iphone-18-pro"].height], [402, 874]);
  assert.deepEqual([EMULATION_DEVICES["iphone-18-pro-max"].width, EMULATION_DEVICES["iphone-18-pro-max"].height], [440, 956]);
});

test("iPad presets send the desktop UA and are told apart only by touch points", () => {
  for (const name of Object.keys(EMULATION_DEVICES).filter((k) => k.startsWith("ipad"))) {
    const d = resolveEmulation({ device: name });
    assert.equal(d.ua, IPADOS_27, name);
    assert.equal(d.platform, undefined, `${name} must keep the real MacIntel platform`);
    assert.equal(d.touchPoints, 5, name);
  }
});

test("pre-iOS 27 names keep resolving", () => {
  for (const name of ["iphone-14", "iphone-14-pro-max", "ipad", "ipad-pro", "pixel-7", "galaxy-s24"]) {
    assert.equal(resolveEmulation({ device: name }).name, name);
  }
  assert.equal(resolveEmulation({ device: " iPhone-18-Pro " }).name, "iphone-18-pro");
});

test("an unknown device is refused with the list instead of a silent 375×812", () => {
  for (const bad of ["iphone-99", "constructor", "__proto__", "toString"]) {
    assert.throws(() => resolveEmulation({ device: bad }), /Unknown device[\s\S]*iphone-18-pro/, bad);
  }
});

test("custom sizes fall back to 375×812 only when missing or invalid", () => {
  assert.deepEqual(resolveEmulation({}), { name: "custom", width: 375, height: 812, ua: "" });
  const c = resolveEmulation({ width: "500.4", height: 900, userAgent: "UA" });
  assert.deepEqual([c.width, c.height, c.ua], [500, 900, "UA"]);
  assert.equal(resolveEmulation({ width: -5, height: "x" }).width, 375);
});

function fakeNavigator() {
  const proto = {};
  for (const [k, v] of Object.entries({ userAgent: IPADOS_27, platform: "MacIntel", maxTouchPoints: 0 })) {
    Object.defineProperty(proto, k, { get: () => v, configurable: true });
  }
  return Object.create(proto);
}

test("the override survives hostile quotes and is removed by reset — and only it", () => {
  const navigator = fakeNavigator();
  const hostile = `it's a \\"UA\\"   line`;
  const js = buildNavigatorOverrideJS({ ua: hostile, platform: "iPhone", touchPoints: 5 });
  assert.equal(vm.runInNewContext(js, { navigator }), hostile);
  assert.equal(navigator.platform, "iPhone");
  assert.equal(navigator.maxTouchPoints, 5);

  // A getter the page defined itself is not ours to remove.
  Object.defineProperty(navigator, "platform", { get: () => "PageOwned", configurable: true });
  assert.equal(vm.runInNewContext(RESET_NAVIGATOR_JS, { navigator }), IPADOS_27);
  assert.equal(navigator.maxTouchPoints, 0);
  assert.equal(navigator.platform, "PageOwned");
});

test("a size-only emulation injects nothing", () => {
  assert.equal(buildNavigatorOverrideJS({ ua: "" }), "");
});
