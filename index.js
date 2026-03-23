#!/usr/bin/env node
// Safari MCP Server — dual engine:
// 1. Safari Web Extension (fast, ~5-20ms, keeps logins) — when extension is connected
// 2. AppleScript + Swift daemon (~5ms, keeps logins) — always available
//
// Extension transport: WebSocket (Chrome) OR HTTP polling (Safari — WebSocket blocked by Apple)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as safari from "./safari.js";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ========== EXTENSION BRIDGE (WebSocket + HTTP polling) ==========
const WS_PORT = 9223;
const HTTP_PORT = 9224;
let _extensionWs = null;
let _extensionConnected = false;

// Pending requests: command sent to extension, waiting for result
const _pendingRequests = new Map();

// Command queue: commands waiting to be picked up by HTTP-polling extension
const _commandQueue = [];

// ========== WEBSOCKET SERVER (for Chrome extensions / direct WebSocket) ==========
let wss;
try {
  wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });
  wss.on("connection", (ws) => {
    _extensionWs = ws;
    _extensionConnected = true;
    console.error(`[Safari MCP] Extension connected via WebSocket`);
    _setupExtensionListener(ws);
    ws.on("close", () => {
      _extensionConnected = false;
      _extensionWs = null;
      _drainOnDisconnect("WebSocket close");
      console.error("[Safari MCP] Extension disconnected (WebSocket)");
    });
  });
  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[Safari MCP] WebSocket port ${WS_PORT} in use — WebSocket disabled`);
    }
  });
} catch {}

function _setupExtensionListener(ws) {
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    _handleExtensionResponse(msg);
  });
}

// ========== HTTP POLLING SERVER (for Safari extensions — WebSocket blocked) ==========
try {
  const httpServer = createServer((req, res) => {
    // CORS headers for extension
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /poll — extension asks for next command (long-poll, up to 5s)
    if (req.method === "GET" && req.url === "/poll") {
      _extensionLastPollTime = Date.now(); // Keep connection alive — critical for stale detection
      if (!_extensionConnected) {
        _extensionConnected = true;
        console.error("[Safari MCP] Extension reconnected via poll");
      }
      if (_commandQueue.length > 0) {
        const cmd = _commandQueue.shift();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(cmd));
      } else {
        // Long-poll: wait up to 5 seconds for a command
        const timer = setTimeout(() => {
          res.writeHead(204);
          res.end();
        }, 5000);

        const checkInterval = setInterval(() => {
          if (_commandQueue.length > 0) {
            clearTimeout(timer);
            clearInterval(checkInterval);
            const cmd = _commandQueue.shift();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(cmd));
          }
        }, 5); // Check every 5ms (reduced from 20ms — cuts avg command delivery delay from 10ms to 2.5ms)

        // Cleanup on client disconnect
        req.on("close", () => {
          clearTimeout(timer);
          clearInterval(checkInterval);
        });
      }
      return;
    }

    // POST /result — extension sends command result
    if (req.method === "POST" && req.url === "/result") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const msg = JSON.parse(body);
          _handleExtensionResponse(msg);
        } catch {}
        res.writeHead(200);
        res.end("ok");
      });
      return;
    }

    // POST /connect — extension announces it's alive
    if (req.method === "POST" && req.url === "/connect") {
      if (!_extensionConnected) {
        _extensionConnected = true;
        console.error("[Safari MCP] Extension connected via HTTP polling");
      }
      _extensionLastPollTime = Date.now();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "connected", profile: process.env.SAFARI_PROFILE || null }));
      return;
    }

    // GET /proxy-check — secondary instances check if extension is connected
    if (req.method === "GET" && req.url === "/proxy-check") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ extensionConnected: _extensionConnected }));
      return;
    }

    // POST /proxy-command — secondary instances send commands through primary
    if (req.method === "POST" && req.url === "/proxy-command") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const { type, payload } = JSON.parse(body);
          const timeout = _commandTimeouts[type] || 30000;
          const result = await sendToExtension(type, payload, timeout);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result }));
        } catch (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(HTTP_PORT, "127.0.0.1", () => {
    _isExtensionHost = true;
    console.error(`[Safari MCP] HTTP server listening on port ${HTTP_PORT} (extension host)`);
  });
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[Safari MCP] HTTP port ${HTTP_PORT} in use — will proxy commands to primary instance`);
      _isExtensionHost = false;
      // Check if primary instance has extension connected
      _checkPrimaryExtension();
    }
  });
} catch {}

