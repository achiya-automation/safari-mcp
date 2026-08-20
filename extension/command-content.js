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
  return false;
});

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
