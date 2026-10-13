/**
 * Contexts that still run an older build (#143).
 *
 * Replacing the extension app does not stop the contexts Safari had already started, and Safari
 * keeps the context of every app generation it ever loaded (13.10.26: its process had the
 * resources of a dozen builds mapped, among them deleted ones). Each wakes every minute, verifies
 * and becomes the daemon's lease holder, each with its own in-memory receipts, so a lease that
 * moves between an old context and a new one loses the receipts the other minted.
 *
 * Reloading an old context does not remove it: it restarts the same old generation, so the stream
 * of old contexts never ends (45 reloads in 90 minutes). What the daemon controls is who leads.
 * A worker that announced no build never takes the lease while a current one has verified within
 * `LEASE_BUILD_PREFERENCE_MS`, and a current one takes it from an old holder at once. Reloading
 * is the fallback for when no current context is around at all: the reload restarts the context
 * from the app now on disk, and the replacement announces the build.
 *
 * A worker that announces any build is never reloaded here, so a newer extension talking to an
 * older daemon is left alone. The rate limit bounds the damage if a reload ever fails to change
 * the code the worker runs.
 */

/** Sent by the extension on `/connect` (`&build=`). Absent on every older build. */
export const EXTENSION_BUILD = "isolated-envelopes-1";

/** How long after a current context verified the daemon keeps older ones away from the lease. */
export const LEASE_BUILD_PREFERENCE_MS = 15 * 60_000;

/**
 * How long the context that leads (the home context) may stay silent before another current
 * context may lead. Its instances wake on a one-minute alarm, so this is a little over one cycle.
 */
export const HOME_CONTEXT_ALIVE_MS = 100_000;

/**
 * Whether the builds and contexts alone settle who may lead. The caller still applies its other
 * rules (a command in flight, a reload handoff) before acting on "take".
 *   deny      an older context while a current one is around, or a current context while another
 *             current one (the home context, by extension origin) is alive: it never leads
 *   take      a current context against a holder from an older app: replace it, even while it polls
 *   ordinary  the usual rule decides (the holder has been quiet for a while)
 *
 * Several current contexts can be alive at once as well, and each has tab ids of its own: a receipt
 * resolves only in the context that minted it, and a write from another context erased it from the
 * shared envelope (13.10.26). Their requests carry different extension origins, so the first current
 * context to lead stays the one that leads while it is alive.
 * @param {{ candidateBuild: string, holderBuild: string, hasHolder: boolean, currentSeenRecently: boolean,
 *   candidateOrigin?: string, homeOrigin?: string, homeAlive?: boolean }} s
 * @returns {"deny" | "take" | "ordinary"}
 */
export function leaseBuildVerdict({
  candidateBuild, holderBuild, hasHolder, currentSeenRecently,
  candidateOrigin = "", homeOrigin = "", homeAlive = false,
}) {
  if (!candidateBuild && currentSeenRecently) return "deny";
  if (candidateBuild && homeAlive && homeOrigin && candidateOrigin !== homeOrigin) return "deny";
  if (candidateBuild && hasHolder && !holderBuild) return "take";
  return "ordinary";
}

/**
 * `check` decides without recording anything; `commit` records an attempt once the reload is
 * really about to be sent. A "no" for busy or too soon is only for now: the daemon asks again on
 * every poll of the lease holder, which is what keeps a context that verified at a busy moment
 * from staying the lease holder for good.
 * @param {{ now?: () => number, minGapMs?: number, windowMs?: number, maxPerWindow?: number }} [options]
 * @returns {{ check: (worker: { build: string, active: boolean, busy: boolean }) => { reload: boolean, reason: string }, commit: () => void }}
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
      if (build) return { reload: false, reason: "announced a build" };
      if (!active) return { reload: false, reason: "not the lease holder" };
      const t = now();
      prune(t);
      if (attempts.length >= maxPerWindow) return { reload: false, reason: "reload limit reached" };
      if (busy) return { reload: false, reason: "a command is in flight" };
      if (attempts.length && t - attempts[attempts.length - 1] < minGapMs) return { reload: false, reason: "reloaded one a moment ago" };
      return { reload: true, reason: "no build announced" };
    },
    commit() {
      const t = now();
      prune(t);
      attempts.push(t);
    },
  };
}
