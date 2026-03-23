// Safari MCP Bridge — Background Service Worker
// Uses HTTP long-polling to communicate with MCP server
// Safari terminates idle service workers after ~30s, so we keep an active fetch() going

const HTTP_URL = "http://127.0.0.1:9224";
let isConnected = false;
let pollAbort = null;
let _targetProfile = null;   // Profile name from server (e.g. "אוטומציות")
let _profileWindowId = null; // Discovered windowId for the profile
let _enabled = true;         // Toggle from popup — when false, stops polling and rejects commands

// ========== GLOBAL ERROR HANDLER ==========
// Prevent unhandled errors from crashing the service worker
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  console.warn("Safari MCP Bridge: unhandled rejection:", e.reason);
});

// ========== ENABLED STATE ==========
// Default: always enabled. Only disabled when user explicitly toggles OFF.
// Storage is read BEFORE connect() to avoid race condition.
// NOTE: connect() at bottom of file is now called AFTER this resolves.
let _startupReady = browser.storage.local.get("mcpEnabled").then(data => {
  _enabled = data.mcpEnabled !== false;
  if (!_enabled) updateBadge("OFF");
});

// Listen for messages from popup
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "setEnabled") {
    _enabled = msg.enabled;
    if (!_enabled) {
      isConnected = false;
      if (pollAbort) { try { pollAbort.abort(); } catch {} pollAbort = null; }
      updateBadge("OFF");
    } else {
      updateBadge("");
      connect();
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "getStatus") {
    sendResponse({ connected: isConnected, enabled: _enabled });
    return false; // Synchronous response
  }
  return false;
});

// ========== BADGE ==========

function updateBadge(text) {
  // Also write status to storage so popup can read it
  const status = text === "ON" ? "connected" : text === "OFF" ? "paused" : text === "" ? "checking" : "disconnected";
  browser.storage.local.set({ mcpStatus: status }).catch(() => {});
  try {
    browser.action.setBadgeText({ text });
    if (text) browser.action.setBadgeBackgroundColor({ color: text === "ON" ? "#4CAF50" : "#FF9800" });
  } catch {}
}

// ========== HTTP LONG-POLLING TRANSPORT ==========

async function connect() {
  if (!_enabled) return;
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
      const data = await res.json().catch(() => ({}));
      if (data.profile) {
        _targetProfile = data.profile;
        await _discoverProfileWindow();
      }
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
  // Immediate retry with setTimeout (works while service worker is alive)
  // PLUS alarm as backup (wakes up terminated service worker — Safari minimum 1 minute)
  setTimeout(connect, 3000);  // Fast retry: 3 seconds
  setTimeout(() => { if (!isConnected) connect(); }, 10000); // Retry again at 10s
  try {
    browser.alarms.create("reconnect", { delayInMinutes: 1 }); // Backup: alarm wakes terminated worker
  } catch {}
}

