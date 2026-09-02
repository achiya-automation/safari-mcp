#!/usr/bin/env node
// Safari MCP Server — dual engine:
// 1. Safari Web Extension (fast, ~5-20ms, keeps logins) — when extension is connected
// 2. AppleScript + Swift daemon (~5ms, keeps logins) — always available
//
// Extension transport: HTTP polling (Safari — WebSocket blocked by Apple)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startTransport } from "./transport.js";
import { currentSessionId } from "./session-context.js";
import { z } from "zod";
import * as safari from "./safari.js";
import { textResult, jsonResult, imageResult, errorResult } from "./response.js";
import {
  OWNERSHIP_DIR, BLANK_TAB_SENTINEL,
  _openedTabs, _ownedTabURLs,
  _isURLOwned, _markBlankTabOpened, _addOwnedURL, _removeOwnedURL, _trackTab, _untrackTab,
} from "./ownership-state.js";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { randomUUID, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB cap on POST body — prevents DoS

// Security: local shared-secret for /proxy-command — prevents an unrelated local process
// (e.g. a malicious npm postinstall) from driving the browser through this bridge.
// Read/created once with mode 600; all instances share it.
const PROXY_TOKEN_FILE = join(homedir(), ".safari-mcp-proxy-token");
function _getProxyToken() {
  try { return readFileSync(PROXY_TOKEN_FILE, "utf8").trim(); }
  catch {
    const tok = randomBytes(32).toString("hex");
    try { writeFileSync(PROXY_TOKEN_FILE, tok, { mode: 0o600 }); }
    catch (err) { console.error(`[Safari MCP] Could not persist proxy token: ${err.message} — secondary instances will get 403 on /proxy-command until the file is writable.`); }
    return tok;
  }
}
const PROXY_TOKEN = _getProxyToken();

// The Safari extension bridge uses a separate per-install secret. The signed
// extension bundle receives the same value as a private resource at build time;
// it never travels in a URL or page state. Keeping this separate from the proxy
// token prevents a compromised extension transport from authenticating as a
// secondary MCP process.
const BRIDGE_TOKEN_FILE = join(homedir(), ".safari-mcp-bridge-token");
function _getBridgeToken() {
  try {
    const existing = readFileSync(BRIDGE_TOKEN_FILE, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {}

  const tok = randomBytes(32).toString("hex");
  const temporaryFile = `${BRIDGE_TOKEN_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporaryFile, tok, { mode: 0o600, flag: "wx" });
    renameSync(temporaryFile, BRIDGE_TOKEN_FILE);
    return tok;
  } catch (err) {
    try { unlinkSync(temporaryFile); } catch {}
    // Another starting process may have repaired the file first. Accept only a
    // complete valid value; otherwise refuse startup instead of authenticating
    // an empty or partially written token.
    try {
      const repaired = readFileSync(BRIDGE_TOKEN_FILE, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(repaired)) return repaired;
    } catch {}
    throw new Error(`Could not create a valid Safari MCP bridge token: ${err.message}`);
  }
}
const BRIDGE_TOKEN = _getBridgeToken();
const CONTENT_WAKE_LABEL = "safari-mcp-content-wakeup-v1";
const CONTENT_WAKE_TOKEN = createHmac("sha256", BRIDGE_TOKEN)
  .update(CONTENT_WAKE_LABEL)
  .digest("hex");

// Security: compare the local shared-secret in constant time. A plain `!==` returns as
// soon as two bytes differ, so the reply latency leaks how many leading bytes matched —
// a byte-at-a-time oracle that recovers the whole token over enough local requests.
// A non-string header (absent, or sent twice so Node yields an array) fails closed.
function _tokenMatches(given) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(PROXY_TOKEN, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function _bridgeTokenMatches(given) {
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/.test(given) || !/^[0-9a-f]{64}$/.test(BRIDGE_TOKEN)) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(BRIDGE_TOKEN, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function _contentWakeTokenMatches(given) {
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/.test(given) || !/^[0-9a-f]{64}$/.test(CONTENT_WAKE_TOKEN)) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(CONTENT_WAKE_TOKEN, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ========== MULTI-INSTANCE: concurrent instances coexist (never kill siblings) ==========
// This block previously SIGTERM'd every other safari-mcp instance running >10s to
// clear "stale" processes from previous sessions. That broke multi-session use:
// each new Claude Code session's instance killed every older session's instance,
// disconnecting them mid-task. Concurrent instances are fully supported by design —
// the first to bind HTTP_PORT becomes the extension host, the rest proxy commands
// through it (see PROXY MODE below). Instances from closed sessions are SIGTERM'd
// by their own MCP client on shutdown, so no cross-instance cleanup is needed here.

// ========== SESSION ID (unique per MCP process — enables per-session tab tracking) ==========
const SESSION_ID = randomUUID().slice(0, 8);

// Persistent tab-ownership state + its helpers now live in ownership-state.js
// (OWNERSHIP_* consts, _ownedTabURLs/_ownedTabTimestamps, _loadOwnershipFile,
// _saveOwnershipFile, _isURLOwned, _addOwnedURL, _trackTab, … — imported at the top).
// OWNERSHIP_DIR is re-used below for the memory-monitor lock file.

// ========== MEMORY GUARD: track & auto-close MCP-opened tabs ==========
const MAX_TABS = parseInt(process.env.MCP_MAX_TABS || "6", 10);
const MEMORY_CHECK_INTERVAL_MS = parseInt(process.env.MCP_MEMORY_CHECK_MS || "60000", 10);
const WEBKIT_MEMORY_LIMIT_MB = parseInt(process.env.MCP_WEBKIT_LIMIT_MB || "3000", 10);

// Tab-ownership state (_openedTabs / _ownedTabURLs / _ownedTabTimestamps), the on-disk
// persistence + TTL, and the helpers (_isURLOwned, _markBlankTabOpened, _addOwnedURL,
// _removeOwnedURL, _trackTab, _untrackTab, BLANK_TAB_SENTINEL) are imported from
// ownership-state.js at the top of this file.

// Close all MCP-opened tabs on process exit
async function _cleanupTabs() {
  if (_openedTabs.size === 0) return;
  // A named Safari profile is extension-only: never mutate it through the
  // AppleScript compatibility backend during process shutdown. Explicit tab
  // closes are ownership-checked by the extension while the session is alive.
  if (process.env.SAFARI_PROFILE) {
    console.error(`[Safari MCP] Cleanup: leaving ${_openedTabs.size} profile tabs for extension-safe cleanup`);
    _openedTabs.clear();
    return;
  }
  console.error(`[Safari MCP] Cleanup: closing ${_openedTabs.size} MCP-opened tabs`);
  // Close by URL (not index) — indices shift as tabs are closed
  const urlsToClose = [..._openedTabs.values()].map(v => v.url).filter(Boolean);
  for (const url of urlsToClose) {
    try {
      // Re-resolve index by URL before each close (indices shift after each closure)
      const tabs = await safari.listTabs();
      const parsed = typeof tabs === 'string' ? JSON.parse(tabs) : tabs;
      const match = parsed.find(t => t.url === url);
      // Name the tab explicitly: it was just resolved out of our own opened-tab table, and
      // closeTab refuses anything it cannot prove it owns (#68).
      if (match) await safari.closeTab(match.index);
    } catch {}
  }
  _openedTabs.clear();
}

// Periodic memory check — proactive monitoring with warning + action thresholds
const WEBKIT_WARNING_THRESHOLD_MB = Math.round(WEBKIT_MEMORY_LIMIT_MB * 0.7); // 70% = warning
let _memoryCheckTimer = null;
let _lastMemoryWarningTime = 0;

// ── Cross-instance memory-monitor lock ───────────────────────────────────────
// Every MCP instance (one per Claude session) runs this monitor and they ALL
// read the SAME global WebKit memory. Uncoordinated, all of them close tabs at
// the same moment ("thundering herd") and Safari windows flicker shut. This file
// lock lets only ONE instance run a close-sweep per cycle; the rest skip it.
const _MEMORY_LOCK_FILE = join(OWNERSHIP_DIR, "memory-monitor.lock");
const _MEMORY_LOCK_TTL_MS = 25000; // lock held longer than this = crashed owner, reclaim it

function _tryAcquireMemoryLock() {
  try {
    if (!existsSync(OWNERSHIP_DIR)) mkdirSync(OWNERSHIP_DIR, { recursive: true });
    // Atomic create-if-absent ("wx") — succeeds for exactly one instance.
    writeFileSync(_MEMORY_LOCK_FILE, `${process.pid}:${Date.now()}`, { flag: "wx" });
    return true;
  } catch {
    // Lock exists — reclaim only if its owner is stale (crashed without releasing).
    try {
      const ts = parseInt(readFileSync(_MEMORY_LOCK_FILE, "utf8").split(":")[1], 10) || 0;
      if (Date.now() - ts > _MEMORY_LOCK_TTL_MS) {
        writeFileSync(_MEMORY_LOCK_FILE, `${process.pid}:${Date.now()}`, { flag: "w" });
        return true;
      }
    } catch {}
    return false;
  }
}

function _releaseMemoryLock() {
  try {
    if (readFileSync(_MEMORY_LOCK_FILE, "utf8").split(":")[0] === String(process.pid)) {
      unlinkSync(_MEMORY_LOCK_FILE);
    }
  } catch {}
}

function _getWebKitMemoryMB() {
  try {
    const pids = execFileSync("pgrep", ["-f", "WebKit|WebContent"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!pids) return 0;
    const pidList = pids.split("\n").join(",");
    const psOut = execFileSync("ps", ["-p", pidList, "-o", "rss="], { encoding: "utf8" }).trim();
    const totalKB = psOut.split("\n").reduce((sum, l) => sum + (parseInt(l.trim(), 10) || 0), 0);
    return totalKB / 1024;
  } catch { return 0; }
}

async function _closeOldestMCPTab() {
  if (process.env.SAFARI_PROFILE) return;
  let oldestIdx = null, oldestTime = Infinity;
  for (const [idx, info] of _openedTabs) {
    if (info.openedAt < oldestTime) { oldestTime = info.openedAt; oldestIdx = idx; }
  }
  if (oldestIdx !== null) {
    try {
      const info = _openedTabs.get(oldestIdx);
      if (info?.url) {
        const tabs = await safari.listTabs();
        const parsed = typeof tabs === 'string' ? JSON.parse(tabs) : tabs;
        const match = parsed.find(t => t.url === info.url);
        if (match) await safari.closeTab(match.index);
      }
    } catch {}
    _untrackTab(oldestIdx);
  }
}

function _startMemoryMonitor() {
  const checkInterval = Math.min(MEMORY_CHECK_INTERVAL_MS, 30000); // Max 30s between checks
  _memoryCheckTimer = setInterval(async () => {
    try {
      // Every instance may sweep — but only its OWN _openedTabs, and only one
      // per cycle: _tryAcquireMemoryLock() below already serializes sweepers
      // machine-wide. The old `_isExtensionHost` gate here was redundant with
      // that lock and made the guard inert in multi-instance setups — only the
      // port-9224 winner could ever sweep, and it can't reach tabs the other
      // instances opened (#83).
      const webkitMB = _getWebKitMemoryMB();
      if (webkitMB <= 0) return;

      // Warning threshold — log only (once per 5 min)
      if (webkitMB > WEBKIT_WARNING_THRESHOLD_MB && webkitMB <= WEBKIT_MEMORY_LIMIT_MB) {
        if (Date.now() - _lastMemoryWarningTime > 300000) {
          console.error(`[Safari MCP] ⚠️ WebKit memory warning: ${Math.round(webkitMB)}MB (threshold: ${WEBKIT_WARNING_THRESHOLD_MB}MB, limit: ${WEBKIT_MEMORY_LIMIT_MB}MB) — ${_openedTabs.size} MCP tabs open`);
          _lastMemoryWarningTime = Date.now();
        }
      }

      // Action threshold — close oldest tabs (up to 2) to recover memory.
      // Guarded by a cross-instance lock: with N instances all watching the same
      // global WebKit memory, only ONE may sweep per cycle — otherwise all N close
      // tabs together and Safari windows flicker shut.
      if (webkitMB > WEBKIT_MEMORY_LIMIT_MB && _openedTabs.size > 1) {
        if (!_tryAcquireMemoryLock()) return; // another instance is already recovering memory
        try {
          console.error(`[Safari MCP] 🔴 WebKit over limit: ${Math.round(webkitMB)}MB — closing oldest MCP tabs`);
          await _closeOldestMCPTab();
          // If still over limit and have more tabs, close another
          if (_openedTabs.size > 1) {
            const afterMB = _getWebKitMemoryMB();
            if (afterMB > WEBKIT_MEMORY_LIMIT_MB) {
              await _closeOldestMCPTab();
            }
          }
        } finally {
          _releaseMemoryLock();
        }
      }
    } catch {}
  }, checkInterval);
  _memoryCheckTimer.unref();
}

// Cleanup on exit
let _cleaningUp = false;
async function _shutdown() {
  if (_cleaningUp) return;
  _cleaningUp = true;
  // Restore the user's clipboard synchronously FIRST — if a native paste is mid-flight, its
  // 2s restore timer would never fire once we exit, leaving the tool's text on the clipboard.
  try { safari.flushClipboardRestore(); } catch {}
  // Cap tab cleanup — if the daemon/Safari is wedged at shutdown (exactly when a SIGTERM
  // tends to arrive), listTabs/closeTab can each block for their full timeout; never let
  // that hang the exit past 3s.
  await Promise.race([_cleanupTabs(), new Promise(r => setTimeout(r, 3000))]);
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, _shutdown);
}
process.on("exit", () => {
  if (_openedTabs.size > 0) {
    console.error(`[Safari MCP] Exit: ${_openedTabs.size} tabs were tracked for cleanup`);
  }
});

// ========== EXTENSION FOCUS SAFETY ==========
// Before the extension proves its Safari profile, AppleScript is the only safe path:
// accepting whichever extension polls first can cross from Automation into Personal.
// Once profile verification succeeds, the extension is both profile-pinned and the only
// backend that still works when macOS temporarily denies Apple Events (-1743).
const _preferAppleScript = !!process.env.SAFARI_PROFILE;
let _profileExtensionVerified = !process.env.SAFARI_PROFILE;
// A same-version .appex replacement leaves Safari running the OLD service worker,
// which this server refuses by design (see EXTENSION_BRIDGE_PROTOCOL). The refusal is
// silent: workers keep POSTing /connect forever and every tool call fails with the
// generic "profile extension unavailable". Count distinct never-verified workers so
// the operator is told the one thing that fixes it instead of debugging the bridge.
const _unverifiedWorkerIds = new Set();
let _staleWorkerAdviceShown = false;
function _noteUnverifiedWorker(workerId) {
  if (!process.env.SAFARI_PROFILE || _profileExtensionVerified || !workerId) return;
  _unverifiedWorkerIds.add(workerId);
  if (_staleWorkerAdviceShown || _unverifiedWorkerIds.size < 3) return;
  _staleWorkerAdviceShown = true;
  console.error(
    `[Safari MCP] ⚠️ ${_unverifiedWorkerIds.size} extension workers connected but none proved profile ` +
    `"${process.env.SAFARI_PROFILE}". This is the signature of a same-version .appex replacement: ` +
    `Safari is still running the previous service worker, which this server refuses by design. ` +
    `Fix: Safari → Settings → Extensions → toggle "Safari MCP Bridge" off and on (or restart Safari). ` +
    `Restarting this server does NOT help — the stale worker lives inside Safari.`
  );
}

// A named profile is driven only by its verified WebExtension worker. The worker
// can create a background window through browser.windows.create() when the last
// profile window was closed, so no AppleScript/UI-scripting recovery is needed.
async function _waitForVerifiedProfileExtension(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (_extensionConnected && _profileExtensionVerified) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

// ========== EXTENSION BRIDGE (WebSocket + HTTP polling) ==========
function _bridgePort(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : fallback;
}
const HTTP_PORT = _bridgePort("SAFARI_MCP_BRIDGE_PORT", 9224);
const WS_PORT = _bridgePort("SAFARI_MCP_BRIDGE_WS_PORT", HTTP_PORT - 1);
// A manifest version is not enough to distinguish two development builds: Safari can
// keep an older service worker alive after a same-version appex is replaced. Require a
// code-capability marker before a worker may enter profile verification, so a stale
// worker can never displace the currently installed worker or consume its commands.
const EXTENSION_BRIDGE_PROTOCOL = "popup-opener-lease-v2";
function _isExtensionSchemeOrigin(origin) {
  const value = String(origin || "");
  return value.startsWith("safari-web-extension://") ||
    value.startsWith("moz-extension://") ||
    value.startsWith("chrome-extension://");
}
// Bearer receipts cross this socket, so an extension scheme is not enough: another
// installed extension could claim the connection. WebSocket transport is disabled
// until exact trusted origins are explicitly allowlisted. Safari uses HTTP polling.
const _allowedWebSocketOrigins = new Set(
  String(process.env.SAFARI_MCP_WS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => _isExtensionSchemeOrigin(origin))
);
function _isAllowedWebSocketOrigin(origin) {
  return _allowedWebSocketOrigins.has(String(origin || ""));
}
let _extensionWs = null;
let _extensionConnected = false;
let _activeHttpWorkerId = "";
const _connectingHttpWorkers = new Map();
const _HTTP_WORKER_TTL_MS = 60 * 1000;
const _HTTP_RELOAD_HANDOFF_TTL_MS = 30 * 1000;
const _HTTP_WORKER_SUCCESSOR_GRACE_MS = 20 * 1000;
const _HTTP_WORKER_DISCONNECT_MS = 30 * 1000;
let _extensionLastPollTime = 0;
let _extensionLastHeartbeat = 0;
let _reloadHttpWorkerHandoff = null;

function _httpWorkerId(req) {
  const value = req.headers["x-safari-mcp-worker"];
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value) ? value : "";
}

function _reloadHandoffToken(req) {
  const value = req.headers["x-safari-mcp-reload-handoff"];
  return typeof value === "string" && /^[A-Za-z0-9_-]{24,}$/.test(value) ? value : "";
}

function _rememberConnectingHttpWorker(workerId, reloadHandoffToken = "") {
  const now = Date.now();
  for (const [id, record] of _connectingHttpWorkers) {
    if (now - record.connectedAt > _HTTP_WORKER_TTL_MS) _connectingHttpWorkers.delete(id);
  }
  _connectingHttpWorkers.set(workerId, { connectedAt: now, reloadHandoffToken });
}

function _connectingHttpWorker(workerId) {
  const record = _connectingHttpWorkers.get(workerId);
  return record && typeof record.connectedAt === "number" && Date.now() - record.connectedAt <= _HTTP_WORKER_TTL_MS
    ? record
    : null;
}

function _prepareReloadHttpWorkerHandoff() {
  const now = Date.now();
  if (!_activeHttpWorkerId) {
    throw new Error("Extension reload requires an active HTTP worker");
  }
  // A prepared handoff is attached by object identity to one pending reload command.
  // Preserve it beyond the successor TTL only while that exact command is pending;
  // otherwise an ACK lost after arming (or a failed runtime.reload) would block all
  // future reloads forever on the still-healthy original worker.
  if (_reloadHttpWorkerHandoff) {
    const handoff = _reloadHttpWorkerHandoff;
    const isPending = [..._pendingRequests.values()].some(
      (pending) => pending.reloadHandoff === handoff
    );
    if (handoff.expiresAt < now && !isPending) {
      _reloadHttpWorkerHandoff = null;
    } else {
      throw new Error("Extension reload is already in progress");
    }
  }
  const handoff = {
    fromWorkerId: _activeHttpWorkerId,
    token: randomBytes(18).toString("base64url"),
    armed: false,
    expiresAt: now + _HTTP_RELOAD_HANDOFF_TTL_MS,
  };
  _reloadHttpWorkerHandoff = handoff;
  return handoff;
}

function _armReloadHttpWorkerHandoff(handoff) {
  if (_reloadHttpWorkerHandoff !== handoff) return false;
  handoff.armed = true;
  handoff.expiresAt = Date.now() + _HTTP_RELOAD_HANDOFF_TTL_MS;
  return true;
}

function _cancelReloadHttpWorkerHandoff(handoff) {
  if (_reloadHttpWorkerHandoff === handoff) _reloadHttpWorkerHandoff = null;
}

function _activeHttpWorkerIsFresh(now = Date.now()) {
  const lastActivity = Math.max(_extensionLastPollTime, _extensionLastHeartbeat);
  return !!_activeHttpWorkerId && _extensionConnected && lastActivity > 0 && now - lastActivity <= _HTTP_WORKER_SUCCESSOR_GRACE_MS;
}

function _activeHttpWorkerHasDispatchedRequest() {
  return !!_activeHttpWorkerId && [..._pendingRequests.values()].some(
    (pending) => pending.dispatchedWorkerId === _activeHttpWorkerId
  );
}

function _mayReplaceActiveHttpWorker(workerId, presentedToken, now = Date.now()) {
  if (!_activeHttpWorkerId || workerId === _activeHttpWorkerId) return true;
  // No successor capability may bypass a mutation already delivered to the
  // active worker. A reload result removes its pending fence before arming the
  // exact handoff, so the intended reload path remains available.
  if (_activeHttpWorkerHasDispatchedRequest()) return false;
  const handoff = _reloadHttpWorkerHandoff;
  if (handoff) {
    // While the old worker is preparing a reload, no unrelated worker may use a
    // momentary poll/heartbeat gap to clear the handoff before /result arms it.
    if (!handoff.armed) return false;
    if (handoff.expiresAt >= now) {
      return handoff.fromWorkerId === _activeHttpWorkerId && presentedToken === handoff.token;
    }
    // An armed successor token is one-shot and short-lived. Once it expires, return
    // to the ordinary healthy-worker lease instead of leaving a permanent blockade.
    if (_reloadHttpWorkerHandoff === handoff) _reloadHttpWorkerHandoff = null;
  }
  return !_activeHttpWorkerIsFresh(now);
}

function _requireActiveHttpWorker(req, res) {
  const workerId = _httpWorkerId(req);
  if (!workerId) {
    res.writeHead(401);
    res.end("Worker authentication required");
    return "";
  }
  if (!_activeHttpWorkerId) {
    res.writeHead(409);
    res.end("Worker reconnect required");
    return "";
  }
  if (workerId !== _activeHttpWorkerId) {
    // A previous Safari service worker can survive an extension reload. It must stop
    // polling rather than consuming commands whose receipt state belongs to the newly
    // verified worker.
    res.writeHead(423);
    res.end("Worker superseded");
    return "";
  }
  return workerId;
}
// Monotonic proof that a worker completed a NEW verified connection.  A boolean is
// insufficient for reload_extension: the old worker can still be marked connected
// when its command response arrives, so callers used to return before the replacement
// worker existed.
let _extensionConnectionGeneration = 0;

async function _waitForExtensionGeneration(previousGeneration, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      _extensionConnectionGeneration > previousGeneration &&
      _extensionConnected &&
      (!_preferAppleScript || _profileExtensionVerified)
    ) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

// Pending requests: command sent to extension, waiting for result
const _pendingRequests = new Map();

// Command queue: commands waiting to be picked up by HTTP-polling extension
const _commandQueue = [];

function _dequeueHttpCommand(workerId) {
  while (_commandQueue.length > 0) {
    const cmd = _commandQueue.shift();
    const pending = _pendingRequests.get(cmd.id);
    // A request timer can expire while its command is at the head of the queue.
    // Never deliver an orphaned or already-claimed mutation out of band.
    if (!pending || pending.dispatchedWorkerId) continue;
    pending.dispatchedWorkerId = workerId;
    return cmd;
  }
  return null;
}

// ========== WEBSOCKET SERVER (for Chrome extensions / direct WebSocket) ==========
let wss;
try {
  wss = new WebSocketServer({
    host: "127.0.0.1",
    port: WS_PORT,
    verifyClient: ({ origin }) => _isAllowedWebSocketOrigin(origin),
  });
  wss.on("connection", (ws) => {
    _extensionWs = ws;
    _extensionConnected = true;
    _extensionConnectionGeneration += 1;
    console.error(`[Safari MCP] Extension connected via WebSocket`);
    _setupExtensionListener(ws);
    ws.on("close", () => {
      _extensionConnected = false;
      _extensionWs = null;
      _drainOnDisconnect("WebSocket close");
      console.error("[Safari MCP] Extension disconnected (WebSocket)");
    });
  });
  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[Safari MCP] WebSocket port ${WS_PORT} in use — WebSocket disabled`);
    }
  });
} catch {}

