#!/usr/bin/env node
/**
 * Pairing hands a downloaded Safari extension the bridge token without building it in.
 * `safari-mcp pair` prints a one-time code; the extension's popup trades it at POST /pair.
 * Covered here: the code itself, the daemon route, the worker's token and pairing code,
 * the popup, the build script, and one round trip through the real CLI, daemon and worker
 * code in a temporary HOME, on free ports (never the production bridge ports).
 *
 * Run:  node --test test/pairing.test.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, statSync, existsSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createPairingCode, consumePairingCode, normalizePairingCode, PAIRING_TTL_MS } from "../pairing.js";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "safari-mcp-pairing-")), "pairing");

test("a pairing code is 8 Crockford base32 characters, stored only as a private hash", () => {
  const file = tempFile();
  const code = createPairingCode({ file });
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = readFileSync(file, "utf8");
  assert.ok(!stored.includes(code.replace("-", "")), "the file must not hold the code itself");
  assert.match(JSON.parse(stored).sha256, /^[0-9a-f]{64}$/);
});

test("a code works once, however it is typed", () => {
  const file = tempFile();
  const code = createPairingCode({ file });
  const typed = ` ${code.toLowerCase().replace("-", " ")} `;
  assert.equal(normalizePairingCode(typed), code.replace("-", ""));
  assert.equal(consumePairingCode(typed, { file }), "ok");
  assert.equal(existsSync(file), false);
  assert.equal(consumePairingCode(code, { file }), "missing");
});

test("a bridge that cannot remove the code file hands out no token", { skip: process.getuid?.() === 0 && "root can remove it anyway" }, () => {
  // Bridges on several ports share the file. When two match the same code at once, the one
  // that finds it already gone must not pair too. A read-only folder fails the removal the same way.
  const file = tempFile();
  const code = createPairingCode({ file });
  chmodSync(dirname(file), 0o500);
  try {
    assert.equal(consumePairingCode(code, { file }), "missing");
  } finally {
    chmodSync(dirname(file), 0o700);
  }
});

test("letters that look like digits read as those digits", () => {
  assert.equal(normalizePairingCode("o1il-OOLI"), "0111" + "0011");
});

test("an expired code is refused and removed", () => {
  const file = tempFile();
  const now = Date.now();
  const code = createPairingCode({ file, now });
  assert.equal(consumePairingCode(code, { file, now: now + PAIRING_TTL_MS }), "expired");
  assert.equal(existsSync(file), false);
});

test("five wrong guesses burn the code", () => {
  const file = tempFile();
  const code = createPairingCode({ file });
  const wrong = code.startsWith("0") ? "1111-1111" : "0000-0000";
  for (let i = 0; i < 4; i++) assert.equal(consumePairingCode(wrong, { file }), "invalid");
  assert.equal(existsSync(file), true);
  assert.equal(consumePairingCode("", { file }), "invalid");
  assert.equal(existsSync(file), false);
  assert.equal(consumePairingCode(code, { file }), "missing");
});

test("a damaged pairing file never pairs", () => {
  const file = tempFile();
  for (const content of ["", "{", "null", JSON.stringify({ expiresAt: Date.now() + 60000 })]) {
    writeFileSync(file, content);
    assert.notEqual(consumePairingCode("0000-0000", { file }), "ok");
  }
});

const worker = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const popupHtml = readFileSync(new URL("../extension/popup/popup.html", import.meta.url), "utf8");
const popupJs = readFileSync(new URL("../extension/popup/popup.js", import.meta.url), "utf8");
const embedScript = new URL("../scripts/embed-bridge-token.sh", import.meta.url).pathname;

const TOKEN = "c".repeat(64);
const BUILT_IN = "d".repeat(64);

/** The worker's token and pairing functions, run against fakes. */
function pairingHarness({ fetch, store = {}, ports = [9224, 9228] }) {
  const block = worker.slice(
    worker.indexOf("const _PAIRED_BRIDGE_TOKEN_KEY"),
    worker.indexOf("async function _bridgeFetch(")
  );
  const calls = { connect: 0, badges: [], wake: 0 };
  const browser = {
    storage: { local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (values) => { Object.assign(store, values); },
    } },
    runtime: { getURL: (path) => `safari-web-extension://test/${path}` },
    action: { setBadgeText: ({ text }) => calls.badges.push(text), setBadgeBackgroundColor: () => {} },
  };
  const api = Function(
    "BRIDGE_PORTS", "browser", "fetch", "connect", "updateBadge", "_publishContentWakeToken",
    `let _bridgeAuthTokenPromise = null; let isConnected = false; let _reconnectTimer = null; let _reconnectDelay = 60000;
     ${block}
     return { _bridgeAuthToken, _pairWithBridge, _showPairingNeeded, problem: () => _bridgeAuthProblem };`
  )(
    ports, browser, fetch,
    () => { calls.connect++; },
    (text) => calls.badges.push(text),
    async () => { calls.wake++; }
  );
  return { ...api, store, calls };
}

