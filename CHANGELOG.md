# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.8.0] - 2026-04-14

### Added

- **Postinstall welcome banner** (`scripts/postinstall.cjs`) — printed once after `npm install`, shows next-step setup and a discoverable star CTA. Skipped silently in CI and when `SAFARI_MCP_SILENT_INSTALL=1` is set.
- **Once-per-day startup banner** in `index.js` — written to stderr (never stdout, so MCP protocol is untouched) on the first server start of the day. Includes version, capability summary, and a one-line star link. Suppressed by `SAFARI_MCP_QUIET=1`.
- **`smithery.yaml`** — Smithery deployment config, points at the existing `smithery-entry.js` (no top-level `await`).

### Changed

- **README revamp for discoverability:**
  - New social-proof badge row: MCP Registry, Glama, Awesome MCP, CLI-Anything.
  - Prominent star CTA block right after Quick Start (was buried at line 568).
  - New "Why Safari MCP and Not the Other Safari MCP Projects?" comparison table — clarifies how this project differs from `lxman/safari-mcp-server`, `Epistates/MCPSafari`, and `HayoDev/safari-devtools-mcp`.
  - Removed duplicate "vs. Chrome DevTools MCP / Playwright MCP" section.
- **GitHub topics** updated for better organic discovery — added `claude-code`, `safari-mcp`, `mcp` to the topic set.

## [2.7.14] - 2026-04-12

### Fixed

- **`safari-helper` now includes `com.apple.security.automation.apple-events` entitlement.** This helps macOS correctly identify the binary's intent and surface the TCC Automation prompt more reliably on first launch from an IDE. Previously, the ad-hoc signature had no entitlements, causing some setups to silently deny Apple Events without ever prompting.
- Added troubleshooting note for "Not authorized" errors after `npm update` — updating changes the binary's cdhash, which causes macOS to silently revoke Automation permission. Users need to re-grant via the `osascript` one-liner.
- Entitlements file (`safari-helper.entitlements`) now ships with the npm package for users building from source.

## [2.7.14] - 2026-04-12

### Fixed

- `safari_press_key` Enter on contenteditable now has a **native fallback** when the JS keydown isn't handled (isTrusted:false rejection by Discord/Slack/etc.). The fallback briefly activates Safari (~80ms), sends a real keystroke, then immediately restores the previous frontmost app — total visual flash <130ms, imperceptible to most users. This closes the last gap in Discord automation: text insertion via `cmd+v` (Slate state-aware) + Enter submission via native fallback. The fallback ONLY fires when the JS path fails (returns `__ENTER_NOT_HANDLED__`), so apps that accept synthetic events still use the zero-focus-steal JS path.

## [2.7.13] - 2026-04-12

### Fixed

- `safari_press_key` Enter on contenteditable no longer inserts a line break. Modern editors (Discord Slate, Slack, Notion, Medium) handle Enter in their own keydown handler to trigger submit/send. The old fallback `execCommand('insertLineBreak')` was double-acting — the app tries to submit AND MCP adds a newline, corrupting the editor state and preventing actual submission. Now:
  - **INPUT** → form submit (unchanged)
  - **TEXTAREA** → insertLineBreak (unchanged)
  - **ContentEditable + Enter** → keydown event only, let the app decide (fixed)
  - **ContentEditable + Shift+Enter** → insertLineBreak (newline, as expected)

## [2.7.12] - 2026-04-12

### Added

- `safari_native_type` tool — inserts text into any editor via OS-level clipboard paste (CGEvent Cmd+V targeted to Safari window). Unlike `safari_fill` which writes to the DOM directly (breaking ProseMirror/Slate/Draft.js internal state), `safari_native_type` goes through the browser's real paste pipeline. The framework processes the paste event natively, so its model stays in sync with the DOM. After calling `safari_native_type`, pressing Enter via `safari_native_keyboard` will actually submit the form — because the framework state matches the visible content. Saves and restores the user's clipboard. No focus stealing.

### Why this matters

