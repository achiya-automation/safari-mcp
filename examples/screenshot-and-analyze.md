# Screenshot and Analyze

Take screenshots of websites for visual inspection, capture specific elements, and export pages as PDF. Since Safari MCP uses your real browser, screenshots show the page exactly as you see it -- with your theme, extensions, and logged-in state.

## 1. Take a full-page screenshot

Navigate to a page and capture the entire scrollable content.

```json
// Step 1: Open a new tab (never touch user's existing tabs)
{ "tool": "safari_new_tab", "arguments": { "url": "https://github.com/trending" } }

// Step 2: Wait for the page to fully render
{ "tool": "safari_wait_for", "arguments": { "selector": "article.Box-row", "timeout": 5000 } }

// Step 3: Full-page screenshot
{ "tool": "safari_screenshot", "arguments": { "fullPage": true } }
```

**Expected output:** A base64-encoded JPEG image of the entire page, including content below the fold. The AI agent receives this as an image content block it can analyze visually.

## 2. Screenshot just the viewport

Capture only what's visible without scrolling.

```json
{ "tool": "safari_screenshot", "arguments": {} }
```

**Expected output:** Base64 JPEG of the current viewport (visible area only). Faster and smaller than full-page.

## 3. Screenshot a specific element

Capture a single element, useful for inspecting a component, chart, or error message.

```json
// Capture only the navigation bar
{ "tool": "safari_screenshot_element", "arguments": { "selector": "nav.global-nav" } }
```

**Expected output:** A cropped screenshot containing only the matched element and its contents.

## 4. Analyze a page without a screenshot

For most tasks, `safari_snapshot` is cheaper and faster than a screenshot. It returns a structured accessibility tree with ref IDs for every interactive element.

```json
// Preferred: structured text instead of a heavy image
{ "tool": "safari_snapshot", "arguments": {} }
```

**Expected output:** Text-based accessibility tree showing headings, links, buttons, inputs, and their ref IDs. Example:
```
[heading] Trending repositories
[link ref=0_12] "javascript" href="/trending/javascript"
[link ref=0_13] "python" href="/trending/python"
[button ref=0_20] "Date range: Today"
```

## 5. Full page analysis in one call

Get a comprehensive audit: title, meta tags, heading structure, link stats, image stats, and forms.

```json
{ "tool": "safari_analyze_page", "arguments": {} }
```

**Expected output:** JSON with title, URL, meta description, OG tags, heading hierarchy (H1-H6 counts), total links (internal/external), images (with/without alt text), and detected forms.

## 6. Export page as PDF

Save the current page as a PDF file.

```json
{ "tool": "safari_save_pdf", "arguments": { "path": "/tmp/github-trending.pdf" } }
```

**Expected output:** PDF saved to the specified path. Note: this tool briefly activates Safari (brings it to foreground) because it uses the native Export menu.

## Why this works without re-authenticating

Because Safari MCP operates on your real Safari profile, screenshots of GitHub show your logged-in dashboard, not a login page. The same applies to Gmail, Slack, Jira, or any site where you have an active session.
