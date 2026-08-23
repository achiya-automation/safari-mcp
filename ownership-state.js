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
import { findOwnedMatch, pruneExpired, hasDurableReceipt } from "./ownership-match.js";

// MCP opens tabs, but a restart re-triggers "Tab safety: no tabs opened yet" errors forcing
// a re-open of every tab. Persist the set to a JSON file with a TTL so tabs remain "owned"
// across process restarts for up to OWNERSHIP_TTL_MS.
export const OWNERSHIP_DIR = join(homedir(), ".safari-mcp");
export const OWNERSHIP_FILE = join(OWNERSHIP_DIR, "owned-tabs.json");
export const OWNERSHIP_TTL_MS = 30 * 60 * 1000; // 30 minutes — plain URLs (can collide with a user tab)
// Receipt-bearing tabs (#mcp-tab=<12+ opaque chars>) get a much longer window. The marker is
// unguessable, so ageing never makes it match someone else's page; the short TTL only ever
// broke long-running jobs mid-way (GBP publish, 2026-08-23: a tab opened at the start became
// un-switchable ~35min in, while still carrying our own marker).
export const RECEIPT_OWNERSHIP_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export function _loadOwnershipFile() {
  try {
    if (!existsSync(OWNERSHIP_FILE)) return [];
    const raw = readFileSync(OWNERSHIP_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const now = Date.now();
    const cutoff = now - OWNERSHIP_TTL_MS;
    const receiptCutoff = now - RECEIPT_OWNERSHIP_TTL_MS;
    // Same tiering as _pruneExpiredOwnership — otherwise a daemon restart (which reloads from
    // disk) silently drops receipt-bearing tabs after 30min even though the in-memory path
    // would have kept them, and every write tool on that tab starts failing.
    return data.filter(
      (e) => e && typeof e.url === "string" && typeof e.ts === "number" &&
        e.ts > (hasDurableReceipt(e.url) ? receiptCutoff : cutoff)
    );
  } catch {
    return [];
  }
}

export function _saveOwnershipFile(urls, removed = []) {
  try {
    if (!existsSync(OWNERSHIP_DIR)) mkdirSync(OWNERSHIP_DIR, { recursive: true });
    const now = Date.now();
    // Merge with disk before writing (#82): this file is shared by every instance on the
    // machine, and a snapshot of only THIS process's Set silently drops entries concurrent
    // instances added after we hydrated. Union disk+local (newest ts wins), then apply this
    // write's explicit removals so deletions propagate instead of being resurrected by the
    // merge. _loadOwnershipFile() TTL-filters, so expired disk entries fall away here too.
    // Residual race: two writers between read and rename can still drop one entry — that
    // window is sub-millisecond (was: entire process lifetime) and losing an entry is
    // fail-safe: ownership is lost, so a tool refuses; it never gains a user's tab.
    const mergedTs = new Map();
    for (const e of _loadOwnershipFile()) mergedTs.set(e.url, e.ts);
    for (const url of urls) {
      const localTs = _ownedTabTimestamps.get(url) ?? now;
      mergedTs.set(url, Math.max(localTs, mergedTs.get(url) ?? 0));
    }
    for (const url of removed) mergedTs.delete(url);
    const entries = Array.from(mergedTs, ([url, ts]) => ({ url, ts }));
    // Atomic write (tmp + rename) — a partial write from one instance must never corrupt
    // the JSON another instance reads.
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
  const before = new Set(_ownedTabURLs);
  if (pruneExpired(_ownedTabURLs, _ownedTabTimestamps, OWNERSHIP_TTL_MS, Date.now(), RECEIPT_OWNERSHIP_TTL_MS)) {
    // Pass the pruned URLs as explicit removals so the merge-on-write in
    // _saveOwnershipFile doesn't resurrect them from the disk copy.
    const removed = [...before].filter((u) => !_ownedTabURLs.has(u));
    _saveOwnershipFile(_ownedTabURLs, removed);
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

// Destructive recovery must never inherit the broader same-path matching used by
// normal navigation. It needs the exact marked URL that new_tab persisted.
export function _isExactURLOwned(url) {
  if (!url) return false;
  _pruneExpiredOwnership();
  return _ownedTabURLs.has(url) ? _touchOwned(url) : false;
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
    _saveOwnershipFile(_ownedTabURLs, [url]);
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
