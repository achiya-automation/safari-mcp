import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const project = readFileSync(new URL("../xcode/Safari MCP/Safari MCP.xcodeproj/project.pbxproj", import.meta.url), "utf8");

test("every Safari polling endpoint is behind the shared bridge token", () => {
  for (const endpoint of ["/poll", "/result", "/connect", "/heartbeat", "/extension-verified", "/verify-profile"]) {
    assert.match(server, new RegExp(endpoint.replace("/", "\\/")));
  }
  assert.match(server, /extensionBridgeEndpoint\s*&&\s*!_bridgeTokenMatches/);
  assert.match(server, /req\.headers\["x-safari-mcp-token"\]/);
  assert.match(server, /Access-Control-Allow-Headers[^\n]*X-Safari-MCP-Token/);
});

test("the Safari worker authenticates every localhost bridge request", () => {
  assert.match(worker, /browser\.runtime\.getURL\("bridge-auth-token"\)/);
  assert.match(worker, /headers\.set\("X-Safari-MCP-Token"/);
  assert.match(worker, /headers\.set\("X-Safari-MCP-Worker"/);
  const bridgeRequestLines = worker.split("\n").filter((line) => line.includes("${HTTP_URL}/"));
  assert.ok(bridgeRequestLines.length >= 6);
  assert.ok(bridgeRequestLines.every((line) => line.includes("_bridgeFetch(")));
  assert.match(worker, /_bridgeFetch\(`\$\{HTTP_URL\}\/poll/);
  assert.match(worker, /_bridgeFetch\(`\$\{HTTP_URL\}\/result/);
});

test("only the profile-verified Safari worker can consume or answer commands", () => {
  assert.match(server, /function _requireActiveHttpWorker/);
  assert.match(server, /res\.writeHead\(423\)/);
  assert.match(server, /_activeHttpWorkerId = workerId/);
  assert.match(server, /_isConnectingHttpWorker\(workerId\)/);
  assert.match(server, /pollingWorkerId !== _activeHttpWorkerId/);
  assert.match(worker, /const _bridgeWorkerId/);
  assert.match(worker, /_bridgeWorkerSuperseded = true/);
  assert.match(worker, /!_bridgeWorkerSuperseded && !_reconnectTimer/);
});

test("both signed extension targets embed a private per-install token resource", () => {
  assert.equal((project.match(/Embed Bridge Authentication \*\//g) || []).length, 4);
  assert.match(project, /scripts\/embed-bridge-token\.sh/);
  assert.equal((project.match(/ENABLE_USER_SCRIPT_SANDBOXING = NO;/g) || []).length, 4);
  assert.doesNotMatch(worker, /[0-9a-f]{64}/);
});

test("an empty or malformed bridge-token file can never authenticate", () => {
  assert.match(server, /!\/\^\[0-9a-f\]\{64\}\$\/\.test\(given\)/);
  assert.match(server, /renameSync\(temporaryFile, BRIDGE_TOKEN_FILE\)/);
  assert.match(server, /throw new Error\(`Could not create a valid Safari MCP bridge token/);
});
