// Opt-in transport selection. Default (no env) = stdio, byte-for-byte the historical behaviour so
// npm users and single-session use are unaffected. SAFARI_MCP_HTTP=1 switches to a shared HTTP
// instance so many Claude Code sessions reuse ONE safari-mcp process. See docs/http-transport-design.md.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const DEFAULT_HTTP_PORT = 9225; // distinct from the 9224 Safari-extension port

// Pure decision: env -> transport plan. No side effects, so it's trivially testable and the
// stdio/HTTP branch is provable in isolation before any socket is opened.
export function planTransport(env = {}) {
  const flag = env.SAFARI_MCP_HTTP;
  if (flag && flag !== "0") {
    return {
      kind: "http",
      host: "127.0.0.1", // localhost-only bind — no auth needed, never exposed off-box
      port: parseInt(env.SAFARI_MCP_HTTP_PORT || String(DEFAULT_HTTP_PORT), 10),
    };
  }
  return { kind: "stdio" };
}

// Connects an McpServer over the chosen transport and returns a handle with close().
// `createServer` is a FACTORY (() => McpServer) — McpServer is single-connection, so the HTTP
// path builds a fresh server per session. That's protocol plumbing only: safari's tab/ownership
// state lives at module scope and is shared across sessions (correct — one physical Safari window),
// so per-session servers still drive the same Safari. stdio calls the factory exactly once, so its
// path is behaviourally identical to the historical inline `new McpServer(); connect(stdio)`.
export async function startTransport(createMcpServer, env = process.env) {
  const plan = planTransport(env);

  if (plan.kind === "stdio") {
    const server = createMcpServer();
    await server.connect(new StdioServerTransport());
    return { kind: "stdio", async close() {} };
  }

  // One StreamableHTTP transport per MCP session (keyed by Mcp-Session-Id), all sharing the single
  // McpServer — this is the SDK's supported multi-client pattern. safari's tab/ownership state stays
  // module-global (correct: one physical Safari window), so sessions share Safari but each gets its
  // own protocol channel for request/response routing.
  const transports = new Map();

  const httpServer = createServer(async (req, res) => {
    try {
      let body;
      if (req.method === "POST") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      }

      const sid = req.headers["mcp-session-id"];
      let transport = sid ? transports.get(sid) : undefined;

      if (!transport && isInitialize(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        const server = createMcpServer(); // fresh server per session (McpServer is single-connection)
        await server.connect(transport);
      }

      if (!transport) {
        if (sid) {
          // The client presented a session id we don't have — it expired, was evicted, or the
          // daemon restarted under it. Per the MCP StreamableHTTP spec this MUST be 404 (NOT 400):
          // a 404 tells the client the session is gone so it transparently re-initializes a fresh
          // one. The old 400 wedged the client permanently on "No valid session" — every shared
          // Claude Code session died the moment its session dropped, with no self-healing.
          res.statusCode = 404;
          res.end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null })
          );
          return;
        }
        // No session id and not an initialize: a genuinely malformed first request.
        res.statusCode = 400;
        res.end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null })
        );
        return;
      }

      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(plan.port, plan.host, resolve);
  });

  return {
    kind: "http",
    port: plan.port,
    async close() {
      for (const t of transports.values()) await t.close().catch(() => {});
      await new Promise((r) => httpServer.close(r));
    },
  };
}

// An MCP initialize request may arrive as a single object or (rarely) batched in an array.
function isInitialize(body) {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && m.method === "initialize");
}
