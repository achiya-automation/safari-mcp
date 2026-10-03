// Safari automation layer — dual engine:
// 1. Extension (WebSocket) — fastest (~5ms), native browser API, keeps logins
// 2. AppleScript + Swift daemon (~5ms) — keeps logins, always available
// Extension is preferred. AppleScript is fallback when extension is not connected.

import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { readFile, writeFile, unlink, appendFile, mkdir } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { VIEWPORT_SCRIPT, SAFE_AREA_SCRIPT, PWA_SCRIPT, WEBKIT_COMPAT_SCRIPT, ALL_SHEETS_FN } from "./injected-validators.js";
import { escJsSingleQuote, escAppleScriptString } from "./injected-escape.js";
import { currentSessionId } from "./session-context.js";
import { allowUserTabs } from "./ownership-state.js";
// Extension bridge is handled by index.js (WebSocket server on port 9223)

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
// ========== STRING ESCAPING (single source of truth) ==========
// Escaping ORDER is security-relevant: the backslash MUST be escaped before the quote, or the
// backslash inserted in front of the quote gets doubled and the string breaks out. These helpers
// replace ~70 hand-inlined copies of the same recipe — fix the escaping once here, not at every
// call site. Verified equivalent to the inline pattern by test/escaping.test.mjs.

// Escaping helpers now live in ./injected-escape.js (pure + test-locked). Imported above
// for internal use; re-exported here so existing `from "./safari.js"` imports keep working.
export { escJsSingleQuote, escAppleScriptString };

// ========== SWIFT HELPER DAEMON ==========
// Persistent process — no subprocess spawn overhead (~5ms vs ~90ms)
let _helperProc = null;
const _helperQueue = []; // callbacks waiting for responses
let _helperConsecutiveTimeouts = 0; // Track consecutive timeouts — kill threshold lives where it's checked (currently 5)

// ── Helper request correlation ────────────────────────────────────────────
// The Swift helper finishes requests out of order on purpose: a native click must
// not wait behind a slow `do JavaScript`. Responses used to be matched to callbacks
// by FIFO queue position, which is correct ONLY with one request in flight — so a
// mutex serialized every round-trip. That mutex was also the ceiling: one heavy page
// froze every other check in the session for as long as it took, and a second Safari
// session looked completely dead meanwhile.
//
// Each request now carries an id the daemon echoes back, so replies are matched by
// identity and may overtake each other freely. The FIFO queue stays as the fallback
// path for a daemon binary older than this protocol (it echoes no id), and the mutex
// stays engaged until the running daemon has proven it speaks ids.
let _helperSeq = 0;
const _helperPending = new Map(); // request id → callback
let _helperSupportsIds = false;   // flipped by the first id-matched reply

function _helperLine(payload, cb) {
  const id = "r" + ++_helperSeq;
  cb.__helperId = id;
  _helperPending.set(id, cb);
  return JSON.stringify({ ...payload, id }) + "\n";
}

function _forgetHelperCb(cb) {
  if (cb?.__helperId) _helperPending.delete(cb.__helperId);
}

let _helperLock = Promise.resolve();
function _withHelperLock(makePromise) {
  // Correlation by id makes serialization unnecessary — this is the line that lets
  // several checks run at once. Until the daemon proves it echoes ids, stay serial:
  // FIFO matching is only honest with a single request in flight.
  if (_helperSupportsIds) return Promise.resolve().then(makePromise);
  const result = _helperLock.then(makePromise, makePromise);
  _helperLock = result.then(() => {}, () => {});
  return result;
}

// A timed-out request keeps its slot: the daemon may still answer, and that late
// reply is proof of life. Swap both trackers to the replacement consumer so the FIFO
// queue stays aligned AND the id still resolves to something.
function _replaceHelperCb(cb, consumer) {
  const idx = _helperQueue.indexOf(cb);
  if (idx >= 0) _helperQueue[idx] = consumer;
  if (cb?.__helperId) {
    consumer.__helperId = cb.__helperId;
    _helperPending.set(cb.__helperId, consumer);
  }
}

// The write never reached the daemon, so no reply is coming for this request.
function _dropHelperCb(cb) {
  const idx = _helperQueue.indexOf(cb);
  if (idx >= 0) _helperQueue.splice(idx, 1);
  _forgetHelperCb(cb);
}

// Reject all pending callbacks when helper crashes
function _drainHelperQueue(reason) {
  const pending = [..._helperPending.values()];
  _helperPending.clear();
  while (_helperQueue.length > 0) {
    const cb = _helperQueue.shift();
    if (cb) {
      const idx = pending.indexOf(cb);
      if (idx >= 0) pending.splice(idx, 1);
      cb(JSON.stringify({ error: reason }));
    }
  }
  // Callbacks tracked only by id (the queue entry was already consumed) still need
  // their rejection, or their caller hangs until its own timeout fires.
  for (const cb of pending) cb(JSON.stringify({ error: reason }));
}

function startHelper() {
  if (_helperProc) return; // idempotent — a respawn already won the race; don't orphan a daemon
  const helperPath = join(__dirname, "safari-helper");
  try {
    _helperProc = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] });
    let _buf = "";
    _helperProc.stdout.on("data", (chunk) => {
      _buf += chunk.toString();
      const lines = _buf.split("\n");
      _buf = lines.pop(); // Keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        let replyId = null;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed.id === "string") replyId = parsed.id;
        } catch { /* not JSON — fall through to arrival order */ }

        const keyed = replyId ? _helperPending.get(replyId) : null;
        if (keyed) {
          _helperPending.delete(replyId);
          const qi = _helperQueue.indexOf(keyed);
          if (qi >= 0) _helperQueue.splice(qi, 1);
          _helperSupportsIds = true; // this daemon speaks the correlated protocol
          keyed(line);
          continue;
        }

        // Legacy daemon, or a reply whose request already timed out.
        const cb = _helperQueue.shift();
        if (cb) { _forgetHelperCb(cb); cb(line); }
      }
    });
    _helperProc.on("error", () => { _drainHelperQueue("helper process error"); _helperProc = null; _scheduleRestart(); });
    _helperProc.on("exit", (code) => { _drainHelperQueue("helper process exited (code " + code + ")"); _helperProc = null; _scheduleRestart(); });
  } catch {
    _helperProc = null;
  }
}

startHelper();

// ========== AUTO-RESTART: recover from helper crashes ==========
let _restartCount = 0;
let _restartTimer = null;
let _shuttingDown = false;

function _scheduleRestart() {
  if (_shuttingDown || _restartTimer) return;
  _restartCount++;
  // Exponential backoff: 500ms, 1s, 2s, 4s, max 10s
  const delay = Math.min(500 * Math.pow(2, _restartCount - 1), 10000);
  console.error(`safari-helper crashed (restart #${_restartCount}, retrying in ${delay}ms)`);
  _restartTimer = setTimeout(() => {
    _restartTimer = null;
    if (!_shuttingDown && !_helperProc) {
      startHelper();
      // Reset restart count after 60s of stability
      setTimeout(() => { if (_helperProc) _restartCount = 0; }, 60000);
    }
  }, delay);
}

// ========== CLEANUP: kill helper when parent process exits ==========
// Without this, safari-helper processes accumulate as zombies when MCP restarts
function cleanupHelper() {
  _shuttingDown = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_helperProc) {
    try { _helperProc.kill("SIGTERM"); } catch (_) {}
    _helperProc = null;
  }
}
// Signal handlers (SIGINT/SIGTERM/SIGHUP) are registered in index.js only.
// cleanupHelper runs via process.on("exit"), which fires when index.js calls process.exit().
process.on("exit", cleanupHelper);
process.on("uncaughtException", (err) => { console.error("Uncaught:", err); cleanupHelper(); process.exit(1); });
// Unhandled promise rejections must NOT terminate the server. A single failed
// async operation — e.g. a proxy fetch to the primary instance while it is
// mid-restart, or an aborted fetch timeout — would otherwise bubble to the
// uncaughtException handler above (Node's default for unhandled rejections) and
// exit the whole MCP process, disconnecting every concurrent session. Log and
// continue: the failed operation is localized, the process itself is healthy.
process.on("unhandledRejection", (reason) => {
  console.error("[Safari MCP] Unhandled rejection (non-fatal, continuing):", (reason && reason.stack) || reason);
});

// ========== SAFARI RUNNING CHECK ==========
// Prevent AppleScript from auto-launching Safari when it's closed
// ponytail: a "running" answer is reused for 1s — AppleScript waits poll every 100–200ms and each
// call spawned a pgrep. Ceiling: a Safari quit inside that second can let one script relaunch it.
let _safariRunningUntil = 0;
async function isSafariRunning() {
  if (Date.now() < _safariRunningUntil) return true;
  try {
    const { stdout } = await execFileAsync("pgrep", ["-x", "Safari"], { timeout: 2000 });
    const running = stdout.trim().length > 0;
    if (running) _safariRunningUntil = Date.now() + 1000;
    return running;
  } catch {
    return false; // pgrep exits 1 when no match
  }
}

function safariNotRunningError() {
  return new Error("Safari is not running. Open Safari manually before using Safari MCP tools.");
}

// ========== CLIPBOARD LOCK ==========
// Prevents concurrent clipboard operations from clobbering the user's clipboard.
// While locked, any new clipboard operation waits until the current one completes.
let _clipboardLocked = false;
let _clipboardRestoreTimer = null;
let _pendingClipboardRestore; // content stashed for a synchronous flush on shutdown (see flushClipboardRestore)

async function _acquireClipboardLock(timeoutMs = 10000) {
  const start = Date.now();
  while (_clipboardLocked) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Clipboard lock timeout — another operation is still using the clipboard. Try again shortly.");
    }
    await new Promise(r => setTimeout(r, 50));
  }
  _clipboardLocked = true;
}

function _releaseClipboardLock() {
  _clipboardLocked = false;
}

// Save current clipboard and return it for later restore
async function _saveClipboard() {
  try {
    const { stdout } = await execFileAsync("pbpaste", []);
    return stdout;
  } catch { return null; }
}

// Write text to the macOS clipboard via pbcopy. Single place that handles EPIPE on the stdin
// stream (pbcopy exiting before it reads) — an unhandled 'error' there would otherwise reach
// uncaughtException and kill the whole server.
function _pbcopy(text) {
  return new Promise((resolve, reject) => {
    const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    proc.stdin.on("error", reject);
    proc.on("error", reject);
    proc.on("close", resolve);
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

// Restore clipboard immediately (no async setTimeout leak)
async function _restoreClipboard(savedContent) {
  if (savedContent === null) return;
  try {
    await _pbcopy(savedContent);
  } catch {}
}

// ========== ACTIVE TAB TRACKING ==========
// Instead of visually switching tabs (which interrupts the user),
// we track which tab we're "working on" by URL (not index, because indices shift
// when the user opens/closes tabs). Before each operation we resolve the URL
// to the current index.
// ── Per-session tab state (see session-context.js) ──────────────────────────
// Was six module-global `let`s. In HTTP-daemon mode one process serves many Claude
// sessions and they overwrote each other's tab pointer → operations drifted onto the
// wrong (often the user's) tab. Now keyed per MCP session via _st(). Field notes:
//   activeTabIndex  — null = use front document (default)
//   activeTabURL    — URL-based tracking (stable even when tabs shift)
//   hasOwnedTab     — once true (after the session's first tab, whether AppleScript or the
//                     extension opened or picked it), write ops
//                     (navigate/click/fill) MUST NOT fall back to "current tab of window"
//                     (the USER'S tab). The 30s grace window was insufficient — tracking
//                     can be lost late in a session (e.g. tab ghost recovery in runJS);
//                     silent fallback overwrote the user's working tab in past incidents.
//   lastResolveTime — cache: skip resolve if verified recently
//   lastTabCount    — track tab count for smart cache invalidation
//   activeTabMarker — window.__mcpTabMarker; survives same-tab navigation, bulletproof id
//   markerId        — per-session unique id baked into the marker string
//   tabFromExtension — the current tab is one the Safari extension opened or picked, so only
//                     the extension can put the marker on it (see resolveActiveTab)
//   marking         — that request while it runs, shared by parallel calls
const _sessions = new Map();
function _st() {
  const sid = currentSessionId();
  let s = _sessions.get(sid);
  if (!s) {
    s = { activeTabIndex: null, activeTabURL: null, hasOwnedTab: false,
          lastResolveTime: 0, lastTabCount: null, activeTabMarker: null,
          tabFromExtension: false, marking: null, markerId: randomUUID().slice(0, 8) };
    _sessions.set(sid, s);
  }
  return s;
}
export function _dropSession(sid) { _sessions.delete(sid); } // called on MCP session close
const RESOLVE_CACHE_MS = 100; // Brief cache — was 500, reduced to catch tabs added by user/popups (v2.8.3 fix)

// ========== DIAGNOSTIC LOG ==========
// File-based log for profile/focus issues — survives MCP restart, visible to user
const _LOG_FILE = '/tmp/safari-mcp-profile.log';
function _logProfile(msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const line = `[${ts}] ${msg}\n`;
  console.error(`[Safari MCP] ${msg}`);
  appendFile(_LOG_FILE, line).catch(() => {});
}

// ========== PROFILE TARGETING ==========
// Set SAFARI_PROFILE env var to target a specific Safari profile window.
// Safari shows profile windows as: "ProfileName — Tab Title"
const SAFARI_PROFILE = process.env.SAFARI_PROFILE || null;
let _targetWindowRef = null; // null = not yet discovered. Updated by refreshTargetWindow()
let _targetWindowId = null;  // Numeric window ID (for CGEvent window targeting)
let _targetWindowCacheTime = 0;
const TARGET_WINDOW_CACHE_MS = 1000; // Short cache — fast detection of window changes
let _profileWindowMissing = false; // True when profile window is not found
let _focusGuardActive = false; // True when an outer caller already handles focus save/restore

// Get the target window ref, falling back to 'front window' ONLY when no profile is configured
function getTargetWindowRef() {
  if (SAFARI_PROFILE) {
    if (!_targetWindowRef) {
      throw new Error(`Safari profile "${SAFARI_PROFILE}" window not found. Open the "${SAFARI_PROFILE}" profile in Safari first.`);
    }
    return _targetWindowRef;
  }
  return _targetWindowRef || 'front window';
}

// Consecutive failed profile-window detections (#81) — drives the poll backoff,
// the subprocess-fallback cutoff, and the missing-window log rate limit.
let _profileMisses = 0;
let _lastMissingLogTime = 0;

async function refreshTargetWindow(force = false) {
  if (!SAFARI_PROFILE) return;
  const now = Date.now();
  if (!force && _targetWindowRef && (now - _targetWindowCacheTime) < TARGET_WINDOW_CACHE_MS) return;
  const safeProfile = SAFARI_PROFILE.replace(/"/g, '\\"');
  // Find profile window by name AND verify the window ID still matches
  const detectScript = `tell application "Safari"\n  repeat with w in every window\n    if name of w starts with "${safeProfile} \u2014" then return (id of w as text) & "|" & name of w\n  end repeat\n  return "0|"\nend tell`;
  let result = await osascriptFast(detectScript).catch(() => '0|');
  // The persistent helper occasionally returns '0|' for a window that genuinely
  // exists (daemon timeout / restart race). Before concluding the window is
  // missing, retry once with a plain osascript subprocess \u2014 slower but reliable.
  // Once consecutive misses have established the window is genuinely ABSENT
  // (not flakily undetected), skip the subprocess retry — an absent window
  // returns '0|' every cycle, so the fallback would otherwise spawn an
  // osascript process per poll, forever (#81). The first successful detection
  // re-arms it for the flaky-helper case it was added for.
  if (String(result).split('|')[0] === '0' && _profileMisses < 3) {
    result = await osascript(detectScript).catch(() => '0|');
  }
  const [idStr, windowName] = String(result).split('|');
  const id = Number(idStr);
  if (id > 0) {
    const newRef = `window id ${id}`;
    if (_targetWindowRef && _targetWindowRef !== newRef) {
      _logProfile(`Profile window changed: ${_targetWindowRef} → ${newRef} ("${windowName}")`);
    }
    _targetWindowRef = newRef;
    _targetWindowId = id;
    _targetWindowCacheTime = now;
    _profileWindowMissing = false;
    _profileMisses = 0;
  } else {
    // Profile window not found — clear ref so getTargetWindowRef() will throw
    _targetWindowRef = null;
    _targetWindowId = null;
    _targetWindowCacheTime = 0;
    _profileWindowMissing = true;
    _profileMisses++;
    _maybeOpenProfileWindow();
    // Log on transition into the missing state, then at most once per 5 minutes —
    // this steady state used to append one line per poll, unbounded (#81).
    if (_profileMisses === 1 || now - _lastMissingLogTime > 300000) {
      _lastMissingLogTime = now;
      _logProfile(`WARNING: Profile "${SAFARI_PROFILE}" window not found — refusing to use front window`);
    }
  }
}

// ponytail: opt-in self-heal for the "profile window is closed" steady state (198 refusals in
// one log, every morning after a reboot). SAFARI_MCP_OPEN_WINDOW_CMD is run with the profile
// name once absence is established (3 consecutive misses), at most every 2 minutes; the poll
// below then rediscovers the window. The command must open the window WITHOUT focusing
// Safari (e.g. ~/bin/safari-bg-window, which presses the File-menu item via Accessibility).
const OPEN_WINDOW_CMD = process.env.SAFARI_MCP_OPEN_WINDOW_CMD || "";
let _lastOpenWindowAttempt = 0;
function _maybeOpenProfileWindow() {
  if (!OPEN_WINDOW_CMD || !SAFARI_PROFILE || _profileMisses < 3) return;
  const now = Date.now();
  if (now - _lastOpenWindowAttempt < 120000) return;
  _lastOpenWindowAttempt = now;
  _logProfile(`Profile "${SAFARI_PROFILE}" window absent — running ${OPEN_WINDOW_CMD}`);
  // The opener presses a File-menu item, which needs Safari running and NOT hidden
  // (`open -g -j` leaves the menu bar inaccessible). Launch it in the background first.
  const ensureRunning = execFileAsync("/usr/bin/pgrep", ["-x", "Safari"]).then(() => null, () =>
    execFileAsync("/usr/bin/open", ["-g", "-a", "Safari"])
      .then(() => new Promise((r) => setTimeout(r, 5000)))
      .catch(() => null));
  ensureRunning
    .then(() => execFileAsync(OPEN_WINDOW_CMD, [SAFARI_PROFILE], { timeout: 30000 }))
    .then(() => {
      _profileMisses = 0; // re-arm the subprocess retry for the fresh window
      setTimeout(() => { refreshTargetWindow(true).catch(() => {}); }, 3000).unref();
    })
    .catch((err) => _logProfile(`Open-window command failed: ${err.message}`));
}

// Background verification: periodically check that cached window ID still belongs to profile
if (SAFARI_PROFILE) {
  // Self-scheduling poll with exponential backoff (#81): 15s while the window is
  // present (or flakily undetected), doubling per consecutive miss up to 60s
  // while it is absent — a closed profile window is a steady state, and the
  // fixed 3s cadence used to spawn an osascript subprocess per cycle, forever.
  // The first successful detection resets to 15s, so rediscovery stays
  // responsive: once the user opens the window, the next poll lands within 60s
  // and everything after it is back on the 15s cadence. This poll is only the
  // background self-heal: every AppleScript caller re-validates the window itself
  // (refreshTargetWindow, 1s cache), so 3s cost a pgrep + an Apple Event to
  // Safari every 3 seconds per daemon for nothing.
  const _POLL_BASE_MS = 15000;
  const _POLL_MAX_MS = 60000;
  const _pollOnce = async () => {
    // No cached window (e.g. flaky detection at startup) — keep trying to
    // rediscover it so the server self-heals instead of staying stuck.
    if (!_targetWindowRef || !_targetWindowId) {
      await refreshTargetWindow(true).catch(() => {});
      return;
    }
    try {
      // Read-only window-name query — opt out of focus-guard so a rare
      // user-app-switch race never triggers the hide-fallback against them.
      const name = await osascriptFast(
        `tell application "Safari" to return name of ${_targetWindowRef}`,
        { noFocusGuard: true }
      ).catch(() => '');
      if (name && !name.startsWith(`${SAFARI_PROFILE} \u2014`)) {
        // Window ID no longer belongs to profile — invalidate cache immediately
        _logProfile(`SAFETY: Window ${_targetWindowRef} no longer belongs to profile "${SAFARI_PROFILE}" (name: "${name}") — invalidating`);
        _targetWindowRef = null;
        _targetWindowId = null;
        _targetWindowCacheTime = 0;
        _profileWindowMissing = true;
        // Try to rediscover immediately
        await refreshTargetWindow(true);
      }
    } catch {
      // Window might have been closed — invalidate and rediscover
      _targetWindowRef = null;
      _targetWindowId = null;
      _targetWindowCacheTime = 0;
      await refreshTargetWindow(true);
    }
  };
  const _schedulePoll = () => {
    const delay =
      _profileMisses > 0
        ? Math.min(_POLL_BASE_MS * 2 ** Math.min(_profileMisses, 5), _POLL_MAX_MS)
        : _POLL_BASE_MS;
    setTimeout(async () => {
      await _pollOnce().catch(() => {});
      _schedulePoll();
    }, delay);
  };
  _schedulePoll();
}

// Initialize profile window at startup (ES module top-level await)
if (SAFARI_PROFILE) {
  // Run profile-window detection off the critical path so module init — and
  // therefore the MCP initialize handshake — completes immediately. Tool calls
  // that arrive before this finishes already trigger lazy refresh via
  // getTargetWindowRef(), so correctness is preserved.
  // Why this matters: a blocking `await refreshTargetWindow(true)` here could
  // run >30s when Safari was busy or AppleScript was stalled, tripping Claude
  // Code's 30s MCP timeout and leaving the conversation's tool catalog without
  // safari tools until a new conversation is started.
  (async () => {
    await new Promise(r => setTimeout(r, 50)); // Let helper process initialize
    await refreshTargetWindow(true);
    if (_targetWindowRef) {
      _logProfile(`Startup: Profile "${SAFARI_PROFILE}" → targeting ${_targetWindowRef}`);
    } else {
      _logProfile(`WARNING: Profile "${SAFARI_PROFILE}" window NOT found at startup`);
    }
  })();
}

// Detect stale window ID errors and invalidate cache
function isStaleWindowError(err) {
  const msg = (err && (err.message || err.stderr || String(err))) || '';
  return /window id \d+/.test(msg) && /(-1728|-10006)/.test(msg);
}

// Safe fallback target: when no tab index is known, use the profile window's current tab
// instead of "front document" which can target the user's personal profile window
// Throw if a write operation is about to fall back to the user's active tab
// during the new-tab grace window. Without this, navigate/fill/click silently
// target whatever tab the user is looking at when our cached index is lost.
function _assertNotFallingBackToUserTab(opName) {
  if (_st().activeTabIndex) return; // we have a tracked index — fine
  // If we ever opened our own tab in this session, we MUST NOT fall back to
  // "current tab of window" — that's the USER'S active tab. Always throw,
  // regardless of how long ago the tab was opened. The previous 30-second
  // grace window was insufficient: long-running sessions (Reddit warmup,
  // multi-step workflows) routinely exceed it, and the danger persists.
  if (_st().hasOwnedTab) {
    throw new Error(
      `Tab tracking lost — refusing to ${opName} via fallback to "current tab of window" (would target the user's active tab). ` +
      `This session previously opened its own tab via safari_new_tab; re-run safari_new_tab to recover, or call safari_list_tabs and safari_switch_tab to re-anchor to a tab this session opened.`
    );
  }
  // No tab ever owned by this session — fallback to front document is intentional.
}

// The tab for a step that names its tab explicitly (a navigation or a poll across one, where the
// page load clears the marker), as { idx, win, marker, fp, op } for _inTab(): this session's tab,
// proven by its marker, with the window the proof found it in and the marker that proved it, or idx
// null for a session that never owned a tab, meaning the front document. An index read straight
// from the session state named whatever tab had shifted into it, and one addressed to 'front
// window' in each later script named that index in whatever window the user had brought to the
// front meanwhile. The marker is the one the scan found, not the session's after the scan's await:
// a parallel call of the same session can change that one. No fingerprint yet: the step's first
// script proves the tab by its marker, and `since` is set just before the step starts its load.
async function _sessionTab(opName) {
  const { idx, win, marker } = await _resolveSessionTab();
  _assertNotFallingBackToUserTab(opName);
  return { idx: idx || null, win, marker: idx && win ? marker || null : null, fp: null, since: 0, op: opName };
}

function getFallbackTarget() {
  return SAFARI_PROFILE ? `current tab of ${getTargetWindowRef()}` : "front document";
}

// ========== TAB IDENTITY MARKER + VISIBILITY SPOOF ==========
// Build the JS that stamps our identity onto a tab and keeps it rendering:
//  - window.name           : survives EVERY navigation (full loads, redirects,
//                            cross-origin). The browser preserves window.name by
//                            design — the bulletproof identity that index/URL lack.
//  - window.__mcpTabMarker : survives SPA / same-document routing (secondary marker).
//  - visibility spoof      : forces document.visibilityState='visible' so a
//                            backgrounded tab keeps rendering. SPAs (e.g. the Meta
//                            developer console) blank their main content when hidden;
//                            with the user actively switching tabs our automation tab
//                            is constantly backgrounded, so without this its content
//                            never paints.
// `{ expr }` in place of a marker stamps the marker that page JavaScript evaluates to: switchTab()
// keeps the marker a tab already carries, which only the page can read.
function _buildStampJS(marker) {
  const m = marker?.expr || "'" + String(marker).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  return "(function(){"
    + "try{window.name=" + m + ";}catch(e){}"
    + "try{window.__mcpTabMarker=" + m + ";}catch(e){}"
    + "try{if(!window.__mcpVisSpoof){window.__mcpVisSpoof=1;"
    +   "Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible';}});"
    +   "Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false;}});"
    +   "Object.defineProperty(document,'webkitVisibilityState',{configurable:true,get:function(){return 'visible';}});"
    +   "Object.defineProperty(document,'webkitHidden',{configurable:true,get:function(){return false;}});"
    +   "var s=function(e){e.stopImmediatePropagation();};"
    +   "document.addEventListener('visibilitychange',s,true);"
    +   "document.addEventListener('webkitvisibilitychange',s,true);"
    +   "try{document.hasFocus=function(){return true;};}catch(e){}"
    + "}}catch(e){}"
    + "return '1';})()";
}

// Stamp identity marker + visibility spoof onto the tab a step proved (see _sessionTab), in the
// script that proves it again (_inTab). No proven window, no stamp: on 'front window' the marker
// went to the tab at that index in whatever window the user had brought forward, and a tab no
// script can prove is not stamped at all: the step fails instead. Identity-critical: a missed
// stamp loses the tab marker, so this is NOT best-effort — a daemon hiccup falls back to the
// reliable osascript subprocess.
async function _stampTab(tab) {
  if (!tab?.idx || !tab.win || !tab.marker) return;
  const stamp = (opts) => _inTab(tab, "''", { stamp: "always", ...opts });
  await stamp({ timeout: 5000 })
    .catch((err) => { if (err.tabUnproven) throw err; return stamp({ timeout: 8000, subprocess: true }); })
    .catch((err) => { if (err.tabUnproven) throw err; });
}

// ========== PROVING THE TAB INSIDE EACH SCRIPT OF A STEP ==========
// A step proves the session's tab once, by the marker scan or the script that made the tab, then
// acts on `tab N of window id W` in more scripts: a load's probes and re-stamp, navigate's
// `set URL`, a click or a history move. AppleScript has no tab id, and a tab opened, closed or moved
// before it in that window (a link opened in a new tab from an earlier tab, a tab closed to its
// left and another opened, another session's tab cap closing its oldest tab) renumbers the window,
// so by the next script tab N can be the user's. Each of those scripts proves the tab again,
// inside itself, before it touches it:
//  1. the tab at N carries the session's marker, checked in the same `do JavaScript` that acts; or
//  2. another tab of the window carries it: the tab moved, and the script acts there instead; or
//  3. no tab of the window carries it, and the page at N is a document the step's own load brought:
//     created after the step started its load (`since`; a cross-site load clears window.name, any
//     load __mcpTabMarker), in a window that still looks the way the last script that proved the
//     tab saw it: the same window, tab count and selected-or-not state of tab N, and the same URLs
//     in the three tabs before it (compared considering case).
// Step 3 never takes a page carrying another session's marker, and never serves a script that runs
// before the step's load (`markerOnly`), whose page still carries the marker. The load polls stamp
// the marker back as soon as a script proves the page, so step 3 bridges the scripts between a load
// and the next poll. A page where no script runs answers missing value, which proves nothing.
// Failing all three, the script touches no tab and answers _TAB_UNPROVEN, and the step fails with
// "Tab tracking lost". The fingerprint catches a tab inserted anywhere before the session's tab or
// closed anywhere (the count), a tab closed to its left and another opened (the URLs before it
// shift), and a tab in another selected-or-not state landing in its place.
// ponytail: false positive — a tab opened, closed or selected in that window, or a URL change in
// one of the three tabs before the session's, between a load that cleared the marker and the next
// poll, fails the step closed; so does a cross-origin load that started more than a second before
// the step's write (a previous call's click, the page's own redirect) and commits while
// clickAndWait or fillAndSubmit waits, and a page the back/forward cache restores that the session
// never stamped (one from before it took the tab). A Cmd+T or another session's new tab at any other
// time does not: the marker decides. Miss — in that gap, while the window's fingerprint matches,
// any page at N whose document started loading after the step's write less a second passes: a tab
// created in the session's place, or one shifted into it (the session's tab closed or dragged
// right), including one that reloaded. The age test compares Node's wall clock with WebKit's
// timeOrigin, which WebKit derives at each read from a clock that stops in sleep: a wall-clock step
// back of more than a second during a step refuses the session's page, and a sleep or forward step
// of S lets a document up to S + 1 s older pass. And the proof and the action are two Apple events
// of one script (as in closeTabByMarker), so a tab moved in the milliseconds between them still
// shifts it.
const _TAB_UNPROVEN = "MCP_TAB_UNPROVEN";
const _TAB_BUSY = "MCP_TAB_BUSY";

// The AppleScript handler that reads the fingerprint of window `w` as its tab `i` sees it, or ""
// when the window has no tab i: "<window id>|<tab count>|<tab i selected>|<URL>|<URL>|<URL>", the URLs
// of the up to three tabs before tab i (missing value as "", cut at 200 characters). No linefeed.
// The window id keeps a script that osascript() retargets to another window from matching.
const _FINGERPRINT_HANDLER = `on mcpFp(w, i)
	tell application "Safari"
		set n to count of tabs of w
		if i > n then return ""
		set fp to ((id of w) as text) & "|" & (n as text) & "|" & ((visible of tab i of w) as text)
		repeat with j from i - 3 to i - 1
			if j > 0 then
				set u to URL of tab j of w
				if u is missing value then set u to ""
				if (length of u) > 200 then set u to text 1 thru 200 of u
				set fp to fp & "|" & u
			end if
		end repeat
		return fp
	end tell
end mcpFp`;

// The page JavaScript an _inTab() script runs: `js`, once the page proves the tab, answering
// "MCP_OK:" and its value as text ("MCP_OK:" alone when `js` throws, as runJS answered "" for a page
// script that threw: the tab is proven, and the script must not run it again elsewhere);
// _TAB_UNPROVEN, before anything else runs, when the page carries neither field of `marker` and
// either the fingerprint did not prove the tab (`positional` false), or the page carries another
// session's marker, or its document is older than `since` less a second of clock slack.
// `stamp` true stamps a page that lacks __mcpTabMarker (a document a load just brought), "always"
// stamps it in any case.
function _provenTabJS(marker, js, { positional, stamp, since = 0 }) {
  const m = String(marker).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const stampJS = stamp === "always" ? `${_buildStampJS(marker)};` : stamp ? `if(c!==M){${_buildStampJS(marker)};}` : "";
  const born = positional ? `var t=0;try{t=performance.timeOrigin||performance.timing.navigationStart||0}catch(e){}` : "";
  const older = positional ? `||!(t>=${Number(since) - 1000})` : "";
  return `(function(P){var M='${m}',n='',c='',own=false;` +
    `try{n=String(window.name);c=String(window.__mcpTabMarker);own=n===M||c===M}catch(e){}${born}` +
    `if(!own&&(!P||n.indexOf('MCP_')===0||c.indexOf('MCP_')===0${older}))return '${_TAB_UNPROVEN}';` +
    `${stampJS}try{return 'MCP_OK:'+String(${js})}catch(e){return 'MCP_OK:'}})(${positional ? 1 : 0})`;
}

// JavaScript for a double-quoted `do JavaScript "..."` literal, escaped as runJS escapes it.
function _doJSLiteral(js) {
  return js
    .replace(/^\s*\/\/[^\n]*$/gm, '')  // Strip // comment-only lines before flattening
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/\t/g, " ");
}

function _tabUnprovenError(op) {
  const err = new Error(
    `Tab tracking lost — ${op} could not prove the session's tab: no tab of its window carries this session's ` +
    `marker, and nothing else proves which tab it is (a tab was opened, closed or moved in that window, a load ` +
    `had just cleared the marker, or the page runs no script). ${op} touched no tab after that. If it had already ` +
    `loaded a URL, clicked, submitted or moved in history, that happened in the session's tab: check the result ` +
    `before repeating it. Call safari_new_tab to open a fresh tab.`
  );
  err.tabUnproven = true;
  return err;
}

// Run `js` in the tab a step proved, `tab` = { idx, win, marker, fp, since, op } (see _sessionTab),
// in one AppleScript that proves the tab again first, as described above, and answer its value.
// `tab.idx` follows the tab to wherever the proof found it, and `tab.fp` becomes the fingerprint read
// there. `markerOnly`: only the marker proves the tab (steps 1 and 2), for the scripts that run
// before the step's page loads, whose page still carries it; step 3 also needs a fingerprint an
// earlier script of the step read and the time the step started its load. `then(target)`:
// AppleScript run on the proven tab after `js`, as in `set URL of ${target} to "…"`. A session that
// never owned a tab has no marker: its step runs as before, in the tab it tracks or the front
// document.
async function _inTab(tab, js, { markerOnly = false, stamp = false, then = null, timeout = 5000, subprocess = false } = {}) {
  const run = subprocess ? osascript : osascriptFast;
  if (!tab.idx || !tab.win || !tab.marker) {
    // A session that owns a tab gets all three from the scan that proved it; missing one, nothing
    // proves the tab, and the old way (by index, or the front document) would guess.
    if (_st().hasOwnedTab) throw _tabUnprovenError(tab.op);
    if (then) {
      const target = tab.idx ? `tab ${tab.idx} of ${tab.win || getTargetWindowRef()}` : getFallbackTarget();
      return run(`tell application "Safari" to ${then(target)}`, { timeout });
    }
    return runJS(js, { tabIndex: tab.idx, win: tab.win, timeout });
  }
  // A script that runs before the step's load stamps the page it is about to leave, once the marker
  // has proved it: a page the back/forward cache brings back later then carries __mcpTabMarker
  // (window.name may not survive the restore), and its old document proves it where step 3 cannot.
  const byMarker = _doJSLiteral(_provenTabJS(tab.marker, js, { positional: false, stamp: stamp || markerOnly }));
  const positional = markerOnly || !tab.fp || !tab.since ? "" : `		else if not skipped then
			set k to ${tab.idx}
			considering case
				if my mcpFp(w, ${tab.idx}) is "${String(tab.fp).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" then set r to do JavaScript "${_doJSLiteral(_provenTabJS(tab.marker, js, { positional: true, stamp, since: tab.since }))}" in tab ${tab.idx} of w
			end considering
`;
  // The first `do JavaScript` goes to whatever tab sits at N: an error or a reply with no value
  // there falls through to the search, as a refusal does, but a timeout ends the script within the
  // call's own budget, so a script Node gave up on never goes on to act minutes later. Each check of
  // the search is bounded, so a tab that does not answer (a pending dialog, a hung page) costs a
  // second, not the script. A tab to the right of N that did not answer may be the session's tab
  // moved there, which the fingerprint cannot see: then step 3 is not taken, and the script answers
  // _TAB_BUSY, which the load polls retry.
  const script = `${_FINGERPRINT_HANDLER}
tell application "Safari"
	set w to ${tab.win}
	set k to ${tab.idx}
	set r to missing value
	if k is less than or equal to (count of tabs of w) then
		try
			with timeout of ${Math.max(1, Math.ceil(timeout / 1000))} seconds
				set r to (do JavaScript "${byMarker}" in tab k of w) as text
			end timeout
		on error errMsg number errNum
			if errNum is -1712 then error errMsg number errNum
		end try
	end if
	if r does not start with "MCP_OK:" then
		set k to 0
		set skipped to false
		repeat with i from (count of tabs of w) to 1 by -1
			try
				with timeout of 1 second
					if (do JavaScript "${_doJSLiteral(_markerCheckJS(tab.marker))}" in tab i of w) is "1" then
						set k to i
						exit repeat
					end if
				end timeout
			on error number errNum
				if errNum is -1712 and i > ${tab.idx} then set skipped to true
			end try
		end repeat
		if k > 0 then
			set r to do JavaScript "${byMarker}" in tab k of w
${positional}		end if
		if r does not start with "MCP_OK:" then
			if skipped then return "${_TAB_BUSY}"
			return "${_TAB_UNPROVEN}"
		end if
	end if
${then ? `	${then("tab k of w")}\n` : ""}	return (k as text) & linefeed & (my mcpFp(w, k)) & linefeed & r
end tell`;
  const res = String(await run(script, { timeout }));
  if (res === _TAB_BUSY) {
    throw new Error(`${tab.op}: a tab of the session's window did not answer, so its tab cannot be proven yet; retry`);
  }
  // "<index>\n<fingerprint>\nMCP_OK:<value>", positively; anything else proves nothing.
  const proven = /^(\d+)\n([^\n]*)\nMCP_OK:([\s\S]*)$/.exec(res);
  if (!proven) throw _tabUnprovenError(tab.op);
  tab.idx = Number(proven[1]);
  tab.fp = proven[2];
  return proven[3];
}

// Quick JS execution — exposed for smart-wait checks in index.js
export async function runJSQuick(js) { return runJS(js); }

// Run a SYNCHRONOUS function body in the page and return its raw result string. The body
// must `return JSON.stringify(...)` (AppleScript `do JavaScript` can't await). This is the
// single home for the `(function(){ … })()` wrapper that ~50 extractors hand-write; output
// is byte-identical to `runJS(\`(function(){BODY})()\`)` — it only removes the boilerplate.
function evalReturningJSON(body, opts) {
  return runJS(`(function(){${body}})()`, opts);
}

// ========== FOCUS PRESERVATION ==========
// Safari AppleScript can steal focus (bring Safari window to front), especially
// on macOS Tahoe where window-mutation commands trigger an implicit activate.
// Strategy: 1) read frontmost from daemon (~0.1ms), 2) try to re-activate previous
// app, 3) settle 5ms (Tahoe needs time to honor the activate), 4) verify, and
// 5) fall back to hiding Safari if activate didn't take.
export async function saveFrontmostApp() {
  const app = await _helperGetFrontApp();
  return app?.bundleId || null;
}
export async function restoreFocusIfStolen(savedBundleId) {
  // Show-intent agents (SAFARI_MCP_RAISE_ON_NAVIGATE=1) WANT Safari to keep
  // the foreground after their actions — restoring would undo the very raise
  // they asked for. The background-operation posture is unchanged by default.
  if (RAISE_ON_NAVIGATE) { _traceRestore(savedBundleId, "skip-show-intent"); return; }
  if (!savedBundleId || savedBundleId === "com.apple.Safari") return;
  let current = await _helperGetFrontApp();
  if (current?.bundleId !== "com.apple.Safari") return;

  // GUARD FIRST — check the user BEFORE any activate. If they interacted within
  // the last couple seconds, Safari is frontmost because THEY are working in it
  // (or just switched to it while a background instance's op was mid-flight), and
  // restoring the previous app rips Safari out from under them — the "VS Code
  // keeps jumping in front every few seconds" bug. The OLD code ran this guard
  // only AFTER the first activate below, so that activate already stole focus
  // before the guard could veto. With ~5 safari-mcp instances sharing one Safari
  // window, every background op fired this steal. Bias HARD toward not stealing:
  // a stale Safari-frontmost (user clicks back once) beats repeatedly yanking
  // focus away from an active user.
  if (await _userIsActive()) { _traceRestore(savedBundleId, "skip-user-active"); return; }

  _traceRestore(savedBundleId, "restore");
  // Bring previous app back. Await so the caller doesn't hand control back to
  // user-space while Safari is still frontmost.
  await _helperActivateApp(savedBundleId).catch(() => {});

  // Settle window — NSRunningApplication.activate() is async at the OS level and
  // reliably takes tens of ms to take effect. The old 5ms was far too short: the
  // verify below almost always still saw Safari frontmost and wrongly fired the
  // hide fallback, even though activate() was about to land. Give it a real
  // chance before deciding activate "failed".
  await new Promise(r => setTimeout(r, 120));

  current = await _helperGetFrontApp();
  if (current?.bundleId === "com.apple.Safari") {
    // Safari still frontmost after activate. The OLD code HID Safari here — but
    // hiding is destructive: it pulls the WHOLE app off-screen. It fired whenever
    // the user had switched into Safari themselves while a background agent's op
    // was in flight, and recurred even with an idle-guard because a user passively
    // VIEWING Safari exceeds the idle threshold. Several autonomous background
    // instances (Daily-RC → codex computer-use) share this one profile window, so
    // the race was constant. NEVER hide. Non-destructive only: if the user is
    // interacting, they own the foreground — leave it. Otherwise one more activate
    // attempt, then give up and leave Safari frontmost (the user clicks back —
    // vastly better than Safari vanishing).
    if (await _userIsActive()) { _traceRestore(savedBundleId, "skip-user-active-late"); return; }
    await _helperActivateApp(savedBundleId).catch(() => {});
  }
}

// Seconds since the user's last HID input (keyboard or mouse), via IOKit.
// `-r -d 1` roots the dump at IOHIDSystem and keeps it shallow (~13ms, ~4KB) —
// note: a plain `-d 1` measures depth from the registry root and never reaches
// IOHIDSystem, returning no HIDIdleTime. Returns Infinity on any failure so
// callers fail toward "user is idle" (preserving the pre-existing hide behavior).
async function _userIdleSeconds() {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-r", "-d", "1"], { timeout: 1500 });
    const m = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
    if (!m) return Infinity;
    return parseInt(m[1], 10) / 1e9; // nanoseconds → seconds
  } catch { return Infinity; }
}

// True when the user interacted within the last ~2.5s — used to avoid hiding
// Safari out from under a user who just brought it to the front themselves.
async function _userIsActive() {
  return (await _userIdleSeconds()) < 2.5;
}

// Lightweight trace of every restore decision — confirms WHICH instance (pid)
// restored focus and whether the user-active guard vetoed it. Best-effort; never
// throws into the hot path. Tail ~/.safari-mcp/restore-trace.log to watch live.
// Lives under ~/.safari-mcp, NOT __dirname (#81) — the package dir is wiped on
// reinstall and read-only in container/CI setups; mutable state doesn't belong there.
const _RESTORE_TRACE = join(homedir(), ".safari-mcp", "restore-trace.log");
function _traceRestore(savedBundleId, decision) {
  mkdir(dirname(_RESTORE_TRACE), { recursive: true })
    .then(() => appendFile(_RESTORE_TRACE, `${new Date().toISOString()} pid=${process.pid} saved=${savedBundleId} -> ${decision}\n`))
    .catch(() => {});
}

function _helperHideSafari(timeout = 2000) {
  return _withHelperLock(() => new Promise((resolve) => {
    if (!_helperProc || !_helperProc.stdin?.writable) { resolve(); return; }
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        _replaceHelperCb(cb, () => {});
        resolve();
      }
    }, timeout);
    function cb() {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve();
    }
    _helperQueue.push(cb);
    try { _helperProc.stdin.write(_helperLine({ hideSafari: true }, cb)); }
    catch {
      _dropHelperCb(cb);
      clearTimeout(timer);
      resolve();
    }
  }));
}

function _helperActivateApp(bundleId, timeout = 2000) {
  return _withHelperLock(() => new Promise((resolve) => {
    if (!_helperProc || !_helperProc.stdin?.writable) { resolve(); return; }
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        _replaceHelperCb(cb, () => {});
        resolve();
      }
    }, timeout);
    function cb() {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve();
    }
    _helperQueue.push(cb);
    try { _helperProc.stdin.write(_helperLine({ activateApp: bundleId }, cb)); }
    catch {
      _dropHelperCb(cb);
      clearTimeout(timer);
      resolve();
    }
  }));
}

export function setFocusGuard(active) { _focusGuardActive = active; }
export function getActiveTabIndex() { return _st().activeTabIndex; }
// Whether this session has opened or claimed a tab of its own (index.js asks before a write).
export function hasOwnedTab() { return _st().hasOwnedTab; }
export function setActiveTabIndex(idx) { _st().activeTabIndex = idx; }
export function getActiveTabURL() { return _st().activeTabURL; }
export function setActiveTabURL(url) { _st().activeTabURL = url; _st().lastResolveTime = Date.now(); }

export function getActiveTabMarker() { return _st().activeTabMarker; }

// A tab adopted from the user (#92) carries a marker of its own family, MCP_A<markerId>_. The session
// acts on it like one of its own tabs, and nothing closes it. The marker, not the URL, says the tab
// was adopted, so that holds wherever the tab navigates, and says nothing about another tab on the
// same URL. markerId is lowercase hex, so no session's own prefix, MCP_<markerId>_, starts with MCP_A.
function _adoptedMarkerPrefix() { return `MCP_A${_st().markerId}_`; }
export function isActiveTabAdopted() { return String(_st().activeTabMarker || "").startsWith(_adoptedMarkerPrefix()); }

// index.js calls this when the Safari extension, not this module, opened or picked the
// session's tab. The index the extension reports is a position in the extension's window,
// which need not be AppleScript's front window, and a tab the user closes or drags moves
// another tab (theirs) into that position. It proves nothing, so the session tracks no index
// until resolveActiveTab() finds the marker the extension puts on the tab. The URL stays for
// index.js's ownership checks; one the extension did not report stays unknown rather than
// naming the previous tab. The old marker has to go: it names the last tab AppleScript opened
// or claimed. The session owns a tab from here on, as it does after newTab(): once it cannot
// prove where this one is, the fallbacks refuse instead of running in the front document.
export function setActiveTabFromExtension(_reportedIndex, url) {
  const s = _st();
  s.activeTabIndex = null;
  s.activeTabURL = url || null;
  s.activeTabMarker = null;
  s.marking = null;
  s.hasOwnedTab = true;
  s.tabFromExtension = true;
  s.lastResolveTime = Date.now();
}

// How index.js has the Safari extension put a marker on the tab it opened or picked:
// `(marker) => Promise<boolean>`. The extension knows that tab by its id and AppleScript only
// by its position, so this is the only way such a tab can be proven. Unset, it stays unproven.
let _markTabViaExtension = null;
export function setExtensionTabMarker(fn) { _markTabViaExtension = fn; }

// `window id N` for the window id an AppleScript reported, or null when it reported none.
// A tab's index is a position in one window, so each later script that acts on an index a script
// proved addresses that window by its id. 'front window' names whichever window is in front when
// each script runs: once the user brought another window forward, the index named their tab.
function _windowById(id) {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? `window id ${n}` : null;
}

// Page JavaScript that answers "1" when the page carries exactly `marker`: in window.name, or in
// window.__mcpTabMarker once a page has taken window.name over.
function _markerCheckJS(marker) {
  const safeMarker = String(marker).replace(/'/g, "\\'");
  return `(function(){try{return (window.name==='${safeMarker}'||window.__mcpTabMarker==='${safeMarker}')?'1':'0'}catch(e){return '0'}})()`;
}

// Scan the target window (or `inWin`, a `window id N`) for the tab carrying `marker`, trying tab
// `hint` first. Returns { idx, win }: that tab's index, 0 when the scan completed and no tab
// carries the marker, and the window scanned (see _windowById); or null when the scan could not
// be completed.
async function _scanForMarker(marker, hint, inWin = null) {
  try {
    const check = _markerCheckJS(marker);
    // One AppleScript call loops every tab internally: faster and far more reliable than N
    // separate daemon round-trips (a daemon hiccup mid-scan used to mis-resolve to the user's tab).
    const scanScript = `tell application "Safari"
    set w to ${inWin || getTargetWindowRef()}
    set wid to (id of w) as text
    set n to count of tabs of w
    ${hint ? `try
      if n is greater than or equal to ${hint} then
        if (do JavaScript "${check}" in tab ${hint} of w) is "1" then return wid & ":${hint}"
      end if
    end try` : ''}
    repeat with i from n to 1 by -1
      try
        if (do JavaScript "${check}" in tab i of w) is "1" then return wid & ":" & i
      end try
    end repeat
    return wid & ":0"
  end tell`;
    // Fast daemon first; a hiccup retries once through the reliable subprocess.
    let res = await osascriptFast(scanScript).catch(() => null);
    if (res === null) res = await osascript(scanScript).catch(() => null);
    if (res === null) return null;
    // "<window id>:<index>". An answer without the window it scanned proves nothing: the index
    // would name a tab of whichever window is in front for the next script.
    const m = /^(\d+):(\d+)$/.exec(String(res).trim());
    const win = m && _windowById(m[1]);
    return win ? { idx: Number(m[2]), win } : null;
  } catch {
    return null; // the target window is gone (a named profile's window closed)
  }
}

// Find the tab carrying an EXACT identity marker. Returns its index, or null when the
// marker is on no tab — or when the scan itself could not be completed.
//
// resolveActiveTab() resolves *this session's current* tab, and can have the extension mark it
// again; this one takes the marker as an argument and has no fallback. A tab recorded minutes
// earlier has shifted its index and may have navigated, so a URL match can land on a tab the
// USER opened on the same URL (#112, the same principle as #68). An index it returns is proof
// only for the script that found it: a close goes through closeTabByMarker(), which finds the
// tab in the same script.
export async function findTabByMarker(marker) {
  if (!marker) return null;
  return (await _scanForMarker(marker))?.idx || null;
}

// The window safari_wait_for_new_tab watches when AppleScript lists it: the one this session's tab
// is in, proven by its marker in the target window as every step proves it, or null for a session
// that has no tab of its own yet. The window in front was the user's whenever theirs was in front:
// the wait missed the popup the session's page opened and claimed a tab the user opened there. So a
// session whose tab is not proven there is refused, and no scan here drops its marker.
export async function sessionTabWindow() {
  const s = _st();
  if (!s.hasOwnedTab) return null;
  if (!s.activeTabMarker) {
    throw new Error(
      "Tab safety: AppleScript has no marker to find this session's tab by (the Safari extension opened it and has " +
      "not marked it, or this session lost track of it), so it cannot tell which window to watch for the new tab. " +
      "Check the extension with safari_doctor, re-anchor with safari_list_tabs and safari_switch_tab, or open a tab with safari_new_tab."
    );
  }
  const found = await _scanForMarker(s.activeTabMarker, s.activeTabIndex);
  if (found?.idx) return found.win;
  if (!found) {
    // The scan answers null for every AppleScript error: name the one no retry gets past.
    if (!(await isSafariRunning())) throw safariNotRunningError();
    throw new Error("Tab safety: Safari did not finish the scan for this session's tab (busy, or its window gone), so this wait claimed nothing.");
  }
  throw new Error(
    "Tab safety: this session's tab is not in the Safari window in front, so AppleScript cannot tell which window to " +
    "watch for the new tab, and watching the one in front could claim a tab of yours. Check the Safari extension with " +
    "safari_doctor; without it, the window with this session's tab has to be in front (if it is, re-anchor with " +
    "safari_switch_tab or open a tab with safari_new_tab)."
  );
}

// Page JavaScript that is true when the page carries a marker starting with `prefix`, in window.name
// or, once a page has taken window.name over, in window.__mcpTabMarker. Every marker the session
// stamps starts with its markerId: MCP_<markerId>_ on a tab it opened, on one it switched to, and on
// one the extension marked for it (resolveActiveTab), and MCP_A<markerId>_ on one it adopted. A switch
// by index has no other proof that the tab is the session's: an index names whatever tab sits there,
// and the user can have the same URL open.
function _markerPrefixTestJS(prefix) {
  return `(function(p){try{return String(window.name).indexOf(p)===0||String(window.__mcpTabMarker).indexOf(p)===0}catch(e){return false}})('${prefix}')`;
}

// Page JavaScript that evaluates to the marker starting with `prefix` that the page carries, window.name's
// before window.__mcpTabMarker's, or to '' when it carries none. Only a whole marker counts, letters,
// digits and `_` as every marker is minted: a page can write anything after the prefix, a quote
// included, and a marker kept from here goes into the AppleScript source of every later scan.
function _markerWithPrefixJS(prefix) {
  return `(function(p){function m(v){v=String(v);return v.indexOf(p)===0&&/^[A-Za-z0-9_]+$/.test(v)?v:''}try{return m(window.name)||m(window.__mcpTabMarker)}catch(e){return ''}})('${prefix}')`;
}

// Page JavaScript that is true when the page carries a marker of another MCP session: one starting
// with MCP_ but with neither of this session's prefixes, `own` (MCP_<markerId>_) and `adopted`
// (MCP_A<markerId>_). Another client of the HTTP daemon, or a server before a restart, stamped it.
function _otherSessionMarkerTestJS(own, adopted) {
  return `(function(p,q){function t(v){v=String(v);return v.indexOf('MCP_')===0&&v.indexOf(p)!==0&&v.indexOf(q)!==0}try{return t(window.name)||t(window.__mcpTabMarker)}catch(e){return false}})('${own}','${adopted}')`;
}

// The index of this session's tab, or null. See _resolveSessionTab().
async function resolveActiveTab() {
  return (await _resolveSessionTab()).idx;
}

// This session's tab as { idx, win }: its index, or null, and the window the marker scan found it
// in (see _windowById), which a caller that acts on the index in a later script addresses.
//
// A session that has owned a tab acts only on a tab it can prove is its own, and the proof is its
// identity marker (window.name, or window.__mcpTabMarker after SPA routing), found on the tab now.
// Nothing else counts. An index is a position: a tab the user closes or drags, or another front
// window, puts one of their tabs there. A URL can be open in the user's tabs too: a prefix match
// on a site root, or the domain anywhere in their URL, picked those, and nothing checked the tab
// again when the script ran. A tab the extension opened or picked starts with no marker, so the
// extension puts one on it when AppleScript first needs the tab, and again once a cross-site load
// has cleared window.name. With no proof this returns null, and the callers refuse rather than run
// in the front document.
//
// A session that never owned a tab keeps what it tracks, which in the default mode is nothing:
// null means the front document, the page the user is looking at.
// `elsewhere`, when given, answers the other windows (`window id N`) the tab may be in, asked
// only once the target window has no tab carrying the marker. A named profile can hold several
// windows and the target window is only the first of them, while the extension opens or picks
// the session's tab in any of them. The marker proves the tab in whichever window it is found.
async function _resolveSessionTab({ elsewhere = null } = {}) {
  const s = _st();
  if (s.hasOwnedTab) {
    let marked = false;
    for (;;) {
      if (!s.activeTabMarker && s.tabFromExtension && _markTabViaExtension && !marked) {
        marked = true;
        // Parallel calls share one request: a second marker would replace the first on the tab
        // while the first call still scans for it. If the session moves to another tab meanwhile,
        // the request is dropped, so the previous tab's marker never becomes the current one's.
        if (!s.marking) {
          const marker = `MCP_${s.markerId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          const marking = _markTabViaExtension(marker).catch(() => false).then((ok) => {
            if (s.marking !== marking) return;
            s.marking = null;
            if (ok && s.tabFromExtension) s.activeTabMarker = marker;
          });
          s.marking = marking;
        }
        await s.marking;
      }
      if (!s.activeTabMarker) break;
      // The marker this scan looks for proves the tab, whatever a parallel call of the session
      // makes of s.activeTabMarker while the scan runs.
      const marker = s.activeTabMarker;
      let found = await _scanForMarker(marker, s.activeTabIndex);
      if (found && !found.idx && elsewhere) {
        for (const win of await elsewhere()) {
          const there = win !== found.win && await _scanForMarker(marker, s.activeTabIndex, win);
          if (there?.idx) { found = there; break; }
        }
      }
      if (found?.idx) { s.activeTabIndex = found.idx; return { ...found, marker }; }
      // The scan did not complete: keep the marker for the next call, but prove nothing now.
      if (!found) break;
      // No tab carries it: the tab closed, a cross-site load or the page itself replaced
      // window.name, or it is in another window. Only the extension can mark its tab again.
      if (s.activeTabMarker === marker) s.activeTabMarker = null;
    }
    console.error("[Safari MCP] This session's tab is not proven (no tab in the window carries its marker) — refusing to act on a tab by position or URL");
    s.activeTabIndex = null;
    return { idx: null, win: null };
  }
  return { idx: await _resolveTrackedTab(s), win: null };
}

// The index a session that never owned a tab tracks, found again by its URL in the target window.
async function _resolveTrackedTab(s) {
  if (!s.activeTabURL) return s.activeTabIndex;

  try {
    const safeUrl = _st().activeTabURL.replace(/"/g, '\\"');
    const domain = _st().activeTabURL.replace(/^https?:\/\//, '').split('/')[0].replace(/"/g, '\\"');
    // Single AppleScript call: verify current index, then search by URL, then by domain
    // Also returns tabCount so we can clamp stale indices
    const result = await osascriptFast(
      `tell application "Safari"
        set w to ${getTargetWindowRef()}
        set tabCount to count of tabs of w
        ${_st().activeTabIndex ? `try
          if tabCount >= ${_st().activeTabIndex} then
            if URL of tab ${_st().activeTabIndex} of w starts with "${safeUrl}" then return ${_st().activeTabIndex}
          end if
        end try` : ''}
        repeat with i from tabCount to 1 by -1
          if URL of tab i of w starts with "${safeUrl}" then return i
        end repeat
        repeat with i from tabCount to 1 by -1
          if URL of tab i of w contains "${domain}" then return -(i)
        end repeat
        return "0:" & tabCount
      end tell`
    );
    // Parse result — can be "N" (found) or "0:tabCount" (not found)
    const resultStr = String(result);
    if (resultStr.includes(':')) {
      // Not found.
      const tabCount = Number(resultStr.split(':')[1]) || 1;
      _st().lastTabCount = tabCount;
      _st().activeTabURL = null;
      if (_st().activeTabIndex && _st().activeTabIndex > tabCount) {
        // Our index is past the end of the window: the user closed a tab or tore one
        // into its own window, so the index no longer names any tab — least of all ours.
        // This used to clamp to `tabCount` ("tab ghost proactive fix"), which silently
        // retargeted us at the LAST tab in the window — the user's. That predates the
        // identity marker (clamp: Mar 31, marker: v2.8.3 Apr 14) and guessed. Fail closed;
        // callers re-anchor via _assertNotFallingBackToUserTab's "re-run safari_new_tab" error.
        console.error(`[Safari MCP] Tab identity lost (index ${_st().activeTabIndex} > tabCount ${tabCount}) — clearing index to avoid targeting the user's tab`);
        _st().activeTabIndex = null;
        return null;
      }
      return _st().activeTabIndex;
    }
    const num = Number(result);
    if (num > 0) {
      _st().activeTabIndex = num;
      return num;
    }
    if (num < 0) {
      // Domain match (negative = partial match)
      _st().activeTabIndex = -num;
      return -num;
    }
    _st().activeTabURL = null;
    return _st().activeTabIndex;
  } catch {
    return _st().activeTabIndex;
  }
}

// ========== FAST OSASCRIPT VIA TEMP FILE ==========
// osascript -i persistent process doesn't work reliably with pipes.
// Instead, we use execFile for every call (~80ms each).
// Optimization: for runJS we write to temp file and execute (avoids arg escaping).

// Run AppleScript — uses execFile (safe, isolated, for complex scripts)
async function osascript(script, { timeout = 10000 } = {}) {
  if (!(await isSafariRunning())) throw safariNotRunningError();
  // Save frontmost app via daemon BEFORE subprocess (~0.1ms)
  // Skip if an outer caller (extensionOrFallback) already handles focus
  const shouldGuardFocus = !_focusGuardActive;
  const frontApp = shouldGuardFocus ? await _helperGetFrontApp() : null;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    // Retry once if the window ID became stale (window reopened/changed)
    if (isStaleWindowError(err) && SAFARI_PROFILE) {
      const oldRef = _targetWindowRef;
      await refreshTargetWindow(true);
      if (_targetWindowRef !== oldRef) {
        const retryScript = script.replace(new RegExp(oldRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), _targetWindowRef);
        const { stdout } = await execFileAsync("osascript", ["-e", retryScript], { timeout, maxBuffer: 10 * 1024 * 1024 });
        return stdout.trim();
      }
    }
    throw new Error(`AppleScript error: ${err.stderr || err.message}`);
  } finally {
    // Awaited restore — caller must not return to user-space while Safari is still frontmost.
    if (shouldGuardFocus && frontApp?.bundleId && frontApp.bundleId !== 'com.apple.Safari') {
      await restoreFocusIfStolen(frontApp.bundleId).catch(() => {});
    }
  }
}

// osascriptFast: uses persistent Swift daemon (~5ms) — 18x faster than subprocess (~90ms)
async function osascriptFast(script, { timeout = 10000, noFocusGuard = false } = {}) {
  if (!(await isSafariRunning())) throw safariNotRunningError();
  if (!_helperProc) startHelper();

  // Focus guard — Tahoe AppleScript can implicitly activate Safari (especially
  // on window-mutating commands: set URL / set bounds / set current tab).
  // Skip if an outer caller (extensionOrFallback / runJSLarge / osascript)
  // already handles focus, or if the caller knows the script is read-only and
  // not worth the round-trip overhead (e.g. background polling every 3s).
  const shouldGuardFocus = !_focusGuardActive && !noFocusGuard;
  const frontApp = shouldGuardFocus ? await _helperGetFrontApp() : null;

  try {
    if (_helperProc) {
      try {
        return await _osascriptFastHelper(script, timeout);
      } catch (err) {
        // Retry once if the window ID became stale
        if (isStaleWindowError(err) && SAFARI_PROFILE) {
          const oldRef = _targetWindowRef;
          await refreshTargetWindow(true);
          if (_targetWindowRef !== oldRef) {
            const retryScript = script.replace(new RegExp(oldRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), _targetWindowRef);
            // Guard: helper may have died during the stale-window retry
            if (!_helperProc) startHelper();
            if (_helperProc) return await _osascriptFastHelper(retryScript, timeout);
            return await osascript(retryScript, { timeout });
          }
        }
        throw err;
      }
    }
    return await osascript(script, { timeout });
  } finally {
    if (shouldGuardFocus && frontApp?.bundleId && frontApp.bundleId !== "com.apple.Safari") {
      await restoreFocusIfStolen(frontApp.bundleId).catch(() => {});
    }
  }
}

function _osascriptFastHelper(script, timeout) {
  return _withHelperLock(() => new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      // DON'T remove from queue — replace with a proof-of-life consumer to maintain
      // FIFO order. A heavy page (e.g. the Airtable SPA) makes `do JavaScript` legitimately
      // slow: the call exceeds `timeout`ms, but the helper IS alive and emits its response a
      // moment later. That late response proves liveness — so when it arrives we reset the
      // consecutive-timeout counter instead of discarding the signal. Killing the daemon on a
      // slow page is pointless (the fresh daemon hits the same slow page) and disruptive.
      // Only a helper that NEVER replies (truly hung) accumulates timeouts with no late reply.
      _replaceHelperCb(cb, () => { _helperConsecutiveTimeouts = 0; }); // late reply ⇒ alive
      _helperConsecutiveTimeouts++;
      if (_helperConsecutiveTimeouts >= 5) {
        console.error(`[Safari MCP] safari-helper: ${_helperConsecutiveTimeouts} consecutive timeouts with no late replies — killing daemon`);
        _helperProc?.kill();
        _helperProc = null;
        _helperConsecutiveTimeouts = 0;
        // The killed proc's 'exit' handler also schedules a restart; guard the timer so only
        // one respawn wins (startHelper is now idempotent too) — no second, orphaned daemon.
        setTimeout(() => { if (!_shuttingDown && !_helperProc) startHelper(); }, 100);
      }
      reject(new Error("safari-helper timeout"));
    }, timeout);

    function cb(line) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      _helperConsecutiveTimeouts = 0;
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed.result ?? "");
      } catch {
        resolve(line);
      }
    }

    if (!_helperProc || !_helperProc.stdin || !_helperProc.stdin.writable) {
      clearTimeout(timer);
      reject(new Error("safari-helper not available"));
      return;
    }
    _helperQueue.push(cb);
    try {
      _helperProc.stdin.write(_helperLine({ script }, cb));
    } catch (writeErr) {
      _dropHelperCb(cb);
      clearTimeout(timer);
      reject(new Error("safari-helper write failed: " + writeErr.message));
    }
  }));
}

// Ask the helper for its permission state (CGEvent posting + screen capture) without
// acting. Resolves the FULL parsed object ({accessibility, screenRecording}); doubles as
// a daemon liveness probe. Used by doctor() (issue #29/#14/#15).
function _helperPreflight(timeout = 3000) {
  return _withHelperLock(() => new Promise((resolve, reject) => {
    if (!_helperProc) startHelper();
    if (!_helperProc || !_helperProc.stdin || !_helperProc.stdin.writable) {
      reject(new Error("safari-helper not available"));
      return;
    }
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      _replaceHelperCb(cb, () => {}); // no-op consumer for a late reply
      reject(new Error("preflight timeout"));
    }, timeout);
    function cb(line) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); }
      catch { reject(new Error("unparseable preflight reply")); }
    }
    _helperQueue.push(cb);
    try {
      _helperProc.stdin.write(_helperLine({ preflight: true }, cb));
    } catch (writeErr) {
      _dropHelperCb(cb);
      clearTimeout(timer);
      reject(new Error("preflight write failed: " + writeErr.message));
    }
  }));
}

// ========== SCREEN LOCK GATE ==========
// A locked screen (the lid shut on an awake Mac, or the lock screen up) routes every OS-level
// event to loginwindow: CGEvent clicks and keys land on the lock screen — keystrokes even in its
// password field — while the native tools used to report "clicked"/"typed". In-page tools keep
// working while locked, so every native path fails fast here and points there instead.
export const SCREEN_LOCKED_MSG =
  "SCREEN_LOCKED: the Mac's screen is locked, so OS-level (native) input would land on the lock screen " +
  "instead of Safari. In-page tools still work while locked: use safari_click / safari_fill / " +
  "safari_type_text / safari_press_key, and safari_upload_file without forceNative.";

export async function isScreenLocked() {
  return execFileAsync("/bin/sh", ["-c",
    "ioreg -n Root -d1 -r -a 2>/dev/null | grep -c CGSSessionScreenIsLocked || true"])
    .then((r) => String(r.stdout).trim() !== "0").catch(() => false);
}

export async function assertScreenUnlocked(probe = isScreenLocked) {
  if (await probe()) throw new Error(SCREEN_LOCKED_MSG);
}

// ========== NATIVE CLICK VIA CGEVENT ==========
// Sends a CGEvent click command to the Swift helper daemon.
// This produces isTrusted: true events — bypasses WAF protection (G2, etc.)

// Guarded at the root: a CGEvent hits the window's SELECTED tab, so every caller — not just
// nativeClick — must have our tab selected first. _withTargetTabFronted is re-entrant, so the
// public native* wrappers (which front the tab before measuring coordinates) cost nothing extra.
function _helperNativeClick(x, y, doubleClick = false, windowId = 0, timeout = 5000) {
  return _withTargetTabFronted(() => _helperNativeClickRaw(x, y, doubleClick, windowId, timeout));
}

async function _helperNativeClickRaw(x, y, doubleClick = false, windowId = 0, timeout = 5000) {
  await assertScreenUnlocked();
  return _withHelperLock(() => new Promise((resolve, reject) => {
    if (!_helperProc) startHelper();
    if (!_helperProc || !_helperProc.stdin || !_helperProc.stdin.writable) {
      reject(new Error("safari-helper not available for native click"));
      return;
    }
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      _replaceHelperCb(cb, () => {}); // No-op consumer for late response
      reject(new Error("native click timeout"));
    }, timeout);

    function cb(line) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed.result ?? "");
      } catch {
        resolve(line);
      }
    }

    _helperQueue.push(cb);
    const cmd = { click: { x, y } };
    if (doubleClick) cmd.click.double = true;
    if (windowId) cmd.click.windowId = windowId;
    try {
      _helperProc.stdin.write(_helperLine(cmd, cb));
    } catch (e) {
      // EPIPE if the daemon died in the gap after the writable check — splice our callback
      // out so it can't consume the NEXT command's response (FIFO desync), then reject.
      _dropHelperCb(cb);
      clearTimeout(timer);
      resolved = true;
      reject(e);
    }
  }));
}

// Sends a CGEvent hover command to the Swift helper daemon.
// Moves the cursor to (x, y), dwells to let tooltips render, optionally restores cursor.
async function _helperNativeHover(x, y, windowId = 0, dwellMs = 500, restoreMouse = true, timeout = 10000) {
  await assertScreenUnlocked();
  return _withHelperLock(() => new Promise((resolve, reject) => {
    if (!_helperProc) startHelper();
    if (!_helperProc || !_helperProc.stdin || !_helperProc.stdin.writable) {
      reject(new Error("safari-helper not available for native hover"));
      return;
    }
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      _replaceHelperCb(cb, () => {});
      reject(new Error("native hover timeout"));
    }, timeout);

    function cb(line) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed.result ?? "");
      } catch {
        resolve(line);
      }
    }

    _helperQueue.push(cb);
    const cmd = { hover: { x, y, dwellMs, restoreMouse } };
    if (windowId) cmd.hover.windowId = windowId;
    try {
      _helperProc.stdin.write(_helperLine(cmd, cb));
    } catch (e) {
      // EPIPE if the daemon died in the gap after the writable check — splice our callback
      // out so it can't consume the NEXT command's response (FIFO desync), then reject.
      _dropHelperCb(cb);
      clearTimeout(timer);
      resolved = true;
      reject(e);
    }
  }));
}

// Sends a CGEvent keyboard command to the Swift helper daemon.
// No focus stealing — sends key events directly to the target window via PID.
function _helperNativeKeyboard(keyCode, flags = [], windowId = 0, timeout = 5000) {
  return _withTargetTabFronted(() => _helperNativeKeyboardRaw(keyCode, flags, windowId, timeout));
}

async function _helperNativeKeyboardRaw(keyCode, flags = [], windowId = 0, timeout = 5000) {
  await assertScreenUnlocked();
  return _withHelperLock(() => new Promise((resolve, reject) => {
    if (!_helperProc) startHelper();
    if (!_helperProc || !_helperProc.stdin || !_helperProc.stdin.writable) {
      reject(new Error("safari-helper not available for native keyboard"));
      return;
    }
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      _replaceHelperCb(cb, () => {}); // No-op consumer for late response
      reject(new Error("native keyboard timeout"));
    }, timeout);

    function cb(line) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed.result ?? "");
      } catch {
        resolve(line);
      }
    }

    _helperQueue.push(cb);
    const cmd = { keyboard: { keyCode, flags } };
    if (windowId) cmd.keyboard.windowId = windowId;
    try {
      _helperProc.stdin.write(_helperLine(cmd, cb));
    } catch (e) {
      // EPIPE if the daemon died in the gap after the writable check — splice our callback
      // out so it can't consume the NEXT command's response (FIFO desync), then reject.
      _dropHelperCb(cb);
      clearTimeout(timer);
      resolved = true;
      reject(e);
    }
  }));
}

// ========== NATIVE FOCUS OPERATIONS VIA DAEMON ==========
// Uses NSRunningApplication — ~0.1ms for get, ~1ms for activate (vs ~90ms AppleScript)

function _helperGetFrontApp(timeout = 2000) {
  return _withHelperLock(() => new Promise((resolve) => {
    if (!_helperProc || !_helperProc.stdin?.writable) { resolve(null); return; }
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        _replaceHelperCb(cb, () => {});
        resolve(null);
      }
    }, timeout);
    function cb(line) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { resolve(JSON.parse(line)); } catch { resolve(null); }
    }
    _helperQueue.push(cb);
    try { _helperProc.stdin.write(_helperLine({ getFrontApp: true }, cb)); }
    catch {
      _dropHelperCb(cb);
      clearTimeout(timer);
      resolve(null);
    }
  }));
}

// Get Safari window bounds, toolbar height, and window ID for coordinate calculation
async function _getSafariWindowGeometry() {
  // A locus-pinned native click measures the window the session's tab actually lives
  // in — not the first window matching the profile name, which with several profile
  // windows open produced coordinates for one window and a click in another.
  if (_pinnedWindowOverride) {
    const windowRef = _pinnedWindowOverride.winRef;
    const boundsResult = await osascriptFast(
      `tell application "Safari"\n  set b to bounds of ${windowRef}\n  set wid to id of ${windowRef}\n  return (item 1 of b as text) & "," & (item 2 of b as text) & "," & (item 3 of b as text) & "," & (item 4 of b as text) & "," & (wid as text)\nend tell`
    );
    const parts = boundsResult.split(",").map(s => Number(s.trim()));
    if (parts.length === 5 && !parts.some(isNaN)) {
      let toolbarHeight = 74;
      try {
        const chromeStr = await runJS(`(window.outerHeight - window.innerHeight) + ''`);
        const chrome = Number(chromeStr);
        if (Number.isFinite(chrome) && chrome >= 50 && chrome <= 200) toolbarHeight = chrome;
      } catch (_e) { /* keep fallback */ }
      return {
        windowX: parts[0], windowY: parts[1], windowRight: parts[2], windowBottom: parts[3],
        toolbarHeight, windowId: parts[4],
      };
    }
    // fall through to the name-based path if the pinned window vanished mid-call
  }
  await refreshTargetWindow();
  const windowRef = getTargetWindowRef();
  // Get window bounds + window ID via the helper daemon. The daemon is TCC-granted
  // under safari-helper's STABLE path, so this never falls back to osascript-under-claude
  // — which re-prompts for Apple Events on every claude version bump (the binary lives in
  // a version-numbered folder). The script returns a plain comma-joined string (not a list),
  // which the daemon's stringValue handles fine. osascriptFast itself falls back to a fresh
  // osascript subprocess only if the daemon is dead — a rare hiccup, not the steady state.
  const boundsResult = await osascriptFast(
    `tell application "Safari"\n  set b to bounds of ${windowRef}\n  set wid to id of ${windowRef}\n  return (item 1 of b as text) & "," & (item 2 of b as text) & "," & (item 3 of b as text) & "," & (item 4 of b as text) & "," & (wid as text)\nend tell`
  );
  // boundsResult = "x1, y1, x2, y2, windowId"
  const parts = boundsResult.split(",").map(s => Number(s.trim()));
  if (parts.length !== 5 || parts.some(isNaN)) {
    throw new Error("Failed to parse Safari window geometry: " + boundsResult);
  }
  // Dynamic toolbar height: outerHeight - innerHeight gives total chrome above content
  // (title bar + URL bar + tab strip + optional bookmarks bar). Hardcoded 74 was wrong
  // for modern Safari (Sequoia+) where chrome is ~90px. Fall back to 74 if JS unreachable.
  let toolbarHeight = 74;
  try {
    const chromeStr = await runJS(`(window.outerHeight - window.innerHeight) + ''`);
    const chrome = Number(chromeStr);
    if (Number.isFinite(chrome) && chrome >= 50 && chrome <= 200) toolbarHeight = chrome;
  } catch (_e) { /* keep fallback */ }
  return {
    windowX: parts[0],
    windowY: parts[1],
    windowRight: parts[2],
    windowBottom: parts[3],
    toolbarHeight,
    // CGWindow ID for background click targeting (no mouse move, no focus steal)
    windowId: parts[4]
  };
}

// ========== NATIVE-EVENT TAB GUARD ==========
// A CGEvent is delivered to a WINDOW, and the window routes it to whichever tab is
// SELECTED — there is no per-tab CGEvent target. runJS does not have this problem: it
// reaches background tabs through AppleScript. So every native_* op has a split brain —
// coordinates measured against OUR tab, event delivered to the USER'S tab. A native click
// aimed at our tab 8 landed on the user's tab 4 (facebook.com/groups) instead: silently
// wrong, and an OS-level click on a tab we never owned.
//
// Fix: select the target tab for the duration of the event, then put the user's tab back.
// `set current tab` switches within the window only — it never calls `activate`, so Safari
// is not raised and foreground focus is not stolen. If we own no tab, or already hold the
// selection, this is a no-op and no switch happens.
const NATIVE_TAB_SETTLE_MS = 120; // let the selected tab paint before the event lands

// Re-entrancy: the guard sits on both the public native* fns (so coordinates are measured
// against a fronted tab) and the low-level _helperNative* calls (so no caller can slip past
// it). A multi-event op like replaceEditorContent — Cmd+A then Cmd+V — must not flip tabs
// between keystrokes, so nested calls run inside the selection the outermost one took.
let _tabFrontedDepth = 0;

async function _withTargetTabFronted(fn) {
  if (_tabFrontedDepth > 0) return await fn(); // already inside a fronted section

  // Only a tab this session can prove is its own gets the event. Without that proof the event
  // would land in whatever tab is selected — the user's.
  const idx = _st().hasOwnedTab ? await resolveActiveTab() : _st().activeTabIndex;
  if (!idx && _st().hasOwnedTab) {
    throw new Error("Tab tracking lost — refusing to act in the selected tab (native input, screenshot): it is the user's. Call safari_new_tab to reopen.");
  }
  if (!idx) return await fn(); // no owned tab — nothing to front

  const winRef = getTargetWindowRef();
  let prev;
  try {
    prev = Number(
      await osascriptFast(`tell application "Safari" to tell ${winRef} to return (index of current tab) as text`)
    );
  } catch (_e) {
    // Can't read the selection — switching blind risks stranding the user on our tab.
    // Deliver the event as-is rather than leave the selection somewhere they didn't put it.
    return await fn();
  }

  if (!Number.isFinite(prev)) return await fn();

  // Already selected? Then no switch and no restore — but still mark the section, so nested
  // _helperNative* calls skip re-checking the selection on every keystroke.
  const mustSwitch = prev !== idx;
  if (mustSwitch) {
    await osascriptFast(`tell application "Safari" to tell ${winRef} to set current tab to tab ${idx}`);
    await new Promise((r) => setTimeout(r, NATIVE_TAB_SETTLE_MS));
  }

  _tabFrontedDepth++;
  try {
    return await fn();
  } finally {
    _tabFrontedDepth--;
    // Always hand the user's tab back — even if the event threw.
    if (mustSwitch) {
      try {
        await osascriptFast(`tell application "Safari" to tell ${winRef} to set current tab to tab ${prev}`);
      } catch (_e) { /* restore is best-effort; never mask the real result */ }
    }
  }
}

// Atomic tab-identity guard, as a JS prefix. Belongs here and not at a call site: it is the
// only check that is independent of how `idx` was resolved, so every path that builds a
// targeted `do JavaScript` needs it — most of all the retry paths, which run precisely when
// the index has already proven untrustworthy. Empty only when the caller named a tab
// explicitly. See #64.
function _tabIdentityGuard(explicitTabIndex) {
  if (explicitTabIndex) return '';
  const marker = _st().activeTabMarker;
  // No marker → this session owns no tab, so the target is the front document: the tab the
  // user is looking at. That fallback is intentional for a session that genuinely never
  // opened one — but "owns no tab" is also what a *re-initialised* session reports. In
  // HTTP-daemon mode a dropped transport makes the client re-init, which mints a new
  // MCP session id, and `_st()` hands it a fresh empty state: `hasOwnedTab` false,
  // `activeTabMarker` null. Every fail-closed branch keys on `hasOwnedTab`, so they all read
  // false at exactly the moment an agent is mid-task and already owns a tab — and the next
  // op runs, unguarded, on the user's current page.
  //
  // The session state died; the marker on the tab did not. A front document carrying any
  // `MCP_` marker is a tab some MCP session opened and this one does not own, so it is
  // never a legitimate implicit target — refuse it. An unmarked front document stays
  // reachable, which keeps "read the page I'm looking at" working for real fresh sessions.
  if (!marker) {
    return `if(typeof window.name==='string'&&window.name.indexOf('MCP_')===0){throw new Error('MCP_FOREIGN_TAB')};`;
  }
  return `if(window.name!=='${marker}'&&window.__mcpTabMarker!=='${marker}'){throw new Error('MCP_WRONG_TAB')};`;
}

// A tripped foreign-tab guard is terminal: with no marker of our own there is nothing to
// re-resolve to, and retrying is the guess the guard just refused.
function _foreignTabError(where, cause) {
  return new Error(
    `Tab tracking lost during ${where} — the target is a tab opened by another MCP session ` +
    `that this session does not own (atomic guard fail-closed). This session holds no tab ` +
    `marker, which is also what a session re-initialised after a transport drop reports. ` +
    `Call safari_new_tab to open a tab this session owns.`,
    cause ? { cause } : undefined
  );
}

// Run JavaScript in Safari — fastest path, no focus stealing
// Uses osascriptFast (persistent process, ~5ms) for short scripts,
// falls back to osascript (~80ms) for long scripts that exceed stdin limits
// An explicit `tabIndex` names a tab of `win` (`window id N`) when the caller proved it there,
// else of the target window. `elsewhere`: see _resolveSessionTab.
async function runJS(js, { tabIndex, win, timeout = 15000, elsewhere = null } = {}) {
  await refreshTargetWindow();
  const escaped = js
    .replace(/^\s*\/\/[^\n]*$/gm, '')  // Strip // comment-only lines before flattening
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/\t/g, " ");
  // Resolve tab: explicit tabIndex > the session's tab, proven by its marker > (a session that
  // never owned a tab) its recently verified or URL-tracked index > front document
  let idx = tabIndex;
  let idxWin = tabIndex ? win : null;
  if (!idx && !_st().hasOwnedTab && _st().activeTabIndex && _st().activeTabURL && (Date.now() - _st().lastResolveTime < RESOLVE_CACHE_MS)) {
    // Recently verified and tab count unchanged — use cached index. Never for a session that
    // has owned a tab: its index counts only once a marker scan has just found the tab there
    // (resolveActiveTab checks that index first, so re-resolving is cheap), which also closes
    // the ~100ms window in which a user tab-shift could leave it pointing at the user's tab.
    idx = _st().activeTabIndex;
  } else if (!idx && (_st().hasOwnedTab || _st().activeTabURL)) {
    const resolved = await _resolveSessionTab({ elsewhere });
    if (resolved.idx) { idx = resolved.idx; idxWin = resolved.win; _st().lastResolveTime = Date.now(); }
  }
  // A session that never owned a tab falls back to the index it tracks (usually none: the front
  // document). An owned session's index is set only by a marker scan, and cleared when one fails.
  if (!idx) idx = _st().activeTabIndex;
  // Once this session owns a tab, never silently run on the user's current tab —
  // regardless of SAFARI_PROFILE. Without a profile getFallbackTarget() returns
  // "front document" (the user's active tab), so the guard matters MOST there.
  // Mirrors runJSLarge and the ghost-recovery guard below, which key on _st().hasOwnedTab alone.
  if (!idx && _st().hasOwnedTab) {
    throw new Error('Tab tracking lost during runJS — refusing to target the user\'s current tab. Call safari_new_tab to reopen.');
  }
  const target = idx
    ? `tab ${idx} of ${idxWin || getTargetWindowRef()}`
    : getFallbackTarget();
  // NEVER activate or raise Safari — that steals the user's foreground. JS runs in the
  // target tab in the background regardless of window stacking. (rAF/timers stay frozen
  // while the window is occluded by macOS; that is a deliberate trade-off — measuring an
  // occluded window's frame rate is not worth stealing focus. Measure when it's visible.)
  // Atomic tab-identity guard: prepend a JS check that throws MCP_WRONG_TAB if the target tab
  // does not carry OUR marker. Makes the op fail-closed at EXECUTION time regardless of how
  // `idx` resolved — a drift to the user's tab (shared profile window) throws instead of
  // running on their page. Skipped when the caller passed an explicit tabIndex.
  const _guard = _tabIdentityGuard(tabIndex);
  const script = `tell application "Safari" to do JavaScript "${_guard}${escaped}" in ${target}`;
  try {
    if (script.length < 50000) {
      return await osascriptFast(script, { timeout });
    }
    return await osascript(script, { timeout });
  } catch (err) {
    // Atomic guard tripped: op reached a tab WITHOUT our marker (drift to the user's tab in
    // the shared profile window). Re-resolve via a full marker scan and retry once on the
    // correct tab; if unresolved, fail closed rather than touch the user's tab.
    const _gmsg = err.message || '';
    if (_gmsg.includes('MCP_FOREIGN_TAB')) throw _foreignTabError('runJS', err);
    if (_guard && _gmsg.includes('MCP_WRONG_TAB')) {
      console.error('[Safari MCP] Atomic guard tripped — re-resolving marked tab via full scan');
      _st().lastResolveTime = 0; _st().activeTabIndex = null;
      const { idx: _reIdx, win: _reWin } = (_st().activeTabURL || _st().activeTabMarker) ? await _resolveSessionTab() : { idx: null, win: null };
      if (_reIdx) {
        const _gs = `tell application "Safari" to do JavaScript "${_guard}${escaped}" in tab ${_reIdx} of ${_reWin || getTargetWindowRef()}`;
        if (_gs.length < 50000) return await osascriptFast(_gs, { timeout });
        return await osascript(_gs, { timeout });
      }
      throw new Error('Tab tracking lost — marked tab not found (atomic guard fail-closed). Call safari_new_tab to reopen.');
    }
    // Tab ghost recovery: "Can't get tab X" → re-resolve and retry once.
    // Match both apostrophes — Safari emits a typographic apostrophe (U+2019),
    // so a plain "Can't" includes() check silently missed every ghost error.
    const msg = err.message || '';
    if (idx && (/[Cc]an.t get tab/.test(msg) || msg.includes("-1728"))) {
      console.error(`[Safari MCP] Tab ghost detected (tab ${idx}), re-resolving...`);
      _st().lastResolveTime = 0; // Force re-resolve
      _st().lastTabCount = null;  // Invalidate tab count cache
      _st().activeTabIndex = null;
      if (_st().activeTabURL || _st().activeTabMarker) {
        const { idx: newIdx, win: newWin } = await _resolveSessionTab();
        if (newIdx && newIdx !== idx) {
          console.error(`[Safari MCP] Tab ghost resolved: ${idx} → ${newIdx}`);
          const newTarget = `tab ${newIdx} of ${newWin || getTargetWindowRef()}`;
          // Keep the guard on the retry. `newIdx` came from a re-resolve triggered by the
          // index being wrong; dropping the check here made the least trustworthy path the
          // only unchecked one (#64).
          const retryScript = `tell application "Safari" to do JavaScript "${_guard}${escaped}" in ${newTarget}`;
          if (retryScript.length < 50000) return osascriptFast(retryScript, { timeout });
          return osascript(retryScript, { timeout });
        }
      }
      // If still can't resolve and we previously owned a tab — refuse to
      // fall back to "current tab of window" (which is the USER'S active tab).
      // Falling back would silently run our JS (potentially writes:
      // document.title=, location.href=) on the user's working page.
      if (_st().hasOwnedTab) {
        throw new Error(
          `Tab tracking lost during runJS — original tab ${idx} no longer exists, and URL-based resolution failed. ` +
          `Refusing to fall back to "current tab of window" (would target user's active tab). ` +
          `Call safari_new_tab to open a fresh tab and retry.`
        );
      }
      // No owned tab in this session — front-document fallback is intentional.
      const fallbackScript = `tell application "Safari" to do JavaScript "${escaped}" in current tab of ${getTargetWindowRef()}`;
      console.error(`[Safari MCP] Falling back to current tab`);
      if (fallbackScript.length < 50000) return osascriptFast(fallbackScript, { timeout });
      return osascript(fallbackScript, { timeout });
    }
    throw err;
  }
}

// Run large JavaScript via temp file — bypasses osascript arg length limit (~260KB)
// Used for operations that embed file data (upload, paste image)
async function runJSLarge(js, { tabIndex, timeout = 30000, elsewhere = null } = {}) {
  await refreshTargetWindow();
  // Resolve tab the same way runJS does — verify cached index via URL
  let idx = tabIndex;
  let idxWin = null;
  // Match runJS: a session that has owned a tab always resolves — only its marker proves where
  // the tab is, and skipping the scan meant large-payload ops (upload/paste) could target a
  // stale index.
  if (!idx && (_st().hasOwnedTab || (_st().activeTabURL && _st().activeTabURL !== 'about:blank'))) {
    const resolved = await _resolveSessionTab({ elsewhere });
    if (resolved.idx) { idx = resolved.idx; idxWin = resolved.win; _st().lastResolveTime = Date.now(); }
  }
  if (!idx) idx = _st().activeTabIndex;
  // If we previously owned a tab but lost tracking, refuse to target current tab
  // (which is the USER'S active tab). Same protection as navigate/runJS fallback.
  if (!idx && _st().hasOwnedTab) {
    throw new Error(
      `Tab tracking lost during runJSLarge — refusing to fall back to "current tab of window" (would target user's active tab). ` +
      `Call safari_new_tab to open a fresh tab and retry.`
    );
  }
  const target = idx
    ? `tab ${idx} of ${idxWin || getTargetWindowRef()}`
    : getFallbackTarget();
  // Write AppleScript to temp file — the JS is embedded inside the AppleScript
  const escaped = js
    .replace(/^\s*\/\/[^\n]*$/gm, '')  // Strip // comment-only lines before flattening
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/\t/g, " ");
  // Same execution-time identity check runJS gets. These are the upload / paste-image ops —
  // the largest blast radius in the toolset — and they were the one targeted path with no
  // guard at all (#64).
  const appleScript = `tell application "Safari" to do JavaScript "${_tabIdentityGuard(tabIndex)}${escaped}" in ${target}`;
  const tmpFile = join(tmpdir(), `safari-mcp-${Date.now()}.scpt`);
  await writeFile(tmpFile, appleScript, "utf8");
  // Save frontmost app via daemon before subprocess execution
  // Skip if outer caller already handles focus
  const shouldGuard = !_focusGuardActive;
  const frontApp = shouldGuard ? await _helperGetFrontApp() : null;
  try {
    const { stdout } = await execFileAsync("osascript", [tmpFile], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    // No retry here, unlike runJS: these payloads carry file data, and re-running one on a
    // freshly resolved tab is exactly the guess this guard exists to prevent.
    if ((err.message || '').includes('MCP_FOREIGN_TAB')) throw _foreignTabError('runJSLarge', err);
    if ((err.message || '').includes('MCP_WRONG_TAB')) {
      throw new Error('Tab tracking lost during runJSLarge — target tab does not carry this session\'s marker (atomic guard fail-closed). Call safari_new_tab to reopen.', { cause: err });
    }
    throw err;
  } finally {
    unlink(tmpFile).catch(() => {});
    // Awaited restore — caller must not return to user-space while Safari is still frontmost.
    if (shouldGuard && frontApp?.bundleId && frontApp.bundleId !== 'com.apple.Safari') {
      await restoreFocusIfStolen(frontApp.bundleId).catch(() => {});
    }
  }
}

// ========== NAVIGATION ==========

// Opt-in: agents whose intent is SHOWING a page (voice assistants, demos)
// can ask navigation to bring the Safari window forward. Off by default —
// the server's background-operation posture is unchanged.
const RAISE_ON_NAVIGATE = process.env.SAFARI_MCP_RAISE_ON_NAVIGATE === "1";
async function raiseWindowForShow() {
  if (!RAISE_ON_NAVIGATE) return;
  await osascript(
    `tell application "Safari"\nactivate\ntry\nset index of front window to 1\nend try\nend tell`,
    { timeout: 5000 }
  ).catch(() => {});
}

export async function navigate(url) {
  await refreshTargetWindow();
  await raiseWindowForShow();
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl;
  }

  // Escape backslash first, then quotes; strip CR/LF — a newline would break out of
  // the AppleScript string literal and allow AppleScript injection.
  const safeUrl = targetUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
    // Prove our tab ONCE by its marker (indices shift), with the window the proof found it in, and
    // pin every script below to that tab of that window: re-resolving mid-navigation is unsafe — a
    // cross-origin load transiently wipes window.name (a browser privacy feature) and the tracked
    // URL is stale until the new page settles, so resolveActiveTab() would conclude "identity lost"
    // and drop the very tab we are navigating — and 'front window' would put every later step,
    // `set URL` and the marker stamp included, in a window the user brought forward meanwhile.
    // A position is not an identity either: each script proves the tab again before it touches it
    // (_inTab), by the marker while the old page still carries it — so a tab opened or closed
    // before ours is followed, never navigated — and across the load by the marker it stamps back.
    const tab = await _sessionTab('navigate');
    const setURL = (u) => (target) => `set URL of ${target} to "${u}"`;
    // Step 0: Suppress onbeforeunload dialogs (prevents blocking navigation)
    await _inTab(tab, "window.onbeforeunload=null", { markerOnly: true, timeout: 2000 }).catch(() => {});

    // Pre-navigation URL, captured before Step 1. Lets the post-load check below
    // detect a `set URL` that silently no-ops (a cold or crashed Swift daemon):
    // the readyState poll would otherwise just see the OLD page still loaded.
    const preNavUrl = await _inTab(tab, 'location.href', { markerOnly: true, timeout: 3000 }).catch(() => '');

    // Step 1: Set URL via fast daemon (~5ms) — don't block daemon with polling. In the script that
    // checks the page still carries the session's marker: the tab it sets is the session's. From
    // here on, a page without the marker is taken by position only when its document is newer.
    tab.since = Date.now();
    await _inTab(tab, "''", { markerOnly: true, then: setURL(safeUrl), timeout: 10000 });

    // Optimistically track the destination NOW. The async load below can take seconds
    // on a heavy SPA; if any step throws mid-load, resolveActiveTab() can still re-find
    // this tab by URL instead of clearing the index and locking the session out of its
    // own tab. Corrected to the real landed URL once the page settles (below).
    _st().activeTabURL = targetUrl;
    _st().activeTabIndex = tab.idx;
    _st().lastResolveTime = Date.now();

    // about:blank and any already-loaded page report readyState 'complete' the instant
    // we poll, BEFORE the async set-URL takes effect — so breaking on readyState alone
    // mistakes the stale/blank page for a finished navigation (root cause of false
    // "set URL had no effect" failures navigating a fresh tab to an SPA). Only settle
    // once the URL has actually LEFT preNavUrl (a same-URL reload is exempt).
    const _isReload = !!preNavUrl && preNavUrl === targetUrl;
    const _settled = (state, landed) => {
      if (state !== 'complete' && state !== 'interactive') return false;
      if (_isReload) return true;
      if (!landed || landed === 'about:blank') return false;
      return landed !== preNavUrl;
    };
    const _probeUrl = (json) => { try { return JSON.parse(json).url || ''; } catch { return ''; } };

    // Step 2: Poll readyState synchronously from Node.js side
    // (AppleScript do JavaScript doesn't await async Promises — returns immediately).
    // Every poll stamps a page that lost the marker, so a load leaves the tab unmarked for one
    // poll at most; a tab no poll can prove ends the navigation (it is not "still loading").
    let result = '{}';
    for (let poll = 0; poll < 80; poll++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const state = await _inTab(tab, 'document.readyState', { stamp: true, timeout: 5000 });
        if (state === 'complete' || state === 'interactive') {
          result = await _inTab(
            tab,
            `JSON.stringify({title:document.title,url:location.href,blocked:document.title.includes('cannot open')||document.title.includes('\u05D0\u05D9\u05DF \u05D0\u05E4\u05E9\u05E8\u05D5\u05EA')})`,
            { stamp: true, timeout: 5000 }
          );
          if (_settled(state, _probeUrl(result))) {
            if (state === 'complete') break;
            // interactive = DOM ready but resources still loading — wait a bit more
            if (poll > 10) break; // Don't wait forever for 'complete' if interactive after 2s
          }
          // else: new URL not in effect yet (stale/blank page) — keep polling
        }
      } catch (err) {
        if (err.tabUnproven) throw err;
        /* page still loading, retry */
      }
    }

    // If the fast `set URL` above silently no-opped (cold/crashed daemon), the poll
    // just saw the OLD page already loaded. Detect that — the URL never left
    // preNavUrl — and retry once through the daemon-independent osascript path.
    let landedUrl = _probeUrl(result);
    if (preNavUrl && preNavUrl !== targetUrl && (!landedUrl || landedUrl === preNavUrl || landedUrl === 'about:blank')) {
      console.error('[Safari MCP] navigate: fast set-URL did not take effect — retrying via osascript subprocess');
      // The page never left, so it still carries the marker, which alone may prove where it is.
      await _inTab(tab, "''", { markerOnly: true, then: setURL(safeUrl), timeout: 12000, subprocess: true });
      for (let rpoll = 0; rpoll < 80; rpoll++) {
        await new Promise(res => setTimeout(res, 200));
        try {
          const state = await _inTab(tab, 'document.readyState', { stamp: true, timeout: 5000 });
          if (state === 'complete' || state === 'interactive') {
            const probe = await _inTab(tab, 'JSON.stringify({title:document.title,url:location.href})', { stamp: true, timeout: 5000 });
            if (_settled(state, _probeUrl(probe))) {
              result = probe;
              if (state === 'complete') break;
              if (rpoll > 10) break;
            }
          }
        } catch (err) {
          if (err.tabUnproven) throw err;
          /* page still loading, retry */
        }
      }
      // Last chance: the daemon may have applied the set URL only AFTER our polls ran.
      // Re-read the live URL directly before declaring failure.
      let retryUrl = _probeUrl(result);
      if (!retryUrl || retryUrl === preNavUrl || retryUrl === 'about:blank') {
        const liveUrl = await _inTab(tab, 'location.href', { stamp: true, timeout: 5000 }).catch((err) => {
          if (err.tabUnproven) throw err;
          return '';
        });
        if (liveUrl && liveUrl !== preNavUrl && liveUrl !== 'about:blank') {
          result = JSON.stringify({ title: '', url: liveUrl });
          retryUrl = liveUrl;
        }
      }
      // Still stuck on the pre-navigation URL → the navigation genuinely failed.
      if (retryUrl && retryUrl === preNavUrl) {
        // Preserve tab tracking (index + the page actually showing) so the session can
        // recover via switch_tab / re-navigate instead of being locked out of its tab.
        _st().activeTabURL = preNavUrl;
        _st().activeTabIndex = tab.idx;
        _st().lastResolveTime = Date.now();
        throw new Error(`navigate failed: page stayed on ${preNavUrl} — Safari "set URL" to ${targetUrl} had no effect (Safari automation/daemon issue, retry exhausted)`);
      }
    }

    // If HTTPS failed and original was HTTP, try original HTTP URL
    try {
      const parsed = JSON.parse(result);
      if (parsed.blocked && url.startsWith("http://")) {
        const httpUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
        // The poll that read the blocked page stamped it: the marker alone may prove where it is.
        await _inTab(tab, "''", { markerOnly: true, then: setURL(httpUrl), timeout: 10000 });
        // Poll readyState for HTTP retry — the tab the step proved (no re-resolve)
        let retryResult = '{}';
        for (let rp = 0; rp < 40; rp++) {
          await new Promise(r => setTimeout(r, 300));
          try {
            const rs = await _inTab(tab, 'document.readyState', { stamp: true, timeout: 5000 });
            if (rs === 'complete' || rs === 'interactive') {
              retryResult = await _inTab(tab, 'JSON.stringify({title:document.title,url:location.href})', { stamp: true, timeout: 5000 });
              if (rs === 'complete') break;
              if (rp > 8) break;
            }
          } catch (err) {
            if (err.tabUnproven) throw err;
            /* retry */
          }
        }
        const retry = retryResult;
        // Update URL tracking with actual URL after HTTP retry
        try {
          const retryParsed = JSON.parse(retry);
          if (retryParsed.url) _st().activeTabURL = retryParsed.url;
        } catch {}
        _st().activeTabIndex = tab.idx;
        _st().lastResolveTime = Date.now();
        await _stampTab(tab);
        _injectHelpersAfterLoad(tab.idx, tab.win);
        return retry;
      }
    } catch (err) {
      if (err?.tabUnproven) throw err;
    }

    // Update URL tracking after navigation (non-blocked path)
    try {
      const parsed = JSON.parse(result);
      _st().activeTabURL = parsed.url || targetUrl;
    } catch {
      _st().activeTabURL = targetUrl;
    }
    _st().activeTabIndex = tab.idx;
    _st().lastResolveTime = Date.now();

    // Re-stamp identity marker + visibility spoof onto the settled page. A cross-origin
    // navigation clears window.name, and any full load wipes __mcpTabMarker and the
    // visibility spoof — re-stamping keeps resolveActiveTab able to find this tab and
    // keeps the page rendering even while backgrounded.
    await _stampTab(tab);
    _injectHelpersAfterLoad(tab.idx, tab.win);

    return result;
}

// Inject click helpers in background (non-blocking, for subsequent clicks), once the page is
// re-stamped, into the tab the navigation proved, behind the marker check. A marker scan of its
// own found no marker while a cross-site load had cleared window.name, or once the user had brought
// another window forward, and dropped the session's. A session that never owned a tab injects into
// the page in front, as before.
function _injectHelpersAfterLoad(idx, win) {
  Promise.resolve()
    .then(() => (idx && win
      ? osascriptFast(`tell application "Safari" to do JavaScript "${_tabIdentityGuard()}${_HELPERS_ESCAPED}" in tab ${idx} of ${win}`, { timeout: 15000 })
      : _injectHelpersfast()))
    .catch((err) => console.error(`[Safari MCP] background helper injection skipped: ${err.message}`));
}

// Poll document.readyState from the Node side and return {title,url[,text]} once the
// page settles. `do JavaScript` returns immediately and never awaits an async IIFE
// (see _evaluateAsync), so any in-page `await` loop is fire-and-forget — page-load
// waits MUST be driven from Node. Shared by goBack/goForward/reload/navigateAndRead/fillAndSubmit.
// Runs in the tab the step proved (`tab`, see _sessionTab), and every poll proves it again and
// stamps a page that lost the marker (_inTab), so the step keeps its tab across a cross-site load
// and the window's fingerprint stands in for the marker for one poll at most.
async function _pollReadyAndRead(tab, { maxLength } = {}) {
  const readExpr = maxLength != null
    ? `JSON.stringify({title:document.title,url:location.href,text:document.body?document.body.innerText.substring(0,${Number(maxLength)}):''})`
    : `JSON.stringify({title:document.title,url:location.href})`;
  let result = '{}';
  for (let poll = 0; poll < 60; poll++) {
    await new Promise(r => setTimeout(r, poll < 10 ? 200 : 500));
    try {
      const state = await _inTab(tab, 'document.readyState', { stamp: true, timeout: 5000 });
      if (state === 'complete' || state === 'interactive') {
        result = await _inTab(tab, readExpr, { stamp: true, timeout: 5000 });
        if (state === 'complete') break;
        if (poll > 10) break; // interactive after ~2s is good enough
      }
    } catch (err) {
      if (err.tabUnproven) throw err;
      /* page still loading, retry */
    }
  }
  return result;
}

export async function goBack() {
  await refreshTargetWindow();
  const tab = await _sessionTab('goBack');
  // history.back() is synchronous; the page-load wait is polled from Node (see _pollReadyAndRead).
  // It runs in the page that still carries the session's marker, checked in the same script.
  tab.since = Date.now();
  await _inTab(tab, "history.back()", { markerOnly: true, timeout: 5000 });
  const result = await _pollReadyAndRead(tab);
  try { const p = JSON.parse(result); if (p.url) _st().activeTabURL = p.url; } catch {}
  // A page the back/forward cache restored keeps __mcpTabMarker but not always window.name: stamp
  // both, as reload() does, so a later same-site load does not lose the marker.
  await _stampTab(tab);
  return result;
}

export async function goForward() {
  await refreshTargetWindow();
  const tab = await _sessionTab('goForward');
  tab.since = Date.now();
  await _inTab(tab, "history.forward()", { markerOnly: true, timeout: 5000 });
  const result = await _pollReadyAndRead(tab);
  try { const p = JSON.parse(result); if (p.url) _st().activeTabURL = p.url; } catch {}
  await _stampTab(tab);
  return result;
}

export async function reload(hardReload = false) {
  await refreshTargetWindow();
  const tab = await _sessionTab('reload');
  // Reload destroys JS context — fire it, then poll readyState from Node.
  tab.since = Date.now();
  await _inTab(tab, hardReload ? "location.reload(true)" : "location.reload()", { markerOnly: true, timeout: 15000 });
  await new Promise((r) => setTimeout(r, 100)); // Brief wait for reload to start
  const result = await _pollReadyAndRead(tab);
  try { const p = JSON.parse(result); if (p.url) _st().activeTabURL = p.url; } catch {}
  // A reload destroys the JS context — re-stamp marker + visibility spoof.
  await _stampTab(tab);
  return result;
}

// ========== PAGE INFO ==========

export async function readPage({ selector, maxLength = 50000 } = {}) {
  if (selector) {
    const sel = escJsSingleQuote(selector);
    return runJS(
      `(function(){
        var el = document.querySelector('${sel}');
        if (!el) return 'Element not found: ${sel}';
        if (el.value !== undefined && el.value !== '') return el.value.substring(0,${Number(maxLength)});
        return (el.innerText || el.textContent || '').substring(0,${Number(maxLength)});
      })()`
    );
  }
  // innerText needs a built render tree, which Safari may skip for a tab that has
  // never been foregrounded — it can come back near-empty even though the DOM is
  // fully present. Detect that and fall back to a layout-independent TreeWalker
  // text extraction so reads work on a background tab without ever taking focus.
  //
  // And the TIME dimension: an SPA mid-render has nothing for either reader —
  // innerText and the walker both see an empty body until the framework paints.
  // Rather than report emptiness as truth, give the page up to ~2s to produce
  // any text before returning the (honestly) empty read.
  const readOnce = () => runJS(
    `(function(){
      var max=${Number(maxLength)};
      var t=document.body.innerText||'';
      if(t.replace(/\\s/g,'').length<20){
        var parts=[];
        var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);
        var n;
        while(n=w.nextNode()){
          var p=n.parentElement;if(!p)continue;
          var tag=p.tagName;
          if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT'||tag==='TEMPLATE')continue;
          var s=(n.textContent||'').replace(/\\s+/g,' ').trim();
          if(s)parts.push(s);
        }
        t=parts.join('\\n');
      }
      return JSON.stringify({title:document.title,url:location.href,text:t.substring(0,max)});
    })()`
  );
  for (let i = 0; ; i++) {
    const out = await readOnce();
    try {
      const parsed = JSON.parse(out);
      if ((parsed.text || "").trim().length > 0 || i >= 3) return out;
    } catch { return out; }
    await new Promise((r) => setTimeout(r, 700));
  }
}

export async function getPageSource({ maxLength = 200000 } = {}) {
  return runJS(`document.documentElement.outerHTML.substring(0,${Number(maxLength)})`);
}

// ========== CLICK ==========

// Inject click helpers ONCE per page (cached on window.__mcp)
// Includes: mcpClick (full event sequence), mcpReactClick (React Fiber), mcpFindText (fast TreeWalker)
// Loaded from mcp-helpers.js at startup — enables syntax highlighting, linting, and easier maintenance
const INJECT_MCP_HELPERS = readFileSync(join(__dirname, 'mcp-helpers.js'), 'utf8');

// NOTE: ~300 lines of legacy inline helpers were here — now in mcp-helpers.js (deleted in v2.4.0)


// Precomputed escaped helper string — avoids re-escaping ~4KB on every injection call
const _HELPERS_ESCAPED = INJECT_MCP_HELPERS
  .replace(/^\s*\/\/[^\n]*$/gm, '')
  .replace(/\\/g, "\\\\")
  .replace(/"/g, '\\"')
  .replace(/\n/g, " ")
  .replace(/\r/g, "")
  .replace(/\t/g, " ");

// Fast helper injection — uses precomputed escaped string + daemon directly
// Skips runJS overhead (escaping, tab resolution) since we already have the escaped string
async function _injectHelpersfast() {
  await refreshTargetWindow();
  let idx = _st().activeTabIndex;
  let win = null;
  // Re-verify identity via the tab marker before trusting the cached index. This path
  // used _st().activeTabIndex directly, so a user tab-shift (which changes which tab lives at
  // that index) would inject helpers into the USER's tab. resolveActiveTab() scans for our
  // marker and is fail-closed (returns null when identity is lost), so the guard below
  // then throws instead of hitting the user's tab.
  if (_st().hasOwnedTab) {
    ({ idx, win } = await _resolveSessionTab());
  }
  // Same guard as runJS: once this session has owned a tab, NEVER fall back to
  // "front document" — that's the user's active tab, and injecting the helpers
  // there is script injection into a page the user is working in.
  if (!idx && _st().hasOwnedTab) {
    throw new Error("Tab tracking lost — refusing to inject helpers into the front (user) tab.");
  }
  const target = idx
    ? `tab ${idx} of ${win || getTargetWindowRef()}`
    : getFallbackTarget();
  const script = `tell application "Safari" to do JavaScript "${_HELPERS_ESCAPED}" in ${target}`;
  return osascriptFast(script, { timeout: 15000 });
}

// Ensure helpers are injected — verify critical functions exist, reset version if partial
// Cache: skip ensureHelpers check if we already injected on this URL recently
let _helpersInjectedForUrl = null;
let _helpersInjectedAt = 0;
const HELPERS_CACHE_MS = 10000; // Re-verify every 10s max

async function ensureHelpers() {
  // Skip check if we recently verified helpers on the same URL
  const now = Date.now();
  if (_st().activeTabURL && _helpersInjectedForUrl === _st().activeTabURL && (now - _helpersInjectedAt) < HELPERS_CACHE_MS) return;

  // Check if helpers are actually present (not just version flag)
  const check = await runJS("(typeof mcpClickWithReact==='function'&&typeof mcpFindText==='function'&&typeof mcpReactSelectSet==='function')?'ok':'missing'").catch(() => 'missing');
  if (check === 'ok') {
    _helpersInjectedForUrl = _st().activeTabURL;
    _helpersInjectedAt = now;
    return;
  }
  // Reset version to force re-injection
  await runJS("window.__mcpVersion=0").catch(() => {});
  // Use precomputed escaped string + osascriptFast directly (~5ms vs ~80ms subprocess)
  const result = await _injectHelpersfast().catch(err => 'INJECT_ERR:' + err.message);
  if (typeof result === 'string' && result.startsWith('INJECT_ERR:')) {
    throw new Error('ensureHelpers failed: ' + result);
  }
  _helpersInjectedForUrl = _st().activeTabURL;
  _helpersInjectedAt = now;
}

// Try tiny click first (~200B). If helpers missing, inject once and retry.
async function clickWithRetry(js) {
  try {
    const result = await runJS(js);
    if (result && (result.includes('mcpClick is not defined') || result.includes('mcpFindText is not defined'))) {
      await ensureHelpers();
      return runJS(js);
    }
    return result;
  } catch (err) {
    if (err.message && (err.message.includes('mcpClick') || err.message.includes('mcpFindText') || err.message.includes('not defined'))) {
      await ensureHelpers();
      return runJS(js);
    }
    throw err;
  }
}

export async function click({ selector, text, x, y, ref }) {
  await ensureHelpers();
  // Native <select> elements look like custom dropdowns on LinkedIn etc., but they
  // hand off to the OS-level option list. .click() on them blocks AppleScript until
  // the native popup is dismissed → the JSC eval times out and the tool returns an
  // error after seconds of hang. Detect early and return a clear directive instead.
  const selectGuard = `if(el&&el.tagName==='SELECT'){var opts=[];for(var oi=0;oi<el.options.length&&opts.length<8;oi++){opts.push(el.options[oi].text||el.options[oi].value);}return '__SELECT_GUARD__:'+(el.id||el.name||'select')+': '+opts.join('|');}`;
  // Page fingerprint, captured synchronously on either side of the click. dispatchEvent
  // is synchronous, so anything that differs between before/after is a direct effect of
  // the click's own handlers — there is no window for ambient ad/lazy-load noise. Catches
  // DOM add/remove, class/attribute/text mutations, navigation, and focus changes.
  const FP = `(location.href+'|'+document.querySelectorAll('*').length+'|'+document.documentElement.innerHTML.length+'|'+(document.activeElement?(document.activeElement.tagName+'#'+(document.activeElement.id||'')):''))`;
  // Mirrors mcpClickWithReact (resolve → React-fiber click → synthetic fallback) but also
  // reports reactFired and whether the page observably changed — so click() can detect a
  // synthetic click that was silently ignored (isTrusted-gated handlers) and escalate.
  const coreJS = (finderExpr, notFound) =>
    `(function(){var el=${finderExpr};if(!el)return JSON.stringify({err:${JSON.stringify(notFound)}});${selectGuard}` +
    `var target=mcpResolveTarget(el)||el;var before=${FP};` +
    `var reactFired=false;try{reactFired=mcpReactClick(target);}catch(e){}` +
    `var anchor=target&&target.closest?target.closest('a[href]'):null;` +
    `if(!reactFired||anchor)mcpClick(target);` +
    `return JSON.stringify({tag:target.tagName,text:((target.innerText||target.textContent)||'').trim().substring(0,50),reactFired:!!reactFired,changed:before!==(${FP}),fp:before});})()`;

  let result;
  if (ref) {
    result = await clickWithRetry(coreJS(`mcpFindRef('${ref}')`, `Element not found: ref=${ref}`));
  } else if (selector) {
    const sel = escJsSingleQuote(selector);
    result = await clickWithRetry(coreJS(`mcpQuerySelectorDeep('${sel}')`, `Element not found: ${selector}`));
  } else if (text) {
    const safeText = escJsSingleQuote(text);
    result = await clickWithRetry(coreJS(`mcpFindText('${safeText}',true)||mcpFindText('${safeText}',false)`, `Element not found with text: ${text}`));
  } else if (x !== undefined && y !== undefined) {
    result = await clickWithRetry(coreJS(`mcpElementFromPoint(${Number(x)},${Number(y)})`, `No element at (${Number(x)},${Number(y)})`));
  } else {
    throw new Error("click requires selector, text, or x/y coordinates");
  }

  if (typeof result === 'string' && result.startsWith('__SELECT_GUARD__:')) {
    const detail = result.substring('__SELECT_GUARD__:'.length);
    throw new Error(`Target is a native <select> (${detail}). Use safari_select_option with a value matching one of the options instead — clicking it would open the OS picker and block.`);
  }

  // Structured result from coreJS. Fall back to the raw string for forward-compat.
  let info;
  try { info = JSON.parse(result); } catch { return result; }
  if (info.err) return info.err;
  const label = info.tag + (info.text ? ` "${info.text}"` : '');

  // A React handler fired, or the page observably changed → the click landed.
  if (info.reactFired || info.changed) return 'Clicked: ' + label;

  // No React handler and no synchronous effect. Give an async handler a brief moment,
  // then re-check before deciding the click was truly ignored.
  await new Promise(r => setTimeout(r, 320));
  const afterFp = await runJS(FP).catch(() => null);
  if (afterFp != null && afterFp !== info.fp) return 'Clicked: ' + label;

  // Synthetic events were ignored — the handler gates on event.isTrusted (Clutch, G2,
  // Cloudflare-class sites). Escalate to a real OS-level CGEvent click (isTrusted:true).
  // If a handler genuinely has no observable effect (pure analytics, slow >320ms async),
  // this re-fires it once via the native click — an accepted, low-cost trade-off.
  try {
    await nativeClick({ selector, text, x, y, ref });
    return 'Clicked (native fallback — synthetic click had no effect): ' + label;
  } catch (e) {
    return 'Clicked: ' + label + ' — ⚠️ synthetic click produced no detectable effect and the native fallback is unavailable (' + ((e && e.message) || e) + '). Retry with safari_native_click.';
  }
}

export async function doubleClick({ selector, x, y, ref }) {
  if (ref) selector = refSelector(ref);
  if (selector) {
    const sel = escJsSingleQuote(selector);
    return runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found: ${sel}';el.scrollIntoView({block:'center'});el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));return 'Double-clicked: '+el.tagName;})()`
    );
  }
  if (x !== undefined && y !== undefined) {
    return runJS(
      `(function(){var el=document.elementFromPoint(${Number(x)},${Number(y)});if(!el)return 'No element at (${x},${y})';el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));return 'Double-clicked: '+el.tagName+' at (${x},${y})';})()`
    );
  }
  throw new Error("doubleClick requires selector or x/y coordinates");
}

export async function rightClick({ selector, x, y }) {
  if (selector) {
    const sel = escJsSingleQuote(selector);
    return runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found: ${sel}';el.scrollIntoView({block:'center'});el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));return 'Right-clicked: '+el.tagName;})()`
    );
  }
  if (x !== undefined && y !== undefined) {
    return runJS(
      `(function(){var el=document.elementFromPoint(${Number(x)},${Number(y)});if(!el)return 'No element at (${x},${y})';el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));return 'Right-clicked: '+el.tagName+' at (${x},${y})';})()`
    );
  }
  throw new Error("rightClick requires selector or x/y coordinates");
}

// ========== NATIVE CLICK (OS-level CGEvent — produces isTrusted: true) ==========
// Unlike JS clicks (dispatchEvent/element.click), CGEvent clicks are real OS input.
// Sites with WAF protection (G2, Cloudflare, etc.) that check isTrusted will accept these.
// Trade-off: this moves the physical mouse cursor and requires Safari to be visible.

export async function nativeClick(args) {
  // Helpers are only needed to LOCATE an element (ref/selector/text). With explicit
  // x/y there is nothing to look up, and demanding injection anyway made native_click
  // unusable on exactly the pages that need it: business.facebook.com stalls injection,
  // so ensureHelpers threw INJECT_ERR and the OS-level click — the one thing React's
  // isTrusted-gated handlers do accept — never got to fire.
  const needsLookup = !!(args?.ref || args?.selector || args?.text);
  if (needsLookup) await ensureHelpers();
  // When the extension told us exactly which window+tab holds this session's page,
  // pin everything to it. Otherwise fall back to the profile-name lookup — which
  // picks the FIRST matching window and silently misses when the profile has several.
  if (args?.locus) {
    const pinned = await _pinWindowFromLocus(args.locus);
    if (pinned) {
      const out = await _withPinnedTabFronted(pinned, () => _nativeClickImpl(args));
      return `${out} [pinned win ${pinned.winId} tab ${pinned.tabIndex}]`;
    }
    return `${await _withTargetTabFronted(() => _nativeClickImpl(args))} [locus unmatched: win ${args.locus.windowId} tab ${args.locus.index}]`;
  }
  // The event is routed to the window's SELECTED tab, so ours has to be it. See _withTargetTabFronted.
  return await _withTargetTabFronted(() => _nativeClickImpl(args));
}

// Translate an extension locus ({windowId (extension-side), index, url, title}) into an
// AppleScript window id. Extension window ids and AppleScript window ids are different
// namespaces, so match by content: the window whose tab at `index` carries the locus URL
// (or title). Returns {winRef, winId, tabIndex} or null when nothing matches.
async function _pinWindowFromLocus(locus) {
  const wanted = String(locus.url || "");
  const wantedTitle = String(locus.title || "");
  const idx = Number(locus.index);
  if (!Number.isFinite(idx) || idx < 1) return null;
  const wantCount = Number(locus.windowTabCount) || 0;
  // Also carry the window's tab COUNT. URL and title both go stale on an SPA, and index
  // alone is ambiguous across windows — but (index, tabCount) together pin one window in
  // practice, and it is the only signal here that a page cannot rewrite.
  const probe = `tell application "Safari"
  set out to ""
  repeat with w in every window
    try
      set c to (count of tabs of w)
      if c >= ${idx} then
        set t to tab ${idx} of w
        set out to out & (id of w as text) & (ASCII character 31) & (URL of t as text) & (ASCII character 31) & (name of t as text) & (ASCII character 31) & (c as text) & (ASCII character 30)
      end if
    end try
  end repeat
  return out
end tell`;
  let raw;
  try { raw = await osascriptFast(probe); } catch (_e) { return null; }
  const rows = String(raw || "").split("\u001E").filter(Boolean).map(r => r.split("\u001F"));
  if (!rows.length) return null;
  const sg = locus.screenGeom;
  if (sg && Number.isFinite(sg.sx) && rows.length > 1) {
    const boundsProbe = `tell application "Safari"
  set out to ""
  repeat with w in every window
    try
      set b to bounds of w
      set out to out & (id of w as text) & (ASCII character 31) & (item 1 of b as text) & (ASCII character 31) & (item 2 of b as text) & (ASCII character 30)
    end try
  end repeat
  return out
end tell`;
    try {
      const braw = await osascriptFast(boundsProbe);
      const brows = String(braw || "").split("\u001E").filter(Boolean).map(r => r.split("\u001F"));
      const chrome = (sg.oh && sg.ih) ? (sg.oh - sg.ih) : 90;
      const m = brows.find(([, bx, by]) =>
        Math.abs(Number(bx) - sg.sx) <= 4 && Math.abs(Number(by) - (sg.sy - chrome)) <= 8);
      if (m) return { winRef: `window id ${m[0]}`, winId: Number(m[0]), tabIndex: idx };
    } catch (_e) { /* fall through to content matching */ }
  }
  // Match on URL, then title. An SPA rewrites its URL while you work, so neither is
  // reliable on its own — but when only ONE window even HAS a tab at this index, that
  // is the window and no content match is needed. That last case is the common one,
  // and without it the whole pin failed and fell back to the first-window-by-name
  // guess, which is exactly the bug this exists to fix.
  const byCount = wantCount ? rows.filter(([, , , c]) => Number(c) === wantCount) : [];
  let hit = rows.find(([, u]) => wanted && u === wanted)
    || rows.find(([, u]) => wanted && wanted.length > 30 && u && u.startsWith(wanted.split("?")[0]))
    || rows.find(([, , t]) => wantedTitle && t === wantedTitle)
    || (byCount.length === 1 ? byCount[0] : null)
    || (rows.length === 1 ? rows[0] : null);
  if (!hit) return null;
  return { winRef: `window id ${hit[0]}`, winId: Number(hit[0]), tabIndex: idx };
}

// An `elsewhere` for runJS/runJSLarge (see _resolveSessionTab): the window `locate()` (index.js
// asking the extension for this session's tab) says holds the tab. Asked at most once, and only
// when the target window has no tab carrying the marker; no answer leaves the scan as it was.
function _locusWindows(locate) {
  if (!locate) return null;
  let wins = null;
  return () => (wins ??= Promise.resolve()
    .then(locate)
    .then((locus) => (locus ? _pinWindowFromLocus(locus) : null))
    .then((pinned) => (pinned ? [pinned.winRef] : []), () => []));
}

// Like _withTargetTabFronted, but for an explicit window+tab. Selects the session's tab
// in ITS OWN window (not whichever window matched the profile name first), runs fn, and
// restores the previous selection.
async function _withPinnedTabFronted(pinned, fn) {
  const { winRef, tabIndex } = pinned;
  let prev = null;
  try {
    prev = Number(await osascriptFast(`tell application "Safari" to tell ${winRef} to return (index of current tab) as text`));
  } catch (_e) { /* window may refuse — run anyway; the click itself will fail loudly */ }
  const mustSwitch = Number.isFinite(prev) && prev !== tabIndex;
  if (mustSwitch) {
    await osascriptFast(`tell application "Safari" to tell ${winRef} to set current tab to tab ${tabIndex}`);
    await new Promise((r) => setTimeout(r, NATIVE_TAB_SETTLE_MS));
  }
  // On macOS 26 a window-targeted CGEvent silently no-ops when the target window is
  // NOT the frontmost Safari window (issue #29 — verified live: the math was right,
  // the event was delivered, the checkbox never toggled; a front-window click landed).
  // Raise the pinned window within Safari for the duration of the click. This does not
  // steal app focus — Safari's window order changes, the active app does not.
  let prevFrontWinId = null;
  try {
    prevFrontWinId = Number(await osascriptFast(`tell application "Safari" to return (id of front window) as text`));
  } catch (_e) { /* leave as-is */ }
  const mustRaise = Number.isFinite(prevFrontWinId) && prevFrontWinId !== pinned.winId;
  if (mustRaise) {
    await osascriptFast(`tell application "Safari" to tell ${winRef} to set index to 1`);
    await new Promise((r) => setTimeout(r, NATIVE_TAB_SETTLE_MS));
  }
  // A CGEvent goes to the FRONTMOST APPLICATION, not to the window id we aim at.
  // Measured 23.8.26: WhatsApp was frontmost, so every "successful" native click was
  // delivered to WhatsApp — the page never saw it. Raising Safari's own window (above)
  // does not change which app is frontmost; Safari itself has to be activated.
  // This is the one moment the tool legitimately needs the foreground, and the saved
  // app is handed back in the finally below.
  const savedApp = await saveFrontmostApp().catch(() => null);
  const mustActivate = savedApp !== "com.apple.Safari";
  if (mustActivate) {
    await _helperActivateApp("com.apple.Safari").catch(() => {});
    await new Promise((r) => setTimeout(r, 150)); // activate() is async at the OS level
  }
  // With Safari genuinely frontmost and the right window raised, use the GLOBAL event
  // tap instead of postToPid. Verified 23.8.26 on macOS 26: a window-targeted
  // postToPid click reports success and never reaches the page — proven on a plain
  // <a> in example.com with a click listener armed, which never fired. The global tap
  // moves the cursor, clicks, and restores it — the same path a person's click takes,
  // and the only one that actually lands. This is why the pin has to raise Safari.
  _pinnedForceGlobalTap = true;
  // _nativeClickImpl reads geometry via _getSafariWindowGeometry(), which resolves the
  // profile window by name. Override the resolution for the duration of this call so
  // geometry, toolbar math, and the CGEvent all target the pinned window.
  const prevOverride = _pinnedWindowOverride;
  _pinnedWindowOverride = pinned;
  try {
    return await fn();
  } finally {
    _pinnedWindowOverride = prevOverride;
    _pinnedForceGlobalTap = false;
    if (mustSwitch) {
      try { await osascriptFast(`tell application "Safari" to tell ${winRef} to set current tab to tab ${prev}`); }
      catch (_e) { /* restore is best-effort */ }
    }
    // Hand the previous front window back — the user (or another session) had it up.
    if (mustRaise && Number.isFinite(prevFrontWinId)) {
      try { await osascriptFast(`tell application "Safari" to tell window id ${prevFrontWinId} to set index to 1`); }
      catch (_e) { /* restore is best-effort */ }
    }
    // And give the foreground back to whatever app had it. restoreFocusIfStolen keeps
    // its own guard: if the user has been interacting, it leaves Safari alone rather
    // than yanking the window out from under them.
    if (mustActivate && savedApp) {
      try { await restoreFocusIfStolen(savedApp); } catch (_e) { /* best-effort */ }
    }
  }
}
let _pinnedWindowOverride = null;
// Set only inside a pinned click, where Safari has been raised to the front. Tells the
// click layer to use the global event tap (windowId 0) instead of postToPid.
let _pinnedForceGlobalTap = false;

async function _nativeClickImpl({ selector, text, x, y, ref, doubleClick = false }) {

  // Step 1: Get element's viewport coordinates via JavaScript
  let viewportCoords;
  if (ref || selector || text) {
    let jsExpr;
    if (ref) {
      jsExpr = `(function(){
        var el = mcpFindRef('${ref}');
        if (!el) return JSON.stringify({error: 'Element not found: ref=${ref}'});
        el.scrollIntoView({block:'center', behavior:'instant'});
        var rect = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          tag: el.tagName,
          text: (el.innerText || el.textContent || '').trim().substring(0, 50)
        });
      })()`;
    } else if (selector) {
      const sel = escJsSingleQuote(selector);
      jsExpr = `(function(){
        var el = document.querySelector('${sel}');
        if (!el) return JSON.stringify({error: 'Element not found: ${sel}'});
        el.scrollIntoView({block:'center', behavior:'instant'});
        var rect = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          tag: el.tagName,
          text: (el.innerText || el.textContent || '').trim().substring(0, 50)
        });
      })()`;
    } else {
      const safeText = escJsSingleQuote(text);
      jsExpr = `(function(){
        var el = mcpFindText('${safeText}', true) || mcpFindText('${safeText}', false);
        if (!el) return JSON.stringify({error: 'Element not found with text: ${safeText}'});
        el.scrollIntoView({block:'center', behavior:'instant'});
        var rect = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          tag: el.tagName,
          text: (el.innerText || el.textContent || '').trim().substring(0, 50)
        });
      })()`;
    }

    const result = await runJS(jsExpr);
    try {
      viewportCoords = JSON.parse(result);
    } catch {
      throw new Error("Failed to get element coordinates: " + result);
    }
    if (viewportCoords.error) {
      throw new Error(viewportCoords.error);
    }
  } else if (x !== undefined && y !== undefined) {
    // Direct viewport coordinates provided
    viewportCoords = { x: Number(x), y: Number(y), tag: 'point', text: '' };
  } else {
    throw new Error("nativeClick requires selector, text, ref, or x/y coordinates");
  }

  // Step 2: Get Safari window position and toolbar geometry
  const geo = await _getSafariWindowGeometry();

  // Step 3: Calculate absolute screen coordinates
  // screenX = windowLeft + viewportX
  // screenY = windowTop + toolbarHeight + viewportY
  const screenX = geo.windowX + viewportCoords.x;
  const screenY = geo.windowY + geo.toolbarHeight + viewportCoords.y;

  // Sanity check: ensure coordinates are within the window bounds
  if (screenX < geo.windowX || screenX > geo.windowRight ||
      screenY < geo.windowY || screenY > geo.windowBottom) {
    console.error(`[Safari MCP] nativeClick: coords (${screenX},${screenY}) outside window bounds (${geo.windowX},${geo.windowY})-(${geo.windowRight},${geo.windowBottom}). Proceeding anyway.`);
  }

  // Step 4: Perform the native click via CGEvent (targeted to specific window — no mouse move, no focus steal)
  // MUST have windowId — legacy path (windowId=0) moves mouse and may steal focus
  if (!geo.windowId) throw new Error("Cannot native-click without Safari window ID — would move mouse and steal focus");
  // windowId 0 selects the global tap. Only a pinned click may ask for it: that path
  // has already raised Safari and its own window, so moving the cursor is expected and
  // the focus is handed back afterwards.
  await _helperNativeClick(screenX, screenY, doubleClick, _pinnedForceGlobalTap ? 0 : geo.windowId);

  const clickType = doubleClick ? 'Native double-clicked' : 'Native clicked';
  const label = viewportCoords.tag + (viewportCoords.text ? ` "${viewportCoords.text}"` : '');
  return `${clickType}: ${label} at screen (${screenX},${screenY})`;
}

// ========== NATIVE HOVER (OS-level CGEvent mouse move — triggers real :hover and mouseenter) ==========
// JS-dispatched mouseenter events work for most React components, but some UIs
// (Discord sidebar, virtualized CSS :hover tooltips, custom portal-rendered
// tooltips) only respond to a real OS-level cursor position. This function
// moves the physical cursor to the target, dwells for tooltips to render,
// then optionally restores the cursor to its original position.
export async function nativeHover(args) {
  await ensureHelpers();
  return await _withTargetTabFronted(() => _nativeHoverImpl(args));
}

async function _nativeHoverImpl({ selector, text, x, y, ref, dwellMs = 500, restoreMouse = true }) {

  // Step 1: Get element's viewport coordinates via JavaScript
  let viewportCoords;
  if (ref || selector || text) {
    let jsExpr;
    if (ref) {
      jsExpr = `(function(){
        var el = mcpFindRef('${ref}');
        if (!el) return JSON.stringify({error: 'Element not found: ref=${ref}'});
        el.scrollIntoView({block:'center', behavior:'instant'});
        var rect = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          tag: el.tagName,
          text: (el.innerText || el.textContent || '').trim().substring(0, 50)
        });
      })()`;
    } else if (selector) {
      const sel = escJsSingleQuote(selector);
      jsExpr = `(function(){
        var el = document.querySelector('${sel}');
        if (!el) return JSON.stringify({error: 'Element not found: ${sel}'});
        el.scrollIntoView({block:'center', behavior:'instant'});
        var rect = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          tag: el.tagName,
          text: (el.innerText || el.textContent || '').trim().substring(0, 50)
        });
      })()`;
    } else {
      const safeText = escJsSingleQuote(text);
      jsExpr = `(function(){
        var el = mcpFindText('${safeText}', true) || mcpFindText('${safeText}', false);
        if (!el) return JSON.stringify({error: 'Element not found with text: ${safeText}'});
        el.scrollIntoView({block:'center', behavior:'instant'});
        var rect = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          tag: el.tagName,
          text: (el.innerText || el.textContent || '').trim().substring(0, 50)
        });
      })()`;
    }

    const result = await runJS(jsExpr);
    try {
      viewportCoords = JSON.parse(result);
    } catch {
      throw new Error("Failed to get element coordinates: " + result);
    }
    if (viewportCoords.error) {
      throw new Error(viewportCoords.error);
    }
  } else if (x !== undefined && y !== undefined) {
    viewportCoords = { x: Number(x), y: Number(y), tag: 'point', text: '' };
  } else {
    throw new Error("nativeHover requires selector, text, ref, or x/y coordinates");
  }

  const geo = await _getSafariWindowGeometry();
  const screenX = geo.windowX + viewportCoords.x;
  const screenY = geo.windowY + geo.toolbarHeight + viewportCoords.y;

  if (!geo.windowId) throw new Error("Cannot native-hover without Safari window ID — would move mouse and steal focus");
  await _helperNativeHover(screenX, screenY, geo.windowId, dwellMs, restoreMouse);

  const label = viewportCoords.tag + (viewportCoords.text ? ` "${viewportCoords.text}"` : '');
  return `Native hovered: ${label} at screen (${screenX},${screenY}) for ${dwellMs}ms${restoreMouse ? ' (mouse restored)' : ''}`;
}

// ========== FORM INPUT ==========

export async function fill({ selector, value, ref }) {
  if (ref) selector = refSelector(ref);
  if (!selector) throw new Error("fill requires selector or ref");
  const sel = escJsSingleQuote(selector);
  // Proper escaping order: backslashes first, then quotes
  const val = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "");
  // Same value encoded for the Lexical JSON literal (Strategy 2): JSON-escape first
  // (quotes/newlines/backslashes), then escape for the surrounding single-quoted JS
  // string. `val` alone broke the JSON on any double-quote, and parseEditorState's
  // silent catch made the whole strategy vanish without a trace.
  const lexVal = JSON.stringify(String(value)).slice(1, -1).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const result = await runJS(
    `(function(){try{var el=document.querySelector('${sel}');if(!el){var q=function(r){var a=r.querySelectorAll('*');for(var i=0;i<a.length;i++){if(a[i].shadowRoot){el=a[i].shadowRoot.querySelector('${sel}');if(el)return el;el=q(a[i].shadowRoot);if(el)return el;}}return null;};el=q(document);}if(!el)return 'Element not found: ${sel}';el.focus();if(el.isContentEditable||el.getAttribute('contenteditable')==='true'){` +
    // Quill editor detection (LinkedIn share composer in 2026 — they migrated from
    // ProseMirror, Slack message editor, many enterprise apps). The Quill instance is
    // attached to `.ql-container.__quill` (v2) or accessible via React Fiber's
    // memoizedProps/stateNode. Without proper API access, fill-by-DOM crashes Quill's
    // internal Delta state and dismisses the dialog (the v2.10.0 LinkedIn bug repro).
    `var qlEditor=el.classList&&el.classList.contains('ql-editor')?el:el.closest('.ql-editor');` +
    `if(qlEditor){` +
      `var qlContainer=qlEditor.closest('.ql-container')||qlEditor.parentElement;` +
      `var quill=(qlContainer&&qlContainer.__quill)||null;` +
      // Fallback: walk React Fiber to find the Quill instance attached as a prop or stateNode
      `if(!quill&&qlContainer){var qfk=Object.keys(qlContainer).find(function(k){return k.indexOf('__reactFiber')===0||k.indexOf('__reactInternalInstance')===0;});if(qfk){var qf=qlContainer[qfk];for(var qd=0;qd<25&&qf;qd++){var qp=qf.memoizedProps;if(qp&&qp.quill&&typeof qp.quill.setContents==='function'){quill=qp.quill;break;}var qsn=qf.stateNode;if(qsn&&qsn.quill&&typeof qsn.quill.setContents==='function'){quill=qsn.quill;break;}qf=qf.return;}}}` +
      `if(quill&&typeof quill.setContents==='function'){` +
        `try{` +
          // Convert escaped string back to real string for Quill API.
          // The val template var has \\n / \\\\ / \\' applied, so we need to unescape for setText.
          `var qlText='${val}'.replace(/\\\\n/g,'\\n').replace(/\\\\'/g,"'").replace(/\\\\\\\\/g,'\\\\');` +
          // setContents with a plain text Delta — bypasses clipboard, no synthetic events,
          // doesn't trigger LinkedIn's focusout-dismiss handler.
          `quill.setContents([{insert: qlText + '\\n'}], 'api');` +
          `quill.setSelection(qlText.length, 0, 'api');` +
          // Verify the text actually committed
          `var qlActual=quill.getText().replace(/\\n+$/,'');` +
          `if(qlActual.indexOf(qlText.substring(0, Math.min(20, qlText.length)))>=0){return 'Filled CE (Quill setContents)';}` +
        `}catch(_qE){}` +
      `}` +
      // Quill instance not found via direct or Fiber — route to native paste fallback.
      // Quill respects real isTrusted clipboard events, so CGEvent Cmd+V works.
      `return '__NATIVE_PASTE_DIALOG__';` +
    `}` +
    // Lexical editor detection (LinkedIn share composer, modern Meta/Shopify apps).
    // Three lookup strategies, cheapest first:
    //   A) [data-lexical-editor="true"] on ancestor with __lexicalEditor property.
    //   B) Walk DOM ancestors for __lexicalEditor (nested-config wrappers).
    //   C) React Fiber walk — LinkedIn sometimes obfuscates __lexicalEditor, so we
    //      locate the editor by duck-typing: any object on props/state/stateNode
    //      that exposes both parseEditorState AND setEditorState is the editor.
    // Once found, two fill strategies, both pure DOM (no CGEvent, no focus shift):
    //   1) InputEvent('beforeinput', insertFromPaste + DataTransfer) — Lexical's
    //      handleBeforeInput reads dataTransfer and commits via editor.update().
    //   2) parseEditorState() + setEditorState() with a minimal paragraph doc —
    //      used when Lexical ignores synthetic paste events.
    `var lexEl=el.closest('[data-lexical-editor="true"]');var lex=(lexEl&&lexEl.__lexicalEditor)||null;` +
    `if(!lex){var lexCur=el;for(var lexI=0;lexI<15&&lexCur;lexI++){if(lexCur.__lexicalEditor){lexEl=lexCur;lex=lexCur.__lexicalEditor;break;}lexCur=lexCur.parentElement;}}` +
    `if(!lex){var lexHost=lexEl||el;var lexFk=null;for(var lfk in lexHost){if(lfk.indexOf('__reactFiber')===0||lfk.indexOf('__reactInternalInstance')===0){lexFk=lfk;break;}}` +
      `if(lexFk){var lexF=lexHost[lexFk];var lexIsEd=function(o){return o&&typeof o.parseEditorState==='function'&&typeof o.setEditorState==='function';};` +
        `for(var lexD=0;lexD<30&&lexF;lexD++){var lp=lexF.memoizedProps;if(lp){for(var lpk in lp){if(lexIsEd(lp[lpk])){lex=lp[lpk];break;}}}` +
        `if(!lex){var ls=lexF.memoizedState;while(ls){if(lexIsEd(ls.memoizedState)){lex=ls.memoizedState;break;}ls=ls.next;}}` +
        `if(!lex){var lsn=lexF.stateNode;if(lsn){if(lexIsEd(lsn))lex=lsn;else if(lsn.editor&&lexIsEd(lsn.editor))lex=lsn.editor;}}` +
        `if(lex)break;lexF=lexF.return;}}}` +
    `if(lex){if(!lexEl){lexEl=lex._rootElement||el;}` +
      // Strategy 1: beforeinput with insertFromPaste + DataTransfer
      `try{lexEl.focus();var lexSel=window.getSelection();if(lexSel){var lexRng=document.createRange();lexRng.selectNodeContents(lexEl);lexSel.removeAllRanges();lexSel.addRange(lexRng);}var lexDt=new DataTransfer();lexDt.setData('text/plain','${val}');var lexBi=new InputEvent('beforeinput',{inputType:'insertFromPaste',dataTransfer:lexDt,bubbles:true,cancelable:true});var lexCancelled=!lexEl.dispatchEvent(lexBi);if(lexCancelled||lexEl.textContent.indexOf('${val.substring(0, 20)}')>=0){return 'Filled CE (Lexical beforeinput paste)';}}catch(lexE1){}` +
      // Strategy 2: parseEditorState + setEditorState (direct state replacement)
      `try{var lexJson='{"root":{"children":[{"children":[{"detail":0,"format":0,"mode":"normal","style":"","text":"${lexVal}","type":"text","version":1}],"direction":"ltr","format":"","indent":0,"textFormat":0,"type":"paragraph","version":1}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}';var lexNs=lex.parseEditorState(lexJson);lex.setEditorState(lexNs);if(typeof lex.focus==='function')lex.focus();return 'Filled CE (Lexical setEditorState)';}catch(lexE2){}` +
    `}` +
    // ProseMirror detection
    `var pm=el.closest('.ProseMirror')||el.querySelector('.ProseMirror');if(pm){try{var v=null;if(pm.pmViewDesc&&pm.pmViewDesc.view)v=pm.pmViewDesc.view;else if(pm.cmView&&pm.cmView.view)v=pm.cmView.view;else{var keys=Object.keys(pm);for(var ki=0;ki<keys.length;ki++){var o=pm[keys[ki]];if(o&&o.state&&o.dispatch){v=o;break;}}}` +
    // React Fiber walk for ProseMirror view (LinkedIn, Tiptap-React)
    `if(!v){var fk=Object.keys(pm).find(function(k){return k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$');});if(fk){var fiber=pm[fk];for(var d=0;d<20&&fiber;d++){var props=fiber.memoizedProps||(fiber.stateNode&&fiber.stateNode.props);if(props){var pv=props.editorView||props.view;if(pv&&pv.state&&pv.dispatch){v=pv;break;}}fiber=fiber.return;}}}` +
    `if(v&&v.state&&v.dispatch){try{var doc=v.state.doc;var hasContent=doc.textContent&&doc.textContent.trim().length>0;if(hasContent){var endPos=doc.content.size>1?doc.content.size-1:doc.content.size;v.dispatch(v.state.tr.insertText(' ${val}',endPos));}else{var tr=v.state.tr;tr.replaceWith(0,doc.content.size,v.state.schema.text('${val}'));v.dispatch(tr);}v.focus();` +
      // Verify the dispatch actually committed — LinkedIn's PM sometimes accepts the
      // tr but rolls it back on the next tick (its readOnly plugin reasserts state).
      // If the doc text doesn't contain our value within 50ms, route to native paste.
      `var pmCheck=(v.state.doc.textContent||'')+' '+(pm.textContent||'');` +
      `if(pmCheck.indexOf('${val.substring(0, Math.min(20, val.length))}')>=0){return 'Filled CE (ProseMirror)';}` +
      `}catch(_pmE){}}}catch(e){}}` +
    // ProseMirror detected but no view — in a dialog (LinkedIn share composer), go to
    // native paste (real CGEvent Cmd+V) so ProseMirror's isTrusted-gated paste handler
    // accepts the insertion and the dialog doesn't dismiss. Outside a dialog fall back
    // to char-by-char beforeinput (works on Discord-style PM without dismissal risk).
    `if(pm&&!v){var inDlg=!!el.closest('[role="dialog"]');if(inDlg){return '__NATIVE_PASTE_DIALOG__';}return '__PM_CHARBYCHAR__';}` +
    // Closure/Medium detection — signal for native paste.
    // Match any of: closure_uid_ key on element, medium.com hostname, ancestor with
    // closure markers, or window.goog.events/goog.editor.Plugin globals (broader catch
    // for Closure-built editors outside Medium).
    `var isClosure=false;` +
    `try{` +
    `if(Object.keys(el).some(function(k){return k.indexOf('closure_uid_')===0||k.indexOf('closure_lm_')===0;}))isClosure=true;` +
    `else if(location.hostname.indexOf('medium.com')>=0)isClosure=true;` +
    `else if(typeof goog!=='undefined'&&goog&&(goog.events||goog.editor))isClosure=true;` +
    `else{var clCur=el.parentElement,clHop=0;while(clCur&&clHop<10){if(Object.keys(clCur).some(function(k){return k.indexOf('closure_uid_')===0;})){isClosure=true;break;}clCur=clCur.parentElement;clHop++;}}` +
    `}catch(_clE){}` +
    `if(isClosure){return '__CLOSURE_NATIVE_PASTE__';}` +
    // Synthetic ClipboardEvent paste — works on ProseMirror, TipTap, Slate, and most modern editors
    // that don't respond to execCommand but DO handle paste events
    // Pre-clear: select all + delete BEFORE paste. Some editors (X's tweetTextarea_0
    // when it has URL-prefilled content from /intent/post?text=, Quill in some configs)
    // append paste content to selection instead of replacing — explicit delete avoids
    // the duplication seen when the textarea was pre-populated by URL parameters.
    `try{el.focus();var sel2=window.getSelection();if(sel2.rangeCount){var rng=document.createRange();rng.selectNodeContents(el);sel2.removeAllRanges();sel2.addRange(rng);document.execCommand('delete',false,null);}var dt=new DataTransfer();dt.setData('text/plain','${val}');var pe=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});var handled=!el.dispatchEvent(pe);if(handled||el.textContent.indexOf('${val.substring(0, 20)}')>=0){return 'Filled CE (synthetic paste)';}}catch(ep){}` +
    // Synthetic paste did not verify — in a dialog, route to native paste (CGEvent Cmd+V)
    // to produce real isTrusted:true events. Avoids LinkedIn-style dialog dismissal too.
    `if(!!el.closest('[role="dialog"]')){return '__NATIVE_PASTE_DIALOG__';}` +
    // Default contenteditable: selectAll+delete+insert. No blur — blur dismisses dialogs
    // and nearby popovers; React only needs 'input' to see the change.
    `document.execCommand('selectAll');document.execCommand('delete');document.execCommand('insertText',false,'${val}');el.dispatchEvent(new Event('input',{bubbles:true}));return 'Filled contenteditable';}` +
    // Standard input/textarea with _valueTracker.
    //   • focus() FIRST — Formik/HubSpot read focused state during onChange validation.
    //   • InputEvent with inputType:'insertReplacementText' + data — React 18 RSC, Next.js,
    //     and Featured.com require a real InputEvent (not plain Event) to update store state.
    //   • composed:true on every event — pierces Shadow DOM (Reddit, web components).
    //   • blur/focusout SUPPRESSED inside dialogs — blur dismisses LinkedIn share composer
    //     and many MUI/Radix dialogs. React only needs 'input' to see the change anyway.
    //   • Post-fill verification — if el.value !== expected after dispatch, signal the wrapper
    //     to try native CGEvent paste fallback (real isTrusted events).
    `var inDlg=!!(el.closest&&el.closest('[role="dialog"]'));` +
    `var t=el._valueTracker;if(t)t.setValue('');` +
    `var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;` +
    `var s=Object.getOwnPropertyDescriptor(proto,'value');` +
    `if(s&&s.set){s.set.call(el,'${val}');}else{el.value='${val}';}` +
    `try{el.dispatchEvent(new InputEvent('input',{inputType:'insertReplacementText',data:'${val}',bubbles:true,composed:true,cancelable:true}));}catch(_iE){el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));}` +
    `el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));` +
    `if(!inDlg){el.dispatchEvent(new Event('blur',{bubbles:true,composed:true}));el.dispatchEvent(new Event('focusout',{bubbles:true,composed:true}));el.focus();}` +
    `var actual=(el.value!==undefined?el.value:'');` +
    `if(actual!=='${val}'){return '__FILL_VALUE_MISMATCH__:'+actual.substring(0,80);}` +
    `return 'Filled: '+actual.substring(0,50);}catch(e){return 'ERR: '+e.message;}})()`
  );

  // ProseMirror editor with no view access: use char-by-char with beforeinput events
  if (result === "__PM_CHARBYCHAR__") {
    const rawValue = value;
    const lines = rawValue.split('\n');
    const charInserts = lines.map((line, i) => {
      const escaped = line.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      let cmds = '';
      if (i > 0) {
        cmds += `t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,code:'Enter',bubbles:true,cancelable:true}));`;
        cmds += `t.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertParagraph',bubbles:true,cancelable:true}));`;
        cmds += `document.execCommand('insertParagraph');`;
        cmds += `t.dispatchEvent(new InputEvent('input',{inputType:'insertParagraph',bubbles:true}));`;
        cmds += `t.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',keyCode:13,code:'Enter',bubbles:true}));`;
      }
      if (escaped.length > 0) {
        // Insert text in one beforeinput + execCommand, then fire input
        cmds += `t.dispatchEvent(new InputEvent('beforeinput',{data:'${escaped}',inputType:'insertText',bubbles:true,cancelable:true}));`;
        cmds += `document.execCommand('insertText',false,'${escaped}');`;
        cmds += `t.dispatchEvent(new InputEvent('input',{data:'${escaped}',inputType:'insertText',bubbles:true}));`;
      }
      return cmds;
    }).join('');

    const fillResult = await runJS(
      `(function(){` +
      `var el=document.querySelector('${escJsSingleQuote(selector)}');` +
      `if(!el)return 'Element not found';` +
      `el.focus();el.click();` +
      `var t=document.activeElement||el;` +
      charInserts +
      // Verification: count actual text length vs expected. If char-by-char dropped
      // intermediate paragraphs (Hashnode-style Tiptap with markdown-like chars at
      // line starts: `>`, `**`, `[`), fall back to execCommand('insertHTML') with
      // paragraph-wrapped HTML.
      `var actualLen=(el.innerText||'').length;` +
      `var expectedLen=${value.length};` +
      `if(actualLen<expectedLen*0.6){` +
        // Clear and re-fill via insertHTML
        `var sel=window.getSelection();var r=document.createRange();r.selectNodeContents(el);sel.removeAllRanges();sel.addRange(r);` +
        `document.execCommand('delete',false,null);` +
        // Build paragraph HTML from the original value
        `var paras=${JSON.stringify(value)}.split(/\\n\\n+/).filter(function(p){return p.trim().length>0;});` +
        `var html=paras.map(function(p){var safe=p.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>');return '<p>'+safe+'</p>';}).join('');` +
        `el.focus();var sel2=window.getSelection();var r2=document.createRange();r2.selectNodeContents(el);r2.collapse(true);sel2.removeAllRanges();sel2.addRange(r2);` +
        `document.execCommand('insertHTML',false,html);` +
        `return 'Filled CE (ProseMirror insertHTML fallback, '+(el.innerText||'').length+'/'+expectedLen+')';` +
      `}` +
      `return 'Filled CE (ProseMirror char-by-char)';` +
      `})()`
    );
    return fillResult;
  }

  // Closure/Medium editor: insert line-by-line via execCommand in small batches
  // No focus stealing, no System Events, no clipboard manipulation.
  // Medium's Closure editor accepts execCommand('insertText') for individual lines
  // and execCommand('insertParagraph') for line breaks — the key is doing it
  // within a single do-JavaScript call so the mutation observer stays in sync.
  if (result === "__CLOSURE_NATIVE_PASTE__") {
    const rawValue = value;
    // Split into lines, escape each for JS string
    const lines = rawValue.split('\n');
    // Build a JS script that inserts line by line
    const lineInserts = lines.map((line, i) => {
      const escaped = line.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      if (i === 0) {
        return escaped.length > 0 ? `document.execCommand('insertText',false,'${escaped}');` : '';
      }
      return `document.execCommand('insertParagraph');` +
        (escaped.length > 0 ? `document.execCommand('insertText',false,'${escaped}');` : '');
    }).join('');

    const fillResult = await runJS(
      `(function(){` +
      `var el=document.querySelector('${escJsSingleQuote(selector)}');` +
      `if(!el)return 'Element not found';` +
      `el.focus();el.click();` +
      `var sel=window.getSelection();if(sel.rangeCount){var r=document.createRange();r.selectNodeContents(el);r.collapse(false);sel.removeAllRanges();sel.addRange(r);}` +
      lineInserts +
      `return 'Filled CE (Closure line-by-line)';` +
      `})()`
    );
    return fillResult;
  }

  // Standard input/textarea path returned with el.value mismatched against expected —
  // typically Next.js RSC (Featured.com) or HubSpot Formik silently ignored the property
  // descriptor setter. Fall back to native CGEvent Cmd+V paste — real keyboard events
  // route through the framework's normal input pipeline.
  if (typeof result === 'string' && result.startsWith('__FILL_VALUE_MISMATCH__')) {
    const sel = escJsSingleQuote(selector);
    await runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'not-found';` +
      `el.focus();if('select' in el){el.select();}else if(el.setSelectionRange){el.setSelectionRange(0,(el.value||'').length);}` +
      `return 'focused';})()`
    );
    await new Promise(r => setTimeout(r, 30));
    try {
      await _nativeTypeViaClipboard(value);
      return `Filled (native paste fallback after value-mismatch, ${value.length} chars)`;
    } catch (e) {
      return `${result} (native paste fallback failed: ${e.message})`;
    }
  }

  // ProseMirror/contenteditable inside a dialog (LinkedIn share composer is the canonical
  // case). Synthetic events get rejected by isTrusted-gated paste handlers, and stray blur
  // events dismiss the dialog. Use CGEvent Cmd+V — real paste, isTrusted:true, windowed so
  // no focus steal. Requires the element to be focused + have a collapsed selection at end.
  if (result === "__NATIVE_PASTE_DIALOG__") {
    const sel = escJsSingleQuote(selector);
    await runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'not-found';` +
      `el.focus();` +
      // Select all existing content so Cmd+V replaces (not appends)
      `var s=window.getSelection();if(s){var r=document.createRange();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r);}` +
      `return 'focused';})()`
    );
    await new Promise(r => setTimeout(r, 50));
    try {
      await _nativeTypeViaClipboard(value);
      return `Filled CE (native paste in dialog, ${value.length} chars)`;
    } catch (e) {
      return `ERR native paste in dialog: ${e.message}`;
    }
  }

  return result;
}

// Verify the framework-level state of an editor or input matches `expected`.
// Modern editors (ProseMirror, Lexical, Closure, React-controlled inputs) maintain
// state separately from the DOM — `.value` or `.textContent` can show the new text
// while the framework's internal store still holds the old value, so a Submit click
// sends the stale data. Call this after `fill` and BEFORE `click`-Submit.
//
// Returns JSON: { match: boolean, mode: 'input'|'prosemirror'|'lexical'|'closure'|'contenteditable',
//                 actual: string, expected: string, hint?: string }
export async function verifyState({ selector, expected, ref }) {
  if (ref) selector = refSelector(ref);
  if (!selector) throw new Error("verifyState requires selector or ref");
  const sel = escJsSingleQuote(selector);
  const exp = String(expected || '').replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "");
  const expSnippet = String(expected || '').substring(0, 30).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "");
  return runJS(
    `(function(){
      var el = document.querySelector('${sel}');
      if (!el && window.mcpQuerySelectorDeep) el = window.mcpQuerySelectorDeep('${sel}');
      if (!el) return JSON.stringify({ match: false, mode: 'not-found', actual: '', expected: '${exp}' });

      var expected = '${exp}';
      var snippet = '${expSnippet}';

      // ProseMirror — check view state, not DOM
      var pm = el.closest && el.closest('.ProseMirror') || el.querySelector && el.querySelector('.ProseMirror');
      if (pm) {
        var v = (pm.pmViewDesc && pm.pmViewDesc.view) || (pm.cmView && pm.cmView.view) || null;
        if (!v) {
          var keys = Object.keys(pm);
          for (var ki = 0; ki < keys.length; ki++) { var o = pm[keys[ki]]; if (o && o.state && o.dispatch) { v = o; break; } }
        }
        if (!v) {
          var fk = Object.keys(pm).find(function(k){return k.indexOf('__reactFiber')===0||k.indexOf('__reactInternalInstance')===0;});
          if (fk) { var fb = pm[fk]; for (var d=0; d<20 && fb; d++){ var pp=fb.memoizedProps||(fb.stateNode&&fb.stateNode.props); if (pp){ var pv=pp.editorView||pp.view; if (pv&&pv.state){ v=pv; break; }} fb=fb.return; }}
        }
        var pmText = v && v.state && v.state.doc ? (v.state.doc.textContent || '') : (pm.textContent || '');
        return JSON.stringify({ match: pmText.indexOf(snippet) >= 0, mode: 'prosemirror', actual: pmText.substring(0, 200), expected: expected.substring(0, 200) });
      }

      // Lexical — read editor state
      var lexEl = el.closest && el.closest('[data-lexical-editor="true"]');
      var lex = lexEl && lexEl.__lexicalEditor;
      if (!lex) {
        var lc = el; for (var li = 0; li < 15 && lc; li++) { if (lc.__lexicalEditor) { lex = lc.__lexicalEditor; break; } lc = lc.parentElement; }
      }
      if (lex && typeof lex.getEditorState === 'function') {
        try {
          var lexText = '';
          lex.getEditorState().read(function(){
            lexText = (lexEl || el).textContent || '';
          });
          return JSON.stringify({ match: lexText.indexOf(snippet) >= 0, mode: 'lexical', actual: lexText.substring(0, 200), expected: expected.substring(0, 200) });
        } catch (_lE) {}
      }

      // Closure (Medium and similar) — check element textContent (Closure mutates DOM directly)
      var isClosure = Object.keys(el).some(function(k){return k.indexOf('closure_uid_')===0;}) || location.hostname.indexOf('medium.com') >= 0;
      if (isClosure) {
        var clText = el.textContent || '';
        return JSON.stringify({ match: clText.indexOf(snippet) >= 0, mode: 'closure', actual: clText.substring(0, 200), expected: expected.substring(0, 200) });
      }

      // Generic contenteditable
      if (el.isContentEditable) {
        var ceText = el.textContent || '';
        return JSON.stringify({ match: ceText.indexOf(snippet) >= 0, mode: 'contenteditable', actual: ceText.substring(0, 200), expected: expected.substring(0, 200) });
      }

      // Standard input/textarea/select
      var actualVal = el.value !== undefined ? String(el.value) : '';
      var match = actualVal === expected;
      var hint = '';
      // Detect React store/_valueTracker mismatch — common Featured.com / Next.js RSC bug
      if (!match && el._valueTracker && typeof el._valueTracker.getValue === 'function') {
        var tracked = el._valueTracker.getValue();
        if (tracked !== actualVal) hint = 'React _valueTracker out of sync (tracked=' + JSON.stringify(tracked.substring(0, 60)) + ')';
      }
      return JSON.stringify({ match: match, mode: 'input', actual: actualVal.substring(0, 200), expected: expected.substring(0, 200), hint: hint });
    })()`
  );
}

export async function clearField({ selector }) {
  const sel = escJsSingleQuote(selector);
  return runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found: ${sel}';if(el.isContentEditable){el.focus();document.execCommand('selectAll');document.execCommand('delete');el.dispatchEvent(new Event('input',{bubbles:true}));return 'Cleared (contenteditable)';}var t=el._valueTracker;if(t)t.setValue('x');var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(el,'');else el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));return 'Cleared';})()`
  );
}

export async function selectOption({ selector, value, ref }) {
  // ref/deep finder: native <select> elements inside same-origin iframes or shadow
  // DOM are invisible to a top-frame document.querySelector. mcpFindRef (snapshot ref)
  // and mcpQuerySelectorDeep traverse those roots — the same finders click() uses.
  await ensureHelpers();
  const val = String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  let finder;
  if (ref) {
    finder = `mcpFindRef('${String(ref).replace(/'/g, "\\'")}')`;
  } else if (selector) {
    const sel = escJsSingleQuote(selector);
    finder = `(document.querySelector('${sel}')||mcpQuerySelectorDeep('${sel}'))`;
  } else {
    throw new Error("selectOption requires 'ref' or 'selector'");
  }
  return runJS(
    `(function(){var el=${finder};if(!el)return 'Element not found';el.focus();var t=el._valueTracker;if(t)t.setValue('');var d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');if(d&&d.set){d.set.call(el,'${val}');}else{el.value='${val}';}var m=false;for(var i=0;i<el.options.length;i++){if(el.options[i].value==='${val}'){el.selectedIndex=i;m=true;break;}}if(!m||el.value!=='${val}'){var norm=function(s){return s.replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g,'').replace(/[\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]/g,'-').replace(/\\s*-\\s*/g,'-').replace(/\\s+/g,' ').trim();};var cv=norm('${val}');for(var i=0;i<el.options.length;i++){if(norm(el.options[i].value)===cv||norm(el.options[i].text)===cv){el.selectedIndex=i;if(d&&d.set){d.set.call(el,el.options[i].value);}else{el.value=el.options[i].value;}m=true;break;}}if(!m){for(var i=0;i<el.options.length;i++){var nv=norm(el.options[i].value),nt=norm(el.options[i].text);if(nv.indexOf(cv)>=0||nt.indexOf(cv)>=0||cv.indexOf(nv)>=0||cv.indexOf(nt)>=0){if(i===0&&el.options.length>1)continue;el.selectedIndex=i;if(d&&d.set){d.set.call(el,el.options[i].value);}else{el.value=el.options[i].value;}m=true;break;}}}}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));return 'Selected: '+el.value+' (index '+el.selectedIndex+')';})()`
  );
}

// React-Select v5 / Radix-style controlled-select bypass.
// Walks React fiber up from the target element to find a Select component
// (props.options + props.onChange) and calls onChange directly — no menu UI.
// Use when safari_click on the chevron/option fails (Cloudflare token form,
// portal-rendered selects that intercept synthetic events).
export async function reactSelectSet({ selector, ref, value }) {
  await ensureHelpers();
  if (value === undefined || value === null) throw new Error("reactSelectSet requires 'value' (option label)");
  let finder;
  if (ref) {
    const safeRef = String(ref).replace(/'/g, "\\'");
    finder = `mcpFindRef('${safeRef}')`;
  } else if (selector) {
    const sel = escJsSingleQuote(selector);
    finder = `mcpQuerySelectorDeep('${sel}')`;
  } else {
    throw new Error("reactSelectSet requires 'ref' or 'selector'");
  }
  const safeValue = String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const js = `(function(){var el=${finder};if(!el)return JSON.stringify({ok:false,error:'element not found'});return window.mcpReactSelectSet(el,'${safeValue}');})()`;
  return runJS(js);
}

export async function reactSelectListOptions({ selector, ref }) {
  await ensureHelpers();
  let finder;
  if (ref) {
    const safeRef = String(ref).replace(/'/g, "\\'");
    finder = `mcpFindRef('${safeRef}')`;
  } else if (selector) {
    const sel = escJsSingleQuote(selector);
    finder = `mcpQuerySelectorDeep('${sel}')`;
  } else {
    throw new Error("reactSelectListOptions requires 'ref' or 'selector'");
  }
  const js = `(function(){var el=${finder};if(!el)return JSON.stringify({ok:false,error:'element not found'});return window.mcpReactSelectListOptions(el);})()`;
  return runJS(js);
}

export async function fillForm({ fields }) {
  // Single JS call for ALL fields (instead of N separate osascript calls).
  // Same React-state-sync logic as `fill`: _valueTracker reset, prototype-correct setter,
  // InputEvent with inputType, composed events for shadow DOM, dialog-aware blur.
  const fieldsJSON = JSON.stringify(fields.map(f => ({
    s: escJsSingleQuote(f.selector),
    v: f.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n"),
  })));
  return runJS(
    `(function(){
      var fields = ${fieldsJSON};
      var results = [];
      fields.forEach(function(f) {
        var el = document.querySelector(f.s);
        if (!el) {
          var roots = window.mcpCollectRoots ? window.mcpCollectRoots() : [document];
          for (var ri = 0; ri < roots.length && !el; ri++) {
            try { el = roots[ri].querySelector(f.s); } catch (_e) {}
          }
        }
        if (!el) { results.push('Not found: ' + f.s); return; }
        el.focus();
        var inDlg = !!(el.closest && el.closest('[role="dialog"]'));
        if (el.isContentEditable) {
          try {
            var sel = window.getSelection();
            if (sel) { var rng = document.createRange(); rng.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(rng); }
            document.execCommand('delete');
          } catch (_seE) {}
          document.execCommand('insertText', false, f.v);
          el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        } else {
          var t = el._valueTracker; if (t) t.setValue('');
          var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype :
                      el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype :
                      window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(el, f.v);
          else el.value = f.v;
          try { el.dispatchEvent(new InputEvent('input', { inputType: 'insertReplacementText', data: f.v, bubbles: true, composed: true, cancelable: true })); }
          catch (_iE) { el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); }
          el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          if (!inDlg) {
            el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('focusout', { bubbles: true, composed: true }));
          }
        }
        var actual = el.value !== undefined ? String(el.value) : (el.textContent || '');
        var match = actual === f.v || actual.indexOf(f.v.substring(0, 20)) >= 0;
        results.push((match ? 'Filled' : 'PARTIAL') + ': ' + el.tagName + ' with "' + f.v.substring(0, 30) + '"');
      });
      return results.join('\\n');
    })()`
  );
}

// ========== KEYBOARD ==========

// JS key names for KeyboardEvent
const jsKeyMap = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", space: " ",
  delete: "Backspace", backspace: "Backspace", up: "ArrowUp", down: "ArrowDown",
  left: "ArrowLeft", right: "ArrowRight", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
};

// macOS virtual key codes for CGEvent keyboard (used by _helperNativeKeyboard).
// These are the HID-level codes that postToPid uses, NOT JS keyCode values.
const macKeyCodeMap = {
  enter: 36, return: 36, "numpad-enter": 76,
  tab: 48, space: 49, delete: 51, backspace: 51, escape: 53,
  up: 126, "arrowup": 126, down: 125, "arrowdown": 125,
  left: 123, "arrowleft": 123, right: 124, "arrowright": 124,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35,
  l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, n: 45, m: 46, ".": 47, "`": 50,
};

// Native keyboard via CGEvent — sends a single key (with optional modifiers)
// to the Safari window WITHOUT activating Safari or moving the mouse.
// This produces isTrusted:true events that bypass React trust checks (Discord ProseMirror,
// Slack virtualized editors, etc.) without any focus stealing. Requires Safari window ID.
// Native type via clipboard paste (CGEvent Cmd+V targeted to Safari window).
// Inserts text into ANY editor (ProseMirror, Slate, Draft.js, regular inputs,
// contenteditable, cross-origin iframes) by going through the real paste pipeline.
// Unlike safari_fill's synthetic paste, this updates the framework's internal
// model state, so subsequent operations (like pressing Enter to submit in Discord)
// see the text as "really there".
export async function nativeType(args) {
  await ensureHelpers();
  if (!args || !args.value) throw new Error("nativeType requires 'value'");
  return await _withTargetTabFronted(() => _nativeTypeImpl(args));
}

async function _nativeTypeImpl({ value, selector, ref }) {
  // Focus the target element if selector/ref provided
  if (ref || selector) {
    const sel = ref ? refSelector(ref) : escJsSingleQuote(selector);
    await runJS(`(function(){ var el=document.querySelector('${sel}'); if(el){el.focus();el.click();} return el?'focused':'not found'; })()`);
    await new Promise(r => setTimeout(r, 50));
  }
  return await _nativeTypeViaClipboard(value);
}

export async function nativeKeyboard(args) {
  await ensureHelpers();
  if (!args || !args.key) throw new Error("nativeKeyboard requires 'key'");
  return await _withTargetTabFronted(() => _nativeKeyboardImpl(args));
}

async function _nativeKeyboardImpl({ key, modifiers = [] }) {
  const k = String(key).toLowerCase();
  const keyCode = macKeyCodeMap[k];
  if (keyCode === undefined) {
    throw new Error(`nativeKeyboard: unsupported key "${key}". Supported: ${Object.keys(macKeyCodeMap).join(", ")}`);
  }
  const geo = await _getSafariWindowGeometry();
  if (!geo.windowId) throw new Error("Cannot native-key without Safari window ID — would steal focus");
  const normalized = (modifiers || []).map(m => String(m).toLowerCase());
  await _helperNativeKeyboard(keyCode, normalized, geo.windowId);
  const modsLabel = normalized.length ? normalized.join("+") + "+" : "";
  return `Native key: ${modsLabel}${k} (CGEvent to window ${geo.windowId}, no focus steal)`;
}

// System Events key codes — only used for paste_image, upload_file, save_pdf
// (functions that truly require OS-level UI interaction)

export async function pressKey({ key, modifiers = [] }) {
  const hasCmdOrCtrl = modifiers.some((m) => ["cmd", "ctrl"].includes(m.toLowerCase()));
  const hasShift = modifiers.some((m) => m.toLowerCase() === "shift");
  const k = key.toLowerCase();

  // Try to handle EVERYTHING via JavaScript — no System Events, no focus stealing
  if (hasCmdOrCtrl) {
    // Map Cmd/Ctrl shortcuts to JS execCommand equivalents
    const jsShortcuts = {
      a: "document.execCommand('selectAll')",
      c: `(function(){
        var sel = window.getSelection();
        if (sel.toString()) { navigator.clipboard.writeText(sel.toString()).catch(function(){}); }
        return 'Copied';
      })()`,
      x: "document.execCommand('cut')",
      z: hasShift ? "document.execCommand('redo')" : "document.execCommand('undo')",
      b: "document.execCommand('bold')",
      i: "document.execCommand('italic')",
      u: "document.execCommand('underline')",
    };

    if (jsShortcuts[k]) {
      await runJS(jsShortcuts[k]);
      return `Pressed: ${modifiers.join("+")}+${key} (via JS)`;
    }

    // Cmd+V (paste) — read clipboard via AppleScript (no activate!), inject via JS
    if (k === "v") {
      // Cross-origin iframe: JS can't paste into it, use CGEvent Cmd+V (no focus steal)
      const activeTag = await runJS(`document.activeElement ? document.activeElement.tagName : ''`);
      if (activeTag === 'IFRAME') {
        // MUST have windowId — windowId=0 would steal focus and move mouse
        const geo = await _getSafariWindowGeometry();
        if (!geo.windowId) throw new Error("Cannot paste into iframe without Safari window ID — would steal focus");
        await _helperNativeKeyboard(9, ["cmd"], geo.windowId);
        await new Promise(r => setTimeout(r, 100)); // 100ms is enough for Cmd+V to process
        return `Pressed: ${modifiers.join("+")}+v (CGEvent Cmd+V into iframe, no focus steal)`;
      }

      const clipText = await osascript(`the clipboard as text`).catch(() => "");
      if (clipText) {
        const escaped = clipText.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
        await runJS(
          `(function(){
            var el = document.activeElement;
            if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
              var start = el.selectionStart, end = el.selectionEnd;
              var val = el.value;
              el.value = val.substring(0, start) + '${escaped}' + val.substring(end);
              el.selectionStart = el.selectionEnd = start + '${escaped}'.length;
              el.dispatchEvent(new Event('input', {bubbles:true}));
              el.dispatchEvent(new Event('change', {bubbles:true}));
              return 'Pasted (input)';
            }
            // ProseMirror: use native API to ensure state updates
            var pm = el && el.closest && el.closest('.ProseMirror');
            if (pm) {
              var v = null;
              if (pm.pmViewDesc && pm.pmViewDesc.view) v = pm.pmViewDesc.view;
              else { var keys = Object.keys(pm); for (var i=0;i<keys.length;i++) { var o=pm[keys[i]]; if(o&&o.state&&o.dispatch){v=o;break;} } }
              if (v && v.dispatch) {
                v.dispatch(v.state.tr.insertText('${escaped}'));
                v.focus();
                return 'Pasted (ProseMirror)';
              }
            }
            // Default: execCommand
            document.execCommand('insertText', false, '${escaped}');
            return 'Pasted';
          })()`
        );
      }
      return `Pressed: ${modifiers.join("+")}+v (via JS, no focus steal)`;
    }

    // Other Cmd shortcuts — dispatch JS KeyboardEvent
    await runJS(
      `(function(){
        var el = document.activeElement || document.body;
        var e = new KeyboardEvent('keydown', {key:'${k}',code:'Key${k.toUpperCase()}',metaKey:true,ctrlKey:false,bubbles:true,cancelable:true});
        el.dispatchEvent(e);
        el.dispatchEvent(new KeyboardEvent('keyup', {key:'${k}',metaKey:true,bubbles:true}));
        return 'Pressed';
      })()`
    );
    return `Pressed: ${modifiers.join("+")}+${key}`;
  }

  // Non-modifier keys: pure JavaScript (no System Events)
  const jsKey = jsKeyMap[k] || key;
  const safeKey = jsKey.replace(/'/g, "\\'");
  // W3C `code` values: special keys are NOT "Key"-prefixed ("Enter", "ArrowUp", ...);
  // only letters are ("KeyA"), digits are "Digit1". Apps that route on event.code
  // (Notion, Monaco, Google Docs) ignore a bogus "KeyEnter".
  const jsCodeMap = {
    "Enter": "Enter", "Tab": "Tab", "Escape": "Escape", " ": "Space",
    "Backspace": "Backspace", "Delete": "Delete",
    "ArrowUp": "ArrowUp", "ArrowDown": "ArrowDown", "ArrowLeft": "ArrowLeft", "ArrowRight": "ArrowRight",
    "Home": "Home", "End": "End", "PageUp": "PageUp", "PageDown": "PageDown",
    "F1": "F1", "F2": "F2", "F3": "F3", "F4": "F4", "F5": "F5", "F6": "F6",
  };
  const jsCode = jsCodeMap[jsKey]
    || (/^[a-z]$/i.test(jsKey) ? "Key" + jsKey.toUpperCase()
      : /^[0-9]$/.test(jsKey) ? "Digit" + jsKey
        : jsKey);
  const safeCode = jsCode.replace(/'/g, "\\'");
  const shiftKey = hasShift;
  const altKey = modifiers.some((m) => m.toLowerCase() === "alt");

  const result = await runJS(
    `(function(){
      var el = document.activeElement || document.body;
      var opts = {key:'${safeKey}',code:'${safeCode}',bubbles:true,cancelable:true,shiftKey:${shiftKey},altKey:${altKey}};
      var down = new KeyboardEvent('keydown', opts);
      var prevented = !el.dispatchEvent(down);
      if (!prevented) {
        if ('${safeKey}' === 'Enter') {
          if (el.tagName === 'INPUT') { el.form && el.form.dispatchEvent(new Event('submit',{bubbles:true})); }
          else if (el.tagName === 'TEXTAREA') { document.execCommand('insertLineBreak'); }
          else if (el.isContentEditable && ${shiftKey}) { document.execCommand('insertLineBreak'); }
          // ContentEditable + Enter (no Shift): do NOT insertLineBreak.
          // Modern editors (Discord Slate, Slack, Notion, Medium) handle Enter
          // in their own keydown listener to trigger submit/send/newBlock.
          // insertLineBreak would double-act: the app submits AND we add a newline.
        } else if ('${safeKey}' === 'Tab') {
          var focusable = [...document.querySelectorAll('input,textarea,select,button,a,[tabindex]')].filter(function(e){return e.tabIndex>=0;});
          var idx = focusable.indexOf(el);
          var next = ${shiftKey} ? focusable[idx-1] : focusable[idx+1];
          if (next) next.focus();
        } else if ('${safeKey}' === 'Backspace') {
          document.execCommand('delete');
        } else if ('${safeKey}' === 'Escape') {
          el.blur();
        }
      }
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      // ContentEditable + Enter: check if the app actually handled it.
      // If editor content didn't change (no submit, no newline), the JS
      // keydown was ignored (isTrusted:false). Signal for native fallback.
      if ('${safeKey}' === 'Enter' && el.isContentEditable && !${shiftKey} && !prevented) {
        return '__ENTER_NOT_HANDLED__';
      }
      return 'OK';
    })()`
  );

  // Fallback for ContentEditable Enter that wasn't handled by JS keydown:
  // apps like Discord/Slack require isTrusted:true. Briefly activate Safari
  // (~50ms), send real keystroke, then immediately restore the previous
  // frontmost app. The visual flash is imperceptible (<100ms total).
  if (result === '__ENTER_NOT_HANDLED__') {
    return `Pressed: enter (JS keydown dispatched but not handled — the app likely requires isTrusted:true. Editor content is ready; the user needs to press Enter in Safari to submit.)`;
  }

  return `Pressed: ${modifiers.length ? modifiers.join("+") + "+" : ""}${key}`;
}

// ========== NATIVE TYPE VIA CLIPBOARD PASTE ==========
// Uses OS-level clipboard + CGEvent Cmd+V to insert text. Produces a REAL paste event
// that ProseMirror/Slate/Draft.js process through their native paste handlers, updating
// internal model state (not just the DOM). Also works for cross-origin iframes.
// NO focus steal — sends CGEvent Cmd+V targeted to Safari window ID.
//
// Why this matters: synthetic DOM manipulation (safari_fill's "synthetic paste") writes
// to the DOM but doesn't update React/ProseMirror state. Discord's onSubmit reads from
// state, not DOM, so Enter submits empty. This function fixes that by going through the
// real paste pipeline.
async function _nativeTypeViaClipboard(text) {
  await _acquireClipboardLock();
  let savedClipboard;
  try {
    // Save current clipboard
    savedClipboard = await _saveClipboard();

    // Set clipboard to our text via pipe (safe from shell injection)
    await _pbcopy(text);

    // Paste via CGEvent Cmd+V targeted to Safari window — NO activate, NO focus steal
    // MUST have windowId — global CGEvent (windowId=0) would steal focus and move mouse
    const geo = await _getSafariWindowGeometry();
    if (!geo.windowId) {
      throw new Error("Cannot native-paste without Safari window ID — would steal focus");
    }
    // keyCode 9 = V key, flags: ["cmd"]
    await _helperNativeKeyboard(9, ["cmd"], geo.windowId);

    // Wait for paste to settle
    await new Promise(r => setTimeout(r, 100)); // 100ms is enough for Cmd+V to process
    return `Typed ${text.length} chars (native paste into iframe)`;
  } finally {
    // ALWAYS restore the user's clipboard + release the lock — even if the daemon died
    // mid-paste — so the user never silently inherits the tool's pasted text.
    if (savedClipboard !== undefined) await _restoreClipboard(savedClipboard).catch(() => {});
    if (_clipboardLocked) _releaseClipboardLock();
  }
}

export async function typeText({ text, selector, ref }) {
  if (ref) selector = refSelector(ref);
  if (selector) {
    const sel = escJsSingleQuote(selector);
    await runJS(`document.querySelector('${sel}')?.focus()`);
    // Quick poll for focus to settle (was 200ms fixed sleep)
    await new Promise((r) => setTimeout(r, 30));
  }

  // Cross-origin iframe detection: JS can't access content inside cross-origin iframes.
  // When activeElement is an IFRAME, use native clipboard paste via System Events.
  const activeTag = await runJS(`document.activeElement ? document.activeElement.tagName : ''`);
  if (activeTag === 'IFRAME') {
    return await _nativeTypeViaClipboard(text);
  }

  // Use execCommand("insertText") — the ONLY approach that works for BOTH:
  // 1. Regular inputs/textareas (execCommand works natively)
  // 2. ContentEditable (ProseMirror/Draft.js/Slate) — execCommand causes real DOM mutation
  //    → MutationObserver fires → framework detects change → state updates
  // InputEvent dispatch does NOT work because it doesn't cause real DOM mutations.
  const safeText = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
  const result = await runJS(
    `(function(){var el=document.activeElement;if(!el)return 'No focused element';` +
    // ProseMirror: use native API
    `var pm=el.closest&&el.closest('.ProseMirror');if(pm){try{var v=null;if(pm.pmViewDesc&&pm.pmViewDesc.view)v=pm.pmViewDesc.view;else{var keys=Object.keys(pm);for(var ki=0;ki<keys.length;ki++){var o=pm[keys[ki]];if(o&&o.state&&o.dispatch){v=o;break;}}}if(v&&v.dispatch){var tr=v.state.tr.insertText('${safeText}');v.dispatch(tr);v.focus();return 'Typed ${text.length} chars (ProseMirror)';}}catch(e){}}` +
    // Closure/Medium: char-by-char with keyboard events + Enter handling
    `var isClosure=el.isContentEditable&&(Object.keys(el).some(function(k){return k.startsWith('closure_uid_');})||location.hostname.includes('medium.com'));` +
    `if(isClosure){var txt='${safeText}';for(var i=0;i<txt.length;i++){var target=document.activeElement||el;var ch=txt[i];if(ch==='\\n'){target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));document.execCommand('insertParagraph');target.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',keyCode:13,bubbles:true}));continue;}var kc=ch.charCodeAt(0);target.dispatchEvent(new KeyboardEvent('keydown',{key:ch,keyCode:kc,bubbles:true}));document.execCommand('insertText',false,ch);target.dispatchEvent(new InputEvent('input',{data:ch,inputType:'insertText',bubbles:true}));target.dispatchEvent(new KeyboardEvent('keyup',{key:ch,keyCode:kc,bubbles:true}));}return 'Typed ${text.length} chars (Closure char-by-char)';}` +
    // Typeahead/combobox (LinkedIn Ember, ARIA autocomplete): needs real per-char key
    // events so the widget runs its async server search. execCommand's single InputEvent
    // opens the menu (aria-expanded=true) but never fires the fetch → empty option list.
    `var isCombo=('value' in el)&&(el.getAttribute('role')==='combobox'||el.getAttribute('aria-autocomplete')||el.hasAttribute('aria-controls'));` +
    `if(isCombo){var tc='${safeText}';for(var j=0;j<tc.length;j++){var cc=tc[j];var kk=cc.charCodeAt(0);el.dispatchEvent(new KeyboardEvent('keydown',{key:cc,keyCode:kk,bubbles:true}));document.execCommand('insertText',false,cc);el.dispatchEvent(new InputEvent('input',{data:cc,inputType:'insertText',bubbles:true}));el.dispatchEvent(new KeyboardEvent('keyup',{key:cc,keyCode:kk,bubbles:true}));}return 'Typed '+${text.length}+' chars (combobox char-by-char)';}` +
    // Default: execCommand
    `var ok=document.execCommand('insertText',false,'${safeText}');if(ok)return 'Typed '+${text.length}+' chars';` +
    // Fallback for inputs where execCommand failed
    `if('value' in el){var start=el.selectionStart||0;el.value=el.value.substring(0,start)+'${safeText}'+el.value.substring(el.selectionEnd||start);el.selectionStart=el.selectionEnd=start+${text.length};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'Typed '+${text.length}+' chars via value set';}return 'Could not type';})()`
  );

  // If JS typing failed and we're somehow in an iframe context, try native fallback
  if (result === 'Could not type') {
    return await _nativeTypeViaClipboard(text);
  }

  return result;
}

// ========== EDITOR SUPPORT (Monaco, CodeMirror) ==========

// Replace all content in a code editor (Monaco, CodeMirror, or ace)
// Used when typeText/fill can't handle the editor
export async function replaceEditorContent({ text }) {
  // Escape for embedding in JS string
  const safeText = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');

  // PREFLIGHT: Two-channel Monaco sync — update the model (visual) AND call
  // the React wrapper's onChange (state). Airtable wraps Monaco in a React
  // component whose "Finish editing" save reads from React state, not from
  // the Monaco model. So setValue alone is "visually correct, stale on save".
  // We walk the React fiber up from .monaco-editor until we find a component
  // whose memoizedProps contain an `onChange` function + a `value` field,
  // then call onChange(text) to sync React. Works for Airtable-style embeds
  // and is a no-op on plain Monaco (VS Code web, GitHub) where setValue
  // already covers the state.
  const preflightFirstLine = text.split('\n')[0].slice(0, 20).replace(/'/g, "\\'");
  const monacoPreflight = await runJS(
    `(function(){
      var m = (typeof monaco !== 'undefined') ? monaco : window.monaco;
      if (!m || !m.editor) return JSON.stringify({kind:'not-monaco'});
      var hasTextarea = !!document.querySelector('.monaco-editor textarea.inputarea');
      var models = []; try { models = m.editor.getModels() || []; } catch(e){}
      if (!models.length) return JSON.stringify({kind:'no-model', hasTextarea: hasTextarea});

      // Locate the React wrapper component that owns this Monaco embed.
      // Prefer an editable wrapper (isReadOnly !== true); fall back to any
      // wrapper if only a read-only preview exists (Airtable before Edit).
      function findFiber(el) {
        if (!el) return null;
        var ks = Object.keys(el);
        for (var j = 0; j < ks.length; j++) {
          if (ks[j].indexOf('__reactFiber') === 0) return el[ks[j]];
        }
        return null;
      }
      function findWrapperWithOnChange(fiber) {
        var c = fiber;
        for (var i = 0; i < 40 && c; i++) {
          var p = c.memoizedProps;
          if (p && typeof p.onChange === 'function' && ('value' in p)) return c;
          c = c.return;
        }
        return null;
      }
      var els = document.querySelectorAll('.monaco-editor');
      var editableWrapper = null, anyWrapper = null;
      for (var i = els.length - 1; i >= 0; i--) {
        var f = findFiber(els[i].parentElement);
        if (!f) continue;
        var w = findWrapperWithOnChange(f);
        if (!w) continue;
        if (!anyWrapper) anyWrapper = w;
        if (w.memoizedProps.isReadOnly !== true) { editableWrapper = w; break; }
      }
      var wrapper = editableWrapper || anyWrapper;

      // Step 1: Monaco model setValue — updates visual + fires onDidChangeModelContent
      try { models[models.length - 1].setValue('${safeText}'); }
      catch(e) { return JSON.stringify({kind:'setValue-err', hasTextarea: hasTextarea, err: String(e && e.message)}); }

      // Step 2: Sync React state via wrapper.onChange (if wrapper found).
      // onChange may be silently guarded (e.g. Airtable's readOnly check).
      // We only treat sync as real when the wrapper's value prop actually
      // changes OR a sibling/parent expression state reflects the update
      // on the next render tick.
      var reactSynced = false;
      var reactGuarded = false;
      if (wrapper) {
        var prevValue = wrapper.memoizedProps.value;
        try {
          wrapper.memoizedProps.onChange('${safeText}');
          // Re-fetch the fiber's memoizedProps (may have been swapped by React)
          var after = wrapper.alternate ? wrapper.alternate.memoizedProps : wrapper.memoizedProps;
          var nowValue = (after && 'value' in after) ? after.value : wrapper.memoizedProps.value;
          reactSynced = (nowValue !== prevValue);
          // If value didn't change, onChange was a no-op (guarded by isReadOnly
          // or permission check). Signal this so caller falls back to native paste.
          reactGuarded = !reactSynced;
        } catch(e) { reactSynced = false; reactGuarded = true; }
      }

      // Step 3: Verify DOM reflects the new content
      var firstDom = document.querySelector('.monaco-editor .view-line');
      var domTxt = firstDom ? firstDom.textContent : '';
      var expected = '${preflightFirstLine}';
      var domOk = expected.length < 5 || domTxt.indexOf(expected) !== -1;

      return JSON.stringify({
        kind: 'monaco',
        domOk: domOk,
        reactSynced: reactSynced,
        reactGuarded: reactGuarded,
        hasWrapper: !!wrapper,
        editable: !!editableWrapper,
        hasTextarea: hasTextarea,
        models: models.length
      });
    })()`
  );

  let mpParsed = null;
  try { mpParsed = JSON.parse(monacoPreflight); } catch(e) {}

  // Fully synced: Monaco model + React state both updated.
  if (mpParsed && mpParsed.kind === 'monaco' && mpParsed.domOk && mpParsed.reactSynced) {
    return 'Monaco(model+react): replaced ' + text.split('\n').length + ' lines';
  }

  // Plain Monaco embed (no React wrapper) — setValue is sufficient.
  if (mpParsed && mpParsed.kind === 'monaco' && mpParsed.domOk && !mpParsed.hasWrapper) {
    return 'Monaco(model): replaced ' + text.split('\n').length + ' lines';
  }

  // Airtable-style embed where React fiber sync failed (wrapper.onChange was
  // a no-op, or the site guards writes by permission/readOnly). Fall back to
  // native clipboard paste via CGEvent: forces readOnly=false first, activates
  // Safari, focuses the textarea, and sends Cmd+A/Cmd+V targeted to the window.
  if (mpParsed && mpParsed.kind === 'monaco' && mpParsed.hasTextarea) {
    const savedFrontApp = await saveFrontmostApp();
    try {
      // Step 1: Install editor capture hook (if not already) + try to find visible editable editor
      await runJS(
        `(function(){
          if (!window.__mcpEditorHook) {
            window.__mcpEditorHook = true;
            window.__mcpCapturedEditors = [];
            try { monaco.editor.onDidCreateEditor(function(e){window.__mcpCapturedEditors.push(e);}); } catch(e){}
          }
          // Force readOnly=false on all existing editors (harmless if already false)
          try {
            (window.__mcpCapturedEditors || []).forEach(function(e){
              try { if (e.updateOptions) e.updateOptions({readOnly: false}); } catch(_){}
            });
          } catch(e){}
          return 'hook-installed';
        })()`
      );
      // Step 2: Activate Safari to frontmost — required for CGEvent keyboard to reach web content
      await _helperActivateApp("com.apple.Safari");
      await new Promise(r => setTimeout(r, 300));
      // Step 3: Focus Monaco's input textarea
      await runJS(`(function(){var t=document.querySelector('.monaco-editor textarea.inputarea');if(t){t.focus();return 'focused';}return 'no-textarea';})()`);
      await new Promise(r => setTimeout(r, 100));
      // Step 4: Cmd+A + Cmd+V via GLOBAL CGEvent (cghidEventTap) — reaches web content
      // reliably since Safari is frontmost
      await _helperNativeKeyboard(0, ["cmd"], 0); // Cmd+A global
      await new Promise(r => setTimeout(r, 100));
      // Write clipboard + paste via global CGEvent (not windowed)
      await _acquireClipboardLock();
      try {
        const savedClip = await _saveClipboard();
        await _pbcopy(text);
        await _helperNativeKeyboard(9, ["cmd"], 0); // Cmd+V global
        await new Promise(r => setTimeout(r, 200));
        await _restoreClipboard(savedClip);
      } finally {
        _releaseClipboardLock();
      }
      await new Promise(r => setTimeout(r, 300));
      // Restore original front app
      if (savedFrontApp) await restoreFocusIfStolen(savedFrontApp);
      return 'Monaco(native-paste): replaced ' + text.split('\n').length + ' lines';
    } catch(e) {
      if (savedFrontApp) await restoreFocusIfStolen(savedFrontApp).catch(() => {});
      // Fall through to remaining editor-type checks
    }
  }

  const result = await runJS(
    `(function(){
      // Monaco editor (Airtable, VS Code web, GitHub)
      // Try both global 'monaco' and window.monaco — some sites expose one but not the other
      var m = (typeof monaco !== 'undefined') ? monaco : window.monaco;
      if (m && m.editor) {
        // Try getModels first (works on Airtable and most Monaco embeds)
        try {
          var models = m.editor.getModels();
          if (models && models.length > 0) {
            models[models.length - 1].setValue('${safeText}');
            return 'Monaco(model): replaced ' + '${safeText}'.split('\\n').length + ' lines';
          }
        } catch(e) {}
        // Try getEditors (standard Monaco API)
        try {
          var eds = m.editor.getEditors();
          if (eds && eds.length > 0) {
            eds[eds.length - 1].setValue('${safeText}');
            return 'Monaco(editor): replaced ' + '${safeText}'.split('\\n').length + ' lines';
          }
        } catch(e) {}
      }

      // CodeMirror 6 (uses EditorView stored on DOM element)
      var cmEls = document.querySelectorAll('.cm-editor');
      for (var i = cmEls.length - 1; i >= 0; i--) {
        var view = cmEls[i].cmView;
        if (view && view.view) {
          var v = view.view;
          v.dispatch({changes: {from: 0, to: v.state.doc.length, insert: '${safeText}'}});
          return 'CodeMirror6: replaced ' + '${safeText}'.split('\\n').length + ' lines';
        }
      }

      // CodeMirror 5
      var CM5 = (typeof CodeMirror !== 'undefined') ? CodeMirror : window.CodeMirror;
      if (CM5) {
        var cm5 = document.querySelector('.CodeMirror');
        if (cm5 && cm5.CodeMirror) {
          cm5.CodeMirror.setValue('${safeText}');
          return 'CodeMirror5: replaced ' + '${safeText}'.split('\\n').length + ' lines';
        }
      }

      // Ace editor
      var aceRef = (typeof ace !== 'undefined') ? ace : window.ace;
      if (aceRef) {
        var aceEls = document.querySelectorAll('.ace_editor');
        if (aceEls.length > 0) {
          var aceEd = aceRef.edit(aceEls[aceEls.length - 1]);
          aceEd.setValue('${safeText}', -1);
          return 'Ace: replaced ' + '${safeText}'.split('\\n').length + ' lines';
        }
      }

      // ProseMirror (LinkedIn, Medium, Notion, HackerNoon)
      var pmEl = document.querySelector('.ProseMirror');
      if (pmEl) {
        // Strategy 1: Native API via view.dispatch (most reliable)
        try {
          var view = pmEl.pmViewDesc && pmEl.pmViewDesc.view;
          if (view && view.state && view.dispatch) {
            var state = view.state;
            var tr = state.tr.replaceWith(0, state.doc.content.size,
              state.schema.text ? state.schema.text('${safeText}') : state.schema.node('paragraph', null, state.schema.text('${safeText}')));
            view.dispatch(tr);
            view.focus();
            return 'ProseMirror(API): replaced';
          }
        } catch(e) {}
        // Strategy 2: execCommand fallback
        try {
          pmEl.focus();
          document.execCommand('selectAll');
          document.execCommand('insertText', false, '${safeText}');
          return 'ProseMirror(execCommand): replaced';
        } catch(e) {}
      }

      // Fallback: contentEditable — try clipboard paste first, then delete+insert
      var el = document.activeElement;
      if (!el || !el.isContentEditable) {
        el = document.querySelector('[contenteditable="true"]');
        if (el) el.focus();
      }
      if (el && el.isContentEditable) {
        // Try clipboard paste (safe for Closure/Medium/unknown editors)
        try {
          document.execCommand('selectAll');
          var dt = new DataTransfer();
          dt.setData('text/plain', '${safeText}');
          var pe = new ClipboardEvent('paste', {bubbles:true,cancelable:true,clipboardData:dt});
          var handled = !el.dispatchEvent(pe);
          if (handled) return 'ContentEditable(paste): replaced';
        } catch(e) {}
        // Fallback: delete then insert (don't combine selectAll+insertText)
        document.execCommand('selectAll');
        document.execCommand('delete');
        document.execCommand('insertText', false, '${safeText}');
        return 'ContentEditable: replaced';
      }

      return 'No code editor found';
    })()`
    , { timeout: 15000 }
  );
  return result;
}

// ========== SCREENSHOT ==========

export async function screenshot({ fullPage = false } = {}) {
  await refreshTargetWindow();
  return _withTargetTabFronted(() => _screenshotFronted({ fullPage }));
}

async function _screenshotFronted({ fullPage }) {
  const tmpFile = join(tmpdir(), `safari-screenshot-${Date.now()}.png`);
  try {
    const windowIdRaw = await osascript(
      `tell application "Safari" to return id of ${getTargetWindowRef()}`
    ).catch(() => null);
    // Window IDs are OS-assigned integers — reject anything non-numeric before it reaches
    // `do shell script "/usr/sbin/screencapture -l<id>"` (defense-in-depth against odd AppleScript stdout).
    const windowId = windowIdRaw != null && /^\d+$/.test(String(windowIdRaw).trim()) ? String(windowIdRaw).trim() : null;

    // On macOS Tahoe, screencapture -l may briefly steal focus.
    // Save frontmost app via daemon so we can hide Safari if it stole focus.
    let previousBundleId = null;
    if (windowId) {
      const fa = await _helperGetFrontApp();
      previousBundleId = fa?.bundleId || null;
    }

    if (windowId) {
      try {
        if (fullPage) {
          const bounds = await osascript(
            `tell application "Safari" to return bounds of ${getTargetWindowRef()}`
          );
          const dims = await runJS("JSON.stringify({h:document.documentElement.scrollHeight,w:document.documentElement.scrollWidth})");
          const { h, w } = JSON.parse(dims);
          await osascript(
            `tell application "Safari" to set bounds of ${getTargetWindowRef()} to {0, 0, ${Number(w)}, ${Math.min(Number(h) + 100, 5000)}}`
          );
          try {
            await new Promise((r) => setTimeout(r, 500));
            // Route capture through the TCC-granted helper (NSAppleScript → do shell script):
            // under the launchd daemon, node has no Screen Recording grant — the helper does.
            await osascriptFast(
              `do shell script "/usr/sbin/screencapture -l${windowId} -o -x '${tmpFile}'"`,
              { timeout: 15000 }
            );
          } finally {
            // Always restore bounds — even if screencapture fails
            await osascript(
              `tell application "Safari" to set bounds of ${getTargetWindowRef()} to {${bounds}}`
            ).catch(() => {});
          }
        } else {
          // Try direct execFile first (works if VS Code has Screen Recording permission)
          try {
            await execFileAsync("/usr/sbin/screencapture", ["-l" + windowId, "-o", "-x", tmpFile]);
            const testData = await readFile(tmpFile);
            if (testData.length < 100) throw new Error("empty");
          } catch (_) {
            // Fallback: do shell script via the TCC-granted helper (node lacks Screen Recording under launchd)
            await osascriptFast(
              `do shell script "/usr/sbin/screencapture -l${windowId} -o -x '${tmpFile}'"`,
              { timeout: 15000 }
            );
          }
        }
        // Re-activate previous app if screencapture stole focus (common on macOS Tahoe).
        // Centralized restore handles settle delay + hide fallback if activate is blocked.
        if (previousBundleId && previousBundleId !== "com.apple.Safari") {
          await restoreFocusIfStolen(previousBundleId).catch(() => {});
        }
        // Compress: convert PNG to JPEG (50% quality) + resize to max 1200px width
        // Cuts ~600KB PNG → ~60KB JPEG — critical for staying under 20MB context limit
        const jpgFile = tmpFile.replace(/\.png$/, '.jpg');
        try {
          await execFileAsync("sips", [
            "-s", "format", "jpeg",
            "-s", "formatOptions", "50",
            "--resampleWidth", "1200",
            tmpFile, "--out", jpgFile
          ], { timeout: 5000 });
          const jpgData = await readFile(jpgFile);
          await unlink(tmpFile).catch(() => {});
          await unlink(jpgFile).catch(() => {});
          if (jpgData.length > 100) return jpgData.toString("base64");
        } catch (_) {
          // sips failed — fall back to original PNG
          await unlink(jpgFile).catch(() => {});
        }
        const data = await readFile(tmpFile);
        await unlink(tmpFile).catch(() => {});
        if (data.length > 100) return data.toString("base64");
      } catch (_) {
        // screencapture failed, fall through to JS method
      }
    }

    // Fallback: full-screen capture + crop to the window rect.
    //
    // macOS 26 (Tahoe) broke `screencapture -l<windowId>` for Safari: it exits 1
    // with "could not create image from window" for EVERY window, while a plain
    // full-screen `screencapture -x` from the same process succeeds. So this is
    // not a TCC problem — safari_doctor reports Screen Recording as granted and
    // is telling the truth. Diagnosed 17.08.2026, when the by-id path started
    // failing mid-session and the misleading "permission may have been lost"
    // error below sent the investigation after a permission that was never gone.
    //
    // Crop math: AppleScript bounds are in points, the capture is in pixels.
    // devicePixelRatio from the page gives the backing-scale factor.
    if (windowId) {
      try {
        // A locked screen captures as solid black. Say so instead of returning a
        // black rectangle the caller has to guess at.
        if (await isScreenLocked()) {
          throw new Error("SCREEN_LOCKED");
        }
        const boundsRaw = await osascript(
          `tell application "Safari" to return bounds of ${getTargetWindowRef()}`
        );
        const [x1, y1, x2, y2] = String(boundsRaw).split(",").map((v) => parseInt(v.trim(), 10));
        const dpr = Math.max(1, Math.round(Number(await runJS("window.devicePixelRatio")) || 1));
        const w = (x2 - x1) * dpr, h = (y2 - y1) * dpr;
        if ([x1, y1, x2, y2].every(Number.isFinite) && w > 0 && h > 0) {
          const fullFile = tmpFile.replace(/\.png$/, "-full.png");
          const cropFile = tmpFile.replace(/\.png$/, "-crop.jpg");
          try {
            // Direct first (VS Code / terminal grant), helper second (launchd daemon has no grant of its own)
            await execFileAsync("/usr/sbin/screencapture", ["-x", fullFile], { timeout: 15000 })
              .catch(() => osascriptFast(`do shell script "/usr/sbin/screencapture -x '${fullFile}'"`, { timeout: 15000 }));
            await execFileAsync("sips", [
              "-c", String(h), String(w), "--cropOffset", String(y1 * dpr), String(x1 * dpr),
              fullFile, "--out", cropFile,
            ], { timeout: 10000 });
            await execFileAsync("sips", [
              "-s", "format", "jpeg", "-s", "formatOptions", "50", "--resampleWidth", "1200",
              cropFile, "--out", cropFile,
            ], { timeout: 10000 });
            const cropped = await readFile(cropFile);
            if (cropped.length > 100) return cropped.toString("base64");
          } finally {
            await unlink(fullFile).catch(() => {});
            await unlink(cropFile).catch(() => {});
          }
        }
      } catch (e) {
        if (e && e.message === "SCREEN_LOCKED") {
          throw new Error("screenshot unavailable — the screen is locked, so the capture would be solid black. Unlock the Mac and retry. (Text-based tools — safari_snapshot / safari_read_page / safari_evaluate — work regardless.)");
        }
        // crop path failed too — fall through to the JS canvas method
      }
    }

    // Fallback: JS-based screenshot via canvas (no permissions needed)
    const dataUrl = await runJS(
      `(async function(){` +
      `var c=document.createElement('canvas');var ctx=c.getContext('2d');` +
      `c.width=window.innerWidth;c.height=${fullPage ? 'document.documentElement.scrollHeight' : 'window.innerHeight'};` +
      `var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+c.width+'" height="'+c.height+'">' +` +
      `'<foreignObject width="100%" height="100%">' +` +
      `'<div xmlns="http://www.w3.org/1999/xhtml">' + document.documentElement.outerHTML + '</div>' +` +
      `'</foreignObject></svg>';` +
      `var blob=new Blob([svg],{type:'image/svg+xml'});` +
      `var url=URL.createObjectURL(blob);` +
      `var img=new Image();` +
      `return new Promise(function(resolve){` +
      `img.onload=function(){ctx.drawImage(img,0,0);resolve(c.toDataURL('image/png').split(',')[1]);};` +
      `img.onerror=function(){resolve('FALLBACK_TEXT')};` +
      `img.src=url;});})()`,
      { timeout: 30000 }
    );

    // canvas/SVG returns a Promise `do JavaScript` can't await → guard against the
    // unsettled "[object Promise]"/empty value and only return a real base64 PNG.
    const looksBase64 = typeof dataUrl === 'string' && dataUrl.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(dataUrl.slice(0, 120));
    if (looksBase64) {
      return dataUrl;
    }

    // Final fallback: throw with clear message for the retry logic in index.js
    throw new Error("screencapture failed — Screen Recording permission may have been lost. Grant permission in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Safari.");
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

// ========== ELEMENT SCREENSHOT ==========

export async function screenshotElement({ selector }) {
  await refreshTargetWindow();
  return _withTargetTabFronted(() => _screenshotElementFronted({ selector }));
}

async function _screenshotElementFronted({ selector }) {
  const sel = escJsSingleQuote(selector);
  // Use html2canvas-like approach: capture element via SVG foreignObject
  const result = await runJS(
    `(async function(){
      var el = document.querySelector('${sel}');
      if (!el) return 'Element not found: ${sel}';
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return 'Element has no dimensions';

      // Scroll element into view
      el.scrollIntoView({block:'center'});
      await new Promise(r => setTimeout(r, 100));
      rect = el.getBoundingClientRect();

      // Use canvas + drawImage from window screenshot approach
      var c = document.createElement('canvas');
      c.width = Math.ceil(rect.width * window.devicePixelRatio);
      c.height = Math.ceil(rect.height * window.devicePixelRatio);
      var ctx = c.getContext('2d');
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

      // Clone element to avoid cross-origin issues
      var clone = el.cloneNode(true);
      var styles = window.getComputedStyle(el);
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:absolute;left:-99999px;top:0;width:'+rect.width+'px;height:'+rect.height+'px;overflow:hidden;background:'+styles.backgroundColor;
      wrapper.appendChild(clone);
      document.body.appendChild(wrapper);

      // Serialize to SVG foreignObject
      var html = new XMLSerializer().serializeToString(wrapper);
      document.body.removeChild(wrapper);
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+rect.width+'" height="'+rect.height+'">' +
        '<foreignObject width="100%" height="100%">' + html + '</foreignObject></svg>';
      var blob = new Blob([svg], {type:'image/svg+xml;charset=utf-8'});
      var url = URL.createObjectURL(blob);
      var img = new Image();
      return new Promise(function(resolve){
        img.onload = function(){
          ctx.drawImage(img, 0, 0, rect.width, rect.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = function(){ resolve('SVG_RENDER_FAILED'); };
        img.src = url;
      });
    })()`,
    { timeout: 15000 }
  );

  // The canvas/SVG path returns a Promise that `do JavaScript` can't await (so it yields
  // "[object Promise]"/empty), and foreignObject can't render cross-origin images/fonts.
  // Treat anything that isn't a valid base64 PNG as a render failure and fall through to
  // the reliable screencapture+crop path.
  const looksBase64 = typeof result === 'string' && result.length > 100 && /^[A-Za-z0-9+/]+={0,2}$/.test(result.slice(0, 120));
  if (!looksBase64) {
    // Fallback: use screencapture + crop
    const tmpFile = join(tmpdir(), `safari-el-${Date.now()}.png`);
    let cropFile = null;
    try {
      const windowIdRaw = await osascript(`tell application "Safari" to return id of ${getTargetWindowRef()}`).catch(() => null);
      const windowId = windowIdRaw != null && /^\d+$/.test(String(windowIdRaw).trim()) ? String(windowIdRaw).trim() : null;
      if (!windowId) throw new Error("Cannot get Safari window ID");

      // Get element bounds relative to screen
      const bounds = await runJS(
        `(function(){var el=document.querySelector('${sel}');if(!el)return '';var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),dpr:(window.devicePixelRatio||1)});})()`
      );
      if (!bounds) throw new Error(typeof result === 'string' && result.startsWith('Element') ? result : 'Element not found for screenshot');

      // Full window screenshot then crop with sips. Direct execFile works when this process
      // has Screen Recording (stdio mode); under the launchd daemon it doesn't — fall back
      // to the TCC-granted helper.
      try {
        await execFileAsync("/usr/sbin/screencapture", ["-l" + windowId, "-o", "-x", tmpFile]);
      } catch {
        await osascriptFast(
          `do shell script "/usr/sbin/screencapture -l${windowId} -o -x '${tmpFile}'"`,
          { timeout: 15000 }
        );
      }
      const { x, y, w, h, dpr = 1 } = JSON.parse(bounds);
      // Use sips to crop (macOS built-in). Use the DYNAMIC toolbar height — Sequoia+ chrome is
      // ~90px, not 74, so a hardcoded 74 left element screenshots vertically offset. Fall back
      // to 74 only if geometry can't be read.
      let toolbarHeight = 74;
      try { const g = await _getSafariWindowGeometry(); if (g?.toolbarHeight) toolbarHeight = g.toolbarHeight; } catch {}
      // screencapture writes the window PNG at PHYSICAL resolution (2× on Retina), but the
      // bounds + toolbar height are CSS points. Scale every crop dimension by devicePixelRatio
      // so the crop lands on the right physical pixels instead of a half-size top-left region.
      const sw = Math.round(w * dpr);
      const sh = Math.round(h * dpr);
      const sx = Math.round(x * dpr);
      const sy = Math.round((y + toolbarHeight) * dpr);
      cropFile = join(tmpdir(), `safari-el-crop-${Date.now()}.png`);
      await execFileAsync("sips", [
        "-c", String(sh), String(sw),
        "--cropOffset", String(sy), String(sx),
        tmpFile, "--out", cropFile
      ]);
      const data = await readFile(cropFile);
      await unlink(tmpFile).catch(() => {});
      await unlink(cropFile).catch(() => {});
      if (data.length > 100) return data.toString("base64");
    } catch (e) {
      await unlink(tmpFile).catch(() => {});
      if (cropFile) await unlink(cropFile).catch(() => {});  // captured path — old code rebuilt it with the wrong timestamp and leaked it
      throw new Error(`Element screenshot failed: ${e.message}`);
    }
  }

  return result;
}

// ========== SCROLL ==========

export async function scroll({ direction = "down", amount = 500 }) {
  const y = direction === "up" ? -Number(amount) : Number(amount);
  // Single call: scroll + return position
  return runJS(
    `(function(){window.scrollBy(0,${y});return 'Scrolled ${direction} ${amount}px. Position: '+JSON.stringify({x:window.scrollX,y:window.scrollY,height:document.documentElement.scrollHeight});})()`
  );
}

export async function scrollTo({ x = 0, y = 0 }) {
  return runJS(`(function(){window.scrollTo(${Number(x)},${Number(y)});return 'Scrolled to (${x},${y})';})()`);
}

// ========== TAB MANAGEMENT ==========

export async function listTabs() {
  await refreshTargetWindow();
  // Re-resolve when EITHER the URL or the tab marker is tracked — the URL may be
  // cleared after a redirect while the marker is still valid; resetting the index
  // then caused spurious "tab tracking lost" errors. Only a session with no
  // tracking at all should reset.
  if (_st().activeTabURL || _st().activeTabMarker) {
    await resolveActiveTab();
  } else {
    _st().activeTabIndex = null;
  }

  const result = await osascript(
    `tell application "Safari"
      set output to ""
      set tabIndex to 1
      repeat with t in every tab of ${getTargetWindowRef()}
        if tabIndex > 1 then set output to output & linefeed
        set output to output & (tabIndex as text) & (ASCII character 9) & name of t & (ASCII character 9) & URL of t
        set tabIndex to tabIndex + 1
      end repeat
      return output
    end tell`
  );
  if (!result.trim()) return JSON.stringify([]);
  const tabs = result.split("\n").map((line) => {
    const parts = line.split("\t");
    return { index: parseInt(parts[0]), title: parts[1] || "", url: parts[2] || "" };
  });
  return JSON.stringify(tabs, null, 2);
}

// One window's tabs, for a caller that compares listings over time: `win` pins the window
// (`window id N`), and with none the target window is listed. The answer names the window it
// listed, so the next listing and a claim address that window. Listings of 'front window' read
// whichever window was in front at each call, and a tab of one window looked new in the other.
// Returns { win, tabs: [{ index, title, url }] }.
export async function listWindowTabs(win) {
  if (win && !/^window id \d+$/.test(win)) throw new Error("listWindowTabs: win must be a `window id N` reference");
  await refreshTargetWindow();
  const result = await osascript(`tell application "Safari"
  set w to ${win || getTargetWindowRef()}
  set output to (id of w) as text
  set tabIndex to 1
  repeat with t in every tab of w
    set output to output & linefeed & (tabIndex as text) & (ASCII character 9) & name of t & (ASCII character 9) & URL of t
    set tabIndex to tabIndex + 1
  end repeat
  return output
end tell`);
  const [id, ...lines] = String(result).split("\n");
  return {
    win: _windowById(id),
    tabs: lines.filter((line) => line.trim()).map((line) => {
      const parts = line.split("\t");
      return { index: parseInt(parts[0]), title: parts[1] || "", url: parts[2] || "" };
    }),
  };
}

// `onMarker(marker)` hears the marker that names the new tab as soon as the tab exists, before
// anything below can fail: comparing the session's marker before and after the call is misled by
// a parallel call of the same session.
export async function newTab(url = "", { onMarker } = {}) {
  await refreshTargetWindow();
  const safeUrl = escAppleScriptString(url); // url defaults to "" → escAppleScriptString("") === ""
  // A blank tab opens on about:blank, not on Safari's new-tab page (the Start Page runs no page
  // script, so no marker could ever prove the tab); `url` stays "", so nothing waits for a load.
  const props = ` with properties {URL:"${url ? safeUrl : "about:blank"}"}`;
  // Bulletproof tab marker. window.name survives ALL navigation (full loads, redirects,
  // cross-origin); __mcpTabMarker survives SPA routing. Minted before the tab exists so the script
  // that makes it can stamp it, but it becomes the session's marker (onMarker, the state below) only
  // once the tab exists, so a scan run meanwhile never looks for one no tab carries yet.
  const marker = `MCP_${_st().markerId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  // The script that makes the tab reports where it put it: its window's id, its index there, read
  // off the tab it made, and the window's fingerprint as that tab sees it (see _inTab), the proof of
  // the tab until a marker is on it. Until then nothing else names the tab, so every script below
  // addresses that window by id. A later `count of tabs` named the tab the user had just opened, and
  // 'front window' names whichever window is in front when each script runs: one the user brought
  // forward while the page loaded took the probes, the marker and the URL read, and with the marker
  // every later write, into their tab. The report is "" when the tab was made but its place could not
  // be read, which must not send the catch below to make another; that tab gets no marker either.
  // Then the script stamps the marker on the tab, so a tab the user or another session opens next to
  // it before the next script runs is told from it by the marker, not by position. `t` is a position
  // too, so the stamp takes only a page as fresh as the one just made: about:blank, carrying no
  // window.name and no marker. The stamp is bounded, and the script's timeout covers it: a new tab
  // slow to answer must not make the catch below open a second tab.
  const report = `  try
    set rep to ((id of w) as text) & ":" & ((index of t) as text) & linefeed & (my mcpFp(w, index of t))
  on error
    return ""
  end try
  try
    with timeout of 2 seconds
      do JavaScript "${_doJSLiteral(`(location.href==='about:blank'&&!window.name&&!window.__mcpTabMarker)?${_buildStampJS(marker)}:''`)}" in t
    end timeout
  end try
  return rep`;
  const since = Date.now();
  let made;
  try {
    made = await osascript(`${_FINGERPRINT_HANDLER}
tell application "Safari"
  set w to ${getTargetWindowRef()}
  tell w
    set userTab to current tab
    set t to make new tab${props}
    set current tab to userTab
  end tell
${report}
end tell`, { timeout: 13000 });
  } catch {
    if (SAFARI_PROFILE) {
      // Profile mode: create tab inside the profile window, never use make new document (opens in front/personal window)
      made = await osascript(`${_FINGERPRINT_HANDLER}
tell application "Safari"
  set w to ${getTargetWindowRef()}
  tell w to set t to make new tab${props}
${report}
end tell`, { timeout: 13000 });
    } else {
      // No window to open a tab in: a new window, whose tab is the new document.
      made = await osascript(`${_FINGERPRINT_HANDLER}
tell application "Safari"
  make new document${props}
  set w to front window
  set t to current tab of w
${report}
end tell`, { timeout: 13000 });
    }
  }
  const at = /^(\d+):(\d+)\n([^\n]+)$/.exec(String(made).trim());
  const win = at && _windowById(at[1]);
  const idx = at ? Number(at[2]) : 0;
  // Permanently true: this session has opened its own tab, so write ops must NEVER fall back to
  // the user's current tab — even when the tab below cannot be told from theirs.
  _st().hasOwnedTab = true;
  if (!win || !(idx > 0)) {
    throw new Error(
      "Tab tracking lost — Safari opened a new tab but did not report which one, so this session " +
      "cannot tell it from your tabs and marked none. Call safari_new_tab again."
    );
  }
  onMarker?.(marker);
  // Every script below proves the tab again before it touches it (_inTab): by the marker, wherever
  // the tab is now, or, right after its page replaced the one the marker was on, by the window
  // looking as it did. A probe that finds a page without the marker stamps it back.
  const tab = { idx, win, marker, fp: at[3], since, op: "newTab" };
  let info = null;
  let failure = null;
  try {
    // Wait for page load if URL given. Poll readyState from the Node side — Safari's
    // `do JavaScript` does NOT await async IIFEs, so an in-page wait loop returns
    // immediately without waiting.
    if (url) {
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 200));
        try {
          const probe = await _inTab(tab, "document.readyState+' '+location.href", { stamp: true });
          const cut = probe.indexOf(" ");
          const st = probe.slice(0, cut);
          const href = probe.slice(cut + 1);
          if ((st === 'complete' || st === 'interactive') && href && href !== 'about:blank') break;
        } catch (err) {
          if (err.tabUnproven) throw err;
          /* tab still loading */
        }
      }
    } else {
      await new Promise(r => setTimeout(r, 200));
    }
    // Stamp identity marker + visibility spoof onto the loaded document, and read the page, in one
    // script. Identity-critical, like _stampTab(): a daemon hiccup retries through the reliable
    // subprocess, and stamping the same marker twice is harmless.
    const stampAndRead = (opts) =>
      _inTab(tab, "JSON.stringify({title:document.title,url:location.href})", { stamp: "always", ...opts });
    const page = JSON.parse(await stampAndRead({ timeout: 5000 }).catch((err) => {
      if (err.tabUnproven) throw err;
      return stampAndRead({ timeout: 15000, subprocess: true });
    }));
    info = JSON.stringify({ title: page.title, url: page.url, tabIndex: tab.idx });
  } catch (err) {
    failure = err;
  }
  // The session's current tab from here on, whether or not the stamp got through: only the
  // marker, found on the tab, proves it is this one. A tab no script could prove keeps no new
  // marker, and nothing is stamped on the tab that took its place.
  Object.assign(_st(), {
    activeTabIndex: tab.idx, activeTabURL: url || null, activeTabMarker: marker,
    tabFromExtension: false, lastResolveTime: Date.now(),
  });
  if (failure?.tabUnproven) throw failure;
  if (info === null) {
    throw new Error(
      "Tab tracking lost — the new tab could not be marked as this session's, so nothing proves which " +
      `tab it is. Call safari_new_tab again. Safari said: ${failure?.message || failure}`,
      { cause: failure }
    );
  }
  try {
    const parsed = JSON.parse(info);
    if (parsed.url && parsed.url !== 'about:blank') _st().activeTabURL = parsed.url;
  } catch {}
  return info;
}

// A tab index this session can prove it owns, or null. Destructive paths only: they may
// never guess, so "can't prove it" has to read as null rather than as the front document.
// The proof is the identity marker, found wherever the tab is now (surviving the index
// shifts of #54): the rule the tab cap and shutdown cleanup follow too (#112). Not
// resolveActiveTab(), which can answer without one — a URL prefix, a domain, the bare index.
async function _provenOwnTabIndex() {
  return findTabByMarker(_st().activeTabMarker);
}

// Close the tab carrying `marker`, found and closed in ONE script. An index one script proved and
// a later script closed named whatever tab sat there by then: a close in between (another
// eviction, the extension, the user, a popup) renumbers the window, and another front window
// renames it, so the close took the user's tab. The window's last tab is blanked instead of closed,
// as closeTab() does. Returns "closed", "blanked", or null when no tab in the target window carries
// the marker. A tab adopted from the user (MCP_A…) is never closed (#92).
// ponytail: the check and `close tab i` are still two Apple events, so a close another process
// lands between them (two instances cleaning up at once) can still shift the index; closing by a
// per-call title nonce (`close (every tab of w whose name is …)`) would make it one.
export async function closeTabByMarker(marker) {
  if (!marker || String(marker).startsWith("MCP_A")) return null;
  await refreshTargetWindow();
  const closed = await osascript(`tell application "Safari"
  set w to ${getTargetWindowRef()}
  set n to count of tabs of w
  repeat with i from n to 1 by -1
    set hit to false
    try
      set hit to ((do JavaScript "${_markerCheckJS(marker)}" in tab i of w) is "1")
    end try
    if hit then
      if n is 1 then
        set URL of tab i of w to "about:blank"
        return "blanked"
      end if
      close tab i of w
      return "closed"
    end if
  end repeat
  return ""
end tell`);
  return closed === "closed" || closed === "blanked" ? closed : null;
}

// `explicitIndex` — a tab the caller already proved is ours. An index a caller merely named
// proves nothing (closeOwnTab), and one proved by an earlier script can name another tab by now:
// with no index, the session's own tab is proven and closed by its marker in one script.
export async function closeTab(explicitIndex) {
  // The index is written into AppleScript source below, so nothing but a tab number may get
  // there: a string index from run_script carried statements of its own, `do shell script` too.
  if (explicitIndex !== undefined && !(Number.isInteger(explicitIndex) && explicitIndex > 0)) {
    throw new Error("closeTab: explicitIndex must be a positive integer");
  }
  // A tab adopted from the user (#92) is writable, never disposable (#68), whatever it shows by now.
  if (!explicitIndex && isActiveTabAdopted()) {
    throw new Error(
      `Tab safety: refusing to close this tab — it was adopted from you via SAFARI_MCP_ALLOW_USER_TABS, ` +
      `not opened by this MCP session. Close it yourself, or open your own tab with safari_new_tab.`
    );
  }
  await refreshTargetWindow();

  // ── Guard: close nothing this session cannot prove it owns. There is deliberately no
  // front-document fallback here, unlike the read paths: `close current tab of window` is
  // the tab the USER is looking at whenever our index is unknown — and "unknown" is exactly
  // what a session re-initialised after a transport drop reports, mid-task, while a tab of
  // its own is still open. That fail-open destroyed a user's tab (#68, the destructive
  // sibling of #64). An unmarked front document stays readable for a genuinely fresh
  // session, because a bad read costs information; a bad close costs their work.
  if (!explicitIndex) {
    const closed = await closeTabByMarker(_st().activeTabMarker);
    if (!closed) {
      throw new Error(
        `Tab tracking lost — refusing to close a tab this session cannot prove it opened ` +
        `(closing "current tab of window" would close the user's active tab). ` +
        `Call safari_new_tab to open a tab this session owns, or safari_list_tabs and ` +
        `safari_switch_tab to re-anchor to a tab this session opened.`
      );
    }
    _st().activeTabIndex = null;
    _st().activeTabURL = null;
    _st().lastTabCount = null;
    _st().lastResolveTime = 0;
    if (closed === "blanked") {
      return "Window's last tab blanked instead of closed (closing it would shut the window / quit Safari)";
    }
    // The tab is gone, so its marker is too — keeping it would let a later resolve
    // match a stale identity, or have the extension mark another tab in its place.
    _st().activeTabMarker = null;
    _st().tabFromExtension = false;
    return "Tab closed";
  }
  const idx = explicitIndex;

  // ── Guard: never close a window's LAST tab. Closing it shuts the window —
  // which quits Safari if it's the only window, AND (for profile-targeted
  // instances) makes the target window vanish so every later op throws
  // "profile window not found". It also wedges a 0-tab "ghost" window that
  // resists `close`. Per-window (not global): with SAFARI_PROFILE set, several
  // skills race closes on the same profile window while other-profile windows
  // exist, so a global count would wrongly allow shutting the profile window.
  // If the target window is down to one tab, blank it instead of closing.
  try {
    const _winTabs = parseInt(
      await osascript(`tell application "Safari" to return (count of tabs of ${getTargetWindowRef()})`),
      10
    );
    if (Number.isFinite(_winTabs) && _winTabs <= 1) {
      // Blanking is destructive too — it throws away whatever page is loaded — so it
      // targets the proven index, never the front document.
      await osascript(
        `tell application "Safari" to set URL of tab ${idx} of ${getTargetWindowRef()} to "about:blank"`
      );
      _st().activeTabIndex = null;
      _st().activeTabURL = null;
      _st().lastTabCount = null;
      _st().lastResolveTime = 0;
      return "Window's last tab blanked instead of closed (closing it would shut the window / quit Safari)";
    }
  } catch { /* count check failed — fall through to normal close */ }

  await osascript(
    `tell application "Safari" to close tab ${idx} of ${getTargetWindowRef()}`
  );
  if (idx === _st().activeTabIndex) {
    _st().activeTabIndex = null;
    _st().activeTabURL = null;
    // The tab is gone, so its marker is too — keeping it would let a later resolve
    // match a stale identity, or have the extension mark another tab in its place.
    _st().activeTabMarker = null;
    _st().tabFromExtension = false;
  }
  _st().lastTabCount = null;    // Invalidate — tab count changed
  _st().lastResolveTime = 0;    // Force re-resolve on next operation
  return "Tab closed";
}

// A close that names its tab by index: run_script's closeTab. That index is the caller's,
// not a tab this module proved. Handed to closeTab() as `explicitIndex`, it closed whatever
// tab sat there, the user's included, while the ownership guard had checked the current tab.
// Only the tab carrying this session's marker closes here, and only when it is the one named.
export async function closeOwnTab(index) {
  if (index != null && Number(index) !== (await _provenOwnTabIndex())) {
    throw new Error(
      `Tab safety: refusing to close tab ${index} — AppleScript proves a tab only by the marker ` +
      `this session stamped on it, and tab ${index} does not carry it.`
    );
  }
  return closeTab();
}

// A switch takes a tab that carries a marker of this session. `adopt` also takes one that does not:
// an adoption (#92), stamped with the session's adoption marker. `claim` takes it as the session's
// own: the tab safari_wait_for_new_tab saw open. Only those callers pass them. A tab that carries the
// session's adoption marker keeps that family whatever the caller passes, so no switch turns a tab
// adopted from the user into one the session can close. `win` (`window id N`) names the window the
// caller saw the tab in; without it, the index is one of the target window. `expectUrl` is the URL the
// caller's listing saw at that index: a tab that closed to its left since slid another tab, the user's
// included, under the index, so the switch refuses (`moved`) before it stamps anything when the tab
// shows another page, and the caller lists again.
export async function switchTab(index, { adopt = false, claim = false, win, expectUrl } = {}) {
  const idx = Number(index);
  // A switch by receipt alone used to arrive here with no index at all, and claimed tab NaN
  // under a marker stamped on no tab.
  if (!Number.isInteger(idx) || idx < 1) throw new Error("switchTab needs the tab's index (a positive integer)");
  if (win && !/^window id \d+$/.test(win)) throw new Error("switchTab: win must be a `window id N` reference");
  // A tab that carries a whole marker of the session's own family (MCP_<markerId>_) keeps it. The
  // server records a tab AppleScript opened by the marker stamped on it then, and the tab cap, the
  // memory sweep, shutdown cleanup and a close forgetting its tab all find the tab by that marker: a
  // fresh one stamped here left the record naming no tab, so the tab escaped all four and its URL
  // stayed claimed. A tab carrying the session's adoption marker gets a fresh adoption marker at every
  // switch, and any other tab a FRESH own marker, never one the session stamped before: the tab
  // carrying that one would be taken for this one. So a switch never puts one marker on two tabs.
  const ownPrefix = `MCP_${_st().markerId}_`;
  const marker = `${ownPrefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const adoptedMarker = `MCP_A${marker.slice(4)}`;
  // The marker makes the tab the session's own from then on: writes go there, and closeTab() closes
  // the tab carrying it. It used to go on whatever tab sat at the index, the user's included, since
  // run_script checked nothing first and safari_switch_tab checks only the tab's URL, which their tab
  // on a page the session also opened passes. So the tab has to carry a marker of this session
  // already, and one script in the page checks that, reads the title and URL, and only then stamps:
  // no tab closed or dragged in between can put another tab under the stamp, and a switch that fails
  // leaves both the tab and the session state as they were.
  // Do NOT visually switch the tab — it brings the Safari window to foreground
  // and interrupts the user. Visual switching only happens in screenshot() when needed.
  // AppleScript `do JavaScript in tab N` works on background tabs without switching.
  // `a`: the tab carries the session's adoption marker, `o`: one of its own markers, `w`: that marker
  // when it is a whole one (_markerWithPrefixJS), `k`: the marker the tab keeps or gets. A claim takes
  // no tab another MCP session marked (`x`): its marker would give way to this session's own, which
  // the tab cap, the sweep, cleanup and closes act on, and the other session would lose the tab, or a
  // tab it adopted from the user would become closable.
  // JSON.stringify makes the URL a JS string literal whatever it holds; its quotes and backslashes are
  // escaped once more for AppleScript below.
  const moved = expectUrl == null ? "" : `if(location.href!==${JSON.stringify(String(expectUrl))})return 'moved';`;
  const js = `(function(){${moved}var a=${_markerPrefixTestJS(_adoptedMarkerPrefix())},o=${_markerPrefixTestJS(ownPrefix)},w=${_markerWithPrefixJS(ownPrefix)},` +
    `x=${_otherSessionMarkerTestJS(ownPrefix, _adoptedMarkerPrefix())};if(${claim}&&x)return 'other';` +
    `if(!a&&!o&&!${adopt || claim})return '';var f=a||${adopt}&&!o,k=f?'${adoptedMarker}':w||'${marker}';` +
    `var r=JSON.stringify({title:document.title,url:location.href,adopted:f,marker:k});` +
    `${_buildStampJS({ expr: "k" })};return r;})()`;
  const script = `tell application "Safari" to do JavaScript "${js.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" in tab ${idx} of ${win || getTargetWindowRef()}`;
  // Fast daemon first; a hiccup retries once through the reliable subprocess (a second run stamps the same marker).
  const result = String(await osascriptFast(script, { timeout: 5000 }).catch(() => osascript(script, { timeout: 8000 }))).trim();
  // `moved` and `otherSession` let safari_wait_for_new_tab pass over the tab and keep waiting for its own.
  if (result === "moved") {
    throw Object.assign(new Error(
      `Tab safety: refusing to ${claim ? "claim" : "switch to"} tab ${idx} — it no longer shows the page the listing saw ` +
      `(a tab closed or moved in between), so it may be another tab.`
    ), { moved: true });
  }
  if (result === "other") {
    throw Object.assign(new Error(
      `Tab safety: refusing to claim tab ${idx} — another MCP session's marker is on it (a tab it opened, or one it ` +
      `adopted from you), and a claim never takes a tab from another session.`
    ), { otherSession: true });
  }
  if (!result) {
    throw Object.assign(new Error(
      `Tab safety: refusing to switch to tab ${idx} — it carries no marker of this session, and AppleScript has ` +
      `no other proof that this session opened it (a URL is none: the same page can be open in one of your tabs). ` +
      `Open a tab with safari_new_tab, switch to a tab the Safari extension opened once safari_doctor shows the ` +
      `extension connected, or set SAFARI_MCP_ALLOW_USER_TABS=1 so that safari_switch_tab adopts a tab you already had open.`
    ), { unproven: true });
  }
  let page;
  try {
    page = JSON.parse(result);
  } catch {
    throw new Error(`switchTab: no page script runs in tab ${idx}, so no marker can find it there`);
  }
  // The page answered with the marker it kept, and a page can answer anything. Every later scan
  // writes that marker into AppleScript source, so it has to be one the session could have minted.
  const kept = page.adopted ? adoptedMarker : String(page.marker);
  if (!page.adopted && !(kept.startsWith(ownPrefix) && /^\w+$/.test(kept))) {
    throw new Error(`Tab safety: refusing to switch to tab ${idx} — its page answered with a marker this session never minted`);
  }
  // The session finds this tab again by that marker (resolveActiveTab scans for it); the URL is for
  // index.js's ownership checks.
  Object.assign(_st(), {
    activeTabIndex: idx, activeTabMarker: kept, activeTabURL: page.url || null,
    hasOwnedTab: true, tabFromExtension: false, lastResolveTime: Date.now(),
  });
  return JSON.stringify({ title: page.title, url: page.url });
}

// ========== WAIT ==========

export async function waitFor({ selector, text, timeout = 10000 }) {
  // `do JavaScript` can't await, so an in-page async wait loop returns immediately
  // (handing back an unsettled promise) instead of waiting. The wait loop runs on
  // the Node side: each tick re-evaluates one SYNCHRONOUS check against the page.
  const safeSelector = selector ? escJsSingleQuote(selector) : "";
  const safeText = text ? escJsSingleQuote(text) : "";
  if (!safeSelector && !safeText) {
    throw new Error("waitFor requires selector or text");
  }
  const checkJs = `(function(){` +
    (safeSelector ? `if(document.querySelector('${safeSelector}'))return 'Found: ${safeSelector}';` : "") +
    (safeText ? `if(document.body&&document.body.innerText.includes('${safeText}'))return 'Found text: ${safeText}';` : "") +
    `return '';})()`;
  const deadline = Date.now() + Number(timeout);
  while (Date.now() < deadline) {
    const hit = await runJS(checkJs, { timeout: 5000 }).catch(() => "");
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timeout waiting for ${selector || text} (${timeout}ms)`);
}

// ========== EVALUATE ==========

// Index of the last `;` that ends a top-level statement — skips `;` inside strings,
// template literals and parens/brackets/braces (e.g. a `for (;;)` header). Returns
// -1 when there is no top-level statement separator.
function _lastTopLevelSemicolon(s) {
  let depth = 0, inStr = false, quote = '', last = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; }
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) last = i;
  }
  return last;
}

// Build the expression to evaluate from a user script. Pure (no Safari calls) so
// it can be unit-tested directly — see scripts/test-evaluate-wrapping.js.
export function _buildEvalExpr(js) {
  // Async iff the *result* is a promise to wait on. `fetch(` alone is NOT async —
  // an un-awaited fetch is fire-and-forget; only await / .then() / a leading
  // `async` make the result thenable.
  const isAsync = /\bawait\b/.test(js) || /\.then\s*\(/.test(js) || /^async\b/.test(js);
  // Statement keywords: a script starting with one is never a bare expression,
  // and `return (<keyword> ...)` would be a syntax error.
  const NON_EXPR = /^(var|let|const|return|if|for|while|switch|try|do|throw)\b/;
  const isIIFE = /^\((?:async\s+)?function/.test(js) || /^\((?:async\s+)?\(/.test(js);
  const isSimpleExpression = !js.includes(';') && !js.includes('\n') && !NON_EXPR.test(js);

  let expr;
  if (isIIFE) {
    expr = js;
  } else if (isSimpleExpression) {
    // A bare expression — usable as-is for sync; async needs an awaiting wrapper.
    expr = isAsync ? `(async function(){return (${js})})()` : js;
  } else {
    // Multi-statement: prepend `return` to the last value-producing line when it
    // can safely take one; otherwise fall back to indirect-eval completion value.
    const lines = js.split('\n');
    let addedReturn = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line.startsWith('//')) continue;
      if (line.startsWith('return ') || line.startsWith('return;') || line === 'return') {
        addedReturn = true; break;
      }
      // A block-closer (`}`, `})`, `})()`), a block body (ends with `}`) or a
      // statement keyword can't take a prepended `return`.
      if (line.startsWith('}') || line.endsWith('}') || NON_EXPR.test(line)) break;
      lines[i] = 'return ' + lines[i];
      addedReturn = true;
      break;
    }
    if (addedReturn) {
      expr = `(${isAsync ? 'async function' : 'function'}(){${lines.join('\n')}})()`;
    } else if (isAsync) {
      // No newline gave a return slot — typically a single-line `const x = await …; expr`.
      // Split at the last top-level `;`: if a bare expression follows it, that becomes the
      // awaited result. Otherwise run the body as-is (value may be undefined).
      const semi = _lastTopLevelSemicolon(js);
      const tail = semi >= 0 ? js.slice(semi + 1).trim() : '';
      if (tail && !tail.startsWith('}') && !NON_EXPR.test(tail)) {
        expr = `(async function(){${js.slice(0, semi + 1)} return (${tail}); })()`;
      } else {
        expr = `(async function(){${js}})()`;
      }
    } else {
      // Indirect eval yields the completion value of an arbitrary statement list. The
      // plain body is the fallback for a strict CSP that refuses eval — probed with "0",
      // so a script that threw by itself (it ran) is not run a second time.
      const escaped = js.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      expr = "(function(){ var __mcpEvalOk = true; try { (0,eval)('0') } catch(_e) { __mcpEvalOk = false } " +
        "if (__mcpEvalOk) return (0,eval)('" + escaped + "'); " + js.replace(/\n/g, ' ') + " })()";
    }
  }
  return { isAsync, expr };
}

// Async scripts can't be awaited through AppleScript `do JavaScript` — it returns
// the moment the synchronous portion finishes, handing back an unsettled Promise.
// So the work is started fire-and-forget into a page global, then that global is
// polled synchronously from the Node side (the same pattern navigate() uses).
//
// Token is identifier-safe (base36 → [0-9a-z], `_` prefix) so `window.<token>`
// dot access needs no quoting/escaping through the AppleScript bridge.
function _newEvalSlot() {
  return 'window.__mcpEval_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Page-side statement that awaits `valueJs` and records the outcome in `slot`.
function _settleIntoSlot(slot, valueJs) {
  return `(async function(){try{var __v=await (${valueJs});` +
    `${slot}.val=(__v===undefined||__v===null)?null:(typeof __v==='object'?JSON.stringify(__v):String(__v));` +
    `}catch(__e){${slot}.err=(__e&&__e.message)||String(__e);}` +
    `finally{${slot}.done=true;}})();`;
}

async function _evaluateAsync(expr) {
  const slot = _newEvalSlot();
  // A SYNC outer function installs the globals, starts the async work (NOT awaited
  // here — `do JavaScript` would not await it anyway) and returns immediately.
  const kickoff = `(function(){${slot}={done:false};${_settleIntoSlot(slot, expr)}return 'ok';})()`;
  const started = await runJS(kickoff, { timeout: 10000 });
  if (started !== 'ok') {
    return typeof started === 'string' && started ? started : '(no return value)';
  }
  return _awaitEvalSlot(slot);
}

// Poll the result global until the async work settles (35s budget).
async function _awaitEvalSlot(slot) {
  const pollJs =
    `(function(){var s=${slot};if(!s)return '__MCP_GONE__';` +
    `if(!s.done)return '';return JSON.stringify({v:s.val,e:s.err});})()`;
  const deadline = Date.now() + 35000;
  let raw = '';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 120));
    raw = await runJS(pollJs, { timeout: 5000 }).catch(() => '');
    if (raw === '__MCP_GONE__') {
      return '(no return value — page navigated away during async evaluation)';
    }
    if (raw) break;
  }
  // Best-effort cleanup of the page global.
  runJS(`(function(){try{delete ${slot};}catch(__e){${slot}=undefined;}return '';})()`).catch(() => {});
  if (!raw) {
    throw new Error('safari_evaluate: async script did not settle within 35s');
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.e) return 'Error: ' + parsed.e;
    return parsed.v !== undefined && parsed.v !== null ? String(parsed.v) : '(no return value)';
  } catch {
    return raw;
  }
}

// Sync: a single `do JavaScript` over one expression — `do JavaScript` only returns the
// value of a single expression, so the whole script is one IIFE. The regex async-sniff in
// _buildEvalExpr only catches a literal await/.then/async and misses scripts whose *value*
// is a thenable (`Promise.resolve(5)`, an async IIFE with no inner await). Such a value is
// awaited in place into a slot: the script already ran, and evaluating it again — as this
// used to on "[object Promise]" — repeated every side effect in it.
export function _buildSyncEvalJs(expr, slot) {
  return `(function(){ try { var __r = (${expr}); ` +
    `if (__r && typeof __r.then === 'function') { ${slot}={done:false}; ${_settleIntoSlot(slot, '__r')} return '__MCP_EVAL_PENDING__'; } ` +
    `return __r; } catch(__mcpErr) { return 'Error: ' + __mcpErr.message; } })()`;
}

export async function evaluate({ script }) {
  const js = (script || '').trim();
  if (!js) return '(no return value)';
  const { isAsync, expr } = _buildEvalExpr(js);
  if (isAsync) return _evaluateAsync(expr);
  const slot = _newEvalSlot();
  const wrappedJs = _buildSyncEvalJs(expr, slot);
  if (process.env.MCP_DEBUG) console.error('[evaluate] wrapped:', wrappedJs.substring(0, 300));
  const result = await runJS(wrappedJs);
  if (typeof result === 'string' && result.trim() === '__MCP_EVAL_PENDING__') return _awaitEvalSlot(slot);
  if (result === null || result === undefined || result === '') {
    return '(no return value)';
  }
  return result;
}

// ========== ELEMENT INFO ==========

export async function getElementInfo({ selector }) {
  const sel = escJsSingleQuote(selector);
  return runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found';var r=el.getBoundingClientRect();return JSON.stringify({tag:el.tagName,text:el.textContent.trim().substring(0,200),href:el.href||'',value:el.value||'',visible:r.width>0&&r.height>0,rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},attrs:Object.fromEntries([...el.attributes].map(function(a){return[a.name,a.value.substring(0,100)]}))})})()`
  );
}

export async function querySelectorAll({ selector, limit = 20 }) {
  const sel = escJsSingleQuote(selector);
  return runJS(
    `JSON.stringify([...document.querySelectorAll('${sel}')].slice(0,${Number(limit)}).map(function(el,i){return{index:i,tag:el.tagName,text:el.textContent.trim().substring(0,100),href:el.href||undefined,value:el.value||undefined}}))`
  );
}

// ========== HOVER ==========

export async function hover({ selector, x, y, ref }) {
  if (ref) selector = refSelector(ref);
  if (selector) {
    const sel = escJsSingleQuote(selector);
    return runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found';el.scrollIntoView({block:'center'});el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));return 'Hovered: '+el.tagName;})()`
    );
  }
  if (x !== undefined && y !== undefined) {
    return runJS(
      `(function(){var el=document.elementFromPoint(${Number(x)},${Number(y)});if(!el)return 'No element';el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));return 'Hovered: '+el.tagName+' at (${Number(x)},${Number(y)})';})()`
    );
  }
  throw new Error("hover requires selector or x/y coordinates");
}

// ========== DIALOG HANDLING ==========

export async function handleDialog({ action = "accept", text }) {
  if (text !== undefined) {
    const safeText = escJsSingleQuote(text);
    await runJS(
      `window.__mcp_dialog_response='${safeText}';window.__origPrompt=window.prompt;window.prompt=function(){var r=window.__mcp_dialog_response;window.prompt=window.__origPrompt;return r;}`
    );
  }
  if (action === "accept") {
    await runJS(
      "window.__origConfirm=window.__origConfirm||window.confirm;window.confirm=function(){window.confirm=window.__origConfirm;return true;};window.__origAlert=window.__origAlert||window.alert;window.alert=function(){window.alert=window.__origAlert;};"
    );
  } else {
    await runJS(
      "window.__origConfirm=window.__origConfirm||window.confirm;window.confirm=function(){window.confirm=window.__origConfirm;return false;};"
    );
  }
  return `Dialog handler set: ${action}${text ? ' with "' + text + '"' : ""}`;
}

// ========== WINDOW ==========

export async function resizeWindow({ width, height }) {
  await refreshTargetWindow();
  await osascript(
    `tell application "Safari" to set bounds of ${getTargetWindowRef()} to {0, 0, ${Number(width)}, ${Number(height)}}`
  );
  return `Resized to ${width}x${height}`;
}

// ========== COOKIES & STORAGE ==========

// The storage tools below are plain page JavaScript (document.cookie, localStorage,
// sessionStorage). Until 2.21.13 they went straight to AppleScript, so a stuck Apple
// Events channel failed them with `Safari profile "X" window not found` while
// safari_evaluate, list_tabs and run_script kept answering through the extension
// (geo-audit, 2026-09-20). index.js points this hook at the same extension-first
// ladder safari_evaluate uses; the fallback it hands back is the original runJS.
// Without a runner (tests, direct imports) pageJS is runJS.
let _pageJSRunner = null;
export function setPageJSRunner(fn) { _pageJSRunner = typeof fn === "function" ? fn : null; }
function pageJS(js, fallback = () => runJS(js)) {
  return _pageJSRunner ? _pageJSRunner(js, fallback) : fallback();
}

export async function getCookies() {
  return pageJS("document.cookie");
}

export async function getLocalStorage({ key }) {
  if (key) {
    const safeKey = escJsSingleQuote(key);
    return pageJS(`localStorage.getItem('${safeKey}')`);
  }
  return pageJS(
    "JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(function(k){var v=localStorage.getItem(k);return[k,v==null?null:v.substring(0,200)]})))"
  );
}

// ========== NETWORK (via Performance API) ==========

export async function getNetworkRequests({ limit = 50 } = {}) {
  return runJS(
    `JSON.stringify(performance.getEntriesByType('resource').slice(-${Number(limit)}).map(function(r){return{name:r.name,type:r.initiatorType,duration:Math.round(r.duration),size:r.transferSize||0}}))`
  );
}

// ========== DRAG ==========

export async function drag({ sourceSelector, targetSelector, sourceX, sourceY, targetX, targetY }) {
  if (sourceSelector && targetSelector) {
    const srcSel = escJsSingleQuote(sourceSelector);
    const tgtSel = escJsSingleQuote(targetSelector);
    return runJS(
      `(function(){` +
      `var src=document.querySelector('${srcSel}');var tgt=document.querySelector('${tgtSel}');` +
      `if(!src)return 'Source not found: ${srcSel}';if(!tgt)return 'Target not found: ${tgtSel}';` +
      `var sr=src.getBoundingClientRect();var tr=tgt.getBoundingClientRect();` +
      `var sx=sr.x+sr.width/2,sy=sr.y+sr.height/2,tx=tr.x+tr.width/2,ty=tr.y+tr.height/2;` +
      `var dt=new DataTransfer();` +
      `src.dispatchEvent(new DragEvent('dragstart',{clientX:sx,clientY:sy,bubbles:true,cancelable:true,dataTransfer:dt}));` +
      `src.dispatchEvent(new MouseEvent('mousedown',{clientX:sx,clientY:sy,bubbles:true}));` +
      `src.dispatchEvent(new MouseEvent('mousemove',{clientX:sx,clientY:sy,bubbles:true}));` +
      `tgt.dispatchEvent(new DragEvent('dragover',{clientX:tx,clientY:ty,bubbles:true,cancelable:true,dataTransfer:dt}));` +
      `tgt.dispatchEvent(new MouseEvent('mousemove',{clientX:tx,clientY:ty,bubbles:true}));` +
      `tgt.dispatchEvent(new MouseEvent('mouseup',{clientX:tx,clientY:ty,bubbles:true}));` +
      `tgt.dispatchEvent(new DragEvent('drop',{clientX:tx,clientY:ty,bubbles:true,cancelable:true,dataTransfer:dt}));` +
      `src.dispatchEvent(new DragEvent('dragend',{bubbles:true}));` +
      `return 'Dragged from '+src.tagName+' to '+tgt.tagName;})()`
    );
  }
  if (sourceX !== undefined && sourceY !== undefined && targetX !== undefined && targetY !== undefined) {
    return runJS(
      `(function(){` +
      `var src=document.elementFromPoint(${Number(sourceX)},${Number(sourceY)});` +
      `if(!src)return 'No element at source';` +
      `src.dispatchEvent(new MouseEvent('mousedown',{clientX:${Number(sourceX)},clientY:${Number(sourceY)},bubbles:true}));` +
      `src.dispatchEvent(new MouseEvent('mousemove',{clientX:${Number(sourceX)},clientY:${Number(sourceY)},bubbles:true}));` +
      `document.elementFromPoint(${Number(targetX)},${Number(targetY)})?.dispatchEvent(new MouseEvent('mousemove',{clientX:${Number(targetX)},clientY:${Number(targetY)},bubbles:true}));` +
      `document.elementFromPoint(${Number(targetX)},${Number(targetY)})?.dispatchEvent(new MouseEvent('mouseup',{clientX:${Number(targetX)},clientY:${Number(targetY)},bubbles:true}));` +
      `return 'Dragged from (${Number(sourceX)},${Number(sourceY)}) to (${Number(targetX)},${Number(targetY)})';})()`
    );
  }
  throw new Error("drag requires sourceSelector+targetSelector or sourceX/Y+targetX/Y");
}

// ========== FILE PATH SAFETY ==========
// Prevent reading sensitive system files via upload/paste tools
function _validateFilePath(filePath) {
  const resolved = resolvePath(filePath);
  // resolve() already collapses "..", so checking the RESOLVED path for it is a dead no-op.
  // Reject traversal sequences in the RAW input instead; the allowlist below is the real guard.
  if (/(^|[/\\])\.\.([/\\]|$)/.test(filePath)) throw new Error("Path traversal not allowed: " + filePath);
  const blocked = ['.ssh', '.gnupg', '.aws', '.config/gcloud', 'credentials', '.env', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', '.keychain'];
  // Resolve symlinks when the target exists, so a symlink under /Users/ pointing at /etc
  // can't slip past the allowlist. Falls back to the lexical path when the file doesn't
  // exist yet (e.g. savePDF's output path).
  let real = resolved;
  try { real = realpathSync(resolved); } catch { /* not created yet — keep lexical path */ }
  for (const checkPath of new Set([resolved, real])) {
    const lower = checkPath.toLowerCase();
    for (const b of blocked) {
      if (lower.includes(b)) throw new Error("Blocked: sensitive path " + filePath);
    }
    // realpathSync resolves /var/folders/... to /private/var/folders/... on macOS —
    // without the /private form an EXISTING file under /var/folders was rejected.
    if (!checkPath.startsWith('/Users/') && !checkPath.startsWith('/tmp/') && !checkPath.startsWith('/var/folders/') && !checkPath.startsWith('/private/tmp/') && !checkPath.startsWith('/private/var/folders/')) {
      throw new Error("File path must be under /Users/, /tmp/, or /var/folders/: " + filePath);
    }
  }
}

// ========== UPLOAD FILE ==========

// How many previews of ingested files the page shows: object-URL / data-URL images and videos,
// background images, and SVG <image> elements. Google Business Profile draws its preview as
// <svg role=img><image href="blob:…">, which went uncounted, so a real upload read as a ghost
// pickup and was escalated to a native dialog that added a second copy. -1: the page was unreadable.
const _PREVIEW_COUNT_JS = `function(){try{
  var n=document.querySelectorAll('img[src^="blob:"], img[src^="data:image"], video[src^="blob:"]').length;
  var all=document.querySelectorAll('div,span,a,figure');
  for(var i=0;i<all.length;i++){var b=all[i].style&&all[i].style.backgroundImage||'';if(b.indexOf('blob:')>-1||b.indexOf('data:image')>-1)n++;}
  var svg=document.querySelectorAll('image');
  for(var j=0;j<svg.length;j++){var h=svg[j].getAttribute('href')||svg[j].getAttributeNS('http://www.w3.org/1999/xlink','href')||'';if(h.indexOf('blob:')===0||h.indexOf('data:image')===0)n++;}
  return n;}catch(_){return -1;}}`;

// `locate`: how index.js asks the extension where this session's tab is (see _locusWindows).
export async function uploadFile({ selector, filePath, forceNative = false, verifyPreview = false, locate = null }) {
  _validateFilePath(filePath);
  const elsewhere = _locusWindows(locate);
  // Read file in Node.js, send as base64 to Safari JS, create File + DataTransfer
  // NO file dialog, NO System Events, NO focus stealing

  // Safety: close any open file dialog first (in case Claude clicked the input before calling this)
  await osascript(
    `tell application "System Events"
      tell process "Safari"
        repeat with w in every window
          if exists sheet 1 of w then
            try
              click button "Cancel" of sheet 1 of w
            on error
              try
                click button "\u05D1\u05D9\u05D8\u05D5\u05DC" of sheet 1 of w  -- "Cancel" in Hebrew locale
              on error
                key code 53
              end try
            end try
            exit repeat
          end if
        end repeat
      end tell
    end tell`
  ).catch(() => {}); // Ignore if no dialog open

  const sel = escJsSingleQuote(selector);
  const { basename, extname } = await import("node:path");
  let fileName = basename(filePath);
  let ext = extname(filePath).toLowerCase().replace(".", "");
  let resolvedPath = filePath;

  // Auto-convert images that the target input rejects.
  // Quora is the canonical case — declares accept="image/png,image/jpeg" and silently
  // ignores webp drops. Convert webp/heic to PNG via macOS sips (no extra deps).
  const imageFormats = new Set(['webp', 'heic', 'heif', 'tiff', 'tif']);
  if (imageFormats.has(ext)) {
    const accept = await runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el){var roots=window.mcpCollectRoots?window.mcpCollectRoots():[document];for(var i=0;i<roots.length;i++){el=roots[i].querySelector('${sel}');if(el)break;}}return el?(el.getAttribute('accept')||''):'';})()`,
      { elsewhere }
    ).catch(() => '');
    const acceptStr = String(accept || '').toLowerCase();
    const accepted = !acceptStr ||
      acceptStr.includes('image/*') ||
      acceptStr.includes(`image/${ext}`) ||
      acceptStr.includes(`.${ext}`);
    if (!accepted) {
      const tmpPng = join(tmpdir(), `safari-mcp-upload-${Date.now()}.png`);
      try {
        await execFileAsync('sips', ['-s', 'format', 'png', resolvedPath, '--out', tmpPng], { timeout: 15000 });
        resolvedPath = tmpPng;
        fileName = basename(tmpPng);
        ext = 'png';
      } catch (sipsErr) {
        console.error(`[Safari MCP] sips conversion failed (${ext}→png): ${sipsErr.message}. Continuing with original.`);
      }
    }
  }

  // Read file as base64
  const fileData = await readFile(resolvedPath);
  const base64 = fileData.toString("base64");

  // Determine MIME type
  const mimeMap = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
    mp4: "video/mp4", mp3: "audio/mpeg", txt: "text/plain", csv: "text/csv",
    json: "application/json", zip: "application/zip", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  const mime = mimeMap[ext] || "application/octet-stream";
  const safeName = fileName.replace(/'/g, "\\'");

  // forceNative: skip synthetic injection entirely. Attempting it first would leave a stray
  // media item behind on sites that register the pickup in their UI without ingesting it
  // (Google Business Profile), so the native dialog would then add a SECOND copy.
  const result = forceNative ? '' : await runJSLarge(
    `(function(){
      // Deep query: main document → shadow DOM → iframes
      function deepQuery(sel) {
        var el = document.querySelector(sel);
        if (el) return el;
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var sr = all[i].shadowRoot;
          if (sr) { el = sr.querySelector(sel); if (el) return el; }
        }
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try { var doc = iframes[i].contentDocument; if (doc) { el = doc.querySelector(sel); if (el) return el; } } catch(_) {}
        }
        return null;
      }
      var el = deepQuery('${sel}');
      if (!el) return 'Element not found: ${sel}';

      // Decode base64 to binary
      var b64 = '${base64}';
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      var file = new File([bytes], '${safeName}', { type: '${mime}' });
      var dt = new DataTransfer();
      dt.items.add(file);

      // Counts the visual proof that a site actually ingested the file: object-URL previews
      // it created for it. Ghost pickups (see Strategy 1) leave this at the pre-upload value.
      var __mcpPreviewCount = ${_PREVIEW_COUNT_JS};

      // Baseline BEFORE any dispatch — after the change event a site that works has already
      // painted its preview, so sampling then makes an honest pickup look identical to a ghost.
      var __mcpPreviewsBefore = __mcpPreviewCount();

      // Strategy 1: Direct files assignment (works on most inputs)
      try { el.files = dt.files; } catch(_) {}

      if (el.files && el.files.length > 0) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        // el.files being set proves the DOM accepted the handle — NOT that the site ingested it.
        // Google Business Profile is the canonical liar: it flips its UI to "image attached"
        // yet renders no preview and publishes the post with no image (2026-08-23). Report the
        // preview count so the Node side can escalate when the caller asked to verify.
        return 'Uploaded: ${safeName} (' + Math.round(bytes.length / 1024) + ' KB, verified ' + el.files.length + ' file(s)) [previews=' + __mcpPreviewsBefore + ']';
      }

      // Strategy 2: Drop event on the input or its container (works when files property is read-only)
      var dropTarget = el.closest('[class*="upload"], [class*="drop"], [class*="file"]') || el.parentElement || el;
      var dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
      dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dropTarget.dispatchEvent(dropEvent);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));

      // No await here: do-JavaScript cannot await a Promise, and the drop events above
      // already dispatched synchronously. A framework that needs a tick is surfaced by the hint below.

      // Re-check after drop
      if (el.files && el.files.length > 0) {
        return 'Uploaded via drop: ${safeName} (' + Math.round(bytes.length / 1024) + ' KB, verified ' + el.files.length + ' file(s))';
      }
      // Check if any new images/files appeared on the page after the drop
      var newImgs = document.querySelectorAll('img[src*="blob:"], img[src*="data:"], [style*="background-image"]');
      var hint = newImgs.length > 0 ? ' (detected ' + newImgs.length + ' blob/data images on page — upload likely succeeded)' : '';
      return 'Upload attempted: ${safeName} (' + Math.round(bytes.length / 1024) + ' KB) — drop event dispatched. el.files is empty (normal for custom upload handlers).' + hint + ' Verify with safari_snapshot.';
    })()`,
    { timeout: 30000, elsewhere }
  );

  // Strategy 3: synthetic injection (files=/drop) is silently rejected by isTrusted-gated
  // or custom upload handlers — GitHub's <file-attachment>, some WAF-fronted forms. Escalate
  // to a REAL native file dialog: a CGEvent click opens the OS NSOpenPanel, then System Events
  // types the path. That is an isTrusted:true selection, which those handlers accept.
  let finalResult = result;

  // verifyPreview: the caller states this upload must produce a visible preview (an image
  // going into a composer). Strategy 1 can "succeed" while the site ingested nothing, so
  // re-read the preview count after giving the page a beat to react; if it never moved, the
  // pickup was a ghost and only a real (isTrusted) OS selection will do.
  let ghostPickup = false;
  if (verifyPreview && !forceNative && /verified [1-9]\d* file/i.test(result)) {
    const before = Number((result.match(/\[previews=(-?\d+)\]/) || [])[1] ?? -1);
    const countPreviews = async () => Number(
      await runJS(`(${_PREVIEW_COUNT_JS})()`, { elsewhere }).catch(() => -1)
    );
    // Locked screen: every window is occluded, Safari throttles the page, and the site can take
    // 30–90 s to render the preview (GBP, 26.9.2026) — while the native-dialog escalation cannot
    // run at all. So poll for up to 90 s instead of judging after 1.4 s.
    const locked = await isScreenLocked();
    const deadline = Date.now() + (locked && before >= 0 ? 90000 : 0);
    let after;
    do {
      await new Promise((r) => setTimeout(r, locked ? 2000 : 1400));
      after = await countPreviews();
    } while (Date.now() < deadline && !(before >= 0 && after > before));
    if (before >= 0 && after >= 0 && after <= before) {
      ghostPickup = true;
      console.error(`[Safari MCP] upload_file: ghost pickup on ${sel} (previews ${before}→${after}) — escalating to native dialog`);
    }
  }

  if (forceNative || ghostPickup) {
    try {
      finalResult = await _nativeFileUpload(sel, resolvedPath, safeName);
      if (ghostPickup) finalResult = `${finalResult} [escalated: synthetic pickup produced no preview]`;
    } catch (nativeErr) {
      finalResult = `${ghostPickup ? "NO PREVIEW — the page never showed the file. " : ""}${result} | Native file-dialog ${forceNative ? '(forced)' : '(ghost-pickup escalation)'} failed: ${nativeErr.message}`;
    }
  } else if (/verified 0 file|Upload attempted|el\.files is empty/i.test(result)) {
    try {
      finalResult = await _nativeFileUpload(sel, resolvedPath, safeName);
    } catch (nativeErr) {
      finalResult = `${result} | Native file-dialog fallback failed: ${nativeErr.message}`;
    }
  }

  // Clean up the temp PNG produced by any sips image conversion above (was leaked before).
  if (resolvedPath !== filePath) await unlink(resolvedPath).catch(() => {});
  return finalResult;
}

// ========== NATIVE FILE UPLOAD (real NSOpenPanel — isTrusted, works on GitHub etc.) ==========
// Fallback for uploadFile when synthetic injection is rejected by isTrusted-gated / custom
// upload handlers (GitHub <file-attachment>, WAF forms). Momentarily makes the (usually
// hidden) <input type=file> clickable, native-clicks it to open the OS file dialog, then
// drives the dialog via System Events (Cmd+Shift+G → path → Return → Return). `sel` is
// already escJsSingleQuote-escaped by the caller.
async function _nativeFileUpload(sel, absPath, safeName) {
  // Gate first: step 1 restyles the input into an invisible full-size overlay.
  await assertScreenUnlocked();
  // 1. Make the input clickable (hidden inputs have no hit-box) and read its viewport centre.
  const coordsJson = await runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el){var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var sr=all[i].shadowRoot;if(sr){el=sr.querySelector('${sel}');if(el)break;}}}if(!el)return JSON.stringify({error:'Element not found: ${sel}'});el.setAttribute('data-mcp-oldstyle',el.getAttribute('style')||'');el.style.cssText='position:fixed !important;top:42% !important;left:38% !important;width:320px !important;height:120px !important;opacity:0.02 !important;z-index:2147483647 !important;display:block !important;visibility:visible !important;pointer-events:auto !important';var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`
  );
  let c;
  try { c = JSON.parse(coordsJson); } catch { throw new Error("coord parse failed: " + coordsJson); }
  if (c.error) throw new Error(c.error);

  let dlgStatus;
  let filesLen;
  try {
    dlgStatus = await _clickInputAndDriveDialog(c, absPath);
  } finally {
    // 4. Restore the input's original style — also when the click or the dialog threw, or the
    //    page keeps an invisible full-size overlay that swallows clicks.
    filesLen = await runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'gone';var old=el.getAttribute('data-mcp-oldstyle');if(old!==null){if(old){el.setAttribute('style',old);}else{el.removeAttribute('style');}el.removeAttribute('data-mcp-oldstyle');}return String(el.files?el.files.length:0);})()`
    ).catch(() => "?");
  }
  // A dialog that never opened selected nothing; reporting "Uploaded" here sent callers on as if it had.
  if (/sheet=false/.test(dlgStatus)) {
    throw new Error(`the OS file dialog never opened (${dlgStatus}, input.files=${filesLen}) — nothing was selected`);
  }
  return `Uploaded via native file dialog (isTrusted): ${safeName} — input.files=${filesLen}, ${dlgStatus}. Real OS selection; accepted by isTrusted-gated handlers (GitHub etc.). Verify with safari_snapshot.`;
}

// Steps 2–3 of _nativeFileUpload: a native click on the restyled input opens the NSOpenPanel,
// then System Events drives it. Returns the dialog status ("sheet=true|false" or "osaerr:…").
async function _clickInputAndDriveDialog(c, absPath) {
  // 2. Native (CGEvent, isTrusted:true) click on the input → opens the OS file dialog.
  const geo = await _getSafariWindowGeometry();
  if (!geo.windowId) throw new Error("no Safari window id (cannot native-click without focus steal)");
  const screenX = geo.windowX + c.x;
  const screenY = geo.windowY + geo.toolbarHeight + c.y;
  // Safari must already be frontmost when the file input is clicked, otherwise the OS file
  // dialog either does not open or opens unfocused. Activate with noFocusGuard so it STAYS
  // frontmost (the normal osascript focus-guard would immediately restore focus elsewhere).
  await osascriptFast('tell application "Safari" to activate', { noFocusGuard: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 450));
  // A targeted (windowId) click does NOT open the OS file dialog — that requires a real,
  // hardware-like click that physically moves the cursor. Use the legacy path (windowId=0)
  // for THIS click only; it briefly moves the mouse to the input, which opens the NSOpenPanel.
  await _helperNativeClick(screenX, screenY, false, 0);

  // 3. Drive the NSOpenPanel: wait for the sheet, Cmd+Shift+G, type the absolute path, confirm.
  const pathEsc = absPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Activate + drive the dialog in ONE osascript so Safari stays frontmost throughout (a
  // separate activate call would be undone by osascript()'s focus-guard restore). Generous
  // timeout: the sheet-wait + Cmd+Shift+G + typing a long path can exceed the 10s default.
  const status = await osascript(
    `tell application "Safari" to activate
    delay 0.3
    tell application "System Events"
      tell process "Safari"
        set _t to 0
        repeat until (exists sheet 1 of window 1) or _t > 25
          delay 0.1
          set _t to _t + 1
        end repeat
        set _hadSheet to (exists sheet 1 of window 1)
        delay 0.25
        keystroke "g" using {command down, shift down}
        delay 0.45
        keystroke "${pathEsc}"
        delay 0.35
        key code 36
        delay 0.6
        key code 36
        return "sheet=" & _hadSheet
      end tell
    end tell`,
    { timeout: 30000 }
  ).catch((e) => "osaerr:" + e.message);
  await new Promise((r) => setTimeout(r, 900));
  return status;
}

// ========== PASTE IMAGE FROM FILE ==========

// `locate`: as for uploadFile.
export async function pasteImageFromFile({ filePath, locate = null }) {
  _validateFilePath(filePath);
  // Paste image via JS ClipboardEvent — NO clipboard touch, NO System Events, NO focus steal
  const { extname } = await import("node:path");
  const ext = extname(filePath).toLowerCase().replace(".", "");
  const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const mime = mimeMap[ext] || "image/png";

  // Read image as base64
  const fileData = await readFile(filePath);
  const base64 = fileData.toString("base64");
  const fileName = filePath.split("/").pop().replace(/'/g, "\\'");

  // Use runJSLarge — images are often >260KB as base64
  const result = await runJSLarge(
    `(function(){
      var el = document.activeElement;
      if (!el) return 'No focused element';

      // Decode base64 to blob
      var b64 = '${base64}';
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var blob = new Blob([bytes], { type: '${mime}' });
      var file = new File([blob], '${fileName}', { type: '${mime}' });

      // Method 1: Synthetic paste event with DataTransfer (works on Medium, dev.to, etc.)
      var dt = new DataTransfer();
      dt.items.add(file);
      var pasteEvent = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      var handled = el.dispatchEvent(pasteEvent);

      // Method 2: If paste didn't work, try drop event (works on drag-drop zones)
      if (!handled || !document.querySelector('img[src^="blob:"],img[src^="data:"]')) {
        var dropDt = new DataTransfer();
        dropDt.items.add(file);
        var dropEvent = new DragEvent('drop', { dataTransfer: dropDt, bubbles: true, cancelable: true });
        el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dropDt, bubbles: true }));
        el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dropDt, bubbles: true }));
        el.dispatchEvent(dropEvent);
      }

      return 'Pasted image: ${fileName} (' + Math.round(bytes.length / 1024) + ' KB)';
    })()`,
    { timeout: 30000, elsewhere: _locusWindows(locate) }
  );

  return result;
}

// ========== EMULATE (VIEWPORT) ==========

// Captured from Mobile Safari on the iOS/iPadOS 27.0 simulator (Xcode 27, 2026-09-15). Since
// iOS 26 Safari freezes the OS token (18_6 at 26.0, 18_7 from 26.2) and only Version/ moves.
// iPadOS requests desktop sites, so an iPad sends the Mac UA and platform "MacIntel"; pages tell
// it apart by navigator.maxTouchPoints, which the override sets too.
const UA_IOS_27 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
const UA_IPADOS_27 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";
const _iphone = (width, height) => ({ width, height, ua: UA_IOS_27, platform: "iPhone", touchPoints: 5 });
const _ipad = (width, height) => ({ width, height, ua: UA_IPADOS_27, touchPoints: 5 });

// Portrait CSS viewport (screen points). The iphone-14* / ipad / ipad-pro names predate iOS 27
// and stay so existing callers keep working.
export const EMULATION_DEVICES = {
  "iphone-18-pro": _iphone(402, 874),
  "iphone-18-pro-max": _iphone(440, 956),
  "iphone-air": _iphone(420, 912),
  "iphone-17": _iphone(402, 874),
  "iphone-17e": _iphone(390, 844),
  "iphone-16": _iphone(393, 852),
  "iphone-14": _iphone(390, 844),
  "iphone-14-pro-max": _iphone(430, 932),
  "ipad": _ipad(820, 1180),
  "ipad-air-11": _ipad(820, 1180),
  "ipad-air-13": _ipad(1024, 1366),
  "ipad-pro-11": _ipad(834, 1210),
  "ipad-pro-13": _ipad(1032, 1376),
  "ipad-pro": _ipad(1024, 1366),
  "pixel-7": { width: 412, height: 915, ua: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" },
  "galaxy-s24": { width: 412, height: 915, ua: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" },
};

// Pure. An unknown name used to fall through to a bare 375×812 window with no UA while the
// result still echoed the requested device — refuse it instead.
export function resolveEmulation({ device, width, height, userAgent } = {}) {
  if (device) {
    const name = String(device).trim().toLowerCase();
    if (!Object.hasOwn(EMULATION_DEVICES, name)) {
      throw new Error(`Unknown device "${device}". Available: ${Object.keys(EMULATION_DEVICES).join(", ")} — or pass width/height (and userAgent).`);
    }
    return { name, ...EMULATION_DEVICES[name] };
  }
  const size = (v, fallback) => (Number(v) > 0 ? Math.round(Number(v)) : fallback);
  return { name: "custom", width: size(width, 375), height: size(height, 812), ua: userAgent || "" };
}

// Pure. The getters carry a marker so resetEmulation() removes only what emulate() added.
export function buildNavigatorOverrideJS({ ua, platform, touchPoints } = {}) {
  const props = [];
  if (ua) props.push(`['userAgent','${escJsSingleQuote(ua)}']`);
  if (platform) props.push(`['platform','${escJsSingleQuote(platform)}']`);
  if (touchPoints != null) props.push(`['maxTouchPoints',${Number(touchPoints)}]`);
  if (!props.length) return "";
  return `(function(){[${props.join(",")}].forEach(function(p){var g=function(){return p[1]};g.__mcpEmulated=true;Object.defineProperty(navigator,p[0],{get:g,configurable:true})});return navigator.userAgent})()`;
}

export const RESET_NAVIGATOR_JS = "(function(){['userAgent','platform','maxTouchPoints'].forEach(function(k){var d=Object.getOwnPropertyDescriptor(navigator,k);if(d&&d.get&&d.get.__mcpEmulated)delete navigator[k]});return navigator.userAgent})()";

export async function emulate(args) {
  const target = resolveEmulation(args);
  await refreshTargetWindow();
  const winRef = getTargetWindowRef();
  const st = _st();
  // Remember the user's window once, so reset_emulation puts it back instead of forcing 1440×900.
  // Comma-joined explicitly: the helper daemon returns "" for an AppleScript list.
  if (!st.preEmulationBounds) {
    const b = String(await osascriptFast(
      `tell application "Safari"\n  set b to bounds of ${winRef}\n  return (item 1 of b as text) & "," & (item 2 of b as text) & "," & (item 3 of b as text) & "," & (item 4 of b as text)\nend tell`
    ).catch(() => "")).trim();
    if (/^-?\d+,-?\d+,-?\d+,-?\d+$/.test(b)) st.preEmulationBounds = b;
  }
  // Size from the measured browser chrome, so the page viewport — not the window — matches.
  let chrome = 90;
  try {
    const c = Number(await runJS("(window.outerHeight - window.innerHeight) + ''"));
    if (Number.isFinite(c) && c >= 50 && c <= 200) chrome = c;
  } catch (_e) { /* keep the Safari 26/27 default */ }
  await osascriptFast(`tell application "Safari" to set bounds of ${winRef} to {0, 0, ${target.width}, ${target.height + chrome}}`);

  // No reload after this: a reload gives the page a fresh navigator and silently drops the
  // override — which is what the old reload-to-apply step did to every emulation.
  const overrideJS = buildNavigatorOverrideJS(target);
  if (overrideJS) await runJS(overrideJS);

  const actual = await _relayoutAndMeasure();
  const notes = [];
  if (overrideJS) notes.push("navigator.userAgent/platform/maxTouchPoints are overridden for this page's JavaScript only: the HTTP User-Agent header is unchanged, and a reload or navigation clears the override — call safari_emulate again after navigating.");
  if (actual && actual[0] > target.width) notes.push(`Safari kept the window wider than ${target.width}px (page viewport ${actual[0]}px).`);
  if (actual && actual[1] < target.height) notes.push(`The screen is too short for a ${target.height}px viewport — the page gets ${actual[1]}px.`);
  return JSON.stringify({ device: target.name, viewport: { requested: [target.width, target.height], actual }, userAgent: target.ua || "(unchanged)", notes });
}

// A background tab keeps its old layout — innerWidth, media queries, even outerWidth — until
// it is shown (seen on Safari 27: 1512px after a resize to 402 until the tab was fronted). Show
// ours for a moment (selection restored, Safari never activated) so the new size sticks.
async function _relayoutAndMeasure() {
  let size = null;
  await _withTargetTabFronted(async () => {
    await new Promise((r) => setTimeout(r, 250));
    try { size = JSON.parse(await runJS("JSON.stringify([window.innerWidth, window.innerHeight])")); } catch (_e) { /* reported as null */ }
  });
  return size;
}

export async function resetEmulation() {
  await refreshTargetWindow();
  const st = _st();
  const bounds = st.preEmulationBounds || "0,0,1440,900";
  st.preEmulationBounds = null;
  await osascriptFast(`tell application "Safari" to set bounds of ${getTargetWindowRef()} to {${bounds}}`);
  // Deleting the marked getters restores Navigator.prototype's — no reload, so page state survives.
  await runJS(RESET_NAVIGATOR_JS);
  const viewport = await _relayoutAndMeasure();
  return `Emulation reset: window bounds {${bounds}}, viewport ${viewport ? viewport.join("×") : "unknown"}, navigator overrides removed`;
}

// ========== CONSOLE CAPTURE ==========

export async function startConsoleCapture() {
  await runJS(
    "if(!window.__mcp_console){window.__mcp_console=[];var orig={log:console.log,warn:console.warn,error:console.error,info:console.info};['log','warn','error','info'].forEach(function(level){console[level]=function(){window.__mcp_console.push({level:level,message:[].slice.call(arguments).map(String).join(' '),time:Date.now()});if(window.__mcp_console.length>2000)window.__mcp_console.shift();orig[level].apply(console,arguments);};});window.addEventListener('error',function(e){window.__mcp_console.push({level:'error',message:e.message,time:Date.now()});if(window.__mcp_console.length>2000)window.__mcp_console.shift();});}"
  );
  return "Console capture started";
}

export async function getConsoleMessages() {
  return runJS("JSON.stringify(window.__mcp_console||[])");
}

export async function clearConsoleCapture() {
  return runJS("window.__mcp_console=[]; 'Console cleared'");
}

// ========== PDF SAVE ==========

export async function savePDF({ path: pdfPath }) {
  await refreshTargetWindow();
  _validateFilePath(pdfPath);  // allowlist (/Users//tmp//var-folders) + block sensitive paths — prevents arbitrary overwrite
  // NO app focus stealing — tab selection, window resize and screencapture all stay
  // inside our window; the user's frontmost app is never activated.

  const tmpPng = join(tmpdir(), `safari-mcp-pdf-${Date.now()}.png`);
  // screencapture -l grabs the window's SELECTED tab — front ours for the duration
  // (selection restored by _withTargetTabFronted), otherwise the PDF shows whatever
  // tab the user last left selected in that window.
  await _withTargetTabFronted(async () => {
    // Step 1: Get full page dimensions
    const dims = await runJS("JSON.stringify({h:document.documentElement.scrollHeight,w:document.documentElement.scrollWidth})");
    const { h, w } = JSON.parse(dims);

    // Step 2: Save current bounds and resize to capture full page
    const origBounds = await osascript(
      `tell application "Safari" to return bounds of ${getTargetWindowRef()}`
    );
    const captureHeight = Math.min(Number(h) + 100, 16000);
    await osascript(
      `tell application "Safari" to set bounds of ${getTargetWindowRef()} to {0, 0, ${Number(w)}, ${captureHeight}}`
    );
    await new Promise(r => setTimeout(r, 500)); // Let page reflow

    // Step 3: Take screenshot via screencapture -l (window-targeted, NO focus steal)
    const windowIdRaw = await osascript(
      `tell application "Safari" to return id of ${getTargetWindowRef()}`
    );
    const windowId = windowIdRaw != null && /^\d+$/.test(String(windowIdRaw).trim()) ? String(windowIdRaw).trim() : null;
    if (!windowId) throw new Error("Cannot get Safari window ID for PDF capture");
    try {
      // Route capture through the TCC-granted helper (NSAppleScript → do shell script):
      // under the launchd daemon, node has no Screen Recording grant — the helper does.
      await osascriptFast(
        `do shell script "/usr/sbin/screencapture -l${windowId} -o -x '${tmpPng}'"`,
        { timeout: 15000 }
      );
    } catch (err) {
      // Restore bounds on failure
      await osascript(`tell application "Safari" to set bounds of ${getTargetWindowRef()} to {${origBounds}}`).catch(() => {});
      throw new Error(`PDF screenshot capture failed: ${err.message}`);
    }

    // Step 4: Restore original bounds
    await osascript(
      `tell application "Safari" to set bounds of ${getTargetWindowRef()} to {${origBounds}}`
    ).catch(() => {});
  });

  // Step 5: Convert screenshot to PDF with sips (macOS built-in). Replaces the previous
  // python3+Quartz converter: current macOS ships pyobjc for neither the system nor the
  // homebrew python3, so any bare `python3` died with ModuleNotFoundError: Quartz.
  try {
    await execFileAsync("/usr/bin/sips", ["-s", "format", "pdf", tmpPng, "--out", pdfPath], { timeout: 15000 });
  } catch (err) {
    throw new Error(`PDF conversion failed: ${err.message}`);
  } finally {
    unlink(tmpPng).catch(() => {});
  }

  return `PDF saved to: ${pdfPath} (image-based, no focus stealing)`;
}

// ========== SNAPSHOT — ref-based interaction (like Chrome DevTools MCP) ==========
// Assigns numeric refs to interactive/visible elements so Claude can say "click ref 5"
// instead of guessing CSS selectors. Much faster, no hallucination risk.

let _snapshotGen = 0;
// getNextSnapshotGen is used by the MCP tool path (index.js) to reserve a gen for the extension.
// If the extension fails and falls back to takeSnapshot(), takeSnapshot uses _snapshotGen directly
// (which was already incremented by getNextSnapshotGen) — so no double-increment occurs.
export function getNextSnapshotGen() { return _snapshotGen++; }

export async function takeSnapshot({ selector, _gen } = {}) {
  // Use provided gen (from tool path) or allocate a new one (direct call)
  const gen = _gen != null ? _gen : _snapshotGen++;
  const root = selector ? `document.querySelector('${selector.replace(/'/g, "\\'")}')` : "document.body";

  const result = await runJS(
    `(function(){
      var gen = ${gen};
      var id = 0;
      var lines = [];
      // Clear old refs
      document.querySelectorAll('[data-mcp-ref]').forEach(function(el){ el.removeAttribute('data-mcp-ref'); });

      function getRole(el) {
        var role = el.getAttribute('role');
        if (role) return role;
        var tag = el.tagName.toLowerCase();
        var map = {
          a:'link', button:'button', input:'textbox', textarea:'textbox',
          select:'combobox', img:'img', h1:'heading', h2:'heading', h3:'heading',
          h4:'heading', h5:'heading', h6:'heading', nav:'navigation', main:'main',
          header:'banner', footer:'contentinfo', form:'form', table:'table',
          tr:'row', th:'columnheader', td:'cell', ul:'list', ol:'list', li:'listitem',
          dialog:'dialog', details:'group', summary:'button', label:'label',
          iframe:'document', video:'video', audio:'audio', canvas:'canvas',
          progress:'progressbar', meter:'meter'
        };
        if (tag === 'input') {
          var type = (el.type || 'text').toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'submit' || type === 'button') return 'button';
          if (type === 'file') return 'file';
          if (type === 'range') return 'slider';
          return 'textbox';
        }
        return map[tag] || null;
      }

      function getName(el) {
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        var ariaLabelledBy = el.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
          var ref = document.getElementById(ariaLabelledBy);
          if (ref) return ref.textContent.trim().substring(0,80);
        }
        if (el.tagName === 'IMG') return el.alt || '';
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          var label = el.closest('label') || (el.id && document.querySelector('label[for=\"'+el.id+'\"]'));
          if (label) return label.textContent.trim().substring(0,80);
          if (el.placeholder) return el.placeholder;
          if (el.name) return el.name;
        }
        if (el.title) return el.title;
        // For links/buttons, use text content
        if (['A','BUTTON','LABEL','SUMMARY'].includes(el.tagName)) {
          return el.textContent.trim().substring(0,80);
        }
        return '';
      }

      function isInteractive(el) {
        var tag = el.tagName;
        if (['A','BUTTON','INPUT','TEXTAREA','SELECT','SUMMARY','DETAILS'].includes(tag)) return true;
        if (el.getAttribute('role')) return true;
        if (el.getAttribute('tabindex') !== null) return true;
        if (el.onclick || el.getAttribute('onclick')) return true;
        if (el.isContentEditable) return true;
        return false;
      }

      function isStyleVisible(el) {
        var style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        return true;
      }

      function isVisible(el) {
        if (!isStyleVisible(el)) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      function walk(el, depth) {
        if (depth > 20 || id > 800) return;
        if (!isStyleVisible(el)) return;

        var role = getRole(el);
        var interactive = isInteractive(el);
        var isHeading = /^H[1-6]$/.test(el.tagName);
        var isText = !role && el.children.length === 0 && el.textContent.trim().length > 0 && el.textContent.trim().length < 200;
        var visible = isVisible(el);

        // Include: interactive elements, headings, images, text nodes with content
        if (visible && (role || interactive || isHeading || isText)) {
          var ref = gen + '_' + (id++);
          el.setAttribute('data-mcp-ref', ref);
          var rect=el.getBoundingClientRect();
          var meta={tag:el.tagName};var nm=getName(el);if(nm)meta.text=nm.substring(0,80);
          if(el.id)meta.id=el.id;
          if(el.getAttribute('name'))meta.nameAttr=el.getAttribute('name');
          var _ti=el.getAttribute('data-testid');if(_ti)meta.testid=_ti;
          if(el.href)meta.href=el.href;
          var _al=el.getAttribute('aria-label');if(_al)meta.al=_al;
          if(el.placeholder)meta.ph=el.placeholder;
          meta.cx=Math.round(window.scrollX+rect.left+rect.width/2);
          meta.cy=Math.round(window.scrollY+rect.top+rect.height/2);
          window.__mcpRefs[ref]=meta;
          var indent = '  '.repeat(depth);
          var line = indent + 'ref=' + ref + ' ';

          if (role) line += role;
          else if (isText) line += 'text';
          else line += el.tagName.toLowerCase();

          var name = getName(el);
          if (name) line += ' "' + name.replace(/"/g, "'") + '"';

          // Value for inputs
          if (el.value !== undefined && el.value !== '' && el.tagName !== 'BUTTON') {
            line += ' value="' + String(el.value).substring(0,50).replace(/"/g, "'") + '"';
          }
          // Checked state
          if (el.checked) line += ' checked';
          // Disabled
          if (el.disabled) line += ' disabled';
          // Required
          if (el.required) line += ' required';
          // Selected (option)
          if (el.selected) line += ' selected';
          // Expanded (details, aria-expanded)
          if (el.open !== undefined) line += el.open ? ' expanded' : ' collapsed';
          if (el.getAttribute('aria-expanded') === 'true') line += ' expanded';
          if (el.getAttribute('aria-expanded') === 'false') line += ' collapsed';
          // Heading level
          if (isHeading) line += ' level=' + el.tagName[1];
          // Focusable
          if (el.tabIndex >= 0) line += ' focusable';
          // Link href
          if (el.tagName === 'A' && el.href) line += ' href="' + el.href.substring(0,100) + '"';
          // Content editable
          if (el.isContentEditable && el.getAttribute('contenteditable') !== 'inherit') line += ' editable';

          lines.push(line);
        }

        // Recurse into children
        for (var i = 0; i < el.children.length; i++) {
          walk(el.children[i], depth + (role ? 1 : 0));
        }
        if (el.shadowRoot) {
          for (var j = 0; j < el.shadowRoot.children.length; j++) {
            walk(el.shadowRoot.children[j], depth + (role ? 1 : 0));
          }
        }
      }

      window.__mcpRefs = {};
      window.__mcpRefsTime = Date.now();
      var root = ${root};
      if (!root) return 'Element not found';
      walk(root, 0);
      return lines.join('\\n');
    })()`
  );

  return result;
}

// Click/fill/type by ref — resolves data-mcp-ref attribute
export function refSelector(ref) {
  return `[data-mcp-ref="${ref}"]`;
}

// ========== RUN SCRIPT (multi-step automation in one call) ==========

// Execute multiple safari.js operations in a single tool call
// Avoids round-trip overhead of calling tools one by one
// script is a JSON array of steps: [{action: "navigate", args: {url: "..."}}, {action: "click", args: {selector: "..."}}, ...]
export async function runScript({ steps, onStep, actions: overrides = {} }) {
  const results = [];
  for (const step of steps) {
    const { action, args = {} } = step;
    // Safety callback (tab-ownership, wired by index.js) runs OUTSIDE the per-step
    // try/catch: a refusal must abort the whole batch, not be recorded as a step
    // error and silently continue to the next step.
    if (onStep) onStep(action, args);
    try {
      // Map action names to safari.js functions
      const actions = {
        navigate: (a) => navigate(a.url),
        reload: (a) => reload(a.hard ?? a.hardReload ?? false),
        newTab: (a) => newTab(a.url || ""),
        closeTab: (a) => closeOwnTab(a.index),
        switchTab: (a) => switchTab(a.index),
        navigateAndRead: (a) => navigateAndRead(a.url, a),
        click, doubleClick, rightClick, fill, clearField, typeText,
        pressKey, scroll, scrollTo, scrollToElement, readPage, getPageSource,
        screenshot, screenshotElement, evaluate, waitFor, waitForTime, hover,
        selectOption, fillForm, fillAndSubmit, clickAndWait,
        goBack, goForward, listTabs,
        getLocalStorage, setLocalStorage, deleteLocalStorage,
        getSessionStorage, setSessionStorage, deleteSessionStorage,
        getCookies, setCookie, deleteCookies, getElementInfo, querySelectorAll,
        extractTables, extractMeta, extractImages, extractLinks,
        analyzePage, detectForms, getAccessibilityTree, getPerformanceMetrics,
        // Previously-missing actions — these tools existed but couldn't be batched.
        verifyState, reactSelectSet, reactSelectListOptions,
        nativeClick, nativeHover, nativeType, nativeKeyboard,
        replaceEditorContent, uploadFile, mockNetworkRoute,
      };
      // index.js takes over an action where it has more to go on (switchTab, getReceipt: the extension;
      // newTab and closeTab: the tab ownership it keeps).
      const fn = overrides[action] || actions[action];
      if (!fn) {
        results.push({ action, error: `Unknown action: ${action}` });
        continue;
      }
      const result = await fn(args);
      results.push({ action, result: typeof result === "string" ? result.substring(0, 2000) : result });
    } catch (err) {
      results.push({ action, error: err.message });
      // A switch that did not happen stops the batch: the steps after it were meant for that tab,
      // and would run in the current one. getReceipt switches too, to the tab its receipt names.
      if (action === "switchTab" || action === "getReceipt") break;
    }
  }
  return JSON.stringify(results);
}

// ========== ACCESSIBILITY SNAPSHOT ==========

export async function getAccessibilityTree({ selector, maxDepth = 5 }) {
  const sel = selector ? `'${selector.replace(/'/g, "\\'")}'` : "null";
  return runJS(
    `(function(){
      function buildTree(el, depth) {
        if (!el || depth > ${Number(maxDepth)}) return null;
        var role = el.getAttribute('role') || el.tagName.toLowerCase();
        var ariaLabel = el.getAttribute('aria-label') || '';
        var ariaDescribedBy = el.getAttribute('aria-describedby') || '';
        var ariaExpanded = el.getAttribute('aria-expanded');
        var ariaChecked = el.getAttribute('aria-checked');
        var ariaSelected = el.getAttribute('aria-selected');
        var ariaDisabled = el.getAttribute('aria-disabled');
        var ariaHidden = el.getAttribute('aria-hidden');
        var tabIndex = el.tabIndex;
        var text = '';
        if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
          text = el.childNodes[0].textContent.trim().substring(0, 100);
        }
        var node = { role: role };
        if (ariaLabel) node.name = ariaLabel;
        if (text) node.text = text;
        if (el.id) node.id = el.id;
        if (ariaExpanded !== null) node.expanded = ariaExpanded;
        if (ariaChecked !== null) node.checked = ariaChecked;
        if (ariaSelected !== null) node.selected = ariaSelected;
        if (ariaDisabled !== null) node.disabled = ariaDisabled;
        if (ariaHidden === 'true') node.hidden = true;
        if (tabIndex >= 0) node.focusable = true;
        if (el.tagName === 'A' && el.href) node.href = el.href;
        if (el.tagName === 'IMG') { node.alt = el.alt || '(missing)'; node.src = el.src; }
        if (['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) {
          node.type = el.type || el.tagName.toLowerCase();
          node.value = (el.value || '').substring(0, 100);
          if (el.required) node.required = true;
          if (el.placeholder) node.placeholder = el.placeholder;
        }
        var children = [];
        for (var i = 0; i < el.children.length; i++) {
          if (el.children[i].getAttribute('aria-hidden') === 'true') continue;
          var child = buildTree(el.children[i], depth + 1);
          if (child) children.push(child);
        }
        if (children.length > 0) node.children = children;
        return node;
      }
      var root = ${sel} ? document.querySelector(${sel}) : document.body;
      if (!root) return JSON.stringify({ error: 'Element not found' });
      return JSON.stringify(buildTree(root, 0));
    })()`,
    { timeout: 30000 }
  );
}

// ========== COOKIE CRUD ==========

export async function setCookie({ name, value, domain, path: cookiePath, expires, secure, sameSite, httpOnly }) {
  const safeName = escJsSingleQuote(name);
  const safeValue = escJsSingleQuote(value);
  // Every interpolated attribute goes through escJsSingleQuote — path/domain/expires
  // used to be embedded raw and then "escaped" with a quote-only replace (no
  // backslash-first), which both broke legitimate values and re-opened the literal.
  let cookie = `${safeName}=${safeValue}`;
  if (cookiePath) cookie += `; path=${escJsSingleQuote(cookiePath)}`;
  if (domain) cookie += `; domain=${escJsSingleQuote(domain)}`;
  if (expires) cookie += `; expires=${escJsSingleQuote(expires)}`;
  if (secure) cookie += '; secure';
  if (sameSite) cookie += `; samesite=${sameSite}`;
  return pageJS(`document.cookie='${cookie}'; 'Cookie set: ${safeName}'`);
}

export async function deleteCookies({ name, all }) {
  if (all) {
    return pageJS(
      `(function(){var cookies=document.cookie.split(';');var count=0;cookies.forEach(function(c){var name=c.split('=')[0].trim();document.cookie=name+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';count++;});return 'Deleted '+count+' cookies';})()`
    );
  }
  if (name) {
    const safeName = escJsSingleQuote(name);
    return pageJS(
      `document.cookie='${safeName}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'; 'Deleted cookie: ${safeName}'`
    );
  }
  throw new Error("deleteCookies requires name or all:true");
}

// ========== SESSION STORAGE ==========

export async function getSessionStorage({ key }) {
  if (key) {
    const safeKey = escJsSingleQuote(key);
    return pageJS(`sessionStorage.getItem('${safeKey}')`);
  }
  return pageJS(
    "JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map(function(k){var v=sessionStorage.getItem(k);return[k,v==null?null:v.substring(0,200)]})))"
  );
}

export async function setSessionStorage({ key, value }) {
  const safeKey = escJsSingleQuote(key);
  const safeValue = escJsSingleQuote(value);
  return pageJS(`sessionStorage.setItem('${safeKey}','${safeValue}'); 'Set sessionStorage: ${safeKey}'`);
}

export async function setLocalStorage({ key, value }) {
  const safeKey = escJsSingleQuote(key);
  const safeValue = escJsSingleQuote(value);
  return pageJS(`localStorage.setItem('${safeKey}','${safeValue}'); 'Set localStorage: ${safeKey}'`);
}

export async function deleteLocalStorage({ key }) {
  if (key) {
    const safeKey = escJsSingleQuote(key);
    return pageJS(`localStorage.removeItem('${safeKey}'); 'Deleted localStorage: ${safeKey}'`);
  }
  return pageJS("var n=localStorage.length; localStorage.clear(); 'Cleared localStorage: '+n+' items'");
}

export async function deleteSessionStorage({ key }) {
  if (key) {
    const safeKey = escJsSingleQuote(key);
    return pageJS(`sessionStorage.removeItem('${safeKey}'); 'Deleted sessionStorage: ${safeKey}'`);
  }
  return pageJS("var n=sessionStorage.length; sessionStorage.clear(); 'Cleared sessionStorage: '+n+' items'");
}

// Export all storage state (cookies + localStorage + sessionStorage) as JSON
export async function exportStorageState() {
  return pageJS(
    `JSON.stringify({
      url: location.href,
      cookies: document.cookie,
      localStorage: Object.fromEntries(Object.keys(localStorage).map(function(k){return[k,localStorage.getItem(k)]})),
      sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(function(k){return[k,sessionStorage.getItem(k)]}))
    })`
  );
}

// Import storage state from JSON
export async function importStorageState({ state }) {
  const parsed = typeof state === "string" ? JSON.parse(state) : state;
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
  const cmds = [];
  // Cookies must be set one at a time — document.cookie only accepts one cookie per assignment
  if (parsed.cookies) {
    const cookiePairs = String(parsed.cookies).split(/;\s*/);
    for (const pair of cookiePairs) {
      if (pair.trim()) cmds.push(`document.cookie='${esc(pair.trim())}'`);
    }
  }
  if (parsed.localStorage) {
    for (const [k, v] of Object.entries(parsed.localStorage)) {
      cmds.push(`localStorage.setItem('${esc(k)}','${esc(v)}')`);
    }
  }
  if (parsed.sessionStorage) {
    for (const [k, v] of Object.entries(parsed.sessionStorage)) {
      cmds.push(`sessionStorage.setItem('${esc(k)}','${esc(v)}')`);
    }
  }
  // Use runJSLarge for large sessions (many cookies/localStorage keys can exceed 260KB limit of runJS)
  const script = cmds.join(";") + "; 'Imported ' + " + cmds.length + " + ' items'";
  return pageJS(script, () => (script.length > 200000 ? runJSLarge(script, { timeout: 30000 }) : runJS(script)));
}

// ========== CLIPBOARD ==========

export async function clipboardRead() {
  // Acquire lock to avoid reading during a write/restore cycle
  await _acquireClipboardLock(3000); // Short timeout — reads are fast
  try {
    const text = await execFileAsync("pbpaste", []);
    return text.stdout;
  } catch {
    return "(clipboard empty or contains non-text data)";
  } finally {
    _releaseClipboardLock();
  }
}

export async function clipboardWrite({ text, restore = true }) {
  await _acquireClipboardLock();
  try {
    // Save current clipboard
    const oldClipboard = restore ? await _saveClipboard() : null;

    // Use spawn + stdin pipe — safe from shell injection (no shell involved)
    await _pbcopy(text);

    // Restore clipboard after 2 seconds (reduced from 5s — shorter exposure window)
    if (restore && oldClipboard !== null) {
      if (_clipboardRestoreTimer) clearTimeout(_clipboardRestoreTimer);
      // Stash the content so flushClipboardRestore() can restore it synchronously if the
      // process is signalled to exit inside this 2s window — otherwise the user is left
      // holding the tool's pasted text (violates the clipboard-safety guarantee).
      _pendingClipboardRestore = oldClipboard;
      _clipboardRestoreTimer = setTimeout(async () => {
        await _restoreClipboard(oldClipboard);
        _pendingClipboardRestore = undefined;
        _clipboardRestoreTimer = null;
        _releaseClipboardLock();
      }, 2000);
      return `Copied ${text.length} chars to clipboard (will restore in 2s)`;
    }

    _releaseClipboardLock();
    return `Copied ${text.length} chars to clipboard`;
  } catch (err) {
    _releaseClipboardLock();
    throw err;
  }
}

// Synchronously flush a pending clipboard restore — called from the shutdown handler so the
// user never inherits the tool's pasted text if the process exits inside the 2s restore
// window. Uses spawnSync (blocking) because we're on the exit path and can't await a Promise.
export function flushClipboardRestore() {
  if (_clipboardRestoreTimer) {
    clearTimeout(_clipboardRestoreTimer);
    _clipboardRestoreTimer = null;
  }
  if (_pendingClipboardRestore === undefined) return;
  const content = _pendingClipboardRestore;
  _pendingClipboardRestore = undefined;
  try {
    spawnSync("pbcopy", [], { input: content });
  } catch { /* best effort — we're exiting anyway */ }
  _releaseClipboardLock();
}

// ========== NETWORK MOCKING ==========

// Intercept fetch/XHR requests matching a URL pattern and return mock responses
export async function mockNetworkRoute({ urlPattern, response }) {
  // Escape backslash FIRST, then quotes — the reverse order double-escapes the quote
  // (\' → \\') and breaks out of the JS string literal.
  const safePattern = escJsSingleQuote(urlPattern);
  const safeBody = (response.body || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
  const status = Number(response.status) || 200;
  // contentType reaches the injected JS literal — escape it like every other field.
  const contentType = escJsSingleQuote(response.contentType || "application/json");

  return runJS(
    `(function(){
      if (!window.__mcp_mocks) window.__mcp_mocks = [];
      window.__mcp_mocks.push({pattern: '${safePattern}', status: ${status}, body: '${safeBody}', contentType: '${contentType}'});

      // Patch fetch (once)
      if (!window.__mcp_fetch_patched) {
        window.__mcp_fetch_patched = true;
        var origFetch = window.fetch;
        window.fetch = function(url, opts) {
          var reqUrl = typeof url === 'string' ? url : url.url;
          var mock = window.__mcp_mocks.find(function(m) {
            return reqUrl.includes(m.pattern) || new RegExp(m.pattern).test(reqUrl);
          });
          if (mock) {
            return Promise.resolve(new Response(mock.body, {
              status: mock.status,
              headers: {'Content-Type': mock.contentType}
            }));
          }
          return origFetch.apply(this, arguments);
        };

        // Patch XHR
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__mcp_url = url;
          this.__mcp_method = method;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(body) {
          var mock = (window.__mcp_mocks || []).find(function(m) {
            return this.__mcp_url && (this.__mcp_url.includes(m.pattern) || new RegExp(m.pattern).test(this.__mcp_url));
          }.bind(this));
          if (mock) {
            Object.defineProperty(this, 'status', {get: function(){return mock.status;}});
            Object.defineProperty(this, 'responseText', {get: function(){return mock.body;}});
            Object.defineProperty(this, 'response', {get: function(){return mock.body;}});
            Object.defineProperty(this, 'readyState', {get: function(){return 4;}});
            this.dispatchEvent(new Event('readystatechange'));
            this.dispatchEvent(new Event('load'));
            return;
          }
          return origSend.apply(this, arguments);
        };
      }
      return 'Mock added: ' + '${safePattern}' + ' → ' + ${status} + ' (' + window.__mcp_mocks.length + ' total mocks)';
    })()`
  );
}

// Remove all network mocks
export async function clearNetworkMocks() {
  return runJS(
    "window.__mcp_mocks=[]; 'All network mocks cleared'"
  );
}

// ========== WAIT FOR TIME ==========

export async function waitForTime({ ms }) {
  const capped = Math.min(Number(ms) || 0, 60000); // Cap at 60 seconds
  await new Promise((r) => setTimeout(r, capped));
  return capped < Number(ms) ? `Waited ${capped}ms (capped from ${ms}ms — max 60s)` : `Waited ${ms}ms`;
}

// ========== NETWORK CAPTURE (Detailed) ==========

export async function startNetworkCapture() {
  await runJS(
    `if(!window.__mcp_network){window.__mcp_network=[];
    var origFetch=window.fetch;
    window.fetch=function(){var url=arguments[0];var opts=arguments[1]||{};var start=Date.now();
      return origFetch.apply(this,arguments).then(function(resp){
        var entry={url:typeof url==='string'?url:url.url,method:opts.method||'GET',status:resp.status,statusText:resp.statusText,
          type:'fetch',duration:Date.now()-start,headers:Object.fromEntries([...resp.headers.entries()].slice(0,20)),time:new Date().toISOString()};
        window.__mcp_network.push(entry);if(window.__mcp_network.length>5000)window.__mcp_network.shift();return resp;
      }).catch(function(err){
        window.__mcp_network.push({url:typeof url==='string'?url:url.url,method:opts.method||'GET',error:err.message,type:'fetch',time:new Date().toISOString()});if(window.__mcp_network.length>5000)window.__mcp_network.shift();
        throw err;
      });
    };
    var origXHR=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url){
      this.__mcp_method=method;this.__mcp_url=url;this.__mcp_start=Date.now();
      this.addEventListener('load',function(){
        window.__mcp_network.push({url:this.__mcp_url,method:this.__mcp_method,status:this.status,statusText:this.statusText,
          type:'xhr',duration:Date.now()-this.__mcp_start,responseSize:this.responseText.length,time:new Date().toISOString()});if(window.__mcp_network.length>5000)window.__mcp_network.shift();
      });
      this.addEventListener('error',function(){
        window.__mcp_network.push({url:this.__mcp_url,method:this.__mcp_method,error:'Network error',type:'xhr',time:new Date().toISOString()});if(window.__mcp_network.length>5000)window.__mcp_network.shift();
      });
      return origXHR.apply(this,arguments);
    };}`
  );
  return "Network capture started (fetch + XHR interception)";
}

export async function clearNetworkCapture() {
  return runJS("window.__mcp_network=[]; 'Network capture cleared'");
}

export async function getNetworkDetails({ limit = 50, filter } = {}) {
  const filterStr = filter ? `.filter(function(r){return r.url.includes('${filter.replace(/'/g, "\\'")}')})` : "";
  return runJS(
    `JSON.stringify((window.__mcp_network||[])${filterStr}.slice(-${Number(limit)}))`
  );
}

// ========== PERFORMANCE METRICS ==========

export async function getPerformanceMetrics() {
  return runJS(
    `(function(){
      var nav = performance.getEntriesByType('navigation')[0] || {};
      var paint = performance.getEntriesByType('paint');
      var fcp = paint.find(function(p){return p.name==='first-contentful-paint'});
      var lcp = null;
      try {
        var entries = performance.getEntriesByType('largest-contentful-paint');
        if (entries.length) lcp = entries[entries.length - 1];
      } catch(e) {}
      var cls = 0;
      try {
        var entries = performance.getEntriesByType('layout-shift');
        entries.forEach(function(e){ if (!e.hadRecentInput) cls += e.value; });
      } catch(e) {}
      var resources = performance.getEntriesByType('resource');
      var totalTransfer = resources.reduce(function(sum, r){ return sum + (r.transferSize || 0); }, 0);
      return JSON.stringify({
        navigation: {
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          tcp: Math.round(nav.connectEnd - nav.connectStart),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          download: Math.round(nav.responseEnd - nav.responseStart),
          domInteractive: Math.round(nav.domInteractive),
          domComplete: Math.round(nav.domComplete),
          loadEvent: Math.round(nav.loadEventEnd),
        },
        webVitals: {
          fcp: fcp ? Math.round(fcp.startTime) : null,
          lcp: lcp ? Math.round(lcp.startTime) : null,
          cls: Math.round(cls * 1000) / 1000,
        },
        resources: {
          total: resources.length,
          totalTransferKB: Math.round(totalTransfer / 1024),
          byType: resources.reduce(function(acc, r) {
            var type = r.initiatorType || 'other';
            if (!acc[type]) acc[type] = { count: 0, sizeKB: 0 };
            acc[type].count++;
            acc[type].sizeKB += Math.round((r.transferSize || 0) / 1024);
            return acc;
          }, {}),
        },
        memory: window.performance.memory ? {
          usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
          totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
          limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
        } : null,
      });
    })()`
  );
}

// ========== NETWORK THROTTLING ==========

export async function throttleNetwork({ profile, latency, downloadKbps, uploadKbps }) {
  const profiles = {
    "slow-3g": { latency: 2000, download: 50, upload: 50 },
    "fast-3g": { latency: 560, download: 150, upload: 75 },
    "4g": { latency: 170, download: 400, upload: 150 },
    offline: { latency: 0, download: 0, upload: 0 },
  };
  const p = profile ? profiles[profile.toLowerCase()] : null;
  const lat = p ? p.latency : (latency || 0);
  const dl = p ? p.download : (downloadKbps || 0);

  if (profile === "offline") {
    await runJS(
      `window.__mcp_throttle={active:true,profile:'offline'};
      var origFetch=window.__mcp_origFetch||window.fetch;
      window.__mcp_origFetch=origFetch;
      window.fetch=function(){return Promise.reject(new TypeError('Network request failed (simulated offline)'));};`
    );
    return "Network throttled: offline";
  }

  if (lat > 0) {
    await runJS(
      `window.__mcp_throttle={active:true,profile:'${profile || "custom"}',latency:${lat},downloadKbps:${dl}};
      var origFetch=window.__mcp_origFetch||window.fetch;
      window.__mcp_origFetch=origFetch;
      window.fetch=function(){var args=arguments;return new Promise(function(resolve){
        setTimeout(function(){resolve(origFetch.apply(window,args));},${lat});
      });};`
    );
    return JSON.stringify({ profile: profile || "custom", latency: lat, downloadKbps: dl });
  }

  // Reset
  await runJS(
    `if(window.__mcp_origFetch){window.fetch=window.__mcp_origFetch;delete window.__mcp_origFetch;}
    delete window.__mcp_throttle; 'Throttle removed'`
  );
  return "Network throttle removed";
}

// ========== CONSOLE FILTER ==========

export async function getConsoleByLevel({ level }) {
  const safeLevel = level.replace(/'/g, "\\'");
  return runJS(
    `JSON.stringify((window.__mcp_console||[]).filter(function(m){return m.level==='${safeLevel}'}))`
  );
}

// ========== DATA EXTRACTION ==========

export async function extractTables({ selector, limit = 10 }) {
  const sel = selector ? `'${selector.replace(/'/g, "\\'")}'` : "'table'";
  return runJS(
    `(function(){
      var tables = [...document.querySelectorAll(${sel})].slice(0, ${Number(limit)});
      return JSON.stringify(tables.map(function(table, ti) {
        var headers = [...table.querySelectorAll('thead th, thead td, tr:first-child th')].map(function(th){ return th.textContent.trim(); });
        var rows = [...table.querySelectorAll('tbody tr, tr')].slice(headers.length ? 0 : 1).map(function(tr) {
          return [...tr.querySelectorAll('td, th')].map(function(td){ return td.textContent.trim().substring(0, 200); });
        });
        return { index: ti, headers: headers, rows: rows.slice(0, 100), rowCount: rows.length };
      }));
    })()`
  );
}

export async function extractMeta() {
  return runJS(
    `(function(){
      var meta = {};
      meta.title = document.title;
      meta.description = (document.querySelector('meta[name="description"]') || {}).content || '';
      meta.canonical = (document.querySelector('link[rel="canonical"]') || {}).href || '';
      meta.robots = (document.querySelector('meta[name="robots"]') || {}).content || '';
      meta.viewport = (document.querySelector('meta[name="viewport"]') || {}).content || '';
      meta.charset = (document.querySelector('meta[charset]') || {}).getAttribute('charset') || document.characterSet;
      meta.language = document.documentElement.lang || '';
      meta.og = {};
      document.querySelectorAll('meta[property^="og:"]').forEach(function(m) {
        meta.og[m.getAttribute('property').replace('og:','')] = m.content;
      });
      meta.twitter = {};
      document.querySelectorAll('meta[name^="twitter:"]').forEach(function(m) {
        meta.twitter[m.getAttribute('name').replace('twitter:','')] = m.content;
      });
      meta.jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map(function(s) {
        try { return JSON.parse(s.textContent); } catch(e) { return null; }
      }).filter(Boolean);
      meta.alternateLanguages = [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map(function(l) {
        return { lang: l.hreflang, href: l.href };
      });
      meta.feeds = [...document.querySelectorAll('link[type="application/rss+xml"], link[type="application/atom+xml"]')].map(function(l) {
        return { title: l.title, href: l.href, type: l.type };
      });
      return JSON.stringify(meta);
    })()`
  );
}

export async function extractImages({ limit = 50 }) {
  return runJS(
    `JSON.stringify([...document.querySelectorAll('img')].slice(0,${Number(limit)}).map(function(img){
      var r = img.getBoundingClientRect();
      return {
        src: img.src, alt: img.alt || '(missing)', width: img.naturalWidth, height: img.naturalHeight,
        displayWidth: Math.round(r.width), displayHeight: Math.round(r.height),
        loading: img.loading || 'eager', srcset: img.srcset || '',
        inViewport: r.top < window.innerHeight && r.bottom > 0,
        decoded: img.complete,
      };
    }))`
  );
}

export async function extractLinks({ limit = 100, filter }) {
  const filterStr = filter
    ? `.filter(function(a){return a.href.includes('${filter.replace(/'/g, "\\'")}')||a.textContent.includes('${filter.replace(/'/g, "\\'")}')})`
    : "";
  return runJS(
    `JSON.stringify([...document.querySelectorAll('a[href]')]${filterStr}.slice(0,${Number(limit)}).map(function(a){
      return {
        href: a.href, text: a.textContent.trim().substring(0,100),
        rel: a.rel || '', target: a.target || '',
        isExternal: a.hostname !== location.hostname,
        isNofollow: a.rel.includes('nofollow'),
      };
    }))`
  );
}

// ========== GEOLOCATION OVERRIDE ==========

export async function overrideGeolocation({ latitude, longitude, accuracy = 100 }) {
  return runJS(
    `navigator.geolocation.getCurrentPosition = function(success) {
      success({ coords: { latitude: ${Number(latitude)}, longitude: ${Number(longitude)}, accuracy: ${Number(accuracy)}, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
    };
    navigator.geolocation.watchPosition = function(success) {
      success({ coords: { latitude: ${Number(latitude)}, longitude: ${Number(longitude)}, accuracy: ${Number(accuracy)}, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
      return 1;
    };
    'Geolocation set to: ${Number(latitude)}, ${Number(longitude)}'`
  );
}

// ========== COMPUTED STYLES ==========

export async function getComputedStyles({ selector, properties }) {
  const sel = escJsSingleQuote(selector);
  const propsFilter = properties
    ? `.filter(function(p){return [${properties.map((p) => `'${String(p).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(",")}].includes(p)})`
    : "";
  return runJS(
    `(function(){
      var el = document.querySelector('${sel}');
      if (!el) return JSON.stringify({ error: 'Element not found' });
      var styles = window.getComputedStyle(el);
      var result = {};
      var props = [...styles]${propsFilter};
      props.forEach(function(p) { result[p] = styles.getPropertyValue(p); });
      return JSON.stringify(result);
    })()`
  );
}

// ========== INDEXEDDB ==========

export async function getIndexedDB({ dbName, storeName, limit = 20 }) {
  const safeDb = dbName.replace(/'/g, "\\'");
  const safeStore = storeName.replace(/'/g, "\\'");
  // `do JavaScript` can't await a Promise — route async work through the Node-side poller.
  return _evaluateAsync(
    `(async function(){
      return new Promise(function(resolve, reject) {
        var request = indexedDB.open('${safeDb}');
        request.onerror = function() { resolve(JSON.stringify({ error: 'Cannot open database: ${safeDb}' })); };
        request.onsuccess = function(e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('${safeStore}')) {
            resolve(JSON.stringify({ error: 'Store not found: ${safeStore}', stores: [...db.objectStoreNames] }));
            db.close(); return;
          }
          var tx = db.transaction('${safeStore}', 'readonly');
          var store = tx.objectStore('${safeStore}');
          var results = [];
          var cursor = store.openCursor();
          cursor.onsuccess = function(e) {
            var c = e.target.result;
            if (c && results.length < ${Number(limit)}) { results.push({ key: c.key, value: c.value }); c.continue(); }
            else { resolve(JSON.stringify({ database: '${safeDb}', store: '${safeStore}', count: results.length, records: results })); db.close(); }
          };
          cursor.onerror = function() { resolve(JSON.stringify({ error: 'Cursor error' })); db.close(); };
        };
      });
    })()`
  );
}

export async function listIndexedDBs() {
  return _evaluateAsync(
    `(async function(){
      try {
        var dbs = await indexedDB.databases();
        return JSON.stringify(dbs.map(function(db){ return { name: db.name, version: db.version }; }));
      } catch(e) {
        return JSON.stringify({ error: 'indexedDB.databases() not supported, try getIndexedDB with a known db name' });
      }
    })()`
  );
}

// ========== CSS COVERAGE ==========

export async function getCSSCoverage() {
  return evalReturningJSON(
    `
      ${ALL_SHEETS_FN}
      var results = [];
      var sheets = allSheets();
      for (var i = 0; i < sheets.length; i++) {
        var sheet = sheets[i];
        try {
          var rules = sheet.cssRules || sheet.rules;
          var total = rules.length;
          var used = 0;
          var unused = [];
          for (var j = 0; j < rules.length; j++) {
            var rule = rules[j];
            if (rule.selectorText) {
              try {
                if (document.querySelector(rule.selectorText)) { used++; }
                else { unused.push(rule.selectorText); }
              } catch(e) { used++; }
            } else { used++; }
          }
          results.push({
            href: sheet.href || (sheet.ownerNode ? '(inline)' : '(adopted)'),
            totalRules: total,
            usedRules: used,
            unusedRules: total - used,
            coveragePercent: total > 0 ? Math.round(used / total * 100) : 100,
            unusedSelectors: unused.slice(0, 20),
          });
        } catch(e) {
          results.push({ href: sheet.href || (sheet.ownerNode ? '(inline)' : '(adopted)'), error: 'CORS blocked' });
        }
      }
      return JSON.stringify(results);
    `
  );
}

// ========== WEBKIT / iOS WEB-DEV VALIDATION ==========

// Validate <meta name="viewport"> against iOS Safari best practices.
// Pure read-only DOM inspection — returns parsed attrs + severity-tagged issues.
export async function inspectViewport() {
  return runJS(VIEWPORT_SCRIPT);
}

// Read live CSS safe-area-inset values via a hidden probe element, check
// viewport-fit=cover, and scan stylesheets for env(safe-area-inset-*) usage.
export async function getSafeAreaInsets() {
  return runJS(SAFE_AREA_SCRIPT);
}

// Audit the page for iOS "Add to Home Screen" / PWA readiness.
export async function checkPWA() {
  return runJS(PWA_SCRIPT);
}

// Check every CSS property used on the page against THIS Safari via
// CSS.supports() — no regex guessing, tested in the live engine.
export async function checkWebKitCompat() {
  return runJS(WEBKIT_COMPAT_SCRIPT);
}

// ========== DOCTOR (PREFLIGHT DIAGNOSTICS) ==========

// One-shot check of the whole macOS permission + daemon chain, so the
// "it doesn't work even with permissions granted" failures (#14/#15/#29)
// surface as one actionable checklist instead of scattered cryptic errors.
// ========== macOS NATIVE-INPUT COMPAT ==========
// CGEvent.postToPid (native clicks/keys/hover) can silently no-op on macOS 26+ (Tahoe) even
// with Accessibility granted — the events are accepted by the API but never cross into Safari's
// WebContent process (issue #29). performNativeClick now works around this by pressing through
// the Accessibility API first, so CLICKS are covered; native keyboard and hover still travel the
// CGEvent path and stay affected. doctor() prints the OS version so a bug report carries the
// single most relevant fact, and points at what is still risky rather than at a phantom
// permission grant.
// Pure (no I/O) so it's unit-tested directly — see test/macos-compat.test.mjs.
export function macosCompatNote(productVersion) {
  const raw = String(productVersion ?? "").trim();
  const major = parseInt(raw.split(".")[0], 10);
  if (!Number.isFinite(major)) {
    return {
      version: "unknown",
      major: null,
      risky: false,
      line: "macOS version: unknown (sw_vers gave no parseable version)",
    };
  }
  const risky = major >= 26;
  const line = risky
    ? `macOS ${raw} ⚠ raw CGEvent input is filtered on macOS 26+ (issue #29) — clicks are covered: safari_native_click presses via Accessibility first. Native keyboard/hover still ride CGEvent, so prefer safari_evaluate or safari_click for those on trust-gated forms.`
    : `macOS ${raw} — CGEvent native input supported.`;
  return { version: raw, major, risky, line };
}

export async function doctor() {
  const checks = [];
  const add = (ok, label, detail, fix) => checks.push({ ok, label, detail, fix: ok ? null : fix });

  // 1. Safari running
  let safariUp = false;
  try {
    const { stdout } = await execFileAsync("pgrep", ["-x", "Safari"], { timeout: 2000 });
    safariUp = stdout.trim().length > 0;
  } catch { safariUp = false; }
  add(safariUp, "Safari running", safariUp ? "Safari process is up" : "Safari is not running", "Open Safari, then retry.");

  // 2. Apple Events / Automation — the bridge every AppleScript tool uses
  let aeOk = false, aeDetail = "";
  try {
    const out = await osascript(`tell application "Safari" to return (count of windows) as string`, { timeout: 5000 });
    aeOk = /^\d+$/.test(String(out).trim());
    aeDetail = aeOk ? `OK (${String(out).trim()} window(s) visible)` : `unexpected reply: ${String(out).slice(0, 60)}`;
  } catch (e) {
    const m = e.message || "";
    if (m.includes("-1743") || /not authoriz/i.test(m)) aeDetail = "Automation permission denied (-1743)";
    else if (m.includes("-600") || /isn.t running/i.test(m)) aeDetail = "Safari not running";
    else aeDetail = m.slice(0, 80);
  }
  add(aeOk, "Apple Events / Automation", aeDetail,
    "System Settings > Privacy & Security > Automation → enable Safari for your terminal/host app; and Safari > Settings > Developer > Allow JavaScript from Apple Events.");

  // 3-5. Native helper daemon + Accessibility + Screen Recording (one preflight round-trip)
  let pf = null, pfErr = "";
  try { pf = await _helperPreflight(); } catch (e) { pfErr = e.message || String(e); }
  // A single 3s probe is a load test, not a health test: under heavy system pressure (swap
  // thrash, a dozen concurrent hosts) the helper answers late and doctor turns one slow reply
  // into THREE hard failures telling the user to reinstall and re-grant permissions that were
  // never revoked. Retry once with a wider window before believing the daemon is down.
  if (!pf) {
    try { pf = await _helperPreflight(8000); pfErr = ""; } catch (e) { pfErr = e.message || String(e); }
  }
  add(!!pf, "Native helper daemon", pf ? "safari-helper responding" : `not responding: ${pfErr}`,
    "It auto-restarts; if this persists, reinstall safari-mcp.");
  add(!!pf && pf.accessibility === true, "Accessibility (native clicks)",
    pf ? (pf.accessibility ? "CGEvent posting permitted" : "NOT permitted — native clicks silently no-op (the #29 root cause)") : "unknown (helper not responding)",
    "System Settings > Privacy & Security > Accessibility (named \"Device Control and Data Access\" on macOS 27) → enable safari-helper, then retry.");
  // macOS attributes the capture to whoever launched this process: the terminal/IDE for a
  // stdio server, but node itself under launchd (a LaunchAgent daemon has ppid 1) — and a
  // Homebrew node upgrade changes that path, so the grant has to follow the new binary.
  add(!!pf && pf.screenRecording === true, "Screen Recording (screenshots)",
    pf ? (pf.screenRecording ? "permitted" : "NOT permitted — screenshots taken through AppleScript and safari_save_pdf fail (extension screenshots don't need it)") : "unknown (helper not responding)",
    `System Settings > Privacy & Security > Screen & System Audio Recording → enable ${process.ppid === 1 ? `node at ${process.execPath} (this server runs under launchd)` : "the terminal/IDE that launched this server"}.`);

  // 6. Helper codesign identity — a stale/ad-hoc id breaks the Accessibility grant on reinstall
  let idOk = false, idDetail = "";
  const helperPath = join(__dirname, "safari-helper");
  try {
    const res = await execFileAsync("codesign", ["-d", "--verbose=2", helperPath], { timeout: 4000 })
      .catch((e) => ({ stdout: "", stderr: e.stderr || "" }));
    const text = (res.stdout || "") + (res.stderr || "");
    const m = /Identifier=(.+)/.exec(text);
    const id = m ? m[1].trim() : "(unknown)";
    idOk = id === "com.achiya-automation.safari-mcp";
    idDetail = idOk ? `stable identifier: ${id}` : `unstable identifier "${id}" — Accessibility grant won't persist across reinstalls`;
  } catch (e) { idDetail = "could not read codesign identity: " + (e.message || "").slice(0, 60); }
  add(idOk, "Helper codesign identity", idDetail,
    `Re-sign: codesign -s - -f --identifier com.achiya-automation.safari-mcp --entitlements safari-helper.entitlements "${helperPath}"`);

  // macOS version — the single most relevant fact for #29-class "native clicks silently fail"
  // reports. Best-effort: sw_vers is macOS-only and absent in sandboxes/CI, so never block doctor.
  let osLine = null;
  try {
    const { stdout } = await execFileAsync("sw_vers", ["-productVersion"], { timeout: 2000 });
    osLine = macosCompatNote(stdout).line;
  } catch { /* sw_vers unavailable — skip the line, the permission checks still stand */ }

  const passed = checks.filter((c) => c.ok).length;
  const lines = [`Safari MCP doctor — ${passed}/${checks.length} checks passed`, ""];
  if (osLine) lines.push(osLine, "");
  // Not a pass/fail check — a state the user has to be able to see here rather than dig out
  // of the host's env, so "why did it touch my tab" has an answer in the same report (#92).
  lines.push(
    allowUserTabs()
      ? "ℹ️ Tab adoption (SAFARI_MCP_ALLOW_USER_TABS): ON — safari_switch_tab may adopt a tab you already had open. safari_close_tab still refuses an adopted tab."
      : "ℹ️ Tab adoption (SAFARI_MCP_ALLOW_USER_TABS): off (default) — the session acts only on tabs it opened itself.",
    "",
  );
  for (const c of checks) {
    lines.push(`${c.ok ? "✅" : "❌"} ${c.label}: ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`   → ${c.fix}`);
  }
  return lines.join("\n");
}

// ========== FORM AUTO-DETECT ==========

export async function detectForms() {
  return runJS(
    `(function(){
      var forms = [...document.querySelectorAll('form')];
      if (forms.length === 0) {
        var inputs = document.querySelectorAll('input, textarea, select');
        if (inputs.length > 0) {
          return JSON.stringify([{
            index: 0, action: '(no form tag)', method: '', fields: [...inputs].slice(0, 30).map(function(el) {
              return { tag: el.tagName, type: el.type || '', name: el.name || '', id: el.id || '',
                placeholder: el.placeholder || '', required: el.required, value: (el.value || '').substring(0, 50),
                selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName.toLowerCase() + '[type="' + el.type + '"]') };
            })
          }]);
        }
        return JSON.stringify([]);
      }
      return JSON.stringify(forms.map(function(form, i) {
        var fields = [...form.querySelectorAll('input, textarea, select')].map(function(el) {
          return { tag: el.tagName, type: el.type || '', name: el.name || '', id: el.id || '',
            placeholder: el.placeholder || '', required: el.required, value: (el.value || '').substring(0, 50),
            selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName.toLowerCase()) };
        });
        return { index: i, action: form.action || '', method: form.method || 'GET', id: form.id || '',
          fieldCount: fields.length, fields: fields.slice(0, 30),
          hasSubmit: !!form.querySelector('[type="submit"], button:not([type])') };
      }));
    })()`
  );
}

// ========== SCROLL TO ELEMENT ==========

export async function scrollToElement({ selector, text, block = "center", timeout = 10000 }) {
  if (selector) {
    const sel = escJsSingleQuote(selector);
    return runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found: ${sel}';el.scrollIntoView({behavior:'smooth',block:'${block}'});var r=el.getBoundingClientRect();return 'Scrolled to: '+el.tagName+' at y='+Math.round(r.y);})()`
    );
  }
  if (text) {
    // Virtual DOM scroll: scroll down repeatedly until text appears (for Airtable, etc.).
    // Each check+scroll is one synchronous step; the loop is driven from Node because
    // `do JavaScript` can't await an in-page delay (see _evaluateAsync).
    const safeText = escJsSingleQuote(text);
    const safeBlock = String(block).replace(/[^a-z]/gi, '') || 'center';
    const tab = await _sessionTab('scrollToElement');
    const stepJs =
      `(function(){` +
      `var scrollable=document.querySelector('[class*="grid"],[class*="virtual"],[class*="scroll"],[role="grid"],[role="table"]')||document.scrollingElement||document.documentElement;` +
      `var tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);` +
      `while(tw.nextNode()){if(tw.currentNode.textContent.trim().includes('${safeText}')){var el=tw.currentNode.parentElement;el.scrollIntoView({behavior:'smooth',block:'${safeBlock}'});return 'Found and scrolled to: "'+el.textContent.trim().substring(0,50)+'"';}}` +
      `var curY=scrollable.scrollTop;scrollable.scrollBy(0,500);return 'SCROLL:'+curY;})()`;
    const deadline = Date.now() + Number(timeout);
    let lastY = -1;
    while (Date.now() < deadline) {
      // Each step scrolls in the page only once that page proves it is the session's (_inTab).
      const r = await _inTab(tab, stepJs, { markerOnly: true, timeout: 5000 }).catch((err) => {
        if (err.tabUnproven) throw err;
        return '';
      });
      if (typeof r === 'string' && r.startsWith('Found')) return r;
      if (typeof r === 'string' && r.startsWith('SCROLL:')) {
        const curY = parseInt(r.slice(7), 10);
        if (curY === lastY) return `Text not found: ${text} (scrolled to bottom)`;
        lastY = curY;
      }
      await new Promise(res => setTimeout(res, 300));
    }
    return `Timeout: text not found within ${timeout}ms`;
  }
  throw new Error("scrollToElement requires selector or text");
}

// ========== COMBO TOOLS (multi-step operations in a single call) ==========

// Navigate + wait + read — the most common 3-step workflow
export async function navigateAndRead(url, { maxLength = 50000 } = {}) {
  await raiseWindowForShow();
  await refreshTargetWindow();
  // Prove the tab once, and have every script prove it again before it touches it (see navigate()).
  const tab = await _sessionTab('navigateAndRead');
  // Suppress onbeforeunload dialogs (same as navigate())
  await _inTab(tab, "window.onbeforeunload=null", { markerOnly: true, timeout: 2000 }).catch(() => {});
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;
  // Escape backslash first, then quotes; strip CR/LF — a newline would break out of
  // the AppleScript string literal and allow AppleScript injection.
  const safeUrl = targetUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
  tab.since = Date.now();
  await _inTab(tab, "''", { markerOnly: true, then: (target) => `set URL of ${target} to "${safeUrl}"`, timeout: 10000 });
  _st().activeTabURL = targetUrl;
  // Poll readyState from Node, then read — `do JavaScript` can't await an async IIFE.
  const navResult = await _pollReadyAndRead(tab, { maxLength });
  // Update _st().activeTabURL with the actual URL after navigation
  try {
    const parsed = JSON.parse(navResult);
    if (parsed.url && parsed.url !== 'about:blank') _st().activeTabURL = parsed.url;
  } catch {}
  return navResult;
}

// Click + wait for navigation or element — common after clicking a link/button
export async function clickAndWait({ selector, text, waitFor: waitSelector, timeout = 10000 }) {
  const esc = (s) => escJsSingleQuote(s);
  const safeSel = selector ? esc(selector) : "";
  const safeText = text ? esc(text) : "";
  const safeWait = waitSelector ? esc(waitSelector) : "";
  const tab = await _sessionTab('clickAndWait');
  // Step 1: find + click — fully synchronous, so it runs inside one `do JavaScript`, which runs it
  // only in a page that still carries the session's marker (_inTab).
  tab.since = Date.now();
  const clickResult = await _inTab(
    tab,
    `(function(){
      var el;
      ${safeSel ? `el = document.querySelector('${safeSel}');` : ""}
      ${safeText && !safeSel ? `
        el = [...document.querySelectorAll('a,button,[role=button],label,[onclick]')].find(function(e){return e.textContent.trim().includes('${safeText}');});
        if(!el) el = [...document.querySelectorAll('*')].filter(function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.textContent.trim().includes('${safeText}');}).sort(function(a,b){return a.textContent.length-b.textContent.length;})[0];
      ` : ""}
      if(!el) return JSON.stringify({error:'Element not found'});
      el.scrollIntoView({block:'center'});
      el.click();
      return JSON.stringify({clicked:el.tagName+' "'+el.textContent.trim().substring(0,50)+'"'});
    })()`,
    { markerOnly: true, timeout: 10000 }
  );
  let clickedInfo = '';
  try { const c = JSON.parse(clickResult); if (c.error) return clickResult; clickedInfo = c.clicked || ''; } catch {}
  // Step 2: wait from Node — `do JavaScript` can't await an in-page loop.
  const deadline = Date.now() + Number(timeout);
  await new Promise(r => setTimeout(r, 300));
  while (Date.now() < deadline) {
    try {
      if (safeWait) {
        if (await _inTab(tab, `document.querySelector('${safeWait}')?'1':''`, { stamp: true, timeout: 5000 }) === '1') break;
      } else if (await _inTab(tab, 'document.readyState', { stamp: true, timeout: 5000 }) === 'complete') {
        break;
      }
    } catch (err) {
      if (err.tabUnproven) throw err;
      /* page navigating */
    }
    await new Promise(r => setTimeout(r, 200));
  }
  const final = await _inTab(tab, `JSON.stringify({title:document.title,url:location.href})`, { stamp: true, timeout: 5000 });
  try { const p = JSON.parse(final); p.clicked = clickedInfo; return JSON.stringify(p); } catch { return final; }
}

// Fill form + submit — common for login, search, etc.
export async function fillAndSubmit({ fields, submitSelector }) {
  // A load the form's own change or blur events start is the step's own load too.
  const since = Date.now();
  await fillForm({ fields });
  const tab = await _sessionTab('fillAndSubmit');
  // The submit click runs in the tab the polls below watch, in a page that still carries the
  // session's marker (_inTab). A click that proved its tab by a scan of its own could submit in the
  // tab at one index while the polls read the tab at another.
  tab.since = since;
  if (submitSelector) {
    const sel = escJsSingleQuote(submitSelector);
    await _inTab(tab,
      `(function(){var el=document.querySelector('${sel}');if(el)el.click();})()`,
      { markerOnly: true, timeout: 15000 }
    );
  } else {
    // Auto-find and click submit button
    await _inTab(tab,
      `(function(){var btn=document.querySelector('[type=submit],button:not([type])');if(btn)btn.click();})()`,
      { markerOnly: true, timeout: 15000 }
    );
  }
  // Wait for navigation/reload — polled from Node (`do JavaScript` can't await).
  await new Promise(r => setTimeout(r, 300));
  return _pollReadyAndRead(tab);
}

// Full page analysis — extracts everything in ONE call
export async function analyzePage() {
  return runJS(
    `(function(){
      var result = {};
      result.title = document.title;
      result.url = location.href;
      result.meta = {};
      result.meta.description = (document.querySelector('meta[name="description"]')||{}).content||'';
      result.meta.canonical = (document.querySelector('link[rel="canonical"]')||{}).href||'';
      result.meta.robots = (document.querySelector('meta[name="robots"]')||{}).content||'';
      result.meta.og = {};
      document.querySelectorAll('meta[property^="og:"]').forEach(function(m){result.meta.og[m.getAttribute('property').replace('og:','')]=m.content;});
      result.headings = {};
      for(var i=1;i<=3;i++){result.headings['h'+i]=[...document.querySelectorAll('h'+i)].map(function(h){return h.textContent.trim().substring(0,100);});}
      result.links = {internal:0,external:0,nofollow:0};
      document.querySelectorAll('a[href]').forEach(function(a){
        if(a.hostname===location.hostname)result.links.internal++;
        else result.links.external++;
        if(a.rel&&a.rel.includes('nofollow'))result.links.nofollow++;
      });
      result.images = {total:document.querySelectorAll('img').length,withoutAlt:[...document.querySelectorAll('img:not([alt]),img[alt=""]')].length};
      result.forms = document.querySelectorAll('form').length;
      result.text = document.body.innerText.substring(0,5000);
      return JSON.stringify(result);
    })()`
  );
}

// ========== GRACEFUL SHUTDOWN ==========
// NOTE: Signal handlers are registered at the top of the file (cleanupHelper + process.exit).
// _drainHelperQueue is called from cleanupHelper via process.on("exit").
process.on("exit", () => { _drainHelperQueue("shutting down"); });
