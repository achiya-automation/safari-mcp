// Per-MCP-session context (AsyncLocalStorage).
//
// WHY: In HTTP-daemon mode (SAFARI_MCP_HTTP=1) ONE node process serves MANY Claude
// Code sessions — each is a separate MCP session multiplexed over the same daemon.
// safari.js kept its active-tab state in module-global `let`s, so two concurrent
// sessions overwrote each other's tab pointer and operations drifted onto the wrong
// (often the user's) tab. transport.js now runs every HTTP request inside
// sessionCtx.run({ sessionId }), and safari.js keys its tab-state off
// currentSessionId(). In stdio mode there is no run() wrapper, so currentSessionId()
// returns "_default" — a single session, behaviourally identical to before.
import { AsyncLocalStorage } from "node:async_hooks";

export const sessionCtx = new AsyncLocalStorage();

export function currentSessionId() {
  return sessionCtx.getStore()?.sessionId ?? "_default";
}
