import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

// _agentWindow + _newTabForSession, run against a fake browser with one user window (id 1).
function harness() {
  const windows = new Map([[1, { id: 1, focused: true }]]);
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
      create: async (options) => {
        const win = { id: nextWindow++, focused: options.focused !== false, tabs: [{ id: nextTab++ }] };
        windows.set(win.id, win);
        created.push({ window: win.id, options });
        return win;
      },
    },
    tabs: {
      create: async (options) => ({ id: nextTab++, index: 1, windowId: options.windowId, url: options.url, title: "" }),
      update: async (id, patch) => ({ id, ...patch }),
      query: async () => [],
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: stored[key] }),
        set: async (values) => Object.assign(stored, values),
      },
    },
  };
  const source = background.slice(
    background.indexOf("let _agentWindowId = null;"),
    background.indexOf("async function _closeTabForSession(")
  );
  const sessionWindows = new Map();
  const api = Function(
    "browser", "_DEFAULT_SESSION", "_sessionWindowIds", "_adoptWindowForSession", "_setSessionTab",
    "_addOwnedTab", "_issueTabReceipt", "_waitForNavigatedTab", "_receiptOrigin", "_safeTabUrl",
    `let _profileWindowId = 1; // the user's focused window, as _discoverProfileWindow finds it
     ${source}
     return { open: _newTabForSession, shared: () => _profileWindowId, close: (id) => { _agentWindowId = id; } };`
  )(
    browser, "__default__", sessionWindows,
    (sid, windowId) => sessionWindows.set(sid, windowId),
    () => {}, async () => {}, async () => "Receipt_abcdefghijklmnopqrstuvwx",
    async () => null, (url) => new URL(url).origin, (url) => url,
  );
  return { api, windows, created, stored, sessionWindows };
}

test("a session with no window opens its tab in an unfocused agent window, never the user's", async () => {
  const { api, created, stored, sessionWindows } = harness();
  const first = await api.open("session-a", {});
  assert.equal(created.length, 1, "one agent window is created");
  assert.equal(created[0].options.focused, false, "the agent window must not take focus");
  const agentId = created[0].window;
  assert.notEqual(agentId, 1);
  assert.equal(stored.mcpAgentWindowId, agentId);
  assert.equal(sessionWindows.get("session-a"), agentId);
  assert.equal(api.shared(), agentId, "the shared default moves off the user's window");
  assert.equal(first.tabIndex, 2);

  // A second session reuses the same agent window.
  await api.open("session-b", {});
  assert.equal(created.length, 1, "the agent window is reused across sessions");
  assert.equal(sessionWindows.get("session-b"), agentId);
});

test("a closed agent window is recreated in the background", async () => {
  const { api, windows, created } = harness();
  await api.open("session-a", {});
  const firstAgent = created[0].window;
  windows.delete(firstAgent); // the user closed it
  await api.open("session-b", {});
  assert.equal(created.length, 2);
  assert.equal(created[1].options.focused, false);
  assert.notEqual(created[1].window, 1, "never falls back to the user's window");
});
