// worker-ledger.js — per-worker bookkeeping for the extension bridge.
//
// "3 extension workers connected but none proved profile" (#109) named nothing: not which
// workers, not what each one announced, not what the profile probe answered them. The
// only way to diagnose that outage was sqlite on Safari's extension storage. This ledger
// keeps the last MAX_WORKERS workers with what each did, so the warning and safari_doctor
// can say it instead. Pure data — no timers, no I/O — so it is unit-testable.

export const MAX_WORKERS = 16;

export function createLedger() {
  return new Map();
}

function _entry(ledger, workerId, now) {
  let entry = ledger.get(workerId);
  if (!entry) {
    entry = {
      firstSeen: now,
      lastSeen: now,
      connects: 0,
      rejected: null,
      verdicts: [],
      verifiedAt: 0,
    };
    ledger.set(workerId, entry);
    // ponytail: evict the oldest by lastSeen; a Safari with four profiles never exceeds
    // four live workers, so this only bounds a reload storm.
    while (ledger.size > MAX_WORKERS) {
      let oldestId = null;
      for (const [id, e] of ledger)
        if (oldestId === null || e.lastSeen < ledger.get(oldestId).lastSeen) oldestId = id;
      ledger.delete(oldestId);
    }
  }
  entry.lastSeen = now;
  return entry;
}

// A worker POSTed /connect. `rejected` is the {verifier, protocol} it announced when the
// host answered 426, null when the announcement was accepted.
export function noteConnect(ledger, workerId, { rejected = null, now = Date.now() } = {}) {
  const entry = _entry(ledger, workerId, now);
  entry.connects += 1;
  entry.rejected = rejected ? { ...rejected, at: now } : null;
  return entry;
}

// The host answered a /verify-profile probe: "match", "wrong:<window name>", "notfound"
// or "error:<message>". Kept as the last three distinct verdicts.
export function noteVerdict(ledger, workerId, verdict, now = Date.now()) {
  const entry = _entry(ledger, workerId, now);
  const text = String(verdict || "").slice(0, 160);
  const isNew =
    entry.verdicts.length === 0 || entry.verdicts[entry.verdicts.length - 1].text !== text;
  if (isNew) {
    entry.verdicts.push({ text, at: now });
    if (entry.verdicts.length > 3) entry.verdicts.shift();
  } else {
    entry.verdicts[entry.verdicts.length - 1].at = now;
  }
  return isNew;
}

export function noteVerified(ledger, workerId, now = Date.now()) {
  _entry(ledger, workerId, now).verifiedAt = now;
}

function _ago(then, now) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

// One line per worker, newest first. `activeWorkerId` marks the worker currently holding
// the profile lease.
export function summarize(ledger, { now = Date.now(), activeWorkerId = "" } = {}) {
  const lines = [];
  const entries = [...ledger.entries()].sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  for (const [id, e] of entries) {
    const parts = [`connected ${e.connects}× (last ${_ago(e.lastSeen, now)})`];
    if (e.rejected) {
      parts.push(
        `REJECTED 426 — announced verifier="${e.rejected.verifier || ""}" protocol="${e.rejected.protocol || ""}": a worker from an older build that Safari is still running`
      );
    } else if (e.verdicts.length) {
      parts.push(
        `profile probe answered ${e.verdicts.map((v) => `${JSON.stringify(v.text)} (${_ago(v.at, now)})`).join(", then ")}`
      );
    } else if (e.verifiedAt) {
      parts.push("verified from its stored identity without a probe");
    } else {
      parts.push(
        "never asked for a profile probe (its stored identity already ruled this host out, or it went silent first)"
      );
    }
    if (e.verifiedAt) parts.push(`verified ${_ago(e.verifiedAt, now)}`);
    if (id === activeWorkerId) parts.push("← holds the lease");
    lines.push(`${id.slice(0, 8)}: ${parts.join("; ")}`);
  }
  return lines;
}

// Mirrors extension/background.js `_canonicalProfileName`: a stored identity of
// "<profile> — <tab title>" reduces to the bare profile name.
export function canonicalProfileName(value) {
  let name = String(value || "")
    .normalize("NFC")
    .trim();
  if (!name || name === "notfound" || name === "__personal__") return "";
  name = name.replace(/^wrong:/, "").trim();
  const titleSeparator = name.indexOf(" — ");
  if (titleSeparator > 0) name = name.slice(0, titleSeparator);
  return name.normalize("NFC").trim();
}