This closes the last gap in the Discord/Slack automation chain:
1. `safari_hover` → find server by tooltip name
2. `safari_click` → enter channel
3. `safari_native_type` → paste message into ProseMirror editor (state-aware)
4. `safari_native_keyboard {key: "enter"}` → submit (no focus steal)

Previously step 3 used `safari_fill` which worked visually but the text wasn't "really there" from Discord's perspective — leading to empty submissions on Enter.

## [2.7.11] - 2026-04-12

### Added

- `safari_native_keyboard` tool — OS-level keyboard event via macOS CGEvent, targeted to the Safari window ID without activating Safari. Produces `isTrusted: true` events that bypass React trust checks in Discord ProseMirror, Slack virtualized editors, and similar trust-gated UIs. Supports all common keys (enter, tab, escape, arrows, letters, digits, punctuation) and modifiers (cmd, shift, alt, ctrl). **No focus stealing** — runs entirely in the background.

### Fixed

- Operations that required a real keypress previously had no zero-focus-steal path; users (and automation agents) had to fall back to `osascript "tell application \"Safari\" to activate"` which brings Safari to the foreground and interrupts whatever the user is doing. `safari_native_keyboard` closes this gap so pressing Enter in Discord, Slack, or any ProseMirror-backed editor no longer pops Safari in front of the user.

## [2.7.10] - 2026-04-12

### Added

- `safari_native_hover` tool — OS-level mouse move via macOS CGEvent. Triggers real `:hover` and `mouseenter` handlers on obfuscated UIs (Discord sidebars, portal-rendered tooltips) where JS-dispatched events aren't enough. Dwells for a configurable duration then restores the cursor position. Complements `safari_native_click`.

### Fixed

