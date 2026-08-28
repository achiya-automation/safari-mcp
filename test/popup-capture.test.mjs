#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function extract(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

function browserFunction(name, nextMarker) {
  return extract(background, `function ${name}(`, nextMarker);
}

function popupDom(html) {
  const dom = new JSDOM(`<body>${html}</body>`, {
    url: "https://affiliate.example.test/signup?private=form-state",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    right: 130,
    bottom: 60,
    width: 120,
    height: 40,
    x: 10,
    y: 20,
  });
  window.Element.prototype.scrollIntoView = () => {};
  const captureSource = browserFunction(
    "_popupClickFrameAction",
    "\nasync function execInExactMatchingFrameMainOnce("
  );
  window.eval(`${captureSource}; window.__capturePopupClick = _popupClickFrameAction;`);
  return window;
}

test("run_script exposes the verified-profile-only clickAndOpenPopup action", () => {
  const dispatcher = extract(
    index,
    "async function _runExtensionBatchAction(",
    "\n// Tab-ownership assertion"
  );
  const tool = extract(
    index,
    'server.tool(\n  "safari_run_script"',
    "\n// ========== CONSOLE =========="
  );

  assert.match(dispatcher, /case "clickAndOpenPopup":/);
  assert.match(dispatcher, /"click_open_popup"/);
  assert.match(dispatcher, /requires exactly one of selector or ref/);
  assert.match(dispatcher, /_sanitizeTabResult/);
  assert.match(tool, /clickAndOpenPopup/);
  assert.match(tool, /refuses CAPTCHA\/challenge targets/);
  assert.match(tool, /never returns URL query\/hash data/);
  assert.match(tool, /"click", "clickAndOpenPopup", "fill"/);
});

test("MAIN-world popup capture clicks once, captures the exact URL, and restores window.open", () => {
  const window = popupDom('<button id="google-oauth">Continue with Google</button>');
  const button = window.document.getElementById("google-oauth");
  let clicks = 0;
  const originalOpen = () => "original";
  Object.defineProperty(window, "open", {
    configurable: true,
    writable: true,
    value: originalOpen,
  });
  button.addEventListener("click", () => {
    clicks += 1;
    window.open(
      "https://accounts.example.test/oauth/../oauth/start?code=private-code%2fX#callback"
    );
  });

  const result = window.__capturePopupClick("#google-oauth", "", "capture");

  assert.equal(clicks, 1, "the OAuth button must receive exactly one click");
  assert.equal(result.ok, true);
  assert.equal(
    result.popupUrl,
    "https://accounts.example.test/oauth/../oauth/start?code=private-code%2fX#callback"
  );
  assert.equal(window.open, originalOpen, "window.open must be restored immediately");
});

test("popup capture supports blank-first OAuth helpers without creating a real popup", () => {
  const window = popupDom('<button id="oauth">Sign in</button>');
  const button = window.document.getElementById("oauth");
  let clicks = 0;
  button.addEventListener("click", () => {
    clicks += 1;
    const popup = window.open("", "oauth-window");
    popup.location.href = "/oauth/authorize?state=private-state";
  });

  const result = window.__capturePopupClick("#oauth", "", "capture");

  assert.equal(clicks, 1);
  assert.equal(result.ok, true);
  assert.equal(
    result.popupUrl,
    "https://affiliate.example.test/oauth/authorize?state=private-state"
  );
});

test("a page error after window.open does not discard the captured OAuth URL", () => {
  const window = popupDom('<button id="oauth">Sign in</button>');
  const button = window.document.getElementById("oauth");
  button.dispatchEvent = () => {
    window.open("https://oauth.example.test/start?state=private-state");
    throw new Error("page listener failed after opening");
  };

  const result = window.__capturePopupClick("#oauth", "", "capture");

  assert.equal(result.ok, true);
  assert.equal(result.popupUrl, "https://oauth.example.test/start?state=private-state");
});

test("popup capture refuses CAPTCHA-like targets before dispatching a click", () => {
  const window = popupDom('<button id="recaptcha-submit">Verify</button>');
  const button = window.document.getElementById("recaptcha-submit");
  let clicks = 0;
  button.addEventListener("click", () => {
    clicks += 1;
  });

  const result = window.__capturePopupClick("#recaptcha-submit", "", "capture");

  assert.equal(result.ok, false);
  assert.equal(result.code, "captcha_refused");
  assert.equal(clicks, 0);
});

test("exact-frame executor mutates one proven frame in MAIN and rejects ambiguity", async () => {
  const helperSource = extract(
    background,
    "async function execInExactMatchingFrameMainOnce(",
    "\nfunction _isFrameMiss("
  );
  let executeCalls = 0;
  let lastOptions = null;
  const makeExecutor = (probes) =>
    Function(
      "_executeAllFrames",
      "getActiveTab",
      "_withInjectionDeadline",
      "browser",
      `${helperSource}; return execInExactMatchingFrameMainOnce;`
    )(
      async () => probes,
      async () => ({ id: 55 }),
      async (promise) => await promise,
      {
        scripting: {
          executeScript: async (options) => {
            executeCalls += 1;
            lastOptions = options;
            return [
              { result: { ok: true, popupUrl: "https://oauth.example.test/start?private=1" } },
            ];
          },
        },
      }
    );

  const exact = makeExecutor([{ frameId: 9, result: { count: 1 } }]);
  const result = await exact(
    () => {},
    [],
    () => {},
    [],
    42
  );
  assert.equal(result.ok, true);
  assert.equal(executeCalls, 1);
  assert.equal(lastOptions.world, "MAIN");
  assert.deepEqual(lastOptions.target, { tabId: 42, frameIds: [9] });

  executeCalls = 0;
  const ambiguous = makeExecutor([
    { frameId: 9, result: { count: 1 } },
    { frameId: 12, result: { count: 1 } },
  ]);
  await assert.rejects(
    ambiguous(
      () => {},
      [],
      () => {},
      [],
      42
    ),
    /ambiguous across frames/
  );
  assert.equal(executeCalls, 0, "an ambiguous selector must never dispatch a click");
});

