#!/usr/bin/env node
// Safari MCP — postinstall: codesign helper + welcome message
// Skipped silently in CI and when stdout is not a TTY (npm install in scripts).

const path = require("path");
const { execSync } = require("child_process");
const fs = require("fs");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

// Re-sign safari-helper with a stable identifier so macOS Accessibility approval persists.
// The package ships with an adhoc-signed binary whose codesign Identifier is a one-off hash
// (e.g. `safari-helper-555549441c166aa237e130ddbe3d95629266ecaf`). macOS TCC keys grants by
// that identifier, so a fresh npm install or rebuild silently invalidates any previously-granted
// Accessibility approval — the helper keeps running but CGEvent injections to non-frontmost Safari
// windows stop reaching WebKit content (no isTrusted click events fire on the page).
// Re-signing here with the fixed identifier `com.achiya-automation.safari-mcp` keeps the grant
// stable across installs.
const STABLE_ID = "com.achiya-automation.safari-mcp";
function readHelperId(helper) {
  try {
    // NOTE: the Identifier= line is only emitted with --verbose. Plain `codesign -d`
    // prints nothing matchable, so the old grep always failed → the early-return never
    // fired and any verify read came back empty (a false "re-sign failed" signal).
    return execSync(`codesign -d --verbose=2 -- "${helper}" 2>&1 | grep "^Identifier="`, { encoding: "utf8" }).trim();
  } catch { return ""; }
}
function ensureCodesign() {
  if (process.platform !== "darwin") return;
  const helper = path.join(__dirname, "..", "safari-helper");
  if (!fs.existsSync(helper)) return;
  try {
    // Check current identifier; only re-sign if it doesn't already match.
    const current = readHelperId(helper);
    if (current.includes(STABLE_ID)) return;
    const entitlements = path.join(__dirname, "..", "safari-helper.entitlements");
    const entFlag = fs.existsSync(entitlements) ? `--entitlements "${entitlements}"` : "";
    // NOTE: do NOT swallow codesign's stderr (the old `2>/dev/null` hid real failures).
    execSync(`codesign -s - -f --identifier ${STABLE_ID} ${entFlag} "${helper}"`, { stdio: ["ignore", "ignore", "pipe"] });
    // Verify the re-sign actually took. A SILENT failure here is the #1 cause of native
    // clicks "succeeding" while never reaching the page — the Accessibility grant is keyed
    // to the identifier, so a wrong/unstable identifier breaks it invisibly. Make it loud.
    const after = readHelperId(helper);
    if (!after.includes(STABLE_ID)) {
      process.stderr.write(
        `\n${c.yellow}⚠ Safari MCP: could not re-sign safari-helper with the stable identifier.${c.reset}\n` +
        `  Now: ${after || "(unknown)"}\n` +
        `  Native clicks may silently fail. Fix:\n` +
        `  ${c.dim}codesign -s - -f --identifier ${STABLE_ID} --entitlements safari-helper.entitlements "${helper}"${c.reset}\n` +
        `  then re-grant Accessibility, and run safari_doctor to verify.\n`
      );
    }
  } catch (e) {
    process.stderr.write(
      `\n${c.yellow}⚠ Safari MCP: codesign step failed${c.reset} — ${(e.message || "").split("\n")[0]}\n` +
      `  The binary still runs ad-hoc-signed, but the macOS Accessibility grant may not persist across installs.\n` +
      `  Run safari_doctor after install to check; re-sign manually if needed.\n`
    );
  }
}
ensureCodesign();

if (process.env.CI || process.env.SAFARI_MCP_SILENT_INSTALL === "1") process.exit(0);

const msg = `
${c.bold}${c.cyan}🦁 Safari MCP installed${c.reset} ${c.dim}— 96 native browser tools for AI agents${c.reset}

${c.bold}Next steps:${c.reset}
  1. Enable Safari → Develop → ${c.yellow}Allow JavaScript from Apple Events${c.reset}
  2. Add to your MCP client config:
     ${c.dim}{ "mcpServers": { "safari": { "command": "npx", "args": ["safari-mcp"] } } }${c.reset}
  3. ${c.bold}For native_click / native_keyboard${c.reset} (no focus stealing):
     System Settings → Privacy & Security → ${c.yellow}Accessibility${c.reset} → add
     ${c.dim}node_modules/safari-mcp/safari-helper${c.reset} ${c.dim}(or the global install path)${c.reset}

${c.bold}${c.magenta}⭐ Found this useful?${c.reset} A star helps others discover it:
   ${c.cyan}https://github.com/achiya-automation/safari-mcp${c.reset}

${c.dim}Docs · Examples · Issues → github.com/achiya-automation/safari-mcp${c.reset}
`;

try { process.stdout.write(msg); } catch { /* ignore */ }
