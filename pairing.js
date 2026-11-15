// One-time pairing codes. They give the Safari extension the bridge token without
// building the token into the app, so one signed app can be downloaded by everyone.
//
// `safari-mcp pair` writes the hash of a fresh code here and prints the code. The bridge's
// POST /pair (extension origins only, see index.js) trades a matching code for the token
// once. The code expires after ten minutes, and five wrong guesses burn it.
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const PAIRING_FILE = join(homedir(), ".safari-mcp-pairing");
export const PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
// Crockford base32 has no I, L, O or U, so a code survives being read aloud or retyped.
// Eight characters give 40 bits.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const sha256 = (value) => createHash("sha256").update(value).digest();

export function normalizePairingCode(input) {
  return String(input ?? "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

export function createPairingCode({ file = PAIRING_FILE, now = Date.now() } = {}) {
  let code = "";
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  const temporaryFile = `${file}.${process.pid}.tmp`;
  const state = { sha256: sha256(code).toString("hex"), expiresAt: now + PAIRING_TTL_MS, failures: 0 };
  writeFileSync(temporaryFile, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporaryFile, file);
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** @returns {"ok" | "invalid" | "expired" | "missing"} */
export function consumePairingCode(input, { file = PAIRING_FILE, now = Date.now() } = {}) {
  let state;
  try { state = JSON.parse(readFileSync(file, "utf8")); } catch { return "missing"; }
  const burn = () => { try { unlinkSync(file); } catch {} };
  if (!(now < state?.expiresAt)) {
    burn();
    return "expired";
  }
  const code = normalizePairingCode(input);
  const expected = Buffer.from(String(state.sha256 || ""), "hex");
  const given = sha256(code);
  if (/^[0-9A-Z]{8}$/.test(code) && expected.length === given.length && timingSafeEqual(expected, given)) {
    burn();
    return "ok";
  }
  // ponytail: two daemons judging guesses at once can race this count; the 40-bit code
  // and the ten-minute expiry still hold without it.
  state.failures = (Number(state.failures) || 0) + 1;
  if (state.failures >= MAX_FAILURES) burn();
  else {
    try { writeFileSync(file, JSON.stringify(state), { mode: 0o600 }); } catch {}
  }
  return "invalid";
}

export function printPairingCode() {
  const code = createPairingCode();
  console.log(`Safari MCP pairing code: ${code}

In Safari, click the Safari MCP button in the toolbar and enter this code.
It works once and expires in ${PAIRING_TTL_MS / 60000} minutes. Your MCP client must be running
(it starts safari-mcp). Each Safari profile pairs separately: run this again for the next one.`);
}