// storage.local persists JSON-encoded values; an unparseable cell is shown as-is.
function _storedString(cell) {
  try {
    return String(JSON.parse(cell || '""'));
  } catch {
    return String(cell || "");
  }
}

export const SAFARI_EXTENSION_STORAGE_GLOB =
  "Library/Containers/com.apple.Safari/Data/Library/WebKit/WebExtensions";

// Reads what every Safari profile's copy of the extension has persisted: its identity,
// its last heartbeat and its badge status. Read-only (`sqlite3 -readonly`, and the -wal is
// picked up). Throws only when Safari's container itself cannot be listed (typically
// macOS denying this process access to it); a missing sqlite3 or a locked file just
// skips that profile. `deps` is injectable for tests.
export async function readProfileIdentities({
  home = "",
  now = Date.now(),
  readdir = null, // async (dir) => string[]
  runSqlite = null, // async (dbPath) => "key|value\n…"
  extensionPrefix = "com.achiya-automation.safari-mcp.Extension",
} = {}) {
  if (!home || !readdir || !runSqlite) return [];
  const root = `${home}/${SAFARI_EXTENSION_STORAGE_GLOB}`;
  const containers = await readdir(root);
  const out = [];
  for (const container of containers) {
    let names;
    try {
      names = await readdir(`${root}/${container}`);
    } catch {
      continue;
    }
    const dir = names.find((n) => n.startsWith(extensionPrefix));
    if (!dir) continue;
    const db = `${root}/${container}/${dir}/LocalStorage.db`;
    let rows;
    try {
      rows = await runSqlite(db);
    } catch {
      continue;
    }
    const kv = {};
    for (const line of String(rows || "").split("\n")) {
      const sep = line.indexOf("|");
      if (sep > 0) kv[line.slice(0, sep)] = line.slice(sep + 1);
    }
    const identity = _storedString(kv.mcpVerifiedProfile);
    const status = _storedString(kv.mcpStatus);
    const heartbeat = Number.parseInt(kv._heartbeat || "", 10);
    out.push({
      container,
      identity,
      canonical: canonicalProfileName(identity),
      status,
      heartbeatAgeMs: Number.isFinite(heartbeat) ? Math.max(0, now - heartbeat) : null,
    });
  }
  return out;
}

export function describeProfileIdentities(list, { profile = "", error = null } = {}) {
  if (error) {
    const code = String(error.code || "");
    return [
      code === "EPERM" || code === "EACCES"
        ? `extension storage: macOS denied this process access to Safari's container (${code}) — grant Full Disk Access to ${process.ppid === 1 ? "node (this server runs under launchd)" : "the terminal/IDE that launched this server"} to see each profile's stored identity here`
        : `extension storage: not readable (${code || String(error.message || error).slice(0, 60)})`,
    ];
  }
  if (!list.length)
    return [
      "extension storage: no Safari profile has this extension's storage yet (or sqlite3 is missing)",
    ];
  const lines = [];
  for (const p of list) {
    const alive =
      p.heartbeatAgeMs === null
        ? "no heartbeat"
        : p.heartbeatAgeMs < 90000
          ? `heartbeat ${Math.round(p.heartbeatAgeMs / 1000)}s ago`
          : `heartbeat ${Math.round(p.heartbeatAgeMs / 60000)} min ago — worker parked or dead`;
    const stored = p.identity ? JSON.stringify(p.identity) : "(none — never proved a profile)";
    const suffix =
      p.identity && p.identity !== p.canonical
        ? ` = ${JSON.stringify(p.canonical)} after canonicalization; an extension older than 2.10.24 cannot reduce this itself (#109) and rejects the profile`
        : "";
    const mine = profile && p.canonical === profile ? " ← this host's profile" : "";
    lines.push(
      `${p.container.slice(0, 8)}: stored identity ${stored}${suffix}; ${alive}; badge ${p.status || "unknown"}${mine}`
    );
  }
  return lines;
}
