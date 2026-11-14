// Injected-JS source for the detailed network capture (safari_start_network_capture and
// safari_network_details). Like injected-validators.js, these strings run in the page via
// `do JavaScript` and are imported by the test suite, so the code that ships is the code
// under test. Rules for the injected source: synchronous IIFE, no `//` comments and no
// backslashes (runJS flattens it to one line and escapes it for AppleScript), semicolons
// everywhere.
//
// A page can only observe the requests its own JavaScript makes. This records fetch, XHR,
// WebSocket and sendBeacon from the moment it is installed until the page navigates. The
// document itself, images, stylesheets, redirects, preflights and cookie headers stay out of
// reach from page JS: safari_network lists those from the Performance API, without headers.

import { escJsSingleQuote } from "./injected-escape.js";

export const NETWORK_CAPTURE_SCRIPT = `(function(){
  if (window.__mcp_network_v === 2) return 'Network capture already running (fetch, XHR, WebSocket, sendBeacon)';
  window.__mcp_network_v = 2;
  if (!window.__mcp_network) window.__mcp_network = [];
  var BODY_CAP = 20000, FRAME_CAP = 2000, MAX_FRAMES = 100, MAX_ENTRIES = 5000, KEEP_BODIES = 200;
  var seq = 0;

  function push(e){
    e.id = ++seq;
    var list = window.__mcp_network;
    list.push(e);
    if (list.length > MAX_ENTRIES) list.shift();
    var old = list[list.length - 1 - KEEP_BODIES];
    if (old && old.type !== 'websocket' && (old.requestBody !== undefined || old.responseBody !== undefined)) {
      delete old.requestBody;
      delete old.responseBody;
      old.bodiesDropped = true;
    }
    return e;
  }
  function cap(s, n){ s = String(s); return s.length > n ? s.slice(0, n) : s; }
  function describeBody(b){
    if (b === undefined || b === null) return undefined;
    if (typeof b === 'string') return b;
    if (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) return b.toString();
    if (typeof FormData !== 'undefined' && b instanceof FormData) {
      var keys = [];
      b.forEach(function(v, k){ keys.push(k); });
      return '[FormData: ' + keys.join(', ') + ']';
    }
    if (typeof Blob !== 'undefined' && b instanceof Blob) return '[Blob ' + b.size + ' bytes' + (b.type ? ' ' + b.type : '') + ']';
    if (b.byteLength !== undefined) return '[binary ' + b.byteLength + ' bytes]';
    return '[' + ((b.constructor && b.constructor.name) || 'body') + ']';
  }
  function setBody(e, key, sizeKey, text){
    if (text === undefined || text === null) return;
    text = String(text);
    e[sizeKey] = text.length;
    e[key] = cap(text, BODY_CAP);
    if (text.length > BODY_CAP) e.bodyTruncated = true;
  }
  function headersToObject(h){
    var out = {};
    if (!h) return out;
    if (Array.isArray(h)) { h.forEach(function(p){ out[p[0]] = p[1]; }); return out; }
    if (typeof h.forEach === 'function') { h.forEach(function(v, k){ out[k] = v; }); return out; }
    Object.keys(h).forEach(function(k){ out[k] = h[k]; });
    return out;
  }
  function parseRawHeaders(raw){
    var out = {};
    String(raw || '').split(String.fromCharCode(10)).forEach(function(line){
      var i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return out;
  }
  function isText(ct){
    ct = String(ct || '').toLowerCase();
    return ct.indexOf('event-stream') === -1 && /json|text|xml|javascript|urlencoded|graphql/.test(ct);
  }
  function readBody(resp, e){
    var ct = resp.headers && resp.headers.get ? resp.headers.get('content-type') : '';
    if (!isText(ct)) return;
    var clone = resp.clone();
    if (clone.body && clone.body.getReader && typeof TextDecoder !== 'undefined') {
      var reader = clone.body.getReader(), dec = new TextDecoder(), text = '', size = 0;
      var pump = function(){
        reader.read().then(function(r){
          if (r.done) { e.responseBody = text; e.responseSize = size; return; }
          size += r.value.byteLength;
          text += dec.decode(r.value, { stream: true });
          if (text.length > BODY_CAP) {
            e.responseBody = text.slice(0, BODY_CAP);
            e.bodyTruncated = true;
            e.responseSize = Number(resp.headers.get('content-length')) || size;
            reader.cancel();
            return;
          }
          pump();
        }, function(){});
      };
      pump();
    } else {
      clone.text().then(function(t){ setBody(e, 'responseBody', 'responseSize', t); }, function(){});
    }
  }

  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function(input, init){
      var start = Date.now();
      var isReq = typeof Request !== 'undefined' && input instanceof Request;
      var opts = init || {};
      var e = {
        type: 'fetch',
        url: isReq ? input.url : String(input),
        method: opts.method || (isReq ? input.method : 'GET'),
        time: new Date().toISOString(),
        requestHeaders: headersToObject(opts.headers || (isReq ? input.headers : null))
      };
      try { setBody(e, 'requestBody', 'requestBodySize', describeBody(opts.body)); } catch (err) {}
      return origFetch.apply(this, arguments).then(function(resp){
        e.status = resp.status;
        e.statusText = resp.statusText;
        e.duration = Date.now() - start;
        e.headers = headersToObject(resp.headers);
        push(e);
        try { readBody(resp, e); } catch (err) {}
        return resp;
      }, function(err){
        e.error = (err && err.message) || String(err);
        e.duration = Date.now() - start;
        push(e);
        throw err;
      });
    };
  }

  var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XP) {
    var origOpen = XP.open, origSetHeader = XP.setRequestHeader, origSend = XP.send;
    XP.open = function(method, url){
      this.__mcp = { type: 'xhr', url: String(url), method: method, requestHeaders: {} };
      return origOpen.apply(this, arguments);
    };
    XP.setRequestHeader = function(name, value){
      if (this.__mcp) this.__mcp.requestHeaders[name] = value;
      return origSetHeader.apply(this, arguments);
    };
    XP.send = function(body){
      var xhr = this, e = xhr.__mcp;
      if (e && !e.time) {
        var start = Date.now();
        e.time = new Date().toISOString();
        try { setBody(e, 'requestBody', 'requestBodySize', describeBody(body)); } catch (err) {}
        var fail = function(message){
          return function(){
            if (xhr.__mcp !== e) return;
            e.error = message;
            e.duration = Date.now() - start;
            push(e);
          };
        };
        xhr.addEventListener('load', function(){
          if (xhr.__mcp !== e) return;
          e.status = xhr.status;
          e.statusText = xhr.statusText;
          e.duration = Date.now() - start;
          try { e.headers = parseRawHeaders(xhr.getAllResponseHeaders()); } catch (err) {}
          try {
            var rt = xhr.responseType;
            if (rt === '' || rt === 'text') setBody(e, 'responseBody', 'responseSize', xhr.responseText);
            else if (rt === 'json') setBody(e, 'responseBody', 'responseSize', JSON.stringify(xhr.response));
            else if (xhr.response && xhr.response.byteLength !== undefined) e.responseSize = xhr.response.byteLength;
            else if (xhr.response && xhr.response.size !== undefined) e.responseSize = xhr.response.size;
          } catch (err) {}
          push(e);
        });
        xhr.addEventListener('error', fail('Network error'));
        xhr.addEventListener('timeout', fail('Timeout'));
        xhr.addEventListener('abort', fail('Aborted'));
      }
      return origSend.apply(this, arguments);
    };
  }

  var OrigWS = window.WebSocket;
  if (typeof OrigWS === 'function') {
    var WS = function(url, protocols){
      var ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
      var start = Date.now();
      var e = push({ type: 'websocket', url: String(url), method: 'GET', time: new Date().toISOString(), frames: [], frameCount: 0 });
      var frame = function(dir, data){
        var f = { dir: dir, time: new Date().toISOString() };
        if (typeof data === 'string') { f.size = data.length; f.data = cap(data, FRAME_CAP); }
        else { f.size = (data && (data.byteLength !== undefined ? data.byteLength : data.size)) || 0; f.binary = true; }
        e.frameCount++;
        e.frames.push(f);
        if (e.frames.length > MAX_FRAMES) e.frames.shift();
      };
      var origWsSend = ws.send;
      ws.send = function(data){
        try { frame('sent', data); } catch (err) {}
        return origWsSend.apply(ws, arguments);
      };
      ws.addEventListener('open', function(){ e.status = 101; e.duration = Date.now() - start; });
      ws.addEventListener('message', function(ev){ try { frame('received', ev.data); } catch (err) {} });
      ws.addEventListener('close', function(ev){ e.closeCode = ev.code; if (ev.reason) e.closeReason = ev.reason; });
      ws.addEventListener('error', function(){ e.error = 'WebSocket error'; });
      return ws;
    };
    WS.prototype = OrigWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function(k){ WS[k] = OrigWS[k]; });
    window.WebSocket = WS;
  }

  if (window.navigator && typeof window.navigator.sendBeacon === 'function') {
    var nav = window.navigator, origBeacon = nav.sendBeacon;
    nav.sendBeacon = function(url, data){
      var e = { type: 'beacon', url: String(url), method: 'POST', time: new Date().toISOString() };
      try { setBody(e, 'requestBody', 'requestBodySize', describeBody(data)); } catch (err) {}
      var queued = origBeacon.apply(nav, arguments);
      e.queued = queued;
      push(e);
      return queued;
    };
  }

  return 'Network capture started (fetch, XHR, WebSocket, sendBeacon)';
})()`;

