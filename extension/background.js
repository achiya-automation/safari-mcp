// Safari MCP Bridge — Background Service Worker
// Uses HTTP long-polling to communicate with MCP server
// Safari terminates idle service workers after ~30s, so we keep an active fetch() going

const HTTP_URL = "http://127.0.0.1:9224";
let isConnected = false;
let pollAbort = null;

// ========== GLOBAL ERROR HANDLER ==========
// Prevent unhandled errors from crashing the service worker
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  console.warn("Safari MCP Bridge: unhandled rejection:", e.reason);
});

// ========== BADGE ==========

function updateBadge(text) {
  try {
    browser.action.setBadgeText({ text });
    if (text) browser.action.setBadgeBackgroundColor({ color: text === "ON" ? "#4CAF50" : "#FF9800" });
  } catch {}
}

// ========== HTTP LONG-POLLING TRANSPORT ==========

async function connect() {
  // Cancel any existing poll
  if (pollAbort) {
    try { pollAbort.abort(); } catch {}
    pollAbort = null;
  }

  try {
    const res = await fetch(`${HTTP_URL}/connect`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      isConnected = true;
      updateBadge("ON");
      pollForCommands();
      return;
    }
  } catch {}

  // Server not available — use alarm to retry (keeps worker from dying)
  isConnected = false;
  updateBadge("");
  scheduleReconnect();
}

function scheduleReconnect() {
  // Use alarms instead of setTimeout — alarms wake up a terminated service worker
  try {
    browser.alarms.create("reconnect", { delayInMinutes: 0.05 }); // ~3 seconds (minimum Safari allows)
  } catch {
    // Fallback: setTimeout (won't survive worker termination, but better than nothing)
    setTimeout(connect, 3000);
  }
}

async function pollForCommands() {
  while (isConnected) {
    try {
      pollAbort = new AbortController();
      // Long-poll: server holds connection open until a command arrives or timeout
      // This active fetch keeps the service worker alive in Safari
      const res = await fetch(`${HTTP_URL}/poll`, {
        signal: pollAbort.signal,
      });
      if (res.status === 200) {
        const msg = await res.json();
        await executeAndReply(msg);
      }
      // 204 = no command, loop immediately to keep connection active
    } catch (err) {
      if (err.name === "AbortError") return; // Intentional abort
      // Server gone — reconnect
      isConnected = false;
      updateBadge("");
      scheduleReconnect();
      return;
    }
  }
}

// ========== SHARED: Execute command and send response ==========

