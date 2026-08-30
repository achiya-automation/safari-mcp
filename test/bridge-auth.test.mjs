import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const worker = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const content = readFileSync(new URL("../extension/command-content.js", import.meta.url), "utf8");
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
  const bridgeRequestLines = worker.split("\n").filter(
    (line) => line.includes("${HTTP_URL}/") || line.includes("${bridgeUrl}/")
  );
  assert.ok(bridgeRequestLines.length >= 6);
  assert.ok(bridgeRequestLines.every((line) => line.includes("_bridgeFetch(")));
  assert.match(worker, /_bridgeFetch\(`\$\{bridgeUrl\}\/poll/);
  assert.match(worker, /_bridgeFetch\(`\$\{bridgeUrl\}\/result/);
});

test("only the profile-verified Safari worker can consume or answer commands", () => {
  assert.match(server, /function _requireActiveHttpWorker/);
  assert.match(server, /res\.writeHead\(423\)/);
  assert.match(server, /_activeHttpWorkerId = workerId/);
  assert.match(server, /_connectingHttpWorker\(workerId\)/);
  assert.match(server, /pollingWorkerId !== _activeHttpWorkerId/);
  assert.match(server, /_mayReplaceActiveHttpWorker\(workerId, connectingWorker\.reloadHandoffToken\)/);
  assert.match(server, /status: "worker_lease_held"/);
  assert.match(worker, /const _bridgeWorkerId/);
  assert.match(worker, /_bridgeWorkerSuperseded = true/);
  assert.match(worker, /!_bridgeWorkerSuperseded && !_bridgeWorkerRetiring && !_reconnectTimer/);
});

