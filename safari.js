// Safari automation layer — dual engine:
// 1. Extension (WebSocket) — fastest (~5ms), native browser API, keeps logins
// 2. AppleScript + Swift daemon (~5ms) — keeps logins, always available
// Extension is preferred. AppleScript is fallback when extension is not connected.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, dirname, resolve as resolvePath } from "node:path";
import { readFile, writeFile, unlink, appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Extension bridge is handled by index.js (WebSocket server on port 9223)

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ========== SWIFT HELPER DAEMON ==========
// Persistent process — no subprocess spawn overhead (~5ms vs ~90ms)
let _helperProc = null;
const _helperQueue = []; // callbacks waiting for responses
let _helperConsecutiveTimeouts = 0; // Track consecutive timeouts — only kill after 3

// Reject all pending callbacks when helper crashes
function _drainHelperQueue(reason) {
  while (_helperQueue.length > 0) {
    const cb = _helperQueue.shift();
    if (cb) cb(JSON.stringify({ error: reason }));
  }
}

function startHelper() {
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
        const cb = _helperQueue.shift();
        if (cb) cb(line);
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

// ========== CLIPBOARD LOCK ==========
// Prevents concurrent clipboard operations from clobbering the user's clipboard.
// While locked, any new clipboard operation waits until the current one completes.
let _clipboardLocked = false;
let _clipboardRestoreTimer = null;

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

// Restore clipboard immediately (no async setTimeout leak)
async function _restoreClipboard(savedContent) {
  if (savedContent === null) return;
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      proc.stdin.write(savedContent);
      proc.stdin.end();
      proc.on("close", resolve);
      proc.on("error", reject);
    });
  } catch {}
}

// ========== ACTIVE TAB TRACKING ==========
// Instead of visually switching tabs (which interrupts the user),
// we track which tab we're "working on" by URL (not index, because indices shift
// when the user opens/closes tabs). Before each operation we resolve the URL
// to the current index.
let _activeTabIndex = null; // null = use front document (default)
let _activeTabURL = null;   // URL-based tracking (stable even when tabs shift)
let _lastResolveTime = 0;   // Cache: skip resolve if verified recently
let _lastTabCount = null;   // Track tab count for smart cache invalidation
const RESOLVE_CACHE_MS = 500; // Brief cache — invalidated on tab count change

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

async function refreshTargetWindow(force = false) {
  if (!SAFARI_PROFILE) return;
  const now = Date.now();
  if (!force && _targetWindowRef && (now - _targetWindowCacheTime) < TARGET_WINDOW_CACHE_MS) return;
  const safeProfile = SAFARI_PROFILE.replace(/"/g, '\\"');
  // Find profile window by name AND verify the window ID still matches
  const result = await osascriptFast(
    `tell application "Safari"\n  repeat with w in every window\n    if name of w starts with "${safeProfile} \u2014" then return (id of w as text) & "|" & name of w\n  end repeat\n  return "0|"\nend tell`
  ).catch(() => '0|');
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
  } else {
    // Profile window not found — clear ref so getTargetWindowRef() will throw
    _targetWindowRef = null;
    _targetWindowId = null;
    _targetWindowCacheTime = 0;
    _profileWindowMissing = true;
    _logProfile(`WARNING: Profile "${SAFARI_PROFILE}" window not found — refusing to use front window`);
  }
}

// Background verification: periodically check that cached window ID still belongs to profile
if (SAFARI_PROFILE) {
  setInterval(async () => {
    if (!_targetWindowRef || !_targetWindowId) return;
    try {
      const name = await osascriptFast(
        `tell application "Safari" to return name of ${_targetWindowRef}`
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
  }, 3000); // Check every 3 seconds
}

// Initialize profile window at startup (ES module top-level await)
if (SAFARI_PROFILE) {
  await new Promise(r => setTimeout(r, 50)); // Let helper process initialize
  await refreshTargetWindow(true);
  if (_targetWindowRef) {
    _logProfile(`Startup: Profile "${SAFARI_PROFILE}" → targeting ${_targetWindowRef}`);
  } else {
    _logProfile(`WARNING: Profile "${SAFARI_PROFILE}" window NOT found at startup`);
  }
}

// Detect stale window ID errors and invalidate cache
function isStaleWindowError(err) {
  const msg = (err && (err.message || err.stderr || String(err))) || '';
  return /window id \d+/.test(msg) && /(-1728|-10006)/.test(msg);
}

// Safe fallback target: when no tab index is known, use the profile window's current tab
// instead of "front document" which can target the user's personal profile window
function getFallbackTarget() {
  return SAFARI_PROFILE ? `current tab of ${getTargetWindowRef()}` : "front document";
}

// Quick JS execution — exposed for smart-wait checks in index.js
export async function runJSQuick(js) { return runJS(js); }

export function getActiveTabIndex() { return _activeTabIndex; }
export function setActiveTabIndex(idx) { _activeTabIndex = idx; }
export function getActiveTabURL() { return _activeTabURL; }
export function setActiveTabURL(url) { _activeTabURL = url; _lastResolveTime = Date.now(); }

// Resolve our tracked URL to current tab index — single combined osascript call
async function resolveActiveTab() {
  if (!_activeTabURL) return _activeTabIndex;
  try {
    const safeUrl = _activeTabURL.replace(/"/g, '\\"');
    const domain = _activeTabURL.replace(/^https?:\/\//, '').split('/')[0].replace(/"/g, '\\"');
    // Single AppleScript call: verify current index, then search by URL, then by domain
    // Also returns tabCount so we can clamp stale indices
    const result = await osascriptFast(
      `tell application "Safari"
        set w to ${getTargetWindowRef()}
        set tabCount to count of tabs of w
        ${_activeTabIndex ? `try
          if tabCount >= ${_activeTabIndex} then
            if URL of tab ${_activeTabIndex} of w starts with "${safeUrl}" then return ${_activeTabIndex}
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
      // Not found — clamp stale index to tabCount
      const tabCount = Number(resultStr.split(':')[1]) || 1;
      _lastTabCount = tabCount;
      _activeTabURL = null;
      if (_activeTabIndex && _activeTabIndex > tabCount) {
        console.error(`[Safari MCP] Tab ghost proactive fix: index ${_activeTabIndex} > tabCount ${tabCount}, clamping to ${tabCount}`);
        _activeTabIndex = tabCount;
      }
      return _activeTabIndex;
    }
    const num = Number(result);
    if (num > 0) {
      _activeTabIndex = num;
      return num;
    }
    if (num < 0) {
      // Domain match (negative = partial match)
      _activeTabIndex = -num;
      return -num;
    }
    _activeTabURL = null;
    return _activeTabIndex;
  } catch {
    return _activeTabIndex;
  }
}

// ========== FAST OSASCRIPT VIA TEMP FILE ==========
// osascript -i persistent process doesn't work reliably with pipes.
// Instead, we use execFile for every call (~80ms each).
// Optimization: for runJS we write to temp file and execute (avoids arg escaping).

// Run AppleScript — uses execFile (safe, isolated, for complex scripts)
async function osascript(script, { timeout = 10000 } = {}) {
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
  }
}

// osascriptFast: uses persistent Swift daemon (~5ms) — 18x faster than subprocess (~90ms)
async function osascriptFast(script, { timeout = 10000 } = {}) {
  if (!_helperProc) startHelper();
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
  return osascript(script, { timeout });
}

function _osascriptFastHelper(script, timeout) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const idx = _helperQueue.indexOf(cb);
      if (idx >= 0) _helperQueue.splice(idx, 1);
      _helperConsecutiveTimeouts++;
      // Only kill the daemon after 3 consecutive timeouts (single slow script shouldn't kill concurrent ops)
      if (_helperConsecutiveTimeouts >= 3) {
        console.error(`[Safari MCP] safari-helper: ${_helperConsecutiveTimeouts} consecutive timeouts — killing daemon`);
        _helperProc?.kill();
        _helperProc = null;
        _helperConsecutiveTimeouts = 0;
        setTimeout(startHelper, 100);
      }
      reject(new Error("safari-helper timeout"));
    }, timeout);

    function cb(line) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      _helperConsecutiveTimeouts = 0; // Reset on success
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed.result ?? "");
      } catch {
        resolve(line);
      }
    }

    // Check process availability BEFORE pushing to queue (prevents dangling callbacks)
    if (!_helperProc || !_helperProc.stdin || !_helperProc.stdin.writable) {
      clearTimeout(timer);
      reject(new Error("safari-helper not available"));
      return;
    }
    _helperQueue.push(cb);
    try {
      _helperProc.stdin.write(JSON.stringify({ script }) + "\n");
    } catch (writeErr) {
      const idx = _helperQueue.indexOf(cb);
      if (idx >= 0) _helperQueue.splice(idx, 1);
      clearTimeout(timer);
      reject(new Error("safari-helper write failed: " + writeErr.message));
    }
  });
}