async function executeAndReply(msg) {
  if (!msg || !msg.id || !msg.type) return;

  let response;
  try {
    const result = await handleCommand(msg.type, msg.payload || {});
    response = { type: "response", id: msg.id, result, error: null };
  } catch (err) {
    response = { type: "response", id: msg.id, result: null, error: err.message || String(err) };
  }

  try {
    await fetch(`${HTTP_URL}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

// ========== COMMAND HANDLERS ==========

async function handleCommand(type, payload) {
  const targetTab = await getTargetTab(payload.tabUrl);
  const tabId = targetTab.id;

  switch (type) {
    // --- Navigation ---
    case "navigate": {
      await browser.tabs.update(tabId, { url: payload.url });
      await waitForTabLoad(tabId, payload.timeout || 30000);
      const updated = await browser.tabs.get(tabId);
      return { title: updated.title, url: updated.url };
    }

    case "go_back": {
      await browser.tabs.goBack(tabId);
      await sleep(500);
      const updated = await browser.tabs.get(tabId);
      return { title: updated.title, url: updated.url };
    }

    case "go_forward": {
      await browser.tabs.goForward(tabId);
      await sleep(500);
      const updated = await browser.tabs.get(tabId);
      return { title: updated.title, url: updated.url };
    }

    case "reload": {
      await browser.tabs.reload(tabId, { bypassCache: payload.hard || false });
      await waitForTabLoad(tabId);
      const updated = await browser.tabs.get(tabId);
      return { title: updated.title, url: updated.url };
    }

    // --- Page Info ---
    case "get_url": {
      return targetTab.url;
    }

    case "get_title": {
      return targetTab.title;
    }

    case "read_page": {
      return await execInTab((sel, maxLen) => {
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return "Element not found: " + sel;
          return el.value !== undefined && el.value !== "" ? el.value.substring(0, maxLen) : (el.innerText || el.textContent || "").substring(0, maxLen);
        }
        return JSON.stringify({ title: document.title, url: location.href, text: document.body.innerText.substring(0, maxLen) });
      }, [payload.selector || null, payload.maxLength || 50000], tabId);
    }

    // --- JavaScript Execution — direct eval in MAIN world (fast, no polling) ---
    case "evaluate": {
      return await execInTab(async (script) => {
        try {
          const result = await (0, eval)(script);
          if (result === undefined || result === null) return null;
          return typeof result === "object" ? JSON.stringify(result) : String(result);
        } catch (e) {
          return "Error: " + e.message;
        }
      }, [payload.script], tabId);
    }

    // --- Screenshot ---
    case "screenshot": {
      const dataUrl = await browser.tabs.captureVisibleTab(null, {
        format: payload.format || "png",
        quality: payload.quality || 80,
      });
      return dataUrl.split(",")[1];
    }

    // --- Click & Input ---
    case "click": {
      return await execInTab((selector, text, x, y) => {
        let el = null;
        if (selector) {
          el = document.querySelector(selector);
        } else if (text) {
          const attrEls = document.querySelectorAll("[aria-label],[placeholder],[title]");
          for (let i = 0; i < attrEls.length; i++) {
            const a = attrEls[i];
            const vals = [a.getAttribute("aria-label"), a.getAttribute("placeholder"), a.getAttribute("title")].filter(Boolean);
            if (vals.some(v => v === text || v.includes(text))) {
              const r = a.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) { el = a; break; }
            }
          }
          if (!el) {
            const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
            let best = null, bestArea = Infinity;
            while (tw.nextNode()) {
              const t = tw.currentNode.textContent.trim();
              if (!t || !(t === text || t.includes(text))) continue;
              const parent = tw.currentNode.parentElement;
              if (!parent) continue;
              const r = parent.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && r.width * r.height < bestArea) {
                best = parent; bestArea = r.width * r.height;
              }
            }
            el = best;
          }
        } else if (x !== undefined && y !== undefined) {
          el = document.elementFromPoint(x, y);
        }

        if (!el) return "Element not found";

        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const s = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, detail: 1 };
        const p = { ...s, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: 0.5 };

        el.dispatchEvent(new PointerEvent("pointerover", { ...p, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("mouseover", { ...s, buttons: 0 }));
        el.dispatchEvent(new PointerEvent("pointerenter", { ...p, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("mouseenter", { ...s, buttons: 0 }));
        el.dispatchEvent(new PointerEvent("pointerdown", { ...p, buttons: 1 }));
        el.dispatchEvent(new MouseEvent("mousedown", { ...s, buttons: 1 }));
        if (el.focus) el.focus();
        el.dispatchEvent(new PointerEvent("pointerup", { ...p, buttons: 0, pressure: 0 }));
        el.dispatchEvent(new MouseEvent("mouseup", { ...s, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("click", { ...s, buttons: 0 }));

        // React Fiber — traverse up to 15 parents for onClick/onMouseDown
        let node = el, reactFired = false;
        for (let depth = 0; depth < 15 && node; depth++) {
          const pk = Object.keys(node).find(k => k.startsWith("__reactProps$"));
          if (pk && node[pk]) {
            const props = node[pk];
            const synth = { type: "click", target: node, currentTarget: node, clientX: cx, clientY: cy, preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent("click"), persist() {}, bubbles: true };
            if (props.onClick) { props.onClick(synth); reactFired = true; break; }
            if (props.onMouseDown) { props.onMouseDown({ ...synth, type: "mousedown" }); reactFired = true; break; }
          }
          node = node.parentElement;
        }

        // A-tag fallback
        const aTag = el.closest ? el.closest("a[href]") : null;
        if (aTag && aTag.href && !aTag.href.startsWith("javascript:") && aTag.href !== location.href) {
          location.href = aTag.href;
          return "Navigated to: " + aTag.href;
        }

        return "Clicked: " + el.tagName + (el.textContent ? ' "' + el.textContent.trim().substring(0, 50) + '"' : "");
      }, [payload.selector, payload.text, payload.x, payload.y], tabId);
    }

    // --- Click + Read (combo — saves 1 full MCP round-trip) ---
    case "click_and_read": {
      await browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (selector, text, x, y) => {
          let el = null;
          if (selector) {
            el = document.querySelector(selector);
          } else if (text) {
            const attrEls = document.querySelectorAll("[aria-label],[placeholder],[title]");
            for (let i = 0; i < attrEls.length; i++) {
              const a = attrEls[i];
              const vals = [a.getAttribute("aria-label"), a.getAttribute("placeholder"), a.getAttribute("title")].filter(Boolean);
              if (vals.some(v => v === text || v.includes(text))) {
                const r = a.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) { el = a; break; }
              }
            }
            if (!el) {
              const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
              let best = null, bestArea = Infinity;
              while (tw.nextNode()) {
                const t = tw.currentNode.textContent.trim();
                if (!t || !(t === text || t.includes(text))) continue;
                const parent = tw.currentNode.parentElement;
                if (!parent) continue;
                const r = parent.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && r.width * r.height < bestArea) {
                  best = parent; bestArea = r.width * r.height;
                }
              }
              el = best;
            }
          } else if (x !== undefined && y !== undefined) {
            el = document.elementFromPoint(x, y);
          }
          if (!el) return;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const s = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, detail: 1 };
          const po = { ...s, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: 0.5 };
          el.dispatchEvent(new PointerEvent("pointerdown", { ...po, buttons: 1 }));
          el.dispatchEvent(new MouseEvent("mousedown", { ...s, buttons: 1 }));
          if (el.focus) el.focus();
          el.dispatchEvent(new PointerEvent("pointerup", { ...po, buttons: 0, pressure: 0 }));
          el.dispatchEvent(new MouseEvent("mouseup", { ...s, buttons: 0 }));
          el.dispatchEvent(new MouseEvent("click", { ...s, buttons: 0 }));
          let node = el;
          for (let d = 0; d < 15 && node; d++) {
            const pk = Object.keys(node).find(k => k.startsWith("__reactProps$"));
            if (pk && node[pk]) {
              const props = node[pk];
              const synth = { type: "click", target: node, currentTarget: node, clientX: cx, clientY: cy, preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent("click"), persist() {}, bubbles: true };
              if (props.onClick) { props.onClick(synth); return; }
              if (props.onMouseDown) { props.onMouseDown({ ...synth, type: "mousedown" }); return; }
            }
            node = node.parentElement;
          }
          const a = el.closest ? el.closest("a[href]") : null;
          if (a && a.href && !a.href.startsWith("javascript:") && a.href !== location.href) {
            location.href = a.href;
          }
        },
        args: [payload.selector, payload.text, payload.x, payload.y],
      });

      const waitMs = payload.wait || 800;
      await sleep(waitMs);

      const currentTab = await browser.tabs.get(tabId).catch(() => null);
      if (currentTab?.status === "loading") {
        await waitForTabLoad(tabId, 10000);
      }

      const maxLen = payload.maxLength || 50000;
      const results = await browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (ml) => JSON.stringify({ title: document.title, url: location.href, text: document.body.innerText.substring(0, ml) }),
        args: [maxLen],
      });
      return results[0]?.result;
    }

    case "fill": {
      return await execInTab((selector, value) => {
        const el = document.querySelector(selector);
        if (!el) return "Element not found: " + selector;
        el.focus();
        if (el.isContentEditable) {
          el.textContent = "";
          document.execCommand("insertText", false, value);
          return "Filled contenteditable";
        }
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
        if (desc?.set) {
          desc.set.call(el, value);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.value = value;
        }
        return "Filled: " + selector;
      }, [payload.selector, payload.value], tabId);
    }

    case "type_text": {
      return await execInTab((text, selector) => {
        if (selector) { const el = document.querySelector(selector); if (el) el.focus(); }
        document.execCommand("insertText", false, text);
        return "Typed " + text.length + " chars";
      }, [payload.text, payload.selector], tabId);
    }

    case "press_key": {
      return await execInTab((key, modifiers) => {
        const el = document.activeElement || document.body;
        const opts = { key, code: "Key" + key.toUpperCase(), bubbles: true, cancelable: true };
        if (modifiers) {
          if (modifiers.includes("cmd") || modifiers.includes("meta")) opts.metaKey = true;
          if (modifiers.includes("ctrl")) opts.ctrlKey = true;
          if (modifiers.includes("shift")) opts.shiftKey = true;
          if (modifiers.includes("alt")) opts.altKey = true;
        }
        el.dispatchEvent(new KeyboardEvent("keydown", opts));
        el.dispatchEvent(new KeyboardEvent("keypress", opts));
        el.dispatchEvent(new KeyboardEvent("keyup", opts));
        return "Pressed: " + key;
      }, [payload.key, payload.modifiers], tabId);
    }

    // --- Tab Management ---
    case "list_tabs": {
      const tabs = await browser.tabs.query({ currentWindow: true });
      return tabs.map(t => ({ index: t.index + 1, title: t.title, url: t.url, active: t.active }));
    }

    case "new_tab": {
      const newTab = await browser.tabs.create({ url: payload.url || "about:blank", active: false });
      if (payload.url) await waitForTabLoad(newTab.id);
      const updated = await browser.tabs.get(newTab.id);
      return { title: updated.title, url: updated.url, tabIndex: updated.index + 1 };
    }

    case "close_tab": {
      if (payload.index) {
        const tabs = await browser.tabs.query({ currentWindow: true });
        const target = tabs[payload.index - 1];
        if (target) await browser.tabs.remove(target.id);
      } else {
        await browser.tabs.remove(tabId);
      }
      return "Tab closed";
    }

    case "switch_tab": {
      const tabs = await browser.tabs.query({ currentWindow: true });
      const target = tabs[payload.index - 1];
      if (!target) return "Tab not found at index " + payload.index;
      await browser.tabs.update(target.id, { active: true });
      return { title: target.title, url: target.url };
    }

    // --- Scroll ---
    case "scroll": {
      return await execInTab((dir, amount) => {
        window.scrollBy(0, dir === "up" ? -amount : amount);
        return "Scrolled " + dir + " " + amount + "px";
      }, [payload.direction || "down", payload.amount || 500], tabId);
    }

    // --- Wait ---
    case "wait_for": {
      return await execInTab(async (selector, text, timeout) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (selector && document.querySelector(selector)) return "Found: " + selector;
          if (text && document.body?.innerText.includes(text)) return "Found text: " + text;
          await new Promise(r => setTimeout(r, 200));
        }
        return "TIMEOUT";
      }, [payload.selector, payload.text, payload.timeout || 10000], tabId);
    }

    // --- Hover ---
    case "hover": {
      return await execInTab((selector) => {
        const el = document.querySelector(selector);
        if (!el) return "Element not found";
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        el.dispatchEvent(new PointerEvent("pointerover", opts));
        el.dispatchEvent(new MouseEvent("mouseover", opts));
        el.dispatchEvent(new PointerEvent("pointerenter", opts));
        el.dispatchEvent(new MouseEvent("mouseenter", opts));
        return "Hovered: " + el.tagName;
      }, [payload.selector], tabId);
    }

    default:
      throw new Error("Unknown command: " + type);
  }
}

// ========== HELPERS ==========

let _cachedTabId = null;

browser.tabs.onActivated.addListener(({ tabId }) => {
  _cachedTabId = tabId;
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (_cachedTabId === tabId) _cachedTabId = null;
});

async function getTargetTab(tabUrl) {
  if (tabUrl) {
    const all = await browser.tabs.query({ currentWindow: true });
    const match = all.find(t => t.url && (t.url.startsWith(tabUrl) || tabUrl.startsWith(t.url.split("?")[0])));
    if (match) {
      _cachedTabId = match.id;
      return match;
    }
  }
  return getActiveTab();
}

async function getActiveTab() {
  if (_cachedTabId !== null) {
    try {
      const tab = await browser.tabs.get(_cachedTabId);
      if (tab.active) return tab;
    } catch {}
    _cachedTabId = null;
  }
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) throw new Error("No active tab");
  _cachedTabId = tabs[0].id;
  return tabs[0];
}

async function execInTab(func, args = [], tabId = null) {
  const id = tabId || (await getActiveTab()).id;
  const results = await browser.scripting.executeScript({
    target: { tabId: id },
    world: "MAIN",
    func,
    args,
  });
  return results[0]?.result;
}

function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    browser.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ========== KEEP-ALIVE VIA ALARMS ==========
// Safari kills service workers after ~30s of inactivity.
// browser.alarms re-wakes the worker and reconnects if needed.
// The active fetch() in pollForCommands() keeps the worker alive while connected.
browser.alarms.create("keepalive", { periodInMinutes: 0.5 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" || alarm.name === "reconnect") {
    if (!isConnected) {
      connect();
    }
  }
});

// ========== STARTUP ==========
console.log("Safari MCP Bridge: service worker started");
updateBadge("...");
connect();