test("popup tab creation preserves the exact URL internally and returns only safe metadata", async () => {
  const helperSource = extract(
    background,
    "async function _openPopupTabForSession(",
    "\nasync function _closeTabForSession("
  );
  const created = [];
  const popupUrl = "https://oauth.example.test/authorize?code=private-code#secret-state";
  const receipt = "PopupReceipt_abcdefghijklmnopqrstuvwxyz";
  const openPopup = Function(
    "browser",
    "_adoptWindowForSession",
    "_setSessionTab",
    "_addOwnedTab",
    "_issueTabReceipt",
    "_receiptOrigin",
    "_safeTabUrl",
    `${helperSource}; return _openPopupTabForSession;`
  )(
    {
      tabs: {
        create: async (options) => {
          created.push(options);
          return {
            id: 88,
            index: 4,
            windowId: 7,
            openerTabId: options.openerTabId,
            url: options.url,
            title: "OAuth",
          };
        },
        get: async () => { throw new Error("already linked"); },
        remove: async () => { throw new Error("must not remove linked popup"); },
      },
    },
    () => {},
    () => {},
    async () => {},
    async () => receipt,
    (url) => new URL(url).origin,
    (url) => {
      const parsed = new URL(url);
      return parsed.origin + parsed.pathname;
    }
  );

  const result = await openPopup("session-a", { id: 41, windowId: 7 }, popupUrl);

  assert.equal(created.length, 1);
  assert.deepEqual(created[0], {
    url: popupUrl,
    active: false,
    windowId: 7,
    openerTabId: 41,
  });
  assert.deepEqual(result, {
    clicked: true,
    popupOpened: true,
    title: "OAuth",
    safeUrl: "https://oauth.example.test/authorize",
    receipt,
    tabIndex: 5,
  });
  assert.equal(JSON.stringify(result).includes("private-code"), false);
  assert.equal(JSON.stringify(result).includes("secret-state"), false);
  assert.equal(Object.hasOwn(result, "url"), false);
});

test("popup creation fails closed unless Safari preserves the exact direct opener", async () => {
  const helperSource = extract(
    background,
    "async function _openPopupTabForSession(",
    "\nasync function _closeTabForSession("
  );
  const removed = [];
  let ownershipAdds = 0;
  let receiptIssues = 0;
  const openPopup = Function(
    "browser",
    "_adoptWindowForSession",
    "_setSessionTab",
    "_addOwnedTab",
    "_issueTabReceipt",
    "_receiptOrigin",
    "_safeTabUrl",
    `${helperSource}; return _openPopupTabForSession;`
  )(
    {
      tabs: {
        create: async (options) => ({ id: 88, index: 4, windowId: 7, url: options.url }),
        get: async () => ({ id: 88, index: 4, windowId: 7 }),
        remove: async (tabId) => removed.push(tabId),
      },
    },
    () => {},
    () => {},
    async () => { ownershipAdds += 1; },
    async () => { receiptIssues += 1; return "unexpected"; },
    (url) => new URL(url).origin,
    (url) => new URL(url).origin + new URL(url).pathname
  );

  await assert.rejects(
    openPopup(
      "session-a",
      { id: 41, windowId: 7 },
      "https://oauth.example.test/start?private=1"
    ),
    /did not preserve the direct OAuth opener/
  );
  assert.deepEqual(removed, [88], "only the exact just-created unusable popup may be removed");
  assert.equal(ownershipAdds, 0, "an unlinked tab must never gain session ownership");
  assert.equal(receiptIssues, 0, "an unlinked tab must never receive a receipt");
});

test("worker keeps the captured URL internal and never retries the click", () => {
  const command = extract(background, 'case "click_open_popup":', "\n    // --- Click + Read");
  const capture = browserFunction(
    "_popupClickFrameAction",
    "\nasync function execInExactMatchingFrameMainOnce("
  );
  const exact = extract(
    background,
    "async function execInExactMatchingFrameMainOnce(",
    "\nfunction _isFrameMiss("
  );

  assert.match(command, /_openPopupTabForSession\(sessionId, targetTab, captured\.popupUrl\)/);
  assert.doesNotMatch(command, /return captured/);
  assert.doesNotMatch(command, /console\./);
  assert.equal((capture.match(/\.dispatchEvent\(event\)/g) || []).length, 1);
  assert.doesNotMatch(capture, /element\.click\(/);
  assert.match(capture, /Object\.defineProperty\(window, "open"/);
  assert.match(capture, /Object\.defineProperty\(window, "open", originalDescriptor\)/);
  assert.equal((exact.match(/browser\.scripting\.executeScript/g) || []).length, 1);
  assert.match(exact, /world: "MAIN"/);
  assert.match(exact, /refusing automatic retry/);

  const openPopup = extract(
    background,
    "async function _openPopupTabForSession(",
    "\nasync function _closeTabForSession("
  );
  assert.match(openPopup, /openerTabId: sourceTabId/);
  assert.match(openPopup, /Number\(linkedPopup\.openerTabId\) !== sourceTabId/);
  assert.doesNotMatch(openPopup, /tabs\.query|Date\.now/);
});
