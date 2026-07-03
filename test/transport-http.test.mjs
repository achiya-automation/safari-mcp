#!/usr/bin/env node
/**
 * Integration tests for HTTP transport mode (SAFARI_MCP_HTTP=1) — the shared single-instance path
 * that lets many Claude Code sessions reuse ONE safari-mcp process. Uses a real MCP client over
 * StreamableHTTP against a stub server, so it proves the wiring Claude Code itself will use.
 * See docs/http-transport-design.md.
 *
 * Run:  node --test test/transport-http.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTransport } from "../transport.js";

function makeStubServer() {
  const server = new McpServer({ name: "safari-mcp-test", version: "0.0.0" });
  server.tool("ping", "returns pong", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
  return server;
}

async function connectClient(port) {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

test("http mode: an MCP client lists and calls tools over the shared instance", async () => {
  const handle = await startTransport(makeStubServer, { SAFARI_MCP_HTTP: "1", SAFARI_MCP_HTTP_PORT: "9319" });
  try {
    const client = await connectClient(9319);
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === "ping"), "ping tool should be listed");
    const res = await client.callTool({ name: "ping", arguments: {} });
    assert.equal(res.content[0].text, "pong");
    await client.close();
  } finally {
    await handle.close();
  }
});

test("http mode: two concurrent clients share one instance", async () => {
  const handle = await startTransport(makeStubServer, { SAFARI_MCP_HTTP: "1", SAFARI_MCP_HTTP_PORT: "9320" });
  try {
    const [a, b] = await Promise.all([connectClient(9320), connectClient(9320)]);
    const [ra, rb] = await Promise.all([
      a.callTool({ name: "ping", arguments: {} }),
      b.callTool({ name: "ping", arguments: {} }),
    ]);
    assert.equal(ra.content[0].text, "pong");
    assert.equal(rb.content[0].text, "pong");
    await a.close();
    await b.close();
  } finally {
    await handle.close();
  }
});

test("http mode: an unknown session id returns 404 (client re-inits) — not 400 (client wedges)", async () => {
  const handle = await startTransport(makeStubServer, { SAFARI_MCP_HTTP: "1", SAFARI_MCP_HTTP_PORT: "9321" });
  try {
    // A request carrying a session id the server never issued (expired, evicted, or the daemon
    // restarted under it). The MCP StreamableHTTP spec requires 404 so the client transparently
    // starts a fresh session. Regression guard: this used to return 400, which wedged every shared
    // Claude Code session permanently on "No valid session" the moment its session dropped.
    const unknown = await fetch("http://127.0.0.1:9321/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "does-not-exist",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(unknown.status, 404, "unknown session id must be 404 so the client re-initializes");

    // No session id AND not an initialize is a genuinely malformed first request → still 400.
    const noSession = await fetch("http://127.0.0.1:9321/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(noSession.status, 400, "no session id + non-initialize stays 400");
  } finally {
    await handle.close();
  }
});
