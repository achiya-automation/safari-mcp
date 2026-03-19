// Safari MCP Bridge — Background Service Worker
// Connects to MCP server via WebSocket, executes browser commands

const WS_URL = "ws://localhost:9223";
let ws = null;
let isConnected = false;

// ========== WEBSOCKET CONNECTION ==========

function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    setTimeout(connect, 3000);
    return;
  }

  ws.onopen = () => {
    isConnected = true;
    browser.action.setBadgeText({ text: "ON" });
    browser.action.setBadgeBackgroundColor({ color: "#4CAF50" });
    keepAlive();
  };

  ws.onclose = () => {
    isConnected = false;
    ws = null;
    browser.action.setBadgeText({ text: "" });
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    ws?.close();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    try {
      const result = await handleCommand(msg.type, msg.payload || {});
      ws.send(JSON.stringify({
        type: "response",
        id: msg.id,
        result,
        error: null,
      }));
    } catch (err) {
      ws.send(JSON.stringify({
        type: "response",
        id: msg.id,
        result: null,
        error: err.message || String(err),
      }));
    }
  };
}

// Keep service worker alive (Safari kills after 30s idle)
function keepAlive() {
  if (!isConnected) return;
  ws?.send(JSON.stringify({ type: "keepalive" }));
  setTimeout(keepAlive, 5000);
}

// ========== COMMAND HANDLERS ==========

async function handleCommand(type, payload) {
  switch (type) {
    // --- Navigation ---
    case "navigate": {
      const tab = await getActiveTab();
      await browser.tabs.update(tab.id, { url: payload.url });
      await waitForTabLoad(tab.id, payload.timeout || 30000);
      const updated = await browser.tabs.get(tab.id);
      return { title: updated.title, url: updated.url };
    }

    case "go_back": {
      const tab = await getActiveTab();
      await browser.tabs.goBack(tab.id);
      await sleep(500);
      const updated = await browser.tabs.get(tab.id);
      return { title: updated.title, url: updated.url };
    }

    case "go_forward": {
      const tab = await getActiveTab();
      await browser.tabs.goForward(tab.id);
      await sleep(500);
      const updated = await browser.tabs.get(tab.id);
      return { title: updated.title, url: updated.url };
    }

    case "reload": {
      const tab = await getActiveTab();
      await browser.tabs.reload(tab.id, { bypassCache: payload.hard || false });
      await waitForTabLoad(tab.id);
      const updated = await browser.tabs.get(tab.id);
      return { title: updated.title, url: updated.url };
    }

    // --- Page Info ---
    case "get_url": {
      const tab = await getActiveTab();
      return tab.url;
    }

    case "get_title": {
      const tab = await getActiveTab();
      return tab.title;
    }

    case "read_page": {
      return await execInTab((sel, maxLen) => {
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return "Element not found: " + sel;
          return el.value !== undefined && el.value !== "" ? el.value.substring(0, maxLen) : (el.innerText || el.textContent || "").substring(0, maxLen);
        }
        return JSON.stringify({ title: document.title, url: location.href, text: document.body.innerText.substring(0, maxLen) });
      }, [payload.selector || null, payload.maxLength || 50000]);
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
      }, [payload.script]);
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
          // Search attributes first (aria-label, placeholder, title)
          const attrEls = document.querySelectorAll("[aria-label],[placeholder],[title]");
          for (let i = 0; i < attrEls.length; i++) {
            const a = attrEls[i];
            const vals = [a.getAttribute("aria-label"), a.getAttribute("placeholder"), a.getAttribute("title")].filter(Boolean);
            if (vals.some(v => v === text || v.includes(text))) {
              const r = a.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) { el = a; break; }
            }
          }
          // TreeWalker text search
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
        // (works in MAIN world — has access to __reactProps$)
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

        // A-tag fallback: if React Router didn't navigate, trigger href directly
        if (!reactFired || !location.href.includes("__mcp_nav")) {
          const aTag = el.closest ? el.closest("a[href]") : null;
          if (aTag && aTag.href && !aTag.href.startsWith("javascript:") && aTag.href !== location.href) {
            location.href = aTag.href;
            return "Navigated to: " + aTag.href;
          }
        }

        return "Clicked: " + el.tagName + (el.textContent ? ' "' + el.textContent.trim().substring(0, 50) + '"' : "");
      }, [payload.selector, payload.text, payload.x, payload.y]);
    }

    // --- Click + Read (combo — saves 1 full MCP round-trip) ---
    case "click_and_read": {
      const tab = await getActiveTab();

      // Click
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
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
          // React Fiber
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
          // A-tag fallback
          const a = el.closest ? el.closest("a[href]") : null;
          if (a && a.href && !a.href.startsWith("javascript:") && a.href !== location.href) {
            location.href = a.href;
          }
        },
        args: [payload.selector, payload.text, payload.x, payload.y],
      });

      // Wait for update/navigation
      const waitMs = payload.wait || 800;
      await sleep(waitMs);

      // Check if tab is still loading (navigation happened)
      const currentTab = await browser.tabs.get(tab.id).catch(() => null);
      if (currentTab?.status === "loading") {
        await waitForTabLoad(tab.id, 10000);
      }

      // Read updated page
      const maxLen = payload.maxLength || 50000;
      const results = await browser.scripting.executeScript({
        target: { tabId: tab.id },
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
      }, [payload.selector, payload.value]);
    }

    case "type_text": {
      return await execInTab((text, selector) => {
        if (selector) { const el = document.querySelector(selector); if (el) el.focus(); }
        document.execCommand("insertText", false, text);
        return "Typed " + text.length + " chars";
      }, [payload.text, payload.selector]);
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
      }, [payload.key, payload.modifiers]);
    }

    // --- Tab Management ---
    case "list_tabs": {
      const tabs = await browser.tabs.query({ currentWindow: true });
      return tabs.map(t => ({ index: t.index + 1, title: t.title, url: t.url, active: t.active }));
    }

    case "new_tab": {
      const tab = await browser.tabs.create({ url: payload.url || "about:blank", active: false });
      if (payload.url) await waitForTabLoad(tab.id);
      const updated = await browser.tabs.get(tab.id);
      return { title: updated.title, url: updated.url, tabIndex: updated.index + 1 };
    }

    case "close_tab": {
      if (payload.index) {
        const tabs = await browser.tabs.query({ currentWindow: true });
        const target = tabs[payload.index - 1];
        if (target) await browser.tabs.remove(target.id);
      } else {
        const tab = await getActiveTab();
        await browser.tabs.remove(tab.id);
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
      }, [payload.direction || "down", payload.amount || 500]);
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
      }, [payload.selector, payload.text, payload.timeout || 10000]);
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
      }, [payload.selector]);
    }

    default:
      throw new Error("Unknown command: " + type);
  }
}

// ========== HELPERS ==========

// Cache active tab ID — avoid browser.tabs.query on every call
let _cachedTabId = null;

browser.tabs.onActivated.addListener(({ tabId }) => {
  _cachedTabId = tabId;
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (_cachedTabId === tabId) _cachedTabId = null;
});

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

// Execute a function in the active tab — MAIN world for full page access (React Fiber, etc.)
async function execInTab(func, args = []) {
  const tab = await getActiveTab();
  const results = await browser.scripting.executeScript({
    target: { tabId: tab.id },
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

// ========== STARTUP ==========
connect();
