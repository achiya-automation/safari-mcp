<div align="center">

# 🦁 Safari MCP

**The only MCP server for Safari — native browser automation for AI agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/achiya-automation/safari-mcp)](https://github.com/achiya-automation/safari-mcp/releases)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![macOS](https://img.shields.io/badge/macOS-only-blue)](https://www.apple.com/macos/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io)
[![achiya-automation/safari-mcp MCP server](https://glama.ai/mcp/servers/achiya-automation/safari-mcp/badges/score.svg)](https://glama.ai/mcp/servers/achiya-automation/safari-mcp)

**80 tools** · **Zero dependencies** · **~5ms per command** · **60% less CPU than Chrome**

[Quick Start](#quick-start) · [All 80 Tools](#tools-80) · [Why Safari MCP?](#safari-mcp-vs-alternatives) · [Architecture](#architecture)

</div>

---

> **TL;DR:** Use your real Safari with all your logins, cookies, and sessions. No headless browsers, no Chrome, no Puppeteer. Just pure AppleScript + JavaScript running natively on macOS — 60% less CPU/heat on Apple Silicon.

<details>
<summary><b>🤔 Why not just use Playwright or Chrome DevTools MCP?</b></summary>

| Problem | Safari MCP Solution |
|---------|-------------------|
| Chrome DevTools MCP heats up your Mac | Native WebKit — ~60% less CPU |
| Playwright launches a new browser without your logins | Uses your **real Safari** with all sessions |
| Puppeteer requires Chrome + debug port | Zero dependencies — just AppleScript |
| Headless browsers can't access your authenticated sessions | Gmail, GitHub, Slack — already logged in |
| Browser automation steals window focus | Safari stays in background, never interrupts |

</details>

---

## Highlights

- **80 tools** — navigation, clicks, forms, screenshots, network, storage, accessibility, and more
- **Zero heat** — native WebKit on Apple Silicon, ~60% less CPU than Chrome
- **Your real browser** — keeps all logins, cookies, sessions (Gmail, GitHub, Ahrefs, etc.)
- **Background operation** — Safari stays in the background, no window stealing
- **No dependencies** — no Puppeteer, no Playwright, no WebDriver, no Chrome
- **Persistent process** — reuses a single osascript process (~5ms per command vs ~80ms)
- **Framework-compatible** — React, Vue, Angular, Svelte form filling via native setters

---

## Quick Start

### Prerequisites

- macOS (any version with Safari)
- Node.js 18+
- Safari → Settings → Advanced → **Show features for web developers** ✓
- Safari → Develop → **Allow JavaScript from Apple Events** ✓

### Install

```bash
git clone https://github.com/achiya-automation/safari-mcp.git
cd safari-mcp
npm install
```

### Configure

Add to your MCP client config:

<details>
<summary><b>Claude Code</b> (~/.mcp.json)</summary>

```json
{
  "mcpServers": {
    "safari": {
      "command": "node",
      "args": ["/path/to/safari-mcp/index.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Claude Desktop</b> (claude_desktop_config.json)</summary>

```json
{
  "mcpServers": {
    "safari": {
      "command": "node",
      "args": ["/path/to/safari-mcp/index.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b> (.cursor/mcp.json)</summary>

```json
{
  "mcpServers": {
    "safari": {
      "command": "node",
      "args": ["/path/to/safari-mcp/index.js"]
    }
  }
}
```
</details>

<details>
<summary><b>Windsurf / VS Code + Continue</b></summary>

```json
{
  "mcpServers": {
    "safari": {
      "command": "node",
      "args": ["/path/to/safari-mcp/index.js"]
    }
  }
}
```
</details>

---

## Tools (80)

### Navigation (4)
| Tool | Description |
|------|-------------|
| `safari_navigate` | Navigate to URL (auto HTTPS, wait for load) |
| `safari_go_back` | Go back in history |
| `safari_go_forward` | Go forward in history |
| `safari_reload` | Reload page (optional hard reload) |

### Page Reading (3)
| Tool | Description |
|------|-------------|
| `safari_read_page` | Get title, URL, and text content |
| `safari_get_source` | Get full HTML source |
| `safari_navigate_and_read` | Navigate + read in one call |

### Click & Interaction (5)
| Tool | Description |
|------|-------------|
| `safari_click` | Click by CSS selector, visible text, or coordinates |
| `safari_double_click` | Double-click (select word, etc.) |
| `safari_right_click` | Right-click (context menu) |
| `safari_hover` | Hover over element |
| `safari_click_and_wait` | Click + wait for navigation |

### Form Input (7)
| Tool | Description |
|------|-------------|
| `safari_fill` | Fill input (React/Vue/Angular compatible) |
| `safari_clear_field` | Clear input field |
| `safari_select_option` | Select dropdown option |
| `safari_fill_form` | Batch fill multiple fields |
| `safari_fill_and_submit` | Fill form + submit in one call |
| `safari_type_text` | Type real keystrokes (JS-based, no System Events) |
| `safari_press_key` | Press key with modifiers |

### Screenshots & PDF (3)
| Tool | Description |
|------|-------------|
| `safari_screenshot` | Screenshot as PNG (viewport or full page) |
| `safari_screenshot_element` | Screenshot a specific element |
| `safari_save_pdf` | Export page as PDF |

### Scroll (3)
| Tool | Description |
|------|-------------|
| `safari_scroll` | Scroll up/down by pixels |
| `safari_scroll_to` | Scroll to exact position |
| `safari_scroll_to_element` | Smooth scroll to element |

### Tab Management (4)
| Tool | Description |
|------|-------------|
| `safari_list_tabs` | List all tabs (index, title, URL) |
| `safari_new_tab` | Open new tab (background, no focus steal) |
| `safari_close_tab` | Close tab |
| `safari_switch_tab` | Switch to tab by index |

### Wait (2)
| Tool | Description |
|------|-------------|
| `safari_wait_for` | Wait for element, text, or URL change |
| `safari_wait` | Wait for specified milliseconds |

### JavaScript (1)
| Tool | Description |
|------|-------------|
| `safari_evaluate` | Execute arbitrary JavaScript, return result |

### Element Inspection (4)
| Tool | Description |
|------|-------------|
| `safari_get_element` | Element details (tag, rect, attrs, visibility) |
| `safari_query_all` | Find all matching elements |
| `safari_get_computed_style` | Computed CSS styles |
| `safari_detect_forms` | Auto-detect all forms with field selectors |

### Accessibility (1)
| Tool | Description |
|------|-------------|
| `safari_accessibility_snapshot` | Full a11y tree: roles, ARIA, focusable elements |

### Drag & Drop (1)
| Tool | Description |
|------|-------------|
| `safari_drag` | Drag between elements or coordinates |

### File Operations (2)
| Tool | Description |
|------|-------------|
| `safari_upload_file` | Upload file via JS DataTransfer (no file dialog!) |
| `safari_paste_image` | Paste image into editor (no clipboard touch!) |

### Dialog & Window (2)
| Tool | Description |
|------|-------------|
| `safari_handle_dialog` | Handle alert/confirm/prompt |
| `safari_resize` | Resize browser window |

### Device Emulation (2)
| Tool | Description |
|------|-------------|
| `safari_emulate` | Emulate device (iPhone, iPad, Pixel, Galaxy) |
| `safari_reset_emulation` | Reset to desktop |

### Cookies & Storage (10)
| Tool | Description |
|------|-------------|
| `safari_get_cookies` | Get all cookies |
| `safari_set_cookie` | Set cookie with all options |
| `safari_delete_cookies` | Delete one or all cookies |
| `safari_local_storage` | Read localStorage |
| `safari_set_local_storage` | Write localStorage |
| `safari_delete_local_storage` | Delete/clear localStorage |
| `safari_session_storage` | Read sessionStorage |
| `safari_set_session_storage` | Write sessionStorage |
| `safari_delete_session_storage` | Delete/clear sessionStorage |
| `safari_export_storage` | Export all storage as JSON (backup/restore sessions) |
| `safari_import_storage` | Import storage state from JSON |

### Clipboard (2)
| Tool | Description |
|------|-------------|
| `safari_clipboard_read` | Read clipboard text |
| `safari_clipboard_write` | Write text to clipboard |

### Network (6)
| Tool | Description |
|------|-------------|
| `safari_network` | Quick network requests via Performance API |
| `safari_start_network_capture` | Start detailed capture (fetch + XHR) |
| `safari_network_details` | Get captured requests with headers/timing |
| `safari_clear_network` | Clear captured requests |
| `safari_mock_route` | Mock network responses (intercept fetch/XHR) |
| `safari_clear_mocks` | Remove all network mocks |

### Console (4)
| Tool | Description |
|------|-------------|
| `safari_start_console` | Start capturing console messages |
| `safari_get_console` | Get all captured messages |
| `safari_clear_console` | Clear captured messages |
| `safari_console_filter` | Filter by level (log/warn/error) |

### Performance (2)
| Tool | Description |
|------|-------------|
| `safari_performance_metrics` | Navigation timing, Web Vitals, memory |
| `safari_throttle_network` | Simulate slow-3g/fast-3g/4g/offline |

### Data Extraction (4)
| Tool | Description |
|------|-------------|
| `safari_extract_tables` | Tables as structured JSON |
| `safari_extract_meta` | All meta: OG, Twitter, JSON-LD, canonical |
| `safari_extract_images` | Images with dimensions and loading info |
| `safari_extract_links` | Links with rel, external/nofollow detection |

### Advanced (5)
| Tool | Description |
|------|-------------|
| `safari_override_geolocation` | Override browser geolocation |
| `safari_list_indexed_dbs` | List IndexedDB databases |
| `safari_get_indexed_db` | Read IndexedDB records |
| `safari_css_coverage` | Find unused CSS rules |
| `safari_analyze_page` | Full page analysis in one call |

### Automation (1)
| Tool | Description |
|------|-------------|
| `safari_run_script` | Run multiple actions in a single call (batch) |

---

## Safari MCP vs Alternatives

| Feature | Safari MCP | Chrome DevTools MCP | Playwright MCP |
|---------|:----------:|:-------------------:|:--------------:|
| CPU/Heat | 🟢 Minimal | 🔴 High | 🟡 Medium |
| Your logins | ✅ Yes | ✅ Yes | ❌ No |
| macOS native | ✅ WebKit | ❌ Chromium | ❌ Chromium/WebKit |
| Dependencies | None | Chrome + debug port | Playwright runtime |
| Tools | 80 | ~30 | ~25 |
| File upload | JS (no dialog) | CDP | Playwright API |
| Image paste | JS (no clipboard) | CDP | Playwright API |
| Focus steal | ❌ Background | ❌ Background | ❌ Headless |
| Network mocking | ✅ | ❌ | ✅ |
| Lighthouse | ❌ | ✅ | ❌ |
| Performance trace | ❌ | ✅ | ❌ |

> **Tip:** Use Safari MCP for daily browsing tasks (95% of work) and Chrome DevTools MCP only for Lighthouse/Performance audits.

---

## Architecture

Safari MCP uses a **dual-engine** architecture — the Extension is preferred for speed and advanced capabilities, with AppleScript as an always-available fallback:

```
Claude/Cursor/AI Agent
        ↓ MCP Protocol (stdio)
   Safari MCP Server (Node.js)
        ↓                    ↓
   Extension (HTTP)     AppleScript + Swift daemon
   (~5-20ms/cmd)        (~5ms/cmd, always available)
        ↓                    ↓
   Content Script       do JavaScript in tab N
        ↓                    ↓
   Page DOM ←←←←←←←←←← Page DOM
```

**Key design decisions:**
- **Dual engine with automatic fallback** — Extension is preferred; if not connected, AppleScript handles everything seamlessly
- **Persistent Swift helper** — one long-running process instead of spawning per command (16x faster)
- **Tab-indexed operations** — all JS runs on a specific tab by index, never steals visual focus
- **JS-first approach** — typing, clicking, file upload all use JavaScript events (no System Events keyboard conflicts)
- **No `activate`** — Safari is never brought to foreground

---

## Safari Extension (Optional)

The Safari MCP Extension is **optional but recommended**. Without it, ~80% of functionality works via AppleScript alone. The extension adds capabilities that AppleScript cannot provide:

### What the Extension Adds

| Capability | With Extension | AppleScript Only |
|-----------|:--------------:|:----------------:|
| Closed Shadow DOM (Reddit, Web Components) | ✅ Full access | ❌ Invisible |
| Strict CSP sites | ✅ Bypasses via MAIN world | ❌ Often blocked |
| React/Vue/Angular state manipulation | ✅ Deep (Fiber, ProseMirror) | ⚠️ Basic |
| Loading state detection (spinners, skeletons) | ✅ Smart detection | ❌ No |
| Dialog handling (alert/confirm) | ❌ | ✅ Only AppleScript |
| Native OS-level click (CGEvent) | ❌ | ✅ Only AppleScript |
| PDF export | ❌ | ✅ Only AppleScript |

> **When do you need the extension?** If you're automating modern SPAs with closed shadow DOM (e.g., Reddit), sites with strict Content Security Policy, or framework-heavy editors (Draft.js, ProseMirror, Slate).

### Installing the Extension

The extension requires a one-time build with Xcode (free, included with macOS):

**Prerequisites:** Xcode (install from App Store — free)

```bash
# 1. Build the extension app
cd safari-mcp
xcodebuild -project "xcode/Safari MCP/Safari MCP.xcodeproj" \
  -scheme "Safari MCP (macOS)" -configuration Release build

# 2. Find and open the built app
open ~/Library/Developer/Xcode/DerivedData/Safari_MCP-*/Build/Products/Release/Safari\ MCP.app
```

Then in Safari:
1. Safari → Settings → Advanced → enable **Show features for web developers**
2. Safari → Develop → **Allow Unsigned Extensions** (required each Safari restart)
3. Safari → Settings → Extensions → enable **Safari MCP Bridge**

The extension connects automatically to the MCP server on port `9224`.

> **Note:** "Allow Unsigned Extensions" resets every time Safari restarts. You'll need to re-enable it in the Develop menu after each restart. The extension itself stays installed.

**Toolbar icon status:**
- **ON** — connected to MCP server
- **OFF** — manually disabled via popup
- *(no badge)* — server not running, will auto-reconnect

---

## macOS Permissions

Safari MCP needs these one-time permissions:

| Permission | Where | Why |
|-----------|-------|-----|
| JavaScript from Apple Events | Safari → Develop menu | Required for `do JavaScript` |
| Screen Recording | System Settings → Privacy | Required for `safari_screenshot` |
| Accessibility | System Settings → Privacy | Required for `safari_save_pdf` only |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "AppleScript error" | Enable "Allow JavaScript from Apple Events" in Safari → Develop |
| Screenshots empty | Grant Screen Recording permission to Terminal/VS Code |
| Tab not found | Call `safari_list_tabs` to refresh tab indices |
| Hebrew keyboard issues | All typing uses JS events — immune to keyboard layout |
| HTTPS blocked | `safari_navigate` auto-tries HTTPS first, falls back to HTTP |
| Safari steals focus | Ensure you're on latest version — `newTab` restores your active tab |

---

## Works With

Safari MCP works with any MCP-compatible client:

| Client | Status |
|--------|--------|
| [Claude Code](https://claude.ai/claude-code) | ✅ Tested daily |
| [Claude Desktop](https://claude.ai/download) | ✅ Tested |
| [Cursor](https://cursor.sh) | ✅ Tested |
| [Windsurf](https://codeium.com/windsurf) | ✅ Compatible |
| [VS Code + Continue](https://continue.dev) | ✅ Compatible |

---

## Contributing

PRs welcome! The codebase is two files:
- `safari.js` — Safari automation layer (AppleScript + JavaScript)
- `index.js` — MCP server with tool definitions

---

## Star History

If Safari MCP saved you from Chrome overhead, consider giving it a ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=achiya-automation/safari-mcp&type=Date)](https://star-history.com/#achiya-automation/safari-mcp&Date)

---

## License

MIT — use it however you want.
