import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function listRegisteredTools() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      SAFARI_MCP_QUIET: "1",
    },
    stderr: "pipe",
  });
  const stderr = [];
  transport.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));

  const client = new Client({ name: "safari-mcp-smoke-test", version: "0.0.0" });

  try {
    await client.connect(transport, { timeout: 10_000 });
    return await client.listTools(undefined, { timeout: 10_000 });
  } catch (error) {
    const logs = stderr.join("").trim();
    error.message = logs ? `${error.message}\nServer stderr:\n${logs}` : error.message;
    throw error;
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

async function getExpectedToolCount() {
  const source = await readFile("index.js", "utf8");
  return source.match(/server\.tool\(/g)?.length ?? 0;
}

test("server starts and lists all registered tools", async () => {
  const expectedToolCount = await getExpectedToolCount();
  const { tools } = await listRegisteredTools();

  assert.ok(expectedToolCount >= 80, "index.js should define at least 80 tools");
  assert.equal(tools.length, expectedToolCount);
});

test("registered tools have valid schemas and unique names", async () => {
  const { tools } = await listRegisteredTools();
  const names = new Set();

  for (const tool of tools) {
    assert.equal(typeof tool.name, "string");
    assert.match(tool.name, /^safari_[a-z0-9_]+$/);
    assert.ok(!names.has(tool.name), `duplicate tool name: ${tool.name}`);
    names.add(tool.name);

    assert.equal(typeof tool.description, "string", `${tool.name} missing description`);
    assert.ok(tool.description.trim().length > 0, `${tool.name} has empty description`);

    assert.equal(typeof tool.inputSchema, "object", `${tool.name} missing inputSchema`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} inputSchema must be object`);
    assert.equal(
      typeof tool.inputSchema.properties,
      "object",
      `${tool.name} inputSchema missing properties`
    );
  }
});
