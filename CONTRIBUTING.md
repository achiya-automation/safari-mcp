# Contributing to Safari MCP

Thanks for your interest in contributing! Safari MCP is the only MCP server for Safari, and community contributions help make it better for everyone.

## Architecture Overview

The codebase is intentionally simple — two main files:

```
safari-mcp/
├── index.js          # MCP server — tool definitions and request routing
├── safari.js         # Safari automation — AppleScript + JavaScript engine
├── xcode/            # Safari Web Extension (optional, for advanced features)
└── examples/         # Usage examples
```

**Dual engine design:**
- **AppleScript + Swift daemon** — always available, handles ~80% of functionality
- **Safari Extension** (optional) — adds Shadow DOM access, CSP bypass, React state manipulation

## Requirements

- **macOS** (Safari MCP is macOS-only by design)
- **Node.js 18+**
- **Safari** with "Allow JavaScript from Apple Events" enabled

## Setup

```bash
git clone https://github.com/achiya-automation/safari-mcp.git
cd safari-mcp
npm install
```

Enable Safari automation:
1. Safari > Settings > Advanced > **Show features for web developers** ✓
2. Develop menu > **Allow JavaScript from Apple Events** ✓

*(Optional)* Build the Safari Extension: open `xcode/Safari MCP/Safari MCP.xcodeproj` and build "Safari MCP (macOS)".

## Running & Testing

```bash
node index.js
```

This starts the MCP server on stdio. Connect it to any MCP client (Claude Code, Cursor, VS Code) to test changes interactively.

**Manual testing** against a real Safari instance is the current approach. If you'd like to help set up automated tests, see issue [#5](https://github.com/achiya-automation/safari-mcp/issues/5)!

## What We're Looking For

Check out issues labeled [`good first issue`](https://github.com/achiya-automation/safari-mcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) for beginner-friendly tasks.

Areas where help is especially welcome:
- **Testing** — automated test framework (issue [#5](https://github.com/achiya-automation/safari-mcp/issues/5))
- **CI improvements** — multi-Node.js version matrix (issue [#6](https://github.com/achiya-automation/safari-mcp/issues/6))
- **Documentation** — FAQ, more examples, tutorials
- **New tools** — browser capabilities we haven't covered yet
- **Bug fixes** — especially cross-macOS-version compatibility

## Submitting a PR

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Test on macOS with a real Safari instance
4. Describe **what** you changed and **why**
5. Keep PRs focused — one feature or fix per PR

**Typical PR review time:** 1-2 days.

## Code Style

- Vanilla JavaScript, ESM modules (`import`/`export`)
- No transpilation, no TypeScript, no bundler
- Keep dependencies minimal — the project intentionally has very few
- Comments in English

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Please read it before participating.

## Questions?

Open an [issue](https://github.com/achiya-automation/safari-mcp/issues) or start a [discussion](https://github.com/achiya-automation/safari-mcp/discussions) — we're happy to help!