// ========== PROXY MODE ==========
// When another MCP instance already owns the port, we proxy commands through it
let _isExtensionHost = false;
let _primaryHasExtension = false;

// Delayed check: if after 2 seconds we're not the host, try proxy mode
setTimeout(() => {
  if (!_isExtensionHost && !_primaryHasExtension) {
    console.error("[Safari MCP] Not extension host after startup — checking for primary instance");
    _checkPrimaryExtension();
  }
}, 2000);

async function _checkPrimaryExtension() {
  try {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/proxy-check`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      _primaryHasExtension = data.extensionConnected;
      if (_primaryHasExtension) {
        _extensionConnected = true; // Enable extension path in extensionOrFallback
        console.error(`[Safari MCP] Primary instance has extension — proxy mode enabled`);
      }
    }
  } catch {
    _primaryHasExtension = false;
  }
  // Re-check every 10s
  setTimeout(_checkPrimaryExtension, 10000);
}

// Send command to primary instance's extension via proxy
async function _proxyToExtension(type, payload, timeoutMs = 30000) {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/proxy-command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Proxy error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

let _extensionLastPollTime = 0;
// Detect stale HTTP connection (no poll in 10s = disconnected)
// Only applies to primary instance (extension host) — not proxy mode
setInterval(() => {
  if (_isExtensionHost && _extensionConnected && !_extensionWs && _extensionLastPollTime > 0) {
    if (Date.now() - _extensionLastPollTime > 10000) {
      _extensionConnected = false;
      _drainOnDisconnect("HTTP poll timeout");
      console.error("[Safari MCP] Extension disconnected (HTTP poll timeout)");
    }
  }
}, 5000);

// ========== SHARED EXTENSION LOGIC ==========

// Drain pending requests and command queue on disconnect — allows fast fallback to AppleScript
function _drainOnDisconnect(reason) {
  // Reject all in-flight requests immediately (instead of waiting for timeout)
  for (const [id, pending] of _pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`Extension disconnected: ${reason}`));
  }
  _pendingRequests.clear();
  // Clear queued commands that will never be picked up
  _commandQueue.length = 0;
}

function _handleExtensionResponse(msg) {
  if (msg.type === "keepalive") return;
  if (msg.type === "connected") {
    if (!_extensionConnected) {
      _extensionConnected = true;
      console.error("[Safari MCP] Extension connected");
    }
    return;
  }
  if (msg.type !== "response" || !msg.id) return;
  const pending = _pendingRequests.get(msg.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  _pendingRequests.delete(msg.id);
  if (msg.error) pending.reject(new Error(msg.error));
  else pending.resolve(msg.result);
}

// Send command to extension (via WebSocket, HTTP command queue, or proxy to primary)
function sendToExtension(type, payload = {}, timeoutMs = 30000) {
  // If we're a secondary instance, proxy through primary
  if (!_isExtensionHost && _primaryHasExtension) {
    return _proxyToExtension(type, payload, timeoutMs);
  }

  return new Promise((resolve, reject) => {
    if (!_extensionConnected) {
      reject(new Error("Extension not connected"));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      _pendingRequests.delete(id);
      reject(new Error(`Extension timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    _pendingRequests.set(id, { resolve, reject, timer });

    const command = { id, type, payload };

    // If WebSocket is connected, use it (faster)
    if (_extensionWs) {
      _extensionWs.send(JSON.stringify(command));
    } else {
      // Otherwise, queue for HTTP polling
      _commandQueue.push(command);
    }
  });
}