function _setupExtensionListener(ws) {
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    _handleExtensionResponse(msg);
  });
}

// ========== HTTP POLLING SERVER (for Safari extensions — WebSocket blocked) ==========
const _contentWakePolls = new Set();
function _releaseContentWakePolls() {
  for (const finish of [..._contentWakePolls]) finish();
}

function _setContentWakeCors(req, res) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  if (origin) res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "X-Safari-MCP-Wakeup");
  res.setHeader("Cache-Control", "no-store");
}

function _isAllowedContentWakeOrigin(origin) {
  if (!origin) return true;
  if (_isExtensionSchemeOrigin(origin)) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin;
  } catch {
    return false;
  }
}

function _handleContentWakeRequest(req, res) {
  if (req.url !== "/content-wakeup") return false;

  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (!_isAllowedContentWakeOrigin(origin)) {
    res.writeHead(403);
    res.end("Forbidden origin");
    return true;
  }

  // Safari gives a content-script fetch the webpage's Origin. Permit only this
  // narrow, authority-free wake route before the extension-only CORS gate below.
  // The actual GET still needs the independent derived HMAC capability.
  if (req.method === "OPTIONS") {
    const requestedMethod = String(req.headers["access-control-request-method"] || "").toUpperCase();
    const requestedHeaders = String(req.headers["access-control-request-headers"] || "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedMethod !== "GET" ||
        requestedHeaders.length !== 1 ||
        requestedHeaders[0] !== "x-safari-mcp-wakeup") {
      res.writeHead(403);
      res.end("Forbidden preflight");
      return true;
    }
    _setContentWakeCors(req, res);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET, OPTIONS" });
    res.end("Method not allowed");
    return true;
  }

  _setContentWakeCors(req, res);
  if (!_contentWakeTokenMatches(req.headers["x-safari-mcp-wakeup"])) {
    res.writeHead(401);
    res.end("Unauthorized");
    return true;
  }

  if (_contentWakePolls.size >= 4) {
    res.writeHead(429, { "Retry-After": "1" });
    res.end("Too many wake polls");
    return true;
  }

  let settled = false;
  let timer = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    _contentWakePolls.delete(finish);
    if (!res.writableEnded) {
      res.writeHead(204);
      res.end();
    }
  };
  _contentWakePolls.add(finish);
  timer = setTimeout(finish, 8000);
  req.on("close", () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    _contentWakePolls.delete(finish);
  });
  return true;
}

try {
  const httpServer = createServer((req, res) => {
    if (_handleContentWakeRequest(req, res)) return;

    // CORS headers — restricted to browser extension origin only.
    // Safari extensions use moz-extension:// or safari-web-extension:// origins.
    // "*" was a security risk: any webpage could POST to the localhost bridge and execute MCP commands.
    const origin = req.headers.origin || "";
    const isSafeOrigin = !origin || _isExtensionSchemeOrigin(origin);
    if (isSafeOrigin) {
      res.setHeader("Access-Control-Allow-Origin", origin || "*");
    } else {
      // Block cross-origin requests from web pages
      res.writeHead(403);
      res.end("Forbidden: cross-origin request blocked");
      return;
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Safari-MCP-Token, X-Safari-MCP-Worker, X-Safari-MCP-Reload-Handoff");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Every Safari-extension HTTP endpoint is authenticated in addition to its
    // CORS check. Origin alone is not authority: another extension has its own
    // extension-scheme origin, and a local process can forge or omit Origin.
    const extensionBridgeEndpoint =
      (req.method === "GET" && req.url === "/poll") ||
      (req.method === "POST" && (
        req.url === "/result" ||
        req.url.startsWith("/connect") ||
        req.url === "/heartbeat" ||
        req.url === "/extension-verified" ||
        req.url === "/verify-profile"
      ));
    if (extensionBridgeEndpoint && !_bridgeTokenMatches(req.headers["x-safari-mcp-token"])) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    // GET /poll — extension asks for next command (long-poll, up to 5s)
    if (req.method === "GET" && req.url === "/poll") {
      const pollingWorkerId = _requireActiveHttpWorker(req, res);
      if (!pollingWorkerId) return;
      // A profile-scoped server never releases queued commands until an extension has
      // proved it belongs to that profile. This keeps an old/wrong worker from draining
      // commands during reconnect races.
      if (process.env.SAFARI_PROFILE && !_profileExtensionVerified) {
        res.writeHead(409);
        res.end("Profile verification required");
        return;
      }
      _extensionLastPollTime = Date.now(); // Keep connection alive — critical for stale detection
      if (!_extensionConnected) {
        _extensionConnected = true;
        console.error("[Safari MCP] Extension reconnected via poll");
      }
      const queuedCommand = _dequeueHttpCommand(pollingWorkerId);
      if (queuedCommand) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(queuedCommand));
      } else {
        // Long-poll: wait up to 5 seconds for a command
        const timer = setTimeout(() => {
          res.writeHead(204);
          res.end();
        }, 5000);

        const checkInterval = setInterval(() => {
          if (pollingWorkerId !== _activeHttpWorkerId) {
            clearTimeout(timer);
            clearInterval(checkInterval);
            res.writeHead(423);
            res.end("Worker superseded");
            return;
          }
          const cmd = _dequeueHttpCommand(pollingWorkerId);
          if (cmd) {
            clearTimeout(timer);
            clearInterval(checkInterval);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(cmd));
          }
        }, 5); // Check every 5ms (reduced from 20ms — cuts avg command delivery delay from 10ms to 2.5ms)

        // Cleanup on client disconnect
        req.on("close", () => {
          clearTimeout(timer);
          clearInterval(checkInterval);
        });
      }
      return;
    }

    // POST /result — extension sends command result
    if (req.method === "POST" && req.url === "/result") {
      const respondingWorkerId = _requireActiveHttpWorker(req, res);
      if (!respondingWorkerId) return;
      let body = "";
      let bodyTooLarge = false; // 'end' can still fire after destroy() — never parse/respond then
      req.on("data", (chunk) => { if (bodyTooLarge || res.headersSent) return; body += chunk; if (body.length > MAX_BODY_SIZE) { bodyTooLarge = true; res.writeHead(413); res.end("Payload too large"); req.destroy(); } });
      req.on("end", () => {
        if (bodyTooLarge) return;
        let accepted = false;
        try {
          const msg = JSON.parse(body);
          accepted = _handleExtensionResponse(msg, respondingWorkerId);
        } catch {}
        res.writeHead(accepted ? 200 : 409);
        res.end(accepted ? "ok" : "Result was not accepted");
      });
      return;
    }

    // POST /connect — extension announces it's alive
    if (req.method === "POST" && req.url.startsWith("/connect")) {
      const workerId = _httpWorkerId(req);
      if (!workerId) {
        res.writeHead(400);
        res.end("Worker identity required");
        return;
      }
      const connectUrl = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
      // Safari can retain old per-profile workers after a development build is replaced.
      // Those workers use the legacy visible-tab verifier. Fail them closed before the
      // server reveals a target profile, while current workers use the no-new-tab verifier.
      if (process.env.SAFARI_PROFILE && (
        connectUrl.searchParams.get("verifier") !== "existing-tab-v1" ||
        connectUrl.searchParams.get("protocol") !== EXTENSION_BRIDGE_PROTOCOL
      )) {
        res.writeHead(426, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "upgrade_required" }));
        return;
      }
      // Only an accepted code generation may proceed to /verify-profile and
      // /extension-verified. Remembering rejected workers would let a stale process
      // skip the protocol gate by posting the second handshake step directly.
      _rememberConnectingHttpWorker(workerId, _reloadHandoffToken(req));
      _noteUnverifiedWorker(workerId);
      // When SAFARI_PROFILE is set, don't mark as connected until profile is verified.
      // A personal-profile extension connecting first would incorrectly set the flag.
      if (!process.env.SAFARI_PROFILE) {
        const reloadHandoffToken = _reloadHandoffToken(req);
        if (!_mayReplaceActiveHttpWorker(workerId, reloadHandoffToken)) {
          _connectingHttpWorkers.delete(workerId);
          res.writeHead(423, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "worker_lease_held" }));
          return;
        }
        const workerChanged = workerId !== _activeHttpWorkerId;
        _activeHttpWorkerId = workerId;
        _connectingHttpWorkers.delete(workerId);
        if (workerChanged) {
          _reloadHttpWorkerHandoff = null;
          _extensionConnectionGeneration += 1;
        }
        if (!_extensionConnected) {
          _extensionConnected = true;
          console.error("[Safari MCP] Extension connected via HTTP polling");
        }
      }
      if (!process.env.SAFARI_PROFILE) _extensionLastPollTime = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "connected", profile: process.env.SAFARI_PROFILE || null }));
      return;
    }

    // POST /heartbeat — extension is alive and mid-command (its poll loop is blocked
    // by the running command, so /poll cannot be what proves liveness here).
    if (req.method === "POST" && req.url === "/heartbeat") {
      const heartbeatingWorkerId = _requireActiveHttpWorker(req, res);
      if (!heartbeatingWorkerId) return;
      _extensionLastHeartbeat = Date.now();
      _extensionLastPollTime = Date.now();
      // Re-arm in-flight deadlines: the worker told us it is still on the command.
      // hardDeadline inside armTimer keeps this from extending indefinitely.
      for (const pending of _pendingRequests.values()) {
        if (pending.dispatchedWorkerId !== heartbeatingWorkerId) continue;
        if (!pending.armTimer || Date.now() >= pending.hardDeadline) continue;
        clearTimeout(pending.timer);
        pending.timer = pending.armTimer();
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // POST /extension-verified — extension confirmed it's in the correct profile
    if (req.method === "POST" && req.url === "/extension-verified") {
      const workerId = _httpWorkerId(req);
      const connectingWorker = workerId ? _connectingHttpWorker(workerId) : null;
      if (!workerId || !connectingWorker) {
        res.writeHead(401);
        res.end("Unverified worker");
        return;
      }
      if (!_mayReplaceActiveHttpWorker(workerId, connectingWorker.reloadHandoffToken)) {
        _connectingHttpWorkers.delete(workerId);
        res.writeHead(423, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "worker_lease_held" }));
        return;
      }
      const workerChanged = workerId !== _activeHttpWorkerId;
      _activeHttpWorkerId = workerId;
      _connectingHttpWorkers.delete(workerId);
      if (workerChanged) _reloadHttpWorkerHandoff = null;
      _profileExtensionVerified = true;
      if (workerChanged) _extensionConnectionGeneration += 1;
      if (!_extensionConnected) {
        _extensionConnected = true;
        console.error("[Safari MCP] Extension connected and profile-verified via HTTP polling");
      }
      _extensionLastPollTime = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "verified" }));
      return;
    }

    // POST /verify-profile — extension asks server to check which profile has a nonce tab
    if (req.method === "POST" && req.url === "/verify-profile") {
      const workerId = _httpWorkerId(req);
      if (!workerId || !_connectingHttpWorker(workerId)) {
        res.writeHead(401);
        res.end("Worker must connect before profile verification");
        return;
      }
      let body = "";
      let bodyTooLarge = false; // 'end' can still fire after destroy() — never parse/respond then
      req.on("data", (chunk) => { if (bodyTooLarge || res.headersSent) return; body += chunk; if (body.length > MAX_BODY_SIZE) { bodyTooLarge = true; res.writeHead(413); res.end("Payload too large"); req.destroy(); } });
      req.on("end", async () => {
        if (bodyTooLarge) return;
        try {
          const { nonce, expectedProfile } = JSON.parse(body);
          // Use AppleScript to find which window contains the nonce in a tab title
          const safeNonce = String(nonce).replace(/[^0-9]/g, '');  // nonce is numeric only
          const safeProfile = (expectedProfile || "").replace(/[^\p{L}\p{N}\s\-_]/gu, '');  // whitelist: letters, numbers, spaces, hyphens, underscores
          // Check via AppleScript — look for the nonce in the profile window
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify: pfy } = await import("node:util");
          const execFileAsync = pfy(execFileCb);
          // Don't launch Safari if it's not running
          try {
            await execFileAsync("pgrep", ["-x", "Safari"], { timeout: 1000 });
          } catch {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ match: false, error: "Safari is not running" }));
            return;
          }
          const script = `tell application "Safari"
            repeat with w in every window
              repeat with t in every tab of w
                if name of t contains "${safeNonce}" then
                  if name of w starts with "${safeProfile} —" then
                    return "match"
                  else
                    return "wrong:" & name of w
                  end if
                end if
              end repeat
            end repeat
            return "notfound"
          end tell`;
          // Must finish well inside the extension's 5s fetch timeout: if the extension aborts
          // first it never caches the verdict, so it re-probes every few seconds — and each probe
          // opens a *new window* in any profile that has none (the personal profile popping up).
          // 1s pgrep + 2.5s osascript = 3.5s worst case, and the catch below still answers 200.
          const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 2500 });
          const out = stdout.trim();
          if (out === "match") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ match: true }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ match: false, actualProfile: out }));
          }
        } catch (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ match: false, error: err.message }));
        }
      });
      return;
    }

    // GET /proxy-check — secondary instances check if extension is connected
    if (req.method === "GET" && req.url.startsWith("/proxy-check")) {
      const requestUrl = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
      const requestedProfile = requestUrl.searchParams.get("profile") || "";
      const hostProfile = process.env.SAFARI_PROFILE || "";
      const profileMatch = requestedProfile === hostProfile;
      const extensionUsable = _extensionConnected && profileMatch && (!_preferAppleScript || _profileExtensionVerified);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ extensionConnected: extensionUsable, profileMatch }));
      return;
    }

    // POST /proxy-command — secondary instances send commands through primary
    if (req.method === "POST" && req.url === "/proxy-command") {
      // Security: require the local shared-secret — blocks unrelated local processes
      if (!_tokenMatches(req.headers["x-local-token"])) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden: invalid local token" }));
        return;
      }
      let body = "";
      let bodyTooLarge = false; // 'end' can still fire after destroy() — never parse/respond then
      req.on("data", (chunk) => { if (bodyTooLarge || res.headersSent) return; body += chunk; if (body.length > MAX_BODY_SIZE) { bodyTooLarge = true; res.writeHead(413); res.end("Payload too large"); req.destroy(); } });
      req.on("end", async () => {
        if (bodyTooLarge) return;
        try {
          const { type, payload, profile = "" } = JSON.parse(body);
          const hostProfile = process.env.SAFARI_PROFILE || "";
          if (profile !== hostProfile) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Refusing proxy command: verified Safari profile does not match" }));
            return;
          }
          // A secondary MCP process proxies extension commands directly and does
          // not execute this host's safari_new_tab tool body. Give a suspended
          // profile worker time to wake before the verification gate; the worker
          // itself will create a background profile window if none exists.
          if (type === "new_tab") await _waitForVerifiedProfileExtension(30000);
          if (_preferAppleScript && !_profileExtensionVerified) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Refusing proxy command: verified Safari profile does not match" }));
            return;
          }
          const timeout = _commandTimeouts[type] || 30000;
          const reloadHandoff = type === "reload_extension"
            ? _prepareReloadHttpWorkerHandoff()
            : null;
          const commandPayload = reloadHandoff
            ? { ...payload, reloadHandoff: reloadHandoff.token }
            : payload;
          let result;
          try {
            result = await sendToExtension(type, commandPayload, timeout);
          } catch (error) {
            if (reloadHandoff) _cancelReloadHttpWorkerHandoff(reloadHandoff);
            throw error;
          }
          if (type === "reload_extension") {
            // The worker answers before scheduling runtime.reload(). Capture the
            // baseline only now: a suspended OLD worker may have reconnected merely
            // to receive this command, and that wake must not satisfy the barrier.
            const reloadGeneration = _extensionConnectionGeneration;
            const reconnected = await _waitForExtensionGeneration(reloadGeneration, 30000);
            if (!reconnected) throw new Error("Extension reload did not produce a verified reconnect within 30000ms");
            if (result && typeof result === "object") result = { ...result, reconnected: true };
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    _isExtensionHost = true;
    console.error(`[Safari MCP] HTTP server listening on port ${HTTP_PORT} (extension host)`);
  });
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[Safari MCP] HTTP port ${HTTP_PORT} in use — will proxy commands to primary instance`);
      _isExtensionHost = false;
      // Check if primary instance has extension connected
      _checkPrimaryExtension();
    }
  });
} catch {}

// ========== PROXY MODE ==========
// When another MCP instance already owns the port, we proxy commands through it
let _isExtensionHost = false;
let _primaryHasExtension = false;

// Delayed check: if after 2 seconds we're not the host, try proxy mode
setTimeout(() => {
  if (!_isExtensionHost && !_primaryHasExtension) {
    console.error("[Safari MCP] Not extension host after startup — checking for primary instance");
    _checkPrimaryExtension();
  }
}, 2000);

async function _checkPrimaryExtension() {
  if (_isExtensionHost) return; // Already hosting — stop polling
  try {
    const profile = encodeURIComponent(process.env.SAFARI_PROFILE || "");
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/proxy-check?profile=${profile}`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      _primaryHasExtension = data.extensionConnected;
      if (_primaryHasExtension) {
        _extensionConnected = true; // Enable extension path in extensionOrFallback
        _profileExtensionVerified = true;
        console.error(`[Safari MCP] Primary instance has extension — proxy mode enabled`);
      } else {
        _extensionConnected = false;
        if (process.env.SAFARI_PROFILE) _profileExtensionVerified = false;
      }
    }
  } catch {
    _primaryHasExtension = false;
  }
  // Re-check every 10s (unref'd — must not keep the Node process alive on its own)
  setTimeout(_checkPrimaryExtension, 10000).unref();
}