const builtInFetch = (body, ok = true) => async (url) => {
  assert.equal(url, "safari-web-extension://test/bridge-auth-token");
  if (!ok) throw new TypeError("resource missing");
  return new Response(body);
};

test("a paired token wins over a built-in one", async () => {
  const h = pairingHarness({ fetch: builtInFetch(BUILT_IN), store: { mcpPairedBridgeTokenV1: TOKEN } });
  assert.equal(await h._bridgeAuthToken(), TOKEN);
});

test("a locally built app still uses its built-in token", async () => {
  assert.equal(await pairingHarness({ fetch: builtInFetch(BUILT_IN) })._bridgeAuthToken(), BUILT_IN);
  const garbage = pairingHarness({ fetch: builtInFetch(BUILT_IN), store: { mcpPairedBridgeTokenV1: "not-a-token" } });
  assert.equal(await garbage._bridgeAuthToken(), BUILT_IN, "a malformed stored value is ignored");
});

test("a downloaded app before pairing has no token, and asks again next time", async () => {
  const h = pairingHarness({ fetch: builtInFetch("", false) });
  await assert.rejects(h._bridgeAuthToken());
  h.store.mcpPairedBridgeTokenV1 = TOKEN;
  assert.equal(await h._bridgeAuthToken(), TOKEN, "a failed read is not cached");
});

test("pairing stores the token the bridge returns and reconnects", async () => {
  const requests = [];
  const h = pairingHarness({
    store: { mcpBridgeUrl: "http://127.0.0.1:9228" },
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.startsWith("http://127.0.0.1:9228")) throw new TypeError("connection refused");
      return Response.json({ token: TOKEN });
    },
  });
  assert.deepEqual(await h._pairWithBridge("k7qf-3mzd"), { ok: true });
  assert.deepEqual(requests.map((r) => r.url), ["http://127.0.0.1:9228/pair", "http://127.0.0.1:9224/pair"]);
  assert.equal(requests[1].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[1].init.body), { code: "k7qf-3mzd" });
  assert.ok(!requests.some((r) => r.url.includes("k7qf")), "the code never goes in a URL");
  assert.equal(h.store.mcpPairedBridgeTokenV1, TOKEN);
  assert.equal(await h._bridgeAuthToken(), TOKEN);
  assert.equal(h.calls.connect, 1);
  assert.equal(h.calls.wake, 1, "the derived wake token is republished from the new token");
});

test("a refused code is reported and stores nothing", async () => {
  const error = "That pairing code is not valid.";
  const h = pairingHarness({ fetch: async () => Response.json({ error }, { status: 401 }) });
  assert.deepEqual(await h._pairWithBridge("0000-0000"), { ok: false, error });
  assert.equal(h.store.mcpPairedBridgeTokenV1, undefined);
  assert.equal(h.calls.connect, 0);
});

test("a bridge without /pair is named as too old; no bridge at all is named too", async () => {
  const old = pairingHarness({ fetch: async () => new Response("Not found", { status: 404 }) });
  assert.match((await old._pairWithBridge("0000-0000")).error, /too old to pair/);
  // An old daemon on one port must not hide a newer one on the next.
  const mixed = pairingHarness({
    fetch: async (url) => (url.includes(":9224/") ? new Response("Not found", { status: 404 }) : Response.json({ token: TOKEN })),
  });
  assert.deepEqual(await mixed._pairWithBridge("0000-0000"), { ok: true });
  assert.equal(mixed.store.mcpPairedBridgeTokenV1, TOKEN);
  const none = pairingHarness({ fetch: async () => { throw new TypeError("refused"); } });
  assert.match((await none._pairWithBridge("0000-0000")).error, /No Safari MCP server is running/);
});

test("a malformed token in a 200 reply is never stored", async () => {
  const h = pairingHarness({ fetch: async () => Response.json({ token: "short" }) });
  assert.equal((await h._pairWithBridge("0000-0000")).ok, false);
  assert.equal(h.store.mcpPairedBridgeTokenV1, undefined);
});

