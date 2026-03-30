# Contributing to Safari MCP

Thanks for your interest in contributing! Safari MCP is the only MCP server for Safari, and community contributions help make it better for everyone.

## Requirements

- **macOS** (Safari MCP is macOS-only by design)
- **Node.js 18+**
- **Safari** with "Allow JavaScript from Apple Events" enabled

## Setup

1. Clone the repo:

   ```bash
   git clone https://github.com/achiya-automation/safari-mcp.git
   cd safari-mcp
   npm install
   ```

2. Enable Safari automation:

   Safari > Settings > Advanced > check "Show features for web developers"

   Then: Develop menu > "Allow JavaScript from Apple Events"

3. *(Optional)* Build the Safari extension with Xcode:

   Open `xcode/Safari MCP/Safari MCP.xcodeproj` and build the scheme "Safari MCP (macOS)".

## Running & Testing

Start the MCP server:

```bash
node index.js
```

This starts the server on stdio (MCP protocol). You can connect it to any MCP client (Claude Code, Cursor, etc.) to test your changes interactively.

There is no test framework yet — manual testing against a real Safari instance is the current approach.

## Submitting a PR

- Describe **what** you changed and **why**
- Test your changes on macOS with a real Safari instance
- Keep PRs focused — one feature or fix per PR

## Code Style

- Vanilla JavaScript, ESM modules (`import`/`export`)
- No transpilation, no TypeScript, no bundler
- Keep dependencies minimal — the project intentionally has very few

## Questions?

Open an issue — we're happy to help.
