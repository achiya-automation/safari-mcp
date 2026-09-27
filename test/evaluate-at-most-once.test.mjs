#!/usr/bin/env node
/**
 * One safari_evaluate must start the caller's script at most once.
 *
 * The extension bounded each executeScript at 3s — a bound on the whole run, not on the
 * injection starting — and on expiry started the same script again: in the ISOLATED world,
 * then through the content bridge, whose own 4s fallback started it once more. A script
 * that merely ran longer than 3s ran up to four times, and every POST in it repeated:
 * Times of Israel on 2026-09-22 (two live duplicate posts) and 2026-09-27 (four identical
 * drafts from one safari_eval_file call).
 *
 * These tests run the real evaluate path of extension/background.js with the real
 * content.js and command-content.js against a fake page: two JS worlds with their own
 * globals — MAIN (the page's) and ISOLATED (the content scripts') — sharing one DOM, the
 * way Safari runs them. Each script records its side effect; the count must end at one,
 * including on a page whose injected evaluate never answers — business.facebook.com in
 * 2026-08 — where the content bridge is the only way a result comes back.
 *
 * Run:  node --test test/evaluate-at-most-once.test.mjs
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const extensionFile = (name) => readFileSync(new URL(`../extension/${name}`, import.meta.url), "utf8");
const background = extensionFile("background.js");
const CONTENT = extensionFile("content.js");
const COMMAND_CONTENT = extensionFile("command-content.js");
const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every top-level function and one-line const of background.js, by name. */
const TOP_LEVEL = new Map();
for (const m of background.matchAll(/^(?:async )?function (\w+)\(|^const (\w+) = /gm)) {
  const name = m[1] || m[2];
  if (TOP_LEVEL.has(name)) continue;
  const end = m[1] ? background.indexOf("\n}\n", m.index) + 2 : background.indexOf("\n", m.index);
  TOP_LEVEL.set(name, background.slice(m.index, end));
}

/** The definitions `source` needs, transitively — whatever the evaluate path is built from. */
function dependencies(source, provided) {
  const seen = new Set(provided);
  const out = [];
  const scan = (src) => {
    for (const [name, definition] of TOP_LEVEL) {
      if (seen.has(name) || !new RegExp(`\\b${name}\\b`).test(src)) continue;
      seen.add(name);
      out.push(definition);
      scan(definition);
    }
  };
  scan(source);
  return out.join("\n");
}

/** The extension's real "evaluate" command, run against `browser`. */
function extensionEvaluate(browser) {
  const start = background.indexOf('    case "evaluate": {');
  const end = background.indexOf("    // --- Screenshot ---", start);
  assert.ok(start >= 0 && end > start, "the evaluate command case should exist");
  const evaluateCase = background.slice(start, end);
  const provided = ["getActiveTab", "resolveFrameId"];
  const handle = new Function(
    "browser", ...provided,
    `${dependencies(evaluateCase, provided)}
    return async (tabId, targetTab, payload) => { switch ("evaluate") {\n${evaluateCase}\n} };`
  )(browser, async () => ({ id: 1 }), async () => 0);
  return (script) => handle(1, { id: 1, url: "https://page.test/compose" }, { script });
}

/**
 * A page as the extension sees it. `effects` records each side effect a script performs,
 * tagged with the world it ran in.
 *
 * injection — what scripting.executeScript does on this page:
 *   "answers"  runs the function and delivers its result (an ordinary page)
 *   "never"    never runs it and never answers (an injection that never starts)
 *   "void"     runs it and never delivers the answer (business.facebook.com, 2026-08)
 * mainBridge — content.js runs in MAIN (the manifest leaves it out of LinkedIn, X, Google apps)
 * evalRefused — the page's CSP refuses eval; an inline <script> still runs, as it does through
 *   the Trusted Types policy content.js registers at document_start
 * nonce — the page's script-src is nonce-based: an inline <script> runs only with this nonce
 */
function fakePage({ injection = "answers", mainBridge = true, evalRefused = false, nonce = "" } = {}) {
  const effects = [];
  const bridgeMessages = [];
  const commandListeners = [];
  const messageListeners = [];
  const document = new EventTarget();

  const world = (name, globals) => {
    const w = vm.createContext({ Event, EventTarget, setTimeout, clearTimeout, crypto, console, ...globals });
    // Inside the context `window` is the context's own global, not the sandbox object.
    const self = vm.runInContext("globalThis", w);
    w.window = w;
    w.document = document;
    w.__post = (what) => effects.push(`${name}:${what}`);
    // window.postMessage reaches every world's listeners, each seeing its own window as source.
    w.addEventListener = (type, fn) => { if (type === "message") messageListeners.push({ self, fn }); };
    w.removeEventListener = (type, fn) => {
      const i = messageListeners.findIndex((l) => l.self === self && l.fn === fn);
      if (i >= 0) messageListeners.splice(i, 1);
    };
    w.postMessage = (data) => {
      const sent = structuredClone(data);
      setTimeout(() => {
        for (const l of [...messageListeners]) l.fn({ source: l.self, data: structuredClone(sent) });
      }, 0);
    };
    if (evalRefused) {
      w.eval = () => {
        throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script");
      };
    }
    return w;
  };
  const worlds = {
    MAIN: world("MAIN", { Element: class { attachShadow() { return {}; } } }),
    ISOLATED: world("ISOLATED", {
      browser: {
        runtime: {
          onMessage: { addListener: (listener) => commandListeners.push(listener), removeListener() {} },
          connect: () => ({ postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} } }),
          sendMessage: async () => {},
        },
        storage: {
          local: { get: async () => ({ mcpEnabled: false }), set: async () => {} },
          onChanged: { addListener() {}, removeListener() {} },
        },
      },
    }),
  };
  // An inline <script> runs in the page's own world, whichever world appends it — on a
  // nonce-based page only when it carries the page's nonce.
  document.createElement = () => ({ textContent: "", nonce: "", remove() {} });
  document.querySelector = (selector) => (nonce && selector === "script[nonce]" ? { nonce } : null);
  // A script that does not parse runs nothing; the browser reports it to onerror, not to appendChild.
  document.documentElement = {
    appendChild: (s) => {
      if (nonce && s.nonce !== nonce) return;
      try { vm.runInContext(String(s.textContent), worlds.MAIN); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
    },
  };
  if (mainBridge) vm.runInContext(CONTENT, worlds.MAIN);
  vm.runInContext(COMMAND_CONTENT, worlds.ISOLATED);

  const injections = [];
  const browser = {
    scripting: {
      executeScript({ world: name, func, args = [] }) {
        injections.push(name);
        const injection = page.injection;
        if (injection === "never") return new Promise(() => {});
        const running = Promise.resolve(vm.runInContext(`(${func})`, worlds[name])(...args));
        if (injection === "void") {
          running.catch(() => {});
          return new Promise(() => {});
        }
        return running.then((result) => [{ result: structuredClone(result) }]);
      },
    },
    tabs: {
      sendMessage(_tabId, message) {
        bridgeMessages.push(message.type);
        return new Promise((resolve, reject) => {
          if (!commandListeners.length) {
            reject(new Error("Could not establish connection. Receiving end does not exist."));
            return;
          }
          let answered = false;
          let later = false;
          for (const listener of commandListeners) {
            const keep = listener(structuredClone(message), {}, (response) => {
              if (answered) return;
              answered = true;
              resolve(structuredClone(response));
            });
            if (keep === true) later = true;
          }
          if (!later && !answered) resolve(undefined);
        });
      },
      query: async () => [{ id: 1 }],
    },
  };
  const page = {
    effects, injections, bridgeMessages, injection,
    evaluate: extensionEvaluate(browser),
    // The tab's content scripts are gone, as in a tab that predates the extension.
    dropBridge: () => { commandListeners.length = 0; },
  };
  return page;
}

