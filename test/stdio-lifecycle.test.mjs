import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test("stdio server exits when the client closes stdin", { timeout: 15_000 }, async () => {
  const child = spawn(process.execPath, ["index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, SAFARI_MCP_QUIET: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  try {
    const response = once(child.stdout, "data");
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-lifecycle-test", version: "1.0.0" },
        },
      })}\n`
    );

    await withTimeout(response, 10_000, `server did not initialize\n${stderr.join("")}`);
    child.stdin.end();

    const [code, signal] = await withTimeout(
      exit,
      5_000,
      `server remained alive after stdin closed\n${stderr.join("")}`
    );
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await withTimeout(exit, 5_000, "server did not stop during test cleanup").catch(() => {
        child.kill("SIGKILL");
      });
    }
  }
});
