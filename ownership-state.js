// Tab-ownership state + tracking — the security-critical core that prevents the MCP
// session from operating on the USER's tabs. Extracted verbatim from index.js so the
// state and its helpers live in one reviewable, test-locked module (see
// tests/ownership-state.test.mjs). The pure matching/pruning semantics live next door in
// ownership-match.js; this module owns the *stateful* layer on top of them: the in-memory
// sets, the on-disk persistence (so ownership survives MCP restarts), and the TTL.
//
// Every symbol here was previously a module-level binding in index.js. All exported state
// is `const` (Map/Set) — mutated, never reassigned — so ESM live bindings keep index.js and
// any future src/tools/* module pointing at the exact same objects.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findOwnedMatch, pruneExpired } from "./ownership-match.js";

// MCP opens tabs, but a restart re-triggers "Tab safety: no tabs opened yet" errors forcing
// a re-open of every tab. Persist the set to a JSON file with a TTL so tabs remain "owned"
// across process restarts for up to OWNERSHIP_TTL_MS.
export const OWNERSHIP_DIR = join(homedir(), ".safari-mcp");
export const OWNERSHIP_FILE = join(OWNERSHIP_DIR, "owned-tabs.json");
export const OWNERSHIP_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function _loadOwnershipFile() {
  try {
    if (!existsSync(OWNERSHIP_FILE)) return [];
    const raw = readFileSync(OWNERSHIP_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const cutoff = Date.now() - OWNERSHIP_TTL_MS;
    return data.filter(
      (e) => e && typeof e.url === "string" && typeof e.ts === "number" && e.ts > cutoff
    );
  } catch {
    return [];
  }
}

export function _saveOwnershipFile(urls) {
  try {
    if (!existsSync(OWNERSHIP_DIR)) mkdirSync(OWNERSHIP_DIR, { recursive: true });
    const now = Date.now();
    const entries = Array.from(urls).map((url) => ({
      url,
      ts: _ownedTabTimestamps.get(url) ?? now,
    }));
    // Atomic write (tmp + rename) — concurrent MCP instances share this file; a partial
    // write from one must never corrupt the JSON another instance reads.
    const tmp = OWNERSHIP_FILE + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    renameSync(tmp, OWNERSHIP_FILE);
  } catch {
    /* best-effort */
  }
}

// Track tabs opened by THIS session (index → {url, openedAt})
export const _openedTabs = new Map();

// ========== TAB OWNERSHIP: prevent operating on user's tabs ==========
// Tracks URLs of tabs opened by this MCP session.
// Any tool that modifies a tab (navigate, click, fill, etc.) is blocked
// unless the current tab was opened via safari_new_tab.
// Hydrated from ~/.safari-mcp/owned-tabs.json so ownership survives MCP restarts.
export const _ownedTabURLs = new Set();
// Preserve each entry's ORIGINAL timestamp so _saveOwnershipFile doesn't reset it to `now` on
// every write — otherwise the 30-min TTL never expires anything while a session is active, and
// stale ownership leaks onto the user's tabs across sessions.
export const _ownedTabTimestamps = new Map();
for (const e of _loadOwnershipFile()) {
  _ownedTabURLs.add(e.url);
  _ownedTabTimestamps.set(e.url, e.ts);
}

// Touch-on-use + live TTL enforcement. The TTL exists so ownership doesn't outlive the
// session's actual use of a tab: entries the session keeps asserting against stay fresh;
// abandoned entries expire after OWNERSHIP_TTL_MS and can no longer match a user's tab.
// (Previously the TTL was only applied when loading the file at startup, so a long-lived
// session accumulated ownership forever.)
export function _touchOwned(ownedKey) {
  _ownedTabTimestamps.set(ownedKey, Date.now());
  return true;
}
export function _pruneExpiredOwnership() {
  if (pruneExpired(_ownedTabURLs, _ownedTabTimestamps, OWNERSHIP_TTL_MS)) {
    _saveOwnershipFile(_ownedTabURLs);
  }
}

// Matching semantics (exact / normalized / same-origin path-prefix with a segment
// boundary) live in ownership-match.js, where test/ownership-match.test.mjs locks
// them — including that owning /org never owns /org-evil, and that the broad
// "own the whole origin" rule stays dead (it defeated tab-safety entirely).
export function _isURLOwned(url) {
  if (!url) return false;
  _pruneExpiredOwnership();
  const match = findOwnedMatch(url, _ownedTabURLs);
  return match !== null ? _touchOwned(match) : false;
}

// Sentinel persisted when a blank tab (about:blank) is opened by this session.
// A blank tab has no unique URL to own, but ownership must still survive an MCP
// process restart (_openedTabs is in-memory only) — otherwise reopening blank
// tabs falsely trips the "no tabs opened yet" guard. The sentinel is never a
// real tab URL, so it cannot falsely match a user's page in _isURLOwned().
export const BLANK_TAB_SENTINEL = "__mcp-blank-tab__";

export function _markBlankTabOpened() {
  if (!_ownedTabURLs.has(BLANK_TAB_SENTINEL)) {
    _ownedTabTimestamps.set(BLANK_TAB_SENTINEL, Date.now());
    _ownedTabURLs.add(BLANK_TAB_SENTINEL);
    _saveOwnershipFile(_ownedTabURLs);
  }
}

export function _addOwnedURL(url) {
  if (url && url !== "about:blank" && url !== "favorites://") {
    if (!_ownedTabTimestamps.has(url)) _ownedTabTimestamps.set(url, Date.now());
    _ownedTabURLs.add(url);
    _saveOwnershipFile(_ownedTabURLs);
  }
}

export function _removeOwnedURL(url) {
  if (url) {
    _ownedTabURLs.delete(url);
    _ownedTabTimestamps.delete(url);
    _saveOwnershipFile(_ownedTabURLs);
  }
}

export function _trackTab(tabIndex, url) {
  _openedTabs.set(tabIndex, { url: url || "", openedAt: Date.now() });
  _addOwnedURL(url);
}

export function _untrackTab(tabIndex) {
  const info = _openedTabs.get(tabIndex);
  if (info?.url) _removeOwnedURL(info.url);
  _openedTabs.delete(tabIndex);
}
