#!/usr/bin/env node
/**
 * A tab whose page took it to another origin gets its receipt back the way the refusal says,
 * with or without SAFARI_PROFILE.
 *
 * Found by code reading on 29.9.26. The extension binds every receipt to the origin it was
 * minted on, and only get_tab_receipt may follow a tab across origins (handleCommand and
 * _resolveReceiptTab in extension/background.js). When the page moves the tab by itself — a
 * clicked link, a JS or server redirect, a login bounce — the next call carrying the receipt is
 * refused, and extensionOrFallback appended: "Rotate it with safari_run_script
 * [{"action":"getReceipt","receipt":"<old receipt>"}], or reopen with safari_new_tab."
 *   1. Without SAFARI_PROFILE, safari_run_script runs safari.js's legacy action table, which had no
 *      getReceipt: the step came back "Unknown action: getReceipt", and the batch went on. With
 *      safari_navigate and safari_switch_tab refusing the same receipt before they run, the
 *      session had no way to get a receipt that works on the tab's new origin.
 *   2. The advice put the receipt beside "action" instead of in "args", and the tool's schema
 *      drops it there. In a profile the step then rotated whichever tab the session had used last,
 *      and a caller that had reconnected since the refusal was refused.
 * Routed to the extension, the step has to name its tab without a profile (the batch's own
 * AppleScript newTab and switchTab leave the session's receipt naming a tab the batch has left), and
 * the server's ownership check leaves it to the extension, as a profile does: the URL safari.js holds
 * for the tab can be one the session never registered, after a redirect during an AppleScript load.
 *
 * Both sides are the real code: the extension's handleCommand preflight, its get_tab_receipt
 * handler, _resolveReceiptTab, _issueTabReceipt, _getReceiptTargetTab and _switchTabForSession
 * over a fake Safari window; index.js's tool handlers, extensionOrFallback with its guard, and
 * safari_run_script with safari.js's real runScript(), fed the advice through the tool's own zod
 * schema.
 *
 * Run:  node --test test/receipt-rotation-default-mode.test.mjs
 */
import assert from "node:assert/strict";
import { test, beforeEach, after } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// ownership-state.js persists to ~/.safari-mcp — point HOME at a throwaway dir first.
const tmpHome = mkdtempSync(join(tmpdir(), "smcp-rotate-"));
process.env.HOME = tmpHome;
const own = await import("../ownership-state.js");
const { textResult, errorResult } = await import("../response.js");
after(() => rmSync(tmpHome, { recursive: true, force: true }));

