#!/usr/bin/env node
/**
 * No tool hands back the value of a password, one-time-code or payment-card field. On
 * 23.11.2026 safari_snapshot of a sign-up form returned the password typed into it, and the
 * value landed in an agent's transcript. A field counts by its input type (password) or by an
 * autocomplete token (current-password, new-password, one-time-code, cc-*); its value is
 * reported as "[redacted N chars]".
 *
 * Runs the extension's page functions and the page scripts safari.js builds under jsdom on one
 * form with every kind of sensitive field, then the server's pass over the replies of an
 * extension built before its page functions masked anything (an installed app updates later
 * than the npm package).
 *
 * Run:  node --test test/sensitive-field-values.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { escJsSingleQuote } from "../injected-escape.js";

// Missing before the fix: every test below that needs it fails on its own.
const fields = await import("../sensitive-fields.js").catch(() => ({}));

const BACKGROUND = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const SAFARI = readFileSync(new URL("../safari.js", import.meta.url), "utf8");
const INDEX = readFileSync(new URL("../index.js", import.meta.url), "utf8");

// Every value here that ends in SECRET belongs to a sensitive field and must never come back.
// "typed-SECRET" is what the user typed into the password field (the property); the markup
// still carries "hunter2-SECRET" (the attribute).
const FORM = `
<form id="signup" action="/signup" method="post">
  <label>Email <input id="email" name="email" type="email" value="visible@example.com"></label>
  <input id="pw" name="pw" type="password" value="hunter2-SECRET">
  <input id="pw-shown" type="text" autocomplete="current-password" value="shown-SECRET">
  <input id="newpw" autocomplete="new-password" value="newpw-SECRET">
  <input id="otp" inputmode="numeric" autocomplete="one-time-code" value="otp-SECRET">
  <input id="cc" autocomplete="cc-number" value="4111-SECRET">
  <input id="csc" autocomplete="billing cc-csc" value="csc-SECRET">
  <button type="submit">Sign up</button>
</form>`;

function page() {
  const dom = new JSDOM(`<!doctype html><body>${FORM}</body>`, {
    url: "http://127.0.0.1/signup", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const { window } = dom;
  // No layout in jsdom: give every element a box, or the snapshots skip it as invisible.
  window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 });
  window.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`) };
  window.document.getElementById("pw").value = "typed-SECRET";
  return window;
}

function assertMasked(out, label) {
  const text = typeof out === "string" ? out : JSON.stringify(out);
  for (const secret of text.match(/[\w@.-]*SECRET/g) || []) assert.fail(`${label} returned a sensitive value: ${secret}`);
  assert.match(text, /\[redacted \d+ chars\]/, `${label} should say a value is there`);
}

// ---------- the extension's page functions ----------

function between(source, startMark, endMark, from = 0) {
  const begin = source.indexOf(startMark, from);
  const end = source.indexOf(endMark, begin);
  assert.ok(begin >= from && end > begin, `${startMark} is where this test looks`);
  return source.slice(begin, end);
}
const caseAt = (name) => BACKGROUND.indexOf(`case "${name}": {`);

const EXT = {
  readPage: between(BACKGROUND, "(sel, maxLen) => {", "\n      };", caseAt("read_page")) + "\n}",
  snapshot: between(BACKGROUND, "(rootSelector, snapshotGen) => {", "}, [payload.selector || null", caseAt("snapshot")) + "}",
  getElement: between(BACKGROUND, "(selector) => {", "}, [payload.selector], tabId);", caseAt("get_element")) + "}",
  queryAll: between(BACKGROUND, "(selector, limit) => {", "\n      };", caseAt("query_all")) + "\n}",
};
const runExt = (name, ...args) => {
  const window = page();
  return window.eval(`(${EXT[name]})`)(...args);
};

test("extension safari_snapshot masks every sensitive field and keeps other values", () => {
  const out = runExt("snapshot", null, 0);
  assertMasked(out, "snapshot");
  assert.match(out, /value="\[redacted 12 chars\]"[^>]*type="password"/, "the typed password is masked by its own length");
  assert.match(out, /value="visible@example\.com"/);
});

test("extension safari_read_page with a selector masks a sensitive field", () => {
  assert.equal(runExt("readPage", "#pw", 50000), "[redacted 12 chars]");
  assert.equal(runExt("readPage", "#otp", 50000), "[redacted 10 chars]");
  assert.equal(runExt("readPage", "#email", 50000), "visible@example.com");
});

test("extension safari_get_element masks the value and the value attribute", () => {
  const pw = JSON.parse(runExt("getElement", "#pw"));
  assert.equal(pw.value, "[redacted 12 chars]");
  assert.equal(pw.attrs.value, "[redacted 14 chars]");
  assert.equal(pw.attrs.type, "password");
  assertMasked(runExt("getElement", "#csc"), "get_element #csc");
  assert.equal(JSON.parse(runExt("getElement", "#email")).value, "visible@example.com");
});

test("extension safari_query_all masks sensitive fields", () => {
  const out = runExt("queryAll", "input", 20);
  assertMasked(out, "query_all");
  assert.equal(JSON.parse(out).find((el) => el.id === "email").value, "visible@example.com");
});

// ---------- the page scripts safari.js builds (AppleScript path and direct tools) ----------

// A function as safari.js declares it, compiled with fakes for what it calls.
function safariFn(name, deps) {
  const at = SAFARI.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, `safari.js declares ${name}`);
  const src = SAFARI.slice(at + 1, SAFARI.indexOf("\n}\n", at) + 2).replace(/^export /, "");
  const all = { escJsSingleQuote, refSelector: (ref) => `[data-mcp-ref="${ref}"]`, ...fields, ...deps };
  return new Function(...Object.keys(all), `${src}\nreturn ${name};`)(...Object.values(all));
}

// Runs a page script the way runJS hands it to Safari: comment-only lines dropped, one line.
const runJSIn = (window) => async (js) =>
  window.eval(js.replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\n/g, " ").replace(/\r/g, "").replace(/\t/g, " "));

const runSafari = (name, args, deps = {}) => {
  const window = page();
  return safariFn(name, { runJS: runJSIn(window), ...deps })(args);
};

test("AppleScript safari_snapshot masks every sensitive field", async () => {
  const out = await runSafari("takeSnapshot", { _gen: 0 });
  assertMasked(out, "takeSnapshot");
  assert.match(out, /value="visible@example\.com"/);
});

test("AppleScript safari_read_page with a selector masks a sensitive field", async () => {
  assert.equal(await runSafari("readPage", { selector: "#pw" }), "[redacted 12 chars]");
  assert.equal(await runSafari("readPage", { selector: "#cc" }), "[redacted 11 chars]");
  assert.equal(await runSafari("readPage", { selector: "#email" }), "visible@example.com");
});

test("AppleScript safari_get_element and safari_query_all mask sensitive fields", async () => {
  const pw = JSON.parse(await runSafari("getElementInfo", { selector: "#pw" }));
  assert.equal(pw.value, "[redacted 12 chars]");
  assert.equal(pw.attrs.value, "[redacted 14 chars]");
  assertMasked(await runSafari("querySelectorAll", { selector: "input" }), "querySelectorAll");
});

test("safari_accessibility_snapshot and safari_detect_forms mask sensitive fields", async () => {
  const tree = await runSafari("getAccessibilityTree", { selector: "#signup", maxDepth: 5 });
  assertMasked(tree, "getAccessibilityTree");
  assert.match(tree, /visible@example\.com/);
  const forms = await runSafari("detectForms");
  assertMasked(forms, "detectForms");
  assert.match(forms, /visible@example\.com/);
});

test("safari_verify_state does not echo what a sensitive field holds", async () => {
  const out = JSON.parse(await runSafari("verifyState", { selector: "#pw", expected: "a-guess" }));
  assert.equal(out.match, false);
  assert.equal(out.actual, "[redacted 12 chars]");
});

test("safari_fill reports a sensitive field's value masked, also when the page kept its own", async () => {
  assert.equal(await runSafari("fill", { selector: "#newpw", value: "agent-pw" }), "Filled: [redacted 8 chars]");
  // A field whose page ignores the new value: the mismatch report carried what the field held.
  const window = page();
  Object.defineProperty(window.document.getElementById("otp"), "value", { get: () => "kept-SECRET", set() {} });
  const fill = safariFn("fill", {
    runJS: runJSIn(window),
    _nativeTypeViaClipboard: async () => { throw new Error("no clipboard in this test"); },
  });
  const out = await fill({ selector: "#otp", value: "123456" });
  assert.match(out, /^__FILL_VALUE_MISMATCH__:/);
  assertMasked(out, "fill mismatch");
});

test("the label of a native click on a sensitive field is masked", async () => {
  const window = page();
  const stamp = safariFn("_axStampJs", {});
  const out = JSON.parse(window.eval(stamp("document.getElementById('pw')", false)));
  assert.equal(out.text, "[redacted 12 chars]");
});

test("safari_get_source masks the value attribute of sensitive fields", async () => {
  const out = await runSafari("getPageSource", {});
  assertMasked(out, "getPageSource");
  assert.match(out, /value="visible@example\.com"/);
});

// ---------- the server's pass over extension replies ----------

// index.js's sendToExtension over a fake extension that answers like an app built before this fix:
// read_page gives a field's bare value, get_element what the field is.
function oldExtensionSend(answer, { thermal = false } = {}) {
  const calls = [];
  const send = new Function(
    "_THERMAL_FILE", "_THERMAL_FREE", "_thermalGate", "_sendToExtension", "redactFieldValues", "redactReadPage",
    `${between(INDEX, "function sendToExtension(", "\n}\n")}\n}\nreturn sendToExtension;`
  )(
    thermal ? "/tmp/heat.json" : "", new Set(), async () => {},
    async (type, payload) => { calls.push(`${type} ${payload.selector || ""}`.trim()); return answer(type, payload); },
    fields.redactFieldValues, fields.redactReadPage
  );
  return { send, calls };
}

test("every extension reply goes through the server's pass, also behind the thermal gate", async () => {
  for (const thermal of [false, true]) {
    const { send } = oldExtensionSend(() => '<input ref="0_3" id="pw" value="typed-SECRET" type="password"/>', { thermal });
    assert.equal(await send("snapshot", {}), '<input ref="0_3" id="pw" value="[redacted 12 chars]" type="password"/>');
  }
});

test("read_page with a selector from an older extension is masked by the field it read", async () => {
  const FIELDS = {
    "#pw": { tag: "INPUT", attrs: { id: "pw", type: "password" }, value: "typed-SECRET" },
    "#otp": { tag: "INPUT", attrs: { id: "otp", autocomplete: "one-time-code" }, value: "otp-SECRET" },
    "#card": { tag: "SELECT", attrs: { autocomplete: "cc-exp-month" }, value: "05-SECRET" },
    "#email": { tag: "INPUT", attrs: { id: "email", type: "email" }, value: "visible@example.com" },
    "article": { tag: "ARTICLE", attrs: {}, text: "Readable article text" },
  };
  const { send, calls } = oldExtensionSend((type, { selector }) => {
    if (!selector) return JSON.stringify({ title: "Sign up", text: "Email Password" });
    const el = FIELDS[selector];
    if (!el) return `Element not found: ${selector}`;
    return type === "read_page" ? el.value ?? el.text : JSON.stringify(el);
  });
  assert.equal(await send("read_page", { selector: "#pw" }), "[redacted 12 chars]");
  assert.equal(await send("read_page", { selector: "#otp" }), "[redacted 10 chars]");
  assert.equal(await send("read_page", { selector: "#card" }), "[redacted 9 chars]");
  assert.equal(await send("read_page", { selector: "#email" }), "visible@example.com");
  assert.equal(await send("read_page", { selector: "article" }), "Readable article text");
  assert.deepEqual(calls.splice(0), [
    "read_page #pw", "get_element #pw", "read_page #otp", "get_element #otp", "read_page #card", "get_element #card",
    "read_page #email", "get_element #email", "read_page article", "get_element article",
  ]);
  assert.equal(await send("read_page", { selector: "#gone" }), "Element not found: #gone");
  assert.equal(await send("read_page", {}), '{"title":"Sign up","text":"Email Password"}', "a whole-page read is not checked against a field");
  assert.deepEqual(calls.splice(0), ["read_page #gone", "read_page"], "only a value that was read asks what its field is");

  const unsure = oldExtensionSend((type) => {
    if (type === "read_page") return "maybe-SECRET";
    throw new Error("Extension timeout");
  });
  assert.equal(await unsure.send("read_page", { selector: "#x" }), "[redacted 12 chars]", "a field nobody could check counts as sensitive");
  const masked = oldExtensionSend(() => "[redacted 8 chars]");
  assert.equal(await masked.send("read_page", { selector: "#pw" }), "[redacted 8 chars]");
  assert.deepEqual(masked.calls, ["read_page #pw"], "an extension that masks by itself is not asked again");
});

test("snapshot from an older extension: a password value is masked, other values stay", () => {
  const { redactFieldValues } = fields;
  const old =
    '<form><input ref="0_2" id="email" value="visible@example.com" type="email"/>' +
    '<input ref="0_3" id="pw" value="say &quot;hi&quot; SECRET" type="password" placeholder="Password"/></form>';
  const out = redactFieldValues("snapshot", old);
  assert.equal(
    out,
    '<form><input ref="0_2" id="email" value="visible@example.com" type="email"/>' +
      '<input ref="0_3" id="pw" value="[redacted 15 chars]" type="password" placeholder="Password"/></form>'
  );
  assert.equal(redactFieldValues("snapshot", out), out, "a masked value is left as it is");
});

test("get_element and query_all from an older extension are masked by the field they describe", () => {
  const { redactFieldValues } = fields;
  const el = JSON.parse(redactFieldValues("get_element", JSON.stringify({
    tag: "INPUT", text: "", attrs: { id: "otp", autocomplete: "one-time-code", value: "otp-SECRET" }, value: "otp-SECRET",
  })));
  assert.equal(el.value, "[redacted 10 chars]");
  assert.equal(el.attrs.value, "[redacted 10 chars]");
  const all = JSON.parse(redactFieldValues("query_all", JSON.stringify([
    { index: 0, tag: "INPUT", type: "email", value: "visible@example.com" },
    { index: 1, tag: "INPUT", type: "password", value: "hunter2-SECRET" },
  ])));
  assert.equal(all[0].value, "visible@example.com");
  assert.equal(all[1].value, "[redacted 14 chars]");
  assert.equal(redactFieldValues("get_element", "Element not found: #x"), "Element not found: #x");
});

test("page source: attribute order, case, quotes, a > inside a value and a cut-off last tag", () => {
  const { redactFieldValues } = fields;
  const html =
    '<input TYPE="Password" value="a &gt; b&amp;SECRET" name="pw">' +
    '<input value="4111-SECRET" autocomplete="CC-NUMBER" data-value="kept">' +
    '<input type="text" value="visible">' +
    '<textarea autocomplete="one-time-code" value="otp-SECRET"></textarea>' +
    '<input type="text" value="cut-SECRET';
  const out = redactFieldValues("get_source", html);
  assertMasked(out, "page source");
  assert.match(out, /<input TYPE="Password" value="\[redacted 12 chars\]" name="pw">/);
  assert.equal(
    redactFieldValues("get_source", '<input placeholder="a type=" type="password" value="pw-SECRET">'),
    '<input placeholder="a type=" type="password" value="[redacted 9 chars]">',
    "a type= inside another attribute's value is not the field's type"
  );
  assert.match(out, /data-value="kept"/);
  assert.match(out, /<input type="text" value="visible">/);
  assert.equal(redactFieldValues("evaluate", 'value="x-SECRET" type="password"'), 'value="x-SECRET" type="password"', "only the commands that read fields are touched");
});
