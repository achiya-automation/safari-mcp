#!/usr/bin/env node
/**
 * Behavioural tests for the detailed network capture, run under jsdom against the SHIPPED
 * injected source (injected-network.js), flattened the way runJS flattens it before it reaches
 * `do JavaScript`. jsdom has no fetch and its XHR and WebSocket talk to the real network, so
 * each test installs a fake of the API it exercises before the capture script wraps it.
 *
 * Run:  node --test test/network-capture.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { NETWORK_CAPTURE_SCRIPT, networkDetailsScript } from "../injected-network.js";

// What runJS does to a script before AppleScript sees it, minus the AppleScript escaping.
const flatten = (js) => js.replace(/^\s*\/\/[^\n]*$/gm, "").replace(/\n/g, " ");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** @param {{ fetchImpl?: (...args: any[]) => Promise<Response> }} [opts] */
function makePage({ fetchImpl } = {}) {
  const { window } = new JSDOM("<!doctype html><body></body>", { url: "https://app.example/", runScripts: "outside-only" });
  Object.assign(window, { Request, Response, Headers, TextDecoder });
  if (fetchImpl) window.fetch = fetchImpl;

  class FakeXHR {
    constructor() { this.listeners = {}; this.responseType = ""; this.sent = []; this._text = ""; }
    open() {}
    setRequestHeader() {}
    send(body) { this.sent.push(body); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    getAllResponseHeaders() { return "Content-Type: application/json\r\nX-Request-Id: 7\r\n"; }
    get responseText() {
      if (this.responseType !== "" && this.responseType !== "text") throw new Error("InvalidStateError");
      return this._text;
    }
    finish(type, fields = {}) { Object.assign(this, fields); for (const fn of this.listeners[type] || []) fn.call(this); }
  }
  window.XMLHttpRequest = FakeXHR;

  class FakeWS extends window.EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.sent = []; }
    send(data) { this.sent.push(data); }
    emit(type, fields = {}) { /** @type {any} */ (this).dispatchEvent(Object.assign(new window.Event(type), fields)); }
  }
  window.WebSocket = FakeWS;

  const beacons = [];
  Object.defineProperty(window.navigator, "sendBeacon", { configurable: true, writable: true, value: (url, data) => { beacons.push([url, data]); return true; } });

  const start = () => window.eval(flatten(NETWORK_CAPTURE_SCRIPT));
  const details = (args) => JSON.parse(window.eval(flatten(networkDetailsScript(args))));
  return { window, start, details, beacons, FakeXHR, FakeWS };
}

test("the injected source survives runJS: no comments, backslashes or backticks, and it parses flattened", () => {
  assert.ok(!/^\s*\/\//m.test(NETWORK_CAPTURE_SCRIPT), "a // comment line would be stripped by runJS");
  assert.ok(!NETWORK_CAPTURE_SCRIPT.includes("\\"), "a backslash would be doubled for AppleScript");
  assert.ok(!NETWORK_CAPTURE_SCRIPT.includes("`"));
  assert.doesNotThrow(() => new Function(`return ${flatten(NETWORK_CAPTURE_SCRIPT)}`));
});

test("fetch: request and response headers and bodies are captured, and the list leaves bodies out", async () => {
  const page = makePage({
    fetchImpl: async () => new Response('{"ok":true}', { status: 201, statusText: "Created", headers: { "Content-Type": "application/json", "X-Trace": "abc" } }),
  });
  assert.match(page.start(), /started/);
  const resp = await page.window.fetch("https://api.example/items", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: '{"name":"a"}',
  });
  assert.equal(await resp.text(), '{"ok":true}', "the page still reads the body the capture cloned");
  await tick();

  const [row] = page.details();
  assert.equal(row.id, 1);
  assert.equal(row.type, "fetch");
  assert.equal(row.url, "https://api.example/items");
  assert.equal(row.method, "POST");
  assert.equal(row.status, 201);
  assert.equal(row.requestHeaders.Authorization, "Bearer t");
  assert.equal(row.headers["x-trace"], "abc");
  assert.equal(row.requestBodySize, 12);
  assert.equal(row.responseSize, 11);
  assert.ok(!("requestBody" in row) && !("responseBody" in row), "the list carries sizes, not bodies");

  const full = page.details({ id: 1 });
  assert.equal(full.requestBody, '{"name":"a"}');
  assert.equal(full.responseBody, '{"ok":true}');
  assert.equal(page.details({ bodies: true })[0].responseBody, '{"ok":true}');
  assert.deepEqual(page.details({ id: 99 }), { error: "No captured request with id 99" });
});

test("fetch: a URL object, a Request, a binary response and a failure are all recorded", async () => {
  let fail = false;
  const page = makePage({
    fetchImpl: async () => {
      if (fail) throw new TypeError("Load failed");
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
    },
  });
  page.start();
  await page.window.fetch(new URL("https://api.example/a.png"));
  await page.window.fetch(new Request("https://api.example/b", { method: "PUT", headers: { "X-A": "1" } }));
  fail = true;
  await assert.rejects(page.window.fetch("https://api.example/down"), /Load failed/);
  await tick();

  const [a, b, c] = page.details({ bodies: true });
  assert.equal(a.url, "https://api.example/a.png");
  assert.ok(!("responseBody" in a), "a binary body is not read");
  assert.equal(b.method, "PUT");
  assert.equal(b.requestHeaders["x-a"], "1");
  assert.equal(c.error, "Load failed");
  assert.equal(c.status, undefined);
});

