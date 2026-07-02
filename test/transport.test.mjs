#!/usr/bin/env node
/**
 * Unit tests for planTransport() — the opt-in transport selection that lets many Claude Code
 * sessions share ONE safari-mcp HTTP instance instead of spawning one stdio node process each.
 * See docs/http-transport-design.md. stdio stays the default → zero behaviour change when off.
 *
 * Run:  node --test test/transport.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { planTransport } from "../transport.js";

test("defaults to stdio when SAFARI_MCP_HTTP is unset", () => {
  assert.deepEqual(planTransport({}), { kind: "stdio" });
});

test("selects http on 127.0.0.1:9225 when SAFARI_MCP_HTTP is set", () => {
  assert.deepEqual(planTransport({ SAFARI_MCP_HTTP: "1" }), {
    kind: "http",
    host: "127.0.0.1",
    port: 9225,
  });
});

test("honors a custom SAFARI_MCP_HTTP_PORT", () => {
  assert.equal(planTransport({ SAFARI_MCP_HTTP: "1", SAFARI_MCP_HTTP_PORT: "9300" }).port, 9300);
});

test("treats SAFARI_MCP_HTTP='0' / '' as off (stdio)", () => {
  assert.equal(planTransport({ SAFARI_MCP_HTTP: "0" }).kind, "stdio");
  assert.equal(planTransport({ SAFARI_MCP_HTTP: "" }).kind, "stdio");
});