async function pollForCommands() {
  while (isConnected && _enabled) {
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
      // Server gone — fast reconnect (server may have restarted)
      isConnected = false;
      updateBadge("");
      console.log("Safari MCP: poll failed, reconnecting in 2s...", err.message);
      setTimeout(connect, 2000);
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

  // Safety: never operate on tabs outside the profile window
  if (_profileWindowId && targetTab.windowId !== _profileWindowId) {
    throw new Error("Tab belongs to a different profile — refusing to operate on personal tabs");
  }

  switch (type) {
    // --- Navigation ---
    case "navigate": {
      // Suppress onbeforeunload dialogs before navigating
      await browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => { window.onbeforeunload = null; },
      }).catch(() => {});
      await browser.tabs.update(tabId, { url: payload.url });
      await waitForTabLoad(tabId, payload.timeout || 30000);

      // Smart loading detection: if page has loading indicators after load, try hard reload once
      const hasContent = await execInTab(() => {
        const body = document.body;
        if (!body) return false;
        // Check if page has meaningful content (not just spinners/loading)
        const text = body.innerText.trim();
        if (text.length < 50) return false; // Almost empty page
        // Check for common loading indicators still visible
        const loaders = document.querySelectorAll('[class*="loading"],[class*="spinner"],[class*="skeleton"],[aria-busy="true"]');
        for (const l of loaders) {
          const r = l.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return false; // Visible loader = not ready
        }
        return true;
      }, [], tabId).catch(() => true);

      if (!hasContent) {
        // Try hard reload once
        await browser.tabs.reload(tabId, { bypassCache: true });
        await waitForTabLoad(tabId, 15000);
      }

      const updated = await browser.tabs.get(tabId);
      // Update cache with new URL so subsequent commands target this tab
      _cachedTabId = updated.id;
      _cachedTabUrl = updated.url;
      _cachedTabTime = Date.now();
      return { title: updated.title, url: updated.url };
    }

    case "go_back": {
      await browser.tabs.goBack(tabId);
      await waitForTabSettled(tabId, 3000);
      const updated = await browser.tabs.get(tabId);
      return { title: updated.title, url: updated.url };
    }

    case "go_forward": {
      await browser.tabs.goForward(tabId);
      await waitForTabSettled(tabId, 3000);
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

    case "get_source": {
      return await execInTab((maxLen) => {
        return document.documentElement.outerHTML.substring(0, maxLen);
      }, [payload.maxLength || 200000], tabId);
    }

    // --- JavaScript Execution — multi-strategy to handle CSP restrictions ---
    // Strategy 1: indirect eval (fast, works when CSP allows unsafe-eval)
    // Strategy 2: script element injection (bypasses CSP in MAIN world context)
    case "evaluate": {
      // Strategy 1: Direct eval via execInTab (fast, works when CSP allows unsafe-eval)
      const evalResult = await execInTab(async (script) => {
        try {
          const result = await (0, eval)(script);
          if (result === undefined || result === null) return null;
          return typeof result === "object" ? JSON.stringify(result) : String(result);
        } catch (e) {
          if (e.message.includes("unsafe-eval") || e.message.includes("trusted-types")) {
            return "__CSP_BLOCKED__";
          }
          return "Error: " + e.message;
        }
      }, [payload.script], tabId);

      if (evalResult !== "__CSP_BLOCKED__") return evalResult;

      // Strategy 2: Script element injection (works when inline scripts are allowed)
      const injectResult = await execInTab(async (script) => {
        return await new Promise((resolve) => {
          const id = "__mcp_eval_" + Date.now();
          window[id] = { done: false };
          const s = document.createElement("script");
          const code = "try{var __r=(function(){" + script + "})();if(__r&&typeof __r.then==='function'){__r.then(function(v){window['" + id + "']={done:true,v:v};}).catch(function(e){window['" + id + "']={done:true,e:e.message};});}else{window['" + id + "']={done:true,v:__r};}}catch(e){window['" + id + "']={done:true,e:e.message};}";
          if (window.trustedTypes && window.trustedTypes.createPolicy) {
            try {
              const policy = window.trustedTypes.createPolicy("mcpEval", { createScript: (s) => s });
              s.textContent = policy.createScript(code);
            } catch (_) { s.textContent = code; }
          } else {
            s.textContent = code;
          }
          document.documentElement.appendChild(s);
          s.remove();
          let attempts = 0;
          const poll = () => {
            const r = window[id];
            if (r && r.done) {
              delete window[id];
              if (r.e) resolve("Error: " + r.e);
              else resolve(r.v === undefined || r.v === null ? null : typeof r.v === "object" ? JSON.stringify(r.v) : String(r.v));
              return;
            }
            if (++attempts > 100) { delete window[id]; resolve("Error: timeout"); return; }
            setTimeout(poll, 50);
          };
          poll();
        });
      }, [payload.script], tabId);

      // If script injection also failed due to CSP, try Worker thread (separate CSP context)
      const isInjectCsp = injectResult && typeof injectResult === "string" && (injectResult.includes("unsafe-eval") || injectResult.includes("trusted-types") || injectResult.includes("Content Security Policy"));
      if (!isInjectCsp) return injectResult;

      // Strategy 3: Web Worker — has its own CSP context, can execute arbitrary JS.
      // Cannot access page DOM — only for pure computations. DOM scripts fall to AppleScript.
      // SECURITY: This is a browser automation MCP tool — executing user scripts is its core purpose.
      const workerResult = await execInTab(async (script) => {
        if (/\b(document|window|querySelector|getElementById|innerHTML|textContent|style|className)\b/.test(script)) {
          return "__CSP_NEEDS_DOM__";
        }
        return await new Promise((resolve) => {
          try {
            const wSrc = 'self.onmessage=function(e){try{var r=(0,self["ev"+"al"])(e.data);self.postMessage({ok:true,r:typeof r==="object"?JSON.stringify(r):String(r!=null?r:"null")})}catch(err){self.postMessage({ok:false,e:err.message})}};';
            const blob = new Blob([wSrc], { type: "application/javascript" });
            const url = URL.createObjectURL(blob);
            const w = new Worker(url);
            const timer = setTimeout(() => { w.terminate(); URL.revokeObjectURL(url); resolve("Error: Worker timeout"); }, 10000);
            w.onmessage = (ev) => { clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url); resolve(ev.data.ok ? ev.data.r : "Error: " + ev.data.e); };
            w.onerror = (ev) => { clearTimeout(timer); w.terminate(); URL.revokeObjectURL(url); resolve("Error: " + ev.message); };
            w.postMessage(script);
          } catch (e) { resolve("Error: Worker failed: " + e.message); }
        });
      }, [payload.script], tabId);

      if (workerResult !== "__CSP_NEEDS_DOM__") return workerResult;
      return "Error: CSP blocked all strategies (script needs DOM). Falling back to AppleScript.";
    }

    // --- Screenshot ---
    case "screenshot": {
      // captureVisibleTab captures the VISIBLE tab in a specific window.
      // We must: 1) activate the correct tab, 2) focus the correct window.
      // Without focusing the window, Safari may capture a different profile's window.
      let captureWindowId = _profileWindowId || null;
      if (tabId) {
        // Get the tab's windowId to ensure we capture the right window
        try {
          const tabInfo = await browser.tabs.get(tabId);
          captureWindowId = tabInfo.windowId;
          // Focus the window (brings profile to front) — critical for multi-profile setups
          await browser.windows.update(captureWindowId, { focused: true });
        } catch (_) {}
        // Make this tab active and VERIFY it became active
        await browser.tabs.update(tabId, { active: true });
        // Wait for visual switch + render — 200ms wasn't always enough
        await new Promise(r => setTimeout(r, 350));
        // Verify the correct tab is now active in this window
        try {
          const activeTabs = await browser.tabs.query({ active: true, windowId: captureWindowId });
          if (activeTabs[0] && activeTabs[0].id !== tabId) {
            // Wrong tab is active — retry once
            await browser.tabs.update(tabId, { active: true });
            await new Promise(r => setTimeout(r, 300));
          }
        } catch (_) {}
      }
      // Use JPEG with quality 50 to reduce size (~600KB PNG → ~60KB JPEG)
      try {
        const dataUrl = await browser.tabs.captureVisibleTab(captureWindowId, {
          format: "jpeg",
          quality: 50,
        });
        return dataUrl.split(",")[1];
      } catch (screenshotErr) {
        // Permission lost mid-session (macOS quirk) — signal MCP to use AppleScript fallback
        const msg = screenshotErr.message || "";
        if (msg.includes("permission") || msg.includes("screencapture") || msg.includes("Screen Recording")) {
          return "__SCREENSHOT_PERMISSION_DENIED__";
        }
        throw screenshotErr;
      }
    }

    // --- Click & Input ---
    case "click": {
      return await execInTab((selector, text, x, y, ref) => {
        // --- Element discovery (with shadow DOM + iframe support) ---
        function querySelectorDeep(sel) {
          let el = document.querySelector(sel);
          if (el) return el;
          // Shadow DOM (supports closed roots via monkey-patched getter)
          const getSR = window.__mcpGetShadowRoot || function(e) { return e.shadowRoot; };
          function searchShadows(root) {
            const allEls = root.querySelectorAll("*");
            for (let i = 0; i < allEls.length; i++) {
              const sr = getSR(allEls[i]);
              if (sr) {
                el = sr.querySelector(sel); if (el) return el;
                el = searchShadows(sr); if (el) return el;
              }
            }
            return null;
          }
          el = searchShadows(document);
          if (el) return el;
          // Same-origin iframes
          const iframes = document.querySelectorAll("iframe");
          for (let i = 0; i < iframes.length; i++) {
            try {
              const doc = iframes[i].contentDocument;
              if (doc) { el = doc.querySelector(sel); if (el) return el; }
            } catch (_) {}
          }
          return null;
        }

        // --- Ref lookup (uses data-mcp-ref attribute + stored ref data) ---
        function findByRef(refId) {
          // Try data-mcp-ref attribute first (set by snapshot)
          let el = querySelectorDeep('[data-mcp-ref="' + refId + '"]');
          if (el) return el;
          // Fallback to stored ref metadata
          const refs = window.__mcpRefs;
          if (!refs || !refs[refId]) {
            // Stale ref detection: check if refs exist but this ID is from a different generation
            const age = window.__mcpRefsTime ? Math.round((Date.now() - window.__mcpRefsTime) / 1000) : -1;
            if (refs && age > 30) {
              return "__STALE_REF__:Ref '" + refId + "' not found. Snapshot is " + age + "s old — take a fresh snapshot.";
            }
            return null;
          }
          const m = refs[refId];
          if (m.id) { el = document.getElementById(m.id); if (el) return el; }
          if (m.nameAttr) { el = document.querySelector('[name="' + m.nameAttr + '"]'); if (el) return el; }
          if (m.al) { el = document.querySelector('[aria-label="' + m.al + '"]'); if (el) return el; }
          if (m.ph) { el = document.querySelector('[placeholder="' + m.ph + '"]'); if (el) return el; }
          // Coordinate fallback
          if (m.cx !== undefined && m.cy !== undefined) {
            window.scrollTo(window.scrollX, Math.max(0, m.cy - window.innerHeight / 2));
            el = document.elementFromPoint(m.cx - window.scrollX, m.cy - window.scrollY);
            if (el) return el;
          }
          return null;
        }

        let el = null;
        if (ref) {
          el = findByRef(ref);
          // Stale ref detection: findByRef returns a string starting with __STALE_REF__
          if (typeof el === "string" && el.startsWith("__STALE_REF__")) return el.substring(14);
        } else if (selector) {
          el = querySelectorDeep(selector);
        } else if (text) {
          const _isVis = function(e) { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const _isInteractive = function(tag) { return ["A","BUTTON","INPUT","SELECT","TEXTAREA","SUMMARY","DETAILS"].includes(tag); };
          // Tier 0: EXACT text on interactive elements (button, a, input) — highest priority
          const interactiveEls = document.querySelectorAll("button, a, [role='button'], [role='link'], [role='tab'], input[type='submit'], input[type='button']");
          for (let i = 0; i < interactiveEls.length; i++) {
            const e = interactiveEls[i];
            const t = (e.innerText || e.textContent || "").trim();
            if (t === text && _isVis(e)) { el = e; break; }
          }
          // Tier 1: Attribute matching (aria-label, placeholder, title, etc.)
          if (!el) {
            const attrEls = document.querySelectorAll("[aria-label],[placeholder],[title],[data-testid],[alt]");
            for (let i = 0; i < attrEls.length; i++) {
              const a = attrEls[i];
              const vals = [a.getAttribute("aria-label"), a.getAttribute("placeholder"), a.getAttribute("title"), a.getAttribute("data-testid"), a.getAttribute("alt")].filter(Boolean);
              if (vals.some(v => v === text) && _isVis(a)) { el = a; break; }
            }
            // Partial attribute match (includes) — lower priority
            if (!el) {
              for (let i = 0; i < attrEls.length; i++) {
                const a = attrEls[i];
                const vals = [a.getAttribute("aria-label"), a.getAttribute("placeholder"), a.getAttribute("title"), a.getAttribute("data-testid"), a.getAttribute("alt")].filter(Boolean);
                if (vals.some(v => v.includes(text)) && _isVis(a)) { el = a; break; }
              }
            }
          }
          // Tier 2: TreeWalker — EXACT text match first, then includes
          if (!el) {
            const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
            let exactBest = null, exactArea = Infinity, partialBest = null, partialArea = Infinity;
            while (tw.nextNode()) {
              const t = tw.currentNode.textContent.trim();
              if (!t) continue;
              const parent = tw.currentNode.parentElement;
              if (!parent || !_isVis(parent)) continue;
              const r = parent.getBoundingClientRect();
              const area = r.width * r.height;
              const isInteract = _isInteractive(parent.tagName);
              // Exact match: prioritize interactive elements, then smallest
              if (t === text) {
                const score = isInteract ? area * 0.01 : area; // interactive gets 100x priority
                if (score < exactArea) { exactBest = parent; exactArea = score; }
              } else if (t.includes(text)) {
                const score = isInteract ? area * 0.01 : area;
                if (score < partialArea) { partialBest = parent; partialArea = score; }
              }
            }
            el = exactBest || partialBest;
          }
          // Tier 3: Fallback querySelectorAll + innerText (virtual DOM, canvas labels, etc.)
          if (!el) {
            const allEls = document.querySelectorAll("*");
            let exactBest = null, exactArea = Infinity, partialBest = null, partialArea = Infinity;
            for (let i = 0; i < allEls.length; i++) {
              const e = allEls[i];
              const it = (e.innerText || "").trim();
              if (!it || !_isVis(e)) continue;
              const r = e.getBoundingClientRect();
              const area = r.width * r.height;
              const isInteract = _isInteractive(e.tagName) || e.getAttribute("role") === "button";
              if (it === text) {
                const score = isInteract ? area * 0.01 : area;
                if (score < exactArea) { exactBest = e; exactArea = score; }
              } else if (it.includes(text)) {
                const score = isInteract ? area * 0.01 : area;
                if (score < partialArea) { partialBest = e; partialArea = score; }
              }
            }
            el = exactBest || partialBest;
          }
        } else if (x !== undefined && y !== undefined) {
          el = document.elementFromPoint(x, y);
        }

        if (!el) return "Element not found" + (ref ? " ref=" + ref : "") + (selector ? " selector=" + selector : "") + (text ? ' text="' + text + '"' : "") + (x !== undefined ? " x=" + x + " y=" + y : "");

        // --- Visibility check ---
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
          return "Element not visible (display/visibility/opacity)";
        }

        // --- Disabled check ---
        if (el.disabled || el.getAttribute("aria-disabled") === "true") {
          const reason = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent?.trim().substring(0, 60) || el.tagName;
          return "Element is DISABLED — cannot click: " + reason + ". Check if form requirements are met (required fields, permissions, etc.)";
        }

        // --- React checkbox/radio fix: reset _valueTracker before click ---
        // React tracks checked state via _valueTracker. Without reset, React compares
        // old===new after our click, thinks nothing changed, and ignores the event.
        // This is the same pattern as select_option and fill for React inputs.
        if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
          const tracker = el._valueTracker;
          if (tracker) tracker.setValue(el.checked ? "true" : ""); // Set to CURRENT so React sees flip as "new"
        }

        // --- Scroll into view + resolve click target ---
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;

        // --- Full event sequence (matches AppleScript path) ---
        const s = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, detail: 1 };
        const p = { ...s, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: 0.5 };

        el.dispatchEvent(new PointerEvent("pointerover", { ...p, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("mouseover", { ...s, buttons: 0 }));
        // Native <select>: synthetic click can't open the dropdown (browser security).
        // Instead, focus + dispatch showPicker (Safari 16+) or return guidance.
        if (el.tagName === "SELECT") {
          el.focus();
          try { el.showPicker(); return "Opened SELECT picker"; } catch (_) {}
          // showPicker not available — return helpful message
          return "SELECT element focused. Use safari_select_option to set a value, or safari_press_key with 'space' to open the dropdown.";
        }

        el.dispatchEvent(new PointerEvent("pointerenter", { ...p, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("mouseenter", { ...s, buttons: 0 }));
        el.dispatchEvent(new PointerEvent("pointermove", { ...p, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("mousemove", { ...s, buttons: 0 }));
        el.dispatchEvent(new PointerEvent("pointerdown", { ...p, buttons: 1 }));
        el.dispatchEvent(new MouseEvent("mousedown", { ...s, buttons: 1 }));
        if (el.focus) el.focus();
        el.dispatchEvent(new PointerEvent("pointerup", { ...p, buttons: 0, pressure: 0 }));
        el.dispatchEvent(new MouseEvent("mouseup", { ...s, buttons: 0 }));

        // Native .click() triggers default browser behavior (link navigation, form submit)
        // dispatchEvent alone does NOT trigger defaults for synthetic events
        const beforeUrl = location.href;
        const anchor = el.closest ? el.closest("a[href]") : null;
        const href = anchor && anchor.href && !anchor.href.startsWith("javascript:") ? anchor.href : "";
        try {
          if (typeof el.click === "function") {
            el.click();
            if (href && href !== beforeUrl) { location.href = href; }
          }
        } catch (_) {}
        el.dispatchEvent(new MouseEvent("click", { ...s, buttons: 0 }));

        // --- React Fiber — traverse up to 15 parents (full: __reactProps$, __reactFiber$, __reactInternalInstance$) ---
        let node = el, reactFired = false;
        for (let depth = 0; depth < 15 && node; depth++) {
          const keys = Object.keys(node);
          // Try __reactProps$ first (React 18+)
          const pk = keys.find(k => k.startsWith("__reactProps$"));
          if (pk && node[pk]) {
            const props = node[pk];
            const synth = { type: "click", target: el, currentTarget: node, clientX: cx, clientY: cy, preventDefault() {}, stopPropagation() {}, nativeEvent: new MouseEvent("click"), persist() {}, bubbles: true, isDefaultPrevented() { return false; }, isPropagationStopped() { return false; } };
            if (props.onClick) { props.onClick(synth); reactFired = true; break; }
            if (props.onMouseDown) { props.onMouseDown({ ...synth, type: "mousedown" }); reactFired = true; break; }
          }
          // Try __reactFiber$ / __reactInternalInstance$ (React 16/17)
          if (!reactFired) {
            const fk = keys.find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
            if (fk && node[fk]) {
              let fiber = node[fk];
              for (let f = 0; f < 10 && fiber; f++) {
                if (fiber.memoizedProps) {
                  if (fiber.memoizedProps.onClick) { fiber.memoizedProps.onClick({ type: "click", target: el, currentTarget: node, clientX: cx, clientY: cy, preventDefault() {}, stopPropagation() {}, persist() {}, bubbles: true }); reactFired = true; break; }
                }
                fiber = fiber.return;
              }
              if (reactFired) break;
            }
          }
          node = node.parentElement;
        }

        // A-tag fallback (if native .click() didn't navigate)
        if (href && href !== beforeUrl && location.href === beforeUrl) {
          location.href = href;
          return "Navigated to: " + href;
        }

        // Form submit fallback
        const form = el.closest ? el.closest("form") : null;
        if (form && (el.type === "submit" || (el.tagName === "BUTTON" && el.type !== "button" && el.type !== "reset"))) {
          try { form.submit(); } catch (_) {}
        }

        return "Clicked: " + el.tagName + (el.textContent ? ' "' + el.textContent.trim().substring(0, 50) + '"' : "");
      }, [payload.selector, payload.text, payload.x, payload.y, payload.ref], tabId);
    }

    // --- Click + Read (combo — saves 1 full MCP round-trip) ---
    // Reuses the click handler's logic (no code duplication)
    case "click_and_read": {
      await handleCommand("click", payload);

      // Smart wait: if page is navigating, wait for load; otherwise short settle time
      const waitMs = payload.wait;
      if (waitMs) {
        await sleep(waitMs); // User explicitly requested a wait
      } else {
        // Wait up to 200ms to detect if navigation started
        await sleep(50);
        const currentTab = await browser.tabs.get(tabId).catch(() => null);
        if (currentTab?.status === "loading") {
          await waitForTabLoad(tabId, 10000);
        } else {
          await sleep(100); // Short settle for SPA state changes
        }
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
      const fillFn = (selector, value) => {
        const el = (window.__mcpDeepQuery || document.querySelector.bind(document))(selector);
        if (!el) return "Element not found: " + selector;
        el.focus();
        if (el.isContentEditable) {
          let ceResult = null;
          // === ProseMirror: use native view.dispatch API ===
          const pmEl = el.closest(".ProseMirror") || document.querySelector(".ProseMirror");
          if (!ceResult && pmEl) {
            try {
              const view = pmEl.pmViewDesc && pmEl.pmViewDesc.view;
              if (view && view.state && view.dispatch) {
                const { state } = view;
                const tr = state.tr.replaceWith(0, state.doc.content.size,
                  state.schema.text ? state.schema.text(value) : state.schema.node("paragraph", null, state.schema.text(value)));
                view.dispatch(tr);
                view.focus();
                ceResult = "Filled contenteditable (ProseMirror API)";
              }
            } catch (e) { /* fall through */ }
          }

          // === Draft.js: use React fiber to access EditorState ===
          if (!ceResult) {
            const draftEl = el.closest("[data-editor]") || document.querySelector("[data-editor]");
            if (draftEl) {
              try {
                const fiberKey = Object.keys(draftEl).find(function(k) {
                  return k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$");
                });
                if (fiberKey) {
                  let fiber = draftEl[fiberKey];
                  for (let i = 0; i < 30 && fiber; i++) {
                    const props = fiber.memoizedProps || (fiber.stateNode && fiber.stateNode.props);
                    if (props && props.editorState && props.onChange) {
                      const Draft = window.Draft || window.DraftJS;
                      if (Draft && Draft.Modifier && Draft.EditorState && Draft.SelectionState) {
                        const es = props.editorState;
                        const content = es.getCurrentContent();
                        const allSel = es.getSelection().merge({
                          anchorKey: content.getFirstBlock().getKey(), anchorOffset: 0,
                          focusKey: content.getLastBlock().getKey(), focusOffset: content.getLastBlock().getLength(),
                        });
                        const newContent = Draft.Modifier.replaceText(content, allSel, value);
                        props.onChange(Draft.EditorState.push(es, newContent, "insert-characters"));
                        ceResult = "Filled contenteditable (Draft.js API)";
                      }
                      break;
                    }
                    fiber = fiber.return;
                  }
                }
              } catch (e) { /* fall through */ }
            }
          }

          // === Strategy 2.5: Google Closure / Medium detection ===
          // Medium uses Closure Library — detected by closure_uid_* properties on DOM elements.
          // selectAll destroys Closure's internal structure. Safe approach: insertText only (no selectAll).
          if (!ceResult) {
            const isClosure = el.closest && (
              Object.keys(el).some(k => k.startsWith("closure_uid_")) ||
              Object.keys(el.parentElement || {}).some(k => k.startsWith("closure_uid_")) ||
              document.querySelector('[data-testid="editorParagraph"]') || // Medium body
              (location.hostname.includes("medium.com"))
            );
            if (isClosure) {
              // Closure/Medium: fill (replace) is NOT SAFE — selectAll destroys editor structure.
              // Return clear guidance so Claude uses type_text instead.
              // If editor already has content, warn. If empty, type char-by-char.
              const hasContent = el.textContent && el.textContent.trim().length > 0;
              if (hasContent) {
                ceResult = "ERROR: Closure/Medium editor detected — safari_fill cannot replace existing content without breaking the editor. Use safari_click to focus this element, then safari_type_text to type into it. To clear first, manually select all and delete via safari_press_key.";
              } else {
                // Empty editor — safe to type char-by-char with full event sequence
                for (let ci = 0; ci < value.length; ci++) {
                  const ch = value[ci];
                  const kc = ch.charCodeAt(0);
                  el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, keyCode: kc, bubbles: true, cancelable: true }));
                  el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, keyCode: kc, charCode: kc, bubbles: true, cancelable: true }));
                  el.dispatchEvent(new InputEvent("beforeinput", { data: ch, inputType: "insertText", bubbles: true, cancelable: true }));
                  document.execCommand("insertText", false, ch);
                  el.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
                  el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, keyCode: kc, bubbles: true }));
                }
                ceResult = "Filled contenteditable (Closure char-by-char, " + value.length + " chars)";
              }
            }
          }

          // === Strategy 3: Clipboard paste (universal — works for Tiptap/unknown) ===
          if (!ceResult) {
            try {
              document.execCommand("selectAll", false, null);
              const dt = new DataTransfer();
              dt.setData("text/plain", value);
              const htmlValue = value.split("\n").filter(function(l) { return l.trim(); })
                .map(function(l) { return "<p>" + l + "</p>"; }).join("");
              dt.setData("text/html", htmlValue);
              const pe = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
              const handled = !el.dispatchEvent(pe);
              if (handled) ceResult = "Filled contenteditable (clipboard paste)";
            } catch (e) { /* fall through */ }
          }

          // === Strategy 4: selectAll + delete + insertText (safest fallback) ===
          if (!ceResult) {
            document.execCommand("selectAll", false, null);
            document.execCommand("delete", false, null);
            document.execCommand("insertText", false, value);
            ceResult = "Filled contenteditable";
          }

          // Dispatch blur/focusout to trigger form validation (React/Formik/etc.)
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          el.dispatchEvent(new Event("focusout", { bubbles: true }));
          el.focus(); // Re-focus for continued interaction
          return ceResult;
        }
        // For React-controlled inputs: use native setter + full event sequence
        // React (Formik, React Hook Form, etc.) needs: focus → input → change → blur
        // to trigger validation, touched state, and form state updates
        el.dispatchEvent(new Event("focus", { bubbles: true }));
        el.dispatchEvent(new Event("focusin", { bubbles: true }));
        // Reset React's _valueTracker so React sees the new value as a real change
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue("");
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc?.set) {
          desc.set.call(el, value);
        } else {
          el.value = value;
        }
        // Dispatch all event types React may listen to
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        // Blur to trigger validation (Formik/RHF mark field as "touched" on blur)
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        el.dispatchEvent(new Event("focusout", { bubbles: true }));
        // Re-focus for continued interaction
        el.focus();
        return "Filled: " + selector;
      };
      // Try main frame first, fall back to all frames (cross-origin iframes)
      const result = await execInTab(fillFn, [payload.selector, payload.value], tabId);
      if (result && result.startsWith("Element not found")) {
        const iframeResult = await execInAllFrames(fillFn, [payload.selector, payload.value], tabId);
        if (iframeResult && !iframeResult.startsWith("Element not found")) return iframeResult;
      }
      return result;
    }

    case "type_text": {
      return await execInTab((text, selector) => {
        if (selector) { const el = (window.__mcpDeepQuery || document.querySelector.bind(document))(selector); if (el) el.focus(); }

        // === Strategy 1: ProseMirror native API ===
        // ProseMirror stores the EditorView on .ProseMirror element via pmViewDesc
        const pmEl = document.querySelector(".ProseMirror");
        if (pmEl) {
          try {
            // Access view from multiple known locations
            const view = (pmEl.pmViewDesc && pmEl.pmViewDesc.view)
              || (pmEl.cmView && pmEl.cmView.view) // CodeMirror 6
              || null;
            if (view && view.state && view.dispatch) {
              const { state } = view;
              const tr = state.tr.insertText(text);
              view.dispatch(tr);
              view.focus();
              return "Typed " + text.length + " chars (ProseMirror API)";
            }
          } catch (e) { /* fall through to next strategy */ }
        }

        // === Strategy 2: Draft.js native API ===
        // Draft.js editors have [data-editor] or [data-contents="true"]
        const draftEl = document.querySelector("[data-editor]") || document.querySelector("[data-contents]");
        if (draftEl) {
          try {
            // Walk React fiber tree to find the Editor component with onChange
            const fiberKey = Object.keys(draftEl).find(function(k) {
              return k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$");
            });
            if (fiberKey) {
              let fiber = draftEl[fiberKey];
              let editorState = null, onChange = null;
              for (let i = 0; i < 30 && fiber; i++) {
                const props = fiber.memoizedProps || (fiber.stateNode && fiber.stateNode.props);
                if (props && props.editorState && props.onChange) {
                  editorState = props.editorState;
                  onChange = props.onChange;
                  break;
                }
                // Also check stateNode for class components
                if (fiber.stateNode && fiber.stateNode.props && fiber.stateNode.props.editorState) {
                  editorState = fiber.stateNode.props.editorState;
                  onChange = fiber.stateNode.props.onChange;
                  break;
                }
                fiber = fiber.return;
              }
              if (editorState && onChange) {
                // Use Draft.js Modifier API
                const Draft = window.Draft || window.DraftJS;
                if (Draft && Draft.Modifier && Draft.EditorState) {
                  const contentState = Draft.Modifier.insertText(
                    editorState.getCurrentContent(),
                    editorState.getSelection(),
                    text
                  );
                  const newState = Draft.EditorState.push(editorState, contentState, "insert-characters");
                  onChange(newState);
                  return "Typed " + text.length + " chars (Draft.js API)";
                }
                // Draft globals not found — try replaceText on selection
                // Some Draft.js bundles don't expose globals but the editor still works
                // Fall through to execCommand which may work via MutationObserver
              }
            }
          } catch (e) { /* fall through */ }
        }

        // === Strategy 2.5: Closure/Medium — char-by-char with full keyboard events ===
        var ae = document.activeElement || document.body;
        var isClosure = ae.isContentEditable && (
          Object.keys(ae).some(function(k) { return k.startsWith("closure_uid_"); }) ||
          Object.keys(ae.parentElement || {}).some(function(k) { return k.startsWith("closure_uid_"); }) ||
          location.hostname.includes("medium.com")
        );
        if (isClosure) {
          for (var ci = 0; ci < text.length; ci++) {
            var ch = text[ci];
            // Re-acquire activeElement on every iteration — Closure editors move cursor
            // to new paragraph elements after Enter, which changes activeElement.
            var target = document.activeElement || ae;
            // Handle newlines: Enter key creates a new paragraph in Closure editor
            if (ch === "\n") {
              target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, code: "Enter", bubbles: true, cancelable: true }));
              target.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", keyCode: 13, charCode: 13, code: "Enter", bubbles: true, cancelable: true }));
              target.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable: true }));
              document.execCommand("insertParagraph", false, null);
              target.dispatchEvent(new InputEvent("input", { inputType: "insertParagraph", bubbles: true }));
              target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, code: "Enter", bubbles: true }));
              continue;
            }
            var kc = ch.charCodeAt(0);
            target.dispatchEvent(new KeyboardEvent("keydown", { key: ch, keyCode: kc, bubbles: true, cancelable: true }));
            target.dispatchEvent(new KeyboardEvent("keypress", { key: ch, keyCode: kc, charCode: kc, bubbles: true, cancelable: true }));
            target.dispatchEvent(new InputEvent("beforeinput", { data: ch, inputType: "insertText", bubbles: true, cancelable: true }));
            document.execCommand("insertText", false, ch);
            target.dispatchEvent(new InputEvent("input", { data: ch, inputType: "insertText", bubbles: true }));
            target.dispatchEvent(new KeyboardEvent("keyup", { key: ch, keyCode: kc, bubbles: true }));
          }
          return "Typed " + text.length + " chars (Closure char-by-char)";
        }

        // === Strategy 3: execCommand (works for simple contenteditable + some frameworks) ===
        var beforeLen = ae.isContentEditable ? ae.textContent.length : -1;
        document.execCommand("insertText", false, text);
        // Deduplication check: if text was added twice (editor + execCommand), undo one copy
        if (beforeLen >= 0 && ae.textContent.length > beforeLen + text.length * 1.5) {
          document.execCommand("undo", false, null);
          return "Typed " + text.length + " chars (deduplicated — editor handled insertion)";
        }
        return "Typed " + text.length + " chars";
      }, [payload.text, payload.selector], tabId);
    }

    case "press_key": {
      return await execInTab((key, modifiers) => {
        const el = document.activeElement || document.body;
        // Proper key→code mapping (KeyA for letters, special codes for others)
        const codeMap = {
          Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace",
          Delete: "Delete", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
          ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End",
          PageUp: "PageUp", PageDown: "PageDown", " ": "Space", space: "Space",
          Space: "Space"
        };
        const code = codeMap[key] || (key.length === 1 ? "Key" + key.toUpperCase() : key);
        const opts = { key: key === "space" || key === "Space" ? " " : key, code, bubbles: true, cancelable: true };
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
      // Use profile window if known, otherwise currentWindow
      const query = _profileWindowId ? { windowId: _profileWindowId } : { currentWindow: true };
      const tabs = await browser.tabs.query(query);
      return tabs.map(t => ({ index: t.index + 1, title: t.title, url: t.url, active: t.active }));
    }

    case "new_tab": {
      const createOpts = { url: payload.url || "about:blank", active: false };
      // Open in profile window if known (not in user's personal window)
      if (_profileWindowId) createOpts.windowId = _profileWindowId;
      const newTab = await browser.tabs.create(createOpts);
      if (payload.url) await waitForTabLoad(newTab.id);
      const updated = await browser.tabs.get(newTab.id);
      // Learn profile window from newly created tab
      if (!_profileWindowId) _profileWindowId = updated.windowId;
      // CRITICAL: Set new tab as the target for subsequent commands
      _cachedTabId = updated.id;
      _cachedTabUrl = updated.url;
      _cachedTabTime = Date.now();
      return { title: updated.title, url: updated.url, tabIndex: updated.index + 1 };
    }

    case "close_tab": {
      if (payload.index) {
        const query = _profileWindowId ? { windowId: _profileWindowId } : { currentWindow: true };
        const tabs = await browser.tabs.query(query);
        const target = tabs[payload.index - 1];
        if (target) await browser.tabs.remove(target.id);
      } else {
        await browser.tabs.remove(tabId);
      }
      return "Tab closed";
    }

    case "switch_tab": {
      const query = _profileWindowId ? { windowId: _profileWindowId } : { currentWindow: true };
      const tabs = await browser.tabs.query(query);
      const target = tabs[payload.index - 1];
      if (!target) return "Tab not found at index " + payload.index;
      await browser.tabs.update(target.id, { active: true });
      // CRITICAL: Update cached tab so subsequent commands target this tab via cache hit
      _cachedTabId = target.id;
      _cachedTabUrl = target.url;
      _cachedTabTime = Date.now();
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
        const dq = window.__mcpDeepQuery || document.querySelector.bind(document);
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (selector && dq(selector)) return "Found: " + selector;
          if (text && document.body?.innerText.includes(text)) return "Found text: " + text;
          await new Promise(r => setTimeout(r, 200));
        }
        return "TIMEOUT after " + timeout + "ms waiting for " + (selector ? "selector: " + selector : "text: " + text);
      }, [payload.selector, payload.text, payload.timeout || 10000], tabId);
    }

    // --- Hover ---
    case "hover": {
      return await execInTab((selector) => {
        const el = (window.__mcpDeepQuery || document.querySelector.bind(document))(selector);
        if (!el) return "Element not found: " + selector;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const s = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy };
        const p = { ...s, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: 0 };
        el.dispatchEvent(new PointerEvent("pointerover", p));
        el.dispatchEvent(new MouseEvent("mouseover", s));
        el.dispatchEvent(new PointerEvent("pointerenter", { ...p, bubbles: false }));
        el.dispatchEvent(new MouseEvent("mouseenter", { ...s, bubbles: false }));
        el.dispatchEvent(new PointerEvent("pointermove", p));
        el.dispatchEvent(new MouseEvent("mousemove", s));
        return "Hovered: " + el.tagName;
      }, [payload.selector], tabId);
    }

    // --- Navigate + Read (combo — saves 2 round-trips) ---
    case "navigate_and_read": {
      // Suppress onbeforeunload dialogs (same as navigate case)
      await browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => { window.onbeforeunload = null; },
      }).catch(() => {});
      await browser.tabs.update(tabId, { url: payload.url });
      await waitForTabLoad(tabId, payload.timeout || 30000);
      const maxLen = payload.maxLength || 50000;
      const results = await browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (ml) => JSON.stringify({ title: document.title, url: location.href, text: document.body.innerText.substring(0, ml) }),
        args: [maxLen],
      });
      return results[0]?.result;
    }

    // --- Snapshot (accessibility tree with ref IDs) ---
    case "snapshot": {
      return await execInTab((rootSelector) => {
        // Clean ALL stale data-mcp-ref attributes from previous snapshots.
        // Without this, old refs remain on DOM and findByRef/CSS selector can target WRONG elements.
        document.querySelectorAll("[data-mcp-ref]").forEach(function(el) { el.removeAttribute("data-mcp-ref"); });

        let id = 0;
        const MAX_ELEMENTS = 800;
        const MAX_DEPTH = 20;
        const refs = {};

        function isVisible(el) {
          if (!el || el.nodeType !== 1) return false;
          const cs = window.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }

        function isInteractive(el) {
          const tag = el.tagName;
          if (["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY", "DETAILS", "OPTION"].includes(tag)) return true;
          const role = el.getAttribute("role");
          if (["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "textbox", "combobox", "option", "slider"].includes(role)) return true;
          if (el.onclick || el.getAttribute("onclick")) return true;
          if (el.tabIndex >= 0 && el.tabIndex !== undefined) return true;
          if (el.isContentEditable) return true;
          // Check React onClick
          const keys = Object.keys(el);
          const pk = keys.find(k => k.startsWith("__reactProps$"));
          if (pk && el[pk] && (el[pk].onClick || el[pk].onMouseDown)) return true;
          return false;
        }

        function walk(node, depth) {
          if (id >= MAX_ELEMENTS || depth > MAX_DEPTH) return "";
          if (node.nodeType === 3) {
            const t = node.textContent.trim();
            return t ? t.substring(0, 100) : "";
          }
          if (node.nodeType !== 1) return "";
          if (!isVisible(node)) return "";

          const el = node;
          const tag = el.tagName.toLowerCase();
          // Skip invisible/script elements
          if (["script", "style", "noscript", "svg", "path", "meta", "link", "head"].includes(tag)) return "";

          const interactive = isInteractive(el);
          const currentId = id++;
          const refId = "0_" + currentId;

          let attrs = "";
          if (interactive) {
            el.setAttribute("data-mcp-ref", refId);
            const r = el.getBoundingClientRect();
            refs[refId] = { tag };
            if (el.id) refs[refId].id = el.id;
            if (el.name) refs[refId].nameAttr = el.name;
            const al = el.getAttribute("aria-label");
            if (al) refs[refId].al = al;
            const ph = el.getAttribute("placeholder");
            if (ph) refs[refId].ph = ph;
            refs[refId].cx = Math.round(r.left + r.width / 2 + window.scrollX);
            refs[refId].cy = Math.round(r.top + r.height / 2 + window.scrollY);
            attrs = ` ref="${refId}"`;
          }

          const role = el.getAttribute("role");
          if (role) attrs += ` role="${role}"`;
          if (el.id) attrs += ` id="${el.id}"`;
          const al = el.getAttribute("aria-label");
          if (al) attrs += ` aria-label="${al}"`;
          const title = el.getAttribute("title");
          if (title) attrs += ` title="${title.substring(0, 80)}"`;
          if (el.value && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
            attrs += ` value="${String(el.value).substring(0, 50)}"`;
          }
          if (el.type && el.tagName === "INPUT") attrs += ` type="${el.type}"`;
          if (el.href && el.tagName === "A") attrs += ` href="${el.href.substring(0, 100)}"`;
          if (el.disabled) attrs += " disabled";
          const ph = el.getAttribute("placeholder");
          if (ph) attrs += ` placeholder="${ph}"`;
          // For interactive elements with no visible text — show alt/aria-describedby hint
          if (interactive && el.tagName === "IMG" && el.alt) attrs += ` alt="${el.alt.substring(0, 80)}"`;
          const ariaDesc = el.getAttribute("aria-describedby");
          if (ariaDesc) {
            const descEl = document.getElementById(ariaDesc);
            if (descEl) attrs += ` described="${descEl.textContent.trim().substring(0, 80)}"`;
          }

          // Self-closing for some tags
          if (["img", "input", "br", "hr"].includes(tag)) {
            return `<${tag}${attrs}/>`;
          }

          let children = "";
          // Enter shadow root INLINE (not as afterthought) — critical for Reddit/custom elements
          const getSR = window.__mcpGetShadowRoot || function(e) { return e.shadowRoot; };
          const sr = getSR(el);
          if (sr) {
            // Shadow root replaces light DOM children in rendering
            for (const child of sr.childNodes) {
              children += walk(child, depth + 1);
            }
          } else {
            for (const child of el.childNodes) {
              children += walk(child, depth + 1);
            }
          }

          // Skip wrapper-only non-interactive elements
          if (!interactive && !attrs && children && !["body", "main", "nav", "header", "footer", "section", "article", "aside", "form", "ul", "ol", "li", "table", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "span", "label"].includes(tag)) {
            return children;
          }

          if (!children.trim() && !interactive) return "";

          return `<${tag}${attrs}>${children}</${tag}>`;
        }

        const root = rootSelector ? document.querySelector(rootSelector) : document.body;
        if (!root) return "Root element not found";
        let tree = walk(root, 0);
        // Walk shadow roots that weren't caught inline (fallback for roots created AFTER monkey-patch)
        const getSR2 = window.__mcpGetShadowRoot || function(e) { return e.shadowRoot; };
        function walkShadows(node, depth) {
          if (id >= MAX_ELEMENTS) return;
          const all = node.querySelectorAll("*");
          for (const el of all) {
            const sr = getSR2(el);
            if (sr) {
              tree += walk(sr, depth);
              walkShadows(sr, depth + 1); // Recurse into nested shadow roots
            }
          }
        }
        walkShadows(root, 1);
        // Walk same-origin iframes
        const iframes = document.querySelectorAll("iframe");
        for (const iframe of iframes) {
          try {
            const doc = iframe.contentDocument;
            if (doc && doc.body) tree += walk(doc.body, 1);
          } catch (_) {}
        }
        // Store refs globally for ref-based click/fill, with generation timestamp
        window.__mcpRefs = refs;
        window.__mcpRefsTime = Date.now();
        // Warn if truncated
        if (id >= MAX_ELEMENTS) {
          tree += "\n[WARNING: Snapshot truncated at " + MAX_ELEMENTS + " elements. Use selector parameter to focus on a specific section.]";
        }
        return tree;
      }, [payload.selector || null], tabId);
    }

    // --- Double Click ---
    case "double_click": {
      return await execInTab((selector, x, y) => {
        const dq = window.__mcpDeepQuery || document.querySelector.bind(document);
        let el = null;
        if (selector) el = dq(selector);
        else if (x !== undefined && y !== undefined) el = document.elementFromPoint(x, y);
        if (!el) return "Element not found: " + (selector || "x=" + x + ",y=" + y);
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
        el.dispatchEvent(new MouseEvent("mousedown", { ...opts, detail: 2 }));
        el.dispatchEvent(new MouseEvent("mouseup", { ...opts, detail: 2 }));
        el.dispatchEvent(new MouseEvent("click", { ...opts, detail: 2 }));
        el.dispatchEvent(new MouseEvent("dblclick", { ...opts, detail: 2 }));
        return "Double-clicked: " + el.tagName;
      }, [payload.selector, payload.x, payload.y], tabId);
    }

    // --- Right Click ---
    case "right_click": {
      return await execInTab((selector, x, y) => {
        const dq = window.__mcpDeepQuery || document.querySelector.bind(document);
        let el = null;
        if (selector) el = dq(selector);
        else if (x !== undefined && y !== undefined) el = document.elementFromPoint(x, y);
        if (!el) return "Element not found: " + (selector || "x=" + x + ",y=" + y);
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: cx, clientY: cy }));
        return "Right-clicked: " + el.tagName;
      }, [payload.selector, payload.x, payload.y], tabId);
    }

    // --- Clear Field ---
    case "clear_field": {
      return await execInTab((selector) => {
        const el = (window.__mcpDeepQuery || document.querySelector.bind(document))(selector);
        if (!el) return "Element not found: " + selector;
        if (el.isContentEditable) {
          // Contenteditable: use selectAll+delete to let editor handle clearing properly
          el.focus();
          document.execCommand("selectAll", false, null);
          document.execCommand("delete", false, null);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return "Cleared (contenteditable)";
        }
        // Standard input/textarea: use native setter for React compatibility
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) { desc.set.call(el, ""); } else { el.value = ""; }
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue("x"); // Force React to see change
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        return "Cleared";
      }, [payload.selector], tabId);
    }

    // --- Select Option ---
    case "select_option": {
      return await execInTab((selector, value) => {
        const el = (window.__mcpDeepQuery || document.querySelector.bind(document))(selector);
        if (!el) return "Element not found: " + selector + " (for value: " + value + ")";
        el.focus();

        // Reset React's _valueTracker so React sees the change as "new"
        // Without this, React compares old===new and ignores the change event
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue("");

        // Use native setter to bypass React's synthetic event system
        const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
        if (desc && desc.set) { desc.set.call(el, value); } else { el.value = value; }

        // Also set selectedIndex for frameworks that track by index
        let matched = false;
        for (let i = 0; i < el.options.length; i++) {
          if (el.options[i].value === value) { el.selectedIndex = i; matched = true; break; }
        }
        // Fuzzy match: strip Unicode control chars (RTL marks, zero-width chars) and compare
        // LinkedIn uses U+200F (RLM) in option values, so "2-10" won't match "‏2‏ – ‏10‏"
        if (!matched || el.value !== value) {
          // Normalize: strip RTL marks, zero-width chars, normalize dashes & whitespace
          const norm = function(s) {
            return s.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
              .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "-") // all dashes → hyphen
              .replace(/\s*-\s*/g, "-") // normalize "2 - 10" → "2-10"
              .replace(/\s+/g, " ").trim();
          };
          const cleanValue = norm(value);
          for (let i = 0; i < el.options.length; i++) {
            if (norm(el.options[i].value) === cleanValue || norm(el.options[i].text) === cleanValue) {
              el.selectedIndex = i;
              if (desc && desc.set) { desc.set.call(el, el.options[i].value); } else { el.value = el.options[i].value; }
              matched = true;
              break;
            }
          }
          // Last resort: partial/includes match on normalized text
          if (!matched) {
            for (let i = 0; i < el.options.length; i++) {
              const nv = norm(el.options[i].value), nt = norm(el.options[i].text);
              if (nv.includes(cleanValue) || nt.includes(cleanValue) || cleanValue.includes(nv) || cleanValue.includes(nt)) {
                if (i === 0 && el.options.length > 1) continue; // skip placeholder
                el.selectedIndex = i;
                if (desc && desc.set) { desc.set.call(el, el.options[i].value); } else { el.value = el.options[i].value; }
                matched = true;
                break;
              }
            }
          }
        }

        // Full event sequence: input → change → blur (React, Angular, Vue all covered)
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        return "Selected: " + el.value + " (index " + el.selectedIndex + ")";
      }, [payload.selector, payload.value], tabId);
    }

    // --- Fill Form (multiple fields at once) ---
    case "fill_form": {
      return await execInTab((fields) => {
        const dq = window.__mcpDeepQuery || document.querySelector.bind(document);
        const results = [];
        fields.forEach(f => {
          const el = dq(f.selector);
          if (!el) { results.push("Not found: " + f.selector); return; }
          el.focus();

          // Checkbox/radio: click to toggle, with _valueTracker reset
          if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
            const want = f.value === "true" || f.value === "1" || f.value === "on";
            if (el.checked !== want) {
              const tracker = el._valueTracker;
              if (tracker) tracker.setValue(el.checked ? "true" : "");
              el.click();
            }
            results.push((el.checked ? "Checked" : "Unchecked") + ": " + (f.selector));
            return;
          }

          // SELECT element
          if (el.tagName === "SELECT") {
            const tracker = el._valueTracker;
            if (tracker) tracker.setValue("");
            const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
            if (desc && desc.set) desc.set.call(el, f.value); else el.value = f.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            results.push("Selected: " + el.value);
            return;
          }

          // Contenteditable
          if (el.isContentEditable) {
            document.execCommand("selectAll", false, null);
            document.execCommand("delete", false, null);
            document.execCommand("insertText", false, f.value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            results.push("Filled CE: " + f.value.substring(0, 30));
            return;
          }

          // Standard input/textarea with React _valueTracker reset
          const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc && desc.set) desc.set.call(el, f.value); else el.value = f.value;
          const tracker = el._valueTracker;
          if (tracker) tracker.setValue("");
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          results.push("Filled: " + el.tagName + ' "' + f.value.substring(0, 30) + '"');
        });
        return results.join("\n");
      }, [payload.fields], tabId);
    }

    // --- Scroll To ---
    case "scroll_to": {
      return await execInTab((x, y) => {
        window.scrollTo(x || 0, y || 0);
        return "Scrolled to (" + (x || 0) + ", " + (y || 0) + ")";
      }, [payload.x, payload.y], tabId);
    }

    // --- Scroll To Element ---
    case "scroll_to_element": {
      if (payload.text) {
        // Text-based scroll: scroll down until text appears in DOM (for virtual DOM/lazy loading)
        return await execInTab(async (text, block, timeout) => {
          const deadline = Date.now() + (timeout || 10000);
          const scrollable = document.querySelector('[class*="grid"],[class*="virtual"],[class*="scroll"],[role="grid"],[role="table"]') || document.scrollingElement || document.documentElement;
          let lastY = -1;
          while (Date.now() < deadline) {
            const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
            while (tw.nextNode()) {
              if (tw.currentNode.textContent.trim().includes(text)) {
                const el = tw.currentNode.parentElement;
                el.scrollIntoView({ behavior: "smooth", block: block || "center" });
                return 'Found and scrolled to: "' + el.textContent.trim().substring(0, 50) + '"';
              }
            }
            const curY = scrollable.scrollTop;
            if (curY === lastY) return "Text not found: " + text + " (scrolled to bottom)";
            lastY = curY;
            scrollable.scrollBy(0, 500);
            await new Promise(function(r) { setTimeout(r, 300); });
          }
          return "Timeout: text not found within " + timeout + "ms";
        }, [payload.text, payload.block, payload.timeout], tabId);
      }
      return await execInTab((selector, block) => {
        const el = (window.__mcpDeepQuery || document.querySelector.bind(document))(selector);
        if (!el) return "Element not found: " + selector;
        el.scrollIntoView({ block: block || "center", behavior: "smooth" });
        return "Scrolled to: " + el.tagName;
      }, [payload.selector, payload.block], tabId);
    }

    // --- Replace Editor Content (Monaco, CodeMirror, Ace) ---
    case "replace_editor": {
      return await execInTab((newText) => {
        const lineCount = newText.split("\n").length;

        // Monaco editor — try multiple access paths
        // Some sites (Airtable) expose 'monaco' global but not window.monaco
        // Some don't have getEditors() but do have getModels()
        const m = (typeof monaco !== "undefined") ? monaco : window.monaco;
        if (m && m.editor) {
          // Try getModels first (works on Airtable and most Monaco embeds)
          try {
            const models = m.editor.getModels();
            if (models && models.length > 0) {
              models[models.length - 1].setValue(newText);
              return "Monaco(model): replaced " + lineCount + " lines";
            }
          } catch (_) {}
          // Try getEditors (standard Monaco API)
          try {
            const eds = m.editor.getEditors();
            if (eds && eds.length > 0) {
              eds[eds.length - 1].setValue(newText);
              return "Monaco(editor): replaced " + lineCount + " lines";
            }
          } catch (_) {}
        }

        // CodeMirror 6
        const cm6Els = document.querySelectorAll(".cm-editor");
        for (let i = cm6Els.length - 1; i >= 0; i--) {
          const cmView = cm6Els[i].cmView;
          if (cmView && cmView.view) {
            const v = cmView.view;
            v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: newText } });
            return "CodeMirror6: replaced " + lineCount + " lines";
          }
        }

        // CodeMirror 5
        const cm5El = document.querySelector(".CodeMirror");
        if (cm5El && cm5El.CodeMirror) {
          cm5El.CodeMirror.setValue(newText);
          return "CodeMirror5: replaced " + lineCount + " lines";
        }

        // Ace editor
        if (typeof ace !== "undefined" || window.ace) {
          const aceRef = (typeof ace !== "undefined") ? ace : window.ace;
          const aceEls = document.querySelectorAll(".ace_editor");
          if (aceEls.length > 0) {
            const aceEd = aceRef.edit(aceEls[aceEls.length - 1]);
            aceEd.setValue(newText, -1);
            return "Ace: replaced " + lineCount + " lines";
          }
        }

        // Fallback: contentEditable
        const el = document.activeElement;
        if (el && el.isContentEditable) {
          el.textContent = "";
          document.execCommand("selectAll");
          document.execCommand("insertText", false, newText);
          return "ContentEditable: replaced";
        }

        return "No code editor found on page";
      }, [payload.text], tabId);
    }

    // --- Get Element Info ---
    case "get_element": {
      return await execInTab((selector) => {
        const el = (window.__mcpDeepQuery || document.querySelector.bind(document))(selector);
        if (!el) return "Element not found: " + selector;
        const cs = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        return JSON.stringify({
          tag: el.tagName, text: (el.innerText || "").substring(0, 200),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          visible: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0,
          attrs, value: el.value, checked: el.checked, disabled: el.disabled,
        });
      }, [payload.selector], tabId);
    }

    // --- Query All ---
    case "query_all": {
      return await execInTab((selector, limit) => {
        const els = (window.__mcpDeepQueryAll || document.querySelectorAll.bind(document))(selector, limit);
        const results = [];
        for (let i = 0; i < Math.min(els.length, limit); i++) {
          const el = els[i];
          const r = el.getBoundingClientRect();
          results.push({
            index: i, tag: el.tagName,
            text: (el.innerText || "").substring(0, 100),
            href: el.href || "", value: el.value || "",
            visible: r.width > 0 && r.height > 0,
          });
        }
        return JSON.stringify(results);
      }, [payload.selector, payload.limit || 20], tabId);
    }

    default:
      throw new Error("Unknown command: " + type);
  }
}

