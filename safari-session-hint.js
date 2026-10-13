/**
 * The identity of the running Safari process, as the daemon sees it.
 *
 * A tab receipt is valid for one browser session: Safari hands out tab ids afresh after a
 * restart, so a receipt minted before one must never be taken for a tab after it. The
 * extension used to name the session itself, with a value kept in `storage.session`. Safari
 * gives every extension worker instance its own `storage.session`, so that value rotated
 * with each worker succession (and differed between instances alive together), and the next
 * tab removal rewrote the shared receipt envelope under a different epoch and dropped every
 * receipt the previous one held (#143).
 *
 * The daemon names the session instead. "<pid>:<start time>" of the Safari process is the
 * same for every worker, survives every worker restart, and changes exactly when Safari
 * itself restarts. The extension derives its epoch from it.
 */
import { execFileSync } from "node:child_process";

const HINT_RE = /^\d{1,8}:[ -~]{8,40}$/;

/**
 * "<pid>:<lstart>" when both are well formed, otherwise "" (the caller sends no hint).
 * @param {unknown} pid
 * @param {unknown} lstart
 */
export function formatSafariSessionHint(pid, lstart) {
  const id = String(pid ?? "").trim();
  const started = String(lstart ?? "").trim().replace(/\s+/g, " ");
  const hint = `${id}:${started}`;
  return /^\d{1,8}$/.test(id) && HINT_RE.test(hint) ? hint : "";
}

/**
 * The oldest process named exactly `Safari`; helper processes carry other names.
 * @param {(file: string, args: string[], options?: object) => string | Buffer} [run]
 */
export function readSafariSessionHintSync(run = /** @type {any} */ (execFileSync)) {
  try {
    const pid = String(run("/usr/bin/pgrep", ["-o", "-x", "Safari"], { encoding: "utf8", timeout: 2000 }))
      .trim().split("\n")[0];
    if (!/^\d+$/.test(pid)) return "";
    const lstart = run("/bin/ps", ["-o", "lstart=", "-p", pid], { encoding: "utf8", timeout: 2000 });
    return formatSafariSessionHint(pid, lstart);
  } catch {
    return ""; // pgrep exits 1 when Safari is not running
  }
}

/**
 * A reader that re-asks at most once per `ttlMs`. Polls from many workers arrive every few
 * seconds; the process table is read once a second at most, synchronously, so that the
 * first response after Safari relaunches already carries the new identity.
 */
export function createSafariSessionHintReader({
  ttlMs = 1000,
  read = readSafariSessionHintSync,
  now = Date.now,
} = {}) {
  let value = "";
  let at = -Infinity;
  return function currentSafariSessionHint() {
    const t = now();
    if (t - at >= ttlMs) {
      value = read();
      at = t;
    }
    return value;
  };
}
