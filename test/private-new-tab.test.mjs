import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

// _newTabForSession against a fake browser with one normal user window (id 1).
function harness({ privateAllowed = true, privateReturnsNull = false } = {}) {
  /** @type {Map<number, any>} */
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
      remove: async (id) => { windows.delete(id); },
      create: async (options) => {
        // Safari opens a normal window when the extension may not run in Private Browsing.
        if (options.incognito && privateReturnsNull) return null;
        const incognito = options.incognito === true && privateAllowed;
        const win = { id: nextWindow++, focused: options.focused !== false, incognito, tabs: [{ id: nextTab++, windowId: nextWindow - 1, index: 0 }] };
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
  const windowHelpers = background.slice(
    background.indexOf("function _windowForSession("),
    background.indexOf("function _windowQuery(")
  );
  const source = background.slice(
    background.indexOf("let _privateWindowId = null;"),
    background.indexOf("async function _closeTabForSession(")
  );
  const sessionWindows = new Map();
  const api = Function(
    "browser", "_DEFAULT_SESSION", "_sessionWindowIds", "_setSessionTab",
    "_addOwnedTab", "_issueTabReceipt", "_waitForNavigatedTab", "_receiptOrigin", "_safeTabUrl",
    `let _profileWindowId = 1; // the user's focused window, as _discoverProfileWindow finds it
     ${windowHelpers}
     ${source}
     return { open: _newTabForSession, shared: () => _profileWindowId };`
  )(
    browser, "__default__", sessionWindows,
    () => {}, async () => {}, async () => "Receipt_abcdefghijklmnopqrstuvwx",
    async () => null, (url) => new URL(url).origin, (url) => url,
  );
  return { api, windows, created, stored, sessionWindows };
}

test("a private tab opens in an unfocused private window and leaves the shared default alone", async () => {
  const { api, windows, created, stored } = harness();
  const result = await api.open("session-a", { private: true });
  assert.equal(created.length, 1);
  assert.equal(created[0].options.incognito, true);
  assert.equal(created[0].options.focused, false, "the private window must not take focus");
  assert.equal(windows.get(created[0].window).incognito, true);
  assert.equal(stored.mcpPrivateWindowId, created[0].window);
  assert.equal(api.shared(), 1, "the shared default never moves to the private window");
  assert.equal(result.private, true, "the reply says the extension honoured the flag");

  // Later private tabs, from any session, reuse the window.
  await api.open("session-a", { private: true });
  await api.open("session-b", { private: true });
  assert.equal(created.length, 1);
});

test("a normal tab after a private one goes back to a normal window", async () => {
  const { api, windows, created } = harness();
  await api.open("session-a", { private: true });
  const result = await api.open("session-a", {});
  assert.equal(created.length, 1, "no extra window: the user's window is used");
  assert.equal(windows.get(1).incognito, undefined);
  assert.equal(result.private, undefined, "a normal tab does not claim to be private");
});

test("a closed private window is recreated", async () => {
  const { api, windows, created } = harness();
  await api.open("session-a", { private: true });
  windows.delete(created[0].window);
  await api.open("session-a", { private: true });
  assert.equal(created.length, 2);
  assert.equal(created[1].options.incognito, true);
});

test("a normal tab never lands in a private window, even with no normal window left", async () => {
  const { api, windows, created } = harness();
  await api.open("session-a", { private: true }); // session-a adopts the private window
  windows.delete(1);
  await api.open("session-a", {});
  assert.equal(created.length, 2);
  assert.notEqual(created[1].options.incognito, true);
  assert.notEqual(windows.get(created[1].window).incognito, true);
});

test("a private tab is refused, never opened logged in, when Safari will not make the window private", async () => {
  const { api, windows, created } = harness({ privateAllowed: false });
  await assert.rejects(api.open("session-a", { private: true }), /Allow in Private Browsing/);
  assert.equal(created.length, 1);
  assert.ok(!windows.has(created[0].window), "the non-private window Safari opened is closed again");
});

test("a private tab is refused when Safari returns no window at all", async () => {
  const { api } = harness({ privateReturnsNull: true });
  await assert.rejects(api.open("session-a", { private: true }), /Allow in Private Browsing/);
});

test("safari_new_tab never falls back to AppleScript for a private tab", () => {
  const from = index.indexOf('"safari_new_tab",');
  const handler = index.slice(from, index.indexOf("server.tool(", from));
  const refusal = handler.search(/if \(isPrivate\) \{\s*throw new Error/);
  assert.ok(refusal > 0, "the fallback must throw for a private tab");
  assert.ok(refusal < handler.indexOf("_openTabViaAppleScript("), "before AppleScript opens any tab");
  assert.match(handler, /\.\.\.\(isPrivate \? \{ private: true \} : \{\}\)/, "the extension is told the tab is private");
});

test("safari_new_tab closes and refuses a tab from an extension that ignored private", () => {
  const from = index.indexOf('"safari_new_tab",');
  const handler = index.slice(from, index.indexOf("server.tool(", from));
  const guard = handler.search(/if \(isPrivate && result\?\.private !== true\) \{/);
  assert.ok(guard > 0, "the reply must confirm private:true");
  assert.match(handler.slice(guard), /^[^]*?_closeTrackedTab\([^]*?throw new Error/, "the stray tab is closed, then refused");
  assert.ok(guard < handler.indexOf("_trackTab("), "before the tab is tracked or made current");
});