// The MCP session the next call comes from (currentSessionId() in index.js).
let sid = "";
beforeEach(() => {
  own._openedTabs.clear();
  own._ownedTabURLs.clear();
  own._ownedTabTimestamps.clear();
  rmSync(own.OWNERSHIP_DIR, { recursive: true, force: true });
  sid = "agent";
});

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const safariSource = readFileSync(new URL("../safari.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const EPOCH = "e".repeat(36);
const WINDOW = 7;
const USER_URL = "https://mail.example/inbox"; // the tab the user is looking at
const SHOP = "https://shop.example/cart";
const LOGIN = "https://login.example/sso?session=s3cr3t"; // where the shop bounces the tab
const THIRD = "https://third.example/";
const digest = (url) => createHash("sha256").update(String(url || "")).digest("hex");

// ---------- the extension, for real, over a fake Safari window ----------

const extensionParts = [
  between(background, "function _safeTabUrl(", "\nasync function _listTabsForSession("),
  between(background, "async function _listTabsForSession(", "\n// 2s was a happy-path budget"),
  between(background, "function _isValidReceiptRecord(", "\n// Rebuild the per-session window map"),
  between(background, "function _receiptForOwnedTab(", "\nfunction _withReceiptMutationLock("),
  between(background, "async function _issueTabReceipt(", "\nasync function _refreshTabReceiptIdentity("),
  between(background, "async function _resolveReceiptTab(", "\nfunction _addOwnedTab("),
  between(background, "function _hasTabReceiptAuthority(", "\n// The browser-run epoch lives"),
  between(background, "const _readOnlyCommands = new Set([", "\n]);") + "\n]);",
  between(background, "async function _getReceiptTargetTab(", "\nasync function getTargetTab("),
  between(background, "async function _switchTabForSession(", "\nlet _enabled = true;"),
].join("\n");
// handleCommand from resolving its target tab through its write guard, and the get_tab_receipt
// handler: which tab a command acts on, and whether its receipt lets it.
const preflight = between(background, "  // Receipt-based targeting depends on durable ownership state", "\n  switch (type) {");
const getTabReceiptCase = between(background, '    case "get_tab_receipt": {', "\n\n    // Which WINDOW holds");

function makeExtension() {
  const tabs = [{ id: 1, windowId: WINDOW, url: USER_URL, title: "", active: true }];
  const receipts = new Map(); // token → record: the extension's receipt registry
  const tokenByTab = new Map();
  const owned = new Map(); // sessionId → Set of tab ids
  const caches = new Map(); // sessionId → { tabId, tabUrl }
  const ran = []; // every command that reached a page: { type, tabId, url }
  let nextId = 100;
  let down = false;

  const live = (id) => tabs.find((tab) => tab.id === id);
  const withIndex = (tab) => ({ ...tab, index: tabs.indexOf(tab) });
  const cache = (session) => {
    if (!caches.has(session)) caches.set(session, { tabId: null, tabUrl: null });
    return caches.get(session);
  };
  const setSessionTab = (session, tabId, url) => Object.assign(cache(session), { tabId, tabUrl: url });
  const ownedBy = (session, id) => !!owned.get(session)?.has(id);
  const addOwned = async (session, id) => {
    if (!owned.has(session)) owned.set(session, new Set());
    owned.get(session).add(id);
  };

  const browser = {
    tabs: {
      query: async () => tabs.map(withIndex),
      get: async (id) => {
        const tab = live(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return withIndex(tab);
      },
    },
  };
  const ext = new Function(
    "browser", "_receiptByToken", "_tokenByTabId", "_digestTabUrl", "_persistOwnedTabs",
    "_withReceiptMutationLock", "_ensureBrowserSessionEpoch", "_isTabOwnedByAnySession",
    "_isTabOwnedBySession", "_addOwnedTab", "_sessionOwnedTabs", "_getSessionCache", "_setSessionTab",
    "_adoptWindowForSession", "_windowForSession", "_windowQuery", "getTargetTab", "_hydrateOwnedTabs",
    "_extractMcpTabMarker", "_DEFAULT_SESSION",
    `${extensionParts}
    return {
      _issueTabReceipt, _listTabsForSession, _switchTabForSession,
      async handleCommand(type, payload, pageCommand) {
        const sessionId = payload.sessionId || _DEFAULT_SESSION;
      ${preflight}
        switch (type) {
      ${getTabReceiptCase}
          default: return pageCommand(type, payload, sessionId, targetTab);
        }
      },
    };`
  )(
    browser, receipts, tokenByTab, async (url) => digest(url), async () => {},
    (operation) => operation(), async () => EPOCH, (id) => [...owned.values()].some((set) => set.has(id)),
    ownedBy, addOwned, owned, cache, setSessionTab,
    () => {}, () => WINDOW, (windowId) => ({ windowId }),
    // getTargetTab without a receipt: the session's cached tab, else the tab in front.
    async (_receipt, session) => live(cache(session).tabId) || tabs.find((tab) => tab.active),
    async () => {}, () => "", "_default"
  );

  // What the commands this test does not model through the real handlers do.
  async function pageCommand(type, payload, sessionId, target) {
    switch (type) {
      case "new_tab": {
        const tab = { id: nextId++, windowId: WINDOW, url: payload.url || "about:blank", title: "", active: false };
        tabs.push(tab);
        setSessionTab(sessionId, tab.id, tab.url);
        await addOwned(sessionId, tab.id);
        const receipt = await ext._issueTabReceipt(tab);
        return { tabIndex: tabs.indexOf(tab) + 1, url: tab.url, receipt };
      }
      case "list_tabs":
        return ext._listTabsForSession(sessionId);
      case "switch_tab":
        return ext._switchTabForSession(sessionId, target, payload);
      case "navigate":
        live(target.id).url = payload.url;
        setSessionTab(sessionId, target.id, payload.url);
        ran.push({ type, tabId: target.id, url: payload.url });
        return { title: "", url: payload.url };
      case "click":
        ran.push({ type, tabId: target.id, url: live(target.id).url });
        return "Clicked";
      default:
        throw new Error(`the fake extension does not model "${type}"`);
    }
  }

  return {
    tabs, ran,
    // The page moves its tab by itself: nothing rotates the receipt.
    pageMoves(id, url) { live(id).url = url; },
    receiptsOf: (id) => [...receipts.values()].filter((record) => record.tabId === id),
    set down(value) { down = value; },
    // The bridge. A payload is copied, as the wire would: handleCommand writes into it.
    async send(type, payload) {
      if (down) throw Object.assign(new Error("Extension timeout after 30000ms"), { dispatched: false });
      return ext.handleCommand(type, { ...payload }, pageCommand);
    },
  };
}

// ---------- safari.js's legacy run_script, for real ----------

// runScript's action table names every safari.js action. Each one runs through AppleScript, and
// here it only records that it did.
const runScriptSource = between(safariSource, "export async function runScript(", "\n// ========== ACCESSIBILITY SNAPSHOT")
  .replace(/^export /, "");
const actionTable = between(safariSource, "const actions = {", "\n      };")
  .slice("const actions = {".length)
  .replace(/\/\/.*$/gm, "");
const tableNames = [...new Set([
  ...[...actionTable.matchAll(/=> (\w+)\(/g)].map((m) => m[1]),
  ...actionTable.split("\n").filter((l) => !l.includes(":")).flatMap((l) => l.split(",")),
].map((name) => name.trim()).filter(Boolean))];

function fakeSafari() {
  const appleScript = []; // every call that reached AppleScript
  const does = {}; // what an AppleScript action does besides recording itself
  const viaAppleScript = (name) => async (...args) => {
    appleScript.push(name);
    return does[name] ? does[name](...args) : `${name} ok`;
  };
  const runScript = new Function(...tableNames, `${runScriptSource}\nreturn runScript;`)(
    ...tableNames.map(viaAppleScript)
  );
  // safari.js keeps the current tab per MCP session, and whether the session has owned one.
  const states = new Map();
  const st = () => {
    if (!states.has(sid)) states.set(sid, { url: null, index: null, owned: false });
    return states.get(sid);
  };
  return {
    appleScript, does, runScript,
    getActiveTabURL: () => st().url,
    setActiveTabURL: (url) => { st().url = url; },
    setActiveTabIndex: (i) => { st().index = i; },
    setActiveTabFromExtension: (_reported, url) => Object.assign(st(), { index: null, url: url || null, owned: true }),
    hasOwnedTab: () => st().owned,
    getActiveTabMarker: () => null,
    isActiveTabAdopted: () => false,
    saveFrontmostApp: async () => null,
    setFocusGuard() {},
    restoreFocusIfStolen: async () => {},
    newTab: viaAppleScript("newTab"),
    navigate: viaAppleScript("navigate"),
    click: viaAppleScript("click"),
    switchTab: viaAppleScript("switchTab"),
    listTabs: viaAppleScript("listTabs"),
  };
}

// ---------- index.js, for real ----------

const indexParts = [
  between(index, "async function _waitForVerifiedProfileExtension(", "\n// ========== EXTENSION BRIDGE"),
  between(index, "function _untrackClosedTab(", "\n// Close all MCP-opened tabs on process exit"),
  between(index, "const _noOwnershipCheck = new Set([", "\n// Origin of a URL"),
  between(index, "function _originOf(", "\nasync function _runExtensionBatchAction("),
  between(index, "async function _runExtensionBatchAction(", "\n// The cookie / localStorage / sessionStorage tools"),
].join("\n");

// The handler and the input schema a server.tool(...) call registers.
function toolAt(name) {
  const at = index.indexOf(`server.tool(\n  "${name}",`);
  assert.ok(at >= 0, `no ${name} tool`);
  return at;
}
function toolHandler(name) {
  const from = index.indexOf("async (", toolAt(name));
  return index.slice(from, index.indexOf("\n);\n", from));
}
function toolSchema(name) {
  const from = index.indexOf("\n  {\n", toolAt(name));
  const to = index.indexOf("\n  },\n  async (", from);
  return new Function("z", `return z.object(${index.slice(from, to)}\n  });`)(z);
}
const runScriptSchema = toolSchema("safari_run_script");

const TOOLS = ["safari_new_tab", "safari_click", "safari_read_page", "safari_navigate", "safari_switch_tab", "safari_run_script"];
const MODES = [
  { name: "without SAFARI_PROFILE", profile: "" },
  { name: "in a named profile", profile: "Work" },
];

function setup(mode) {
  const extension = makeExtension();
  const safari = fakeSafari();
  const deps = {
    safari, SESSION_ID: "daemon", currentSessionId: () => sid,
    process: { env: mode.profile ? { SAFARI_PROFILE: mode.profile } : {} },
    console: { error() {} }, textResult, errorResult,
    sendToExtension: (type, payload) => extension.send(type, payload),
    _evictOldestTab: async () => null, _trackTab: own._trackTab, _untrackTab: own._untrackTab,
    _openedTabs: own._openedTabs, _ownedTabURLs: own._ownedTabURLs, _addOwnedURL: own._addOwnedURL,
    _removeOwnedURL: own._removeOwnedURL, _markBlankTabOpened: own._markBlankTabOpened,
    _isURLOwned: own._isURLOwned, _trackedAtIndex: own._trackedAtIndex, _sessionTabs: own._sessionTabs,
    allowUserTabs: own.allowUserTabs, BLANK_TAB_SENTINEL: own.BLANK_TAB_SENTINEL,
    // A named profile is extension-only; without one, AppleScript is the fallback.
    _preferAppleScript: !!mode.profile, _extensionConnected: true, _profileExtensionVerified: true,
    _isExtensionHost: false, _commandTimeouts: {}, _nullMeansFailure: new Set(),
  };
  const server = new Function(
    ...Object.keys(deps),
    `${indexParts}
    return {
      // Safari restarted the profile's worker: calls wait until it has verified again.
      setVerified(value) { _profileExtensionVerified = value; },
      ${TOOLS.map((name) => `${name}: ${toolHandler(name)}`).join(",\n")}
    };`
  )(...Object.values(deps));
  return { server, extension, safari };
}

// A refusal comes back as a thrown error, or as an error result.
async function outcome(call) {
  try {
    return JSON.stringify(await call());
  } catch (err) {
    return err.message;
  }
}
const json = (result) => JSON.parse(result.content[0].text);

// Open a tab the way a caller does, and let its page take it to `movesTo`.
async function strandedTab(server, extension, movesTo = LOGIN) {
  const { receipt } = json(await server.safari_new_tab({ url: SHOP }));
  const tab = extension.tabs.at(-1);
  extension.pageMoves(tab.id, movesTo);
  return { receipt, tab };
}

// The refusal's advice, taken literally: its run_script step, with the caller's receipt where it
// says "<old receipt>", as the MCP server hands it to the tool once its schema has parsed it.
function advisedSteps(refusal, receipt) {
  const advice = /safari_run_script (\[.*\])/.exec(refusal);
  assert.ok(advice, `the refusal names no run_script step: ${refusal}`);
  return runScriptSchema.parse({ steps: JSON.parse(advice[1].replace("<old receipt>", receipt)) });
}

// ---------- 1. the advice gets the session back to its tab ----------

for (const mode of MODES) {
  test(`${mode.name}: the refusal's advice rotates the receipt of a tab its page took to another origin`, async () => {
    const { server, extension, safari } = setup(mode);
    const { receipt, tab } = await strandedTab(server, extension);

    const refusal = await outcome(() => server.safari_click({ selector: "#continue", receipt }));
    assert.match(refusal, /^Tab safety: receipt is not valid for this origin\. Likely cause: the tab moved to another origin/);
    // Nothing else reaches the tab with the receipt the session holds.
    assert.match(await outcome(() => server.safari_navigate({ url: SHOP, receipt })), /not valid for this origin/);
    assert.match(await outcome(() => server.safari_switch_tab({ receipt })), /not valid for this origin/);
    assert.deepEqual(extension.ran, [], "a refused call ran in the tab");

    const steps = advisedSteps(refusal, receipt);
    assert.deepEqual(steps.steps, [{ action: "getReceipt", args: { receipt } }], "the tool's schema dropped the advice's receipt");
    const [step] = json(await server.safari_run_script(steps));
    assert.equal(step.error, undefined, `getReceipt failed: ${step.error}`);
    assert.equal(step.result.safeUrl, "https://login.example/sso", "the tab where it is now, without its query");
    assert.match(step.result.receipt, /^[A-Za-z0-9_-]{24,}$/);
    assert.notEqual(step.result.receipt, receipt, "a rotation mints a new receipt");

    // The caller carries on with the receipt it holds: the server resolves it to the new one.
    assert.equal(await outcome(() => server.safari_click({ selector: "#continue", receipt })), JSON.stringify(textResult("Clicked")));
    assert.equal(await outcome(() => server.safari_click({ selector: "#continue", receipt: step.result.receipt })), JSON.stringify(textResult("Clicked")));
    assert.deepEqual(extension.ran, [
      { type: "click", tabId: tab.id, url: LOGIN },
      { type: "click", tabId: tab.id, url: LOGIN },
    ]);
    assert.deepEqual(safari.appleScript, [], "AppleScript touched no tab");
  });

  test(`${mode.name}: the rotated receipt is bound to the new origin, and the extension retired the old one`, async () => {
    const { server, extension } = setup(mode);
    const { receipt, tab } = await strandedTab(server, extension);
    const refusal = await outcome(() => server.safari_click({ selector: "#continue", receipt }));
    const [{ result }] = json(await server.safari_run_script(advisedSteps(refusal, receipt)));

    // Presented to the extension as it is, bypassing the server's alias, the old receipt is gone.
    await assert.rejects(
      extension.send("click", { receipt, sessionId: `daemon:${sid}` }),
      /no record of that receipt/
    );
    assert.deepEqual(extension.receiptsOf(tab.id).map((r) => r.receiptOrigin), ["https://login.example"]);

    // When the page moves on again, the new receipt is refused there too, and rotates the same way.
    extension.pageMoves(tab.id, THIRD);
    const again = await outcome(() => server.safari_click({ selector: "#next", receipt: result.receipt }));
    assert.match(again, /not valid for this origin/);
    const [{ result: third }] = json(await server.safari_run_script(advisedSteps(again, result.receipt)));
    assert.equal(third.safeUrl, THIRD);
    assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#next", receipt })), /Tab safety/);
    assert.deepEqual(extension.ran, [{ type: "click", tabId: tab.id, url: THIRD }]);
  });

  test(`${mode.name}: the advice rotates the tab it names, not the tab the session used last`, async () => {
    const { server, extension } = setup(mode);
    const stranded = await strandedTab(server, extension);
    const refusal = await outcome(() => server.safari_click({ selector: "#continue", receipt: stranded.receipt }));
    // The session opens another tab and works there before it comes back for the first one.
    const { receipt: other } = json(await server.safari_new_tab({ url: "https://docs.example/" }));
    const docs = extension.tabs.at(-1);
    await server.safari_click({ selector: "#read", receipt: other });

    const [{ result, error }] = json(await server.safari_run_script(advisedSteps(refusal, stranded.receipt)));
    assert.equal(error, undefined, `getReceipt failed: ${error}`);
    assert.equal(result.safeUrl, "https://login.example/sso", "the stranded tab was rotated");
    assert.deepEqual(extension.receiptsOf(docs.id).map((r) => r.token), [other], "the other tab kept its receipt");

    // No receipt: the rotated tab is the session's current one now.
    await server.safari_click({ selector: "#continue" });
    assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: stranded.tab.id, url: LOGIN });
  });

  test(`${mode.name}: the advice still rotates the receipt once the session has switched to the tab by index`, async () => {
    const { server, extension } = setup(mode);
    const { receipt, tab } = await strandedTab(server, extension);
    const refusal = await outcome(() => server.safari_click({ selector: "#continue", receipt }));
    // The extension switches to a tab the session owns by its index, and hands back no receipt for
    // it on its new origin.
    const switched = await outcome(() => server.safari_switch_tab({ index: extension.tabs.indexOf(tab) + 1 }));
    assert.doesNotMatch(switched, /Tab safety|receipt/);

    const [{ result, error }] = json(await server.safari_run_script(advisedSteps(refusal, receipt)));
    assert.equal(error, undefined, `getReceipt failed: ${error}`);
    assert.equal(result.safeUrl, "https://login.example/sso");
    assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#continue", receipt })), /Tab safety/);
    assert.deepEqual(extension.ran, [{ type: "click", tabId: tab.id, url: LOGIN }]);
  });

  test(`${mode.name}: a caller that reconnected since the refusal recovers its tab with the receipt it kept`, async () => {
    const { server, extension } = setup(mode);
    const { receipt, tab } = await strandedTab(server, extension);
    const refusal = await outcome(() => server.safari_click({ selector: "#continue", receipt }));

    sid = "agent-after-reconnect"; // a new MCP session: no current tab, no receipt of its own
    const [{ result, error }] = json(await server.safari_run_script(advisedSteps(refusal, receipt)));
    assert.equal(error, undefined, `getReceipt failed: ${error}`);
    assert.equal(result.safeUrl, "https://login.example/sso");
    assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#continue", receipt })), /Tab safety/);
    assert.deepEqual(extension.ran, [{ type: "click", tabId: tab.id, url: LOGIN }]);
  });

  // ---------- 2. a rotation, never an ownership bootstrap ----------

  test(`${mode.name}: getReceipt gives a session with no tab of its own no receipt, and the batch stops there`, async () => {
    const { server, extension, safari } = setup(mode);
    sid = "other"; // another client of the daemon has a tab of its own
    await server.safari_new_tab({ url: SHOP });
    sid = "fresh";

    const refusals = [
      {
        step: { action: "getReceipt" },
        // Without a profile the step has to name its tab. In a profile the extension finds no tab
        // this session owns, unless the server's own guard refuses first.
        refused: mode.profile
          ? /Tab safety: (getReceipt requires an existing receipt or a tab already owned by this MCP session|refusing "get_tab_receipt")/
          : /^Tab safety: without SAFARI_PROFILE, getReceipt needs the receipt of the tab it rotates/,
      },
      {
        step: { action: "getReceipt", args: { receipt: "Receipt_forged0000000000000000" } },
        refused: /^Tab safety: this extension has no record of that receipt/,
      },
    ];
    for (const { step, refused } of refusals) {
      const results = json(await server.safari_run_script({ steps: [step, { action: "click", args: { selector: "#send" } }] }));
      assert.equal(results.length, 1, `the step after a failed getReceipt ran: ${JSON.stringify(results)}`);
      assert.match(results[0].error, refused);
    }
    assert.deepEqual(extension.receiptsOf(1), [], "the user's tab got a receipt");
    assert.deepEqual(extension.ran, []);
    assert.deepEqual(safari.appleScript, []);
  });

  test(`${mode.name}: a getReceipt step whose receipt is not one is refused, and rotates no tab`, async () => {
    const { server, extension } = setup(mode);
    const stranded = await strandedTab(server, extension);
    const refusal = await outcome(() => server.safari_click({ selector: "#continue", receipt: stranded.receipt }));
    // The session opens another tab, which becomes its current one.
    const { receipt: other } = json(await server.safari_new_tab({ url: "https://docs.example/" }));
    const docs = extension.tabs.at(-1);

    for (const steps of [
      advisedSteps(refusal, "<old receipt>"), // the advice pasted as it is
      runScriptSchema.parse({ steps: [{ action: "getReceipt", args: { receipt: stranded.receipt.slice(0, 12) } }] }),
      runScriptSchema.parse({ steps: [{ action: "getReceipt", args: { receipt: 12345 } }] }),
    ]) {
      steps.steps.push({ action: "click", args: { selector: "#continue" } });
      const results = json(await server.safari_run_script(steps));
      assert.equal(results.length, 1, `the step after a refused getReceipt ran: ${JSON.stringify(results)}`);
      assert.match(results[0].error, /^Tab safety: getReceipt requires an extension-issued receipt/);
    }
    assert.deepEqual(extension.receiptsOf(docs.id).map((r) => r.token), [other], "the current tab was rotated in its place");
    assert.deepEqual(extension.receiptsOf(stranded.tab.id).map((r) => r.token), [stranded.receipt]);
    assert.deepEqual(extension.ran, []);
  });
}

test("without SAFARI_PROFILE, a getReceipt step that names no tab rotates none, after the batch's own AppleScript newTab", async () => {
  const { server, extension, safari } = setup(MODES[0]);
  const { receipt, tab } = await strandedTab(server, extension);
  // AppleScript opens the batch's tab: the session's receipt still names the tab above.
  const steps = [
    { action: "newTab", args: { url: "https://docs.example/" } },
    { action: "getReceipt" },
    { action: "click", args: { selector: "#continue" } },
  ];
  const results = json(await server.safari_run_script({ steps }));
  assert.deepEqual(results.map((r) => r.action), ["newTab", "getReceipt"], "the batch went on past getReceipt");
  assert.match(results[1].error, /^Tab safety: without SAFARI_PROFILE, getReceipt needs the receipt of the tab it rotates, in args\.receipt/);
  assert.deepEqual(extension.receiptsOf(tab.id).map((r) => r.token), [receipt], "a tab the batch did not name was rotated");
  assert.deepEqual(safari.appleScript, ["newTab"]);
  assert.deepEqual(extension.ran, []);
});

test("without SAFARI_PROFILE, getReceipt never falls back to AppleScript, and a failed one stops the batch", async () => {
  const { server, extension, safari } = setup(MODES[0]);
  const { receipt } = await strandedTab(server, extension);
  const refusal = await outcome(() => server.safari_click({ selector: "#continue", receipt }));

  extension.down = true;
  const steps = advisedSteps(refusal, receipt);
  steps.steps.push({ action: "click", args: { selector: "#continue" } });
  const results = json(await server.safari_run_script(steps));
  assert.equal(results.length, 1, `the step after a failed getReceipt ran: ${JSON.stringify(results)}`);
  assert.match(results[0].error, /^getReceipt: the Safari extension did not hand back a new receipt/);
  assert.deepEqual(safari.appleScript, [], "AppleScript touched a tab");
});

test("without SAFARI_PROFILE, the advice rotates the receipt of a tab the batch's own AppleScript load saw redirected", async () => {
  const { server, extension, safari } = setup(MODES[0]);
  const { receipt } = json(await server.safari_new_tab({ url: SHOP }));
  const tab = extension.tabs.at(-1);
  // safari.js's navigate() records the URL the tab landed on, here the login page it bounced to.
  safari.does.navigate = async () => {
    extension.pageMoves(tab.id, LOGIN);
    safari.setActiveTabURL(LOGIN);
    return JSON.stringify({ title: "", url: LOGIN });
  };
  const [load] = json(await server.safari_run_script({ steps: [{ action: "navigate", args: { url: "https://shop.example/account" } }] }));
  assert.equal(load.error, undefined, `the load failed: ${load.error}`);

  const refusal = await outcome(() => server.safari_read_page({}));
  assert.match(refusal, /not valid for this origin/);
  const [{ result, error }] = json(await server.safari_run_script(advisedSteps(refusal, receipt)));
  assert.equal(error, undefined, `getReceipt failed: ${error}`);
  assert.equal(result.safeUrl, "https://login.example/sso");
  assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#continue", receipt })), /Tab safety/);
  assert.deepEqual(extension.ran, [{ type: "click", tabId: tab.id, url: LOGIN }]);
  assert.deepEqual(safari.appleScript, ["navigate"]);
});

test("without SAFARI_PROFILE, safari_navigate hands back the fresh receipt it promises when it takes the tab to another origin", async () => {
  const { server, extension } = setup(MODES[0]);
  const { receipt } = json(await server.safari_new_tab({ url: SHOP }));
  const tab = extension.tabs.at(-1);

  const landed = json(await server.safari_navigate({ url: LOGIN, receipt }));
  assert.match(landed.receipt ?? "", /^[A-Za-z0-9_-]{24,}$/, `no fresh receipt: ${JSON.stringify(landed)}`);
  assert.deepEqual(extension.receiptsOf(tab.id).map((r) => [r.token, r.receiptOrigin]), [[landed.receipt, "https://login.example"]]);
});

test("in a named profile, a getReceipt that names no receipt rotates the tab the session had when it started, whatever a call running alongside names", async () => {
  const { server, extension } = setup(MODES[1]);
  const { receipt: other } = json(await server.safari_new_tab({ url: "https://docs.example/" }));
  const docs = extension.tabs.at(-1);
  const stranded = await strandedTab(server, extension); // now the session's current tab

  server.setVerified(false);
  const rotation = server.safari_run_script({ steps: [{ action: "getReceipt" }] });
  // Its receipt becomes the session's current one before it waits for the worker too.
  const click = outcome(() => server.safari_click({ selector: "#read", receipt: other }));
  server.setVerified(true);

  const [{ result, error }] = json(await rotation);
  assert.equal(error, undefined, `getReceipt failed: ${error}`);
  assert.equal(result.safeUrl, "https://login.example/sso", "it rotated the tab the other call named");
  assert.deepEqual(extension.receiptsOf(docs.id).map((r) => r.token), [other]);
  assert.doesNotMatch(await click, /Tab safety/);
  assert.deepEqual(extension.ran, [{ type: "click", tabId: docs.id, url: "https://docs.example/" }]);
  assert.notEqual(stranded.receipt, result.receipt);
});

test("in a named profile, a getReceipt that names no receipt follows a rotation another session made, and keeps that session's receipt working", async () => {
  const { server, extension } = setup(MODES[1]);
  const { receipt, tab } = await strandedTab(server, extension);
  sid = "subagent"; // a second client of the daemon, handed the receipt
  assert.match(await outcome(() => server.safari_click({ selector: "#continue", receipt })), /not valid for this origin/);
  sid = "agent";
  const [{ result: first }] = json(await server.safari_run_script({ steps: [{ action: "getReceipt", args: { receipt } }] }));

  sid = "subagent"; // its current receipt is still the one the agent has since rotated
  const [{ result: second, error }] = json(await server.safari_run_script({ steps: [{ action: "getReceipt" }] }));
  assert.equal(error, undefined, `getReceipt failed: ${error}`);
  assert.equal(second.safeUrl, "https://login.example/sso");
  sid = "agent"; // carries on with the receipt its own rotation handed it
  assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#continue", receipt: first.receipt })), /Tab safety/);
  assert.deepEqual(extension.ran, [{ type: "click", tabId: tab.id, url: LOGIN }]);
});

for (const mode of MODES) {
  test(`${mode.name}: a getReceipt that fails leaves the session on the tab it was on`, async () => {
    const { server, extension } = setup(mode);
    const stranded = await strandedTab(server, extension);
    const { receipt: other } = json(await server.safari_new_tab({ url: "https://docs.example/" }));
    const docs = extension.tabs.at(-1);
    await server.safari_click({ selector: "#read", receipt: other });
    extension.tabs.splice(extension.tabs.indexOf(stranded.tab), 1); // the user closes the stranded tab

    const [{ error }] = json(await server.safari_run_script({ steps: [{ action: "getReceipt", args: { receipt: stranded.receipt } }] }));
    assert.match(error, /^Tab safety: the receipt's tab is closed/);
    assert.doesNotMatch(await outcome(() => server.safari_click({ selector: "#read" })), /Tab safety/);
    assert.deepEqual(extension.ran.at(-1), { type: "click", tabId: docs.id, url: "https://docs.example/" });
  });
}
