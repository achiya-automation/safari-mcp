#!/usr/bin/env node
/**
 * Regression coverage for several Claude sessions sharing one Safari profile.
 *
 * In HTTP daemon mode (SAFARI_MCP_HTTP=1) a single node process serves many MCP
 * sessions against ONE Safari window. Two pieces of state were process-wide and
 * silently shared, so sessions fought over the same tabs:
 *
 *   1. getTargetTab fell through to "active tab of the profile window (no session
 *      bias)" — whatever another session (or the user) last fronted. Measured
 *      23.8.26: commands landed on a parallel session's Telegram tab mid-run, and
 *      the ownership guard then rejected them as "not opened by this MCP session".
 *
 *   2. _openedTabs backed the MAX_TABS cap. With N sessions the cap was the SUM of
 *      everyone's tabs, and the "close the oldest" eviction closed whichever tab was
 *      oldest overall — routinely a tab another session was still working in.
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const ownership = readFileSync(new URL("../ownership-state.js", import.meta.url), "utf8");

test("a session with its own tabs never falls through to the active tab", () => {
  const fn = background.slice(
    background.indexOf("async function getTargetTab("),
    background.indexOf("async function getActiveTab(")
  );
  const ownIdx = fn.indexOf("_sessionOwnedTabs.get(sessionId");
  const activeIdx = fn.indexOf("// PRIORITY 3: Active tab");
  assert.ok(ownIdx > 0, "must consult the session's own tabs");
  assert.ok(
    ownIdx < activeIdx,
    "the session's own tabs must be preferred BEFORE the active-tab fallback"
  );
});

test("the owned-tab lookup keeps the guards that make it safe", () => {
  const fn = background.slice(
    background.indexOf("// PRIORITY 2: a tab this session actually owns"),
    background.indexOf("// PRIORITY 3: Active tab")
  );
  assert.ok(fn.includes("browser.tabs.get("), "a closed tab must not be returned");
  assert.ok(fn.includes("winId"), "must not cross out of the session's profile window");
  assert.ok(/delete\(ownedId\)/.test(fn), "dead tab ids must be pruned, not retried forever");
  assert.ok(fn.includes("reverse()"), "most recent tab first — that is the one in use");
});

test("a session that owns nothing still reaches the old fallback", () => {
  // Sessions on their first command, and read-only helpers, must behave as before.
  const fn = background.slice(
    background.indexOf("// PRIORITY 2: a tab this session actually owns"),
    background.indexOf("async function getActiveTab(")
  );
  assert.ok(
    /if \(ownedIds && ownedIds\.size\)/.test(fn),
    "the new branch must be conditional, not unconditional"
  );
  assert.ok(fn.includes("// PRIORITY 3: Active tab"), "the active-tab fallback must still exist below it");
});

test("the tab cap counts only the calling session's tabs", () => {
  const near = index.slice(
    index.indexOf("Enforce tab limit"),
    index.indexOf("const rawResult = await extensionOrFallback")
  );
  assert.ok(
    !/_openedTabs\.size >= MAX_TABS/.test(near),
    "cap must not be measured against the process-wide map"
  );
  assert.ok(near.includes("myTabs"), "cap must be measured against this session's tabs");
  assert.ok(
    /filter\(.*info\.sessionId/s.test(near),
    "the session's tabs must be selected by sessionId"
  );
});

test("eviction can only close a tab the calling session opened", () => {
  const near = index.slice(
    index.indexOf("Enforce tab limit"),
    index.indexOf("const rawResult = await extensionOrFallback")
  );
  const loop = near.slice(near.indexOf("for ("), near.indexOf("if (oldestIdx !== null)"));
  assert.ok(
    loop.includes("myTabs") && !loop.includes("_openedTabs"),
    "the oldest-tab scan must iterate this session's tabs, not every tab"
  );
});

test("every tab we open is stamped with its session", () => {
  assert.ok(
    /_trackTab\(tabIndex, url, sessionId = ""\)/.test(ownership),
    "_trackTab must accept a session"
  );
  assert.ok(/openedAt: Date\.now\(\), sessionId/.test(ownership), "and record it");
  const calls = [...index.matchAll(/_trackTab\(([^;]*?)\)\s*;/g)].map(m => m[1]);
  assert.ok(calls.length >= 3, "expected every _trackTab call site to be covered");
  for (const args of calls) {
    assert.ok(
      /mySession|currentSessionId\(\)/.test(args),
      `_trackTab call without a session id would escape the per-session cap: ${args}`
    );
  }
});

test("each session tracks its own profile window", () => {
  // One Safari profile can hold several windows once parallel sessions have run for a
  // while — measured 23.8.26: three "אוטומציות" windows at once. A single shared
  // _profileWindowId then locked every session but one out of its OWN tabs with
  // "a same-URL tab exists in another window — refusing to cross windows".
  assert.ok(background.includes("_sessionWindowIds"), "must keep a per-session window map");
  assert.ok(background.includes("function _windowForSession"), "and resolve through it");

  const fn = background.slice(
    background.indexOf("async function getTargetTab("),
    background.indexOf("async function getActiveTab(")
  );
  assert.ok(fn.includes("_windowForSession(sessionId)"), "getTargetTab must use the session's window");
  assert.ok(
    !/_profileWindowId &&/.test(fn),
    "getTargetTab must not gate on the shared window id any more"
  );

  // Adoption happens only where the session actually opened a tab — never by guessing.
  assert.ok(background.includes("_adoptWindowForSession(sessionId, openedWindowId)"),
    "a session adopts a window by opening a tab in it");
});

test("falling back to the shared window keeps first-command behaviour", () => {
  const resolver = background.slice(
    background.indexOf("function _windowForSession"),
    background.indexOf("function _adoptWindowForSession")
  );
  assert.ok(resolver.includes("|| _profileWindowId"),
    "a session with no window of its own must still get the shared one");
});

test("new_tab survives a profile that already has several windows", () => {
  // new_tab CREATES its target, so failing to resolve an existing one must not stop it.
  // With several windows open, resolution legitimately throws "a same-URL tab exists in
  // another window" — which made new_tab, the very command that recovers from that
  // state, impossible to run.
  const fn = background.slice(
    background.indexOf("async function handleCommand("),
    background.indexOf("TAB OWNERSHIP GUARD")
  );
  assert.ok(/catch \(resolveErr\)/.test(fn), "resolution failure must be catchable");
  assert.ok(
    /if \(type !== "new_tab"\) throw resolveErr/.test(fn),
    "only new_tab may proceed past a resolution failure — everything else must still throw"
  );
});

test("the cross-profile guard checks the session's window, not the shared one", () => {
  const fn = background.slice(
    background.indexOf("async function handleCommand("),
    background.indexOf("TAB OWNERSHIP GUARD")
  );
  assert.ok(fn.includes("_windowForSession(sessionId)"), "guard must resolve per session");
  assert.ok(
    !/if \(_profileWindowId && targetTab\.windowId !== _profileWindowId\)/.test(fn),
    "the old shared-window comparison must be gone"
  );
  assert.ok(fn.includes("tabId !== null"), "a not-yet-created tab must skip the guard");
});

test("ownership survives a worker suspend on Safari", () => {
  // The ownership map was written only to storage.session — which does not exist on
  // Safari, so the write went nowhere. Every worker suspend wiped it, and the session
  // was then told "not opened by this MCP session" about tabs it had just opened.
  const persist = background.slice(
    background.indexOf("function _persistOwnedTabs"),
    background.indexOf("function _extractMcpTabMarker")
  );
  assert.ok(persist.includes("_OWNED_TABS_LOCAL_KEY"), "the map must be mirrored to storage.local");
  assert.ok(/at: Date\.now\(\)/.test(persist), "and stamped, so staleness can be judged");

  const hydrate = background.slice(
    background.indexOf("async function _hydrateOwnedTabs"),
    background.indexOf("function _persistOwnedTabs")
  );
  assert.ok(hydrate.includes("_OWNED_TABS_LOCAL_KEY"), "and read back on wake");
  assert.ok(hydrate.includes("_OWNED_TABS_TTL_MS"), "bounded by age");
  assert.ok(
    hydrate.includes("_resolveHydratedReceiptTab("),
    "hydration must require the exact same tab id plus one unambiguous URL digest"
  );
});

test("worker restart recovers each session's own window from live owned tabs", () => {
  const helperStart = background.indexOf("function _recoverSessionWindowsFromOwnedTabs(");
  const helperEnd = background.indexOf("\nasync function _hydrateOwnedTabs", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "recovery helper must exist");
  const helper = background.slice(helperStart, helperEnd);

  const recovered = Function(`
    const _DEFAULT_SESSION = "__default__";
    const _sessionOwnedTabs = new Map([
      ["session-a", new Set([11, 12, 99])],
      ["session-b", new Set([21])],
    ]);
    const windows = new Map();
    const tabs = new Map();
    function _adoptWindowForSession(sessionId, windowId) {
      windows.set(sessionId || _DEFAULT_SESSION, windowId);
    }
    function _setSessionTab(sessionId, tabId, url) {
      tabs.set(sessionId || _DEFAULT_SESSION, { tabId, url });
    }
    ${helper}
    _recoverSessionWindowsFromOwnedTabs(new Map([
      [11, { id: 11, windowId: 101, url: "https://example.test/older" }],
      [12, { id: 12, windowId: 101, url: "https://example.test/latest" }],
      [21, { id: 21, windowId: 202, url: "https://example.test/b" }],
    ]));
    return { windows, tabs };
  `)();

  assert.equal(recovered.windows.get("session-a"), 101);
  assert.equal(recovered.windows.get("session-b"), 202);
  assert.deepEqual(recovered.tabs.get("session-a"), {
    tabId: 12,
    url: "https://example.test/latest",
  });
  assert.deepEqual(recovered.tabs.get("session-b"), {
    tabId: 21,
    url: "https://example.test/b",
  });

  const hydrate = background.slice(
    background.indexOf("async function _hydrateOwnedTabs"),
    background.indexOf("function _persistOwnedTabs")
  );
  const localRestore = hydrate.indexOf("browser.storage.local.get(_OWNED_TABS_LOCAL_KEY)");
  const recoveryCall = hydrate.indexOf("_recoverSessionWindowsFromOwnedTabs(liveTabsById)");
  assert.ok(localRestore >= 0, "hydrate must restore local ownership");
  assert.ok(
    recoveryCall > localRestore,
    "window recovery must run after persisted ownership has been restored"
  );
});

test("tab management stays inside each session's window, including last-tab protection", async () => {
  const helperStart = background.indexOf("function _windowQuery(");
  const helperEnd = background.indexOf("\nlet _enabled", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "tab-management helpers must exist");
  const helpers = background.slice(helperStart, helperEnd);

  const sessionWindows = new Map([
    ["session-a", 101],
    ["session-b", 202],
  ]);
  const owned = new Map([
    ["session-a", new Set([11, 12])],
    ["session-b", new Set([21])],
  ]);
  const targets = new Map();
  const removed = [];
  const updated = [];
  const created = [];
  let nextTabId = 30;
  const liveTabs = [
    { id: 11, windowId: 101, index: 0, title: "A one", url: "https://a.test/one", active: true },
    { id: 12, windowId: 101, index: 1, title: "A two", url: "https://a.test/two", active: false },
    { id: 21, windowId: 202, index: 0, title: "B only", url: "https://b.test/only", active: true },
  ];
  const reindex = (windowId) => {
    liveTabs.filter((tab) => tab.windowId === windowId)
      .sort((a, b) => a.index - b.index)
      .forEach((tab, index) => { tab.index = index; });
  };
  const browser = {
    windows: {
      get: async (windowId) => ({ id: windowId }),
      getAll: async () => [{ id: 101 }, { id: 202 }],
      create: async () => { throw new Error("unexpected window creation"); },
    },
    tabs: {
      query: async (query) => {
        const windowId = query.windowId || 101;
        return liveTabs.filter((tab) => tab.windowId === windowId)
          .sort((a, b) => a.index - b.index);
      },
      create: async ({ windowId, url }) => {
        const tab = {
          id: nextTabId++, windowId,
          index: liveTabs.filter((candidate) => candidate.windowId === windowId).length,
          title: "", url, active: false,
        };
        liveTabs.push(tab);
        created.push(tab);
        return tab;
      },
      update: async (tabId, patch) => {
        const tab = liveTabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error("missing tab " + tabId);
        Object.assign(tab, patch);
        updated.push({ tabId, patch });
        return tab;
      },
      remove: async (tabId) => {
        const index = liveTabs.findIndex((candidate) => candidate.id === tabId);
        if (index < 0) throw new Error("missing tab " + tabId);
        const [{ windowId }] = liveTabs.splice(index, 1);
        removed.push(tabId);
        reindex(windowId);
      },
    },
    storage: { local: { set: async () => {} } },
  };

  const api = Function(
    "browser",
    "_windowForSession",
    "_extractMcpTabMarker",
    "_receiptForOwnedTab",
    "_sessionWindowIds",
    "_DEFAULT_SESSION",
    "_profileWindowId",
    "_adoptWindowForSession",
    "_setSessionTab",
    "_addOwnedTab",
    "_issueTabReceipt",
    "_isTabOwnedBySession",
    "_removeOwnedTab",
    `${helpers}
     return {
       list: _listTabsForSession,
       open: _newTabForSession,
       close: _closeTabForSession,
       switchTo: _switchTabForSession,
       sharedWindow: () => _profileWindowId,
     };`
  )(
    browser,
    (sessionId) => sessionWindows.get(sessionId) || 101,
    () => "",
    (sessionId, tab) => owned.get(sessionId)?.has(tab.id) ? `receipt:${tab.id}` : "",
    sessionWindows,
    "__default__",
    101,
    (sessionId, windowId) => sessionWindows.set(sessionId, windowId),
    (sessionId, tabId, url) => targets.set(sessionId, { tabId, url }),
    async (sessionId, tabId) => {
      if (!owned.has(sessionId)) owned.set(sessionId, new Set());
      owned.get(sessionId).add(tabId);
    },
    async (tab) => `Receipt_${String(tab.id).padEnd(24, "0")}`,
    (sessionId, tabId) => owned.get(sessionId)?.has(tabId) || false,
    async (sessionId, tabId) => owned.get(sessionId)?.delete(tabId),
  );

  assert.deepEqual((await api.list("session-a")).map((tab) => tab.title), ["A one", "A two"]);
  assert.deepEqual((await api.list("session-b")).map((tab) => tab.title), ["B only"]);

  const switched = await api.switchTo("session-b", liveTabs.find((tab) => tab.id === 21), { index: 1 });
  assert.equal(switched.safeUrl, "https://b.test/only");
  assert.equal(targets.get("session-b").tabId, 21, "session B must not switch to window A's index 1");

  assert.equal(
    await api.close("session-a", liveTabs.find((tab) => tab.id === 11), { index: 2 }),
    "Tab closed"
  );
  assert.deepEqual(removed, [12], "session A's indexed close must remove only its own window's tab");

  assert.match(
    await api.close("session-b", liveTabs.find((tab) => tab.id === 21), {}),
    /^Last remaining tab blanked/
  );
  assert.deepEqual(removed, [12], "session B's last tab must be blanked, never removed");
  assert.ok(updated.some(({ tabId, patch }) => tabId === 21 && patch.url === "about:blank"));

  const rawSignedUrl = "https://b.test/new?X-Amz-Signature=ab%2fCD%2Bef&dup=1&dup=2#/route?next=%2F";
  const opened = await api.open("session-b", { url: rawSignedUrl });
  assert.equal(created.at(-1).windowId, 202, "session B must create its next tab in window B");
  assert.equal(opened.tabIndex, 2);
  assert.equal(opened.safeUrl, "https://b.test/new");
  assert.match(opened.receipt, /^[A-Za-z0-9_-]{24,}$/);
  assert.ok(
    updated.some(({ tabId, patch }) => tabId === created.at(-1).id && patch.url === rawSignedUrl),
    "tabs.update must receive the caller's exact signed query and application hash byte-for-byte"
  );
  assert.equal(api.sharedWindow(), 101, "opening in window B must not move the shared default from A");

  const managementCases = background.slice(
    background.indexOf('case "list_tabs":'),
    background.indexOf("// --- Scroll ---")
  );
  for (const helper of [
    "_listTabsForSession", "_newTabForSession", "_closeTabForSession", "_switchTabForSession",
  ]) {
    assert.ok(managementCases.includes(helper), `handleCommand must delegate to ${helper}`);
  }
});

test("native_click with explicit coordinates does not require injection", () => {
  // Helpers are only needed to LOCATE an element. Demanding injection even for x/y made
  // native_click unusable on the pages that need it most: business.facebook.com stalls
  // injection, so ensureHelpers threw INJECT_ERR and the OS-level click — the only kind
  // React's isTrusted-gated handlers accept — never fired.
  const safari = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
  const fn = safari.slice(
    safari.indexOf("export async function nativeClick("),
    safari.indexOf("async function _nativeClickImpl(")
  );
  assert.ok(/const needsLookup/.test(fn), "must decide whether a lookup is needed");
  assert.ok(
    /if \(needsLookup\) await ensureHelpers\(\)/.test(fn),
    "ensureHelpers must be conditional, not unconditional"
  );
  assert.ok(
    /args\?\.ref \|\| args\?\.selector \|\| args\?\.text/.test(fn),
    "a lookup is exactly ref/selector/text — x/y needs nothing"
  );
});

test("a pinned native click uses the global tap, not postToPid", () => {
  // Measured 23.8.26 on macOS 26: a window-targeted postToPid click reports success and
  // never reaches the page. Proven on a plain <a> in example.com with a click listener
  // armed — it never fired. Only the global tap (windowId 0, which moves the cursor and
  // restores it) actually lands, and it needs Safari genuinely frontmost. That is what
  // the pin buys: it raises Safari and its window, clicks for real, then hands both back.
  const safari = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
  assert.ok(safari.includes("_pinnedForceGlobalTap"), "pinned clicks must select the tap explicitly");
  assert.ok(
    /_helperNativeClick\([^)]*_pinnedForceGlobalTap \? 0 : geo\.windowId\)/s.test(safari),
    "windowId 0 (global tap) only when pinned; otherwise keep the targeted path"
  );
  const pinned = safari.slice(
    safari.indexOf("async function _withPinnedTabFronted"),
    safari.indexOf("let _pinnedWindowOverride")
  );
  assert.ok(pinned.includes('_helperActivateApp("com.apple.Safari")'), "must bring Safari to the front");
  assert.ok(pinned.includes("restoreFocusIfStolen"), "and give the foreground back afterwards");
  assert.ok(
    pinned.indexOf("_pinnedForceGlobalTap = false") > pinned.indexOf("finally"),
    "the flag must be cleared in finally, or it leaks into unpinned clicks"
  );
});
