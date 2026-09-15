#!/usr/bin/env node
/**
 * A server that starts while another process holds the extension bridge port runs as a
 * secondary and proxies through that "primary". It never tried the port again, so when
 * the primary went away the secondary stayed a proxy to nothing: the extension had no
 * bridge to connect to, and every tool failed until someone restarted the daemon.
 *
 * Seen live on 2026-09-15: a test run's short-lived `node index.js` held 9224 for a few
 * seconds exactly while the LaunchAgent daemon restarted. The daemon came up as a
 * secondary, the test process exited, and nothing listened on 9224 any more.
 *
 * Both instances here run on free ports, never the production bridge ports.
 *
 * Run:  node --test test/bridge-port-takeover.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { test } from "node:test";

test("no test starts a server on the production bridge ports", () => {
  // `npm test` in any session could otherwise take 9224 while the LaunchAgent daemon
  // restarts — the start of the incident the takeover test below reproduces.
  for (const dir of ["test", "tests"]) {
    for (const name of readdirSync(new URL(`../${dir}/`, import.meta.url))) {
      if (!/\.m?js$/.test(name)) continue;
      const source = readFileSync(new URL(`../${dir}/${name}`, import.meta.url), "utf8");
      if (!/spawn\([^)]*["']index\.js["']/.test(source)) continue;
      assert.match(source, /SAFARI_MCP_BRIDGE_PORT/, `${dir}/${name} spawns index.js on the default bridge port`);
      assert.match(source, /SAFARI_MCP_BRIDGE_WS_PORT/, `${dir}/${name} spawns index.js on the default WebSocket port`);
    }
  }
});

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  server.close();
  await once(server, "close");
  return port;
}

/** Starts `node index.js` (stdio mode) and collects its stderr. */
function startServer(env) {
  const child = spawn(process.execPath, ["index.js"], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const waitFor = async (pattern, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(output)) {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`no ${pattern} within ${timeoutMs}ms; stderr:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  return { child, waitFor };
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await exited;
}

test("a secondary takes over the bridge port when its primary is gone", { timeout: 45_000 }, async () => {
  const bridgePort = await freePort();
  // Plain stdio instances: no profile, no HTTP transport of their own.
  const { SAFARI_PROFILE: _profile, SAFARI_MCP_HTTP: _http, ...parentEnv } = process.env;
  const env = {
    ...parentEnv,
    SAFARI_MCP_QUIET: "1",
    SAFARI_MCP_BRIDGE_PORT: String(bridgePort),
    SAFARI_MCP_BRIDGE_WS_PORT: String(await freePort()),
  };

  const primary = startServer(env);
  let secondary = null;
  try {
    await primary.waitFor(new RegExp(`listening on port ${bridgePort} \\(extension host\\)`), 15_000);
    secondary = startServer(env);
    await secondary.waitFor(new RegExp(`HTTP port ${bridgePort} in use`), 15_000);

    await stop(primary);

    await secondary.waitFor(new RegExp(`listening on port ${bridgePort} \\(extension host\\)`), 25_000);
  } finally {
    await stop(primary);
    if (secondary) await stop(secondary);
  }
});
