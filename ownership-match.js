// ownership-match.js — pure tab-ownership matching + TTL pruning for safari-mcp.
// Extracted from index.js so the safety-critical semantics are unit-testable
// (test/ownership-match.test.mjs locks them):
//   • exact match, then normalized match (query / fragment / trailing slashes ignored)
//   • same-origin path-prefix match REQUIRES a path-segment boundary —
//     owning /org must never own /org-evil
//   • the blank-tab sentinel (not a parseable URL) never matches a real page
// Keep this file dependency-free.

/** Strip query, fragment and trailing slashes. */
export function normalizeURL(u) {
  return u.split("?")[0].split("#")[0].replace(/\/+$/, "");
}

/**
 * Find which owned entry matches `url`.
 * Returns the matching owned entry (so the caller can touch its TTL timestamp),
 * or null when the URL is not owned.
 * @param {string} url
 * @param {Iterable<string>} ownedUrls
 * @returns {string|null}
 */
export function findOwnedMatch(url, ownedUrls) {
  if (!url) return null;
  const ownedSet = ownedUrls instanceof Set ? ownedUrls : new Set(ownedUrls);
  if (ownedSet.has(url)) return url;
  // Match ignoring query params / fragments / trailing slashes (the URL may change
  // slightly after load).
  const urlBase = normalizeURL(url);
  for (const owned of ownedSet) {
    if (urlBase === normalizeURL(owned)) return owned;
  }
  // Same-origin redirect: a tab that navigated from an owned URL to a deeper path
  // on the same origin (e.g. /login/device → /login/device/select_account) is still
  // ours. The "+ '/'" boundary is load-bearing: owning /org must NOT own /org-evil.
  // (A broader "own anything on the origin" rule used to exist and defeated
  // tab-safety entirely — see CHANGELOG v2.12.0.)
  try {
    const urlOrigin = new URL(url).origin;
    for (const owned of ownedSet) {
      try {
        if (new URL(owned).origin === urlOrigin && urlBase.startsWith(normalizeURL(owned) + "/")) return owned;
      } catch { /* owned entry isn't a parseable URL (e.g. the blank-tab sentinel) */ }
    }
  } catch { /* url isn't parseable — no origin-based matching possible */ }
  return null;
}

/**
 * Remove entries whose timestamp is older than ttlMs from BOTH structures, in place.
 * @param {Set<string>} ownedUrls
 * @param {Map<string, number>} timestamps
 * @param {number} ttlMs
 * @param {number} [now]
 * @returns {boolean} whether anything was removed
 */
export function pruneExpired(ownedUrls, timestamps, ttlMs, now = Date.now()) {
  const cutoff = now - ttlMs;
  let changed = false;
  for (const [url, ts] of timestamps) {
    if (ts <= cutoff) {
      ownedUrls.delete(url);
      timestamps.delete(url);
      changed = true;
    }
  }
  return changed;
}