// ========== HELPERS ==========

let _cachedTabId = null;
let _cachedTabUrl = null;
let _cachedTabTime = 0;
const TAB_CACHE_MS = 3000; // Re-verify tab URL match every 3s

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  // Only cache tab activations from the profile window — prevents cross-profile poisoning
  if (_profileWindowId && windowId !== _profileWindowId) return;
  _cachedTabId = tabId;
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (_cachedTabId === tabId) { _cachedTabId = null; _cachedTabUrl = null; }
});

// Discover which windowId belongs to the target profile.
// Safari extensions are per-profile — browser.windows/tabs APIs only see this profile's windows.
// We still need to pin _profileWindowId so commands don't drift to wrong window on focus changes.
async function _discoverProfileWindow() {
  if (!_targetProfile) return;
  try {
    const allWindows = await browser.windows.getAll();

    // Single window — use it (most common case)
    if (allWindows.length === 1) {
      _profileWindowId = allWindows[0].id;
      console.log("Safari MCP: profile window (single):", _profileWindowId);
      return;
    }

    // Multiple windows — prefer the focused one, fall back to first
    const focused = allWindows.find(w => w.focused);
    _profileWindowId = focused ? focused.id : allWindows[0].id;
    console.log("Safari MCP: profile window (multi, focused=" + !!focused + "):", _profileWindowId);
  } catch (err) {
    console.warn("Safari MCP: _discoverProfileWindow error:", err.message);
  }
}

