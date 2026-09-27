import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const code = index.slice(index.indexOf("function _chipTemp()"), index.indexOf("function sendToExtension("));
const dir = mkdtempSync(join(tmpdir(), "thermal-gate-"));

function gate(file, { max = 80, waitMs = 1500 } = {}) {
  const ctx = {
    readFileSync, Date, setTimeout, console: { error() {} },
    _THERMAL_FILE: file, _THERMAL_MAX: max, _THERMAL_WAIT_MS: waitMs, _THERMAL_FREE: new Set(["close_tab", "list_tabs"]),
  };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nthis.gate = _thermalGate;`, ctx);
  return ctx.gate;
}

function reading(name, temp, ageSeconds = 0) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ _t: temp, _ts: Date.now() / 1000 - ageSeconds }));
  return file;
}

async function elapsed(fn) {
  const t0 = Date.now();
  await fn();
  return Date.now() - t0;
}

test("a hot chip holds page work up to the wait budget", async () => {
  assert.ok(await elapsed(() => gate(reading("hot", 90))("evaluate")) >= 1400);
});

test("closing or listing tabs never waits, even on a hot chip", async () => {
  const hot = gate(reading("hot2", 95));
  assert.ok(await elapsed(() => hot("close_tab")) < 200);
  assert.ok(await elapsed(() => hot("list_tabs")) < 200);
});

test("a cool, stale or missing reading holds nothing", async () => {
  assert.ok(await elapsed(() => gate(reading("cool", 70))("navigate")) < 200);
  assert.ok(await elapsed(() => gate(reading("stale", 95, 60))("navigate")) < 200);
  assert.ok(await elapsed(() => gate(join(dir, "missing"))("navigate")) < 200);
  assert.ok(await elapsed(() => gate("")("navigate")) < 200);
});

test("every extension command passes the gate unless it is exempt", () => {
  const send = index.slice(index.indexOf("function sendToExtension("), index.indexOf("function _sendToExtension("));
  assert.match(send, /_thermalGate\(type\)\.then\(\(\) => _sendToExtension\(type, payload, timeoutMs\)\)/);
});
