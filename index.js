#!/usr/bin/env node
// Safari MCP Server - שליטה מלאה ב-Safari דרך AppleScript
// קל על המחשב, שומר לוגינים, רץ ברקע

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as safari from "./safari.js";

const server = new McpServer({
  name: "safari-mcp",
  version: "1.0.0",
  description: "Safari browser automation - lightweight, keeps logins",
});

// ========== NAVIGATION ==========

server.tool(
  "safari_navigate",
  "Navigate to a URL in Safari. Waits for page to fully load.",
  { url: z.string().describe("URL to navigate to") },
  async ({ url }) => {
    const result = await safari.navigate(url);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_go_back",
  "Go back in browser history",
  {},
  async () => {
    const result = await safari.goBack();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_go_forward",
  "Go forward in browser history",
  {},
  async () => {
    const result = await safari.goForward();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_reload",
  "Reload the current page",
  { hard: z.boolean().optional().describe("Hard reload (bypass cache)") },
  async ({ hard }) => {
    const result = await safari.reload(hard);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

// ========== PAGE INFO ==========

server.tool(
  "safari_read_page",
  "Read page content (title, URL, text). Use selector to read specific element. Use maxLength to limit output.",
  {
    selector: z.string().optional().describe("CSS selector to read specific element"),
    maxLength: z.coerce.number().optional().describe("Max chars to return (default: 50000)"),
  },
  async ({ selector, maxLength }) => {
    const result = await safari.readPage({ selector, maxLength });
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_get_source",
  "Get HTML source of current page",
  { maxLength: z.coerce.number().optional().describe("Max chars (default: 200000)") },
  async ({ maxLength }) => {
    const result = await safari.getPageSource({ maxLength });
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== SNAPSHOT (ref-based interaction like Chrome DevTools MCP) ==========

server.tool(
  "safari_snapshot",
  "Get page accessibility tree with ref IDs for every interactive element. Use refs with click/fill/type instead of CSS selectors. PREFERRED workflow: snapshot → see refs → click({ref:'0_5'})",
  { selector: z.string().optional().describe("CSS selector for subtree (default: full page)") },
  async (args) => {
    const result = await safari.takeSnapshot(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== CLICK ==========

server.tool(
  "safari_click",
  "Click element. Use ref (from snapshot), selector, text, or x/y. Set force=true for React/Airtable apps that don't respond to JS clicks (uses OS-level mouse click).",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot (e.g. '0_5')"),
    selector: z.string().optional().describe("CSS selector"),
    text: z.string().optional().describe("Visible text to find and click"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
    force: z.boolean().optional().describe("Force OS-level click (for React/Airtable/virtual DOM apps)"),
  },
  async (args) => {
    const result = await safari.click(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_double_click",
  "Double-click an element by CSS selector or x/y coordinates (e.g. to select a word in text)",
  {
    selector: z.string().optional().describe("CSS selector"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
  },
  async (args) => {
    const result = await safari.doubleClick(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_right_click",
  "Right-click (context menu) an element by CSS selector or x/y coordinates",
  {
    selector: z.string().optional().describe("CSS selector"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
  },
  async (args) => {
    const result = await safari.rightClick(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== FORM INPUT ==========

server.tool(
  "safari_fill",
  "Fill input field. Use ref (from snapshot) or CSS selector",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    selector: z.string().optional().describe("CSS selector"),
    value: z.string().describe("Value to fill"),
  },
  async (args) => {
    const result = await safari.fill(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_clear_field",
  "Clear an input field",
  { selector: z.string().describe("CSS selector of the input") },
  async (args) => {
    const result = await safari.clearField(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_select_option",
  "Select an option in a dropdown/select element",
  {
    selector: z.string().describe("CSS selector of the select"),
    value: z.string().describe("Option value to select"),
  },
  async (args) => {
    const result = await safari.selectOption(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_fill_form",
  "Fill multiple form fields at once",
  {
    fields: z.array(z.object({
      selector: z.string().describe("CSS selector"),
      value: z.string().describe("Value to fill"),
    })).describe("Array of {selector, value} pairs"),
  },
  async (args) => {
    const result = await safari.fillForm(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== KEYBOARD ==========

server.tool(
  "safari_press_key",
  "Press a keyboard key (enter, tab, escape, arrows, etc). Supports modifiers (cmd, shift, alt, ctrl).",
  {
    key: z.string().describe("Key name: enter, tab, escape, space, delete, up, down, left, right, or a single character"),
    modifiers: z.array(z.string()).optional().describe("Modifier keys: cmd, shift, alt, ctrl"),
  },
  async (args) => {
    const result = await safari.pressKey(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_type_text",
  "Type text character by character. Use ref or selector to focus first.",
  {
    text: z.string().describe("Text to type"),
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    selector: z.string().optional().describe("CSS selector to focus"),
  },
  async (args) => {
    const result = await safari.typeText(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== SCREENSHOT ==========

server.tool(
  "safari_screenshot",
  "Take a screenshot of the current Safari window. Returns base64 PNG image.",
  {
    fullPage: z.boolean().optional().describe("Capture full page (not just viewport)"),
  },
  async ({ fullPage }) => {
    const base64 = await safari.screenshot({ fullPage });
    return {
      content: [{ type: "image", data: base64, mimeType: "image/png" }],
    };
  }
);

server.tool(
  "safari_screenshot_element",
  "Take a screenshot of a specific element (by CSS selector). Returns base64 PNG image.",
  { selector: z.string().describe("CSS selector of the element to capture") },
  async ({ selector }) => {
    const base64 = await safari.screenshotElement({ selector });
    return {
      content: [{ type: "image", data: base64, mimeType: "image/png" }],
    };
  }
);

// ========== SCROLL ==========

server.tool(
  "safari_scroll",
  "Scroll the page up or down by a specified amount",
  {
    direction: z.enum(["up", "down"]).optional().describe("Scroll direction (default: down)"),
    amount: z.coerce.number().optional().describe("Pixels to scroll (default: 500)"),
  },
  async (args) => {
    const result = await safari.scroll(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_scroll_to",
  "Scroll to a specific position on the page",
  {
    x: z.coerce.number().optional().describe("X position (default: 0)"),
    y: z.coerce.number().optional().describe("Y position (default: 0)"),
  },
  async (args) => {
    const result = await safari.scrollTo(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== TAB MANAGEMENT ==========

server.tool(
  "safari_list_tabs",
  "List all open tabs in Safari with their titles and URLs",
  {},
  async () => {
    const result = await safari.listTabs();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_new_tab",
  "Open a new tab, optionally with a URL",
  { url: z.string().optional().describe("URL to open (empty for blank tab)") },
  async ({ url }) => {
    const result = await safari.newTab(url);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_close_tab",
  "Close the current tab",
  {},
  async () => {
    const result = await safari.closeTab();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_switch_tab",
  "Switch to a specific tab by index (use safari_list_tabs to see indices)",
  { index: z.coerce.number().describe("Tab index (starting from 1)") },
  async ({ index }) => {
    const result = await safari.switchTab(index);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

// ========== WAIT ==========

server.tool(
  "safari_wait_for",
  "Wait for an element or text to appear on the page",
  {
    selector: z.string().optional().describe("CSS selector to wait for"),
    text: z.string().optional().describe("Text to wait for"),
    timeout: z.coerce.number().optional().describe("Timeout in ms (default: 10000)"),
  },
  async (args) => {
    const result = await safari.waitFor(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== EVALUATE JAVASCRIPT ==========

server.tool(
  "safari_evaluate",
  "Execute arbitrary JavaScript in the current page and return the result",
  { script: z.string().describe("JavaScript code to execute") },
  async (args) => {
    const result = await safari.evaluate(args);
    return { content: [{ type: "text", text: result || "(no return value)" }] };
  }
);

// ========== ELEMENT INFO ==========

server.tool(
  "safari_get_element",
  "Get detailed info about an element (tag, text, rect, attributes, visibility)",
  { selector: z.string().describe("CSS selector") },
  async (args) => {
    const result = await safari.getElementInfo(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_query_all",
  "Find all elements matching a CSS selector (returns tag, text, href, value)",
  {
    selector: z.string().describe("CSS selector"),
    limit: z.coerce.number().optional().describe("Max results (default: 20)"),
  },
  async (args) => {
    const result = await safari.querySelectorAll(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== HOVER ==========

server.tool(
  "safari_hover",
  "Hover over element. Use ref, selector, or x/y",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    selector: z.string().optional().describe("CSS selector"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
  },
  async (args) => {
    const result = await safari.hover(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== DIALOG HANDLING ==========

server.tool(
  "safari_handle_dialog",
  "Set up handler for the next alert/confirm/prompt dialog",
  {
    action: z.enum(["accept", "dismiss"]).optional().describe("Accept or dismiss (default: accept)"),
    text: z.string().optional().describe("Text to enter for prompt dialogs"),
  },
  async (args) => {
    const result = await safari.handleDialog(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== WINDOW ==========

server.tool(
  "safari_resize",
  "Resize the Safari window",
  {
    width: z.coerce.number().describe("Window width"),
    height: z.coerce.number().describe("Window height"),
  },
  async (args) => {
    const result = await safari.resizeWindow(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== DRAG ==========

server.tool(
  "safari_drag",
  "Drag an element to another element or position. Use CSS selectors or x/y coordinates.",
  {
    sourceSelector: z.string().optional().describe("CSS selector of element to drag"),
    targetSelector: z.string().optional().describe("CSS selector of drop target"),
    sourceX: z.coerce.number().optional().describe("Source X coordinate"),
    sourceY: z.coerce.number().optional().describe("Source Y coordinate"),
    targetX: z.coerce.number().optional().describe("Target X coordinate"),
    targetY: z.coerce.number().optional().describe("Target Y coordinate"),
  },
  async (args) => {
    const result = await safari.drag(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== UPLOAD FILE ==========

server.tool(
  "safari_upload_file",
  "Upload a file to a <input type='file'> element via JavaScript DataTransfer — NO file dialog, NO UI interaction. IMPORTANT: Do NOT click the file input before calling this tool — just provide the selector and file path. If a file dialog is already open, this tool will close it first.",
  {
    selector: z.string().describe("CSS selector of the file input"),
    filePath: z.string().describe("Absolute path to the file to upload"),
  },
  async (args) => {
    const result = await safari.uploadFile(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== PASTE IMAGE ==========

server.tool(
  "safari_paste_image",
  "Paste an image from a local file into the focused element. Copies to clipboard then Cmd+V. Works on Medium, dev.to, HackerNoon, etc.",
  {
    filePath: z.string().describe("Absolute path to the image file (PNG, JPG, WebP)"),
  },
  async ({ filePath }) => {
    const result = await safari.pasteImageFromFile({ filePath });
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== EMULATE (DEVICE SIMULATION) ==========

server.tool(
  "safari_emulate",
  "Emulate a mobile device by resizing window and setting user agent. Devices: iphone-14, iphone-14-pro-max, ipad, ipad-pro, pixel-7, galaxy-s24. Or use custom width/height.",
  {
    device: z.string().optional().describe("Device name: iphone-14, ipad, pixel-7, galaxy-s24, etc."),
    width: z.coerce.number().optional().describe("Custom viewport width"),
    height: z.coerce.number().optional().describe("Custom viewport height"),
    userAgent: z.string().optional().describe("Custom user agent string"),
    scale: z.coerce.number().optional().describe("Initial scale (default: 1)"),
  },
  async (args) => {
    const result = await safari.emulate(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_reset_emulation",
  "Reset device emulation back to desktop mode",
  {},
  async () => {
    const result = await safari.resetEmulation();
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== COOKIES & STORAGE ==========

server.tool(
  "safari_get_cookies",
  "Get cookies for the current page",
  {},
  async () => {
    const result = await safari.getCookies();
    return { content: [{ type: "text", text: result || "(no cookies)" }] };
  }
);

server.tool(
  "safari_local_storage",
  "Get localStorage data for the current page",
  { key: z.string().optional().describe("Specific key to get (omit for all)") },
  async ({ key }) => {
    const result = await safari.getLocalStorage({ key });
    return { content: [{ type: "text", text: result || "(empty)" }] };
  }
);

// ========== NETWORK ==========

server.tool(
  "safari_network",
  "Get network requests made by the current page (via Performance API)",
  { limit: z.coerce.number().optional().describe("Max requests to return (default: 50)") },
  async ({ limit }) => {
    const result = await safari.getNetworkRequests({ limit });
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== RUN SCRIPT (multi-step) ==========

server.tool(
  "safari_run_script",
  "Batch multiple Safari actions in ONE call. Steps: [{action, args}]. Actions match other safari_* tool names without prefix (e.g. 'navigate', 'click', 'fill', 'evaluate', 'readPage').",
  {
    steps: z.array(z.object({
      action: z.string().describe("Action name (e.g. 'navigate', 'click', 'fill')"),
      args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the action"),
    })).describe("Array of steps to execute sequentially"),
  },
  async ({ steps }) => {
    const result = await safari.runScript({ steps });
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== CONSOLE ==========

server.tool(
  "safari_start_console",
  "Start capturing console messages (log, warn, error, info). Call once per page.",
  {},
  async () => {
    const result = await safari.startConsoleCapture();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_get_console",
  "Get captured console messages (must call safari_start_console first)",
  {},
  async () => {
    const result = await safari.getConsoleMessages();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_clear_console",
  "Clear all captured console messages",
  {},
  async () => {
    const result = await safari.clearConsoleCapture();
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== PDF SAVE ==========

server.tool(
  "safari_save_pdf",
  "Save the current page as a PDF file. Uses Safari's native Export as PDF.",
  { path: z.string().describe("Absolute file path to save the PDF (e.g. /Users/am/Downloads/page.pdf)") },
  async (args) => {
    const result = await safari.savePDF(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== ACCESSIBILITY SNAPSHOT ==========

server.tool(
  "safari_accessibility_snapshot",
  "Get the accessibility tree of the page (roles, ARIA labels, focusable elements, form states). Essential for a11y auditing.",
  {
    selector: z.string().optional().describe("CSS selector for subtree (default: full page)"),
    maxDepth: z.coerce.number().optional().describe("Max tree depth (default: 5)"),
  },
  async (args) => {
    const result = await safari.getAccessibilityTree(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== COOKIE CRUD ==========

server.tool(
  "safari_set_cookie",
  "Set a cookie on the current page",
  {
    name: z.string().describe("Cookie name"),
    value: z.string().describe("Cookie value"),
    domain: z.string().optional().describe("Cookie domain"),
    path: z.string().optional().describe("Cookie path (default: /)"),
    expires: z.string().optional().describe("Expiry date (e.g. 'Thu, 01 Jan 2030 00:00:00 GMT')"),
    secure: z.boolean().optional().describe("Secure flag"),
    sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("SameSite attribute"),
  },
  async (args) => {
    const result = await safari.setCookie(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_delete_cookies",
  "Delete a specific cookie or all cookies for the current page",
  {
    name: z.string().optional().describe("Cookie name to delete"),
    all: z.boolean().optional().describe("Delete all cookies"),
  },
  async (args) => {
    const result = await safari.deleteCookies(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== SESSION STORAGE ==========

server.tool(
  "safari_session_storage",
  "Get sessionStorage data for the current page",
  { key: z.string().optional().describe("Specific key (omit for all)") },
  async ({ key }) => {
    const result = await safari.getSessionStorage({ key });
    return { content: [{ type: "text", text: result || "(empty)" }] };
  }
);

server.tool(
  "safari_set_session_storage",
  "Set a value in sessionStorage",
  {
    key: z.string().describe("Storage key"),
    value: z.string().describe("Value to store"),
  },
  async (args) => {
    const result = await safari.setSessionStorage(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_set_local_storage",
  "Set a value in localStorage",
  {
    key: z.string().describe("Storage key"),
    value: z.string().describe("Value to store"),
  },
  async (args) => {
    const result = await safari.setLocalStorage(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== STORAGE DELETE / CLEAR ==========

server.tool(
  "safari_delete_local_storage",
  "Delete a localStorage key, or clear all localStorage (omit key to clear all)",
  { key: z.string().optional().describe("Key to delete (omit to clear ALL)") },
  async ({ key }) => {
    const result = await safari.deleteLocalStorage({ key });
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_delete_session_storage",
  "Delete a sessionStorage key, or clear all sessionStorage (omit key to clear all)",
  { key: z.string().optional().describe("Key to delete (omit to clear ALL)") },
  async ({ key }) => {
    const result = await safari.deleteSessionStorage({ key });
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== STORAGE STATE EXPORT/IMPORT ==========

server.tool(
  "safari_export_storage",
  "Export all storage state (cookies + localStorage + sessionStorage) as JSON — useful for saving and restoring login sessions",
  {},
  async () => {
    const result = await safari.exportStorageState();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_import_storage",
  "Import storage state from JSON (as exported by safari_export_storage) — restores cookies, localStorage, sessionStorage",
  { state: z.string().describe("JSON string from safari_export_storage") },
  async ({ state }) => {
    const result = await safari.importStorageState({ state });
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== CLIPBOARD ==========

server.tool(
  "safari_clipboard_read",
  "Read the current clipboard content (text)",
  {},
  async () => {
    const result = await safari.clipboardRead();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_clipboard_write",
  "Write text to the system clipboard",
  { text: z.string().describe("Text to copy to clipboard") },
  async (args) => {
    const result = await safari.clipboardWrite(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== NETWORK MOCKING ==========

server.tool(
  "safari_mock_route",
  "Intercept network requests matching a URL pattern and return a mock response. Works with both fetch and XHR. Useful for testing API error states, offline behavior, or replacing API responses.",
  {
    urlPattern: z.string().describe("URL substring or regex pattern to match (e.g. '/api/users' or 'example\\.com')"),
    response: z.object({
      status: z.coerce.number().optional().describe("HTTP status code (default: 200)"),
      body: z.string().optional().describe("Response body string (JSON, HTML, text)"),
      contentType: z.string().optional().describe("Content-Type header (default: application/json)"),
    }).describe("Mock response to return"),
  },
  async ({ urlPattern, response }) => {
    const result = await safari.mockNetworkRoute({ urlPattern, response });
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_clear_mocks",
  "Remove all network route mocks (restore real network behavior)",
  {},
  async () => {
    const result = await safari.clearNetworkMocks();
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== WAIT FOR TIME ==========

server.tool(
  "safari_wait",
  "Wait for a specified number of milliseconds. Use between actions that need time to settle.",
  { ms: z.coerce.number().describe("Milliseconds to wait") },
  async ({ ms }) => {
    const result = await safari.waitForTime({ ms });
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== NETWORK CAPTURE (Detailed) ==========

server.tool(
  "safari_start_network_capture",
  "Start capturing detailed network requests (fetch + XHR) with headers, status, timing. Call once per page.",
  {},
  async () => {
    const result = await safari.startNetworkCapture();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_network_details",
  "Get captured network requests with full details (must call safari_start_network_capture first)",
  {
    limit: z.coerce.number().optional().describe("Max requests (default: 50)"),
    filter: z.string().optional().describe("Filter by URL substring"),
  },
  async (args) => {
    const result = await safari.getNetworkDetails(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_clear_network",
  "Clear all captured network requests",
  {},
  async () => {
    const result = await safari.clearNetworkCapture();
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== PERFORMANCE METRICS ==========

server.tool(
  "safari_performance_metrics",
  "Get detailed performance metrics: navigation timing, Web Vitals (FCP, LCP, CLS), resource breakdown, memory usage",
  {},
  async () => {
    const result = await safari.getPerformanceMetrics();
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== NETWORK THROTTLING ==========

server.tool(
  "safari_throttle_network",
  "Simulate slow network conditions. Profiles: slow-3g, fast-3g, 4g, offline. Or custom latency/speed. Call with no args to reset.",
  {
    profile: z.string().optional().describe("Preset: slow-3g, fast-3g, 4g, offline"),
    latency: z.coerce.number().optional().describe("Custom latency in ms"),
    downloadKbps: z.coerce.number().optional().describe("Custom download speed in Kbps"),
  },
  async (args) => {
    const result = await safari.throttleNetwork(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== CONSOLE FILTER ==========

server.tool(
  "safari_console_filter",
  "Get console messages filtered by level (must call safari_start_console first)",
  { level: z.enum(["log", "warn", "error", "info"]).describe("Console level to filter") },
  async (args) => {
    const result = await safari.getConsoleByLevel(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== DATA EXTRACTION ==========

server.tool(
  "safari_extract_tables",
  "Extract HTML tables as structured JSON (headers + rows). Perfect for scraping data tables.",
  {
    selector: z.string().optional().describe("CSS selector (default: 'table')"),
    limit: z.coerce.number().optional().describe("Max tables (default: 10)"),
  },
  async (args) => {
    const result = await safari.extractTables(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_extract_meta",
  "Extract all meta tags: title, description, canonical, OG tags, Twitter cards, JSON-LD, alternate languages, RSS feeds",
  {},
  async () => {
    const result = await safari.extractMeta();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_extract_images",
  "Extract all images with src, alt, dimensions, loading strategy, viewport visibility",
  { limit: z.coerce.number().optional().describe("Max images (default: 50)") },
  async (args) => {
    const result = await safari.extractImages(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_extract_links",
  "Extract all links with href, text, rel, target, external/nofollow detection",
  {
    limit: z.coerce.number().optional().describe("Max links (default: 100)"),
    filter: z.string().optional().describe("Filter by URL or text substring"),
  },
  async (args) => {
    const result = await safari.extractLinks(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== GEOLOCATION OVERRIDE ==========

server.tool(
  "safari_override_geolocation",
  "Override the browser's geolocation API to return custom coordinates",
  {
    latitude: z.coerce.number().describe("Latitude (-90 to 90)"),
    longitude: z.coerce.number().describe("Longitude (-180 to 180)"),
    accuracy: z.coerce.number().optional().describe("Accuracy in meters (default: 100)"),
  },
  async (args) => {
    const result = await safari.overrideGeolocation(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== COMPUTED STYLES ==========

server.tool(
  "safari_get_computed_style",
  "Get computed CSS styles for an element. Optionally filter specific properties.",
  {
    selector: z.string().describe("CSS selector"),
    properties: z.array(z.string()).optional().describe("Specific CSS properties to get (e.g. ['color', 'font-size'])"),
  },
  async (args) => {
    const result = await safari.getComputedStyles(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== INDEXEDDB ==========

server.tool(
  "safari_list_indexed_dbs",
  "List all IndexedDB databases on the current page",
  {},
  async () => {
    const result = await safari.listIndexedDBs();
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_get_indexed_db",
  "Read records from an IndexedDB database store",
  {
    dbName: z.string().describe("Database name"),
    storeName: z.string().describe("Object store name"),
    limit: z.coerce.number().optional().describe("Max records (default: 20)"),
  },
  async (args) => {
    const result = await safari.getIndexedDB(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== CSS COVERAGE ==========

server.tool(
  "safari_css_coverage",
  "Analyze CSS coverage: find unused CSS rules across all stylesheets. Shows coverage percentage per stylesheet.",
  {},
  async () => {
    const result = await safari.getCSSCoverage();
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== FORM AUTO-DETECT ==========

server.tool(
  "safari_detect_forms",
  "Auto-detect all forms on the page with their fields, types, selectors, and submit buttons. Great for automated form filling.",
  {},
  async () => {
    const result = await safari.detectForms();
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== SCROLL TO ELEMENT ==========

server.tool(
  "safari_scroll_to_element",
  "Scroll smoothly to a specific element by CSS selector",
  {
    selector: z.string().describe("CSS selector of target element"),
    block: z.enum(["start", "center", "end", "nearest"]).optional().describe("Scroll alignment (default: center)"),
  },
  async (args) => {
    const result = await safari.scrollToElement(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== COMBO TOOLS (fast multi-step operations) ==========

server.tool(
  "safari_navigate_and_read",
  "Navigate to URL AND read the page content in one fast operation. Returns title, URL, and text. Use this instead of navigate + read_page separately.",
  { url: z.string().describe("URL to navigate to") },
  async ({ url }) => {
    const result = await safari.navigateAndRead(url);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_click_and_wait",
  "Click an element AND wait for the result (page load or element). Use instead of click + wait_for separately.",
  {
    selector: z.string().optional().describe("CSS selector to click"),
    text: z.string().optional().describe("Visible text to click"),
    waitFor: z.string().optional().describe("CSS selector to wait for after click"),
    timeout: z.coerce.number().optional().describe("Wait timeout in ms (default: 10000)"),
  },
  async (args) => {
    const result = await safari.clickAndWait(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_fill_and_submit",
  "Fill a form AND submit it in one operation. Finds submit button automatically if not specified.",
  {
    fields: z.array(z.object({
      selector: z.string().describe("CSS selector"),
      value: z.string().describe("Value to fill"),
    })).describe("Fields to fill"),
    submitSelector: z.string().optional().describe("Submit button selector (auto-detected if omitted)"),
  },
  async (args) => {
    const result = await safari.fillAndSubmit(args);
    return { content: [{ type: "text", text: result }] };
  }
);

server.tool(
  "safari_analyze_page",
  "Full page analysis in ONE call: title, URL, meta tags, OG, headings, link stats, image stats, forms, and text preview. Perfect for SEO/audit.",
  {},
  async () => {
    const result = await safari.analyzePage();
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== START SERVER ==========

const transport = new StdioServerTransport();
await server.connect(transport);
