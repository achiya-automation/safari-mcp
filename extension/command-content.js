// Isolated-world command bridge for DOM interactions.
//
// Safari sometimes turns an exception from a PAGE click listener into an opaque
// `JavaScript extension error` for browser.scripting.executeScript(), aborting the
// background command. A persistent content script shares the DOM and event path,
// while page-listener exceptions stay in the page console.

// Register on every execution. Safari can preserve the isolated-world globals while
// invalidating the old runtime listener during an extension update; a persistent
// boolean guard then falsely says the bridge is installed. sendContentCommand only
// reinjects this file after a message failure, so duplicate live listeners are rare
// and harmless (the first synchronous response wins).

// Safari may unload an MV3 service worker even while it owns an HTTP long-poll. A
// content script lives with the page, so use a narrow extension Port to generate a
// real worker event comfortably inside Safari's roughly 30-second idle window. The
// ping carries no page URL, DOM data, receipt, or other authority. If Safari drops the
// worker, onDisconnect retries quickly; the normal interval remains the bounded
// fallback if the extension was reloaded and this script's runtime became stale.
const _MCP_KEEPALIVE_PORT_NAME = "mcp-content-keepalive-v1";
const _MCP_KEEPALIVE_INTERVAL_MS = 10000;
const _MCP_KEEPALIVE_RECONNECT_MS = 1500;
let _mcpKeepalivePort = null;
let _mcpKeepaliveReconnectTimer = null;
let _mcpKeepaliveTickRunning = false;

function _scheduleMcpKeepaliveReconnect() {
  if (_mcpKeepaliveReconnectTimer) return;
  _mcpKeepaliveReconnectTimer = setTimeout(() => {
    _mcpKeepaliveReconnectTimer = null;
    _mcpKeepaliveTick();
  }, _MCP_KEEPALIVE_RECONNECT_MS);
}

function _openMcpKeepalivePort() {
  if (_mcpKeepalivePort) return _mcpKeepalivePort;
  try {
    const port = browser.runtime.connect({ name: _MCP_KEEPALIVE_PORT_NAME });
    _mcpKeepalivePort = port;
    port.onDisconnect.addListener(() => {
      if (_mcpKeepalivePort !== port) return;
      _mcpKeepalivePort = null;
      _scheduleMcpKeepaliveReconnect();
    });
    return port;
  } catch (_) {
    _scheduleMcpKeepaliveReconnect();
    return null;
  }
}

async function _mcpKeepaliveTick() {
  if (_mcpKeepaliveTickRunning) return;
  _mcpKeepaliveTickRunning = true;
  try {
    // Respect the popup's OFF state without waking the service worker merely to ask.
    const stored = await browser.storage.local.get("mcpEnabled").catch(() => null);
    if (!stored || stored.mcpEnabled === false) {
      if (_mcpKeepalivePort) {
        try { _mcpKeepalivePort.disconnect(); } catch (_) {}
        _mcpKeepalivePort = null;
      }
      return;
    }
    const port = _openMcpKeepalivePort();
    if (!port) return;
    try {
      port.postMessage({ type: "ping" });
    } catch (_) {
      if (_mcpKeepalivePort === port) _mcpKeepalivePort = null;
      _scheduleMcpKeepaliveReconnect();
    }
  } finally {
    _mcpKeepaliveTickRunning = false;
  }
}

_mcpKeepaliveTick();
setInterval(_mcpKeepaliveTick, _MCP_KEEPALIVE_INTERVAL_MS);

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;
  if (message.type === "mcp-content-click") {
    sendResponse(handleClick(message.payload || {}));
    return true;
  }
  if (message.type === "mcp-content-fill") {
    sendResponse(handleFill(message.payload || {}));
    return true;
  }
  // Last-resort path for evaluate. On hardened SPAs (business.facebook.com) BOTH
  // scripting.executeScript worlds hang forever instead of rejecting, while this
  // already-injected listener keeps answering — clicks kept working there the whole
  // time. Nothing is injected here, so there is no injection to stall on.
  if (message.type === "mcp-content-eval") {
    // The relayed function is often async (the evaluate handler awaits inside it), so
    // this must resolve before answering — returning the promise itself serialised to
    // "{}" and silently produced an empty result.
    handleEval(message.payload || {}).then(sendResponse);
    return true;
  }
  return false;
});