- **Tab ownership now survives MCP process restarts.** Previously, every time Claude Code (or any other MCP client) recycled the Safari MCP server, the in-memory `_ownedTabURLs` set was wiped, causing `⚠️ Tab safety: no tabs opened yet` errors on the next tool call. Ownership is now persisted to `~/.safari-mcp/owned-tabs.json` with a 30-minute TTL.
- **`safari-helper` now targets macOS 12.0+ instead of macOS 26.** The daemon was shipped in v2.7.9 compiled with `minos 26.0`, which silently failed to launch on macOS 15 and earlier (#15 root cause). Rebuilt with `swiftc -target arm64-apple-macos12.0` so it runs on Monterey through Tahoe.

## [2.7.9] - 2026-04-11

### Fixed

- Remove `pgrep -E` flag that doesn't exist on macOS — memory monitor was emitting `pgrep: illegal option -- E` on stderr on every check (#15)
- Move Safari extension popup inline `<script>` into `popup/popup.js` so MV3 `script-src 'self'` CSP stops blocking it; popup was stuck on "Checking..." indefinitely (#18, thanks @mikhailkogan17)
- Re-sign `safari-helper` daemon with an explicit ad-hoc signature (replaces the linker-signed fallback) so macOS TCC has a stable cdhash to anchor Automation permissions

### Documentation

- README: add **Automation → Safari** to the macOS Permissions table, plus instructions for granting it to the parent IDE and the `osascript` one-shot workaround (#16)
- README: add `codesign --sign - --force --deep` step to the extension build instructions so Safari will actually load the bundle produced by `xcodebuild` (#17)

### Security

- Pin `hono` to `^4.12.12` and `@hono/node-server` to `^1.19.13` via `package.json` overrides, silencing 6 transitive dependabot advisories (not exploitable at runtime — safari-mcp only loads `StdioServerTransport`)
- Add `.github/CODEOWNERS` and expand Dependabot to cover `github-actions` ecosystem
- Publishing to npm now uses OIDC Trusted Publisher instead of long-lived `NPM_TOKEN`; releases gate on a manual-approval `npm-publish` environment

## [2.7.3] - 2026-04-01

### Fixed

- Prevent Safari from auto-launching when closed — `tell application "Safari"` in AppleScript starts Safari automatically; added `pgrep` check before every osascript call to return an error instead of launching Safari

## [2.7.2] - 2026-03-31

### Changed

- Replace Hebrew text in code comments and author headers with English
- Use Unicode escapes for locale-dependent UI strings (Cancel button, error detection)
- Remove unused popup.js (logic is inline in popup.html)
- Add `lang="en"` to popup.html for accessibility

## [2.5.3] - 2026-03-31

### Fixed

- Tab targeting: always re-resolve tab by URL before every command (RESOLVE_CACHE_MS → 0). Cached indices go stale when tabs are opened/closed by other sessions, causing commands to land on wrong tabs

## [2.5.2] - 2026-03-31

### Fixed

- Type text in cross-origin iframes: Extension now falls back to `allFrames: true` when typing in main frame fails, preventing the AppleScript path from stealing focus

## [2.5.1] - 2026-03-31

### Fixed

- Click in cross-origin iframes: Extension now falls back to `allFrames: true` when element not found in main frame, enabling clicks on buttons inside Intercom, Zendesk, and other cross-origin iframe widgets — zero focus stealing

## [2.5.0] - 2026-03-31

### Added

- CGEvent native keyboard support in Swift helper — send keystrokes to Safari without activating the window or stealing focus
- Cross-origin iframe typing: `typeText` and `pressKey` (Cmd+V) now detect when the active element is an iframe and use native CGEvent paste instead of JavaScript

### Fixed

- Focus stealing: `_nativeTypeViaClipboard` and `pressKey` Cmd+V for iframes no longer activate Safari or use System Events — all done via background CGEvent targeting

## [2.1.5] - 2026-03-30

### Fixed

- Memory protection: prevent system crashes from WebKit memory leaks in long-running sessions

## [2.1.4] - 2026-03-29

### Fixed

- ClipboardEvent paste fallback for modern editors that block synthetic input events

## [2.1.3] - 2026-03-29

### Fixed

- Singleton process management: kill stale MCP instances on startup
- Sibling instance detection: don't kill instances started by Claude Code VSCode

## [2.1.2] - 2026-03-29

### Added

- Closure/Medium editor fill via `execCommand` line-by-line insertion
- Native paste for Closure/Medium editors via System Events `Cmd+V`
- Demo GIF in README

### Fixed

- Closure/Medium fill without focus stealing
- Closure/Medium editor fill via synthetic clipboard paste

## [2.1.1] - 2026-03-28

### Added

- Official MCP Registry support (`server.json`)
- `mcpName` field for registry identification
- `mcp.json` for Cursor Directory / Open Plugins

## [2.1.0] - 2026-03-28

### Added

- `safari_native_click` tool: OS-level mouse click via CGEvent (produces `isTrusted` events)
- Window-targeted native click: no mouse movement, no focus steal
- Extension reconnect with exponential backoff
- Architecture documentation for the dual-engine system

### Fixed

- Native click saves/restores mouse position (no cursor stealing)
- Window bounds fallback to direct osascript
- `navigate()` properly waits for page load via sync polling

## [2.0.1] - 2026-03-23

### Added

- Closed Shadow DOM support with screenshot verification
- React `_valueTracker` reset for LinkedIn/React app compatibility
- Fuzzy matching in `select_option` for RTL text and dashes
- CSP fallback strategy chain for `evaluate`
- Smart loading detection with auto hard reload
- Disabled element detection in `click` with clear error messages
- Per-session tab tracking with profile separation
- `glama.json` server metadata

### Changed

- Click text matching: 3-layer matching (exact, deepest, contains)
- `switch_tab` performs visual switch with stale ref warnings
- Richer `snapshot` output
- Closure editor fill improvements

### Fixed

- Tab targeting: commands run on the correct tab after `switch_tab`
- Extension blocked in personal profile to prevent window focus jumping
- Extension skipped when `SAFARI_PROFILE` is set (AppleScript avoids focus steal)
- LinkedIn ProseMirror view detection and paste behavior
- Medium editor: auto-detection, clear error on fill failure, character-by-character mode
- `fill_form`, `type_text`, `press_key`, `scroll`, and `click` bugs from deep audit
- Checkbox React state synchronization
- `select_option` retry via AppleScript fallback
- Screenshot fallback respects `_preferAppleScript`
- AppleScript `clearField` for contenteditable elements
- `requestSubmit` used instead of `form.submit` for WAF compatibility

### Performance

- Extension v2.1 with HTTP polling, profiles, and command queue

## [2.0.0] - 2026-03-19

### Added

- Safari Web Extension engine: 5-20ms operations with real cookies and logins
- Dual-engine architecture: Extension (preferred) + AppleScript daemon (fallback)
- WebSocket bridge connecting Safari Extension to MCP tools
- Pure JS React click with full PointerEvent sequence and Fiber fallback
- OS-level click for React/Airtable/virtual DOM apps via CGEvent
- Tab tracking by URL to prevent hijacking user tabs
- Profile separation via `SAFARI_PROFILE` environment variable

### Changed

- Extension always targets the MCP tab, not the active tab
- Reverted to AppleScript-first for `newTab` to preserve cookies/logins

### Fixed

- Handle `EADDRINUSE` on WebSocket port 9223 gracefully
- Click on `<a>` tags with href navigates directly as fallback
- React click with coordinates on synthetic events and parent traversal
- Evaluate return values and virtual DOM scroll-to-text
- Tab tracking: resolve by URL in single osascript call
- Screenshot: switch to target tab before capture, restore after
- Critical bugs in type casting, evaluate returns, virtual DOM clicks, and new tab navigation
- Removed broken persistent osascript process (136x faster)

### Performance

- Tab caching and `world:MAIN` context for faster execution
- `click_and_read` combined operation
- TreeWalker text search with cached click helpers
- Click payload reduced from 3KB to 200B with retry pattern
- Pre-inject helpers on navigate
- Cached tab resolve with attribute-aware text search
- Combined navigate + newTab into single osascript calls

## [1.0.0] - 2026-03-18

### Added

- Initial release with 80 MCP tools for native Safari browser automation
- Navigation: `navigate`, `go_back`, `go_forward`, `reload`, `new_tab`, `close_tab`, `switch_tab`, `list_tabs`
- Interaction: `click`, `fill`, `select_option`, `press_key`, `type_text`, `hover`, `drag`, `scroll`, `double_click`, `right_click`
- Forms: `fill_form`, `fill_and_submit`, `detect_forms`, `clear_field`, `upload_file`
- Reading: `read_page`, `snapshot`, `get_source`, `get_element`, `query_all`, `extract_links`, `extract_images`, `extract_tables`, `extract_meta`
- Screenshots: `screenshot`, `screenshot_element`, `save_pdf`
- JavaScript: `evaluate`, `run_script`, `click_and_read`, `click_and_wait`, `navigate_and_read`
- Network: `start_network_capture`, `network`, `network_details`, `clear_network`, `mock_route`, `clear_mocks`, `throttle_network`
- Storage: `get_cookies`, `set_cookie`, `delete_cookies`, `local_storage`, `set_local_storage`, `delete_local_storage`, `session_storage`, `set_session_storage`, `delete_session_storage`, `get_indexed_db`, `list_indexed_dbs`, `export_storage`, `import_storage`
- Console: `start_console`, `get_console`, `console_filter`, `clear_console`
- Accessibility: `accessibility_snapshot`, `analyze_page`, `get_computed_style`
- Clipboard: `clipboard_read`, `clipboard_write`, `paste_image`
- Emulation: `emulate`, `resize`, `reset_emulation`, `override_geolocation`
- Waiting: `wait`, `wait_for`, `wait_for_new_tab`
- Other: `handle_dialog`, `performance_metrics`, `css_coverage`, `replace_editor`
- Built on AppleScript + JavaScript injection via `osascript`
- Tab safety: per-session tracking to never hijack user tabs
- macOS-native: zero browser overhead, no Chrome/Chromium dependency

[2.1.5]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.4...v2.1.5
[2.1.4]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.3...v2.1.4
[2.1.3]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.2...v2.1.3
[2.1.2]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/achiya-automation/safari-mcp/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/achiya-automation/safari-mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/achiya-automation/safari-mcp/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/achiya-automation/safari-mcp/releases/tag/v1.0.0