test("pairing is offered with a badge, and the popup can read why", async () => {
  const h = pairingHarness({ fetch: builtInFetch("", false) });
  h._showPairingNeeded("rejected");
  assert.equal(h.problem(), "rejected");
  assert.equal(h.store.mcpStatus, "rejected");
  assert.deepEqual(h.calls.badges, ["PAIR"]);
});

// connect()'s unpaired and rejected paths run in test/reconnect-drops-command.test.mjs.
test("a connected worker clears the pairing problem, and only the popup may pair", () => {
  assert.match(worker, /isConnected = true;\s*_bridgeAuthProblem = "";/);
  assert.match(worker, /if \(msg\.action === "pairBridge"\) \{\s*if \(sender\?\.tab\) return false;/);
  assert.match(worker, /auth: _bridgeAuthProblem/);
});

function openPopup({ status, pair = async () => ({ ok: true }) }) {
  const dom = new JSDOM(popupHtml.replace('<script src="popup.js"></script>', ""), { runScripts: "outside-only" });
  const sent = [];
  dom.window.browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        if (message.action === "getStatus") return status;
        if (message.action === "pairBridge") return pair(message.code);
      },
    },
  };
  dom.window.eval(popupJs);
  const $ = (id) => dom.window.document.getElementById(id);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { dom, sent, $, settle };
}

test("the popup asks for a code only when the extension is unpaired or rejected", async () => {
  for (const [status, text, form] of [
    [{ connected: false, enabled: true, auth: "unpaired" }, "Not paired", true],
    [{ connected: false, enabled: true, auth: "rejected" }, "Pairing needed", true],
    [{ connected: true, enabled: true, auth: "" }, "Connected", false],
    [{ connected: false, enabled: false, auth: "" }, "Paused", false],
  ]) {
    const popup = openPopup({ status });
    await popup.settle();
    assert.equal(popup.$("statusText").textContent, text);
    assert.equal(popup.$("pairForm").hidden, !form, `form for ${text}`);
  }
});

test("the popup formats the code, pairs through the worker, and shows its answer", async () => {
  let answer = { ok: false, error: "That pairing code has expired." };
  const popup = openPopup({ status: { connected: false, enabled: true, auth: "unpaired" }, pair: async () => answer });
  await popup.settle();
  const input = popup.$("pairCode");
  input.value = " k7qf 3mzd ";
  input.dispatchEvent(new popup.dom.window.Event("input"));
  assert.equal(input.value, "K7QF-3MZD");

  popup.$("pairForm").dispatchEvent(new popup.dom.window.Event("submit", { cancelable: true }));
  await popup.settle();
  assert.deepEqual({ ...popup.sent.at(-1) }, { action: "pairBridge", code: "K7QF-3MZD" });
  assert.equal(popup.$("pairMessage").textContent, "That pairing code has expired.");
  assert.equal(popup.$("pairMessage").className, "pair-message error");

  answer = { ok: true };
  popup.$("pairForm").dispatchEvent(new popup.dom.window.Event("submit", { cancelable: true }));
  await popup.settle();
  assert.match(popup.$("pairMessage").textContent, /^Paired/);
  assert.equal(input.value, "");
  assert.equal(popup.$("pairButton").disabled, false);
});

function runEmbed(env) {
  const home = mkdtempSync(join(tmpdir(), "safari-mcp-embed-"));
  const build = join(home, "build");
  const output = execFileSync("/bin/sh", [embedScript], {
    env: { PATH: process.env.PATH, HOME: home, TARGET_BUILD_DIR: build, UNLOCALIZED_RESOURCES_FOLDER_PATH: "Resources", ...env },
    encoding: "utf8",
  });
  return { home, resource: join(build, "Resources", "bridge-auth-token"), output };
}