test("fetch: a body over the cap is cut and flagged, and the size still says how big it was", async () => {
  const big = "x".repeat(50000);
  const page = makePage({ fetchImpl: async () => new Response(big, { headers: { "Content-Type": "text/plain", "Content-Length": "50000" } }) });
  page.start();
  await page.window.fetch("https://api.example/big");
  await tick(50);
  const full = page.details({ id: 1 });
  assert.equal(full.responseBody.length, 20000);
  assert.equal(full.bodyTruncated, true);
  assert.equal(full.responseSize, 50000);
});

test("xhr: headers and bodies are captured, and a json responseType no longer drops the request", () => {
  const page = makePage();
  page.start();
  const text = new page.window.XMLHttpRequest();
  text.open("POST", "https://api.example/x");
  text.setRequestHeader("X-Csrf", "tok");
  text.send("a=1");
  text.finish("load", { status: 200, statusText: "OK", _text: "hello" });

  const json = new page.window.XMLHttpRequest();
  json.open("GET", "https://api.example/j");
  json.responseType = "json";
  json.send();
  json.finish("load", { status: 200, statusText: "OK", response: { n: 1 } });

  const failed = new page.window.XMLHttpRequest();
  failed.open("GET", "https://api.example/f");
  failed.send();
  failed.finish("error");

  const rows = page.details({ bodies: true });
  assert.deepEqual(rows.map((r) => r.url), ["https://api.example/x", "https://api.example/j", "https://api.example/f"]);
  assert.deepEqual(text.sent, ["a=1"], "the real send still runs");
  assert.equal(rows[0].requestHeaders["X-Csrf"], "tok");
  assert.equal(rows[0].requestBody, "a=1");
  assert.equal(rows[0].responseBody, "hello");
  assert.equal(rows[0].headers["x-request-id"], "7");
  assert.equal(rows[1].responseBody, '{"n":1}');
  assert.equal(rows[2].error, "Network error");
});

test("xhr: an object that is opened and sent again records one entry per request", () => {
  const page = makePage();
  page.start();
  const xhr = new page.window.XMLHttpRequest();
  xhr.open("GET", "https://api.example/1");
  xhr.send();
  xhr.finish("load", { status: 200, _text: "one" });
  xhr.open("GET", "https://api.example/2");
  xhr.send();
  xhr.finish("load", { status: 200, _text: "two" });
  assert.deepEqual(page.details().map((r) => r.url), ["https://api.example/1", "https://api.example/2"]);
});

test("websocket: frames in both directions are recorded and the page's socket still behaves", () => {
  const page = makePage();
  page.start();
  const ws = new page.window.WebSocket("wss://live.example/feed", ["v1"]);
  assert.ok(ws instanceof page.window.WebSocket, "instanceof still holds through the wrapper");
  assert.equal(page.window.WebSocket.OPEN, 1);
  assert.deepEqual(ws.protocols, ["v1"]);
  ws.emit("open");
  ws.send("ping");
  ws.send(new Uint8Array(8));
  ws.emit("message", { data: "pong" });
  ws.emit("close", { code: 1000, reason: "done" });
  assert.equal(ws.sent.length, 2, "the real send still runs");

  const [row] = page.details();
  assert.equal(row.type, "websocket");
  assert.equal(row.status, 101);
  assert.equal(row.frameCount, 3);
  assert.equal(row.closeCode, 1000);
  assert.ok(!("frames" in row), "the list carries the frame count, not the frames");
  const { frames } = page.details({ id: row.id });
  assert.deepEqual(frames.map((f) => [f.dir, f.data ?? `binary:${f.size}`]), [["sent", "ping"], ["sent", "binary:8"], ["received", "pong"]]);
});

test("sendBeacon is recorded and still queued", () => {
  const page = makePage();
  page.start();
  assert.equal(page.window.navigator.sendBeacon("https://stats.example/b", "e=1"), true);
  assert.equal(page.beacons.length, 1);
  const [row] = page.details({ bodies: true });
  assert.equal(row.type, "beacon");
  assert.equal(row.requestBody, "e=1");
  assert.equal(row.queued, true);
});

test("starting twice does not wrap twice, and clearing keeps the capture running", async () => {
  const page = makePage({ fetchImpl: async () => new Response("ok", { headers: { "Content-Type": "text/plain" } }) });
  page.start();
  assert.match(page.start(), /already running/);
  await page.window.fetch("https://api.example/1");
  assert.equal(page.details().length, 1);
  page.window.eval("window.__mcp_network=[]");
  await page.window.fetch("https://api.example/2");
  const rows = page.details();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 2, "ids keep counting after a clear");
});

test("only the most recent requests keep their bodies", async () => {
  const page = makePage({ fetchImpl: async () => new Response("ok", { headers: { "Content-Type": "text/plain" } }) });
  page.start();
  for (let i = 0; i < 202; i++) await page.window.fetch("https://api.example/n", { method: "POST", body: "b" });
  await tick();
  const oldest = page.details({ id: 1 });
  assert.equal(oldest.bodiesDropped, true);
  assert.ok(!("requestBody" in oldest));
  assert.equal(oldest.requestBodySize, 1, "the size outlives the body");
  assert.equal(page.details({ id: 202 }).requestBody, "b");
});

test("networkDetailsScript: the filter is contained as a string, and limit and id are validated", () => {
  const page = makePage({ fetchImpl: async () => new Response("ok") });
  page.start();
  page.window.__PWNED = false;
  assert.deepEqual(page.details({ filter: "'); window.__PWNED = true; ('" }), []);
  assert.equal(page.window.__PWNED, false);
  assert.match(networkDetailsScript({ limit: "abc" }), /slice\(-50\)/);
  assert.match(networkDetailsScript({ limit: 1e9 }), /slice\(-5000\)/);
  assert.throws(() => networkDetailsScript({ id: "1; alert(1)" }), /integer/);
});
