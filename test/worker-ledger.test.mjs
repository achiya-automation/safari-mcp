#!/usr/bin/env node
/**
 * The extension-bridge ledger behind "N workers connected but none proved profile" and
 * the safari_doctor bridge section (#109). On 2026-09-20 four workers were alive and
 * heartbeating, the target profile's worker never proved itself, and the warning named
 * none of them — this pins that the ledger and the storage reader say who did what.
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  MAX_WORKERS,
  createLedger,
  noteConnect,
  noteVerdict,
  noteVerified,
  summarize,
  canonicalProfileName,
  readProfileIdentities,
  describeProfileIdentities,
} from "../worker-ledger.js";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

const T0 = 1_789_885_000_000;
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

test("summarize names every worker with what it announced and what the probe answered", () => {
  const ledger = createLedger();
  noteConnect(ledger, A, { now: T0 });
  noteConnect(ledger, A, { now: T0 + 5000 });
  assert.equal(
    noteVerdict(ledger, A, "wrong:עבודה — mcp-profile-check-1789885069020", T0 + 6000),
    true
  );
  assert.equal(
    noteVerdict(ledger, A, "wrong:עבודה — mcp-profile-check-1789885069020", T0 + 6500),
    false,
    "a repeat verdict is not news"
  );
  noteConnect(ledger, B, {
    rejected: { verifier: "visible-tab-v0", protocol: "" },
    now: T0 + 7000,
  });
  noteConnect(ledger, C, { now: T0 + 8000 });
  noteVerified(ledger, C, T0 + 8500);

  const lines = summarize(ledger, { now: T0 + 10000, activeWorkerId: C });
  assert.equal(lines.length, 3);
  assert.match(
    lines[0],
    /^cccccccc: connected 1× \(last 2s ago\); verified from its stored identity without a probe; verified 2s ago; ← holds the lease$/
  );
  assert.match(
    lines[1],
    /^bbbbbbbb: connected 1× \(last 3s ago\); REJECTED 426 — announced verifier="visible-tab-v0" protocol="": a worker from an older build/
  );
  assert.match(
    lines[2],
    /^aaaaaaaa: connected 2× \(last 4s ago\); profile probe answered "wrong:עבודה — mcp-profile-check-1789885069020" \(4s ago\)$/
  );
});

test("a worker that connected but never probed is described as such, and the ledger is bounded", () => {
  const ledger = createLedger();
  for (let i = 0; i < MAX_WORKERS + 4; i++)
    noteConnect(ledger, String(i).padStart(32, "0"), { now: T0 + i });
  assert.equal(ledger.size, MAX_WORKERS, "oldest workers are evicted");
  assert.equal(ledger.has("0".repeat(32)), false);
  const [newest] = summarize(ledger, { now: T0 + 100 });
  assert.match(newest, /never asked for a profile probe/);
});

test("verdicts keep the last three distinct answers in order", () => {
  const ledger = createLedger();
  for (const [i, v] of ["notfound", "error:timeout", "wrong:אישי — x", "match"].entries())
    noteVerdict(ledger, A, v, T0 + i);
  const [line] = summarize(ledger, { now: T0 + 10 });
  assert.match(line, /"error:timeout".*then "wrong:אישי — x".*then "match"/);
  assert.doesNotMatch(line, /notfound/);
});

test("canonicalProfileName mirrors the extension's _canonicalProfileName byte for byte", () => {
  const start = background.indexOf("function _canonicalProfileName(");
  const end = background.indexOf("\n}", start);
  const theirs = Function(`${background.slice(start, end + 2)}; return _canonicalProfileName;`)();
  for (const v of [
    "אוטומציות — עמוד הפתיחה",
    "wrong:עבודה — mcp-profile-check-1789885069020",
    "מחקר אנונימי",
    "notfound",
    "__personal__",
    "",
    null,
  ]) {
    assert.equal(canonicalProfileName(v), theirs(v), JSON.stringify(v));
  }
});

test("readProfileIdentities reads each profile container read-only and reports identity, heartbeat and badge", async () => {
  const now = T0 + 60_000;
  const tree = {
    "/h/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebExtensions": [
      "C5040C6C-1",
      "Default",
      "Other",
    ],
    "/h/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebExtensions/C5040C6C-1": [
      "com.achiya-automation.safari-mcp.Extension (PQ7BWRHSYV)",
    ],
    "/h/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebExtensions/Default": [
      "com.achiya-automation.safari-mcp.Extension (PQ7BWRHSYV)",
      "com.other.Extension (X)",
    ],
    "/h/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebExtensions/Other": [
      "com.other.Extension (X)",
    ],
  };
  const queried = [];
  const rows = {
    "C5040C6C-1": `_heartbeat|${T0 + 45_000}\nmcpStatus|"checking"\nmcpVerifiedProfile|"אוטומציות — עמוד הפתיחה"`,
    Default: `mcpVerifiedProfile|"אישי"\nmcpStatus|"connected"`,
  };
  const list = await readProfileIdentities({
    home: "/h",
    now,
    readdir: async (dir) => {
      if (!(dir in tree)) throw new Error("ENOENT");
      return tree[dir];
    },
    runSqlite: async (db) => {
      queried.push(db);
      return rows[db.split("/")[9]];
    },
  });
  assert.deepEqual(
    queried.map((q) => q.split("/").slice(-3).join("/")),
    [
      "C5040C6C-1/com.achiya-automation.safari-mcp.Extension (PQ7BWRHSYV)/LocalStorage.db",
      "Default/com.achiya-automation.safari-mcp.Extension (PQ7BWRHSYV)/LocalStorage.db",
    ],
    "only this extension's containers are read"
  );
  assert.deepEqual(list, [
    {
      container: "C5040C6C-1",
      identity: "אוטומציות — עמוד הפתיחה",
      canonical: "אוטומציות",
      status: "checking",
      heartbeatAgeMs: 15_000,
    },
    {
      container: "Default",
      identity: "אישי",
      canonical: "אישי",
      status: "connected",
      heartbeatAgeMs: null,
    },
  ]);
  const lines = describeProfileIdentities(list, { profile: "אוטומציות" });
  assert.match(
    lines[0],
    /^C5040C6C: stored identity "אוטומציות — עמוד הפתיחה" = "אוטומציות" after canonicalization; .*; heartbeat 15s ago; badge checking ← this host's profile$/
  );
  assert.match(lines[1], /^Default: stored identity "אישי"; no heartbeat; badge connected$/);
  await assert.rejects(
    readProfileIdentities({
      home: "/nowhere",
      readdir: async () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
      runSqlite: async () => "",
    }),
    { code: "EPERM" },
    "a container that cannot be listed surfaces its error instead of an empty list"
  );
  assert.deepEqual(await readProfileIdentities(), [], "no deps → nothing, never a throw");
  assert.match(
    describeProfileIdentities([])[0],
    /no Safari profile has this extension's storage yet/
  );
  assert.match(
    describeProfileIdentities([], {
      error: Object.assign(new Error("denied"), { code: "EPERM" }),
    })[0],
    /macOS denied this process access .*\(EPERM\) — grant Full Disk Access/
  );
  assert.match(
    describeProfileIdentities([], { error: new Error("boom") })[0],
    /not readable \(boom\)/
  );
});

test("index.js records rejected and accepted workers, probe verdicts, and appends the bridge report to safari_doctor", () => {
  const connect = index.slice(
    index.indexOf('req.url.startsWith("/connect")'),
    index.indexOf("// POST /heartbeat")
  );
  assert.ok(
    connect.includes("ledgerNoteConnect(_workerLedger, workerId, { rejected })"),
    "a 426 is recorded with what the worker announced"
  );
  assert.ok(connect.includes("rejected (426 upgrade_required)"), "and logged once");
  assert.ok(
    connect.includes("ledgerNoteConnect(_workerLedger, workerId);"),
    "an accepted worker is recorded"
  );
  const verify = index.slice(
    index.indexOf('req.url === "/verify-profile"'),
    index.indexOf("// GET /proxy-check")
  );
  assert.equal(
    (verify.match(/_logProfileVerdict\(workerId, /g) || []).length,
    2,
    "both the AppleScript verdict and the error path are logged"
  );
  const doctorTool = index.slice(
    index.indexOf('"safari_doctor"'),
    index.indexOf('"safari_detect_forms"')
  );
  assert.ok(
    doctorTool.includes("_extensionBridgeReport()"),
    "safari_doctor appends the bridge report"
  );
  assert.ok(doctorTool.includes(".catch("), "and never fails the permission checklist on it");
  assert.ok(index.includes('["-readonly", db,'), "extension storage is opened read-only");
  const warning = index.slice(
    index.indexOf("function _noteUnverifiedWorker"),
    index.indexOf("function _logProfileVerdict")
  );
  assert.ok(
    warning.includes("summarizeWorkerLedger(_workerLedger"),
    "the none-proved warning prints the ledger"
  );
  assert.ok(
    !warning.includes("UPDATE extension_storage"),
    "and no longer prescribes a sqlite write as the fix"
  );
});