// Builds the read-back expression. The list leaves bodies and WebSocket frames out, so fifty
// requests stay readable; `bodies: true` keeps them, and `id` returns one request in full.
/** @param {{ limit?: number | string, filter?: string, id?: number | string | null, bodies?: boolean }} [args] */
export function networkDetailsScript({ limit = 50, filter, id, bodies } = {}) {
  if (id !== undefined && id !== null && id !== "") {
    const want = Number(id);
    if (!Number.isInteger(want)) throw new Error(`id must be an integer, got ${JSON.stringify(id)}`);
    return `(function(){var l=window.__mcp_network||[];for(var i=0;i<l.length;i++){if(l[i].id===${want})return JSON.stringify(l[i]);}return JSON.stringify({error:'No captured request with id ${want}'});})()`;
  }
  const n = Math.max(1, Math.min(Math.floor(Number(limit)) || 50, 5000));
  const filterStr = filter ? `.filter(function(r){return String(r.url).indexOf('${escJsSingleQuote(filter)}')!==-1;})` : "";
  const slimStr = bodies
    ? ""
    : `.map(function(r){var o={};for(var k in r){if(k!=='requestBody'&&k!=='responseBody'&&k!=='frames')o[k]=r[k];}return o;})`;
  return `JSON.stringify((window.__mcp_network||[])${filterStr}.slice(-${n})${slimStr})`;
}