// Per-command timeouts — fast commands get short timeouts, nav/screenshot get longer ones
const _commandTimeouts = {
  click: 10000, fill: 5000, read_page: 10000, get_source: 10000, evaluate: 15000,
  type_text: 5000, press_key: 5000, scroll: 3000, scroll_to: 3000, scroll_to_element: 3000,
  hover: 5000, list_tabs: 5000, new_tab: 15000, close_tab: 5000, switch_tab: 5000,
  wait_for: 30000, navigate: 30000, navigate_and_read: 30000, go_back: 10000, go_forward: 10000,
  reload: 15000, screenshot: 15000, snapshot: 15000, click_and_read: 15000,
  double_click: 10000, right_click: 10000, clear_field: 5000, select_option: 5000, fill_form: 10000,
  get_url: 3000, get_title: 3000,
};

// Commands where null result means failure (should fall back to AppleScript)
const _nullMeansFailure = new Set([
  "click", "double_click", "right_click", "fill",
  "press_key", "hover", "clear_field", "select_option", "fill_form",
  // NOTE: "type_text" intentionally NOT here — execCommand always returns a string,
  // and double execution would duplicate text in contenteditable editors.
  "read_page", "get_source", "snapshot", "get_element", "query_all",
  "scroll", "scroll_to",
  // NOTE: "evaluate" intentionally NOT here — null is a valid return value.
  // CSP fallback is handled separately via isCspError check.
]);