// Send command to primary instance's extension via proxy
async function _proxyToExtension(type, payload, timeoutMs = 30000) {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/proxy-command`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-local-token": PROXY_TOKEN },
    body: JSON.stringify({ type, payload, profile: process.env.SAFARI_PROFILE || "" }),
    // new_tab may first wait for a suspended profile worker to reconnect on the
    // host, so its proxy envelope must outlive the command timeout itself.
    // The host also re-arms a command's deadline on every extension heartbeat, up to
    // the same ceiling sendToExtension uses. Without matching that here, a secondary
    // instance abandoned a heavy-DOM command at ~35s while the host was still happily
    // waiting for it — the exact failure this envelope is supposed to prevent.
    signal: AbortSignal.timeout(
      Math.max(timeoutMs * 4, 180000) + (type === "new_tab" ? 35000 : 5000)
    ),
  });
  if (!res.ok) throw new Error(`Proxy error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// Beats while the extension is busy executing a command, so a long command does not
// look like a dead worker. See POST /heartbeat.
// Detect stale HTTP connection (no poll in 30s = disconnected)
// Only applies to primary instance (extension host) — not proxy mode
const _staleHttpTimer = setInterval(() => {
  if (_isExtensionHost && _extensionConnected && !_extensionWs && _extensionLastPollTime > 0) {
    if (Date.now() - _extensionLastPollTime > _HTTP_WORKER_DISCONNECT_MS) {
      // A command already delivered to this worker is an at-most-once fence.
      // Its own bounded request timer releases the fence; disconnect cleanup must
      // not make an ordinary successor eligible while the old worker may finish it.
      if (_activeHttpWorkerHasDispatchedRequest()) return;
      // The extension runs each command inside its own poll loop, so a command that
      // outlives 30s (heavy DOM: facebook.com, business.facebook.com) starves /poll
      // even though the worker is alive and still working on OUR command. Killing the
      // connection here also drained the very request it was executing. Trust the
      // per-command heartbeat instead, and only declare death when nothing is in flight.
      if (_pendingRequests.size > 0 && Date.now() - _extensionLastHeartbeat < 30000) return;
      // A reload result must arm the exact object captured by its pending request.
      // Let that request's own bounded timer cancel the prepared handoff; clearing it
      // here creates an identity race when /result lands on the same timer tick.
      if (_reloadHttpWorkerHandoff && [..._pendingRequests.values()].some(
        (pending) => pending.reloadHandoff === _reloadHttpWorkerHandoff
      )) return;
      _extensionConnected = false;
      _activeHttpWorkerId = "";
      _connectingHttpWorkers.clear();
      _reloadHttpWorkerHandoff = null;
      _drainOnDisconnect("HTTP poll timeout");
      console.error("[Safari MCP] Extension disconnected (HTTP poll timeout)");
    }
  }
}, 5000);
_staleHttpTimer.unref();  // stale-detection must not keep the Node process alive on its own

// ========== SHARED EXTENSION LOGIC ==========

// Drain pending requests and command queue on disconnect — allows fast fallback to AppleScript
function _drainOnDisconnect(reason) {
  if (process.env.SAFARI_PROFILE) _profileExtensionVerified = false;
  // Reject all in-flight requests immediately (instead of waiting for timeout)
  for (const [id, pending] of _pendingRequests) {
    clearTimeout(pending.timer);
    if (pending.reloadHandoff) _cancelReloadHttpWorkerHandoff(pending.reloadHandoff);
    pending.reject(new Error(`Extension disconnected: ${reason}`));
  }
  _pendingRequests.clear();
  // Clear queued commands that will never be picked up
  _commandQueue.length = 0;
}

function _handleExtensionResponse(msg, respondingWorkerId = "") {
  if (msg.type === "keepalive") return true;
  if (msg.type === "connected") {
    if (!_extensionConnected) {
      _extensionConnected = true;
      console.error("[Safari MCP] Extension connected");
    }
    return true;
  }
  if (msg.type !== "response" || !msg.id) return false;
  const pending = _pendingRequests.get(msg.id);
  if (!pending) return false;
  if ((pending.dispatchedWorkerId || "") !== respondingWorkerId) return false;
  clearTimeout(pending.timer);
  _pendingRequests.delete(msg.id);
  if (msg.error) {
    if (pending.reloadHandoff) _cancelReloadHttpWorkerHandoff(pending.reloadHandoff);
    pending.reject(new Error(msg.error));
    return true;
  }
  // Arm the successor lease synchronously while handling /result. The HTTP ACK is
  // sent only after this returns true, so the old worker cannot reload before the
  // host is ready to accept the exact replacement token.
  if (pending.reloadHandoff && !_armReloadHttpWorkerHandoff(pending.reloadHandoff)) {
    _cancelReloadHttpWorkerHandoff(pending.reloadHandoff);
    pending.reject(new Error("Extension reload handoff could not be armed"));
    return false;
  }
  pending.resolve(msg.result);
  return true;
}

// Send command to extension (via WebSocket, HTTP command queue, or proxy to primary)
function sendToExtension(type, payload = {}, timeoutMs = 30000) {
  // If we're a secondary instance, proxy through primary
  if (!_isExtensionHost && _primaryHasExtension) {
    return _proxyToExtension(type, payload, timeoutMs);
  }

  return new Promise((resolve, reject) => {
    if (!_extensionConnected) {
      reject(new Error("Extension not connected"));
      return;
    }
    const reloadHandoff = type === "reload_extension" &&
      _reloadHttpWorkerHandoff?.token === payload.reloadHandoff
      ? _reloadHttpWorkerHandoff
      : null;
    if (type === "reload_extension" && !reloadHandoff) {
      reject(new Error("Extension reload handoff is unavailable"));
      return;
    }
    const id = randomUUID();
    // A heavy DOM (facebook.com, business.facebook.com) can take well past 30s for a
    // single read_page/snapshot. Rather than raise every timeout — which would make a
    // genuinely stuck worker hang for just as long — let the extension's mid-command
    // heartbeat re-arm this deadline. No heartbeat, no extension: it still fails fast.
    // hardDeadline is the ceiling, so a worker that beats forever cannot hang us.
    const hardDeadline = Date.now() + Math.max(timeoutMs * 4, 180000);
    const expire = () => {
      _pendingRequests.delete(id);
      if (reloadHandoff) _cancelReloadHttpWorkerHandoff(reloadHandoff);
      // Also drop it from the HTTP poll queue — otherwise the extension could poll this command
      // long after the caller gave up and run a stale navigate/click out of band.
      const qi = _commandQueue.findIndex(c => c.id === id);
      if (qi >= 0) _commandQueue.splice(qi, 1);
      reject(new Error(`Extension timeout after ${timeoutMs}ms`));
    };
    const armTimer = () => setTimeout(expire, Math.min(timeoutMs, Math.max(0, hardDeadline - Date.now())));
    _pendingRequests.set(id, {
      resolve,
      reject,
      timer: armTimer(),
      armTimer,
      hardDeadline,
      reloadHandoff,
      dispatchedWorkerId: "",
    });

    const command = { id, type, payload };

    // If WebSocket is connected, use it (faster)
    if (_extensionWs) {
      _extensionWs.send(JSON.stringify(command));
    } else {
      // Otherwise, queue for HTTP polling
      _commandQueue.push(command);
      _releaseContentWakePolls();
    }
  });
}

// Per-command timeouts — fast commands get short timeouts, nav/screenshot get longer ones
const _commandTimeouts = {
  // Safari can suspend a profile extension worker for 20–25 seconds even while
  // its window remains open. Short deadlines caused a queued mutating command to
  // be abandoned and then retried through AppleScript, which is both unreliable
  // and unsafe for clicks/typing. Keep every profile command above that wake-up
  // window; fast workers still return immediately.
  click: 30000, click_open_popup: 30000, fill: 30000, read_page: 30000, get_source: 30000, evaluate: 30000,
  type_text: 30000, press_key: 30000, scroll: 30000, scroll_to: 30000, scroll_to_element: 30000,
  hover: 30000, list_tabs: 30000, new_tab: 30000, close_tab: 30000, switch_tab: 30000,
  wait_for: 30000, navigate: 45000, navigate_and_read: 45000, go_back: 30000, go_forward: 30000,
  reload: 30000, screenshot: 30000, snapshot: 30000, click_and_read: 30000,
  double_click: 30000, right_click: 30000, clear_field: 30000, select_option: 30000, fill_form: 30000,
  replace_editor: 30000, get_url: 30000, get_title: 30000,
};

// Commands where null result means failure (should fall back to AppleScript)
const _nullMeansFailure = new Set([
  "click", "double_click", "right_click", "fill",
  "press_key", "hover", "clear_field", "select_option", "fill_form",
  // NOTE: "type_text" intentionally NOT here — execCommand always returns a string,
  // and double execution would duplicate text in contenteditable editors.
  "read_page", "get_source", "snapshot", "get_element", "query_all",
  "scroll", "scroll_to",
  // NOTE: "evaluate" intentionally NOT here — null is a valid return value.
  // CSP fallback is handled separately via isCspError check.
]);

// Operations that don't need tab ownership (read-only or tab management)
const _noOwnershipCheck = new Set([
  // Tab management. NOTE: "close_tab" is deliberately NOT here. It sat in this set as
  // "tab management" next to new_tab/list_tabs/switch_tab, but it is the only member that
  // destroys a user tab: new_tab creates one, list_tabs reads, and switch_tab carries its
  // own ownership check at the tool. close_tab had none — exempt from the shared guard and
  // unguarded underneath, which is how it closed a user's tab in #68.
  "new_tab", "list_tabs", "switch_tab",
  // Extension self-management (doesn't touch tabs)
  "reload_extension",
  // Read-only — don't modify the page
  "read_page", "get_source", "snapshot", "accessibility_snapshot",
  "get_element", "query_all", "screenshot", "screenshot_element",
  "get_console", "list_console_messages", "start_console",
  "get_network", "list_network_requests", "start_network_capture",
  "network", "network_details", "console_filter",
  "performance_metrics", "css_coverage", "get_computed_style",
  "extract_images", "extract_links", "extract_meta", "extract_tables",
  "get_cookies", "local_storage", "session_storage",
  "get_indexed_db", "list_indexed_dbs", "detect_forms",
  "save_pdf", "analyze_page",
]);

// run_script action names (camelCase) that don't require an owned tab — strictly
// read-only steps, plus newTab/switchTab/listTabs which mirror _noOwnershipCheck.
// Everything that can change page or tab state (navigate, evaluate, reload, goBack,
// closeTab, ...) is asserted PER STEP while the batch runs (see the run_script
// handler): a batch can change the active tab mid-run, so a single pre-flight
// check is not enough. "evaluate" in particular was exempt here while the
// standalone safari_evaluate tool was guarded — an inconsistency that allowed
// arbitrary JS in an unowned tab via batching.
const _RUNSCRIPT_OWNERSHIP_EXEMPT = new Set([
  "newTab", "switchTab", "listTabs",
  "readPage", "getPageSource", "screenshot", "screenshotElement",
  "waitFor", "waitForTime", "getElementInfo", "querySelectorAll",
  "extractTables", "extractMeta", "extractImages", "extractLinks",
  "analyzePage", "detectForms", "getAccessibilityTree", "getPerformanceMetrics",
  "getLocalStorage", "getSessionStorage", "getCookies",
]);

// Origin of a URL, or "" when it has none (about:blank, "missing value", junk).
// An empty result must never compare equal to another empty result at a call site.
function _originOf(url) {
  try { return new URL(String(url || "")).origin; } catch { return ""; }
}

function _safeUrlForOutput(rawUrl) {
  const raw = String(rawUrl || "");
  if (!raw) return "unknown";
  if (raw === "about:blank" || raw === "missing value") return raw;
  try {
    const parsed = new URL(raw);
    if (/^https?:$/.test(parsed.protocol)) return parsed.origin + parsed.pathname;
    return parsed.protocol ? parsed.protocol.replace(/:$/, "") + ":" : "unknown";
  } catch {
    return "unknown";
  }
}

function _receiptToken(value) {
  const raw = String(value || "");
  if (/^[A-Za-z0-9_-]{24,}$/.test(raw)) return raw;
  const legacy = raw.match(/(?:[?#&])mcp-tab=([A-Za-z0-9_-]{24,})(?:[&#]|$)/);
  return legacy ? legacy[1] : "";
}

const _activeReceipts = new Map();
function _receiptSessionKey() {
  return `${SESSION_ID}:${currentSessionId()}`;
}
function _getActiveReceipt() {
  return _activeReceipts.get(_receiptSessionKey()) || "";
}
function _setActiveReceipt(receipt) {
  const token = _receiptToken(receipt);
  const key = _receiptSessionKey();
  if (token) _activeReceipts.set(key, token);
  else _activeReceipts.delete(key);
}

function _sanitizeTabResult(value) {
  let normalized = value;
  if (typeof normalized === "string") {
    try { normalized = JSON.parse(normalized); } catch { return normalized; }
  }
  if (Array.isArray(normalized)) return normalized.map(_sanitizeTabResult);
  if (!normalized || typeof normalized !== "object") return normalized;
  const safeUrl = _safeUrlForOutput(normalized.safeUrl || normalized.url || normalized.requestedUrl || "");
  const receipt = _receiptToken(normalized.receipt || normalized.receiptUrl || "");
  return {
    ...(normalized.index !== undefined ? { index: normalized.index } : {}),
    ...(normalized.tabIndex !== undefined ? { tabIndex: normalized.tabIndex } : {}),
    ...(normalized.title !== undefined ? { title: normalized.title } : {}),
    ...(safeUrl !== "unknown" ? { safeUrl } : {}),
    ...(receipt ? { receipt } : {}),
    ...(normalized.active !== undefined ? { active: !!normalized.active } : {}),
    ...(normalized.owned !== undefined ? { owned: !!normalized.owned } : {}),
    ...(normalized.clicked !== undefined ? { clicked: !!normalized.clicked } : {}),
    ...(normalized.popupOpened !== undefined ? { popupOpened: !!normalized.popupOpened } : {}),
  };
}

function _isBatchSemanticFailure(result) {
  if (Array.isArray(result)) return result.some(_isBatchSemanticFailure);
  if (result && typeof result === "object") return result.ok === false;
  if (typeof result !== "string") return false;
  return /(?:^|\n)\s*(?:Element not found|Not found|Tab not found|TIMEOUT|No click target|Typed 0 chars)\b/i.test(result) ||
    /(?:^|\n)\s*Selected:\s*(?:\(index -1\))?\s*$/im.test(result);
}

async function _runExtensionBatchAction(action, args = {}) {
  const mySession = `${SESSION_ID}:${currentSessionId()}`;
  const normalize = (value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  const syncResultUrl = (value, fallbackUrl = "") => {
    const normalized = normalize(value);
    const landedUrl = normalized && typeof normalized === "object" && normalized.url
      ? normalized.url
      : fallbackUrl;
    if (landedUrl) {
      safari.setActiveTabURL(landedUrl);
      _addOwnedURL(landedUrl);
    }
    return normalized;
  };

  switch (action) {
    case "newTab": {
      const requestedUrl = String(args.url || "");
      const raw = await extensionOrFallback(
        "new_tab", { url: requestedUrl },
        () => safari.newTab(requestedUrl)
      );
      const value = _sanitizeTabResult(normalize(raw));
      if (value && typeof value === "object" && value.tabIndex) {
        safari.setActiveTabIndex(value.tabIndex);
        _trackTab(value.tabIndex, requestedUrl, mySession);
      }
      const trackUrl = requestedUrl || "about:blank";
      if (trackUrl) {
        safari.setActiveTabURL(trackUrl);
        _addOwnedURL(trackUrl);
      } else {
        _markBlankTabOpened();
      }
      if (value?.receipt) _setActiveReceipt(value.receipt);
      return value;
    }

    case "switchTab": {
      const index = args.index === undefined ? undefined : Number(args.index);
      const receipt = _receiptToken(args.receipt || args.receiptUrl || args.url || "");
      if ((args.receipt || args.receiptUrl || args.url) && !receipt) {
        throw new Error("Tab safety: switchTab requires an extension-issued receipt");
      }
      if (!receipt && (!Number.isInteger(index) || index < 1)) {
        throw new Error("switchTab requires a positive index or an extension-issued receipt");
      }
      if (index !== undefined && (!Number.isInteger(index) || index < 1)) {
        throw new Error("switchTab index must be a positive integer when provided");
      }
      const raw = await extensionOrFallback(
        "switch_tab",
        receipt ? { ...(index ? { index } : {}), receipt } : { index },
        () => safari.switchTab(index)
      );
      const value = _sanitizeTabResult(raw);
      const resolvedIndex = value?.tabIndex || index;
      if (resolvedIndex) safari.setActiveTabIndex(resolvedIndex);
      if (value?.receipt || receipt) _setActiveReceipt(value?.receipt || receipt);
      return value;
    }

    case "listTabs":
      return _sanitizeTabResult(await extensionOrFallback("list_tabs", {}, () => safari.listTabs()));

    case "getReceipt": {
      const value = normalize(await extensionOrFallback(
        "get_tab_receipt", {
          ...(_receiptToken(args.receipt || "") ? { receipt: _receiptToken(args.receipt) } : {}),
        },
        () => { throw new Error("getReceipt requires the verified Safari extension"); }
      ));
      const safeValue = _sanitizeTabResult(value);
      if (safeValue?.index) safari.setActiveTabIndex(safeValue.index);
      if (safeValue?.receipt) _setActiveReceipt(safeValue.receipt);
      return safeValue;
    }

    case "closeTab": {
      const index = args.index === undefined ? undefined : Number(args.index);
      const receipt = _receiptToken(args.receipt || args.receiptUrl || args.url || "") || _getActiveReceipt();
      const raw = await extensionOrFallback(
        "close_tab", { ...(index ? { index } : {}), ...(receipt ? { receipt } : {}) },
        () => safari.closeTab(index)
      );
      const activeIndex = safari.getActiveTabIndex();
      if (activeIndex !== null) _untrackTab(activeIndex);
      safari.setActiveTabIndex(null);
      safari.setActiveTabURL(null);
      _setActiveReceipt("");
      return normalize(raw);
    }

    case "navigate": {
      const url = String(args.url || "");
      if (!url) throw new Error("navigate requires url");
      _addOwnedURL(url);
      const raw = await extensionOrFallback(
        "navigate", { url, timeout: args.timeout },
        () => safari.navigate(url)
      );
      return syncResultUrl(raw, url);
    }

    case "navigateAndRead": {
      const url = String(args.url || "");
      if (!url) throw new Error("navigateAndRead requires url");
      _addOwnedURL(url);
      const raw = await extensionOrFallback(
        "navigate_and_read", { url, maxLength: args.maxLength, timeout: args.timeout },
        async () => { await safari.navigate(url); return safari.readPage({ maxLength: args.maxLength }); }
      );
      safari.setActiveTabURL(url);
      return normalize(raw);
    }

    case "readPage":
      return normalize(await extensionOrFallback(
        "read_page", { selector: args.selector, maxLength: args.maxLength },
        () => safari.readPage(args)
      ));

    case "snapshot": {
      const gen = safari.getNextSnapshotGen();
      return await extensionOrFallback(
        "snapshot", { selector: args.selector, gen },
        () => safari.takeSnapshot({ selector: args.selector, _gen: gen })
      );
    }

    case "getElementInfo":
      return normalize(await extensionOrFallback(
        "get_element", { selector: args.selector },
        () => safari.getElementInfo(args)
      ));

    case "querySelectorAll":
      return normalize(await extensionOrFallback(
        "query_all", { selector: args.selector, limit: args.limit },
        () => safari.querySelectorAll(args)
      ));

    case "waitFor":
      return await extensionOrFallback(
        "wait_for", { selector: args.selector, text: args.text, timeout: args.timeout },
        () => safari.waitFor(args)
      );

    case "waitForTime": {
      const ms = Math.max(0, Math.min(Number(args.ms) || 0, 30000));
      await new Promise((resolve) => setTimeout(resolve, ms));
      return `Waited ${ms}ms`;
    }

    case "click":
      return await extensionOrFallback(
        "click", { ref: args.ref, selector: args.selector, text: args.text, x: args.x, y: args.y },
        () => safari.click(args)
      );

    case "clickAndOpenPopup": {
      const selector = typeof args.selector === "string" && args.selector ? args.selector : "";
      const ref = typeof args.ref === "string" && args.ref ? args.ref : "";
      if ((selector ? 1 : 0) + (ref ? 1 : 0) !== 1) {
        throw new Error("clickAndOpenPopup requires exactly one of selector or ref");
      }
      const raw = await extensionOrFallback(
        "click_open_popup", { ...(selector ? { selector } : { ref }) },
        () => { throw new Error("clickAndOpenPopup requires a verified Safari profile extension"); }
      );
      return _sanitizeTabResult(normalize(raw));
    }

    case "fill":
      return await extensionOrFallback(
        "fill", { selector: args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector, value: args.value },
        () => safari.fill(args)
      );

    case "fillForm":
      return await extensionOrFallback(
        "fill_form", { fields: args.fields },
        () => safari.fillForm(args)
      );

    case "clearField":
      return await extensionOrFallback(
        "clear_field", { selector: args.selector },
        () => safari.clearField(args)
      );

    case "typeText":
      return await extensionOrFallback(
        "type_text", { text: args.text, selector: args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector },
        () => safari.typeText(args)
      );

    case "selectOption":
      return await extensionOrFallback(
        "select_option", { selector: args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector, value: args.value },
        () => safari.selectOption(args)
      );

    case "pressKey":
      return await extensionOrFallback(
        "press_key", { key: args.key, modifiers: args.modifiers },
        () => safari.pressKey(args)
      );

    case "scroll":
      return await extensionOrFallback(
        "scroll", { direction: args.direction, amount: args.amount },
        () => safari.scroll(args)
      );

    case "scrollTo":
      return await extensionOrFallback(
        "scroll_to", { x: args.x, y: args.y },
        () => safari.scrollTo(args)
      );

    case "scrollToElement":
      return await extensionOrFallback(
        "scroll_to_element", { selector: args.selector, text: args.text, block: args.block, timeout: args.timeout },
        () => safari.scrollToElement(args)
      );

    case "hover":
      return await extensionOrFallback(
        "hover", { selector: args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector },
        () => safari.hover(args)
      );

    case "evaluate":
      return normalize(await extensionOrFallback(
        "evaluate", { script: args.script },
        () => safari.evaluate(args)
      ));

    case "reload":
      return syncResultUrl(await extensionOrFallback(
        "reload", { hard: args.hard },
        () => safari.reload(args.hard)
      ));

    case "goBack":
      return syncResultUrl(await extensionOrFallback("go_back", {}, () => safari.goBack()));

    case "goForward":
      return syncResultUrl(await extensionOrFallback("go_forward", {}, () => safari.goForward()));

    default:
      throw new Error(`Unsupported extension batch action: ${action}`);
  }
}

// Tab-ownership assertion — shared by extensionOrFallback AND the tools that bypass it
// (safari_run_script, native_*). Throws if the operation would land on a tab this MCP
// session didn't open. Read-only / tab-management ops (in _noOwnershipCheck) are exempt.
// Once any tab has been opened via new_tab, ALL subsequent page-mutating ops must target
// an owned tab — this is what prevents navigating/clicking in the user's tabs.
function _assertTabOwnership(opType, extensionPayload = {}) {
  if (_noOwnershipCheck.has(opType)) return;
  // In a named profile the extension is the authority. A bearer receipt may be
  // presented after a stateless reconnect; only the extension can validate its exact
  // tab binding, freshness, digest, and origin.
  if (_preferAppleScript && _receiptToken(extensionPayload.receipt || _getActiveReceipt())) return;
  const currentUrl = safari.getActiveTabURL();
  if (_ownedTabURLs.size === 0 && _openedTabs.size === 0) {
    // No tabs opened yet — block everything except read-only ops
    const msg = `⚠️ Tab safety: no tabs opened yet. Call safari_new_tab first before "${opType}".`;
    console.error(`[Safari MCP] ${msg}`);
    throw new Error(msg);
  }
  if (currentUrl && !_isURLOwned(currentUrl)) {
    // about:blank tabs are owned if we have any tracked tabs (new_tab creates them at about:blank)
    const isBlankOwned = (currentUrl === 'about:blank' || currentUrl === 'missing value') && (_openedTabs.size > 0 || _ownedTabURLs.has(BLANK_TAB_SENTINEL));
    if (!isBlankOwned) {
      const msg = `⚠️ Tab safety: refusing "${opType}" — current tab (${_safeUrlForOutput(currentUrl)}) was not opened by this MCP session. Use safari_new_tab or safari_switch_tab to target your own tab.`;
      console.error(`[Safari MCP] ${msg}`);
      throw new Error(msg);
    }
  }
}

// Try the profile-verified extension first. Named profiles are extension-only:
// crossing to AppleScript would lose the extension's profile and tab-id proof.
async function extensionOrFallback(extensionType, extensionPayload, fallbackFn) {
  // Tab-ownership guard — extracted to _assertTabOwnership so run_script / native_* share it.
  _assertTabOwnership(extensionType, extensionPayload);

  // Safari may terminate an otherwise healthy profile worker between two tool
  // calls. If no command has been sent yet, waiting for its verified reconnect is
  // safe even for non-idempotent actions (click/fill): there is nothing to repeat.
  if (_preferAppleScript && (!_extensionConnected || !_profileExtensionVerified)) {
    await _waitForVerifiedProfileExtension(30000);
  }

  // ========== FOCUS PRESERVATION ==========
  // Safari AppleScript/extension can steal focus (bring Safari window to front).
  // Save the frontmost app before the operation and restore it after if Safari stole focus.
  // Set focusGuard flag so inner osascript/runJSLarge calls skip their own focus logic.
  const savedApp = _preferAppleScript ? null : await safari.saveFrontmostApp();
  safari.setFocusGuard(true);

  let result;
  let usedExtension = false;
  try {
    if (_extensionConnected && (!_preferAppleScript || _profileExtensionVerified)) {
      try {
        const t0 = Date.now();
        const activeReceipt = _getActiveReceipt();
        // Composite id: SESSION_ID alone is process-wide, so in HTTP-daemon mode every
        // MCP client looked like ONE extension session and could target another client's
        // cached tab (#76). currentSessionId() alone would collapse all stdio processes
        // into "_default" — so both parts are needed.
        // A receipt is an opaque capability, not a URL. Keep it out of page state and
        // attach it automatically only to commands that target the current logical tab.
        const attachActiveReceipt = !["new_tab", "list_tabs", "switch_tab", "reload_extension"].includes(extensionType);
        const reloadHandoff = extensionType === "reload_extension" && _isExtensionHost
          ? _prepareReloadHttpWorkerHandoff()
          : null;
        const payload = {
          ...(attachActiveReceipt && activeReceipt ? { receipt: activeReceipt } : {}),
          ...extensionPayload,
          ...(reloadHandoff ? { reloadHandoff: reloadHandoff.token } : {}),
          sessionId: `${SESSION_ID}:${currentSessionId()}`,
        };
        const timeout = _commandTimeouts[extensionType] || 30000;
        try {
          result = await sendToExtension(extensionType, payload, timeout);
        } catch (error) {
          if (reloadHandoff) _cancelReloadHttpWorkerHandoff(reloadHandoff);
          throw error;
        }
        const isCspError = typeof result === 'string' && (result.includes('unsafe-eval') || result.includes('trusted-types') || result.includes('Trusted Type') || result.includes('Content Security Policy'));
        const isPermissionDenied = typeof result === 'string' && result.includes('__SCREENSHOT_PERMISSION_DENIED__');
        const isElementMiss = typeof result === 'string' && result.startsWith('Element not found');
        const isFailed = result === null || isElementMiss;
        if (isPermissionDenied) {
          console.error(`[Safari MCP] ${extensionType} permission denied (${Date.now() - t0}ms) — falling back to AppleScript`);
        } else if (isCspError) {
          console.error(`[Safari MCP] ${extensionType} CSP blocked: ${result?.substring(0, 100)} (${Date.now() - t0}ms) — falling back to AppleScript`);
        } else if (isFailed && _nullMeansFailure.has(extensionType)) {
          if (_preferAppleScript && isElementMiss) {
            // In a profile-scoped session AppleScript is intentionally forbidden.  An
            // exhaustive DOM lookup returning no element is a semantic miss from a
            // healthy extension, not evidence that its backend disconnected. Preserve
            // the exact result so callers can correct their selector instead of seeing
            // the misleading generic "profile extension unavailable" error.
            console.error(`[Safari MCP] ${extensionType} semantic miss via extension: ${result} (${Date.now() - t0}ms)`);
            usedExtension = true;
          } else {
            console.error(`[Safari MCP] ${extensionType} extension failed: ${result} (${Date.now() - t0}ms) — falling back to AppleScript`);
          }
        } else {
          console.error(`[Safari MCP] ${extensionType} via extension (${Date.now() - t0}ms)`);
          usedExtension = true;
        }
      } catch (err) {
        // A profile extension ownership refusal is a security boundary, not a
        // transient backend failure. Falling back to AppleScript here would bypass
        // the extension's tab-id proof and could switch to or mutate a user's tab.
        if (String(err?.message || err).includes("Tab safety:")) throw err;
        if (_preferAppleScript) throw new Error(`Safari profile extension unavailable for "${extensionType}": ${err.message}`);
        console.error(`[Safari MCP] ${extensionType} extension failed: ${err.message} — falling back to AppleScript`);
      }
    }
    if (!usedExtension) {
      if (_preferAppleScript) {
        throw new Error(`Safari profile extension unavailable for "${extensionType}"; refusing AppleScript fallback`);
      }
      const t0 = Date.now();
      result = await fallbackFn();
      console.error(`[Safari MCP] ${extensionType} via AppleScript (${Date.now() - t0}ms)`);
    }
  } finally {
    safari.setFocusGuard(false);
    // Restore focus in finally — even when the operation threw, Safari may have come to
    // the front mid-op and must be sent back, or the user is left staring at the
    // automation window with their keystrokes landing in it.
    //
    // ...BUT only for AppleScript ops. AppleScript raises Safari to the front itself,
    // so a restore correctly returns focus to wherever the user was. Extension ops run
    // as background JS injection and NEVER raise Safari — so if Safari is frontmost
    // after an extension op, it's because the USER switched into it mid-op. Restoring
    // then yanks Safari out from under them (the "VS Code jumps in front while I work
    // in Safari" bug), and the HID-idle guard can't catch it because a user who is
    // reading (not typing) looks idle. So skip restore entirely for extension ops.
    if (!usedExtension && savedApp) await safari.restoreFocusIfStolen(savedApp);
  }

  return result;
}

// Read version from package.json to avoid hardcoded mismatch
const _pkgVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version;
// Factory so each MCP session (in HTTP mode) gets its own McpServer — McpServer is single-connection.
// stdio mode calls this exactly once, identical to the historical inline server. Tool bodies are
// unchanged; they close over the module-global safari state, which stays shared across sessions
// (correct: one physical Safari window). See docs/http-transport-design.md.
function buildServer() {
const server = new McpServer({
  name: "safari-mcp",
  version: _pkgVersion,
  description: "Safari browser automation - lightweight, keeps logins",
});

// ========== NAVIGATION ==========

server.tool(
  "safari_navigate",
  "Navigate to a URL in Safari. Waits for page to fully load.",
  { url: z.string().describe("URL to navigate to") },
  async ({ url }) => {
    const oldUrl = safari.getActiveTabURL();
    // Pre-register the destination as owned BEFORE navigating. We are navigating OUR
    // tab, so the target URL is ours even if navigate() throws mid-load on a slow SPA.
    // Without this, a slow/failed navigate left the new URL unowned and locked the
    // switch_tab recovery out — the very recovery the lock error tells you to use.
    _addOwnedURL(url);
    const result = await extensionOrFallback(
      "navigate", { url },
      () => safari.navigate(url)
    );
    // Tab kept its identity, just changed URL — drop the stale old URL from ownership.
    if (oldUrl && oldUrl !== url && oldUrl !== 'about:blank') _removeOwnedURL(oldUrl);
    return textResult(result);
  }
);

server.tool(
  "safari_go_back",
  "Go back in browser history",
  {},
  async () => {
    const result = await extensionOrFallback("go_back", {}, () => safari.goBack());
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_go_forward",
  "Go forward in browser history",
  {},
  async () => {
    const result = await extensionOrFallback("go_forward", {}, () => safari.goForward());
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_reload",
  "Reload the current page",
  { hard: z.boolean().optional().describe("Hard reload (bypass cache)") },
  async ({ hard }) => {
    const result = await extensionOrFallback("reload", { hard }, () => safari.reload(hard));
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

// ========== PAGE INFO ==========

server.tool(
  "safari_read_page",
  "Read page text content (title, URL, body text). Use for reading article text or page content. For interacting with elements, prefer safari_snapshot (gives ref IDs). Use selector to read specific element. Use maxLength to limit output.",
  {
    selector: z.string().optional().describe("CSS selector to read specific element"),
    maxLength: z.coerce.number().optional().describe("Max chars to return (default: 50000)"),
  },
  async ({ selector, maxLength }) => {
    const result = await extensionOrFallback(
      "read_page", { selector, maxLength },
      () => safari.readPage({ selector, maxLength })
    );
    return textResult(result);
  }
);

server.tool(
  "safari_get_source",
  "Get HTML source of current page",
  { maxLength: z.coerce.number().optional().describe("Max chars (default: 200000)") },
  async ({ maxLength }) => {
    const result = await extensionOrFallback(
      "get_source", { maxLength },
      () => safari.getPageSource({ maxLength })
    );
    return textResult(result);
  }
);

// ========== SNAPSHOT (ref-based interaction like Chrome DevTools MCP) ==========

server.tool(
  "safari_snapshot",
  "PREFERRED way to see page state. Returns accessibility tree with ref IDs for every interactive element. Use refs with click/fill/type instead of CSS selectors. Workflow: snapshot → see refs → click({ref:'0_5'}). PREFER THIS over safari_screenshot (cheaper, structured text vs heavy image) and over safari_read_page (includes interactive refs). Use safari_screenshot only when you need to see visual layout/styling.",
  { selector: z.string().optional().describe("CSS selector for subtree (default: full page)") },
  async (args) => {
    const gen = safari.getNextSnapshotGen();
    const result = await extensionOrFallback(
      "snapshot", { selector: args.selector, gen },
      () => safari.takeSnapshot({ ...args, _gen: gen })
    );
    return textResult(result);
  }
);

server.tool(
  "safari_navigate_and_read",
  "Navigate to a URL and return the page content in one step — saves 1 full round-trip vs navigate+read_page. Use instead of safari_navigate + safari_read_page.",
  {
    url: z.string().describe("URL to navigate to"),
    maxLength: z.coerce.number().optional().describe("Max chars to return (default: 50000)"),
    timeout: z.coerce.number().optional().describe("Load timeout in ms (default: 30000)"),
  },
  async ({ url, maxLength, timeout }) => {
    const oldUrl = safari.getActiveTabURL();
    // Pre-register destination as owned BEFORE navigating (see safari_navigate) so a
    // slow/throwing navigate on a heavy SPA cannot lock switch_tab recovery out.
    _addOwnedURL(url);
    const result = await extensionOrFallback(
      "navigate_and_read", { url, maxLength, timeout },
      async () => {
        await safari.navigate(url);
        return safari.readPage({ maxLength });
      }
    );
    if (oldUrl && oldUrl !== url && oldUrl !== 'about:blank') _removeOwnedURL(oldUrl);
    return textResult(result);
  }
);

// ========== CLICK ==========

server.tool(
  "safari_click",
  "Click element. Use ref (from snapshot), selector, text, or x/y. Works on React/Airtable/virtual DOM apps via full PointerEvent+MouseEvent sequence + React Fiber fallback. Pure JS — never touches user's mouse. When using ref, always take a FRESH safari_snapshot first — refs expire after each new snapshot.",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot (e.g. '0_5')"),
    selector: z.string().optional().describe("CSS selector"),
    text: z.string().optional().describe("Visible text to find and click"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "click", { ref: args.ref, selector: args.selector, text: args.text, x: args.x, y: args.y },
      () => safari.click(args)
    );
    return textResult(result);
  }
);

server.tool(
  "safari_click_and_read",
  "Click an element then return the updated page — saves 1 full round-trip vs separate click+read_page. Handles both React Router navigation and full page loads.",
  {
    text: z.string().optional().describe("Visible text of the element to click"),
    selector: z.string().optional().describe("CSS selector"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
    wait: z.coerce.number().optional().describe("Ms to wait after click (default: auto-detect navigation)"),
    maxLength: z.coerce.number().optional().describe("Max chars to return (default: 50000)"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "click_and_read",
      { selector: args.selector, text: args.text, x: args.x, y: args.y, wait: args.wait, maxLength: args.maxLength },
      async () => {
        await safari.click(args);
        if (args.wait) {
          await new Promise(r => setTimeout(r, args.wait));
        } else {
          // Smart wait: brief pause then check if page is loading
          await new Promise(r => setTimeout(r, 50));
          const state = await safari.runJSQuick("document.readyState");
          if (state === "loading") {
            // Page is navigating — wait for it to complete
            await safari.runJSQuick("(async function(){for(var i=0;i<50;i++){if(document.readyState==='complete')return 'done';await new Promise(r=>setTimeout(r,200));}return 'timeout';})()");
          } else {
            await new Promise(r => setTimeout(r, 100)); // SPA settle time
          }
        }
        return safari.readPage({ maxLength: args.maxLength });
      }
    );
    return textResult(result);
  }
);

server.tool(
  "safari_double_click",
  "Double-click an element by CSS selector or x/y coordinates (e.g. to select a word in text)",
  {
    selector: z.string().optional().describe("CSS selector"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "double_click", { selector: args.selector, x: args.x, y: args.y },
      () => safari.doubleClick(args)
    );
    return textResult(result);
  }
);

server.tool(
  "safari_right_click",
  "Right-click (context menu) an element by CSS selector or x/y coordinates",
  {
    selector: z.string().optional().describe("CSS selector"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "right_click", { selector: args.selector, x: args.x, y: args.y },
      () => safari.rightClick(args)
    );
    return textResult(result);
  }
);

// ========== NATIVE CLICK (OS-level, isTrusted: true) ==========

server.tool(
  "safari_native_click",
  "OS-level mouse click via macOS CGEvent — produces isTrusted: true events that pass WAF/bot detection (G2, Cloudflare, etc.). Use when regular safari_click fails with 405/403 errors or form submissions are blocked. Trade-off: physically moves the mouse cursor and requires Safari window to be visible. Use ref (from snapshot), selector, text, or x/y. When using ref, always take a FRESH safari_snapshot first.",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot (e.g. '0_5')"),
    selector: z.string().optional().describe("CSS selector"),
    text: z.string().optional().describe("Visible text to find and click"),
    x: z.coerce.number().optional().describe("Viewport X coordinate"),
    y: z.coerce.number().optional().describe("Viewport Y coordinate"),
    doubleClick: z.boolean().optional().default(false).describe("Double-click instead of single click"),
  },
  async (args) => {
    // Native click always uses AppleScript path (no extension) — it needs OS-level access.
    // Bypasses extensionOrFallback, so assert tab-ownership explicitly — an OS-level click
    // on the user's front window would otherwise slip past the safety guard.
    _assertTabOwnership("native_click");
    // A profile can hold SEVERAL windows (measured: four "אוטומציות" at once), and the
    // AppleScript side picks the first by name — so coordinates were computed against
    // one window and the event delivered to another, a silent no-op. The extension is
    // the only party that knows which window holds this session's tab; ask it, and pin
    // both the geometry read and the click to that window. Falls back to the old
    // behaviour when the extension is unavailable.
    let locus = null;
    try { locus = await _tabLocusFromExtension(); } catch (_e) { /* AppleScript-only mode */ }
    const result = await safari.nativeClick({ ...args, locus });
    return textResult(result);
  }
);

// Resolve THIS session's tab window/index via the extension. Returns null when the
// extension can't answer (disconnected, AppleScript-only session).
async function _tabLocusFromExtension() {
  // Wait out a brief extension reconnect rather than silently falling back to the
  // broken postToPid path — that intermittency is exactly what made pinned clicks
  // land only sometimes. Bounded, so a genuinely absent extension still returns fast.
  try { await _waitForVerifiedProfileExtension(4000); } catch (_e) {}
  if (!_extensionConnected && !_primaryHasExtension) return null;
  // Deliberately NO tabUrl: an SPA rewrites its URL as you move through it, so passing
  // the URL we happened to record earlier makes the extension's URL-based lookup miss
  // and the whole pin silently degrade. Its per-session tab cache already knows which
  // tab this is — that is the authoritative answer here.
  const locus = await sendToExtension("get_tab_locus", {
    sessionId: `${SESSION_ID}:${currentSessionId()}`,
  }, 10000);
  return locus && typeof locus === "object" && locus.windowId ? locus : null;
}

server.tool(
  "safari_native_hover",
  "OS-level mouse hover via macOS CGEvent — moves the real cursor to an element to trigger native :hover / mouseenter handlers. Use for obfuscated UIs where JS-dispatched mouseenter isn't enough, like Discord server sidebars (tooltips only appear on real hover) or portal-rendered tooltips. After hover, call safari_wait_for or safari_evaluate to read the tooltip. Dwells for dwellMs to let tooltips render, then restores the original cursor position by default. Requires Safari window to be visible.",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    selector: z.string().optional().describe("CSS selector"),
    text: z.string().optional().describe("Visible text to find and hover"),
    x: z.coerce.number().optional().describe("Viewport X coordinate"),
    y: z.coerce.number().optional().describe("Viewport Y coordinate"),
    dwellMs: z.coerce.number().optional().default(500).describe("Milliseconds to dwell over the element so tooltips render (clamped 0-5000)"),
    restoreMouse: z.boolean().optional().default(true).describe("Restore cursor to original position after dwell"),
  },
  async (args) => {
    _assertTabOwnership("native_hover");
    const result = await safari.nativeHover(args);
    return textResult(result);
  }
);

server.tool(
  "safari_native_keyboard",
  "OS-level keyboard event via macOS CGEvent — sends a real keypress (with optional modifiers) to the Safari window WITHOUT activating Safari or stealing focus. Use when safari_press_key's JS path doesn't reach React trust-gated handlers (Discord ProseMirror Enter, Slack send, virtualized editors). Keys: enter, return, tab, escape, space, delete, backspace, up/down/left/right, home, end, pageup, pagedown, f1-f6, a-z, 0-9 and common punctuation. Modifiers: cmd, shift, alt, ctrl. Produces isTrusted:true events. Never activates Safari — runs entirely in the background.",
  {
    key: z.string().describe("Key name: enter, escape, tab, space, arrow keys, letters, digits, etc."),
    modifiers: z.array(z.string()).optional().default([]).describe("Modifier keys: cmd, shift, alt, ctrl"),
  },
  async (args) => {
    _assertTabOwnership("native_keyboard");
    const result = await safari.nativeKeyboard(args);
    return textResult(result);
  }
);

server.tool(
  "safari_native_type",
  "Insert text into ANY editor via OS-level clipboard paste (CGEvent Cmd+V targeted to Safari window). Unlike safari_fill which manipulates DOM directly (breaking React/ProseMirror state), this goes through the real paste pipeline — ProseMirror/Slate/Draft.js process the paste event natively and update their internal model. After native_type, pressing Enter (via safari_native_keyboard) will actually submit the form because the framework state matches the DOM. Saves and restores the user's clipboard. No focus stealing. Use for Discord, Slack, and any editor where safari_fill works visually but the content isn't 'really there' when you try to submit.",
  {
    value: z.string().describe("Text to insert via clipboard paste"),
    selector: z.string().optional().describe("CSS selector of the editor element to focus first"),
    ref: z.string().optional().describe("Ref ID from safari_snapshot to focus first"),
  },
  async (args) => {
    _assertTabOwnership("native_type");
    const result = await safari.nativeType(args);
    return textResult(result);
  }
);

// ========== FORM INPUT ==========

server.tool(
  "safari_fill",
  "Fill/replace value in an input, textarea, select, OR contenteditable (rich text). Handles React controlled inputs, ProseMirror, Draft.js, and Google Closure editors automatically. Use for SETTING a value (replaces existing). For code editors (Monaco/CodeMirror/Ace), use safari_replace_editor instead. For character-by-character typing in search boxes, use safari_type_text. IMPORTANT: When using ref, always take a FRESH safari_snapshot first — refs expire after each new snapshot (prefix changes: 5_xx → 6_xx).",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    selector: z.string().optional().describe("CSS selector"),
    value: z.string().describe("Value to fill"),
  },
  async (args) => {
    const selector = args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector;
    const result = await extensionOrFallback(
      "fill", { selector, value: args.value },
      () => safari.fill(args)
    );
    return textResult(result);
  }
);

server.tool(
  "safari_clear_field",
  "Clear an input field",
  { selector: z.string().describe("CSS selector of the input") },
  async (args) => {
    const result = await extensionOrFallback(
      "clear_field", { selector: args.selector },
      () => safari.clearField(args)
    );
    return textResult(result);
  }
);

server.tool(
  "safari_verify_state",
  "Verify the framework-level state of an editor/input matches the expected value. Returns JSON {match, mode, actual, expected, hint?}. Modern editors (ProseMirror, Lexical, Closure, React-controlled inputs) maintain state separately from the DOM — `.value` or `.textContent` may show new text while the internal store still holds old data, so a Submit click sends stale data. Call this AFTER safari_fill and BEFORE clicking Submit on critical forms (Featured.com, LinkedIn share, Medium, Reddit).",
  {
    selector: z.string().describe("CSS selector of the editor/input to verify"),
    expected: z.string().describe("Expected value or text fragment that should appear in framework state"),
  },
  async (args) => {
    const result = await safari.verifyState(args);
    return textResult(result);
  }
);

server.tool(
  "safari_select_option",
  "Select an option in a native <select> dropdown. Sets .value and dispatches change event. Pass `ref` (from safari_snapshot) for a select inside an iframe or shadow DOM — a plain `selector` only reaches the top document. For custom dropdowns (React/LinkedIn), use safari_click on the dropdown trigger, then safari_click on the option instead.",
  {
    selector: z.string().optional().describe("CSS selector of the select (top document only)"),
    ref: z.string().optional().describe("Ref ID from safari_snapshot — required for selects inside iframes/shadow DOM"),
    value: z.string().describe("Option value or visible label to select"),
  },
  async (args) => {
    // The engine calls below can bypass extensionOrFallback — assert ownership here.
    _assertTabOwnership("select_option");
    // ref path: resolve via mcpFindRef (reaches iframes/shadow DOM) on the AppleScript
    // engine — the extension's select_option handler is selector-only.
    if (args.ref) {
      const refResult = await safari.selectOption({ ref: args.ref, value: args.value });
      return { content: [{ type: "text", text: typeof refResult === 'string' ? refResult : JSON.stringify(refResult) }] };
    }
    let result = await extensionOrFallback(
      "select_option", { selector: args.selector, value: args.value },
      () => safari.selectOption(args)
    );
    // If extension returned "Selected: " with empty/default value, fuzzy match may have failed.
    // Retry via AppleScript path which has the latest fuzzy match code.
    if (typeof result === 'string' && result.match(/^Selected:\s*$/) ) {
      console.error('[Safari MCP] select_option returned empty value — retrying via AppleScript');
      result = await safari.selectOption(args);
    }
    return textResult(result);
  }
);

server.tool(
  "safari_react_select_set",
  "Set a value in a react-select v5 dropdown by walking React fiber to find the Select component and invoking onChange directly — bypasses the menu UI entirely. Use when safari_click on the chevron or option keeps failing (Cloudflare custom token forms after a few rows, portal-rendered selects that intercept synthetic events). Returns JSON {ok, selected} on success, or {ok:false, error, available:[…]} listing up to 30 option labels on miss. Match is by label, value, or case-insensitive label. Either ref or selector required. NOTE: For Permissions-levels combos that are disabled until a Permission is selected, set the Permissions value first — the level combo becomes enabled and its props.options populate.",
  {
    selector: z.string().optional().describe("CSS selector — typically input[name=...] or the .react-select__control container"),
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    value: z.string().describe("Option label (or value) to select — case-insensitive fallback"),
  },
  async (args) => {
    _assertTabOwnership("react_select_set");
    const result = await safari.reactSelectSet(args);
    return textResult(result);
  }
);

server.tool(
  "safari_react_select_list_options",
  "List available options of a react-select v5 dropdown without opening the menu. Returns JSON {ok, total, options:[{label,value}…]}. Useful when safari_react_select_set returns 'option not found' and you need to see exact labels (e.g. 'Email Routing Rules' vs 'Email Routing'). Either ref or selector required.",
  {
    selector: z.string().optional().describe("CSS selector"),
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
  },
  async (args) => {
    const result = await safari.reactSelectListOptions(args);
    return textResult(result);
  }
);

server.tool(
  "safari_fill_form",
  "Fill multiple form fields at once",
  {
    fields: z.array(z.object({
      selector: z.string().describe("CSS selector"),
      value: z.string().describe("Value to fill"),
    })).describe("Array of {selector, value} pairs"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "fill_form", { fields: args.fields },
      () => safari.fillForm(args)
    );
    return textResult(result);
  }
);

// ========== KEYBOARD ==========

server.tool(
  "safari_press_key",
  "Press a keyboard key (enter, tab, escape, arrows, etc). Supports modifiers (cmd, shift, alt, ctrl).",
  {
    key: z.string().describe("Key name: enter, tab, escape, space, delete, up, down, left, right, or a single character"),
    modifiers: z.array(z.string()).optional().describe("Modifier keys: cmd, shift, alt, ctrl"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "press_key", { key: args.key, modifiers: args.modifiers },
      () => safari.pressKey(args)
    );
    return textResult(result);
  }
);

server.tool(
  "safari_type_text",
  "Type text character-by-character with realistic key events. Best for: search boxes (triggers autocomplete), chat inputs, and fields that react to each keystroke. For rich text editors (Medium, HackerNoon, LinkedIn), use safari_fill instead — it uses framework-native APIs. For code editors (Monaco/CodeMirror), use safari_replace_editor. When using ref, always take a FRESH safari_snapshot first — refs expire after each new snapshot.",
  {
    text: z.string().describe("Text to type"),
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    selector: z.string().optional().describe("CSS selector to focus"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "type_text", { text: args.text, selector: args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector },
      () => safari.typeText(args)
    );
    return textResult(result);
  }
);

// ========== CODE EDITOR ==========

server.tool(
  "safari_replace_editor",
  "Replace ALL content in a code editor (Monaco, CodeMirror, Ace, ProseMirror). Use ONLY for code editors — Airtable automations, GitHub gists, CodePen, n8n code nodes, etc. NOT for rich text editors like Medium/LinkedIn (use safari_fill for those). Detects ProseMirror/Draft.js/CodeMirror/Monaco/Ace and uses their native API.",
  {
    text: z.string().describe("The complete code/text to put in the editor"),
  },
  async ({ text }) => {
    const result = await extensionOrFallback(
      "replace_editor", { text },
      () => safari.replaceEditorContent({ text })
    );
    return textResult(result);
  }
);

// ========== SCREENSHOT ==========

server.tool(
  "safari_screenshot",
  "Take a visual screenshot (base64 JPEG). EXPENSIVE — use safari_snapshot instead for most tasks. Only use screenshot when you need to verify visual layout, styling, images, or colors that snapshot can't show.",
  {
    fullPage: z.boolean().optional().describe("Capture full page (not just viewport)"),
  },
  async ({ fullPage }) => {
    let base64;
    try {
      base64 = await extensionOrFallback(
        "screenshot", { fullPage },
        () => safari.screenshot({ fullPage })
      );
    } catch (err) {
      // If AppleScript screenshot failed (permission lost), retry via extension only
      // But only if we're not in profile mode (extension may be from wrong profile)
      if (_extensionConnected && !_preferAppleScript && err.message && (err.message.includes("permission") || err.message.includes("screencapture") || err.message.includes("empty"))) {
        console.error("[Safari MCP] Screenshot AppleScript failed, retrying via extension only");
        base64 = await sendToExtension("screenshot", { fullPage }, 15000);
      } else {
        throw err;
      }
    }
    return {
      content: [{ type: "image", data: base64, mimeType: "image/jpeg" }],
    };
  }
);

server.tool(
  "safari_screenshot_element",
  "Take a screenshot of a specific element (by CSS selector). Returns base64 PNG image.",
  { selector: z.string().describe("CSS selector of the element to capture") },
  async ({ selector }) => {
    const base64 = await extensionOrFallback(
      "screenshot_element", { selector },
      () => safari.screenshotElement({ selector })
    );
    return {
      content: [{ type: "image", data: base64, mimeType: "image/jpeg" }],
    };
  }
);

// ========== SCROLL ==========

server.tool(
  "safari_scroll",
  "Scroll the page up or down by a specified amount",
  {
    direction: z.enum(["up", "down"]).optional().describe("Scroll direction (default: down)"),
    amount: z.coerce.number().optional().describe("Pixels to scroll (default: 500)"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "scroll", { direction: args.direction, amount: args.amount },
      () => safari.scroll(args)
    );
    return textResult(result);
  }
);

server.tool(
  "safari_scroll_to",
  "Scroll to a specific position on the page",
  {
    x: z.coerce.number().optional().describe("X position (default: 0)"),
    y: z.coerce.number().optional().describe("Y position (default: 0)"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "scroll_to", { x: args.x, y: args.y },
      () => safari.scrollTo(args)
    );
    return textResult(result);
  }
);

// ========== TAB MANAGEMENT ==========

server.tool(
  "safari_list_tabs",
  "List all open tabs in Safari with their titles and URLs",
  {},
  async () => {
    const result = await extensionOrFallback(
      "list_tabs", {},
      () => safari.listTabs()
    );
    const safeResult = _sanitizeTabResult(result);
    return { content: [{ type: "text", text: typeof safeResult === 'string' ? safeResult : JSON.stringify(safeResult, null, 2) }] };
  }
);

server.tool(
  "safari_reload_extension",
  "Hot-reload the Safari MCP Bridge extension — forces it to reload its own code from disk without requiring manual Safari Preferences → Extensions → toggle. Use after editing extension/background.js or extension/content.js in the safari-mcp repo. The extension briefly disconnects during reload and auto-reconnects within ~2 seconds. NOTE: this tool itself requires the extension version already installed to support the `reload_extension` command (added in v2.9.1+). If your extension is older, trigger a manual reload once to pick up this feature.",
  {},
  async () => {
    let result = await extensionOrFallback(
      "reload_extension", {},
      async () => "Extension fallback not available — this command requires the Safari MCP Bridge extension."
    );
    // Proxy mode waits on the extension host inside /proxy-command. A host process
    // performs the same generation barrier here before reporting success locally.
    if (_isExtensionHost) {
      // Baseline after the response, for the same suspended-old-worker reason as the
      // proxy route above. The extension schedules runtime.reload() after responding.
      const reloadGeneration = _extensionConnectionGeneration;
      const reconnected = await _waitForExtensionGeneration(reloadGeneration, 30000);
      if (!reconnected) throw new Error("Extension reload did not produce a verified reconnect within 30000ms");
      if (result && typeof result === "object") result = { ...result, reconnected: true };
    }
    return textResult(result);
  }
);

server.tool(
  "safari_new_tab",
  "Open a new tab, optionally with a URL",
  { url: z.string().optional().describe("URL to open (empty for blank tab)") },
  async ({ url }) => {
    // Safari may suspend the profile worker between calls. Give it one full wake
    // cycle; once connected, the extension creates a background profile window
    // itself when the previous last window was closed.
    if (process.env.SAFARI_PROFILE) await _waitForVerifiedProfileExtension(30000);

    // Enforce tab limit — close this session's oldest MCP tab if at max.
    // Scoped to the caller: in HTTP daemon mode _openedTabs is process-wide, so a
    // global cap meant N concurrent sessions shared one budget and the eviction closed
    // whichever tab was oldest overall — routinely another session's live page. Each
    // session now gets its own MAX_TABS and can only evict its own.
    const mySession = `${SESSION_ID}:${currentSessionId()}`;
    const myTabs = [..._openedTabs].filter(([, info]) => (info.sessionId || "") === mySession);
    if (myTabs.length >= MAX_TABS) {
      let oldestIdx = null, oldestTime = Infinity;
      for (const [idx, info] of myTabs) {
        if (info.openedAt < oldestTime) { oldestTime = info.openedAt; oldestIdx = idx; }
      }
      if (oldestIdx !== null) {
        console.error(`[Safari MCP] Tab limit (${MAX_TABS}) reached for this session — closing its oldest tab #${oldestIdx}`);
        try {
          await extensionOrFallback(
            "close_tab",
            { index: oldestIdx },
            () => safari.closeTab(oldestIdx)
          );
        } catch {}
        _untrackTab(oldestIdx);
      }
    }

    const requestedUrl = String(url || "");
    const rawResult = await extensionOrFallback(
      "new_tab", { url: requestedUrl },
      () => safari.newTab(requestedUrl)
    );
    // AppleScript fallback returns a JSON string; extension returns an object — normalize
    let result = rawResult;
    if (typeof rawResult === 'string') {
      try { result = JSON.parse(rawResult); } catch {}
    }
    const safeResult = _sanitizeTabResult(result);
    // Sync safari.js tracking when extension handled new_tab. The raw navigation URL
    // remains internal and is never copied into the MCP response.
    if (safeResult?.tabIndex) {
      safari.setActiveTabIndex(safeResult.tabIndex);
      _trackTab(safeResult.tabIndex, requestedUrl, mySession);
    }
    if (requestedUrl) {
      const trackUrl = requestedUrl;
      safari.setActiveTabURL(trackUrl);
      _addOwnedURL(trackUrl);
    }
    if (!requestedUrl) _markBlankTabOpened();
    if (safeResult?.receipt) _setActiveReceipt(safeResult.receipt);
    return { content: [{ type: "text", text: typeof safeResult === 'string' ? safeResult : JSON.stringify(safeResult) }] };
  }
);

server.tool(
  "safari_close_tab",
  "Close the current tab. After a daemon/session restart, pass the opaque receipt returned by safari_new_tab or safari_list_tabs.",
  {
    receipt: z.string().optional().describe("Opaque extension-issued tab receipt"),
    url: z.string().optional().describe("Deprecated legacy receipt URL"),
  },
  async ({ receipt, url }) => {
    const activeIdx = safari.getActiveTabIndex();
    const supplied = receipt || url || "";
    const token = _receiptToken(supplied) || _getActiveReceipt();
    if (supplied && !token) return errorResult("Tab safety: invalid tab receipt");
    const result = await extensionOrFallback(
      "close_tab",
      token ? { receipt: token } : {},
      () => safari.closeTab()
    );
    if (activeIdx !== null) _untrackTab(activeIdx);
    _setActiveReceipt("");
    return textResult(result);
  }
);

server.tool(
  "safari_switch_tab",
  "Switch the MCP session's logical target without focusing Safari. Pass an index for the current session window, or an opaque receipt to recover the exact owned tab across Safari windows; a valid receipt takes precedence over any supplied index.",
  {
    index: z.coerce.number().optional().describe("Tab index (starting from 1); optional when receipt is provided"),
    receipt: z.string().optional().describe("Opaque extension-issued receipt for the exact owned tab"),
    url: z.string().optional().describe("Deprecated legacy receipt URL"),
  },
  async ({ index, receipt, url }) => {
    const supplied = receipt || url || "";
    const token = _receiptToken(supplied);
    if (supplied && !token) {
      const msg = "⚠️ Tab safety: refusing switch_tab — invalid receipt.";
      console.error(`[Safari MCP] ${msg}`);
      return errorResult(msg);
    }
    if (!token && (!Number.isInteger(index) || index < 1)) {
      return errorResult("Tab safety: switch_tab requires a positive index or a valid receipt");
    }
    if (index !== undefined && (!Number.isInteger(index) || index < 1)) {
      return errorResult("Tab safety: switch_tab index must be a positive integer when provided");
    }

    // Tab ownership check: verify target tab is one we opened
    if (!process.env.SAFARI_PROFILE && _ownedTabURLs.size > 0) {
      // Get target tab's URL via list_tabs before switching
      try {
        const tabs = await extensionOrFallback(
          "list_tabs", {},
          () => safari.listTabs()
        );
        const parsed = typeof tabs === 'string' ? JSON.parse(tabs) : tabs;
        const target = parsed.find(t => t.index === index);
        if (target && target.url && !_isURLOwned(target.url)) {
          // about:blank / missing value tabs are owned if tracked in _openedTabs
          const isBlankOwned = (target.url === 'about:blank' || target.url === 'missing value') && (_openedTabs.has(index) || _ownedTabURLs.has(BLANK_TAB_SENTINEL));
          // A tab THIS session opened may have redirected away from the URL we
          // registered (/dashboard -> /login, any 302), so the URL alone stops
          // being proof and the tab became permanently un-switchable. But a
          // tracked index is not proof either: `_openedTabs` is keyed by INDEX
          // and Safari renumbers every index whenever any tab closes, so a stale
          // key can point straight at a user's tab. Require BOTH — the index we
          // opened AND the origin we opened it on. That mirrors the origin
          // boundary the extension keeps on its own receipts, so nothing that
          // would survive the extension's check is lost here, and the AppleScript
          // fallback (which has no ownership check of its own) stays guarded.
          const trackedOrigin = _originOf(_openedTabs.get(index)?.url);
          const isTrackedRedirect = !!trackedOrigin && trackedOrigin === _originOf(target.url);
          if (!isBlankOwned && !isTrackedRedirect) {
            const msg = `⚠️ Tab safety: refusing switch_tab to index ${index} (${_safeUrlForOutput(target.url)}) — not opened by this MCP session. Use safari_new_tab to open your own tab.`;
            console.error(`[Safari MCP] ${msg}`);
            return errorResult(msg);
          }
        }
      } catch {}
    }
    const result = await extensionOrFallback(
      "switch_tab", token ? { ...(index ? { index } : {}), receipt: token } : { index },
      () => safari.switchTab(index)
    );
    const safeResult = _sanitizeTabResult(result);
    // Sync safari.js state so AppleScript fallback targets the correct tab
    const resolvedIndex = safeResult?.tabIndex || index;
    if (resolvedIndex) safari.setActiveTabIndex(resolvedIndex);
    if (safeResult?.safeUrl) safari.setActiveTabURL(safeResult.safeUrl);
    if (safeResult?.receipt || token) _setActiveReceipt(safeResult?.receipt || token);
    return { content: [{ type: "text", text: JSON.stringify(safeResult) }] };
  }
);

// ========== WAIT ==========

server.tool(
  "safari_wait_for",
  "Wait for an element or text to appear on the page",
  {
    selector: z.string().optional().describe("CSS selector to wait for"),
    text: z.string().optional().describe("Text to wait for"),
    timeout: z.coerce.number().optional().describe("Timeout in ms (default: 10000)"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "wait_for", { selector: args.selector, text: args.text, timeout: args.timeout },
      () => safari.waitFor(args)
    );
    return textResult(result);
  }
);

server.tool(
  "safari_wait_for_new_tab",
  "Wait for a new tab to appear (e.g. after OAuth login click opens popup). Automatically switches to the new tab.",
  {
    timeout: z.coerce.number().optional().describe("Timeout in ms (default: 10000)"),
    urlContains: z.string().optional().describe("Only match new tabs whose URL contains this string"),
  },
  async ({ timeout, urlContains }) => {
    const timeoutMs = timeout || 10000;
    // Get current tab list
    const beforeRaw = await extensionOrFallback("list_tabs", {}, () => safari.listTabs());
    const beforeTabs = typeof beforeRaw === 'string' ? JSON.parse(beforeRaw) : beforeRaw;
    const beforeIds = new Set(beforeTabs.map(t => `${t.index}:${t.url}`));
    const beforeCount = beforeTabs.length;

    // Poll for new tab — detect by count increase + new entries (handles about:blank tabs)
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const nowRaw = await extensionOrFallback("list_tabs", {}, () => safari.listTabs());
      const nowTabs = typeof nowRaw === 'string' ? JSON.parse(nowRaw) : nowRaw;
      if (nowTabs.length > beforeCount) {
        // Find the new tab(s) — could be about:blank initially (OAuth popups)
        for (const tab of nowTabs) {
          if (!beforeIds.has(`${tab.index}:${tab.url}`)) {
            // Wait for about:blank to resolve to actual URL — dynamic polling instead of fixed delay
            if (tab.url === 'about:blank') {
              let resolved = null;
              for (let attempt = 0; attempt < 10; attempt++) {
                await new Promise(r => setTimeout(r, 300)); // 300ms intervals, max 3s total
                const refreshed = await extensionOrFallback("list_tabs", {}, () => safari.listTabs());
                const refreshedTabs = typeof refreshed === 'string' ? JSON.parse(refreshed) : refreshed;
                resolved = refreshedTabs.find(t => t.index === tab.index);
                if (resolved && resolved.url !== 'about:blank') break;
                resolved = null;
              }
              if (resolved && resolved.url !== 'about:blank') {
                if (urlContains && !resolved.url.includes(urlContains)) continue;
                await extensionOrFallback("switch_tab", { index: resolved.index }, () => safari.switchTab(resolved.index));
                safari.setActiveTabIndex(resolved.index);
                safari.setActiveTabURL(resolved.url);
                _trackTab(resolved.index, resolved.url, `${SESSION_ID}:${currentSessionId()}`);  // own the popup for THIS session, else the next interaction trips the tab-safety guard
                return { content: [{ type: "text", text: `Found new tab: ${resolved.title} (${resolved.url})` }] };
              }
              continue;
            }
            if (urlContains && !tab.url.includes(urlContains)) continue;
            await extensionOrFallback("switch_tab", { index: tab.index }, () => safari.switchTab(tab.index));
            safari.setActiveTabIndex(tab.index);
            safari.setActiveTabURL(tab.url);
            _trackTab(tab.index, tab.url, `${SESSION_ID}:${currentSessionId()}`);  // own the new tab for THIS session, else the next interaction trips the tab-safety guard
            return { content: [{ type: "text", text: `Found new tab: ${tab.title} (${tab.url})` }] };
          }
        }
      }
    }
    return { content: [{ type: "text", text: "TIMEOUT: no new tab appeared" }] };
  }
);

// ========== EVALUATE JAVASCRIPT ==========

server.tool(
  "safari_evaluate",
  "Execute JavaScript in the current page. Automatically falls back to AppleScript when CSP blocks execution (e.g. Google Search Console, LinkedIn). For reading data, prefer safari_read_page or safari_snapshot. For interactions, prefer safari_click/fill with refs.",
  { script: z.string().describe("JavaScript code to execute") },
  async (args) => {
    const result = await extensionOrFallback(
      "evaluate", { script: args.script },
      () => safari.evaluate(args)
    );
    return { content: [{ type: "text", text: (typeof result === 'string' ? result : JSON.stringify(result)) || "(no return value)" }] };
  }
);

server.tool(
  "safari_eval_file",
  "Execute JavaScript read from a FILE path (avoids passing huge scripts inline / manual copy). Same engine as safari_evaluate: extension-first (no focus steal), AppleScript fallback. Use to upload binary via a generated .js containing base64.",
  { path: z.string().describe("Absolute path to a .js file whose contents are the script to execute") },
  async (args) => {
    const script = readFileSync(args.path, "utf8");
    const result = await extensionOrFallback("evaluate", { script }, () => safari.evaluate({ script }));
    return { content: [{ type: "text", text: (typeof result === "string" ? result : JSON.stringify(result)) || "(no return value)" }] };
  }
);

// ========== ELEMENT INFO ==========

server.tool(
  "safari_get_element",
  "Get detailed info about an element (tag, text, rect, attributes, visibility)",
  { selector: z.string().describe("CSS selector") },
  async (args) => {
    const result = await extensionOrFallback(
      "get_element", { selector: args.selector },
      () => safari.getElementInfo(args)
    );
    return textResult(result);
  }
);

server.tool(
  "safari_query_all",
  "Find all elements matching a CSS selector (returns tag, text, href, value)",
  {
    selector: z.string().describe("CSS selector"),
    limit: z.coerce.number().optional().describe("Max results (default: 20)"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "query_all", { selector: args.selector, limit: args.limit },
      () => safari.querySelectorAll(args)
    );
    return textResult(result);
  }
);

// ========== HOVER ==========

server.tool(
  "safari_hover",
  "Hover over element. Use ref, selector, or x/y",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    selector: z.string().optional().describe("CSS selector"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
  },
  async (args) => {
    const sel = args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector;
    const result = await extensionOrFallback(
      "hover", { selector: sel },
      () => safari.hover(args)
    );
    return textResult(result);
  }
);

// ========== DIALOG HANDLING ==========

server.tool(
  "safari_handle_dialog",
  "Set up handler for the next alert/confirm/prompt dialog",
  {
    action: z.enum(["accept", "dismiss"]).optional().describe("Accept or dismiss (default: accept)"),
    text: z.string().optional().describe("Text to enter for prompt dialogs"),
  },
  async (args) => {
    _assertTabOwnership("handle_dialog");
    const result = await safari.handleDialog(args);
    return textResult(result);
  }
);

// ========== WINDOW ==========

server.tool(
  "safari_resize",
  "Resize the Safari window",
  {
    width: z.coerce.number().describe("Window width"),
    height: z.coerce.number().describe("Window height"),
  },
  async (args) => {
    _assertTabOwnership("resize");
    const result = await safari.resizeWindow(args);
    return textResult(result);
  }
);

// ========== DRAG ==========

server.tool(
  "safari_drag",
  "Drag an element to another element or position. Use CSS selectors or x/y coordinates.",
  {
    sourceSelector: z.string().optional().describe("CSS selector of element to drag"),
    targetSelector: z.string().optional().describe("CSS selector of drop target"),
    sourceX: z.coerce.number().optional().describe("Source X coordinate"),
    sourceY: z.coerce.number().optional().describe("Source Y coordinate"),
    targetX: z.coerce.number().optional().describe("Target X coordinate"),
    targetY: z.coerce.number().optional().describe("Target Y coordinate"),
  },
  async (args) => {
    _assertTabOwnership("drag");
    const result = await safari.drag(args);
    return textResult(result);
  }
);

// ========== UPLOAD FILE ==========

server.tool(
  "safari_upload_file",
  "Upload a file to a <input type='file'> element via JavaScript DataTransfer — NO file dialog, NO UI interaction. IMPORTANT: Do NOT click the file input before calling this tool — just provide the selector and file path. If a file dialog is already open, this tool will close it first. NOTE: 'verified 0 files' may appear even on success if the site uses a custom upload handler — check visually with safari_snapshot. For an IMAGE going into a composer/editor that should show a thumbnail, pass verifyPreview:true — some sites (Google Business Profile) accept the file handle and flip their UI to 'attached' while ingesting nothing, and the post then publishes with no image.",
  {
    selector: z.string().describe("CSS selector of the file input"),
    filePath: z.string().describe("Absolute path to the file to upload"),
    verifyPreview: z.boolean().optional().describe("Require a visible preview (blob:/data: image) to appear; if none does, the synthetic pickup was a ghost and this escalates to a real OS file dialog. Use for images going into a composer."),
    forceNative: z.boolean().optional().describe("Skip synthetic injection and go straight to the real OS file dialog (isTrusted). Needs an unlocked screen and briefly focuses Safari. Use when the site is known to reject synthetic uploads."),
  },
  async (args) => {
    _assertTabOwnership("upload_file");
    const result = await safari.uploadFile(args);
    return textResult(result);
  }
);

// ========== PASTE IMAGE ==========

server.tool(
  "safari_paste_image",
  "Paste an image from a local file into the focused element via JS DataTransfer (no clipboard, no focus steal). Works on Medium, dev.to, HackerNoon, TOI, etc.",
  {
    filePath: z.string().describe("Absolute path to the image file (PNG, JPG, WebP)"),
  },
  async ({ filePath }) => {
    _assertTabOwnership("paste_image");
    const result = await safari.pasteImageFromFile({ filePath });
    return textResult(result);
  }
);

// ========== EMULATE (DEVICE SIMULATION) ==========

server.tool(
  "safari_emulate",
  "Emulate a mobile device by resizing window and setting user agent. Devices: iphone-14, iphone-14-pro-max, ipad, ipad-pro, pixel-7, galaxy-s24. Or use custom width/height.",
  {
    device: z.string().optional().describe("Device name: iphone-14, ipad, pixel-7, galaxy-s24, etc."),
    width: z.coerce.number().optional().describe("Custom viewport width"),
    height: z.coerce.number().optional().describe("Custom viewport height"),
    userAgent: z.string().optional().describe("Custom user agent string"),
    scale: z.coerce.number().optional().describe("Initial scale (default: 1)"),
  },
  async (args) => {
    _assertTabOwnership("emulate");
    const result = await safari.emulate(args);
    return textResult(result);
  }
);

server.tool(
  "safari_reset_emulation",
  "Reset device emulation back to desktop mode",
  {},
  async () => {
    _assertTabOwnership("reset_emulation");
    const result = await safari.resetEmulation();
    return textResult(result);
  }
);

// ========== COOKIES & STORAGE ==========

server.tool(
  "safari_get_cookies",
  "Get cookies for the current page",
  {},
  async () => {
    const result = await safari.getCookies();
    return { content: [{ type: "text", text: result || "(no cookies)" }] };
  }
);

server.tool(
  "safari_local_storage",
  "Get localStorage data for the current page",
  { key: z.string().optional().describe("Specific key to get (omit for all)") },
  async ({ key }) => {
    const result = await safari.getLocalStorage({ key });
    return { content: [{ type: "text", text: result || "(empty)" }] };
  }
);

// ========== NETWORK ==========

server.tool(
  "safari_network",
  "Quick network overview via Performance API (no setup needed). Shows URLs and timing for resources loaded by the page. For detailed request/response info (headers, status codes, POST bodies), use safari_start_network_capture + safari_network_details instead.",
  { limit: z.coerce.number().optional().describe("Max requests to return (default: 50)") },
  async ({ limit }) => {
    const result = await safari.getNetworkRequests({ limit });
    return textResult(result);
  }
);

// ========== RUN SCRIPT (multi-step) ==========

server.tool(
  "safari_run_script",
  "Batch Safari actions in one MCP session. Named profiles use the verified extension and support: newTab, switchTab, getReceipt, listTabs, closeTab, navigate, navigateAndRead, readPage, snapshot, getElementInfo, querySelectorAll, waitFor, waitForTime, click, clickAndOpenPopup, fill, fillForm, clearField, typeText, selectOption, pressKey, scroll, scrollTo, scrollToElement, hover, evaluate, reload, goBack, goForward. switchTab accepts an index or an opaque receipt; a valid receipt recovers the exact owned tab across Safari windows without focusing one. clickAndOpenPopup takes exactly one selector or snapshot ref, targets one exact frame, performs one click, captures a blocked HTTP(S) window.open, and opens it as a background tab without focusing Safari; it refuses CAPTCHA/challenge targets and never returns URL query/hash data. Non-profile mode retains the legacy action set. Use getReceipt after a cross-origin redirect.",
  {
    steps: z.array(z.object({
      action: z.string().describe("Action name (e.g. 'navigate', 'click', 'fill')"),
      args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the action"),
    })).describe("Array of steps to execute sequentially"),
  },
  async ({ steps }) => {
    // Preserve the full historical action surface for non-profile installations.
    // Named-profile sessions cannot use it because safari.runScript drives Safari via
    // AppleScript and loses the verified profile/tab-id boundary; they use the
    // extension-only dispatcher below.
    if (!process.env.SAFARI_PROFILE) {
      const onStep = (action, stepArgs) => {
        if (action === "newTab") { _markBlankTabOpened(); return; }
        if (action === "navigate" || action === "navigateAndRead") {
          _assertTabOwnership(`run_script:${action}`);
          const url = stepArgs && typeof stepArgs.url === "string" ? stepArgs.url : null;
          if (url) {
            _addOwnedURL(url);
            if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) _addOwnedURL("https://" + url);
          }
          return;
        }
        if (!_RUNSCRIPT_OWNERSHIP_EXEMPT.has(action)) _assertTabOwnership(`run_script:${action}`);
      };
      return textResult(await safari.runScript({ steps, onStep }));
    }

    // Keep every step in one MCP request/session and route it through
    // extensionOrFallback. In a named Safari profile this is extension-only; the old
    // safari.runScript path invoked AppleScript directly and also passed object args to
    // positional functions such as newTab(url), producing `u.split is not a function`.
    const results = [];
    const stopOnSemanticMiss = new Set([
      "newTab", "switchTab", "closeTab", "navigate", "navigateAndRead", "waitFor",
      "click", "clickAndOpenPopup", "fill", "fillForm", "clearField", "typeText", "selectOption",
      "pressKey", "scroll", "scrollTo", "scrollToElement", "hover", "evaluate",
      "reload", "goBack", "goForward",
    ]);
    for (const step of steps) {
      try {
        const result = await _runExtensionBatchAction(step.action, step.args || {});
        const semanticFailure = _isBatchSemanticFailure(result);
        if (semanticFailure && stopOnSemanticMiss.has(step.action)) {
          results.push({ action: step.action, error: result });
          break;
        }
        results.push({ action: step.action, result });
      } catch (err) {
        results.push({ action: step.action, error: err?.message || String(err) });
        break;
      }
    }
    return textResult(JSON.stringify(results));
  }
);

// ========== CONSOLE ==========

server.tool(
  "safari_start_console",
  "Start capturing console messages (log, warn, error, info). Call once per page.",
  {},
  async () => {
    const result = await safari.startConsoleCapture();
    return textResult(result);
  }
);

server.tool(
  "safari_get_console",
  "Get captured console messages (must call safari_start_console first)",
  {},
  async () => {
    const result = await safari.getConsoleMessages();
    return textResult(result);
  }
);

server.tool(
  "safari_clear_console",
  "Clear all captured console messages",
  {},
  async () => {
    const result = await safari.clearConsoleCapture();
    return textResult(result);
  }
);

// ========== PDF SAVE ==========

server.tool(
  "safari_save_pdf",
  "Save the current page as a PDF file. Uses screencapture + PDF rendering (no Safari UI interaction needed).",
  { path: z.string().describe("Absolute file path to save the PDF (e.g. /Users/am/Downloads/page.pdf)") },
  async (args) => {
    const result = await safari.savePDF(args);
    return textResult(result);
  }
);

// ========== ACCESSIBILITY SNAPSHOT ==========

server.tool(
  "safari_accessibility_snapshot",
  "Get the accessibility tree of the page (roles, ARIA labels, focusable elements, form states). Essential for a11y auditing.",
  {
    selector: z.string().optional().describe("CSS selector for subtree (default: full page)"),
    maxDepth: z.coerce.number().optional().describe("Max tree depth (default: 5)"),
  },
  async (args) => {
    const result = await safari.getAccessibilityTree(args);
    return textResult(result);
  }
);

// ========== COOKIE CRUD ==========

server.tool(
  "safari_set_cookie",
  "Set a cookie on the current page",
  {
    name: z.string().describe("Cookie name"),
    value: z.string().describe("Cookie value"),
    domain: z.string().optional().describe("Cookie domain"),
    path: z.string().optional().describe("Cookie path (default: /)"),
    expires: z.string().optional().describe("Expiry date (e.g. 'Thu, 01 Jan 2030 00:00:00 GMT')"),
    secure: z.boolean().optional().describe("Secure flag"),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("SameSite attribute"),
  },
  async (args) => {
    _assertTabOwnership("set_cookie");
    const result = await safari.setCookie(args);
    return textResult(result);
  }
);

server.tool(
  "safari_delete_cookies",
  "Delete a specific cookie or all cookies for the current page",
  {
    name: z.string().optional().describe("Cookie name to delete"),
    all: z.boolean().optional().describe("Delete all cookies"),
  },
  async (args) => {
    _assertTabOwnership("delete_cookies");
    const result = await safari.deleteCookies(args);
    return textResult(result);
  }
);

// ========== SESSION STORAGE ==========

server.tool(
  "safari_session_storage",
  "Get sessionStorage data for the current page",
  { key: z.string().optional().describe("Specific key (omit for all)") },
  async ({ key }) => {
    const result = await safari.getSessionStorage({ key });
    return { content: [{ type: "text", text: result || "(empty)" }] };
  }
);

server.tool(
  "safari_set_session_storage",
  "Set a value in sessionStorage",
  {
    key: z.string().describe("Storage key"),
    value: z.string().describe("Value to store"),
  },
  async (args) => {
    _assertTabOwnership("set_session_storage");
    const result = await safari.setSessionStorage(args);
    return textResult(result);
  }
);

server.tool(
  "safari_set_local_storage",
  "Set a value in localStorage",
  {
    key: z.string().describe("Storage key"),
    value: z.string().describe("Value to store"),
  },
  async (args) => {
    _assertTabOwnership("set_local_storage");
    const result = await safari.setLocalStorage(args);
    return textResult(result);
  }
);

// ========== STORAGE DELETE / CLEAR ==========

server.tool(
  "safari_delete_local_storage",
  "Delete a localStorage key, or clear all localStorage (omit key to clear all)",
  { key: z.string().optional().describe("Key to delete (omit to clear ALL)") },
  async ({ key }) => {
    _assertTabOwnership("delete_local_storage");
    const result = await safari.deleteLocalStorage({ key });
    return textResult(result);
  }
);

server.tool(
  "safari_delete_session_storage",
  "Delete a sessionStorage key, or clear all sessionStorage (omit key to clear all)",
  { key: z.string().optional().describe("Key to delete (omit to clear ALL)") },
  async ({ key }) => {
    _assertTabOwnership("delete_session_storage");
    const result = await safari.deleteSessionStorage({ key });
    return textResult(result);
  }
);

// ========== STORAGE STATE EXPORT/IMPORT ==========

server.tool(
  "safari_export_storage",
  "Export all storage state (cookies + localStorage + sessionStorage) as JSON — useful for saving and restoring login sessions",
  {},
  async () => {
    const result = await safari.exportStorageState();
    return textResult(result);
  }
);

server.tool(
  "safari_import_storage",
  "Import storage state from JSON (as exported by safari_export_storage) — restores cookies, localStorage, sessionStorage",
  { state: z.string().describe("JSON string from safari_export_storage") },
  async ({ state }) => {
    _assertTabOwnership("import_storage");
    const result = await safari.importStorageState({ state });
    return textResult(result);
  }
);

// ========== CLIPBOARD ==========

server.tool(
  "safari_clipboard_read",
  "Read the current clipboard content (text)",
  {},
  async () => {
    const result = await safari.clipboardRead();
    return textResult(result);
  }
);

server.tool(
  "safari_clipboard_write",
  "Write text to the system clipboard",
  { text: z.string().describe("Text to copy to clipboard") },
  async (args) => {
    const result = await safari.clipboardWrite(args);
    return textResult(result);
  }
);

// ========== NETWORK MOCKING ==========

server.tool(
  "safari_mock_route",
  "Intercept network requests matching a URL pattern and return a mock response. Works with both fetch and XHR. Useful for testing API error states, offline behavior, or replacing API responses.",
  {
    urlPattern: z.string().describe("URL substring or regex pattern to match (e.g. '/api/users' or 'example\\.com')"),
    response: z.object({
      status: z.coerce.number().optional().describe("HTTP status code (default: 200)"),
      body: z.string().optional().describe("Response body string (JSON, HTML, text)"),
      contentType: z.string().optional().describe("Content-Type header (default: application/json)"),
    }).describe("Mock response to return"),
  },
  async ({ urlPattern, response }) => {
    _assertTabOwnership("mock_route");
    const result = await safari.mockNetworkRoute({ urlPattern, response });
    return textResult(result);
  }
);

server.tool(
  "safari_clear_mocks",
  "Remove all network route mocks (restore real network behavior)",
  {},
  async () => {
    const result = await safari.clearNetworkMocks();
    return textResult(result);
  }
);

// ========== WAIT FOR TIME ==========

server.tool(
  "safari_wait",
  "Wait for a fixed time in milliseconds. Use only when you need a brief pause between actions. PREFER safari_wait_for (waits for element/text to appear) — it's smarter and doesn't waste time.",
  { ms: z.coerce.number().describe("Milliseconds to wait") },
  async ({ ms }) => {
    const result = await safari.waitForTime({ ms });
    return textResult(result);
  }
);

// ========== NETWORK CAPTURE (Detailed) ==========

server.tool(
  "safari_start_network_capture",
  "Start capturing detailed network requests (fetch + XHR) with headers, status, timing. Call once per page. Intercepts fetch/XHR — captures requests AFTER this call only. For quick overview of already-loaded resources, use safari_network instead.",
  {},
  async () => {
    const result = await safari.startNetworkCapture();
    return textResult(result);
  }
);

server.tool(
  "safari_network_details",
  "Get captured network requests with full details (must call safari_start_network_capture first)",
  {
    limit: z.coerce.number().optional().describe("Max requests (default: 50)"),
    filter: z.string().optional().describe("Filter by URL substring"),
  },
  async (args) => {
    const result = await safari.getNetworkDetails(args);
    return textResult(result);
  }
);

server.tool(
  "safari_clear_network",
  "Clear all captured network requests",
  {},
  async () => {
    const result = await safari.clearNetworkCapture();
    return textResult(result);
  }
);

// ========== PERFORMANCE METRICS ==========

server.tool(
  "safari_performance_metrics",
  "Get detailed performance metrics: navigation timing, Web Vitals (FCP, LCP, CLS), resource breakdown, memory usage",
  {},
  async () => {
    const result = await safari.getPerformanceMetrics();
    return textResult(result);
  }
);

// ========== NETWORK THROTTLING ==========

server.tool(
  "safari_throttle_network",
  "Simulate slow network conditions. Profiles: slow-3g, fast-3g, 4g, offline. Or custom latency/speed. Call with no args to reset.",
  {
    profile: z.string().optional().describe("Preset: slow-3g, fast-3g, 4g, offline"),
    latency: z.coerce.number().optional().describe("Custom latency in ms"),
    downloadKbps: z.coerce.number().optional().describe("Custom download speed in Kbps"),
  },
  async (args) => {
    _assertTabOwnership("throttle");
    const result = await safari.throttleNetwork(args);
    return textResult(result);
  }
);

// ========== CONSOLE FILTER ==========

server.tool(
  "safari_console_filter",
  "Get console messages filtered by level (must call safari_start_console first)",
  { level: z.enum(["log", "warn", "error", "info"]).describe("Console level to filter") },
  async (args) => {
    const result = await safari.getConsoleByLevel(args);
    return textResult(result);
  }
);

// ========== DATA EXTRACTION ==========

server.tool(
  "safari_extract_tables",
  "Extract HTML tables as structured JSON (headers + rows). Perfect for scraping data tables.",
  {
    selector: z.string().optional().describe("CSS selector (default: 'table')"),
    limit: z.coerce.number().optional().describe("Max tables (default: 10)"),
  },
  async (args) => {
    const result = await safari.extractTables(args);
    return textResult(result);
  }
);

server.tool(
  "safari_extract_meta",
  "Extract all meta tags: title, description, canonical, OG tags, Twitter cards, JSON-LD, alternate languages, RSS feeds",
  {},
  async () => {
    const result = await safari.extractMeta();
    return textResult(result);
  }
);

server.tool(
  "safari_extract_images",
  "Extract all images with src, alt, dimensions, loading strategy, viewport visibility",
  { limit: z.coerce.number().optional().describe("Max images (default: 50)") },
  async (args) => {
    const result = await safari.extractImages(args);
    return textResult(result);
  }
);

server.tool(
  "safari_extract_links",
  "Extract all links with href, text, rel, target, external/nofollow detection",
  {
    limit: z.coerce.number().optional().describe("Max links (default: 100)"),
    filter: z.string().optional().describe("Filter by URL or text substring"),
  },
  async (args) => {
    const result = await safari.extractLinks(args);
    return textResult(result);
  }
);

// ========== GEOLOCATION OVERRIDE ==========

server.tool(
  "safari_override_geolocation",
  "Override the browser's geolocation API to return custom coordinates",
  {
    latitude: z.coerce.number().describe("Latitude (-90 to 90)"),
    longitude: z.coerce.number().describe("Longitude (-180 to 180)"),
    accuracy: z.coerce.number().optional().describe("Accuracy in meters (default: 100)"),
  },
  async (args) => {
    _assertTabOwnership("override_geolocation");
    const result = await safari.overrideGeolocation(args);
    return textResult(result);
  }
);

// ========== COMPUTED STYLES ==========

server.tool(
  "safari_get_computed_style",
  "Get computed CSS styles for an element. Optionally filter specific properties.",
  {
    selector: z.string().describe("CSS selector"),
    properties: z.array(z.string()).optional().describe("Specific CSS properties to get (e.g. ['color', 'font-size'])"),
  },
  async (args) => {
    const result = await safari.getComputedStyles(args);
    return textResult(result);
  }
);

// ========== INDEXEDDB ==========

server.tool(
  "safari_list_indexed_dbs",
  "List all IndexedDB databases on the current page",
  {},
  async () => {
    const result = await safari.listIndexedDBs();
    return textResult(result);
  }
);

server.tool(
  "safari_get_indexed_db",
  "Read records from an IndexedDB database store",
  {
    dbName: z.string().describe("Database name"),
    storeName: z.string().describe("Object store name"),
    limit: z.coerce.number().optional().describe("Max records (default: 20)"),
  },
  async (args) => {
    const result = await safari.getIndexedDB(args);
    return textResult(result);
  }
);

// ========== CSS COVERAGE ==========

server.tool(
  "safari_css_coverage",
  "Analyze CSS coverage: find unused CSS rules across all stylesheets. Shows coverage percentage per stylesheet.",
  {},
  async () => {
    const result = await safari.getCSSCoverage();
    return textResult(result);
  }
);

// ========== WEBKIT / iOS WEB-DEV VALIDATION ==========

server.tool(
  "safari_inspect_viewport",
  "Validate the page's <meta name=viewport> against iOS Safari best practices: width=device-width, initial-scale, disabled-zoom (WCAG 1.4.4), viewport-fit=cover. Returns parsed attributes + severity-tagged issues (error/warning/info).",
  {},
  async () => {
    const result = await safari.inspectViewport();
    return textResult(result);
  }
);

server.tool(
  "safari_safe_area_insets",
  "Read the live CSS safe-area-inset values (top/right/bottom/left) as the page sees them, whether viewport-fit=cover is set, and whether env(safe-area-inset-*) is used in any stylesheet. For notch / Dynamic Island layout debugging.",
  {},
  async () => {
    const result = await safari.getSafeAreaInsets();
    return textResult(result);
  }
);

server.tool(
  "safari_check_pwa",
  "Audit the page for iOS 'Add to Home Screen' / PWA readiness: apple-mobile-web-app-capable, apple-touch-icon (incl. 180x180), theme-color, status-bar style, web app manifest, splash screens. Returns a pass/total checklist.",
  {},
  async () => {
    const result = await safari.checkPWA();
    return textResult(result);
  }
);

server.tool(
  "safari_webkit_compat",
  "Check every CSS property used on the page against THIS Safari via CSS.supports() — reports unsupported properties, properties that need a -webkit- prefix, and known Safari rendering quirks (e.g. position:sticky inside overflow ancestors). Tested in the live engine, so no false positives.",
  {},
  async () => {
    const result = await safari.checkWebKitCompat();
    return textResult(result);
  }
);

// ========== DIAGNOSTICS ==========

server.tool(
  "safari_doctor",
  "Diagnose the macOS permission + daemon chain in one shot: Safari running, Apple Events/Automation, native helper daemon, Accessibility (native clicks), Screen Recording, and the helper's codesign identity. Returns a pass/fail checklist with the exact System Settings fix per failure. Run this FIRST when clicks/screenshots/startup 'don't work even with permissions granted'.",
  {},
  async () => {
    const result = await safari.doctor();
    return textResult(result);
  }
);

// ========== FORM AUTO-DETECT ==========

server.tool(
  "safari_detect_forms",
  "Auto-detect all forms on the page with their fields, types, selectors, and submit buttons. Great for automated form filling.",
  {},
  async () => {
    const result = await safari.detectForms();
    return textResult(result);
  }
);

// ========== SCROLL TO ELEMENT ==========

server.tool(
  "safari_scroll_to_element",
  "Scroll to element by CSS selector OR text. For virtual DOM (Airtable) use text — scrolls down until text appears in DOM.",
  {
    selector: z.string().optional().describe("CSS selector of target element"),
    text: z.string().optional().describe("Text to find — scrolls down until it appears (for virtual DOM/lazy loading)"),
    block: z.enum(["start", "center", "end", "nearest"]).optional().describe("Scroll alignment (default: center)"),
    timeout: z.coerce.number().optional().describe("Max time to scroll in ms (default: 10000)"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "scroll_to_element",
      { selector: args.selector, text: args.text, block: args.block },
      () => safari.scrollToElement(args)
    );
    return textResult(result);
  }
);

// ========== COMBO TOOLS (fast multi-step operations) ==========

server.tool(
  "safari_click_and_wait",
  "Click an element AND wait for the result (page load or element). Use instead of click + wait_for separately.",
  {
    selector: z.string().optional().describe("CSS selector to click"),
    text: z.string().optional().describe("Visible text to click"),
    waitFor: z.string().optional().describe("CSS selector to wait for after click"),
    timeout: z.coerce.number().optional().describe("Wait timeout in ms (default: 10000)"),
  },
  async (args) => {
    _assertTabOwnership("click_and_wait");
    const result = await safari.clickAndWait(args);
    return textResult(result);
  }
);

server.tool(
  "safari_fill_and_submit",
  "Fill a form AND submit it in one operation. Finds submit button automatically if not specified.",
  {
    fields: z.array(z.object({
      selector: z.string().describe("CSS selector"),
      value: z.string().describe("Value to fill"),
    })).describe("Fields to fill"),
    submitSelector: z.string().optional().describe("Submit button selector (auto-detected if omitted)"),
  },
  async (args) => {
    _assertTabOwnership("fill_and_submit");
    const result = await safari.fillAndSubmit(args);
    return textResult(result);
  }
);

server.tool(
  "safari_analyze_page",
  "Full page analysis in ONE call: title, URL, meta tags, OG, headings, link stats, image stats, forms, and text preview. Perfect for SEO/audit.",
  {},
  async () => {
    const result = await safari.analyzePage();
    return textResult(result);
  }
);

  // HTTP mode builds one server per session; the daily state file keeps the banner
  // to once a day anyway, and this flag keeps it to once a process.
  if (!_bannerShown) { _bannerShown = true; _showStartupBanner(server); }
  return server;
}
let _bannerShown = false;

// ========== START SERVER ==========

// One-time-per-day startup banner — visible CTA without spamming MCP logs.
// Stderr only (stdout is reserved for MCP protocol). Skipped if SAFARI_MCP_QUIET=1.
//
// Takes the server it should count tools from: `server` is a local of buildServer(),
// so reading it at module scope threw a ReferenceError that this function's own
// best-effort catch swallowed — the banner printed nothing at all from v2.16.2 until
// this was fixed. Called from buildServer(), which is the first point an instance exists.
function _showStartupBanner(server) {
try {
  if (process.env.SAFARI_MCP_QUIET !== "1") {
    const bannerStateFile = join(homedir(), ".safari-mcp", "last-banner");
    if (!existsSync(OWNERSHIP_DIR)) mkdirSync(OWNERSHIP_DIR, { recursive: true });
    let lastShown = 0;
    try { lastShown = parseInt(readFileSync(bannerStateFile, "utf8"), 10) || 0; } catch {}
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - lastShown > ONE_DAY_MS) {
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
      let version = "?";
      try { version = JSON.parse(readFileSync(pkgPath, "utf8")).version; } catch {}
      console.error("");
      // Count tools at runtime — a hardcoded number here drifted to 96 while the code had 97.
      const toolCount = Object.keys(server._registeredTools ?? {}).length;
      const toolsPhrase = toolCount ? `${toolCount} tools, ` : "";
      console.error(`[Safari MCP] 🦁 v${version} ready — ${toolsPhrase}native WebKit, zero Chrome.`);
      console.error(`[Safari MCP] ⭐ Like it? Star: https://github.com/achiya-automation/safari-mcp`);
      console.error("");
      try { writeFileSync(bannerStateFile, String(Date.now()), { mode: 0o600 }); } catch {}
    }
  }
} catch { /* banner is best-effort, never block startup */ }
}

_startMemoryMonitor();

// Runtime guard for the silent stale-identity regression (#29): postinstall re-signs the
// helper to a stable id so the Accessibility grant persists, but `npm ci`, `--ignore-scripts`,
// Docker and Smithery installs skip postinstall entirely — leaving the swiftc one-off id and
// a grant that breaks invisibly. Warn once on stderr (non-blocking) so it's diagnosable.
(function warnIfHelperIdentityDrifted() {
  try {
    if (process.platform !== "darwin") return;
    const helper = join(dirname(fileURLToPath(import.meta.url)), "safari-helper");
    if (!existsSync(helper)) return;
    execFile("codesign", ["-d", "--verbose=2", helper], { timeout: 4000 }, (_err, stdout, stderr) => {
      const text = (stdout || "") + (stderr || "");
      if (text && !/Identifier=com\.achiya-automation\.safari-mcp/.test(text)) {
        console.error("[Safari MCP] ⚠ safari-helper codesign identity is not the stable id — native clicks may silently fail. Run the safari_doctor tool to diagnose.");
      }
    });
  } catch { /* best-effort, never block startup */ }
})();

// Transport is chosen at runtime: default stdio (unchanged), or a shared HTTP instance when
// SAFARI_MCP_HTTP=1 (many Claude sessions → one process). buildServer is the per-session factory.
const transportHandle = await startTransport(buildServer, process.env);

if (transportHandle.kind === "stdio") {
  // A client can disappear without delivering a signal. Treat its pipe closing as the stdio
  // server's lifecycle boundary, while leaving the opt-in HTTP daemon independent of stdin.
  process.stdin.once("end", _shutdown);
  process.stdin.once("close", _shutdown);
  if (process.stdin.readableEnded || process.stdin.destroyed) void _shutdown();
}