test("reload handoff is an exact ephemeral capability, never a general worker takeover", () => {
  assert.match(server, /X-Safari-MCP-Reload-Handoff/);
  assert.match(server, /randomBytes\(18\)\.toString\("base64url"\)/);
  assert.match(worker, /const _BRIDGE_RELOAD_HANDOFF_KEY/);
  assert.match(worker, /X-Safari-MCP-Reload-Handoff/);
  assert.match(worker, /verifiedResponse\?\.status === 423/);
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

test("the derived wake capability compares only one exact fixed-length token", () => {
  const matcherSource = server.slice(
    server.indexOf("function _contentWakeTokenMatches("),
    server.indexOf("// ========== MULTI-INSTANCE")
  );
  const expected = "a".repeat(64);
  const matches = Function(
    "CONTENT_WAKE_TOKEN", "Buffer", "timingSafeEqual",
    `${matcherSource}; return _contentWakeTokenMatches;`
  )(expected, Buffer, (left, right) => left.equals(right));

  assert.equal(matches(expected), true);
  for (const value of [undefined, null, [expected], "a".repeat(63), "b" + "a".repeat(63)]) {
    assert.equal(matches(value), false);
  }
});

test("the page-bound wake poll has a separate narrow capability", () => {
  assert.match(server, /createHmac\("sha256", BRIDGE_TOKEN\)/);
  assert.match(server, /function _contentWakeTokenMatches/);
  assert.match(server, /req\.url !== "\/content-wakeup"/);
  assert.match(server, /req\.headers\["x-safari-mcp-wakeup"\]/);
  assert.match(server, /_releaseContentWakePolls\(\)/);
  assert.match(server, /requestedHeaders\[0\] !== "x-safari-mcp-wakeup"/);
  assert.ok(
    server.indexOf("_handleContentWakeRequest(req, res)") <
      server.indexOf("Forbidden: cross-origin request blocked"),
    "only the authenticated wake route may run before the extension-origin gate"
  );
  assert.match(worker, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(worker, /mcpContentWakeTokenV1/);
  assert.match(content, /"X-Safari-MCP-Wakeup": _mcpContentWakeToken/);
  assert.match(content, /\/content-wakeup/);
  assert.doesNotMatch(content, /bridge-auth-token|X-Safari-MCP-Token/);
});

test("webpage-origin wake preflight is narrow and the actual poll stays authenticated", () => {
  const wakeSource = server.slice(
    server.indexOf("const _contentWakePolls = new Set()"),
    server.indexOf("try {\n  const httpServer = createServer")
  );
  let timerCallback = null;
  const harness = Function(
    "_contentWakeTokenMatches", "_isExtensionSchemeOrigin", "setTimeout", "clearTimeout",
    `${wakeSource}
     return {
       handle: _handleContentWakeRequest,
       release: _releaseContentWakePolls,
       pollCount: () => _contentWakePolls.size,
     };`
  )(
    (value) => value === "valid-wake-token",
    (origin) => /^(safari-web-extension|moz-extension|chrome-extension):\/\//.test(origin),
    (callback) => { timerCallback = callback; return 1; },
    () => { timerCallback = null; }
  );

  const exchange = (method, url, headers = {}) => {
    const closeListeners = [];
    const req = { method, url, headers, on: (event, callback) => {
      if (event === "close") closeListeners.push(callback);
    } };
    const responseHeaders = new Map();
    const res = {
      status: null,
      body: "",
      writableEnded: false,
      setHeader: (name, value) => responseHeaders.set(name.toLowerCase(), value),
      writeHead(status, extraHeaders = {}) {
        this.status = status;
        for (const [name, value] of Object.entries(extraHeaders)) {
          responseHeaders.set(name.toLowerCase(), value);
        }
      },
      end(body = "") { this.body = body; this.writableEnded = true; },
    };
    return { handled: harness.handle(req, res), res, responseHeaders, closeListeners };
  };

  const preflight = exchange("OPTIONS", "/content-wakeup", {
    origin: "https://example.test",
    "access-control-request-method": "GET",
    "access-control-request-headers": "X-Safari-MCP-Wakeup",
  });
  assert.equal(preflight.handled, true);
  assert.equal(preflight.res.status, 204);
  assert.equal(preflight.responseHeaders.get("access-control-allow-origin"), "https://example.test");
  assert.equal(preflight.responseHeaders.get("access-control-allow-methods"), "GET, OPTIONS");
  assert.equal(preflight.responseHeaders.get("access-control-allow-headers"), "X-Safari-MCP-Wakeup");
  assert.equal(preflight.responseHeaders.get("cache-control"), "no-store");

  const httpPreflight = exchange("OPTIONS", "/content-wakeup", {
    origin: "http://example.test",
    "access-control-request-method": "get",
    "access-control-request-headers": "  x-SaFaRi-McP-WaKeUp  ",
  });
  assert.equal(httpPreflight.res.status, 204);
  assert.equal(httpPreflight.responseHeaders.get("access-control-allow-origin"), "http://example.test");

  const broadPreflight = exchange("OPTIONS", "/content-wakeup", {
    origin: "https://example.test",
    "access-control-request-method": "GET",
    "access-control-request-headers": "X-Safari-MCP-Wakeup, X-Safari-MCP-Token",
  });
  assert.equal(broadPreflight.res.status, 403);
  assert.equal(broadPreflight.responseHeaders.has("access-control-allow-origin"), false);
  for (const origin of ["null", "not an origin", "https://example.test/path"]) {
    const invalidOrigin = exchange("OPTIONS", "/content-wakeup", {
      origin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "X-Safari-MCP-Wakeup",
    });
    assert.equal(invalidOrigin.res.status, 403);
  }
  assert.equal(exchange("POST", "/content-wakeup", {
    origin: "https://example.test",
  }).res.status, 405);
  assert.equal(exchange("HEAD", "/content-wakeup", {
    origin: "https://example.test",
  }).res.status, 405);
  assert.equal(exchange("GET", "/content-wakeup?extra=1", {
    origin: "https://example.test",
    "x-safari-mcp-wakeup": "valid-wake-token",
  }).handled, false);

  assert.equal(exchange("GET", "/content-wakeup", {
    origin: "https://example.test",
  }).res.status, 401);
  assert.equal(exchange("GET", "/content-wakeup", {
    origin: "https://example.test",
    "x-safari-mcp-wakeup": "wrong-token",
  }).res.status, 401);

  const valid = exchange("GET", "/content-wakeup", {
    origin: "https://example.test",
    "x-safari-mcp-wakeup": "valid-wake-token",
  });
  assert.equal(valid.res.status, null, "the authenticated GET must remain a long poll");
  assert.equal(harness.pollCount(), 1);
  harness.release();
  assert.equal(valid.res.status, 204);
  assert.equal(harness.pollCount(), 0);
  assert.equal(timerCallback, null);

  assert.equal(exchange("GET", "/poll", {
    origin: "https://example.test",
    "x-safari-mcp-wakeup": "valid-wake-token",
  }).handled, false, "the wake capability must not enter command routes");
  assert.match(content, /mode: "cors"/);
  assert.match(content, /credentials: "omit"/);
  assert.match(content, /referrerPolicy: "no-referrer"/);
});
