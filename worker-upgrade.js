/**
 * Retiring extension contexts that still run an older build (#143).
 *
 * Replacing the extension app does not stop the contexts Safari had already started: they stay
 * alive, each with its own in-memory receipts, and each becomes the daemon's lease holder again
 * every time it verifies. A lease that moves between an old context and a new one loses the
 * receipts the other minted. Every worker that holds the lease passes through verification, so
 * the daemon reloads it there, once, when it did not announce a build: the reload restarts that
 * context from the app now on disk, and the replacement announces the build.
 *
 * A worker that announces any build is never reloaded here, so a newer extension talking to an
 * older daemon is left alone. The rate limit bounds the damage if a reload ever fails to change
 * the code the worker runs.
 */

/** Sent by the extension on `/connect` (`&build=`). Absent on every older build. */
export const EXTENSION_BUILD = "isolated-envelopes-1";

/**
 * `check` decides without recording anything; `commit` records an attempt once the reload is
 * really about to be sent. `retry` says the answer may change soon: a command in flight or a
 * reload a moment ago only delays the reload while the worker stays the lease holder.
 * @param {{ now?: () => number, minGapMs?: number, windowMs?: number, maxPerWindow?: number }} [options]
 * @returns {{ check: (worker: { build: string, active: boolean, busy: boolean }) => { reload: boolean, retry: boolean, reason: string }, commit: () => void }}
 */
export function createStaleWorkerPolicy({
  now = Date.now,
  minGapMs = 20_000,
  windowMs = 10 * 60_000,
  maxPerWindow = 10,
} = {}) {
  /** @type {number[]} */
  const attempts = [];
  const prune = (t) => { while (attempts.length && t - attempts[0] > windowMs) attempts.shift(); };
  return {
    check({ build, active, busy }) {
      if (build) return { reload: false, retry: false, reason: "announced a build" };
      if (!active) return { reload: false, retry: false, reason: "not the lease holder" };
      const t = now();
      prune(t);
      if (attempts.length >= maxPerWindow) return { reload: false, retry: false, reason: "reload limit reached" };
      if (busy) return { reload: false, retry: true, reason: "a command is in flight" };
      if (attempts.length && t - attempts[attempts.length - 1] < minGapMs) return { reload: false, retry: true, reason: "reloaded one a moment ago" };
      return { reload: true, retry: false, reason: "no build announced" };
    },
    commit() {
      const t = now();
      prune(t);
      attempts.push(t);
    },
  };
}