/** Records its side effect, then takes 5s to finish — like saving a draft. */
const slowScript = (what) =>
  `(async () => { __post(${JSON.stringify(what)}); await new Promise((r) => setTimeout(r, 5000)); return "saved"; })()`;

// Longer than every fallback timer of the old ladder and the new one, so a late second
// start would have happened by the time the count is checked.
const settle = () => sleep(3000);

describe("an evaluate starts its script at most once", { concurrency: true }, () => {
  test("a script that runs 5s on an ordinary page starts once, and does not file the page as blocked", async () => {
    const page = fakePage();
    assert.equal(await page.evaluate(slowScript("draft")), "saved");
    await settle();
    assert.deepEqual(page.effects, ["MAIN:draft"], "the draft was saved more than once");

    // A slow script is not an injection that stalls: the next evaluate must still inject.
    const injected = page.injections.length;
    assert.equal(await page.evaluate('__post("next"); "ok"'), "ok");
    assert.equal(page.injections.length, injected + 1, "the page was filed as injection-blocked");
    assert.deepEqual(page.effects, ["MAIN:draft", "MAIN:next"]);
  });

  test("a page whose injection never starts: the bridge starts the script once, and the next call goes bridge-first", async () => {
    const page = fakePage({ injection: "never" });
    assert.equal(await page.evaluate(slowScript("draft")), "saved");
    await settle();
    assert.deepEqual(page.effects, ["MAIN:draft"]);

    const injected = page.injections.length;
    assert.equal(await page.evaluate('__post("next"); "ok"'), "ok");
    assert.equal(page.injections.length, injected, "a page known to stall injection goes straight to the bridge");
    assert.deepEqual(page.effects, ["MAIN:draft", "MAIN:next"]);
  });

  test("a page whose injection runs but never answers (business.facebook.com, 2026-08): the bridge joins that run", async () => {
    const page = fakePage({ injection: "void" });
    assert.equal(await page.evaluate(slowScript("draft")), "saved");
    await settle();
    assert.deepEqual(page.effects, ["MAIN:draft"]);
  });

  test("a page filed as blocked whose tab has no bridge falls back to injection — and the script still runs once", async () => {
    const page = fakePage({ injection: "never" });
    assert.equal(await page.evaluate('__post("first"); "ok"'), "ok"); // files the page as blocked
    page.dropBridge();
    page.injection = "answers";
    assert.equal(await page.evaluate('__post("second"); "ok"'), "ok");
    assert.deepEqual(page.effects, ["MAIN:first", "MAIN:second"]);
    assert.ok(page.bridgeMessages.includes("mcp-content-ping"), "bridge-first asks whether a bridge listens before using it");
  });

  test("a page without content.js in MAIN (LinkedIn, X, Google apps): a slow script still starts once", async () => {
    const page = fakePage({ mainBridge: false });
    assert.equal(await page.evaluate(slowScript("draft")), "saved");
    await settle();
    assert.deepEqual(page.effects, ["MAIN:draft"]);
  });

  test("a page without content.js in MAIN whose injection never starts: the ISOLATED fallback runs the script once", async () => {
    const page = fakePage({ mainBridge: false, injection: "never" });
    assert.equal(await page.evaluate('__post("draft"); "saved"'), "saved");
    assert.deepEqual(page.effects, ["ISOLATED:draft"]);
  });

  test("a quick script is answered by the injection alone", async () => {
    const page = fakePage();
    assert.equal(await page.evaluate('__post("read"); 6 * 7'), "42");
    assert.deepEqual(page.effects, ["MAIN:read"]);
    assert.deepEqual(page.bridgeMessages, [], "no bridge traffic for a script that answers in time");
  });

  test("a script that throws after its side effect is reported, not started again by another strategy", async () => {
    const page = fakePage();
    const result = await page.evaluate(
      `__post("draft"); throw new Error("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source")`
    );
    assert.match(result, /^Error: Refused to evaluate/);
    await settle();
    assert.deepEqual(page.effects, ["MAIN:draft"]);
  });

  test("a page whose CSP refuses eval runs the script once, through an inline script", async () => {
    const page = fakePage({ evalRefused: true });
    // A statement list: the expression form does not parse (nothing runs), the body form does.
    assert.equal(await page.evaluate('__post("draft"); return "saved"'), "saved");
    // An expression answers with its value, as through eval.
    assert.equal(await page.evaluate('(__post("title"), "Meta Business Suite");'), "Meta Business Suite");
    assert.deepEqual(page.effects, ["MAIN:draft", "MAIN:title"]);
  });

  test("facebook.com (no 'unsafe-eval', nonce-based script-src): the inline script carries the page's nonce", async () => {
    const page = fakePage({ evalRefused: true, nonce: "n0nce" });
    assert.equal(await page.evaluate('(async () => { __post("draft"); return "saved"; })()'), "saved");
    assert.deepEqual(page.effects, ["MAIN:draft"]);
  });
});