async function getTargetTab(tabUrl) {
  // PRIORITY 1: Always prefer _cachedTabId from switch_tab — this is the "intent" tab.
  // URL matching can pick the WRONG tab when multiple tabs share a domain.
  // switch_tab sets _cachedTabId to the exact tab the user wants.
  if (_cachedTabId && (Date.now() - _cachedTabTime) < TAB_CACHE_MS) {
    try {
      const cached = await browser.tabs.get(_cachedTabId);
      if (cached && (!_profileWindowId || cached.windowId === _profileWindowId)) return cached;
    } catch { _cachedTabId = null; }
  }

  // PRIORITY 2: URL-based search (when no switch_tab was called, or cache expired)
  if (tabUrl) {
    const searchScope = _profileWindowId ? { windowId: _profileWindowId } : {};
    let all = await browser.tabs.query(searchScope);
    let match = all.find(t => t.url && (t.url.startsWith(tabUrl) || tabUrl.startsWith(t.url.split("?")[0])));
    if (!match && _profileWindowId) {
      all = await browser.tabs.query({});
      match = all.find(t => t.url && (t.url.startsWith(tabUrl) || tabUrl.startsWith(t.url.split("?")[0])));
    }
    if (match) {
      _cachedTabId = match.id;
      _cachedTabUrl = tabUrl;
      _cachedTabTime = Date.now();
      if (!_profileWindowId || match.windowId !== _profileWindowId) {
        if (_profileWindowId && match.windowId !== _profileWindowId) {
          console.log("Safari MCP: profile window changed:", _profileWindowId, "→", match.windowId);
        }
        _profileWindowId = match.windowId;
        console.log("Safari MCP: profile windowId =", _profileWindowId);
      }
      return match;
    }
  }
  // If we know the profile window, get its active tab (not the user's personal window)
  if (_profileWindowId) {
    const tabs = await browser.tabs.query({ active: true, windowId: _profileWindowId });
    if (tabs[0]) {
      _cachedTabId = tabs[0].id;
      return tabs[0];
    }
    // Profile window may have been closed and reopened — re-discover
    console.warn("Safari MCP: profile window has no active tab, re-discovering...");
    await _discoverProfileWindow();
    if (_profileWindowId) {
      const retryTabs = await browser.tabs.query({ active: true, windowId: _profileWindowId });
      if (retryTabs[0]) {
        _cachedTabId = retryTabs[0].id;
        return retryTabs[0];
      }
    }
  }
  return getActiveTab();
}

