# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (2.x) | Yes |
| < 2.0 | No |

Only the latest published version on npm receives security updates.

## Reporting a Vulnerability

If you discover a security vulnerability in safari-mcp, please report it responsibly:

- **Email:** [info@achiya-automation.com](mailto:info@achiya-automation.com)
- **Response time:** We will acknowledge your report within **48 hours**.
- **Process:** We will work with you to understand and validate the issue, develop a fix, and coordinate disclosure.

Please **do not** open a public GitHub issue for security vulnerabilities. Use the email above for responsible disclosure.

We follow a coordinated disclosure policy: we ask that you give us reasonable time to address the issue before making it public.

## Scope

### In Scope

- The `safari-mcp` npm package source code
- The Safari Web Extension bundled in this repository
- The MCP server (Node.js process and tool handlers)
- The AppleScript/Swift helper daemon

### Out of Scope

- Safari browser itself (report to [Apple](https://support.apple.com/en-us/102549))
- macOS operating system
- The MCP protocol specification
- Third-party MCP clients or hosts

## Security Model

safari-mcp is a **local-only** tool designed for developer use on macOS:

- **No network access required** -- the server communicates with its MCP client via stdio. No ports are opened and no HTTP server is exposed.
- **No data leaves the machine** -- all browser automation happens locally through AppleScript and JavaScript for Automation (JXA). Page content, cookies, and form data stay on the local machine.
- **AppleScript sandbox** -- browser interactions are constrained by macOS AppleScript permissions. The user must explicitly grant Accessibility and Automation permissions in System Settings.
- **No credentials stored** -- safari-mcp does not store, transmit, or log any authentication tokens, passwords, or session data.

## Known Considerations

### JavaScript from Apple Events

Safari's "Allow JavaScript from Apple Events" setting (under Develop menu) must be enabled for safari-mcp to function. This setting allows external processes to execute JavaScript in Safari tabs. Users should be aware that:

- This is a Safari developer feature intended for automation.
- It should only be enabled when actively using safari-mcp or similar tools.
- It grants JavaScript execution capability to any process with Accessibility permissions.

### Tab Ownership Guard

safari-mcp implements a tab ownership model to protect the user's browsing session. MCP clients are expected to only interact with tabs they opened via `safari_new_tab`, never with pre-existing user tabs. This prevents accidental navigation, form submission, or data loss in tabs the user is actively working in.

### Extension Permissions

The Safari Web Extension requests permission to access page content for automation purposes. It communicates exclusively with the local MCP server via HTTP on localhost and does not make any external network requests.