test("safari_eval_file takes a receipt and hands it on, like safari_evaluate", () => {
  const tool = index.slice(index.indexOf('"safari_eval_file"'), index.indexOf("// ========== ELEMENT INFO =========="));
  assert.match(tool, /receipt: z\.string\(\)\.optional\(\)/);
  assert.match(tool, /\{ script, \.\.\._explicitReceipt\(args\) \}/);
});

test("AppleScript never re-runs an evaluate the extension may have started", () => {
  const start = index.indexOf("async function extensionOrFallback");
  const fallback = index.slice(start, index.indexOf("\nasync function ", start + 1));
  assert.match(
    fallback,
    /extensionType === "evaluate" && err\?\.dispatched !== false && !\/evaluate did not start\/\.test\(err\.message\)/
  );
  // A result that merely mentions CSP is the script's own error once it ran; only the
  // extension's own "nothing ran" marker may send an evaluate on to AppleScript.
  assert.match(fallback, /const isCspError = hardCspBlock \|\| \(extensionType !== "evaluate" && /);
  assert.match(background, /CSP blocked all strategies - the script did not run/);
  // Only a command that never left the queue, or never had an extension to go to, is safe
  // to run elsewhere.
  assert.match(index, /new Error\("Extension not connected"\), \{ dispatched: false \}/);
  assert.match(index, /new Error\(`Extension timeout after \$\{timeoutMs\}ms`\), \{ dispatched: qi < 0 \}/);
  assert.match(index, /\{ dispatched: !queued\.has\(id\) \}/);
});