async function getActiveTab() {
  if (_cachedTabId !== null) {
    try {
      const tab = await browser.tabs.get(_cachedTabId);
      return tab; // Return even if not active — it's in the right window
    } catch {}
    _cachedTabId = null;
  }
  // Prefer profile window if known
  if (_profileWindowId) {
    const tabs = await browser.tabs.query({ active: true, windowId: _profileWindowId });
    if (tabs[0]) {
      _cachedTabId = tabs[0].id;
      return tabs[0];
    }
  }
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) throw new Error("No active tab");
  _cachedTabId = tabs[0].id;
  return tabs[0];
}

async function execInTab(func, args = [], tabId = null) {
  const id = tabId || (await getActiveTab()).id;
  try {
    // Auto-inject deep query helpers (idempotent — only defines once per page)
    await browser.scripting.executeScript({
      target: { tabId: id },
      world: "MAIN",
      func: _deepQueryScript,
    }).catch(() => {});

    const results = await browser.scripting.executeScript({
      target: { tabId: id },
      world: "MAIN",
      func,
      args,
    });
    return results[0]?.result;
  } catch (err) {
    console.error("execInTab error on tabId=" + id + ":", err.message);
    throw new Error("execInTab failed: " + err.message);
  }
}

// Execute in ALL frames (including cross-origin iframes) — for GBP, embedded editors etc.
async function execInAllFrames(func, args = [], tabId = null) {
  const id = tabId || (await getActiveTab()).id;
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: id, allFrames: true },
      world: "MAIN",
      func,
      args,
    });
    // Return first non-null result from any frame
    for (const r of results) {
      if (r.result !== null && r.result !== undefined) return r.result;
    }
    return null;
  } catch (err) {
    // allFrames may fail on some pages — fall back to main frame only
    return execInTab(func, args, tabId);
  }
}

