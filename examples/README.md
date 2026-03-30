# Safari MCP Examples

Practical examples showing how AI agents use Safari MCP tools via the Model Context Protocol.

**What makes Safari MCP unique:**
- Uses your real Safari with all existing logins (Gmail, GitHub, Slack -- already authenticated)
- Zero Chrome overhead -- native WebKit on Apple Silicon, ~60% less CPU
- 80 tools covering navigation, forms, screenshots, network, storage, accessibility, and more
- Background operation -- Safari never steals window focus

## Examples

| Example | Description |
|---------|-------------|
| [Screenshot and Analyze](screenshot-and-analyze.md) | Take screenshots, capture specific elements, and export PDFs |
| [Form Automation](form-automation.md) | Detect forms, fill fields, select dropdowns, and submit -- works with React/Vue/Angular |
| [Data Extraction](data-extraction.md) | Extract tables, links, meta tags, and structured data from any page |
| [Network Monitoring](network-monitoring.md) | Capture API calls, inspect request/response details, and mock network responses |
| [Multi-Tab Workflow](multi-tab-workflow.md) | Safely manage multiple tabs without touching the user's existing tabs |

## How to read these examples

Each example shows MCP tool calls as JSON objects with:
- `tool` -- the tool name (prefixed with `safari_`)
- `arguments` -- the parameters passed to the tool

In practice, your MCP client (Claude Code, Cursor, etc.) sends these as standard MCP `tools/call` requests. The JSON format shown here is the arguments object.

## Tool prefix

When used through an MCP client, tools are typically prefixed with the server name. For example:
- Claude Code: `mcp__safari__safari_navigate`
- Direct MCP: `safari_navigate`

The examples below use the short form (`safari_navigate`) for readability.