test("a local build embeds this Mac's token; a release build embeds none", () => {
  const local = runEmbed({});
  const token = readFileSync(join(local.home, ".safari-mcp-bridge-token"), "utf8").trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(local.resource, "utf8").trim(), token);
  assert.equal(statSync(local.resource).mode & 0o777, 0o600);

  const release = runEmbed({ SAFARI_MCP_EMBED_BRIDGE_TOKEN: "NO" });
  assert.equal(existsSync(release.resource), false);
  assert.equal(existsSync(join(release.home, ".safari-mcp-bridge-token")), false, "a release build must not even create one");
  assert.match(release.output, /will ask to pair/);

  // An existing token is reused, not replaced.
  writeFileSync(join(local.home, ".safari-mcp-bridge-token"), "e".repeat(64));
  const again = execFileSync("/bin/sh", [embedScript], {
    env: { PATH: process.env.PATH, HOME: local.home, TARGET_BUILD_DIR: join(local.home, "build"), UNLOCALIZED_RESOURCES_FOLDER_PATH: "Resources" },
    encoding: "utf8",
  });
  assert.equal(again, "");
  assert.equal(readFileSync(local.resource, "utf8").trim(), "e".repeat(64));

  // A release build into a folder that a local build used removes the token left there.
  execFileSync("/bin/sh", [embedScript], {
    env: { PATH: process.env.PATH, HOME: local.home, TARGET_BUILD_DIR: join(local.home, "build"), UNLOCALIZED_RESOURCES_FOLDER_PATH: "Resources", SAFARI_MCP_EMBED_BRIDGE_TOKEN: "NO" },
    encoding: "utf8",
  });
  assert.equal(existsSync(local.resource), false);
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

test("the CLI's code buys the bridge token once, and only from an extension origin", { timeout: 45_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "safari-mcp-pair-home-"));
  const { SAFARI_PROFILE: _profile, SAFARI_MCP_HTTP: _http, ...parentEnv } = process.env;
  const bridgePort = await freePort();
  const env = {
    ...parentEnv,
    HOME: home,
    SAFARI_MCP_QUIET: "1",
    SAFARI_MCP_BRIDGE_PORT: String(bridgePort),
    SAFARI_MCP_BRIDGE_WS_PORT: String(await freePort()),
  };

  const printed = execFileSync(process.execPath, ["cli.js", "pair"], { cwd: process.cwd(), env, encoding: "utf8" });
  const code = printed.match(/pairing code: ([0-9A-Z]{4}-[0-9A-Z]{4})/)?.[1];
  assert.ok(code, `no code in:\n${printed}`);
  assert.equal(statSync(join(home, ".safari-mcp-pairing")).mode & 0o777, 0o600);

  const child = spawn(process.execPath, ["index.js"], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    const deadline = Date.now() + 15_000;
    while (!new RegExp(`listening on port ${bridgePort} \\(extension host\\)`).test(stderr)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`daemon did not start:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const token = readFileSync(join(home, ".safari-mcp-bridge-token"), "utf8").trim();
    assert.match(token, /^[0-9a-f]{64}$/);

    const extension = "safari-web-extension://0123ABCD-test";
    // node's fetch omits Origin; set it the way Safari does for each caller.
    const pair = (body, origin) => fetch(`http://127.0.0.1:${bridgePort}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });

    // A web page (its own origin) or a caller with no Origin never reaches the code check.
    assert.equal((await pair({ code }, "https://evil.example")).status, 403);
    assert.equal((await pair({ code }, "")).status, 403);
    assert.equal((await pair({ code }, "null")).status, 403);

    const wrong = await pair({ code: code.startsWith("0") ? "1111-1111" : "0000-0000" }, extension);
    assert.equal(wrong.status, 401);
    assert.doesNotMatch(await wrong.text(), /[0-9a-f]{64}/);

    // The worker's own pairing code, as the popup triggers it, against this daemon. Safari
    // adds the extension origin to every extension-page request; node's fetch has to be told.
    let paired = null;
    const worker = pairingHarness({
      ports: [bridgePort],
      fetch: async (url, init) => {
        const response = await fetch(url, { ...init, headers: { ...init.headers, Origin: extension } });
        paired = response;
        return response;
      },
    });
    assert.deepEqual(await worker._pairWithBridge(code.toLowerCase()), { ok: true });
    assert.equal(worker.store.mcpPairedBridgeTokenV1, token);
    assert.equal(await worker._bridgeAuthToken(), token);
    assert.equal(paired.headers.get("cache-control"), "no-store");
    assert.equal(paired.headers.get("access-control-allow-origin"), extension);

    const again = await pair({ code }, extension);
    assert.equal(again.status, 401, "a code pairs once");

    // The paired token is the one every command endpoint checks.
    const connect = (headerToken) => fetch(`http://127.0.0.1:${bridgePort}/heartbeat`, {
      method: "POST",
      headers: { Origin: extension, "X-Safari-MCP-Token": headerToken, "X-Safari-MCP-Worker": "a".repeat(32) },
    });
    assert.equal((await connect("b".repeat(64))).status, 401);
    assert.notEqual((await connect(token)).status, 401);

    assert.ok(!stderr.includes(token), "the daemon must never log the bridge token");
    assert.ok(!stderr.includes(code) && !stderr.includes(code.replace("-", "")), "the daemon must never log the code");
    assert.match(stderr, /A Safari extension paired with this bridge/);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