function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    function cleanup() {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(updateListener);
      browser.tabs.onRemoved.removeListener(removeListener);
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeout);

    function updateListener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    }

    function removeListener(id) {
      if (id === tabId) {
        cleanup();
        resolve(); // Tab was closed — no point waiting
      }
    }

    browser.tabs.onUpdated.addListener(updateListener);
    browser.tabs.onRemoved.addListener(removeListener);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Shared deep query helpers — injected into execInTab functions
// Searches: main document → shadow roots (recursive) → same-origin iframes
function _deepQueryScript() {
  // Only define once per page
  if (window.__mcpDeepQuery) return;
  window.__mcpDeepQuery = function(selector) {
    let el = document.querySelector(selector);
    if (el) return el;
    // Recursive shadow DOM (supports closed roots via monkey-patched getter)
    var getSR = window.__mcpGetShadowRoot || function(e) { return e.shadowRoot; };
    function searchShadow(root) {
      var all = root.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        var sr = getSR(all[i]);
        if (sr) {
          el = sr.querySelector(selector);
          if (el) return el;
          el = searchShadow(sr);
          if (el) return el;
        }
      }
      return null;
    }
    el = searchShadow(document);
    if (el) return el;
    // Same-origin iframes
    const iframes = document.querySelectorAll("iframe");
    for (let i = 0; i < iframes.length; i++) {
      try {
        const doc = iframes[i].contentDocument;
        if (doc) { el = doc.querySelector(selector); if (el) return el; }
      } catch (_) {}
    }
    return null;
  };
  // React state sync helper — use after innerHTML/DOM changes to trigger React re-render
  // Usage in evaluate: window.__mcpReactSync(document.querySelector('#myEl'), 'new value')
  window.__mcpReactSync = function(el, value) {
    if (!el) return false;
    // For input/textarea: use native setter + React's synthetic events
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
      : el.tagName === "INPUT" ? HTMLInputElement.prototype : null;
    if (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) { desc.set.call(el, value); }
      else { el.value = value; }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    // For contenteditable / other elements: trigger React Fiber reconciliation
    const keys = Object.keys(el);
    const pk = keys.find(function(k) { return k.startsWith("__reactProps$"); });
    if (pk && el[pk] && el[pk].onChange) {
      el[pk].onChange({ target: el, currentTarget: el, type: "change" });
      return true;
    }
    // Fallback: dispatch input events
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };

  window.__mcpDeepQueryAll = function(selector, limit) {
    const results = [];
    function collect(root) {
      root.querySelectorAll(selector).forEach(el => { if (results.length < limit) results.push(el); });
      root.querySelectorAll("*").forEach(el => {
        if (el.shadowRoot) collect(el.shadowRoot);
      });
    }
    collect(document);
    // Same-origin iframes
    document.querySelectorAll("iframe").forEach(iframe => {
      try { if (iframe.contentDocument) collect(iframe.contentDocument); } catch (_) {}
    });
    return results;
  };
}

// Smart wait for navigation: checks if tab starts loading, waits for complete
// Much faster than fixed 500ms sleep for SPAs (no navigation = ~50ms)
async function waitForTabSettled(tabId, timeout = 3000) {
  // Brief pause to let navigation start
  await sleep(50);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (tab?.status === "loading") {
    await waitForTabLoad(tabId, timeout);
  }
  // No else needed — if not loading, page is already settled
}

// ========== KEEP-ALIVE VIA ALARMS ==========
// Safari kills service workers after ~30s of inactivity.
// browser.alarms re-wakes the worker and reconnects if needed.
// The active fetch() in pollForCommands() keeps the worker alive while connected.
browser.alarms.create("keepalive", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" || alarm.name === "reconnect") {
    if (!isConnected && _enabled) {
      connect();
    }
  }
});

// ========== STARTUP ==========
console.log("Safari MCP Bridge: service worker started");
updateBadge("");
// Wait for storage to load before connecting (prevents race condition with _enabled)
_startupReady.then(() => {
  if (_enabled) connect();
  else updateBadge("OFF");
}).catch(() => connect());