// Try extension first, fall back to AppleScript
async function extensionOrFallback(extensionType, extensionPayload, fallbackFn) {
  if (_extensionConnected) {
    try {
      const t0 = Date.now();
      const tabUrl = safari.getActiveTabURL();
      const payload = tabUrl ? { ...extensionPayload, tabUrl } : extensionPayload;
      const timeout = _commandTimeouts[extensionType] || 30000;
      const result = await sendToExtension(extensionType, payload, timeout);
      // If extension returned null or "Element not found" for action commands,
      // fall back to AppleScript (which has better element discovery with helpers)
      const isCspError = typeof result === 'string' && (result.includes('unsafe-eval') || result.includes('trusted-types') || result.includes('Content Security Policy'));
      const isFailed = result === null || (typeof result === 'string' && result.startsWith('Element not found'));
      // CSP errors ALWAYS fall back to AppleScript (regardless of _nullMeansFailure)
      if (isCspError) {
        console.error(`[Safari MCP] ${extensionType} CSP blocked: ${result?.substring(0, 100)} (${Date.now() - t0}ms) — falling back to AppleScript`);
      } else if (isFailed && _nullMeansFailure.has(extensionType)) {
        console.error(`[Safari MCP] ${extensionType} extension failed: ${result} (${Date.now() - t0}ms) — falling back to AppleScript`);
      } else {
        console.error(`[Safari MCP] ${extensionType} via extension (${Date.now() - t0}ms)`);
        return result;
      }
    } catch (err) {
      console.error(`[Safari MCP] ${extensionType} extension failed: ${err.message} — falling back to AppleScript`);
    }
  }
  const t0 = Date.now();
  const result = await fallbackFn();
  console.error(`[Safari MCP] ${extensionType} via AppleScript (${Date.now() - t0}ms)`);
  return result;
}

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
    const result = await extensionOrFallback(
      "navigate", { url },
      () => safari.navigate(url)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_go_back",
  "Go back in browser history",
  {},
  async () => {
    const result = await extensionOrFallback("go_back", {}, () => safari.goBack());
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_go_forward",
  "Go forward in browser history",
  {},
  async () => {
    const result = await extensionOrFallback("go_forward", {}, () => safari.goForward());
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_reload",
  "Reload the current page",
  { hard: z.boolean().optional().describe("Hard reload (bypass cache)") },
  async ({ hard }) => {
    const result = await extensionOrFallback("reload", { hard }, () => safari.reload(hard));
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

// ========== PAGE INFO ==========

server.tool(
  "safari_read_page",
  "Read page text content (title, URL, body text). Use for reading article text or page content. For interacting with elements, prefer safari_snapshot (gives ref IDs). Use selector to read specific element. Use maxLength to limit output.",
  {
    selector: z.string().optional().describe("CSS selector to read specific element"),
    maxLength: z.coerce.number().optional().describe("Max chars to return (default: 50000)"),
  },
  async ({ selector, maxLength }) => {
    const result = await extensionOrFallback(
      "read_page", { selector, maxLength },
      () => safari.readPage({ selector, maxLength })
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_get_source",
  "Get HTML source of current page",
  { maxLength: z.coerce.number().optional().describe("Max chars (default: 200000)") },
  async ({ maxLength }) => {
    const result = await extensionOrFallback(
      "get_source", { maxLength },
      () => safari.getPageSource({ maxLength })
    );
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== SNAPSHOT (ref-based interaction like Chrome DevTools MCP) ==========

server.tool(
  "safari_snapshot",
  "PREFERRED way to see page state. Returns accessibility tree with ref IDs for every interactive element. Use refs with click/fill/type instead of CSS selectors. Workflow: snapshot → see refs → click({ref:'0_5'}). PREFER THIS over safari_screenshot (cheaper, structured text vs heavy image) and over safari_read_page (includes interactive refs). Use safari_screenshot only when you need to see visual layout/styling.",
  { selector: z.string().optional().describe("CSS selector for subtree (default: full page)") },
  async (args) => {
    const result = await extensionOrFallback(
      "snapshot", { selector: args.selector },
      () => safari.takeSnapshot(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_navigate_and_read",
  "Navigate to a URL and return the page content in one step — saves 1 full round-trip vs navigate+read_page. Use instead of safari_navigate + safari_read_page.",
  {
    url: z.string().describe("URL to navigate to"),
    maxLength: z.coerce.number().optional().describe("Max chars to return (default: 50000)"),
    timeout: z.coerce.number().optional().describe("Load timeout in ms (default: 30000)"),
  },
  async ({ url, maxLength, timeout }) => {
    const result = await extensionOrFallback(
      "navigate_and_read", { url, maxLength, timeout },
      async () => {
        await safari.navigate(url);
        return safari.readPage({ maxLength });
      }
    );
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
  }
);

// ========== CLICK ==========

server.tool(
  "safari_click",
  "Click element. Use ref (from snapshot), selector, text, or x/y. Works on React/Airtable/virtual DOM apps via full PointerEvent+MouseEvent sequence + React Fiber fallback. Pure JS — never touches user's mouse. When using ref, always take a FRESH safari_snapshot first — refs expire after each new snapshot.",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot (e.g. '0_5')"),
    selector: z.string().optional().describe("CSS selector"),
    text: z.string().optional().describe("Visible text to find and click"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "click", { ref: args.ref, selector: args.selector, text: args.text, x: args.x, y: args.y },
      () => safari.click(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_click_and_read",
  "Click an element then return the updated page — saves 1 full round-trip vs separate click+read_page. Handles both React Router navigation and full page loads.",
  {
    text: z.string().optional().describe("Visible text of the element to click"),
    selector: z.string().optional().describe("CSS selector"),
    x: z.coerce.number().optional().describe("X coordinate"),
    y: z.coerce.number().optional().describe("Y coordinate"),
    wait: z.coerce.number().optional().describe("Ms to wait after click (default: auto-detect navigation)"),
    maxLength: z.coerce.number().optional().describe("Max chars to return (default: 50000)"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "click_and_read",
      { selector: args.selector, text: args.text, x: args.x, y: args.y, wait: args.wait, maxLength: args.maxLength },
      async () => {
        await safari.click(args);
        if (args.wait) {
          await new Promise(r => setTimeout(r, args.wait));
        } else {
          // Smart wait: brief pause then check if page is loading
          await new Promise(r => setTimeout(r, 50));
          const state = await safari.runJSQuick("document.readyState");
          if (state === "loading") {
            // Page is navigating — wait for it to complete
            await safari.runJSQuick("(async function(){for(var i=0;i<50;i++){if(document.readyState==='complete')return 'done';await new Promise(r=>setTimeout(r,200));}return 'timeout';})()");
          } else {
            await new Promise(r => setTimeout(r, 100)); // SPA settle time
          }
        }
        return safari.readPage({ maxLength: args.maxLength });
      }
    );
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
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
    const result = await extensionOrFallback(
      "double_click", { selector: args.selector, x: args.x, y: args.y },
      () => safari.doubleClick(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
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
    const result = await extensionOrFallback(
      "right_click", { selector: args.selector, x: args.x, y: args.y },
      () => safari.rightClick(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

// ========== FORM INPUT ==========

server.tool(
  "safari_fill",
  "Fill/replace value in an input, textarea, select, OR contenteditable (rich text). Handles React controlled inputs, ProseMirror, Draft.js, and Google Closure editors automatically. Use for SETTING a value (replaces existing). For code editors (Monaco/CodeMirror/Ace), use safari_replace_editor instead. For character-by-character typing in search boxes, use safari_type_text. IMPORTANT: When using ref, always take a FRESH safari_snapshot first — refs expire after each new snapshot (prefix changes: 5_xx → 6_xx).",
  {
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    selector: z.string().optional().describe("CSS selector"),
    value: z.string().describe("Value to fill"),
  },
  async (args) => {
    const selector = args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector;
    const result = await extensionOrFallback(
      "fill", { selector, value: args.value },
      () => safari.fill(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_clear_field",
  "Clear an input field",
  { selector: z.string().describe("CSS selector of the input") },
  async (args) => {
    const result = await extensionOrFallback(
      "clear_field", { selector: args.selector },
      () => safari.clearField(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_select_option",
  "Select an option in a native <select> dropdown. Sets .value and dispatches change event. For custom dropdowns (React/LinkedIn), use safari_click on the dropdown trigger, then safari_click on the option instead.",
  {
    selector: z.string().describe("CSS selector of the select"),
    value: z.string().describe("Option value to select"),
  },
  async (args) => {
    let result = await extensionOrFallback(
      "select_option", { selector: args.selector, value: args.value },
      () => safari.selectOption(args)
    );
    // If extension returned "Selected: " with empty/default value, fuzzy match may have failed.
    // Retry via AppleScript path which has the latest fuzzy match code.
    if (typeof result === 'string' && result.match(/^Selected:\s*$/) ) {
      console.error('[Safari MCP] select_option returned empty value — retrying via AppleScript');
      result = await safari.selectOption(args);
    }
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
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
    const result = await extensionOrFallback(
      "fill_form", { fields: args.fields },
      () => safari.fillForm(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
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
    const result = await extensionOrFallback(
      "press_key", { key: args.key, modifiers: args.modifiers },
      () => safari.pressKey(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_type_text",
  "Type text character-by-character with realistic key events. Best for: search boxes (triggers autocomplete), chat inputs, and fields that react to each keystroke. For rich text editors (Medium, HackerNoon, LinkedIn), use safari_fill instead — it uses framework-native APIs. For code editors (Monaco/CodeMirror), use safari_replace_editor. When using ref, always take a FRESH safari_snapshot first — refs expire after each new snapshot.",
  {
    text: z.string().describe("Text to type"),
    ref: z.string().optional().describe("Ref ID from safari_snapshot"),
    selector: z.string().optional().describe("CSS selector to focus"),
  },
  async (args) => {
    const result = await extensionOrFallback(
      "type_text", { text: args.text, selector: args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector },
      () => safari.typeText(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

// ========== CODE EDITOR ==========

server.tool(
  "safari_replace_editor",
  "Replace ALL content in a code editor (Monaco, CodeMirror, Ace, ProseMirror). Use ONLY for code editors — Airtable automations, GitHub gists, CodePen, n8n code nodes, etc. NOT for rich text editors like Medium/LinkedIn (use safari_fill for those). Detects ProseMirror/Draft.js/CodeMirror/Monaco/Ace and uses their native API.",
  {
    text: z.string().describe("The complete code/text to put in the editor"),
  },
  async ({ text }) => {
    const result = await extensionOrFallback(
      "replace_editor", { text },
      () => safari.replaceEditorContent({ text })
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

// ========== SCREENSHOT ==========

server.tool(
  "safari_screenshot",
  "Take a visual screenshot (base64 JPEG). EXPENSIVE — use safari_snapshot instead for most tasks. Only use screenshot when you need to verify visual layout, styling, images, or colors that snapshot can't show.",
  {
    fullPage: z.boolean().optional().describe("Capture full page (not just viewport)"),
  },
  async ({ fullPage }) => {
    let base64;
    try {
      base64 = await extensionOrFallback(
        "screenshot", { fullPage },
        () => safari.screenshot({ fullPage })
      );
    } catch (err) {
      // If AppleScript screenshot failed (permission lost), retry via extension only
      if (_extensionConnected && err.message && (err.message.includes("permission") || err.message.includes("screencapture") || err.message.includes("empty"))) {
        console.error("[Safari MCP] Screenshot AppleScript failed, retrying via extension only");
        base64 = await sendToExtension("screenshot", { fullPage }, 15000);
      } else {
        throw err;
      }
    }
    return {
      content: [{ type: "image", data: base64, mimeType: "image/jpeg" }],
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
      content: [{ type: "image", data: base64, mimeType: "image/jpeg" }],
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
    const result = await extensionOrFallback(
      "scroll", { direction: args.direction, amount: args.amount },
      () => safari.scroll(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
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
    const result = await extensionOrFallback(
      "scroll_to", { x: args.x, y: args.y },
      () => safari.scrollTo(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

// ========== TAB MANAGEMENT ==========

server.tool(
  "safari_list_tabs",
  "List all open tabs in Safari with their titles and URLs",
  {},
  async () => {
    const result = await extensionOrFallback(
      "list_tabs", {},
      () => safari.listTabs()
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "safari_new_tab",
  "Open a new tab, optionally with a URL",
  { url: z.string().optional().describe("URL to open (empty for blank tab)") },
  async ({ url }) => {
    const result = await extensionOrFallback(
      "new_tab", { url },
      () => safari.newTab(url)
    );
    // Sync safari.js tracking when extension handled new_tab
    if (result?.tabIndex) {
      safari.setActiveTabIndex(result.tabIndex);
    }
    if (result?.url) {
      safari.setActiveTabURL(result.url);
    }
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_close_tab",
  "Close the current tab",
  {},
  async () => {
    const result = await extensionOrFallback("close_tab", {}, () => safari.closeTab());
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_switch_tab",
  "Switch to a specific tab by index (use safari_list_tabs to see indices). All subsequent commands (click, fill, evaluate, screenshot, scroll) will target this tab. If commands seem to run on the wrong tab, call switch_tab again to re-anchor.",
  { index: z.coerce.number().describe("Tab index (starting from 1)") },
  async ({ index }) => {
    const result = await extensionOrFallback(
      "switch_tab", { index },
      () => safari.switchTab(index)
    );
    // Sync safari.js state so AppleScript fallback targets the correct tab
    safari.setActiveTabIndex(index);
    if (result && typeof result === 'object' && result.url) {
      safari.setActiveTabURL(result.url);
    }
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
    const result = await extensionOrFallback(
      "wait_for", { selector: args.selector, text: args.text, timeout: args.timeout },
      () => safari.waitFor(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  }
);

server.tool(
  "safari_wait_for_new_tab",
  "Wait for a new tab to appear (e.g. after OAuth login click opens popup). Automatically switches to the new tab.",
  {
    timeout: z.coerce.number().optional().describe("Timeout in ms (default: 10000)"),
    urlContains: z.string().optional().describe("Only match new tabs whose URL contains this string"),
  },
  async ({ timeout, urlContains }) => {
    const timeoutMs = timeout || 10000;
    // Get current tab list
    const beforeRaw = await extensionOrFallback("list_tabs", {}, () => safari.listTabs());
    const beforeTabs = typeof beforeRaw === 'string' ? JSON.parse(beforeRaw) : beforeRaw;
    const beforeUrls = new Set(beforeTabs.map(t => t.url));

    // Poll for new tab
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const nowRaw = await extensionOrFallback("list_tabs", {}, () => safari.listTabs());
      const nowTabs = typeof nowRaw === 'string' ? JSON.parse(nowRaw) : nowRaw;
      for (const tab of nowTabs) {
        if (!beforeUrls.has(tab.url) && tab.url !== 'about:blank') {
          if (urlContains && !tab.url.includes(urlContains)) continue;
          // Switch to new tab
          await extensionOrFallback("switch_tab", { index: tab.index }, () => safari.switchTab(tab.index));
          return { content: [{ type: "text", text: `Found new tab: ${tab.title} (${tab.url})` }] };
        }
      }
    }
    return { content: [{ type: "text", text: "TIMEOUT: no new tab appeared" }] };
  }
);

// ========== EVALUATE JAVASCRIPT ==========

server.tool(
  "safari_evaluate",
  "Execute JavaScript in the current page. Automatically falls back to AppleScript when CSP blocks execution (e.g. Google Search Console, LinkedIn). For reading data, prefer safari_read_page or safari_snapshot. For interactions, prefer safari_click/fill with refs.",
  { script: z.string().describe("JavaScript code to execute") },
  async (args) => {
    const result = await extensionOrFallback(
      "evaluate", { script: args.script },
      () => safari.evaluate(args)
    );
    return { content: [{ type: "text", text: (typeof result === 'string' ? result : JSON.stringify(result)) || "(no return value)" }] };
  }
);

// ========== ELEMENT INFO ==========

server.tool(
  "safari_get_element",
  "Get detailed info about an element (tag, text, rect, attributes, visibility)",
  { selector: z.string().describe("CSS selector") },
  async (args) => {
    const result = await extensionOrFallback(
      "get_element", { selector: args.selector },
      () => safari.getElementInfo(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
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
    const result = await extensionOrFallback(
      "query_all", { selector: args.selector, limit: args.limit },
      () => safari.querySelectorAll(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
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
    const sel = args.ref ? `[data-mcp-ref="${args.ref}"]` : args.selector;
    const result = await extensionOrFallback(
      "hover", { selector: sel },
      () => safari.hover(args)
    );
    return { content: [{ type: "text", text: typeof result === 'string' ? result : JSON.stringify(result) }] };
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
  "Upload a file to a <input type='file'> element via JavaScript DataTransfer — NO file dialog, NO UI interaction. IMPORTANT: Do NOT click the file input before calling this tool — just provide the selector and file path. If a file dialog is already open, this tool will close it first. NOTE: 'verified 0 files' may appear even on success if the site uses a custom upload handler — check visually with safari_snapshot.",
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
  "Paste an image from a local file into the focused element. Copies to clipboard then Cmd+V. Works on Medium, dev.to, HackerNoon, TOI, etc. WARNING: This STEALS FOCUS — Safari comes to foreground briefly. Also briefly overwrites system clipboard (auto-restored).",
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
  "Quick network overview via Performance API (no setup needed). Shows URLs and timing for resources loaded by the page. For detailed request/response info (headers, status codes, POST bodies), use safari_start_network_capture + safari_network_details instead.",
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
  "Save the current page as a PDF file. Uses Safari's native Export as PDF. WARNING: This STEALS FOCUS — Safari comes to foreground briefly for the Export menu.",
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
  "Wait for a fixed time in milliseconds. Use only when you need a brief pause between actions. PREFER safari_wait_for (waits for element/text to appear) — it's smarter and doesn't waste time.",
  { ms: z.coerce.number().describe("Milliseconds to wait") },
  async ({ ms }) => {
    const result = await safari.waitForTime({ ms });
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== NETWORK CAPTURE (Detailed) ==========

server.tool(
  "safari_start_network_capture",
  "Start capturing detailed network requests (fetch + XHR) with headers, status, timing. Call once per page. Intercepts fetch/XHR — captures requests AFTER this call only. For quick overview of already-loaded resources, use safari_network instead.",
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
  "Scroll to element by CSS selector OR text. For virtual DOM (Airtable) use text — scrolls down until text appears in DOM.",
  {
    selector: z.string().optional().describe("CSS selector of target element"),
    text: z.string().optional().describe("Text to find — scrolls down until it appears (for virtual DOM/lazy loading)"),
    block: z.enum(["start", "center", "end", "nearest"]).optional().describe("Scroll alignment (default: center)"),
    timeout: z.coerce.number().optional().describe("Max time to scroll in ms (default: 10000)"),
  },
  async (args) => {
    const result = await safari.scrollToElement(args);
    return { content: [{ type: "text", text: result }] };
  }
);

// ========== COMBO TOOLS (fast multi-step operations) ==========

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
