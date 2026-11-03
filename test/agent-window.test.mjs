import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const AGENT = { agentWindow: true }; // what safari_new_tab sends when SAFARI_MCP_AGENT_WINDOW=1
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

// _agentWindow + _newTabForSession, run against a fake browser with one user window (id 1).
function harness() {
  const windows = new Map([[1, { id: 1, focused: true }]]);
  // Tabs by window, in order. The user's window shows one of their pages first.
  const tabsByWindow = new Map([[1, [{ id: 100, url: "https://mail.example.com/" }]]]);
  const created = [];
  const stored = {};
  let nextWindow = 50;
  let nextTab = 500;
  const browser = {
    windows: {
      get: async (id) => {
        if (!windows.has(id)) throw new Error("no window " + id);
        return windows.get(id);
      },
      getAll: async () => [...windows.values()],
      remove: async (id) => { windows.delete(id); },
      create: async (options) => {
        // Safari puts the user's pinned tabs first in every new window.
        // Safari does not report them as pinned.
        const pinned = [{ id: 900, url: "https://chat.example.com/" }, { id: 901, url: "https://app.example.com/" }];
        const win = { id: nextWindow++, focused: options.focused !== false, tabs: [...pinned, { id: nextTab++, url: "about:blank" }] };
        windows.set(win.id, win);
        tabsByWindow.set(win.id, [...win.tabs]);
        created.push({ window: win.id, options });
        return win;
      },
    },
    tabs: {
      create: async (options) => {
        const list = tabsByWindow.get(options.windowId);
        const tab = { id: nextTab++, url: options.url };
        list.push(tab);
        return { ...tab, index: list.length - 1, windowId: options.windowId, title: "" };
      },
      update: async (id, patch) => ({ id, ...patch }),
      get: async (id) => {
        for (const [windowId, list] of tabsByWindow) {
          const tab = list.find((candidate) => candidate.id === id);
          if (tab) return { ...tab, windowId };
        }
        throw new Error("no tab " + id);
      },
      query: async ({ windowId, index }) =>
        (tabsByWindow.get(windowId) || []).map((tab, i) => ({ ...tab, index: i, windowId })).filter((tab) => index === undefined || tab.index === index),
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: stored[key] }),
        set: async (values) => Object.assign(stored, values),
      },
    },
  };
  const source = background.slice(
    background.indexOf("let _agentWindowRecord = "),
    background.indexOf("async function _closeTabForSession(")
  );
  const sessionWindows = new Map();
  const api = Function(
    "browser", "_DEFAULT_SESSION", "_sessionWindowIds", "_adoptWindowForSession", "_setSessionTab",
    "_addOwnedTab", "_issueTabReceipt", "_waitForNavigatedTab", "_receiptOrigin", "_safeTabUrl",
    `let _profileWindowId = 1; // the user's focused window, as _discoverProfileWindow finds it
     function _windowForSession(sessionId) { return _sessionWindowIds.get(sessionId || _DEFAULT_SESSION) || _profileWindowId; } // as in background.js
     ${source}
     return { open: _newTabForSession, shared: () => _profileWindowId };`
  )(
    browser, "__default__", sessionWindows,
    (sid, windowId) => sessionWindows.set(sid, windowId),
    () => {}, async () => {}, async () => "Receipt_abcdefghijklmnopqrstuvwx",
    async () => null, (url) => new URL(url).origin, (url) => url,
  );
  return { api, windows, created, stored, sessionWindows, tabsByWindow };
}

test("a session with no window opens its tab in an unfocused agent window, never the user's", async () => {
  const { api, created, stored, sessionWindows } = harness();
  const first = await api.open("session-a", AGENT);
  assert.equal(created.length, 1, "one agent window is created");
  assert.equal(created[0].options.focused, false, "the agent window must not take focus");
  const agentId = created[0].window;
  assert.notEqual(agentId, 1);
  assert.equal(stored.mcpAgentWindow.windowId, agentId);
  assert.equal(typeof stored.mcpAgentWindow.parkingTabId, "number", "the parking tab is recorded with the window");
  assert.equal(sessionWindows.get("session-a"), agentId);
  assert.equal(api.shared(), agentId, "the shared default moves off the user's window");
  assert.equal(first.tabIndex, 4, "after the two pinned tabs and the parking tab");

  // A second session reuses the same agent window.
  await api.open("session-b", AGENT);
  assert.equal(created.length, 1, "the agent window is reused across sessions");
  assert.equal(sessionWindows.get("session-b"), agentId);
});

test("a closed agent window is recreated in the background", async () => {
  const { api, windows, created } = harness();
  await api.open("session-a", AGENT);
  const firstAgent = created[0].window;
  windows.delete(firstAgent); // the user closed it
  await api.open("session-b", AGENT);
  assert.equal(created.length, 2);
  assert.equal(created[1].options.focused, false);
  assert.notEqual(created[1].window, 1, "never falls back to the user's window");
});

test("a stored window id that now names the user's window (ids reused after a restart) is not trusted", async () => {
  const { api, created, stored, sessionWindows } = harness();
  stored.mcpAgentWindow = { windowId: 1, parkingTabId: 501 }; // from before the restart
  await api.open("session-a", AGENT);
  assert.equal(created.length, 1, "a new agent window is made");
  assert.notEqual(sessionWindows.get("session-a"), 1, "the tab never lands in the user's window");
});

test("the agent window is reused despite pinned tabs before its parking tab, and only while that tab is blank", async () => {
  const { api, created, tabsByWindow, stored } = harness();
  await api.open("session-a", AGENT);
  const agent = created[0].window;
  assert.ok(![900, 901].includes(stored.mcpAgentWindow.parkingTabId), "a pinned tab is never taken for the parking tab");
  await api.open("session-c", AGENT);
  assert.equal(created.length, 1, "pinned tabs first do not make the window look foreign");
  tabsByWindow.get(agent).find((tab) => tab.id === stored.mcpAgentWindow.parkingTabId).url = "https://news.example.com/"; // the user browsed in the parking tab
  await api.open("session-b", AGENT);
  assert.equal(created.length, 2);
});

// Opt-in: without payload.agentWindow the extension must pick windows exactly as it always did.
test("default path: the tab opens in the user's window and no window is created", async () => {
  for (const payload of [{}, { agentWindow: false }]) {
    const { api, created, stored, sessionWindows } = harness();
    const result = await api.open("session-a", payload);
    assert.equal(created.length, 0, "no window is created");
    assert.equal(stored.mcpAgentWindow, undefined, "no agent window is recorded");
    assert.equal(sessionWindows.get("session-a"), 1, "the tab lands in the user's window");
    assert.equal(result.tabIndex, 2, "after the user's one tab");
  }
});

test("safari_new_tab sends agentWindow only when SAFARI_MCP_AGENT_WINDOW is 1", () => {
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const from = index.indexOf('"safari_new_tab",');
  const handler = index.slice(from, index.indexOf("server.tool(", from));
  assert.match(handler, /\.\.\.\(process\.env\.SAFARI_MCP_AGENT_WINDOW === "1" \? \{ agentWindow: true \} : \{\}\)/);
});