// ========== NATIVE CLICK VIA CGEVENT ==========
// Sends a CGEvent click command to the Swift helper daemon.
// This produces isTrusted: true events — bypasses WAF protection (G2, etc.)

function _helperNativeClick(x, y, doubleClick = false, windowId = 0, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (!_helperProc) startHelper();
    if (!_helperProc || !_helperProc.stdin || !_helperProc.stdin.writable) {
      reject(new Error("safari-helper not available for native click"));
      return;
    }
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const idx = _helperQueue.indexOf(cb);
      if (idx >= 0) _helperQueue.splice(idx, 1);
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
    _helperProc.stdin.write(JSON.stringify(cmd) + "\n");
  });
}

// Sends a CGEvent keyboard command to the Swift helper daemon.
// No focus stealing — sends key events directly to the target window via PID.
function _helperNativeKeyboard(keyCode, flags = [], windowId = 0, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (!_helperProc) startHelper();
    if (!_helperProc || !_helperProc.stdin || !_helperProc.stdin.writable) {
      reject(new Error("safari-helper not available for native keyboard"));
      return;
    }
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const idx = _helperQueue.indexOf(cb);
      if (idx >= 0) _helperQueue.splice(idx, 1);
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
    _helperProc.stdin.write(JSON.stringify(cmd) + "\n");
  });
}

// Get Safari window bounds, toolbar height, and window ID for coordinate calculation
async function _getSafariWindowGeometry() {
  await refreshTargetWindow();
  const windowRef = getTargetWindowRef();
  // Get window bounds + window ID — always use direct osascript (daemon returns empty for this)
  const boundsResult = await osascript(
    `tell application "Safari"\n  set b to bounds of ${windowRef}\n  set wid to id of ${windowRef}\n  return (item 1 of b as text) & "," & (item 2 of b as text) & "," & (item 3 of b as text) & "," & (item 4 of b as text) & "," & (wid as text)\nend tell`
  );
  // boundsResult = "x1, y1, x2, y2, windowId"
  const parts = boundsResult.split(",").map(s => Number(s.trim()));
  if (parts.length !== 5 || parts.some(isNaN)) {
    throw new Error("Failed to parse Safari window geometry: " + boundsResult);
  }
  return {
    windowX: parts[0],
    windowY: parts[1],
    windowRight: parts[2],
    windowBottom: parts[3],
    // Safari toolbar height: standard is ~74px (address bar + tab bar).
    // This is approximate — varies with compact tabs, bookmarks bar, etc.
    toolbarHeight: 74,
    // CGWindow ID for background click targeting (no mouse move, no focus steal)
    windowId: parts[4]
  };
}

