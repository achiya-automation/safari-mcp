# HTTP Transport (opt-in) — shared single-instance mode

**Status:** design approved 2026-07-02
**Goal:** let many Claude Code sessions share ONE safari-mcp process instead of spawning one node process per session (~17 → 1). Reduces memory/startup footprint. Opt-in, zero behaviour change when off.

## Problem

safari-mcp uses `StdioServerTransport` (index.js:2402) → MCP spawns a fresh `node index.js` per client session. With many concurrent Claude Code sessions this is ~17 node + ~17 helper processes (~590MB). Proxy-mode already funnels Safari commands through one extension host, so the extra processes are pure per-session transport overhead.

## Approach — native `StreamableHTTPServerTransport`, opt-in

Switch the transport at the bottom of index.js based on an env var:

```
SAFARI_MCP_HTTP=1            → StreamableHTTPServerTransport on 127.0.0.1:PORT
(unset, default)             → StdioServerTransport   (UNCHANGED — current behaviour)
SAFARI_MCP_HTTP_PORT=9225    → listen port (default 9225; distinct from 9224 extension port)
```

A single launchd daemon runs the `SAFARI_MCP_HTTP=1` instance; all Claude sessions connect over HTTP (`type: http` in `.mcp.json`).

## Key decisions

- **State is shared on purpose.** ownership (`_ownedTabURLs`, on-disk + TTL), `_openedTabs`, and the extension host (9224) stay module-global. Correct because there is ONE physical Safari window — `MAX_TABS` budget and tab list should reflect that one window. The user-tab protection (`_isURLOwned`) is preserved.
- **Session handling:** follow the SDK's standard Streamable-HTTP pattern. Exact stateful-vs-stateless choice is decided by the first TDD test (does one `McpServer` accept multiple transports, or is a per-session server factory needed / is stateless sufficient given module-global state).
- **Concurrency:** commands from N sessions are serialized by the daemon's single event loop + the single extension host — same as today's proxy mode. No new race surface vs. current multi-session use.

## Safety / backward-compat (the "never worse than before" gate)

1. Opt-in: without the env var, code path is byte-for-byte the current stdio path. npm users unaffected.
2. `.mcp.json` switch is the LAST step, done only after HTTP mode is proven to work at least as well as stdio (same tools succeed, tab-safety holds).
3. **Rollback:** revert one line in `~/.mcp.json` (`type: http` → `command: node`) → back to today. Zero data loss (ownership file is shared/compatible across both modes).

## Test plan

- HTTP mode boots, answers `initialize`, lists all 96 tools.
- A representative tool (e.g. list tabs) works over HTTP.
- Two concurrent HTTP clients both work; tab-safety (user tab not owned) still blocks.
- stdio mode unchanged (regression).
- launchd `KeepAlive` restarts the daemon on crash.

## Out of scope (for now)

Per-session tab isolation (deliberately shared), command queue (add only if a real race appears), auth (localhost-only bind).