// We are in the ISOLATED world: we can talk to the background, but the PAGE's CSP
// governs eval here, and a hardened page (business.facebook.com) forbids it — an
// earlier attempt with new Function() died exactly there. content.js is already in
// MAIN world from document_start and holds a grandfathered Trusted Types policy, so
// hand the work to it over a CustomEvent and wait for its reply.
function handleEval(payload) {
  return new Promise((resolve) => {
    const id = "b" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onReply);
      clearTimeout(timer);
      resolve(result);
    };
    function onReply(ev) {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.__mcp !== "eval_res" || d.id !== id) return;
      finish(d.result && typeof d.result === "object"
        ? d.result
        : { ok: false, error: "malformed bridge reply" });
    }
    // Bounded independently of the background's own deadline, so a page that never
    // answers cannot hold the command open. If MAIN never replies (its listener failed
    // to install, or the page tore it out), try here: a content script is governed by
    // the PAGE's CSP, and the pages this bridge targets do allow 'unsafe-eval'.
    const timer = setTimeout(() => {
      let out;
      try {
        out = (0, eval)(String(payload.source || ""));
      } catch (err) {
        finish({ ok: false, error: "eval bridge did not answer; isolated retry: " + ((err && err.message) || err) });
        return;
      }
      Promise.resolve(out).then(
        (v) => {
          if (v === undefined || v === null) return finish({ ok: true, value: null });
          if (typeof v === "object") {
            try { return finish({ ok: true, value: JSON.stringify(v) }); }
            catch { return finish({ ok: true, value: String(v) }); }
          }
          finish({ ok: true, value: String(v) });
        },
        (err) => finish({ ok: false, error: (err && err.message) || String(err) })
      );
    }, 4000);
    // postMessage, not CustomEvent: a CustomEvent's detail arrives as null in the MAIN
    // world, so the listener there fired with nothing to run.
    window.addEventListener("message", onReply);
    try {
      window.postMessage({ __mcp: "eval_req", id, source: String(payload.source || "") }, "*");
    } catch (err) {
      finish({ ok: false, error: (err && err.message) || String(err) });
    }
  });
}

function handleFill(payload) {
  try {
    let el = null;
    if (payload.ref) {
      el = document.querySelector('[data-mcp-ref="' + cssString(payload.ref) + '"]');
    } else if (payload.selector) {
      try { el = document.querySelector(payload.selector); } catch (_) {}
    }
    if (!el) return { ok: false, result: "Element not found" };
    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      return { ok: false, result: "Element is DISABLED — cannot fill" };
    }

    const value = String(payload.value ?? "");
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
      safeDispatch(el, new InputEvent("input", {
        bubbles: true, composed: true, inputType: "insertText", data: value,
      }));
      return { ok: true, result: "Filled contenteditable: " + value.length + " chars" };
    }

    if (el.tagName === "SELECT") {
      el.value = value;
      safeDispatch(el, new Event("input", { bubbles: true, composed: true }));
      safeDispatch(el, new Event("change", { bubbles: true, composed: true }));
      return { ok: true, result: "Filled SELECT: " + value };
    }

    if (!("value" in el)) return { ok: false, result: "Element is not fillable" };
    const prototype = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    try {
      if (el._valueTracker && typeof el._valueTracker.setValue === "function") {
        el._valueTracker.setValue("");
      }
    } catch (_) {}
    safeDispatch(el, new InputEvent("input", {
      bubbles: true, composed: true, inputType: "insertText", data: value,
    }));
    safeDispatch(el, new Event("change", { bubbles: true, composed: true }));
    return { ok: true, result: "Filled " + el.tagName + ": " + value.length + " chars" };
  } catch (error) {
    return { ok: false, result: "Content fill failed: " + (error && error.message ? error.message : String(error)) };
  }
}