// Run JavaScript in Safari — fastest path, no focus stealing
// Uses osascriptFast (persistent process, ~5ms) for short scripts,
// falls back to osascript (~80ms) for long scripts that exceed stdin limits
async function runJS(js, { tabIndex, timeout = 15000 } = {}) {
  await refreshTargetWindow();
  const escaped = js
    .replace(/^\s*\/\/[^\n]*$/gm, '')  // Strip // comment-only lines before flattening
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/\t/g, " ");
  // Resolve tab: explicit tabIndex > cached index > URL-tracked tab > front document
  let idx = tabIndex;
  if (!idx && _activeTabIndex && _activeTabURL && (Date.now() - _lastResolveTime < RESOLVE_CACHE_MS)) {
    // Recently verified and tab count unchanged — use cached index
    idx = _activeTabIndex;
  } else if (!idx && _activeTabURL && _activeTabURL !== '') {
    // Resolve by URL — verify index is still correct
    const resolved = await resolveActiveTab();
    if (resolved) { idx = resolved; _lastResolveTime = Date.now(); }
  }
  // ALWAYS fall back to _activeTabIndex — never clear it from resolve failures
  if (!idx) idx = _activeTabIndex;
  const target = idx
    ? `tab ${idx} of ${getTargetWindowRef()}`
    : getFallbackTarget();
  const script = `tell application "Safari" to do JavaScript "${escaped}" in ${target}`;
  try {
    if (script.length < 50000) {
      return await osascriptFast(script, { timeout });
    }
    return await osascript(script, { timeout });
  } catch (err) {
    // Tab ghost recovery: "Can't get tab X" → re-resolve and retry once
    const msg = err.message || '';
    if (idx && (msg.includes("Can't get tab") || msg.includes("-1728"))) {
      console.error(`[Safari MCP] Tab ghost detected (tab ${idx}), re-resolving...`);
      _lastResolveTime = 0; // Force re-resolve
      _lastTabCount = null;  // Invalidate tab count cache
      _activeTabIndex = null;
      if (_activeTabURL) {
        const newIdx = await resolveActiveTab();
        if (newIdx && newIdx !== idx) {
          console.error(`[Safari MCP] Tab ghost resolved: ${idx} → ${newIdx}`);
          const newTarget = `tab ${newIdx} of ${getTargetWindowRef()}`;
          const retryScript = `tell application "Safari" to do JavaScript "${escaped}" in ${newTarget}`;
          if (retryScript.length < 50000) return osascriptFast(retryScript, { timeout });
          return osascript(retryScript, { timeout });
        }
      }
      // If still can't resolve, try current tab of the window
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
async function runJSLarge(js, { tabIndex, timeout = 30000 } = {}) {
  await refreshTargetWindow();
  // Resolve tab the same way runJS does — verify cached index via URL
  let idx = tabIndex;
  if (!idx && _activeTabURL && _activeTabURL !== 'about:blank' && _activeTabURL !== '') {
    const resolved = await resolveActiveTab();
    if (resolved) { idx = resolved; _lastResolveTime = Date.now(); }
  }
  if (!idx) idx = _activeTabIndex;
  const target = idx
    ? `tab ${idx} of ${getTargetWindowRef()}`
    : getFallbackTarget();
  // Write AppleScript to temp file — the JS is embedded inside the AppleScript
  const escaped = js
    .replace(/^\s*\/\/[^\n]*$/gm, '')  // Strip // comment-only lines before flattening
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .replace(/\t/g, " ");
  const appleScript = `tell application "Safari" to do JavaScript "${escaped}" in ${target}`;
  const tmpFile = join(tmpdir(), `safari-mcp-${Date.now()}.scpt`);
  await writeFile(tmpFile, appleScript, "utf8");
  try {
    const { stdout } = await execFileAsync("osascript", [tmpFile], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } finally {
    unlink(tmpFile).catch(() => {});
  }
}

// ========== NAVIGATION ==========

export async function navigate(url) {
  await refreshTargetWindow();
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl;
  }

  const safeUrl = targetUrl.replace(/"/g, '\\"');
    // Resolve tab by URL first (in case indices shifted)
    if (_activeTabURL) await resolveActiveTab();
    const navTarget = _activeTabIndex
      ? `tab ${_activeTabIndex} of ${getTargetWindowRef()}`
      : getFallbackTarget();
    // Step 0: Suppress onbeforeunload dialogs (prevents blocking navigation)
    await runJS("window.onbeforeunload=null", { timeout: 2000 }).catch(() => {});

    // Step 1: Set URL via fast daemon (~5ms) — don't block daemon with polling
    await osascriptFast(
      `tell application "Safari" to set URL of ${navTarget} to "${safeUrl}"`,
      { timeout: 10000 }
    );

    // Step 2: Poll readyState synchronously from Node.js side
    // (AppleScript do JavaScript doesn't await async Promises — returns immediately)
    let result = '{}';
    for (let poll = 0; poll < 80; poll++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const state = await runJS('document.readyState', { timeout: 5000 });
        if (state === 'complete' || state === 'interactive') {
          result = await runJS(
            `JSON.stringify({title:document.title,url:location.href,blocked:document.title.includes('cannot open')||document.title.includes('אין אפשרות')})`,
            { timeout: 5000 }
          );
          if (state === 'complete') break;
          // interactive = DOM ready but resources still loading — wait a bit more
          if (poll > 10) break; // Don't wait forever for 'complete' if interactive after 2s
        }
      } catch { /* page still loading, retry */ }
    }

    // Inject click helpers in background (non-blocking, for subsequent clicks)
    _injectHelpersfast().catch(() => {});

    // If HTTPS failed and original was HTTP, try original HTTP URL
    try {
      const parsed = JSON.parse(result);
      if (parsed.blocked && url.startsWith("http://")) {
        const httpUrl = url.replace(/"/g, '\\"');
        const navTarget = _activeTabIndex
          ? `tab ${_activeTabIndex} of ${getTargetWindowRef()}`
          : `current tab of ${getTargetWindowRef()}`;
        await osascriptFast(
          `tell application "Safari" to set URL of ${navTarget} to "${httpUrl}"`
        );
        // Poll readyState for HTTP retry (same sync approach)
        let retryResult = '{}';
        for (let rp = 0; rp < 40; rp++) {
          await new Promise(r => setTimeout(r, 300));
          try {
            const rs = await runJS('document.readyState', { timeout: 5000 });
            if (rs === 'complete' || rs === 'interactive') {
              retryResult = await runJS('JSON.stringify({title:document.title,url:location.href})', { timeout: 5000 });
              if (rs === 'complete') break;
              if (rp > 8) break;
            }
          } catch { /* retry */ }
        }
        const retry = retryResult;
        // Update URL tracking with actual URL after HTTP retry
        try {
          const retryParsed = JSON.parse(retry);
          if (retryParsed.url) _activeTabURL = retryParsed.url;
        } catch {}
        _lastResolveTime = Date.now();
        return retry;
      }
    } catch (_) {}

    // Update URL tracking after navigation (non-blocked path)
    try {
      const parsed = JSON.parse(result);
      _activeTabURL = parsed.url || targetUrl;
    } catch {
      _activeTabURL = targetUrl;
    }
    _lastResolveTime = Date.now();

    return result;
}

export async function goBack() {
  // Navigate back + smart wait: check immediately, then poll only if loading
  const result = await runJS(
    `(async function(){history.back();await new Promise(function(r){setTimeout(r,50)});if(document.readyState!=='complete'){for(var i=0;i<30;i++){await new Promise(function(r){setTimeout(r,150)});if(document.readyState==='complete')break;}}return JSON.stringify({title:document.title,url:location.href});})()`,
    { timeout: 10000 }
  );
  try { const p = JSON.parse(result); if (p.url) _activeTabURL = p.url; } catch {}
  return result;
}

export async function goForward() {
  const result = await runJS(
    `(async function(){history.forward();await new Promise(function(r){setTimeout(r,50)});if(document.readyState!=='complete'){for(var i=0;i<30;i++){await new Promise(function(r){setTimeout(r,150)});if(document.readyState==='complete')break;}}return JSON.stringify({title:document.title,url:location.href});})()`,
    { timeout: 10000 }
  );
  try { const p = JSON.parse(result); if (p.url) _activeTabURL = p.url; } catch {}
  return result;
}

export async function reload(hardReload = false) {
  // Reload destroys JS context — must wait separately then re-query
  await runJS(hardReload ? "location.reload(true)" : "location.reload()");
  await new Promise((r) => setTimeout(r, 100)); // Brief wait for reload to start (was 500ms)
  // Poll readyState in a single call
  const result = await runJS(
    `(async function(){for(var i=0;i<30;i++){if(document.readyState==='complete')break;await new Promise(function(r){setTimeout(r,200)});}return JSON.stringify({title:document.title,url:location.href});})()`,
    { timeout: 10000 }
  );
  try { const p = JSON.parse(result); if (p.url) _activeTabURL = p.url; } catch {}
  return result;
}

// ========== PAGE INFO ==========

export async function readPage({ selector, maxLength = 50000 } = {}) {
  if (selector) {
    const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return runJS(
      `(function(){
        var el = document.querySelector('${sel}');
        if (!el) return 'Element not found: ${sel}';
        if (el.value !== undefined && el.value !== '') return el.value.substring(0,${Number(maxLength)});
        return (el.innerText || el.textContent || '').substring(0,${Number(maxLength)});
      })()`
    );
  }
  return runJS(
    `JSON.stringify({title:document.title,url:location.href,text:document.body.innerText.substring(0,${Number(maxLength)})})`
  );
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
  let idx = _activeTabIndex;
  const target = idx
    ? `tab ${idx} of ${getTargetWindowRef()}`
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
  if (_activeTabURL && _helpersInjectedForUrl === _activeTabURL && (now - _helpersInjectedAt) < HELPERS_CACHE_MS) return;

  // Check if helpers are actually present (not just version flag)
  const check = await runJS("(typeof mcpClickWithReact==='function'&&typeof mcpFindText==='function')?'ok':'missing'").catch(() => 'missing');
  if (check === 'ok') {
    _helpersInjectedForUrl = _activeTabURL;
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
  _helpersInjectedForUrl = _activeTabURL;
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
  if (ref) {
    return clickWithRetry(
      `(function(){var el=mcpFindRef('${ref}');if(!el)return 'Element not found: ref=${ref}';var target=mcpClickWithReact(el);return 'Clicked: '+target.tagName+((target.innerText||target.textContent)?(' "'+(target.innerText||target.textContent).trim().substring(0,50)+'"'):'');})()`
    );
  }

  if (selector) {
    const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return clickWithRetry(
      `(function(){var el=mcpQuerySelectorDeep('${sel}');if(!el)return 'Element not found: ${sel}';var target=mcpClickWithReact(el);return 'Clicked: '+target.tagName+((target.innerText||target.textContent)?(' "'+(target.innerText||target.textContent).trim().substring(0,50)+'"'):'');})()`
    );
  }

  if (text) {
    const safeText = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return clickWithRetry(
      `(function(){var el=mcpFindText('${safeText}',true)||mcpFindText('${safeText}',false);if(!el)return 'Element not found with text: ${safeText}';var target=mcpClickWithReact(el);return 'Clicked: '+target.tagName+' "'+((target.innerText||target.textContent)||'').trim().substring(0,50)+'"';})()`
    );
  }

  if (x !== undefined && y !== undefined) {
    return clickWithRetry(
      `(function(){var el=mcpElementFromPoint(${Number(x)},${Number(y)});if(!el)return 'No element at (${Number(x)},${Number(y)})';var target=mcpClickWithReact(el);return 'Clicked: '+target.tagName+' at (${Number(x)},${Number(y)})';})()`
    );
  }
  throw new Error("click requires selector, text, or x/y coordinates");
}

export async function doubleClick({ selector, x, y, ref }) {
  if (ref) selector = refSelector(ref);
  if (selector) {
    const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
    const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

export async function nativeClick({ selector, text, x, y, ref, doubleClick = false }) {
  await ensureHelpers();

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
      const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
      const safeText = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
  await _helperNativeClick(screenX, screenY, doubleClick, geo.windowId);

  const clickType = doubleClick ? 'Native double-clicked' : 'Native clicked';
  const label = viewportCoords.tag + (viewportCoords.text ? ` "${viewportCoords.text}"` : '');
  return `${clickType}: ${label} at screen (${screenX},${screenY})`;
}

// ========== FORM INPUT ==========

export async function fill({ selector, value, ref }) {
  if (ref) selector = refSelector(ref);
  if (!selector) throw new Error("fill requires selector or ref");
  const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  // Proper escaping order: backslashes first, then quotes
  const val = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "");
  const result = await runJS(
    `(function(){try{var el=document.querySelector('${sel}');if(!el){var q=function(r){var a=r.querySelectorAll('*');for(var i=0;i<a.length;i++){if(a[i].shadowRoot){el=a[i].shadowRoot.querySelector('${sel}');if(el)return el;el=q(a[i].shadowRoot);if(el)return el;}}return null;};el=q(document);}if(!el)return 'Element not found: ${sel}';el.focus();if(el.isContentEditable||el.getAttribute('contenteditable')==='true'){` +
    // ProseMirror detection
    `var pm=el.closest('.ProseMirror')||el.querySelector('.ProseMirror');if(pm){try{var v=null;if(pm.pmViewDesc&&pm.pmViewDesc.view)v=pm.pmViewDesc.view;else if(pm.cmView&&pm.cmView.view)v=pm.cmView.view;else{var keys=Object.keys(pm);for(var ki=0;ki<keys.length;ki++){var o=pm[keys[ki]];if(o&&o.state&&o.dispatch){v=o;break;}}}if(v&&v.state&&v.dispatch){var doc=v.state.doc;var hasContent=doc.textContent&&doc.textContent.trim().length>0;if(hasContent){var endPos=doc.content.size>1?doc.content.size-1:doc.content.size;v.dispatch(v.state.tr.insertText(' ${val}',endPos));v.focus();return 'Filled CE (ProseMirror append)';}else{var tr=v.state.tr;tr.replaceWith(0,doc.content.size,v.state.schema.text('${val}'));v.dispatch(tr);v.focus();return 'Filled CE (ProseMirror replace)';}}}catch(e){}}` +
    // Closure/Medium detection — signal for native paste
    `var isClosure=Object.keys(el).some(function(k){return k.startsWith('closure_uid_');})||location.hostname.includes('medium.com');if(isClosure){return '__CLOSURE_NATIVE_PASTE__';}` +
    // Synthetic ClipboardEvent paste — works on ProseMirror, TipTap, Slate, and most modern editors
    // that don't respond to execCommand but DO handle paste events
    `try{el.focus();var sel2=window.getSelection();if(sel2.rangeCount){var rng=document.createRange();rng.selectNodeContents(el);sel2.removeAllRanges();sel2.addRange(rng);}var dt=new DataTransfer();dt.setData('text/plain','${val}');var pe=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});var handled=!el.dispatchEvent(pe);if(handled||el.textContent.indexOf('${val.substring(0, 20)}')>=0){return 'Filled CE (synthetic paste)';}}catch(ep){}` +
    // Default contenteditable: selectAll+delete+insert (safer than textContent='')
    `document.execCommand('selectAll');document.execCommand('delete');document.execCommand('insertText',false,'${val}');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));return 'Filled contenteditable';}` +
    // Standard input/textarea with _valueTracker
    `var t=el._valueTracker;if(t)t.setValue('');var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var s=Object.getOwnPropertyDescriptor(proto,'value');if(s&&s.set){s.set.call(el,'${val}');}else{el.value='${val}';}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));el.dispatchEvent(new Event('focusout',{bubbles:true}));el.focus();return 'Filled: '+el.value.substring(0,50);}catch(e){return 'ERR: '+e.message;}})()`
  );

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
      `var el=document.querySelector('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');` +
      `if(!el)return 'Element not found';` +
      `el.focus();el.click();` +
      `var sel=window.getSelection();if(sel.rangeCount){var r=document.createRange();r.selectNodeContents(el);r.collapse(false);sel.removeAllRanges();sel.addRange(r);}` +
      lineInserts +
      `return 'Filled CE (Closure line-by-line)';` +
      `})()`
    );
    return fillResult;
  }

  return result;
}

export async function clearField({ selector }) {
  const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found: ${sel}';if(el.isContentEditable){el.focus();document.execCommand('selectAll');document.execCommand('delete');el.dispatchEvent(new Event('input',{bubbles:true}));return 'Cleared (contenteditable)';}var t=el._valueTracker;if(t)t.setValue('x');var p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(p,'value');if(d&&d.set)d.set.call(el,'');else el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));return 'Cleared';})()`
  );
}

export async function selectOption({ selector, value }) {
  const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const val = value.replace(/'/g, "\\'");
  return runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found';el.focus();var t=el._valueTracker;if(t)t.setValue('');var d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');if(d&&d.set){d.set.call(el,'${val}');}else{el.value='${val}';}var m=false;for(var i=0;i<el.options.length;i++){if(el.options[i].value==='${val}'){el.selectedIndex=i;m=true;break;}}if(!m||el.value!=='${val}'){var norm=function(s){return s.replace(/[\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]/g,'').replace(/[\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]/g,'-').replace(/\\s*-\\s*/g,'-').replace(/\\s+/g,' ').trim();};var cv=norm('${val}');for(var i=0;i<el.options.length;i++){if(norm(el.options[i].value)===cv||norm(el.options[i].text)===cv){el.selectedIndex=i;if(d&&d.set){d.set.call(el,el.options[i].value);}else{el.value=el.options[i].value;}m=true;break;}}if(!m){for(var i=0;i<el.options.length;i++){var nv=norm(el.options[i].value),nt=norm(el.options[i].text);if(nv.indexOf(cv)>=0||nt.indexOf(cv)>=0||cv.indexOf(nv)>=0||cv.indexOf(nt)>=0){if(i===0&&el.options.length>1)continue;el.selectedIndex=i;if(d&&d.set){d.set.call(el,el.options[i].value);}else{el.value=el.options[i].value;}m=true;break;}}}}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));return 'Selected: '+el.value+' (index '+el.selectedIndex+')';})()`
  );
}

export async function fillForm({ fields }) {
  // Single JS call for ALL fields (instead of N separate osascript calls)
  const fieldsJSON = JSON.stringify(fields.map(f => ({
    s: f.selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    v: f.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n"),
  })));
  return runJS(
    `(function(){
      var fields = ${fieldsJSON};
      var results = [];
      fields.forEach(function(f) {
        var el = document.querySelector(f.s);
        if (!el) { results.push('Not found: ' + f.s); return; }
        el.focus();
        if (el.isContentEditable) {
          el.textContent = '';
          document.execCommand('insertText', false, f.v);
        } else {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                       Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (setter && setter.set) setter.set.call(el, f.v);
          else el.value = f.v;
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }
        results.push('Filled: ' + el.tagName + ' with "' + f.v.substring(0, 30) + '"');
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
        await new Promise(r => setTimeout(r, 300));
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
  const shiftKey = hasShift;
  const altKey = modifiers.some((m) => m.toLowerCase() === "alt");

  await runJS(
    `(function(){
      var el = document.activeElement || document.body;
      var opts = {key:'${safeKey}',code:'Key${safeKey.length === 1 ? safeKey.toUpperCase() : safeKey}',bubbles:true,cancelable:true,shiftKey:${shiftKey},altKey:${altKey}};
      var down = new KeyboardEvent('keydown', opts);
      var prevented = !el.dispatchEvent(down);
      if (!prevented) {
        if ('${safeKey}' === 'Enter') {
          if (el.tagName === 'INPUT') { el.form && el.form.dispatchEvent(new Event('submit',{bubbles:true})); }
          else { document.execCommand('insertLineBreak'); }
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
      return 'OK';
    })()`
  );
  return `Pressed: ${modifiers.length ? modifiers.join("+") + "+" : ""}${key}`;
}

// Native typing via clipboard paste — for cross-origin iframes (Intercom, Zendesk, etc.)
// JS can't access content inside cross-origin iframes, so we use OS-level CGEvent:
// 1. Save current clipboard
// 2. Set clipboard to our text
// 3. Cmd+V via CGEvent keyboard (targeted to window — NO focus steal, NO activate)
// 4. Restore clipboard
// Requires nativeClick to have focused the input inside the iframe first.
async function _nativeTypeViaClipboard(text) {
  await _acquireClipboardLock();
  try {
    // Save current clipboard
    const savedClipboard = await _saveClipboard();

    // Set clipboard to our text via pipe (safe from shell injection)
    await new Promise((resolve, reject) => {
      const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      proc.stdin.write(text);
      proc.stdin.end();
      proc.on("close", resolve);
      proc.on("error", reject);
    });

    // Paste via CGEvent Cmd+V targeted to Safari window — NO activate, NO focus steal
    // MUST have windowId — global CGEvent (windowId=0) would steal focus and move mouse
    const geo = await _getSafariWindowGeometry();
    if (!geo.windowId) {
      // Can't get window ID — restore clipboard and throw
      await _restoreClipboard(savedClipboard);
      _releaseClipboardLock();
      throw new Error("Cannot native-paste without Safari window ID — would steal focus");
    }
    // keyCode 9 = V key, flags: ["cmd"]
    await _helperNativeKeyboard(9, ["cmd"], geo.windowId);

    // Wait for paste to settle, then restore clipboard immediately
    await new Promise(r => setTimeout(r, 300));
    await _restoreClipboard(savedClipboard);
    _releaseClipboardLock();

    return `Typed ${text.length} chars (native paste into iframe)`;
  } catch (err) {
    _releaseClipboardLock();
    throw err;
  }
}

export async function typeText({ text, selector, ref }) {
  if (ref) selector = refSelector(ref);
  if (selector) {
    const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
  const tmpFile = join(tmpdir(), `safari-screenshot-${Date.now()}.png`);
  try {
    // Check if target tab is a background tab — if so, use JS screenshot to avoid tab jumping
    let isBackgroundTab = false;
    if (_activeTabIndex) {
      try {
        const currentIdx = await osascriptFast(
          `tell application "Safari" to return index of current tab of ${getTargetWindowRef()}`
        );
        isBackgroundTab = Number(currentIdx) !== _activeTabIndex;
      } catch (_) {}
    }
    // When on a background tab, go straight to JS-based screenshot (no tab switch, no focus steal)
    const skipScreencapture = isBackgroundTab;

    // Try screencapture — use osascript's do shell script to bypass VS Code permission issue
    const windowId = !skipScreencapture ? await osascript(
      `tell application "Safari" to return id of ${getTargetWindowRef()}`
    ).catch(() => null) : null;

    // Save frontmost app BEFORE screencapture (it may steal focus on macOS Tahoe)
    // Restore it immediately after capture to minimize disruption
    let previousApp = null;
    if (windowId) {
      try {
        previousApp = (await osascriptFast(
          `tell application "System Events" to return name of first application process whose frontmost is true`
        )).trim();
      } catch (_) {}
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
            // Use do shell script to inherit osascript's Screen Recording permission
            await osascript(
              `do shell script "screencapture -l${windowId} -o -x '${tmpFile}'"`,
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
            await execFileAsync("screencapture", ["-l" + windowId, "-o", "-x", tmpFile]);
            const testData = await readFile(tmpFile);
            if (testData.length < 100) throw new Error("empty");
          } catch (_) {
            // Fallback: use do shell script (osascript may have permission)
            await osascript(
              `do shell script "screencapture -l${windowId} -o -x '${tmpFile}'"`,
              { timeout: 15000 }
            );
          }
        }
        // Restore focus if screencapture stole it (common on macOS Tahoe)
        if (previousApp && previousApp !== "Safari") {
          await osascriptFast(
            `tell application "${previousApp}" to activate`
          ).catch(() => {});
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

    if (dataUrl && dataUrl !== "FALLBACK_TEXT") {
      return dataUrl;
    }

    // Final fallback: throw with clear message for the retry logic in index.js
    throw new Error("screencapture failed — Screen Recording permission may have been lost. Grant permission in System Settings → Privacy & Security → Screen Recording, then restart Safari.");
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

// ========== ELEMENT SCREENSHOT ==========

export async function screenshotElement({ selector }) {
  const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

  if (result === "SVG_RENDER_FAILED" || result.startsWith("Element")) {
    // Fallback: use screencapture + crop
    const tmpFile = join(tmpdir(), `safari-el-${Date.now()}.png`);
    try {
      const windowId = await osascript(`tell application "Safari" to return id of ${getTargetWindowRef()}`).catch(() => null);
      if (!windowId) throw new Error("Cannot get Safari window ID");

      // Get element bounds relative to screen
      const bounds = await runJS(
        `(function(){var el=document.querySelector('${sel}');if(!el)return '';var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})()`
      );
      if (!bounds) throw new Error(result);

      // Full window screenshot then crop with sips
      await execFileAsync("screencapture", ["-l" + windowId, "-o", "-x", tmpFile]);
      const { x, y, w, h } = JSON.parse(bounds);
      // Use sips to crop (macOS built-in)
      const toolbarHeight = 74; // Safari toolbar approximate height (matches _getSafariWindowGeometry)
      const cropFile = join(tmpdir(), `safari-el-crop-${Date.now()}.png`);
      await execFileAsync("sips", [
        "-c", String(h), String(w),
        "--cropOffset", String(y + toolbarHeight), String(x),
        tmpFile, "--out", cropFile
      ]);
      const data = await readFile(cropFile);
      await unlink(tmpFile).catch(() => {});
      await unlink(cropFile).catch(() => {});
      if (data.length > 100) return data.toString("base64");
    } catch (e) {
      await unlink(tmpFile).catch(() => {});
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
  // If we have a tracked URL, re-resolve the index (it may have shifted)
  // If no URL tracked, reset index (new session should open its own tab)
  if (_activeTabURL) {
    await resolveActiveTab();
  } else {
    _activeTabIndex = null;
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

export async function newTab(url = "") {
  await refreshTargetWindow();
  const safeUrl = url ? url.replace(/"/g, '\\"') : "";
  try {
    if (url) {
      await osascript(`tell application "Safari"\ntell ${getTargetWindowRef()}\nset userTab to current tab\nmake new tab with properties {URL:"${safeUrl}"}\nset current tab to userTab\nend tell\nend tell`);
    } else {
      await osascript(`tell application "Safari"\ntell ${getTargetWindowRef()}\nset userTab to current tab\nmake new tab\nset current tab to userTab\nend tell\nend tell`);
    }
  } catch {
    if (SAFARI_PROFILE) {
      // Profile mode: create tab inside the profile window, never use make new document (opens in front/personal window)
      if (url) {
        await osascript(`tell application "Safari" to tell ${getTargetWindowRef()} to make new tab with properties {URL:"${safeUrl}"}`);
      } else {
        await osascript(`tell application "Safari" to tell ${getTargetWindowRef()} to make new tab`);
      }
    } else {
      if (url) { await osascript(`tell application "Safari" to make new document with properties {URL:"${safeUrl}"}`); }
      else { await osascript('tell application "Safari" to make new document'); }
    }
  }
  // Get count atomically from the same tell block as tab creation (avoids TOCTOU if user opens tabs concurrently)
  const tabCount = await osascriptFast(`tell application "Safari" to return count of tabs of ${getTargetWindowRef()}`);
  _activeTabIndex = Number(tabCount);  // New tab is always appended as last
  _activeTabURL = url || null;
  _lastResolveTime = Date.now();
  _lastTabCount = Number(tabCount);  // Update tab count cache
  // Wait for page load if URL given
  if (url) {
    try {
      await runJS(
        `(async function(){for(var i=0;i<40;i++){if(location.href!=='about:blank'&&document.readyState==='complete')break;await new Promise(r=>setTimeout(r,250))}return 'ok'})()`,
        { tabIndex: _activeTabIndex, timeout: 12000 }
      );
    } catch {}
  } else {
    await new Promise(r => setTimeout(r, 200));
  }
  const info = await runJS(`JSON.stringify({title:document.title,url:location.href,tabIndex:${_activeTabIndex}})`, { tabIndex: _activeTabIndex });
  try {
    const parsed = JSON.parse(info);
    if (parsed.url && parsed.url !== 'about:blank') _activeTabURL = parsed.url;
  } catch {}
  return info;
}

export async function closeTab() {
  await refreshTargetWindow();
  if (_activeTabIndex) {
    await osascript(
      `tell application "Safari" to close tab ${_activeTabIndex} of ${getTargetWindowRef()}`
    );
    _activeTabIndex = null;
    _activeTabURL = null;
  } else {
    await osascript(
      `tell application "Safari" to close current tab of ${getTargetWindowRef()}`
    );
  }
  _lastTabCount = null;    // Invalidate — tab count changed
  _lastResolveTime = 0;    // Force re-resolve on next operation
  return "Tab closed";
}

export async function switchTab(index) {
  const idx = Number(index);
  _activeTabIndex = idx;
  // Do NOT visually switch the tab — it brings the Safari window to foreground
  // and interrupts the user. Visual switching only happens in screenshot() when needed.
  // AppleScript `do JavaScript in tab N` works on background tabs without switching.
  // Get title+URL from the target tab
  const result = await runJS(
    `JSON.stringify({title:document.title,url:location.href})`,
    { tabIndex: idx }
  );
  // Track by URL so we can find this tab even if indices shift
  try {
    const parsed = JSON.parse(result);
    _activeTabURL = parsed.url || null;
  } catch {}
  return result;
}

// ========== WAIT ==========

export async function waitFor({ selector, text, timeout = 10000 }) {
  // Single JS call with internal polling loop — 1 call instead of 20+
  const safeSelector = selector ? selector.replace(/'/g, "\\'") : "";
  const safeText = text ? text.replace(/'/g, "\\'") : "";
  const result = await runJS(
    `(async function(){
      var deadline = Date.now() + ${Number(timeout)};
      while (Date.now() < deadline) {
        ${safeSelector ? `if (document.querySelector('${safeSelector}')) return 'Found: ${safeSelector}';` : ""}
        ${safeText ? `if (document.body && document.body.innerText.includes('${safeText}')) return 'Found text: ${safeText}';` : ""}
        await new Promise(function(r){setTimeout(r, 50)});
      }
      return 'TIMEOUT';
    })()`,
    { timeout: timeout + 2000 }
  );
  if (result === "TIMEOUT") {
    throw new Error(`Timeout waiting for ${selector || text} (${timeout}ms)`);
  }
  return result;
}

// ========== EVALUATE ==========

export async function evaluate({ script }) {
  let js = script.trim();

  const isAsync = /\bawait\b/.test(js) || /\.then\s*\(/.test(js) || /^async\b/.test(js) || /\bfetch\s*\(/.test(js);

  if (isAsync) {
    // Single combined call: execute async + return result in ONE runJS (no polling!)
    const result = await runJS(
      `(async function(){
        try{
          var v = await(async function(){${js}})();
          return JSON.stringify({v: v !== undefined && v !== null ? (typeof v === 'object' ? JSON.stringify(v) : String(v)) : null});
        }catch(e){
          return JSON.stringify({e: e.message});
        }
      })()`,
      { timeout: 35000 }
    );
    try {
      const parsed = JSON.parse(result);
      if (parsed.e) return `Error: ${parsed.e}`;
      return parsed.v !== undefined && parsed.v !== null ? String(parsed.v) : '(undefined)';
    } catch { return result || '(undefined)'; }
  }

  const isIIFE = /^\((?:async\s+)?function/.test(js) || /^\((?:async\s+)?\(/.test(js);
  const isSimpleExpression = !js.includes(';') && !js.includes('\n') && !js.startsWith('var ') && !js.startsWith('let ') && !js.startsWith('const ');

  if (!isIIFE && !isSimpleExpression) {
    const lines = js.split('\n');
    let addedReturn = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line.startsWith('//')) continue;
      if (line.startsWith('return ') || line.startsWith('return;')) { addedReturn = true; break; }
      if (line.endsWith('}') || line.startsWith('var ') || line.startsWith('let ') || line.startsWith('const ')) break;
      lines[i] = 'return ' + lines[i];
      addedReturn = true;
      break;
    }
    if (addedReturn) {
      js = '(function(){' + lines.join('\n') + '})()';
    } else {
      // Last line ends with } (if/else/for/while) or starts with var/let/const — can't prepend return.
      // Use indirect eval to capture completion value. Falls back to plain IIFE on CSP-strict pages.
      // eslint-disable-next-line no-eval
      const escaped = js.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      js = "(function(){ try { return (0,eval)('" + escaped + "') } catch(_e) { " + js.replace(/\n/g, ' ') + " } })()";
    }
  }

  // Wrap in IIFE with try/catch. Safari's `do JavaScript` only returns values from single expressions —
  // multi-statement scripts (var x; try{} x) return nothing. So the entire wrapper must be one IIFE.
  const wrappedJs = `(function(){ try { return (${js}); } catch(__mcpErr) { return 'Error: ' + __mcpErr.message; } })()`;
  if (process.env.MCP_DEBUG) console.error('[evaluate] wrapped:', wrappedJs.substring(0, 300));
  const result = await runJS(wrappedJs);
  if (result === null || result === undefined || result === '') {
    return '(no return value)';
  }
  return result;
}

// ========== ELEMENT INFO ==========

export async function getElementInfo({ selector }) {
  const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found';var r=el.getBoundingClientRect();return JSON.stringify({tag:el.tagName,text:el.textContent.trim().substring(0,200),href:el.href||'',value:el.value||'',visible:r.width>0&&r.height>0,rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},attrs:Object.fromEntries([...el.attributes].map(function(a){return[a.name,a.value.substring(0,100)]}))})})()`
  );
}

export async function querySelectorAll({ selector, limit = 20 }) {
  const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return runJS(
    `JSON.stringify([...document.querySelectorAll('${sel}')].slice(0,${Number(limit)}).map(function(el,i){return{index:i,tag:el.tagName,text:el.textContent.trim().substring(0,100),href:el.href||undefined,value:el.value||undefined}}))`
  );
}

// ========== HOVER ==========

export async function hover({ selector, x, y, ref }) {
  if (ref) selector = refSelector(ref);
  if (selector) {
    const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
    const safeText = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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

export async function getCookies() {
  return runJS("document.cookie");
}

export async function getLocalStorage({ key }) {
  if (key) {
    const safeKey = key.replace(/'/g, "\\'");
    return runJS(`localStorage.getItem('${safeKey}')`);
  }
  return runJS(
    "JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(function(k){return[k,localStorage.getItem(k).substring(0,200)]})))"
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
    const srcSel = sourceSelector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const tgtSel = targetSelector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
  if (resolved.includes('..')) throw new Error("Path traversal not allowed: " + filePath);
  const blocked = ['.ssh', '.gnupg', '.aws', '.config/gcloud', 'credentials', '.env', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', '.keychain'];
  const lower = resolved.toLowerCase();
  for (const b of blocked) {
    if (lower.includes(b)) throw new Error("Blocked: reading sensitive path " + filePath);
  }
  // Must be under /Users/ or /tmp/ or /var/folders/ (macOS temp)
  if (!resolved.startsWith('/Users/') && !resolved.startsWith('/tmp/') && !resolved.startsWith('/var/folders/') && !resolved.startsWith('/private/tmp/')) {
    throw new Error("File path must be under /Users/, /tmp/, or /var/folders/: " + filePath);
  }
}

// ========== UPLOAD FILE ==========

export async function uploadFile({ selector, filePath }) {
  _validateFilePath(filePath);
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
                click button "ביטול" of sheet 1 of w
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

  const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const { basename, extname } = await import("node:path");
  const fileName = basename(filePath);
  const ext = extname(filePath).toLowerCase().replace(".", "");

  // Read file as base64
  const fileData = await readFile(filePath);
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

  // Send to Safari via runJSLarge (handles files >260KB via temp file)
  const result = await runJSLarge(
    `(async function(){
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

      // Strategy 1: Direct files assignment (works on most inputs)
      try { el.files = dt.files; } catch(_) {}

      if (el.files && el.files.length > 0) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'Uploaded: ${safeName} (' + Math.round(bytes.length / 1024) + ' KB, verified ' + el.files.length + ' file(s))';
      }

      // Strategy 2: Drop event on the input or its container (works when files property is read-only)
      var dropTarget = el.closest('[class*="upload"], [class*="drop"], [class*="file"]') || el.parentElement || el;
      var dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
      dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      dropTarget.dispatchEvent(dropEvent);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));

      // Wait briefly for framework to process drop events before checking
      await new Promise(function(r) { setTimeout(r, 200); });

      // Re-check after drop
      if (el.files && el.files.length > 0) {
        return 'Uploaded via drop: ${safeName} (' + Math.round(bytes.length / 1024) + ' KB, verified ' + el.files.length + ' file(s))';
      }
      // Check if any new images/files appeared on the page after the drop
      var newImgs = document.querySelectorAll('img[src*="blob:"], img[src*="data:"], [style*="background-image"]');
      var hint = newImgs.length > 0 ? ' (detected ' + newImgs.length + ' blob/data images on page — upload likely succeeded)' : '';
      return 'Upload attempted: ${safeName} (' + Math.round(bytes.length / 1024) + ' KB) — drop event dispatched. el.files is empty (normal for custom upload handlers).' + hint + ' Verify with safari_snapshot.';
    })()`,
    { timeout: 30000 }
  );

  return result;
}

// ========== PASTE IMAGE FROM FILE ==========

export async function pasteImageFromFile({ filePath }) {
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
    { timeout: 30000 }
  );

  return result;
}

// ========== EMULATE (VIEWPORT) ==========

export async function emulate({ device, width, height, userAgent, scale = 1 }) {
  await refreshTargetWindow();
  const devices = {
    "iphone-14": { width: 390, height: 844, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    "iphone-14-pro-max": { width: 430, height: 932, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    "ipad": { width: 820, height: 1180, ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    "ipad-pro": { width: 1024, height: 1366, ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    "pixel-7": { width: 412, height: 915, ua: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" },
    "galaxy-s24": { width: 412, height: 915, ua: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" },
  };

  const d = device ? devices[device.toLowerCase()] : null;
  const w = d ? d.width : (width || 375);
  const h = d ? d.height : (height || 812);
  const ua = d ? d.ua : (userAgent || "");

  // Resize Safari window to match device
  await osascript(
    `tell application "Safari" to set bounds of ${getTargetWindowRef()} to {0, 0, ${w}, ${h + 100}}`
  );

  // Override viewport meta and user agent if specified
  if (ua) {
    await runJS(
      `Object.defineProperty(navigator,'userAgent',{get:function(){return '${ua.replace(/'/g, "\\'")}'},configurable:true})`
    );
  }

  // Set viewport meta tag
  await runJS(
    `(function(){var m=document.querySelector('meta[name=viewport]');if(!m){m=document.createElement('meta');m.name='viewport';document.head.appendChild(m);}m.content='width=${w},initial-scale=${scale}';})()`
  );

  // Reload to apply changes
  // Reload and wait via inline JS polling (not fixed sleep)
  await runJS(
    `(async function(){location.reload();await new Promise(function(r){setTimeout(r,300)});for(var i=0;i<30;i++){if(document.readyState==='complete')break;await new Promise(function(r){setTimeout(r,200)});}return 'done';})()`
  );

  return JSON.stringify({
    device: device || "custom",
    width: w,
    height: h,
    userAgent: ua ? ua.substring(0, 60) + "..." : "(default)",
  });
}

export async function resetEmulation() {
  await refreshTargetWindow();
  // Reset user agent — remove the defineProperty override set by emulate()
  await runJS(
    "try{var d=Object.getOwnPropertyDescriptor(Navigator.prototype,'userAgent');if(d){Object.defineProperty(navigator,'userAgent',d);}else{delete navigator.userAgent;}}catch(_){}"
  );
  // Maximize window
  await osascript(
    `tell application "Safari" to set bounds of ${getTargetWindowRef()} to {0, 0, 1440, 900}`
  );
  await runJS(
    `(async function(){location.reload();await new Promise(function(r){setTimeout(r,300)});for(var i=0;i<30;i++){if(document.readyState==='complete')break;await new Promise(function(r){setTimeout(r,200)});}return 'done';})()`
  );
  return "Emulation reset to desktop";
}

// ========== CONSOLE CAPTURE ==========

export async function startConsoleCapture() {
  await runJS(
    "if(!window.__mcp_console){window.__mcp_console=[];var orig={log:console.log,warn:console.warn,error:console.error,info:console.info};['log','warn','error','info'].forEach(function(level){console[level]=function(){window.__mcp_console.push({level:level,message:[].slice.call(arguments).map(String).join(' '),time:Date.now()});orig[level].apply(console,arguments);};});window.addEventListener('error',function(e){window.__mcp_console.push({level:'error',message:e.message,time:Date.now()});});}"
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
  // NO focus stealing — uses screencapture + Python Quartz to generate PDF

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
  const windowId = await osascript(
    `tell application "Safari" to return id of ${getTargetWindowRef()}`
  );
  const tmpPng = join(tmpdir(), `safari-mcp-pdf-${Date.now()}.png`);
  try {
    // Use do shell script to inherit osascript's Screen Recording permission
    await osascript(
      `do shell script "screencapture -l${windowId} -o -x '${tmpPng}'"`,
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

  // Step 5: Convert screenshot to PDF using Python3 + macOS Quartz (no external deps)
  const safePdfPath = pdfPath.replace(/'/g, "'\\''");
  const safePngPath = tmpPng.replace(/'/g, "'\\''");
  try {
    await execFileAsync("python3", ["-c", `
import sys
from Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex, CGImageGetWidth, CGImageGetHeight, CGPDFContextCreateWithURL, CGRectMake, CGPDFContextBeginPage, CGPDFContextEndPage, CGContextDrawImage
from CoreFoundation import CFURLCreateFromFileSystemRepresentation

png_path = b'${safePngPath}'
pdf_path = b'${safePdfPath}'

src_url = CFURLCreateFromFileSystemRepresentation(None, png_path, len(png_path), False)
img_src = CGImageSourceCreateWithURL(src_url, None)
if not img_src:
    print("ERROR: failed to read screenshot", file=sys.stderr); sys.exit(1)
img = CGImageSourceCreateImageAtIndex(img_src, 0, None)
if not img:
    print("ERROR: failed to decode image", file=sys.stderr); sys.exit(1)
w = CGImageGetWidth(img)
h = CGImageGetHeight(img)

pdf_url = CFURLCreateFromFileSystemRepresentation(None, pdf_path, len(pdf_path), False)
ctx = CGPDFContextCreateWithURL(pdf_url, CGRectMake(0, 0, w, h), None)
CGPDFContextBeginPage(ctx, None)
CGContextDrawImage(ctx, CGRectMake(0, 0, w, h), img)
CGPDFContextEndPage(ctx)
del ctx
print(f"OK {w}x{h}")
`.trim()], { timeout: 15000 });
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
export async function runScript({ steps }) {
  const results = [];
  for (const step of steps) {
    const { action, args = {} } = step;
    try {
      // Map action names to safari.js functions
      const actions = {
        navigate, click, doubleClick, rightClick, fill, clearField, typeText,
        pressKey, scroll, scrollTo, scrollToElement, readPage, getPageSource,
        screenshot, screenshotElement, evaluate, waitFor, waitForTime, hover,
        selectOption, fillForm, fillAndSubmit, navigateAndRead, clickAndWait,
        goBack, goForward, reload, newTab, closeTab, switchTab, listTabs,
        getLocalStorage, setLocalStorage, deleteLocalStorage,
        getSessionStorage, setSessionStorage, deleteSessionStorage,
        getCookies, setCookie, deleteCookies, getElementInfo, querySelectorAll,
        extractTables, extractMeta, extractImages, extractLinks,
        analyzePage, detectForms, getAccessibilityTree, getPerformanceMetrics,
      };
      const fn = actions[action];
      if (!fn) {
        results.push({ action, error: `Unknown action: ${action}` });
        continue;
      }
      const result = await fn(args);
      results.push({ action, result: typeof result === "string" ? result.substring(0, 2000) : result });
    } catch (err) {
      results.push({ action, error: err.message });
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
  const safeName = name.replace(/'/g, "\\'");
  const safeValue = value.replace(/'/g, "\\'");
  let cookie = `${safeName}=${safeValue}`;
  if (cookiePath) cookie += `; path=${cookiePath}`;
  if (domain) cookie += `; domain=${domain}`;
  if (expires) cookie += `; expires=${expires}`;
  if (secure) cookie += '; secure';
  if (sameSite) cookie += `; samesite=${sameSite}`;
  return runJS(`document.cookie='${cookie.replace(/'/g, "\\'")}'; 'Cookie set: ${safeName}'`);
}

export async function deleteCookies({ name, all }) {
  if (all) {
    return runJS(
      `(function(){var cookies=document.cookie.split(';');var count=0;cookies.forEach(function(c){var name=c.split('=')[0].trim();document.cookie=name+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';count++;});return 'Deleted '+count+' cookies';})()`
    );
  }
  if (name) {
    const safeName = name.replace(/'/g, "\\'");
    return runJS(
      `document.cookie='${safeName}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'; 'Deleted cookie: ${safeName}'`
    );
  }
  throw new Error("deleteCookies requires name or all:true");
}

// ========== SESSION STORAGE ==========

export async function getSessionStorage({ key }) {
  if (key) {
    const safeKey = key.replace(/'/g, "\\'");
    return runJS(`sessionStorage.getItem('${safeKey}')`);
  }
  return runJS(
    "JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map(function(k){return[k,sessionStorage.getItem(k).substring(0,200)]})))"
  );
}

export async function setSessionStorage({ key, value }) {
  const safeKey = key.replace(/'/g, "\\'");
  const safeValue = value.replace(/'/g, "\\'");
  return runJS(`sessionStorage.setItem('${safeKey}','${safeValue}'); 'Set sessionStorage: ${safeKey}'`);
}

export async function setLocalStorage({ key, value }) {
  const safeKey = key.replace(/'/g, "\\'");
  const safeValue = value.replace(/'/g, "\\'");
  return runJS(`localStorage.setItem('${safeKey}','${safeValue}'); 'Set localStorage: ${safeKey}'`);
}

export async function deleteLocalStorage({ key }) {
  if (key) {
    const safeKey = key.replace(/'/g, "\\'");
    return runJS(`localStorage.removeItem('${safeKey}'); 'Deleted localStorage: ${safeKey}'`);
  }
  return runJS("var n=localStorage.length; localStorage.clear(); 'Cleared localStorage: '+n+' items'");
}

export async function deleteSessionStorage({ key }) {
  if (key) {
    const safeKey = key.replace(/'/g, "\\'");
    return runJS(`sessionStorage.removeItem('${safeKey}'); 'Deleted sessionStorage: ${safeKey}'`);
  }
  return runJS("var n=sessionStorage.length; sessionStorage.clear(); 'Cleared sessionStorage: '+n+' items'");
}

// Export all storage state (cookies + localStorage + sessionStorage) as JSON
export async function exportStorageState() {
  return runJS(
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
  if (script.length > 200000) {
    return runJSLarge(script, { timeout: 30000 });
  }
  return runJS(script);
}

// ========== CLIPBOARD ==========

export async function clipboardRead() {
  try {
    const text = await execFileAsync("pbpaste", []);
    return text.stdout;
  } catch {
    return "(clipboard empty or contains non-text data)";
  }
}

export async function clipboardWrite({ text, restore = true }) {
  await _acquireClipboardLock();
  try {
    // Save current clipboard
    const oldClipboard = restore ? await _saveClipboard() : null;

    // Use spawn + stdin pipe — safe from shell injection (no shell involved)
    await new Promise((resolve, reject) => {
      const proc = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      proc.stdin.write(text);
      proc.stdin.end();
      proc.on("close", resolve);
      proc.on("error", reject);
    });

    // Restore clipboard after 2 seconds (reduced from 5s — shorter exposure window)
    if (restore && oldClipboard !== null) {
      if (_clipboardRestoreTimer) clearTimeout(_clipboardRestoreTimer);
      _clipboardRestoreTimer = setTimeout(async () => {
        await _restoreClipboard(oldClipboard);
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

// ========== NETWORK MOCKING ==========

// Intercept fetch/XHR requests matching a URL pattern and return mock responses
export async function mockNetworkRoute({ urlPattern, response }) {
  const safePattern = urlPattern.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
  const safeBody = (response.body || "").replace(/'/g, "\\'").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
  const status = response.status || 200;
  const contentType = response.contentType || "application/json";

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
        window.__mcp_network.push(entry);return resp;
      }).catch(function(err){
        window.__mcp_network.push({url:typeof url==='string'?url:url.url,method:opts.method||'GET',error:err.message,type:'fetch',time:new Date().toISOString()});
        throw err;
      });
    };
    var origXHR=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url){
      this.__mcp_method=method;this.__mcp_url=url;this.__mcp_start=Date.now();
      this.addEventListener('load',function(){
        window.__mcp_network.push({url:this.__mcp_url,method:this.__mcp_method,status:this.status,statusText:this.statusText,
          type:'xhr',duration:Date.now()-this.__mcp_start,responseSize:this.responseText.length,time:new Date().toISOString()});
      });
      this.addEventListener('error',function(){
        window.__mcp_network.push({url:this.__mcp_url,method:this.__mcp_method,error:'Network error',type:'xhr',time:new Date().toISOString()});
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
  const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const propsFilter = properties
    ? `.filter(function(p){return [${properties.map((p) => `'${p}'`).join(",")}].includes(p)})`
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
  return runJS(
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
    })()`,
    { timeout: 15000 }
  );
}

export async function listIndexedDBs() {
  return runJS(
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
  return runJS(
    `(function(){
      var results = [];
      for (var i = 0; i < document.styleSheets.length; i++) {
        try {
          var sheet = document.styleSheets[i];
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
            href: sheet.href || '(inline)',
            totalRules: total,
            usedRules: used,
            unusedRules: total - used,
            coveragePercent: total > 0 ? Math.round(used / total * 100) : 100,
            unusedSelectors: unused.slice(0, 20),
          });
        } catch(e) {
          results.push({ href: sheet.href || '(inline)', error: 'CORS blocked' });
        }
      }
      return JSON.stringify(results);
    })()`
  );
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
    const sel = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found: ${sel}';el.scrollIntoView({behavior:'smooth',block:'${block}'});var r=el.getBoundingClientRect();return 'Scrolled to: '+el.tagName+' at y='+Math.round(r.y);})()`
    );
  }
  if (text) {
    // Virtual DOM scroll: scroll down repeatedly until text appears (for Airtable, etc.)
    const safeText = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return runJS(
      `(async function(){
        var deadline = Date.now() + ${Number(timeout)};
        var scrollable = document.querySelector('[class*="grid"],[class*="virtual"],[class*="scroll"],[role="grid"],[role="table"]') || document.scrollingElement || document.documentElement;
        var lastY = -1;
        while (Date.now() < deadline) {
          // Check if text exists in DOM
          var tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
          while(tw.nextNode()){
            if(tw.currentNode.textContent.trim().includes('${safeText}')){
              var el = tw.currentNode.parentElement;
              el.scrollIntoView({behavior:'smooth',block:'${block}'});
              return 'Found and scrolled to: "' + el.textContent.trim().substring(0,50) + '"';
            }
          }
          // Scroll down
          var curY = scrollable.scrollTop;
          if (curY === lastY) return 'Text not found: ${safeText} (scrolled to bottom)';
          lastY = curY;
          scrollable.scrollBy(0, 500);
          await new Promise(function(r){setTimeout(r,300)});
        }
        return 'Timeout: text not found within ${timeout}ms';
      })()`,
      { timeout: timeout + 5000 }
    );
  }
  throw new Error("scrollToElement requires selector or text");
}

// ========== COMBO TOOLS (multi-step operations in a single call) ==========

// Navigate + wait + read — the most common 3-step workflow
export async function navigateAndRead(url, { maxLength = 50000 } = {}) {
  await refreshTargetWindow();
  // Suppress onbeforeunload dialogs (same as navigate())
  await runJS("window.onbeforeunload=null", { timeout: 2000 }).catch(() => {});
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;
  const safeUrl = targetUrl.replace(/"/g, '\\"');
  const navTarget = _activeTabIndex ? `tab ${_activeTabIndex} of ${getTargetWindowRef()}` : getFallbackTarget();
  await osascriptFast(`tell application "Safari" to set URL of ${navTarget} to "${safeUrl}"`);
  _activeTabURL = targetUrl;
  // Single JS call: poll readyState + return page data — 1 call instead of 30+
  const navResult = await runJS(
    `(async function(){
      for(var i=0;i<60;i++){
        if(document.readyState==='complete')break;
        await new Promise(function(r){setTimeout(r,i<10?200:500)});
      }
      return JSON.stringify({title:document.title,url:location.href,text:document.body.innerText.substring(0,${Number(maxLength)})});
    })()`,
    { timeout: 30000 }
  );
  // Update _activeTabURL with the actual URL after navigation
  try {
    const parsed = JSON.parse(navResult);
    if (parsed.url && parsed.url !== 'about:blank') _activeTabURL = parsed.url;
  } catch {}
  return navResult;
}

// Click + wait for navigation or element — common after clicking a link/button
export async function clickAndWait({ selector, text, waitFor: waitSelector, timeout = 10000 }) {
  const safeSel = selector ? selector.replace(/'/g, "\\'") : "";
  const safeText = text ? text.replace(/'/g, "\\'") : "";
  const safeWait = waitSelector ? waitSelector.replace(/'/g, "\\'") : "";
  // Single JS call: click + wait — 1 call instead of 20+
  return runJS(
    `(async function(){
      // Find and click
      var el;
      ${safeSel ? `el = document.querySelector('${safeSel}');` : ""}
      ${safeText && !safeSel ? `
        el = [...document.querySelectorAll('a,button,[role=button],label,[onclick]')].find(function(e){return e.textContent.trim().includes('${safeText}');});
        if(!el) el = [...document.querySelectorAll('*')].filter(function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.textContent.trim().includes('${safeText}');}).sort(function(a,b){return a.textContent.length-b.textContent.length;})[0];
      ` : ""}
      if(!el) return JSON.stringify({error:'Element not found'});
      el.scrollIntoView({block:'center'});
      el.click();
      // Wait
      var deadline = Date.now() + ${Number(timeout)};
      ${safeWait ? `
        while(Date.now()<deadline){
          if(document.querySelector('${safeWait}'))break;
          await new Promise(function(r){setTimeout(r,200)});
        }
      ` : `
        await new Promise(function(r){setTimeout(r,300)});
        while(Date.now()<deadline){
          if(document.readyState==='complete')break;
          await new Promise(function(r){setTimeout(r,200)});
        }
      `}
      return JSON.stringify({title:document.title,url:location.href,clicked:el.tagName+' "'+el.textContent.trim().substring(0,50)+'"'});
    })()`,
    { timeout: timeout + 5000 }
  );
}

// Fill form + submit — common for login, search, etc.
export async function fillAndSubmit({ fields, submitSelector }) {
  await fillForm({ fields });
  if (submitSelector) {
    const sel = submitSelector.replace(/'/g, "\\'");
    await runJS(
      `(function(){var el=document.querySelector('${sel}');if(el)el.click();})()`
    );
  } else {
    // Auto-find and click submit button
    await runJS(
      `(function(){var btn=document.querySelector('[type=submit],button:not([type])');if(btn)btn.click();})()`
    );
  }
  // Wait for navigation/reload via inline JS (not fixed sleep)
  return runJS(
    `(async function(){
      await new Promise(function(r){setTimeout(r,300)});
      for(var i=0;i<30;i++){if(document.readyState==='complete')break;await new Promise(function(r){setTimeout(r,200)});}
      return JSON.stringify({title:document.title,url:location.href});
    })()`,
    { timeout: 15000 }
  );
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
