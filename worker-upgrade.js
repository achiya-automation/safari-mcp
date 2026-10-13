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
 * @param {{ now?: () => number, minGapMs?: number, windowMs?: number, maxPerWindow?: number }} [options]
 * @returns {(worker: { build: string, active: boolean, busy: boolean }) => { reload: boolean, reason: string }}
 */
export function createStaleWorkerPolicy({
  now = Date.now,
  minGapMs = 20_000,
  windowMs = 10 * 60_000,
  maxPerWindow = 10,
} = {}) {
  /** @type {number[]} */
  const attempts = [];
  return function decide({ build, active, busy }) {
    if (build) return { reload: false, reason: "announced a build" };
    if (!active) return { reload: false, reason: "not the lease holder" };
    if (busy) return { reload: false, reason: "a command is in flight" };
    const t = now();
    while (attempts.length && t - attempts[0] > windowMs) attempts.shift();
    if (attempts.length && t - attempts[attempts.length - 1] < minGapMs) return { reload: false, reason: "reloaded one a moment ago" };
    if (attempts.length >= maxPerWindow) return { reload: false, reason: "reload limit reached" };
    attempts.push(t);
    return { reload: true, reason: "no build announced" };
  };
}
