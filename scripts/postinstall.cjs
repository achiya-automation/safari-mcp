#!/usr/bin/env node
// Safari MCP — postinstall welcome message
// Skipped silently in CI and when stdout is not a TTY (npm install in scripts).

if (process.env.CI || process.env.SAFARI_MCP_SILENT_INSTALL === "1") process.exit(0);

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
};

const msg = `
${c.bold}${c.cyan}🦁 Safari MCP installed${c.reset} ${c.dim}— 80 native browser tools for AI agents${c.reset}

${c.bold}Next steps:${c.reset}
  1. Enable Safari → Develop → ${c.yellow}Allow JavaScript from Apple Events${c.reset}
  2. Add to your MCP client config:
     ${c.dim}{ "mcpServers": { "safari": { "command": "npx", "args": ["safari-mcp"] } } }${c.reset}

${c.bold}${c.magenta}⭐ Found this useful?${c.reset} A star helps others discover it:
   ${c.cyan}https://github.com/achiya-automation/safari-mcp${c.reset}

${c.dim}Docs · Examples · Issues → github.com/achiya-automation/safari-mcp${c.reset}
`;

try { process.stdout.write(msg); } catch { /* ignore */ }
