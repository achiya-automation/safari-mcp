<div align="center">

<img src="social-preview.png" alt="Safari MCP Server — 80 native browser automation tools for AI agents on macOS" width="100%">

<br/>

# 🦁 Safari MCP

**The only MCP server for Safari — native browser automation for AI agents.**

[![npm version](https://img.shields.io/npm/v/safari-mcp)](https://www.npmjs.com/package/safari-mcp)
[![npm downloads](https://img.shields.io/npm/dm/safari-mcp)](https://www.npmjs.com/package/safari-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![macOS](https://img.shields.io/badge/macOS-only-blue)](https://www.apple.com/macos/)
[![GitHub stars](https://img.shields.io/github/stars/achiya-automation/safari-mcp?style=social)](https://github.com/achiya-automation/safari-mcp/stargazers)

[![MCP Registry](https://img.shields.io/badge/MCP-Registry-purple?logo=anthropic)](https://registry.modelcontextprotocol.io/)
[![Glama](https://img.shields.io/badge/Glama-Listed-7c3aed)](https://glama.ai/mcp/servers/g0upg7gyex)
[![Awesome MCP](https://img.shields.io/badge/Awesome%20MCP-Featured-ff69b4)](https://github.com/punkpeye/awesome-mcp-servers)
[![Featured on HackerNoon](https://img.shields.io/badge/Featured%20on-HackerNoon-00FE9A?logo=hackernoon&logoColor=black)](https://hackernoon.com/i-had-to-reverse-engineer-react-shadow-dom-and-csp-to-automate-safari-without-chrome)
[![Featured in CLI-Anything](https://img.shields.io/badge/Featured%20in-CLI--Anything-blueviolet)](https://github.com/HKUDS/CLI-Anything/pull/212)

<a href="vscode:mcp/install?%7B%22safari-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22safari-mcp%22%5D%7D%7D"><img src="https://img.shields.io/badge/VS_Code-Install_Server-0078d4?logo=visual-studio-code&logoColor=white" alt="Install in VS Code"></a>
<a href="https://insiders.vscode.dev/redirect?url=vscode-insiders:mcp/install?%7B%22safari-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22safari-mcp%22%5D%7D%7D"><img src="https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?logo=visual-studio-code&logoColor=white" alt="Install in VS Code Insiders"></a>
<a href="cursor://anysphere.cursor-deeplink/mcp/install?name=safari-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22safari-mcp%22%5D%7D"><img src="https://img.shields.io/badge/Cursor-Install_Server-f97316?logo=cursor&logoColor=white" alt="Install in Cursor"></a>

**80 tools** · **No Chrome/Puppeteer/Playwright needed** · **~5ms per command** · **60% less CPU than Chrome**

[Quick Start](#quick-start) · [All 80 Tools](#tools-80) · [Examples](examples/) · [Why Safari MCP?](#safari-mcp-vs-alternatives) · [Architecture](#architecture) · [Changelog](CHANGELOG.md)

![Safari MCP Demo](https://github.com/achiya-automation/safari-mcp/releases/download/v2.1.2/safari-mcp-showcase.gif)

</div>

> **TL;DR:** Use your real Safari with all your logins, cookies, and sessions. No headless browsers, no Chrome, no Puppeteer. Just native AppleScript + JavaScript on macOS — 60% less CPU/heat on Apple Silicon.

> 📰 **Featured on HackerNoon:** [I Had to Reverse-Engineer React, Shadow DOM, and CSP to Automate Safari Without Chrome](https://hackernoon.com/i-had-to-reverse-engineer-react-shadow-dom-and-csp-to-automate-safari-without-chrome) — the three hardest technical problems behind Safari MCP and the code that solved them.

### 🤔 Why not just use Playwright or Chrome DevTools MCP?

| Problem | Safari MCP Solution |
|---------|-------------------|
| Chrome DevTools MCP heats up your Mac | Native WebKit — ~60% less CPU |
| Playwright launches a new browser without your logins | Uses your **real Safari** with all sessions |
| Puppeteer requires Chrome + debug port | Just AppleScript — no extra browser |
| Headless browsers can't access your authenticated sessions | Gmail, GitHub, Slack — already logged in |
| Browser automation steals window focus | Safari stays in background, never interrupts |

---

## Highlights

- **80 tools** — navigation, clicks, forms, screenshots, network, storage, accessibility, and more
- **Zero heat** — native WebKit on Apple Silicon, ~60% less CPU than Chrome
- **Your real browser** — keeps all logins, cookies, sessions (Gmail, GitHub, Ahrefs, etc.)
- **Background operation** — Safari stays in the background, no window stealing
- **No browser dependencies** — no Puppeteer, no Playwright, no WebDriver, no Chrome
- **Persistent process** — reuses a single osascript process (~5ms per command vs ~80ms)
- **Framework-compatible** — React, Vue, Angular, Svelte form filling via native setters

---

## Quick Start

### Prerequisites

- macOS (any version with Safari)
- Node.js 18+
- Safari → Settings → Advanced → **Show features for web developers** ✓
- Safari → Develop → **Allow JavaScript from Apple Events** ✓

### Install (one command)

```bash
npx safari-mcp
```

That's it — no global install needed. Or install permanently:

```bash
npm install -g safari-mcp
```

### Configure your MCP client

Add to your client's config file — all clients use the same JSON:

```json
{
  "mcpServers": {
    "safari": {
      "command": "npx",
      "args": ["safari-mcp"]
    }
  }
}
```

<details>
<summary><b>Where does each client store this?</b></summary>

| Client | Config file |
|--------|------------|
| **Claude Code** | `~/.mcp.json` |
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Cursor** | `.cursor/mcp.json` in your project |
| **Windsurf** | `.windsurf/mcp.json` in your project |
| **VS Code + Continue** | `.vscode/mcp.json` in your project |

</details>

<details>
<summary><b>Alternative: Homebrew</b></summary>

```bash
brew install achiya-automation/tap/safari-mcp
```
</details>

<details>
<summary><b>Alternative: from source</b></summary>

```bash
git clone https://github.com/achiya-automation/safari-mcp.git
cd safari-mcp && npm install
```
</details>

---

<div align="center">

### ⭐ Found Safari MCP useful?

**A star takes 2 seconds and helps other macOS developers discover this.**

[![Star on GitHub](https://img.shields.io/github/stars/achiya-automation/safari-mcp?style=for-the-badge&logo=github&color=yellow&label=Star%20this%20repo)](https://github.com/achiya-automation/safari-mcp)

*4,000+ developers install Safari MCP every month. Less than 1% star it.*
*If it saves you Chrome heat, give it back a click.*

📰 **[Read the deep-dive on HackerNoon →](https://hackernoon.com/i-had-to-reverse-engineer-react-shadow-dom-and-csp-to-automate-safari-without-chrome)**

</div>

---

## Usage Workflow

The recommended pattern for AI agents using Safari MCP:

```
1. safari_snapshot        → Get page state (accessibility tree)
2. safari_click/fill/...  → Interact with elements by ref
3. safari_snapshot        → Verify the result
```

**Element targeting** — tools accept multiple targeting strategies:

| Strategy | Example | Best for |
|----------|---------|----------|
| CSS selector | `#login-btn`, `.submit` | Unique elements |
| Visible text | `"Sign In"`, `"Submit"` | Buttons, links |
| Coordinates | `x: 100, y: 200` | Canvas, custom widgets |
| Ref from snapshot | `ref: "e42"` | Any element from accessibility tree |

> **Tip:** Start with `safari_snapshot` to get element refs, then use refs for precise targeting. This is faster and more reliable than CSS selectors.

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

## Security

Safari MCP runs locally on your Mac with minimal attack surface:

| Aspect | Detail |
|--------|--------|
| Network | **No remote connections** — all communication is local (stdio + localhost) |
| Permissions | macOS system permissions required (Screen Recording for screenshots) |
| Data | No telemetry, no analytics, no data sent anywhere |
| Extension | Communicates only with `localhost:9224`, validated by Safari |
| Code | Fully open source (MIT) — audit every line |

---

## Safari MCP vs Alternatives

| Feature | Safari MCP | Chrome DevTools MCP | Playwright MCP |
|---------|:----------:|:-------------------:|:--------------:|
| CPU/Heat | 🟢 Minimal | 🔴 High | 🟡 Medium |
| Your logins | ✅ Yes | ✅ Yes | ❌ No |
| macOS native | ✅ WebKit | ❌ Chromium | ❌ Chromium/WebKit |
| Browser dependencies | None | Chrome + debug port | Playwright runtime |
| Tools | 80 | ~30 | ~25 |
| File upload | JS (no dialog) | CDP | Playwright API |
| Image paste | JS (no clipboard) | CDP | Playwright API |
| Focus steal | ❌ Background | ❌ Background | ❌ Headless |
| Network mocking | ✅ | ❌ | ✅ |
| Lighthouse | ❌ | ✅ | ❌ |
| Performance trace | ❌ | ✅ | ❌ |

> **Tip:** Use Safari MCP for daily browsing tasks (95% of work) and Chrome DevTools MCP only for Lighthouse/Performance audits.

### Why Safari MCP and Not the Other Safari MCP Projects?

There are several "safari-mcp" projects floating around. Here's how they compare:

| Feature | **🦁 safari-mcp** *(this repo)* | [lxman/safari-mcp-server](https://github.com/lxman/safari-mcp-server) | [Epistates/MCPSafari](https://github.com/Epistates/MCPSafari) | [HayoDev/safari-devtools-mcp](https://github.com/HayoDev/safari-devtools-mcp) |
|---------|:------------------------------:|:----------------------:|:------------:|:----------------------:|
| **Tools** | **80** | ~10 | 23 | ~15 |
| **Install** | `npx safari-mcp` | Manual | Binary | `npx` |
| **Engine** | **Dual** (Extension + AppleScript) | WebDriver | Extension only | DevTools Protocol |
| **Keeps your real Safari logins** | ✅ Yes | ⚠️ Limited | ✅ Yes | ❌ Debug session |
| **Background (no focus steal)** | ✅ Yes | ❌ No | ⚠️ Sometimes | ✅ Yes |
| **Storage tools** (cookies, localStorage, IndexedDB) | **10** | 0 | 0 | 2 |
| **Data extraction** (tables, meta, images, links) | **4** | 0 | 0 | 0 |
| **Network mocking** | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **Device emulation** (iPhone, iPad, Pixel) | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **File upload** (no dialog) | ✅ JS DataTransfer | ❌ No | ❌ No | ❌ No |
| **Image paste** (no clipboard touch) | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **PDF export** | ✅ Yes | ❌ No | ❌ No | ❌ No |
| **Console capture** | **4 tools** | 0 | 1 | 1 |
| **Performance metrics + Web Vitals** | ✅ Yes | ❌ No | ❌ No | ⚠️ Partial |
| **Active maintenance** | ✅ Multiple releases/week | 🟡 Sporadic | 🟡 Slow | 🟡 Slow |
| **License** | **MIT** | MIT | None specified | MIT |
| **In MCP Registry** | ✅ | ❌ | ❌ | ✅ |
| **In Awesome MCP** | ✅ | ❌ | ❌ | ❌ |

> **TL;DR** — if you want the most complete Safari MCP with the smoothest install, the most tools, and active maintenance, **this is the one**.

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

The extension requires a one-time build with Xcode (free, included with macOS).

> **Note for npm users:** The `xcode/` directory is not included in the npm package.
> Clone the [GitHub repository](https://github.com/achiya-automation/safari-mcp) to build from source.

**Prerequisites:** Xcode (install from App Store — free)

```bash
# 1. Clone the repo (the npm package does not include the Xcode project)
git clone https://github.com/achiya-automation/safari-mcp.git
cd safari-mcp

# 2. Build the extension
xcodebuild -project "xcode/Safari MCP/Safari MCP.xcodeproj" \
  -scheme "Safari MCP (macOS)" -configuration Release build

# 3. Ad-hoc sign the built app so Safari will load it
# (xcodebuild without a signing identity produces a bundle Safari silently rejects)
APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData/Safari_MCP-*/Build/Products/Release -name "Safari MCP.app" -maxdepth 2 | head -1)
codesign --sign - --force --deep "$APP_PATH"

# 4. Re-sign safari-helper with the Apple Events entitlement
# (helps macOS surface the TCC Automation prompt reliably)
codesign --sign - --force --entitlements safari-helper.entitlements safari-helper

# 4. Open the app (needed once so Safari registers the extension)
open "$APP_PATH"
```

Alternatively, open `xcode/Safari MCP/Safari MCP.xcodeproj` directly in Xcode, select your Apple ID under Signing & Capabilities, and click Run. A free personal Apple Developer account is sufficient for local use.

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
| Automation → Safari | System Settings → Privacy & Security → Automation | Required for all AppleScript-backed tools |
| Screen Recording | System Settings → Privacy & Security → Screen Recording | Required for `safari_screenshot` |
| Accessibility | System Settings → Privacy & Security → Accessibility | Required for `safari_save_pdf` only |

### Granting Automation → Safari (important for IDE users)

macOS TCC grants Automation permission to the **parent process** that spawns the MCP server, not to `safari-mcp` itself. So you need to grant **Automation → Safari** to the app that runs Claude Code / Cursor / Windsurf — typically **Visual Studio Code** or **Terminal**.

If the permission dialog never appears automatically, run this command once from a Terminal that already has Automation permission:

```bash
osascript -e 'tell application "Safari" to get URL of current tab of window 1'
```

That call registers the Terminal app in the Automation database and then triggers the prompt for Safari. After you approve it, subsequent MCP calls from any child process chain will work.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "AppleScript error" | Enable "Allow JavaScript from Apple Events" in Safari → Develop |
| "Not authorized to send Apple events to Safari" | Grant Automation → Safari to your IDE (see above) |
| "Not authorized" after `npm update` | Updating changes the binary's cdhash — macOS silently revokes Automation permission. Re-run the `osascript` one-liner above to re-grant it |
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

PRs welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions.

The codebase is two files:
- `safari.js` — Safari automation layer (AppleScript + JavaScript)
- `index.js` — MCP server with tool definitions

---

## Sponsors

Safari MCP is free and open source. If it saves you time or CPU cycles, consider supporting its development:

<a href="https://paypal.me/achiyaC123"><img src="https://img.shields.io/badge/Sponsor-PayPal-blue?logo=paypal" alt="Sponsor via PayPal"></a>

Your support funds:
- 🧪 Testing across macOS versions and Safari releases
- 🛠️ New tools and features
- 📖 Documentation and examples

[Become the first sponsor!](https://paypal.me/achiyaC123)

---

## Community

**2,000+ monthly npm downloads** — developers are using Safari MCP to build AI agents on macOS.

- [GitHub Discussions](https://github.com/achiya-automation/safari-mcp/discussions) — ask questions, share use cases
- [Issues](https://github.com/achiya-automation/safari-mcp/issues) — bug reports and feature requests
- [![Good First Issues](https://img.shields.io/github/issues/achiya-automation/safari-mcp/good%20first%20issue?color=7057ff&label=good%20first%20issues)](https://github.com/achiya-automation/safari-mcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) — start contributing

---

## Ecosystem

Other macOS MCP servers that complement Safari MCP:

| Project | What it does | When to use |
|---------|-------------|-------------|
| [mcp-server-macos-use](https://github.com/mediar-ai/mcp-server-macos-use) | OS-level macOS automation (accessibility, screen control) | System-wide interactions beyond Safari |
| [chrome-devtools-mcp](https://github.com/anthropics/chrome-devtools-mcp) | Chrome DevTools Protocol | Lighthouse audits, Chrome-specific performance traces |

> Using Safari MCP alongside Chrome DevTools MCP? Safari handles 95% of daily browsing (zero overhead), Chrome handles the 5% that needs Lighthouse or Chrome-specific traces.

---

## Like it? Give it a ⭐

If Safari MCP saves you from Chrome overhead, **a star helps others discover it:**

[![Star this repo](https://img.shields.io/github/stars/achiya-automation/safari-mcp?style=social)](https://github.com/achiya-automation/safari-mcp)

[Share on Twitter/X](https://twitter.com/intent/tweet?text=Safari%20MCP%20%E2%80%94%20Stop%20running%20Chrome%20just%20so%20your%20AI%20agent%20can%20browse.%2080%20tools%2C%20native%20Safari%2C%2060%25%20less%20CPU.&url=https%3A%2F%2Fgithub.com%2Fachiya-automation%2Fsafari-mcp) · [Share on LinkedIn](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fgithub.com%2Fachiya-automation%2Fsafari-mcp) · [Write about it](https://dev.to/)

[![Star History Chart](https://api.star-history.com/svg?repos=achiya-automation/safari-mcp&type=Date)](https://star-history.com/#achiya-automation/safari-mcp&Date)

---

## Listed On

[![Glama](https://glama.ai/mcp/servers/achiya-automation/safari-mcp/badges/score.svg)](https://glama.ai/mcp/servers/achiya-automation/safari-mcp) [![MCP Registry](https://img.shields.io/badge/MCP-Registry-purple)](https://registry.modelcontextprotocol.io/) [![CI](https://github.com/achiya-automation/safari-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/achiya-automation/safari-mcp/actions/workflows/ci.yml)

---

## License

MIT — use it however you want.
