// Daemon SESSION_ID must survive a restart in HTTP mode, and must NOT be shared
// between stdio processes. Run: node test-daemon-session-id.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const home = mkdtempSync(join(tmpdir(), "safari-mcp-id-"));
const idFile = join(home, ".safari-mcp", "daemon-session-id");

// Print SESSION_ID the same way index.js derives it, without booting the server.
const probe = `
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const OWNERSHIP_DIR = join(homedir(), ".safari-mcp");
${(await import("node:fs")).readFileSync(new URL("./index.js", import.meta.url), "utf8")
  .match(/function _daemonSessionId\(\)[\s\S]*?\n}\n/)[0]}
process.stdout.write(_daemonSessionId());
`;

const run = (env) =>
  execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, HOME: home, ...env },
    encoding: "utf8",
  });

const http1 = run({ SAFARI_MCP_HTTP: "1" });
assert.match(http1, /^[0-9a-f]{8}$/, "http id shape");
assert.ok(existsSync(idFile), "http mode persists the id");

const http2 = run({ SAFARI_MCP_HTTP: "1" });
assert.equal(http2, http1, "http id must survive a daemon restart");

const stdio1 = run({ SAFARI_MCP_HTTP: "" });
const stdio2 = run({ SAFARI_MCP_HTTP: "" });
assert.notEqual(stdio1, stdio2, "stdio ids must stay per-process");

rmSync(home, { recursive: true, force: true });
console.log("ok — daemon id stable across restarts, stdio ids stay unique");