function handleClick(payload) {
  try {
    const { selector, text, x, y, ref } = payload;
    let el = null;

    if (ref) {
      el = document.querySelector('[data-mcp-ref="' + cssString(ref) + '"]');
    } else if (selector) {
      try { el = document.querySelector(selector); } catch (_) {}
    } else if (text) {
      const candidates = document.querySelectorAll(
        "button,a,[role='button'],[role='link'],[role='tab'],[role='combobox'],input[type='submit'],input[type='button']"
      );
      for (const candidate of candidates) {
        if (isVisible(candidate) && (candidate.innerText || candidate.textContent || "").trim() === text) {
          el = candidate;
          break;
        }
      }
      if (!el) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const value = (walker.currentNode.textContent || "").trim();
          if (value === text && isVisible(walker.currentNode.parentElement)) {
            el = walker.currentNode.parentElement;
            break;
          }
        }
      }
    } else if (x !== undefined && y !== undefined) {
      el = document.elementFromPoint(Number(x), Number(y));
    }

    if (!el) return { ok: false, result: "Element not found" };
    if (!isVisible(el)) return { ok: false, result: "Element not visible" };
    if (el.disabled || el.getAttribute("aria-disabled") === "true") {
      return { ok: false, result: "Element is DISABLED — cannot click" };
    }

    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let from = document.elementFromPoint(cx, cy);
    if (!from || !(from === el || el.contains(from))) from = el;

    const anchor = el.closest ? el.closest("a[href]") : null;
    const href = anchor && anchor.href && !anchor.href.startsWith("javascript:") ? anchor.href : "";
    const beforeUrl = location.href;
    const common = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, button: 0, detail: 1,
    };

    // Meta's rel=dialog handler specifically validates a leaf event.target. It does
    // not need (and on Safari is harmed by) a synthetic pointer prelude.
    if (anchor && anchor.getAttribute("rel") === "dialog") {
      const notPrevented = from.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
      return {
        ok: true,
        result: notPrevented ? "rel=dialog handler did not claim click" : "Clicked rel=dialog link",
      };
    }

    const pointer = {
      ...common, pointerId: 1, pointerType: "mouse", isPrimary: true,
      width: 1, height: 1, pressure: 0.5,
    };
    safeDispatch(from, new PointerEvent("pointerover", { ...pointer, buttons: 0 }));
    safeDispatch(from, new MouseEvent("mouseover", { ...common, buttons: 0 }));
    safeDispatch(from, new PointerEvent("pointerenter", { ...pointer, buttons: 0 }));
    safeDispatch(from, new MouseEvent("mouseenter", { ...common, buttons: 0 }));
    safeDispatch(from, new PointerEvent("pointermove", { ...pointer, buttons: 0 }));
    safeDispatch(from, new MouseEvent("mousemove", { ...common, buttons: 0 }));
    safeDispatch(from, new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
    safeDispatch(from, new MouseEvent("mousedown", { ...common, buttons: 1 }));
    try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
    safeDispatch(from, new PointerEvent("pointerup", { ...pointer, buttons: 0, pressure: 0 }));
    safeDispatch(from, new MouseEvent("mouseup", { ...common, buttons: 0 }));

    const notPrevented = from.dispatchEvent(new MouseEvent("click", { ...common, buttons: 0 }));
    const target = anchor ? (anchor.getAttribute("target") || "") : "";
    if (href && notPrevented && location.href === beforeUrl && (!target || target === "_self")) {
      return { ok: true, result: "__MCP_NAVIGATE__:" + href };
    }

    const form = el.closest ? el.closest("form") : null;
    if (form && (el.type === "submit" || (el.tagName === "BUTTON" && el.type !== "button" && el.type !== "reset"))) {
      try { form.requestSubmit ? form.requestSubmit(el.type === "submit" ? el : undefined) : form.submit(); } catch (_) {}
    }

    return {
      ok: true,
      result: "Clicked: " + el.tagName + (el.textContent ? ' "' + el.textContent.trim().substring(0, 50) + '"' : ""),
    };
  } catch (error) {
    return { ok: false, result: "Content click failed: " + (error && error.message ? error.message : String(error)) };
  }
}

function cssString(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function isVisible(el) {
  if (!el) return false;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity || "1") !== 0 && rect.width > 0 && rect.height > 0;
}

function safeDispatch(el, event) {
  try { return el.dispatchEvent(event); } catch (_) { return true; }
}

// Expose only to this extension's isolated world. The background worker uses these
// after an extension update when Safari refuses to return a response from a listener
// added to an already-open tab; it schedules the call after executeScript has returned.
globalThis.__mcpHandleContentClick = handleClick;
globalThis.__mcpHandleContentFill = handleFill;
