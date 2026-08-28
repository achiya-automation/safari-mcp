// Safari MCP Bridge — Background Service Worker
// Uses HTTP long-polling to communicate with MCP server
// Safari terminates idle service workers after ~30s, so we keep an active fetch() going

// Each Safari profile can have its own MCP daemon. The extension worker is also
// profile-scoped, so it discovers the daemon whose declared profile matches its
// stored identity instead of letting whichever daemon won port 9224 own every profile.
const BRIDGE_PORTS = [9224, 9228, 9232, 9236];
let HTTP_URL = `http://127.0.0.1:${BRIDGE_PORTS[0]}`;
let isConnected = false;
let pollAbort = null;
let _bridgeAuthTokenPromise = null;
const _bridgeWorkerId = (() => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
})();
let _bridgeWorkerSuperseded = false;
const _BRIDGE_RELOAD_HANDOFF_KEY = "mcpBridgeReloadHandoffV1";

async function _storedReloadHandoffToken() {
  let stored;
  try {
    stored = await browser.storage.local.get(_BRIDGE_RELOAD_HANDOFF_KEY);
  } catch {
    return "";
  }
  const record = stored?.[_BRIDGE_RELOAD_HANDOFF_KEY];
  const token = String(record?.token || "");
  const issuedAt = Number(record?.issuedAt) || 0;
  return /^[A-Za-z0-9_-]{24,}$/.test(token) && Date.now() - issuedAt <= 30000
    ? token
    : "";
}

async function _bridgeAuthToken() {
  if (!_bridgeAuthTokenPromise) {
    _bridgeAuthTokenPromise = fetch(browser.runtime.getURL("bridge-auth-token"), {
      cache: "no-store",
    }).then(async (response) => {
      if (!response.ok) throw new Error("Safari MCP bridge authentication resource is unavailable");
      const token = (await response.text()).trim();
      if (!/^[0-9a-f]{64}$/.test(token)) {
        throw new Error("Safari MCP bridge authentication resource is invalid");
      }
      return token;
    }).catch((error) => {
      _bridgeAuthTokenPromise = null;
      throw error;
    });
  }
  return _bridgeAuthTokenPromise;
}

async function _bridgeFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Safari-MCP-Token", await _bridgeAuthToken());
  headers.set("X-Safari-MCP-Worker", _bridgeWorkerId);
  return fetch(url, { ...init, headers });
}
let _targetProfile = null;   // Profile name from server (e.g. "Automations")
let _profileWindowId = null; // Discovered windowId for the profile (shared default)
// Per-session profile window. One Safari profile can hold SEVERAL windows once
// parallel Claude sessions have been running for a while — measured 23.8.26: three
// "אוטומציות" windows at once. With a single shared _profileWindowId, a session whose
// tab lived in window B was told "a same-URL tab exists in another window — refusing
// to cross windows" and could not reach its OWN tab. A session adopts a window only by
// opening a tab there or proving an exact tab it already owns, never by URL or focus.
const _sessionWindowIds = new Map();
function _windowForSession(sessionId) {
  const own = _sessionWindowIds.get(sessionId || _DEFAULT_SESSION);
  return own || _profileWindowId;
}
function _adoptWindowForSession(sessionId, windowId) {
  if (!windowId) return;
  _sessionWindowIds.set(sessionId || _DEFAULT_SESSION, windowId);
}

function _windowQuery(windowId) {
  return windowId ? { windowId } : { currentWindow: true };
}

function _safeTabUrl(rawUrl) {
  const raw = String(rawUrl || "");
  if (!raw) return "unknown";
  if (raw === "about:blank") return raw;
  try {
    const parsed = new URL(raw);
    if (/^https?:$/.test(parsed.protocol)) return parsed.origin + parsed.pathname;
    return parsed.protocol ? parsed.protocol.replace(/:$/, "") + ":" : "unknown";
  } catch {
    return "unknown";
  }
}

function _receiptOrigin(rawUrl) {
  const raw = String(rawUrl || "");
  if (raw === "about:blank") return raw;
  try {
    const parsed = new URL(raw);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
  } catch {
    return "";
  }
}

function _receiptTokenFromPayload(payload) {
  const direct = String(payload?.receipt || "");
  if (/^[A-Za-z0-9_-]{24,}$/.test(direct)) return direct;
  // Backward-compatible input only. The synthetic URL is never navigated to and its
  // origin/path are not authorization evidence; only the extension-minted token is.
  return _extractMcpTabMarker(payload?.receiptUrl || payload?.url || payload?.tabUrl || "");
}

async function _listTabsForSession(sessionId) {
  const tabs = await browser.tabs.query(_windowQuery(_windowForSession(sessionId)));
  return tabs.map((tab) => {
    const receipt = _receiptForOwnedTab(sessionId, tab);
    return {
      index: tab.index + 1,
      title: tab.title,
      safeUrl: _safeTabUrl(tab.url),
      ...(receipt ? { receipt } : {}),
      active: tab.active,
    };
  });
}

async function _newTabForSession(sessionId, payload) {
  const sid = sessionId || _DEFAULT_SESSION;
  const hadSessionWindow = _sessionWindowIds.has(sid);
  const preferredWindowId = _windowForSession(sessionId);
  let profileWindow = preferredWindowId
    ? await browser.windows.get(preferredWindowId).catch(() => null)
    : null;

  if (!profileWindow) {
    const existingWindows = await browser.windows.getAll();
    profileWindow = existingWindows[0] || null;
  }

  let newTab;
  if (!profileWindow) {
    // The extension worker is scoped to this Safari profile, so a WebExtension
    // window created here belongs to the verified profile. `focused: false`
    // keeps the recovery entirely in the background and avoids UI scripting.
    profileWindow = await browser.windows.create({ url: "about:blank", focused: false });
    const bootstrapTabs = profileWindow.tabs?.length
      ? profileWindow.tabs
      : await browser.tabs.query({ windowId: profileWindow.id });
    newTab = bootstrapTabs[0] || await browser.tabs.create({
      url: "about:blank",
      active: false,
      windowId: profileWindow.id,
    });
  } else {
    newTab = await browser.tabs.create({
      url: "about:blank",
      active: false,
      windowId: profileWindow.id,
    });
  }

  const openedWindowId = newTab.windowId || profileWindow.id;
  // A session that already owns a window must not move the shared default for every
  // other session merely because it opened another tab in its own window.
  if (!_profileWindowId || !hadSessionWindow) {
    _profileWindowId = openedWindowId;
    browser.storage.local.set({ mcpProfileWindowId: _profileWindowId }).catch(() => {});
  }
  _adoptWindowForSession(sessionId, openedWindowId);

  const rawNavigationUrl = String(payload.url || "");
  const trackUrl = rawNavigationUrl || newTab.url || "about:blank";
  _setSessionTab(sessionId, newTab.id, trackUrl);
  await _addOwnedTab(sessionId, newTab.id);
  // Ownership is durable before navigation starts. Do not await a slow navigation:
  // Safari may otherwise hold this command past the bridge timeout. tabs.update itself
  // resolves once Safari accepts the new URL; it does not wait for the page load. Minting
  // before this point bound the receipt digest to about:blank, so the first real command
  // could see the destination URL and reject its own freshly issued receipt as stale.
  let receiptTab = newTab;
  if (rawNavigationUrl && rawNavigationUrl !== "about:blank") {
    // Pass the caller's exact string. Parsing is permitted for validation/output, but
    // serializing it would corrupt signed query bytes and application fragments.
    const acceptedTab = await browser.tabs.update(newTab.id, { url: rawNavigationUrl }).catch(() => {
      console.warn("Safari MCP: new tab navigation failed");
      return null;
    });
    if (acceptedTab) receiptTab = acceptedTab;
  }
  const receiptIdentity = receiptTab.url || rawNavigationUrl || "about:blank";
  const receipt = await _issueTabReceipt(receiptTab, {
    receiptOrigin: _receiptOrigin(receiptIdentity),
    identityUrl: receiptIdentity,
  });
  return {
    title: newTab.title || "",
    safeUrl: _safeTabUrl(receiptIdentity),
    ...(receipt ? { receipt } : {}),
    tabIndex: newTab.index + 1,
  };
}

async function _openPopupTabForSession(sessionId, sourceTab, rawPopupUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawPopupUrl || ""));
  } catch {
    throw new Error("Captured popup URL is invalid");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Captured popup URL must use HTTP(S)");
  }
  const sourceTabId = Number(sourceTab?.id);
  if (!Number.isInteger(sourceTabId)) {
    throw new Error("Popup source tab identity is unavailable");
  }

  // The exact URL, including signed query bytes, stays inside the extension worker.
  // Never stringify or log it. browser.tabs.create is profile-scoped here and
  // `active:false` keeps Safari and the user's foreground application untouched.
  // openerTabId preserves the direct OAuth child relationship without a native click.
  let popupTab;
  try {
    popupTab = await browser.tabs.create({
      url: String(rawPopupUrl),
      active: false,
      windowId: sourceTab.windowId,
      openerTabId: sourceTabId,
    });
  } catch {
    // Safari may create a tab and then reject the promise while navigation is still
    // progressing. The click is deliberately one-shot, so never retry automatically.
    throw new Error("Popup tab creation outcome is unknown; refusing automatic retry");
  }

  // Safari 14+ supports openerTabId, but fail closed if this concrete tab does not
  // report the direct relationship. Never adopt a nearby tab by URL or creation time.
  const linkedPopup = Number(popupTab?.openerTabId) === sourceTabId
    ? popupTab
    : await browser.tabs.get(popupTab.id).catch(() => null);
  if (!linkedPopup || Number(linkedPopup.openerTabId) !== sourceTabId) {
    // This exact tab was created by the call above and has not been granted ownership.
    // Remove the unusable OAuth child so it cannot be mistaken for a successful flow.
    await browser.tabs.remove(popupTab.id).catch(() => {});
    throw new Error("Safari did not preserve the direct OAuth opener; popup was closed");
  }
  popupTab = linkedPopup;

  _adoptWindowForSession(sessionId, popupTab.windowId || sourceTab.windowId);
  _setSessionTab(sessionId, popupTab.id, popupTab.url || String(rawPopupUrl));
  await _addOwnedTab(sessionId, popupTab.id);

  const identityUrl = popupTab.url || String(rawPopupUrl);
  const receipt = await _issueTabReceipt(popupTab, {
    receiptOrigin: _receiptOrigin(identityUrl),
    identityUrl,
  });
  return {
    clicked: true,
    popupOpened: true,
    title: popupTab.title || "",
    safeUrl: _safeTabUrl(identityUrl),
    ...(receipt ? { receipt } : {}),
    tabIndex: popupTab.index + 1,
  };
}

async function _closeTabForSession(sessionId, targetTab, payload) {
  const explicitIndex = Number.isInteger(Number(payload.index)) && Number(payload.index) > 0;
  // An explicit index is local to the session's window. Without one, targetTab is
  // already the concrete ownership-checked tab, so its own window is authoritative.
  const closeWindowId = explicitIndex
    ? (_windowForSession(sessionId) || targetTab?.windowId)
    : (targetTab?.windowId || _windowForSession(sessionId));
  const windowTabs = await browser.tabs.query(_windowQuery(closeWindowId));
  const isLastTab = windowTabs.length <= 1;

  if (explicitIndex) {
    const requestedIndex = Number(payload.index);
    const target = windowTabs.find((tab) => tab.index + 1 === requestedIndex)
      || windowTabs[requestedIndex - 1];
    if (!target) return "Tab not found at index " + requestedIndex;
    if (payload._receiptTabId && target.id !== payload._receiptTabId) {
      throw new Error("Tab safety: receipt and requested index identify different tabs");
    }
    if (payload._receiptTabId && !_isTabOwnedBySession(sessionId, target.id)) {
      await _addOwnedTab(sessionId, target.id);
    }
    if (!_isTabOwnedBySession(sessionId, target.id)) {
      throw new Error(`⚠️ Tab safety: refusing to close tab ${requestedIndex} (${_safeTabUrl(target.url)}) — not opened by this MCP session.`);
    }
    await _removeOwnedTab(sessionId, target.id);
    if (isLastTab) {
      await browser.tabs.update(target.id, { url: "about:blank" });
      return "Last remaining tab blanked instead of closed (closing it would quit Safari)";
    }
    await browser.tabs.remove(target.id);
    return "Tab closed";
  }

  if (payload._receiptTabId && !_isTabOwnedBySession(sessionId, targetTab.id)) {
    await _addOwnedTab(sessionId, targetTab.id);
  }
  await _removeOwnedTab(sessionId, targetTab.id);
  if (isLastTab) {
    await browser.tabs.update(targetTab.id, { url: "about:blank" });
    return "Last remaining tab blanked instead of closed (closing it would quit Safari)";
  }
  await browser.tabs.remove(targetTab.id);
  return "Tab closed";
}

async function _switchTabForSession(sessionId, targetTab, payload) {
  const suppliedReceipt = _receiptTokenFromPayload(payload);
  let target;

  if (suppliedReceipt) {
    // handleCommand resolves receipts against browser.tabs.query({}), so this is the
    // exact global tab identity even when an OAuth popup moved the session's logical
    // window elsewhere. The receipt is the authority; a stale/window-local index must
    // never redirect the switch to a neighbouring tab.
    if (!targetTab || !Number.isInteger(Number(targetTab.id))) {
      throw new Error("Tab safety: receipt did not resolve to a live tab");
    }
    target = targetTab;
  } else {
    const requestedIndex = Number(payload.index);
    if (!Number.isInteger(requestedIndex) || requestedIndex < 1) {
      throw new Error("switch_tab requires a positive index or a valid receipt");
    }
    const switchWindowId = _windowForSession(sessionId) || targetTab?.windowId;
    const tabs = await browser.tabs.query(_windowQuery(switchWindowId));
    target = tabs.find((tab) => tab.index + 1 === requestedIndex)
      || tabs[requestedIndex - 1];
    if (!target) return "Tab not found at index " + requestedIndex;
  }

  if (!_isTabOwnedBySession(sessionId, target.id)) {
    if (suppliedReceipt && targetTab && target.id === targetTab.id) {
      await _addOwnedTab(sessionId, target.id);
    } else {
      throw new Error(`⚠️ Tab safety: refusing "switch_tab" to tab ${target.id} (${_safeTabUrl(target.url)}) — not opened by this MCP session. Use safari_new_tab first.`);
    }
  }
  // Do not visually activate the tab. Extension APIs work on background tabs; only
  // the session's logical target and window need to change.
  _adoptWindowForSession(sessionId, target.windowId);
  _setSessionTab(sessionId, target.id, target.url);
  return {
    title: target.title,
    safeUrl: _safeTabUrl(target.url),
    ...(_receiptForOwnedTab(sessionId, target) ? { receipt: _receiptForOwnedTab(sessionId, target) } : {}),
    tabIndex: target.index + 1,
    owned: true,
  };
}
let _enabled = true;         // Toggle from popup — when false, stops polling and rejects commands
let _reconnectTimer = null;  // Single reconnect timer — prevents exponential growth
let _reconnectDelay = 3000;  // Current backoff delay (resets on successful connect)
const _RECONNECT_MAX = 60000; // Max backoff: 60 seconds

// Profile verification used to persist the server's raw AppleScript verdict, e.g.
// "wrong:אוטומציות — Start Page". When another profile happened to own port 9224,
// that value permanently poisoned the *correct* profile on every later reconnect.
// Reduce both the old verdict and the current format to the stable profile name so
// an extension can reuse a previously proven identity without Apple Events/TCC.
function _canonicalProfileName(value) {
  let name = String(value || "").normalize("NFC").trim();
  if (!name || name === "notfound" || name === "__personal__") return "";
  name = name.replace(/^wrong:/, "").trim();
  const titleSeparator = name.indexOf(" — ");
  if (titleSeparator > 0) name = name.slice(0, titleSeparator);
  return name.normalize("NFC").trim();
}

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
      if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
      _reconnectDelay = 3000;
      _stopHeartbeat();
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

let _connecting = false; // re-entrancy lock — the startup promise and the alarm can race into connect()
async function connect() {
  if (!_enabled || _bridgeWorkerSuperseded) return;
  // One connect at a time: two near-simultaneous calls (cold start + alarm wake)
  // could each spawn a poll loop before the other assigned pollAbort.
  if (_connecting) return;
  _connecting = true;
  // Cancel any existing poll
  if (pollAbort) {
    try { pollAbort.abort(); } catch {}
    pollAbort = null;
  }

  const storedBridge = await browser.storage.local.get("mcpBridgeUrl").catch(() => ({}));
  const candidates = [
    storedBridge.mcpBridgeUrl,
    ...BRIDGE_PORTS.map((port) => `http://127.0.0.1:${port}`),
  ].filter((url, index, all) => url && all.indexOf(url) === index);

  for (const candidate of candidates) {
    try {
      HTTP_URL = candidate;
      // Version the handshake in the URL so stale workers still cached by Safari are
      // rejected before they reach the legacy profile probe that creates a visible tab.
      // The optional reload capability travels in a header and is never logged or put in
      // a URL; the localhost bridge explicitly permits that one preflighted header.
      const reloadHandoffToken = await _storedReloadHandoffToken();
      const connectHeaders = reloadHandoffToken
        ? { "X-Safari-MCP-Reload-Handoff": reloadHandoffToken }
        : {};
      const res = await _bridgeFetch(`${HTTP_URL}/connect?verifier=existing-tab-v1&protocol=popup-opener-lease-v2`, {
        method: "POST",
        headers: connectHeaders,
        signal: AbortSignal.timeout(1500),
      });
      if (!res.ok) continue;

      const data = await res.json().catch(() => ({}));
      if (data.profile) {
        _targetProfile = data.profile;
        // Safari runs a separate service worker per profile. Reject this daemon and
        // keep scanning when its target does not match the worker's proven identity.
        const isCorrectProfile = await _verifyProfileMatch(data.profile);
        if (!isCorrectProfile) {
          console.log(`Safari MCP: bridge ${candidate} wants profile "${data.profile}" — trying next bridge`);
          continue;
        }
        const verifiedResponse = await _bridgeFetch(`${HTTP_URL}/extension-verified`, {
          method: "POST",
          signal: AbortSignal.timeout(1500),
        }).catch(() => null);
        if (!verifiedResponse?.ok) {
          if (verifiedResponse?.status === 423) {
            // The current lease holder is still healthy. This worker may be the valid
            // successor after that holder exits, so back off and retry instead of
            // permanently classifying itself as superseded.
            isConnected = false;
            updateBadge("");
            _stopHeartbeat();
            scheduleReconnect();
            _connecting = false;
            return;
          }
          continue;
        }
        await _discoverProfileWindow();
      }

      await browser.storage.local.remove(_BRIDGE_RELOAD_HANDOFF_KEY).catch(() => {});
      await browser.storage.local.set({ mcpBridgeUrl: HTTP_URL }).catch(() => {});
      isConnected = true;
      _reconnectDelay = 3000; // Reset backoff on success
      updateBadge("ON");
      _startHeartbeat(); // Keep service worker alive between polls
      _connecting = false;
      pollForCommands();
      return;
    } catch {}
  }

  // No matching server available — retry with exponential backoff.
  isConnected = false;
  updateBadge("");
  scheduleReconnect();
  _connecting = false;
}

function scheduleReconnect() {
  if (!_enabled || _bridgeWorkerSuperseded) return;
  // Cancel any existing reconnect to prevent exponential growth
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

  // Single timer with exponential backoff (3s → 6s → 12s → ... → 60s max)
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, _reconnectDelay);
  _reconnectDelay = Math.min(_reconnectDelay * 2, _RECONNECT_MAX);

  // Alarm as backup — wakes terminated service worker (Safari minimum 1 minute)
  try {
    browser.alarms.create("reconnect", { delayInMinutes: 1 });
  } catch {}
}

async function pollForCommands() {
  while (isConnected && _enabled) {
    try {
      pollAbort = new AbortController();
      // Long-poll: server holds connection open until a command arrives or timeout
      // This active fetch keeps the service worker alive in Safari
      // 90s safety timeout prevents stuck connections from blocking forever
      const timeout = setTimeout(() => pollAbort.abort(), 90000);
      const res = await _bridgeFetch(`${HTTP_URL}/poll`, {
        signal: pollAbort.signal,
      });
      clearTimeout(timeout);
      if (res.status === 423) {
        // A replacement worker completed profile verification. This stale worker must
        // stay dormant until Safari reloads it; reconnecting would steal the lease back.
        _bridgeWorkerSuperseded = true;
        isConnected = false;
        updateBadge("");
        _stopHeartbeat();
        return;
      }
      if (res.status === 401 || res.status === 403 || res.status === 409) {
        isConnected = false;
        updateBadge("");
        scheduleReconnect();
        return;
      }
      if (res.status === 200) {
        // A single malformed/truncated body must NOT tear down the poll loop — a bad
        // packet used to throw SyntaxError here, fall through to "server gone", and
        // trigger a multi-second reconnect backoff. Skip the bad packet and keep polling.
        const msg = await res.json().catch(() => null);
        // executeAndReply blocks this loop, so /poll goes silent for as long as the
        // command runs. On a heavy DOM (facebook.com) that passes the server's 30s
        // stale threshold and the server kills the connection — draining the very
        // command still executing here. Beat while busy so it knows we are alive.
        // NOT the same as _startHeartbeat(): that one pokes storage.local to stop Safari
        // suspending the worker, and runs unconditionally. This one must fire ONLY while a
        // command is in flight — an unconditional beat would refresh the server's stale
        // clock forever and mask a genuinely dead worker.
        if (msg) {
          const beat = setInterval(() => {
            _bridgeFetch(`${HTTP_URL}/heartbeat`, { method: "POST" }).catch(() => {});
          }, 5000);
          try { await executeAndReply(msg); } finally { clearInterval(beat); }
        }
      }
      // 204 = no command, loop immediately to keep connection active
    } catch (err) {
      if (err.name === "AbortError") {
        // 90s safety-timeout abort while still connected — continue the loop in place.
        // (Re-calling pollForCommands() here risked two overlapping loops posting dup results.)
        if (isConnected && _enabled) continue;
        return; // Intentional abort (disable/new connect)
      }
      // Server gone — reconnect via shared scheduler (prevents duplicate timers)
      isConnected = false;
      updateBadge("");
      console.log("Safari MCP: poll failed, reconnecting...", err.message);
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
    const resultAck = await _bridgeFetch(`${HTTP_URL}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
      signal: AbortSignal.timeout(5000),
    });
    if (!resultAck.ok) {
      throw new Error(`Result rejected with status ${resultAck.status}`);
    }
    // Reload only after the host acknowledges the result. For reload_extension that
    // acknowledgement proves the one-use successor lease was armed first.
    if (msg.type === "reload_extension" && !response.error) {
      // Stop the poll loop before yielding to the reload timer. Otherwise this worker
      // can fetch one more non-idempotent command during the short handoff window and
      // runtime.reload() would terminate it without a result.
      isConnected = false;
      _stopHeartbeat();
      setTimeout(() => {
        try {
          browser.runtime.reload();
        } catch (_) {
          try { chrome.runtime.reload(); } catch (_) { scheduleReconnect(); }
        }
      }, 50);
    }
  } catch (err) {
    console.warn("Safari MCP Bridge: failed to send result to server:", err.message);
  }
}

// ========== COMMAND HANDLERS ==========

async function handleCommand(type, payload) {
  const sessionId = payload.sessionId || _DEFAULT_SESSION;
  // Worker maintenance is deliberately tab-independent. In particular, a stale
  // active-tab receipt or an unrelated Safari window must never make the one command
  // that can load newly installed code impossible to run.
  if (type === "reload_extension") {
    const reloadHandoff = String(payload.reloadHandoff || "");
    if (!/^[A-Za-z0-9_-]{24,}$/.test(reloadHandoff)) {
      throw new Error("Reload handoff authority is unavailable");
    }
    await _hydrateOwnedTabs();
    // Checkpoint every already-authorized tab before the worker disappears. This does
    // not grant ownership and does not move receiptOrigin across redirects.
    await _refreshAllReceiptIdentities();
    await browser.storage.local.set({
      [_BRIDGE_RELOAD_HANDOFF_KEY]: { token: reloadHandoff, issuedAt: Date.now() },
    });
    return { reloaded: true, version: browser.runtime.getManifest().version };
  }
  // Receipt-based targeting depends on durable ownership state, so hydrate it
  // before resolving the tab (not only before consulting the write guard).
  await _hydrateOwnedTabs();
  const suppliedReceipt = (type === "new_tab" || type === "list_tabs")
    ? ""
    : _receiptTokenFromPayload(payload);
  const allowReceiptOriginChange = type === "get_tab_receipt";
  let receiptResolved = false;
  // new_tab CREATES its target, so a failure to resolve an existing one must not stop
  // it. Once a profile holds several windows, resolution legitimately fails with
  // "a same-URL tab exists in another window" — which used to make new_tab, the very
  // command that recovers from that state, unusable.
  let targetTab;
  try {
    if (suppliedReceipt) {
      targetTab = await _resolveReceiptTab(suppliedReceipt, {
        allowOriginChange: allowReceiptOriginChange,
      });
      if (!targetTab) {
        throw new Error("Tab safety: receipt is forged, stale, ambiguous, or not valid for this origin");
      }
      receiptResolved = true;
      payload._receiptTabId = targetTab.id;
      // A valid receipt names one concrete tab. It may move a stateless session into
      // that tab's extension-owned window, but never into an arbitrary window by URL.
      _adoptWindowForSession(sessionId, targetTab.windowId);
    } else {
      targetTab = type === "get_tab_receipt"
        ? await _getReceiptTargetTab(sessionId)
        : await getTargetTab(null, sessionId);
    }
  } catch (resolveErr) {
    if (type !== "new_tab") throw resolveErr;
    targetTab = { id: null, windowId: null, url: "" };
  }
  const tabId = targetTab.id;

  // getReceipt is a capability rotation, not an ownership bootstrap. A verified old
  // receipt may follow its tab across an origin-changing redirect; without one, the
  // caller must already own the concrete target tab in this exact MCP session.
  if (type === "get_tab_receipt" && !_hasTabReceiptAuthority(sessionId, tabId, receiptResolved)) {
    throw new Error("Tab safety: getReceipt requires an existing receipt or a tab already owned by this MCP session");
  }

  // Safety: never operate on tabs outside this session's profile window. Checked against
  // the session's own window — with one shared id, a session working in a second window
  // of the same profile was told its tab was "a different profile".
  const sessionWindow = _windowForSession(sessionId);
  if (tabId !== null && sessionWindow && targetTab.windowId !== sessionWindow) {
    throw new Error("Tab belongs to a different profile — refusing to operate on personal tabs");
  }

  // ========== TAB OWNERSHIP GUARD ==========
  // Block write operations on tabs not opened by this session.
  // new_tab is always allowed (it creates owned tabs). Read-only ops are allowed on any tab.
  // switch_tab validates its index-selected destination inside its own handler.
  // Guarding the generic pre-resolved tab here can reject the user's harmless active
  // tab after a service-worker wake, before we ever inspect the intended destination.
  if (type !== "new_tab" && type !== "switch_tab" && !_readOnlyCommands.has(type) && !_isTabOwnedBySession(sessionId, tabId)) {
    if (receiptResolved) {
      // getReceipt may use an old origin-bound token only as a locator, then rotate it
      // explicitly. switch/close verify their concrete index/target inside the helper.
      if (type !== "get_tab_receipt" && type !== "close_tab") {
        await _addOwnedTab(sessionId, tabId);
      }
    } else {
      // A cold or brand-new session has no authority to mutate the user's active tab.
      // Stateless callers can present a receipt; otherwise they must create a tab first.
      throw new Error(`⚠️ Tab safety: refusing "${type}" on tab ${tabId} (${_safeTabUrl(targetTab.url)}) — not opened by this MCP session. Use safari_new_tab first or provide its receipt.`);
    }
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

      // Don't hard-reload OAuth/redirect callback pages: a sparse-but-valid callback
      // (code=/token=/state= in the URL) would be reloaded, dropping its POST data and
      // breaking the auth flow. Only reload normal http(s) pages without auth params.
      const reloadable = /^https?:/i.test(payload.url || "") &&
        !/[?&#](code|token|access_token|id_token|state|session_state)=/i.test(payload.url || "");
      if (!hasContent && reloadable) {
        // Try hard reload once
        await browser.tabs.reload(tabId, { bypassCache: true });
        await waitForTabLoad(tabId, 15000);
      }

      const updated = await browser.tabs.get(tabId);
      // Update this session's cache with new URL so subsequent commands target this tab
      _setSessionTab(sessionId, updated.id, updated.url);
      return { title: updated.title, url: updated.url };
    }

    case "go_back": {
      await browser.tabs.goBack(tabId);
      await waitForTabSettled(tabId, 3000);
      const updated = await browser.tabs.get(tabId);
      _setSessionTab(sessionId, updated.id, updated.url);
      return { title: updated.title, url: updated.url };
    }

    case "go_forward": {
      await browser.tabs.goForward(tabId);
      await waitForTabSettled(tabId, 3000);
      const updated = await browser.tabs.get(tabId);
      _setSessionTab(sessionId, updated.id, updated.url);
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

    case "get_tab_receipt": {
      // Rotate entirely in the extension worker. The old token can locate this exact
      // tab after a redirect, but it cannot authorize any page mutation on the new
      // origin. No MAIN-world injection and no page URL/history/hash mutation occurs.
      const liveTab = await browser.tabs.get(tabId);
      const origin = _receiptOrigin(liveTab.url);
      if (!origin) {
        throw new Error("Cannot issue a receipt for this tab URL");
      }
      const receipt = await _issueTabReceipt(liveTab, {
        receiptOrigin: origin,
        identityUrl: liveTab.url,
      });
      await _addOwnedTab(sessionId, tabId);
      _adoptWindowForSession(sessionId, liveTab.windowId);
      _setSessionTab(sessionId, tabId, liveTab.url);
      return {
        index: liveTab.index + 1,
        safeUrl: _safeTabUrl(liveTab.url),
        receipt,
      };
    }

    // Which WINDOW holds this session's tab, and where is the tab inside it. The
    // AppleScript side picks "the first window whose name starts with the profile" —
    // but a profile can hold several windows (measured: four "אוטומציות" at once), so
    // native clicks computed coordinates against one window and delivered the event
    // to another. The extension is the only party that actually knows the tab.
    case "get_tab_locus": {
      let tabsInWindow = [];
      try { tabsInWindow = await browser.tabs.query({ windowId: targetTab.windowId }); } catch {}
      const activeInWindow = tabsInWindow.find(t => t.active);
      // The window's on-screen origin, read from the page itself. This is what makes the
      // native click robust: matching a Safari window by URL/title/index is fragile (an
      // SPA rewrites its URL, parallel sessions change the tab count), but screenX/screenY
      // + outer/inner give the exact pixel box, so the click needs no window-id mapping
      // at all. Only meaningful for the active tab (a background tab has no live window).
      let screenGeom = null;
      try {
        const r = await browser.scripting.executeScript({
          target: { tabId: targetTab.id }, world: "MAIN",
          func: () => ({
            sx: window.screenX, sy: window.screenY,
            ow: window.outerWidth, oh: window.outerHeight,
            iw: window.innerWidth, ih: window.innerHeight,
            dpr: window.devicePixelRatio,
          }),
        });
        if (r && r[0] && r[0].result) screenGeom = r[0].result;
      } catch {}
      return {
        tabId: targetTab.id,
        windowId: targetTab.windowId,
        index: targetTab.index + 1,           // AppleScript tab indices are 1-based
        url: targetTab.url || "",
        title: targetTab.title || "",
        active: !!targetTab.active,
        activeTabTitle: (activeInWindow && activeInWindow.title) || "",
        windowTabCount: tabsInWindow.length,
        screenGeom,
      };
    }

    case "get_title": {
      return targetTab.title;
    }

    case "read_page": {
      const readPage = (sel, maxLen) => {
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return null;
          return el.value !== undefined && el.value !== "" ? el.value.substring(0, maxLen) : (el.innerText || el.textContent || "").substring(0, maxLen);
        }
        const bodyText = document.body?.innerText || document.body?.textContent || "";
        return JSON.stringify({ title: document.title, url: location.href, text: bodyText.substring(0, maxLen) });
      };
      const args = [payload.selector || null, payload.maxLength || 50000];
      if (payload.selector) {
        const frameResult = await execInAllFrames(readPage, args, tabId);
        return frameResult !== null && frameResult !== undefined
          ? frameResult
          : "Element not found: " + payload.selector;
      }
      return await execInTab(readPage, args, tabId);
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
      // Strategy 0: pages that stall injection outright. Every strategy below reaches
      // the page through scripting.executeScript, which on business.facebook.com never
      // resolves — so all three died on the caller's timeout and evaluate was simply
      // unavailable there. The content-script bridge needs no injection at all, so try
      // it FIRST once a tab is known to block injection, and fall back to it below
      // when a fresh tab turns out to block it too.
      const evalTabId = tabId || (await getActiveTab()).id;
      const viaBridge = async () => {
        const r = await sendContentCommand(
          evalTabId, "mcp-content-eval", { source: payload.script }, 10000
        );
        if (!r || r.ok !== true) throw new Error((r && r.error) || "content bridge failed");
        _injectionBlockedTabs.add(evalTabId);
        return r.value;
      };
      if (_injectionBlockedTabs.has(evalTabId)) {
        try { return await viaBridge(); }
        catch (_e) { _injectionBlockedTabs.delete(evalTabId); } // page changed — re-probe
      }

      // First contact with a hardened page: every execInTab strategy below will stall.
      // Catch that here so it costs one bounded probe, not the caller's whole timeout.
      const evalStrategies = async () => {
      // Strategy 1: Direct eval via execInTab (fast, works when CSP allows unsafe-eval)
      const evalResult = await execInTab(async (script) => {
        try {
          const result = await (0, eval)(script);
          if (result === undefined || result === null) return null;
          return typeof result === "object" ? JSON.stringify(result) : String(result);
        } catch (e) {
          if (e.message.includes("unsafe-eval") || e.message.includes("trusted-types") || e.message.includes("Trusted Type")) {
            return "__CSP_BLOCKED__";
          }
          return "Error: " + e.message;
        }
      }, [payload.script], tabId);

      if (evalResult !== "__CSP_BLOCKED__") return evalResult;

      // Strategy 2: Script element injection (works when inline scripts are allowed)
      const injectResult = await execInTab(async (script) => {
        return await new Promise((resolve) => {
          // Unpredictable key — a Date.now()-based name let a hostile page pre-seed
          // window["__mcp_eval_<now>"] with a fabricated {done:true,v:...} result.
          const id = "__mcp_eval_" + (crypto.randomUUID
            ? crypto.randomUUID().replace(/-/g, "")
            : Date.now().toString(36) + Math.random().toString(36).slice(2));
          window[id] = { done: false };
          const s = document.createElement("script");
          const code = "try{var __r=(function(){" + script + "})();if(__r&&typeof __r.then==='function'){__r.then(function(v){window['" + id + "']={done:true,v:v};}).catch(function(e){window['" + id + "']={done:true,e:e.message};});}else{window['" + id + "']={done:true,v:__r};}}catch(e){window['" + id + "']={done:true,e:e.message};}";
          // Prefer the policy pre-registered by content.js at document_start —
          // pages that block new policy creation post-load (GSC, modern Google admin)
          // still accept ours because it was grandfathered in before their CSP applied.
          if (window.__mcpTrustedPolicy && typeof window.__mcpTrustedPolicy.createScript === "function") {
            try { s.textContent = window.__mcpTrustedPolicy.createScript(code); }
            catch (_) { s.textContent = code; }
          } else if (window.trustedTypes && window.trustedTypes.createPolicy) {
            try {
              const policy = window.trustedTypes.createPolicy("mcpEval_" + Date.now(), { createScript: (s) => s });
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
      };

      try {
        return await evalStrategies();
      } catch (err) {
        // "injection stalled" means the page refuses executeScript in both worlds, so
        // none of the strategies above can ever reach it. The bridge does not inject.
        if (!/injection stalled/.test(err?.message || "")) throw err;
        console.warn("Safari MCP: injection blocked on this page, using content bridge");
        return await viaBridge();
      }
    }

    // --- Screenshot ---
    case "screenshot": {
      // Strategy: try captureVisibleTab WITHOUT focusing the window first.
      // If it fails, fall back to AppleScript screencapture -l (which also doesn't steal focus).
      // NEVER use browser.windows.update({ focused: true }) — it steals user's keyboard/mouse.
      let captureWindowId = _profileWindowId || null;
      if (tabId) {
        try {
          const tabInfo = await browser.tabs.get(tabId);
          captureWindowId = tabInfo.windowId;
          // Only activate the correct tab — does NOT bring Safari window to foreground
          await browser.tabs.update(tabId, { active: true });
        } catch (_) {}
        await new Promise(r => setTimeout(r, 150));
      }
      // Use JPEG with quality 50 to reduce size (~600KB PNG → ~60KB JPEG)
      try {
        const dataUrl = await browser.tabs.captureVisibleTab(captureWindowId, {
          format: "jpeg",
          quality: 50,
        });
        return dataUrl.split(",")[1];
      } catch (screenshotErr) {
        // Permission lost or window not visible — signal MCP to use AppleScript fallback
        // AppleScript uses screencapture -l<windowId> which captures without stealing focus
        const msg = screenshotErr.message || "";
        if (msg.includes("permission") || msg.includes("screencapture") || msg.includes("Screen Recording") || msg.includes("visible")) {
          return "__SCREENSHOT_PERMISSION_DENIED__";
        }
        // Any other error also falls back — better than stealing focus
        return "__SCREENSHOT_PERMISSION_DENIED__";
      }
    }

    // --- Click & Input ---
    case "click": {
      let result;
      try {
        const response = await sendContentCommand(tabId, "mcp-content-click", {
          selector: payload.selector, text: payload.text,
          x: payload.x, y: payload.y, ref: payload.ref,
        });
        if (!response || typeof response.result !== "string") {
          throw new Error("content click bridge returned no result");
        }
        result = response.result;
      } catch (contentError) {
        console.warn("content click bridge unavailable:", contentError?.message || String(contentError));
        if ((targetTab.url || "").includes("business.facebook.com")) {
          throw new Error("content click bridge unavailable: " + (contentError?.message || String(contentError)));
        }
        // Excluded domains and pages loaded before the bridge was installed keep the
        // scripting fallback. A reload/new navigation installs the persistent bridge.
        result = await execInTabIsolated((selector, text, x, y, ref) => {
        // Use shared deep query (defined by ensureHelpers / _deepQueryScript)
        const dq = window.__mcpDeepQuery || document.querySelector.bind(document);

        // --- Ref lookup (uses data-mcp-ref attribute + stored ref data) ---
        function findByRef(refId) {
          // Try data-mcp-ref attribute first (set by snapshot)
          let el = dq('[data-mcp-ref="' + refId + '"]');
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
          // Escape attribute values + guard the query — a page-controlled aria-label/name/
          // placeholder containing a double-quote would otherwise build an invalid selector
          // and throw a DOMException that surfaces as a misleading "element not found".
          const dqAttr = (sel) => { try { return dq(sel); } catch (_e) { return null; } };
          const aq = (v) => String(v).replace(/["\\]/g, "\\$&");
          if (m.id) { el = document.getElementById(m.id); if (el) return el; }
          if (m.nameAttr) { el = dqAttr('[name="' + aq(m.nameAttr) + '"]'); if (el) return el; }
          if (m.al) { el = dqAttr('[aria-label="' + aq(m.al) + '"]'); if (el) return el; }
          if (m.ph) { el = dqAttr('[placeholder="' + aq(m.ph) + '"]'); if (el) return el; }
          // Type attribute fallback (input type="email", type="url", etc.)
          if (m.inputType) { el = dqAttr(m.tag.toLowerCase() + '[type="' + aq(m.inputType) + '"]'); if (el) return el; }
          // Coordinate fallback — scroll into view then hit-test
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
          el = dq(selector);
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
        if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || parseFloat(cs.opacity) === 0) {
          return "Element not visible (display/visibility/opacity)";
        }

        // --- Disabled check ---
        if (el.disabled || el.getAttribute("aria-disabled") === "true") {
          const reason = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent?.trim().substring(0, 60) || el.tagName;
          return "Element is DISABLED — cannot click: " + reason + ". Check if form requirements are met (required fields, permissions, etc.)";
        }

        // Meta's legacy rel=dialog router needs the click to originate on the inner
        // label, but its event stack throws a generic Safari WebExtension injection
        // error when it also receives the synthetic pointer prelude. Use the smallest
        // browser-shaped event for this well-defined link contract.
        const relDialogAnchor = el.closest ? el.closest('a[rel="dialog"]') : null;
        if (relDialogAnchor) {
          relDialogAnchor.scrollIntoView({ block: "center", inline: "center" });
          const rr = relDialogAnchor.getBoundingClientRect();
          const rx = rr.left + rr.width / 2, ry = rr.top + rr.height / 2;
          let dialogFrom = document.elementFromPoint(rx, ry);
          if (!dialogFrom || !(dialogFrom === relDialogAnchor || relDialogAnchor.contains(dialogFrom))) {
            dialogFrom = relDialogAnchor;
          }
          try {
            const claimed = !dialogFrom.dispatchEvent(new MouseEvent("click", {
              bubbles: true, cancelable: true, composed: true, view: window,
              clientX: rx, clientY: ry, button: 0, buttons: 0, detail: 1,
            }));
            return claimed ? "Clicked rel=dialog link" : "rel=dialog handler did not claim click";
          } catch (err) {
            return "rel=dialog click failed: " + (err?.message || String(err));
          }
        }

        // React checkbox/radio: reset _valueTracker so React sees the flip as "new"
        if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
          (window.__mcpResetTracker || function(){})(el, el.checked ? "true" : "");
        }

        // --- Scroll into view + resolve click target ---
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;

        // Real clicks bubble from the deepest node under the pointer. Dispatching from
        // the actionable ancestor makes event.target === currentTarget; Meta rel=dialog
        // and SPA router gates reject that synthetic shape. Keep the actionable element
        // for focus/form logic, but fire the event sequence from the leaf.
        let from = document.elementFromPoint(cx, cy);
        if (!from || !(from === el || el.contains(from))) from = el;

        // --- Full event sequence (matches AppleScript path) ---
        const s = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, detail: 1 };
        const p = { ...s, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: 0.5 };

        from.dispatchEvent(new PointerEvent("pointerover", { ...p, buttons: 0 }));
        from.dispatchEvent(new MouseEvent("mouseover", { ...s, buttons: 0 }));
        // Native <select>: synthetic click can't open the dropdown (browser security).
        // Instead, focus + dispatch showPicker (Safari 16+) or return guidance.
        if (el.tagName === "SELECT") {
          el.focus();
          try { el.showPicker(); return "Opened SELECT picker"; } catch (_) {}
          // showPicker not available — return helpful message
          return "SELECT element focused. Use safari_select_option to set a value, or safari_press_key with 'space' to open the dropdown.";
        }

        from.dispatchEvent(new PointerEvent("pointerenter", { ...p, buttons: 0 }));
        from.dispatchEvent(new MouseEvent("mouseenter", { ...s, buttons: 0 }));
        from.dispatchEvent(new PointerEvent("pointermove", { ...p, buttons: 0 }));
        from.dispatchEvent(new MouseEvent("mousemove", { ...s, buttons: 0 }));
        from.dispatchEvent(new PointerEvent("pointerdown", { ...p, buttons: 1 }));
        from.dispatchEvent(new MouseEvent("mousedown", { ...s, buttons: 1 }));
        if (el.focus) el.focus();
        from.dispatchEvent(new PointerEvent("pointerup", { ...p, buttons: 0, pressure: 0 }));
        from.dispatchEvent(new MouseEvent("mouseup", { ...s, buttons: 0 }));

        const beforeUrl = location.href;
        const anchor = el.closest ? el.closest("a[href]") : null;
        const href = anchor && anchor.href && !anchor.href.startsWith("javascript:") ? anchor.href : "";
        const anchorTarget = anchor ? (anchor.getAttribute("target") || "") : "";
        // One click only. Calling `.click()` and then dispatching another click used to
        // toggle custom comboboxes open and immediately closed. Dispatch from the leaf so
        // event.target/currentTarget match a real click; explicit navigation/form handling
        // below supplies the native defaults synthetic dispatch does not guarantee.
        const clickEvent = new MouseEvent("click", { ...s, buttons: 0 });
        const notPrevented = from.dispatchEvent(clickEvent);
        if (href && notPrevented && location.href === beforeUrl && (!anchorTarget || anchorTarget === "_self")) {
          return "__MCP_NAVIGATE__:" + href;
        }

        // Form submit fallback — use requestSubmit to fire submit event + validation
        const form = el.closest ? el.closest("form") : null;
        if (form && (el.type === "submit" || (el.tagName === "BUTTON" && el.type !== "button" && el.type !== "reset"))) {
          try {
            if (form.requestSubmit) {
              form.requestSubmit(el.type === "submit" ? el : undefined);
            } else {
              form.submit();
            }
          } catch (_) {}
        }

        return "Clicked: " + el.tagName + (el.textContent ? ' "' + el.textContent.trim().substring(0, 50) + '"' : "");
        }, [payload.selector, payload.text, payload.x, payload.y, payload.ref], tabId);
      }

      if (typeof result === "string" && result.startsWith("__MCP_NAVIGATE__:")) {
        const href = result.substring("__MCP_NAVIGATE__:".length);
        await browser.tabs.update(tabId, { url: href });
        await waitForTabLoad(tabId, payload.timeout || 30000);
        try {
          const updated = await browser.tabs.get(tabId);
          _setSessionTab(sessionId, updated.id, updated.url);
        } catch {}
        return "Navigated to: " + href;
      }

      // Fallback: if element not found in main frame, try all frames (cross-origin iframes)
      if (result && (result.startsWith("Element not found") || result === "No click target")) {
        const iframeArgs = [payload.selector, payload.text, payload.ref];
        const iframeResult = await execInFirstMatchingFrameMutating((selector, text, ref) => {
          const deepQuery = (query, root = document) => {
            const direct = root.querySelector(query);
            if (direct) return direct;
            for (const host of root.querySelectorAll("*")) {
              if (!host.shadowRoot) continue;
              const nested = deepQuery(query, host.shadowRoot);
              if (nested) return nested;
            }
            return null;
          };
          if (ref) {
            const safeRef = String(ref).replace(/["\\]/g, "\\$&");
            return !!deepQuery('[data-mcp-ref="' + safeRef + '"]');
          }
          if (selector) return !!deepQuery(selector);
          if (!text) return false;
          const candidates = document.querySelectorAll("button, a, [role='button'], input[type='submit']");
          for (let i = 0; i < candidates.length; i++) {
            const value = (candidates[i].innerText || candidates[i].textContent || "").trim();
            if (value && (value === text || value.includes(text) || text.includes(value))) return true;
          }
          return false;
        }, iframeArgs, (selector, text, ref) => {
          const deepQuery = (query, root = document) => {
            const direct = root.querySelector(query);
            if (direct) return direct;
            for (const host of root.querySelectorAll("*")) {
              if (!host.shadowRoot) continue;
              const nested = deepQuery(query, host.shadowRoot);
              if (nested) return nested;
            }
            return null;
          };
          let el = null;
          if (ref) {
            const safeRef = String(ref).replace(/["\\]/g, "\\$&");
            el = deepQuery('[data-mcp-ref="' + safeRef + '"]');
          } else if (selector) {
            el = deepQuery(selector);
          } else if (text) {
            // Search interactive elements by text
            const candidates = document.querySelectorAll("button, a, [role='button'], input[type='submit']");
            for (let i = 0; i < candidates.length; i++) {
              const t = (candidates[i].innerText || candidates[i].textContent || "").trim();
              if (t === text) { el = candidates[i]; break; }
            }
            // Fuzzy: contains match
            if (!el) {
              for (let i = 0; i < candidates.length; i++) {
                const t = (candidates[i].innerText || candidates[i].textContent || "").trim();
                if (t && (t.includes(text) || text.includes(t))) { el = candidates[i]; break; }
              }
            }
          }
          if (!el) return null;
          el.scrollIntoView({ block: "center", behavior: "instant" });
          el.click();
          return "Clicked (iframe): " + el.tagName + (el.textContent ? ' "' + el.textContent.trim().substring(0, 50) + '"' : "");
        }, iframeArgs, tabId);
        if (iframeResult) return iframeResult;
      }
      return result;
    }

    // --- One-shot popup capture for OAuth buttons inside exact child frames ---
    case "click_open_popup": {
      const selector = typeof payload.selector === "string" && payload.selector ? payload.selector : "";
      const ref = typeof payload.ref === "string" && payload.ref ? payload.ref : "";
      if ((selector ? 1 : 0) + (ref ? 1 : 0) !== 1) {
        throw new Error("clickAndOpenPopup requires exactly one of selector or ref");
      }

      const captured = await execInExactMatchingFrameMainOnce(
        _popupClickFrameAction,
        [selector, ref, "probe"],
        _popupClickFrameAction,
        [selector, ref, "capture"],
        tabId
      );
      if (!captured) throw new Error("Element not found for clickAndOpenPopup");
      if (!captured.ok) {
        if (captured.code === "captcha_refused") {
          throw new Error("Safety: clickAndOpenPopup refuses CAPTCHA or challenge targets");
        }
        if (captured.code === "no_popup") {
          throw new Error("No HTTP(S) popup URL was captured; the one-shot click was not retried");
        }
        if (captured.code === "non_http_popup") {
          throw new Error("Captured popup URL must use HTTP(S)");
        }
        throw new Error("One-shot popup click did not produce a safe popup URL");
      }

      // captured.popupUrl is intentionally never logged or returned. Only the newly
      // created tab's origin+path and opaque ownership receipt leave this worker.
      return await _openPopupTabForSession(sessionId, targetTab, captured.popupUrl);
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
      try {
        const response = await sendContentCommand(tabId, "mcp-content-fill", {
          selector: payload.selector, ref: payload.ref, value: payload.value,
        });
        if (response && response.ok && typeof response.result === "string") {
          return response.result;
        }
      } catch (contentError) {
        console.warn("content fill bridge unavailable:", contentError?.message || String(contentError));
        // Pages without the content bridge retain the framework-aware fallback below.
      }
      const fillFn = (selector, value) => {
        const localDeepQuery = (query, root = document) => {
          const direct = root.querySelector(query);
          if (direct) return direct;
          for (const host of root.querySelectorAll("*")) {
            if (!host.shadowRoot) continue;
            const nested = localDeepQuery(query, host.shadowRoot);
            if (nested) return nested;
          }
          return null;
        };
        const el = window.__mcpDeepQuery ? window.__mcpDeepQuery(selector) : localDeepQuery(selector);
        if (!el) return "Element not found: " + selector;
        el.focus();
        if (el.isContentEditable) {
          let ceResult = null;
          // === ProseMirror: use native view.dispatch API ===
          const pmEl = el.closest(".ProseMirror") || document.querySelector(".ProseMirror");
          if (!ceResult && pmEl) {
            try {
              let view = pmEl.pmViewDesc && pmEl.pmViewDesc.view;
              if (!view) { const keys = Object.keys(pmEl); for (let i=0;i<keys.length;i++) { const o=pmEl[keys[i]]; if(o&&o.state&&o.dispatch){view=o;break;} } }
              // Walk React Fiber tree to find EditorView (LinkedIn, Tiptap-React, etc.)
              if (!view) {
                const fk = Object.keys(pmEl).find(function(k){return k.startsWith("__reactFiber$")||k.startsWith("__reactInternalInstance$");});
                if (fk) { let fiber = pmEl[fk]; for (let d=0;d<20&&fiber;d++) { const props = fiber.memoizedProps||(fiber.stateNode&&fiber.stateNode.props); if(props) { const v = props.editorView||props.view; if(v&&v.state&&v.dispatch){view=v;break;} } fiber=fiber.return; } }
              }
              if (view && view.state && view.dispatch) {
                const { state } = view;
                const doc = state.doc;
                const hasContent = doc.textContent && doc.textContent.trim().length > 0;
                if (hasContent) {
                  const endPos = doc.content.size > 1 ? doc.content.size - 1 : doc.content.size;
                  view.dispatch(state.tr.insertText(" " + value, endPos));
                  view.focus();
                  ceResult = "Filled contenteditable (ProseMirror append)";
                } else {
                  const tr = state.tr.replaceWith(0, doc.content.size,
                    state.schema.text ? state.schema.text(value) : state.schema.node("paragraph", null, state.schema.text(value)));
                  view.dispatch(tr);
                  view.focus();
                  ceResult = "Filled contenteditable (ProseMirror replace)";
                }
              }
            } catch (e) { /* fall through */ }
          }
          // ProseMirror detected but no view found — use char-by-char with beforeinput
          if (!ceResult && pmEl) {
            try {
              el.focus();
              (window.__mcpClosureType || function(){})(value, el);
              ceResult = "Filled contenteditable (ProseMirror char-by-char, " + value.length + " chars)";
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
                // Empty editor — char-by-char with Enter handling (matches type_text strategy)
                (window.__mcpClosureType || function(){})(value, el);
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
            el.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: value, bubbles: true, cancelable: true }));
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
        (window.__mcpResetTracker || function(){})(el, "");
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
        const iframeResult = await execInFirstMatchingFrameMutating(
          (selector) => {
            const deepQuery = (query, root = document) => {
              const direct = root.querySelector(query);
              if (direct) return direct;
              for (const host of root.querySelectorAll("*")) {
                if (!host.shadowRoot) continue;
                const nested = deepQuery(query, host.shadowRoot);
                if (nested) return nested;
              }
              return null;
            };
            return !!deepQuery(selector);
          },
          [payload.selector],
          fillFn,
          [payload.selector, payload.value],
          tabId
        );
        if (iframeResult && !iframeResult.startsWith("Element not found")) return iframeResult;
      }
      return result;
    }

    case "type_text": {
      const result = await execInTab((text, selector) => {
        if (selector) {
          const el = (window.__mcpDeepQuery || document.querySelector.bind(document))(selector);
          if (!el) return "Element not found: " + selector;
          el.focus();
        }

        // === Strategy 1: ProseMirror native API ===
        // ProseMirror stores the EditorView on .ProseMirror element via pmViewDesc
        const pmEl = document.querySelector(".ProseMirror");
        if (pmEl) {
          try {
            // Access view from multiple known locations
            let view = (pmEl.pmViewDesc && pmEl.pmViewDesc.view)
              || (pmEl.cmView && pmEl.cmView.view) // CodeMirror 6
              || null;
            if (!view) { const keys = Object.keys(pmEl); for (let i=0;i<keys.length;i++) { const o=pmEl[keys[i]]; if(o&&o.state&&o.dispatch){view=o;break;} } }
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
          (window.__mcpClosureType || function(){})(text, ae);
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

      // Fallback: if typing failed in main frame, try all frames (cross-origin iframes)
      if (result === "Typed 0 chars" || !result || result.startsWith("Element not found")) {
        const iframeResult = await execInFirstMatchingFrameMutating((selector) => {
          if (selector) {
            const deepQuery = (query, root = document) => {
              const direct = root.querySelector(query);
              if (direct) return direct;
              for (const host of root.querySelectorAll("*")) {
                if (!host.shadowRoot) continue;
                const nested = deepQuery(query, host.shadowRoot);
                if (nested) return nested;
              }
              return null;
            };
            return !!deepQuery(selector);
          }
          const active = document.activeElement;
          return !!active && active !== document.body;
        }, [payload.selector], (text, selector) => {
          const deepQuery = (query, root = document) => {
            const direct = root.querySelector(query);
            if (direct) return direct;
            for (const host of root.querySelectorAll("*")) {
              if (!host.shadowRoot) continue;
              const nested = deepQuery(query, host.shadowRoot);
              if (nested) return nested;
            }
            return null;
          };
          const el = selector ? deepQuery(selector) : document.activeElement;
          if (!el || el === document.body) return null;
          if (selector) el.focus();
          // Try execCommand insert
          const ok = document.execCommand("insertText", false, text);
          if (ok) return "Typed " + text.length + " chars (iframe execCommand)";
          // Fallback: contenteditable or input
          if (el.isContentEditable) {
            el.textContent = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return "Typed " + text.length + " chars (iframe contenteditable)";
          }
          if ("value" in el) {
            el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return "Typed " + text.length + " chars (iframe input)";
          }
          return null;
        }, [payload.text, payload.selector], tabId);
        if (iframeResult) return iframeResult;
      }
      return result;
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
      return await _listTabsForSession(sessionId);
    }

    case "new_tab": {
      // Create a blank tab first so Safari returns an ownership receipt immediately.
      // On authenticated/slow apps, browser.tabs.create({url}) can wait for navigation
      // long enough to exceed the bridge timeout even though the tab was created. That
      // strands an unowned tab and makes the caller believe creation failed.
      return await _newTabForSession(sessionId, payload);
    }

    case "close_tab": {
      // ── Guard: never remove a window's LAST tab — doing so closes the window
      // (quitting Safari if it's the only one, or making a profile-targeted
      // window vanish). Per-window, not global, so other-profile windows don't
      // mask it. If the target window is down to one tab, blank it instead.
      // Mirrors safari.js closeTab().
      return await _closeTabForSession(sessionId, targetTab, payload);
    }

    case "switch_tab": {
      return await _switchTabForSession(sessionId, targetTab, payload);
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
      const timeout = payload.timeout || 10000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = await execInAllFrames((selector, text) => {
          const dq = window.__mcpDeepQuery || document.querySelector.bind(document);
          if (selector && dq(selector)) return "Found: " + selector;
          const bodyText = document.body?.innerText || document.body?.textContent || "";
          if (text && bodyText.includes(text)) return "Found text: " + text;
          return null;
        }, [payload.selector, payload.text], tabId);
        if (found) return found;
        await sleep(200);
      }
      return "TIMEOUT after " + timeout + "ms waiting for " + (payload.selector ? "selector: " + payload.selector : "text: " + payload.text);
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
      // Update the session cache like every other navigation command — without this,
      // the next command within TAB_CACHE_MS resolved against the PRE-navigation URL
      // and could fall through to the user's active tab.
      try {
        const updated = await browser.tabs.get(tabId);
        _setSessionTab(sessionId, updated.id, updated.url);
      } catch {}
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
      const result = await execTextAcrossFrames((rootSelector, snapshotGen) => {
        // Clean ALL stale data-mcp-ref attributes from previous snapshots.
        // Without this, old refs remain on DOM and findByRef/CSS selector can target WRONG elements.
        document.querySelectorAll("[data-mcp-ref]").forEach(function(el) { el.removeAttribute("data-mcp-ref"); });

        const getSR = window.__mcpGetShadowRoot || function(e) { return e.shadowRoot; };
        let id = 0;
        const MAX_ELEMENTS = 800;
        const MAX_DEPTH = 20;
        const refs = {};
        // Shared by both walk() and the child-frame wrapper below. Keeping this in
        // walk() made every non-empty child frame throw when its URL was escaped.
        const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        // Refs must be unique across child frames because click/fill later search all
        // frames for the exact data attribute.  Keep the historical top-frame format
        // and give each child document a stable per-document namespace.
        let frameNamespace = "";
        if (window !== top) {
          if (!window.__mcpFrameRefNamespace) {
            window.__mcpFrameRefNamespace = Math.random().toString(36).slice(2, 9);
          }
          frameNamespace = window.__mcpFrameRefNamespace + "_";
        }

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
          const refId = snapshotGen + "_" + frameNamespace + currentId;

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
            if (el.type && el.tagName === "INPUT") refs[refId].inputType = el.type;
            refs[refId].cx = Math.round(r.left + r.width / 2 + window.scrollX);
            refs[refId].cy = Math.round(r.top + r.height / 2 + window.scrollY);
            attrs = ` ref="${refId}"`;
          }

          // Escape page-controlled attribute values: a crafted aria-label/title/value with
          // a double-quote could otherwise break the pseudo-XML snapshot and inject a fake
          // ref=""/role="" that steers the agent into clicking the wrong element.
          const role = el.getAttribute("role");
          if (role) attrs += ` role="${esc(role)}"`;
          if (el.id) attrs += ` id="${esc(el.id)}"`;
          const al = el.getAttribute("aria-label");
          if (al) attrs += ` aria-label="${esc(al)}"`;
          const title = el.getAttribute("title");
          if (title) attrs += ` title="${esc(title.substring(0, 80))}"`;
          if (el.value && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) {
            attrs += ` value="${esc(String(el.value).substring(0, 50))}"`;
          }
          if (el.type && el.tagName === "INPUT") attrs += ` type="${esc(el.type)}"`;
          if (el.href && el.tagName === "A") attrs += ` href="${esc(el.href.substring(0, 100))}"`;
          if (el.disabled) attrs += " disabled";
          const ph = el.getAttribute("placeholder");
          if (ph) attrs += ` placeholder="${esc(ph)}"`;
          // For interactive elements with no visible text — show alt/aria-describedby hint
          if (interactive && el.tagName === "IMG" && el.alt) attrs += ` alt="${esc(el.alt.substring(0, 80))}"`;
          const ariaDesc = el.getAttribute("aria-describedby");
          if (ariaDesc) {
            const descEl = document.getElementById(ariaDesc);
            if (descEl) attrs += ` described="${esc(descEl.textContent.trim().substring(0, 80))}"`;
          }

          // Self-closing for some tags
          if (["img", "input", "br", "hr"].includes(tag)) {
            return `<${tag}${attrs}/>`;
          }

          let children = "";
          // Enter shadow root INLINE — critical for Reddit/custom elements with closed shadow DOM
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

        let root = rootSelector ? document.querySelector(rootSelector) : document.body;
        // Fallback: if selector not found, try common dialog/portal containers
        // React portals, Radix UI, Headless UI, MUI all use these patterns
        if (!root && rootSelector) {
          const portalSelectors = [
            '[role="dialog"]', '[role="alertdialog"]', 'dialog[open]',
            '[data-radix-portal]', '[class*="modal"]', '[class*="Modal"]',
            '[class*="dialog"]', '[class*="Dialog"]', '[id*="portal"]'
          ];
          for (const ps of portalSelectors) {
            const candidate = document.querySelector(ps);
            if (candidate) {
              // If original selector was more specific (e.g. "[role=dialog] form"),
              // try to find the target within the portal
              const inner = candidate.querySelector(rootSelector.split(/\s+/).pop());
              root = inner || candidate;
              break;
            }
          }
        }
        if (!root) return "Element not found: " + rootSelector;

        // TOP-LAYER MODAL DETECTION: when a modal/dialog is open, user intent is almost always
        // to interact with it, not the page behind. Pages like Google Business Profile, Drive,
        // Airtable rich dialogs open top-layer content that standard DOM walks miss or bury.
        // Detect visible modals and, if found, walk them FIRST so their refs appear at the top.
        let topLayerTree = "";
        if (!rootSelector) {
          const seenModals = new Set();
          const modalSelectors = [
            'dialog[open]',
            '[role="dialog"]:not([aria-hidden="true"])',
            '[role="alertdialog"]:not([aria-hidden="true"])',
            '[aria-modal="true"]',
            '[data-radix-dialog-content]',
            '[data-headlessui-state*="open"][role="dialog"]',
            '.MuiDialog-container',
            // Google overlays: Search/GBP/Drive editors use these markers
            '[jscontroller][aria-modal]',
            '[jscontroller][role="dialog"]',
            'c-wiz[role="dialog"]',
            'c-wiz[aria-modal]'
          ];
          for (const sel of modalSelectors) {
            let nodes;
            try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
            for (const m of nodes) {
              if (seenModals.has(m)) continue;
              seenModals.add(m);
              const cs = window.getComputedStyle(m);
              if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
              const r = m.getBoundingClientRect();
              // A real modal covers a meaningful area
              if (r.width < 150 || r.height < 100) continue;
              // Tombstones: modals at 0,0 with 0 size are placeholders
              if (r.width === 0 || r.height === 0) continue;
              // Nested modals: skip if we already included a parent
              let isNested = false;
              for (const other of seenModals) {
                if (other !== m && other.contains(m)) { isNested = true; break; }
              }
              if (isNested) continue;
              topLayerTree += walk(m, 0);
            }
          }
        }

        let tree = topLayerTree + walk(root, 0);
        // Shadow roots are now walked INLINE inside walk() — no separate walkShadows needed.
        // Cross-origin and same-origin child documents are collected independently by
        // execTextAcrossFrames. Walking them again here would duplicate their content
        // and race with the child frame's own unique ref namespace.
        // Store refs globally for ref-based click/fill, with generation timestamp
        window.__mcpRefs = refs;
        window.__mcpRefsTime = Date.now();
        // Warn if truncated
        if (id >= MAX_ELEMENTS) {
          tree += "\n[WARNING: Snapshot truncated at " + MAX_ELEMENTS + " elements. Use selector parameter to focus on a specific section.]";
        }
        if (window !== top && tree) {
          // Never expose query/hash values from OAuth, payment, or partner frames.
          // They commonly carry codes, signed state, and other credential-like data.
          let frameLabel = "opaque-frame";
          try {
            const frameUrl = new URL(location.href);
            frameLabel = /^https?:$/.test(frameUrl.protocol)
              ? frameUrl.origin + frameUrl.pathname
              : frameUrl.protocol + "frame";
          } catch (_) {}
          tree = "<iframe-context url=\"" + esc(frameLabel.substring(0, 160)) + "\">" + tree + "</iframe-context>";
        }
        return tree;
      }, [payload.selector || null, payload.gen != null ? payload.gen : 0], tabId);
      return result || (payload.selector ? "Element not found: " + payload.selector : "");
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
        (window.__mcpResetTracker || function(){})(el, "x");
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

        (window.__mcpResetTracker || function(){})(el, "");

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
              (window.__mcpResetTracker || function(){})(el, el.checked ? "true" : "");
              el.click();
            }
            results.push((el.checked ? "Checked" : "Unchecked") + ": " + (f.selector));
            return;
          }

          // SELECT element
          if (el.tagName === "SELECT") {
            (window.__mcpResetTracker || function(){})(el, "");
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
          (window.__mcpResetTracker || function(){})(el, "");
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
      const result = await execInAllFrames((selector) => {
        const el = (window.__mcpDeepQuery || document.querySelector.bind(document))(selector);
        if (!el) return null;
        const cs = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        return JSON.stringify({
          tag: el.tagName, text: (el.innerText || el.textContent || "").substring(0, 200),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          visible: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0,
          attrs, value: el.value, checked: el.checked, disabled: el.disabled,
        });
      }, [payload.selector], tabId);
      return result || "Element not found: " + payload.selector;
    }

    // --- Query All ---
    case "query_all": {
      const queryFn = (selector, limit) => {
        const els = (window.__mcpDeepQueryAll || document.querySelectorAll.bind(document))(selector, limit);
        const results = [];
        for (let i = 0; i < Math.min(els.length, limit); i++) {
          const el = els[i];
          const r = el.getBoundingClientRect();
          results.push({
            index: i, tag: el.tagName,
            text: (el.innerText || "").substring(0, 100),
            href: el.href || "", value: el.value || "",
            id: el.id || "", name: el.name || "", type: el.type || "",
            placeholder: el.getAttribute("placeholder") || "",
            ariaLabel: el.getAttribute("aria-label") || "",
            visible: r.width > 0 && r.height > 0,
            // Center point relative to the element's OWN frame viewport. In the main
            // frame that equals page-viewport coordinates; in a cross-origin iframe it
            // is iframe-relative — check `frame` and offset by the iframe's position
            // before clicking by coordinates.
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2),
            frame: location.href.substring(0, 120),
          });
        }
        return JSON.stringify(results);
      };

      const mainResult = await execInTab(queryFn, [payload.selector, payload.limit || 20], tabId);
      // The main frame is authoritative when it matches. Cross-origin iframes (GHL's
      // workflow list, embedded editors) are invisible to it, so fall back the same
      // way click/fill already do rather than reporting "no matches".
      try {
        if (mainResult && JSON.parse(mainResult).length > 0) return mainResult;
      } catch { return mainResult; }
      const frameResult = await execAcrossFrames(queryFn, [payload.selector, payload.limit || 20], tabId);
      return frameResult || mainResult;
    }

    default:
      throw new Error("Unknown command: " + type);
  }
}

// ========== HELPERS ==========

// Per-session tab cache: Map<sessionId, {tabId, tabUrl, time}>
// Each MCP process has a unique sessionId — prevents sessions from overwriting each other's tab context
const _sessionTabCache = new Map();
// How long a session keeps pointing at the tab it opened/navigated.
// This was 3s, which is shorter than the gap between two MCP calls in real use (the
// model thinks, the user reads). Once it lapsed, getTargetTab fell through to
// "PRIORITY 3: active tab of the profile window" — so a tab the user or a parallel
// session brought to the front silently became the target, and the ownership guard
// then rejected the command ("not opened by this MCP session") or, before that guard
// existed, the command ran on the wrong page.
// Expiry is not what keeps this safe: browser.tabs.get() below drops the cache when
// the tab is gone, and the windowId check rejects a tab outside the profile window.
const TAB_CACHE_MS = 900000; // 15 min — spans an interactive session, not one turn
const _DEFAULT_SESSION = "__default__"; // Fallback for commands without sessionId
const SESSION_MAX_AGE_MS = 5 * 60 * 1000; // 5 min — prune stale sessions
const MAX_SESSIONS = 50; // Hard cap on session cache size

// ========== TAB OWNERSHIP: track tabs opened by each MCP session ==========
// Prevents operating on user's tabs — only tabs created via new_tab are "owned".
const _sessionOwnedTabs = new Map(); // sessionId → Set<tabId>
// Mirror of the above in storage.local. storage.session is absent on Safari, so it is
// the only place ownership actually survives a worker suspend.
const _OWNED_TABS_LOCAL_KEY = "mcpOwnedTabsLocal";
// Long enough to span a working session, short enough that tab ids from a previous
// browser run have expired rather than being reused by unrelated tabs.
const _OWNED_TABS_TTL_MS = 6 * 60 * 60 * 1000;

// Persist owned-tab IDs in storage.session: it survives the frequent MV3
// service-worker terminations (but clears when Safari quits, matching tab-ID
// lifetime). Without this, every worker restart wiped the Map — and the
// "no tabs owned yet" compatibility path then silently allowed write commands
// on ANY tab, including the user's.
const _OWNED_TABS_KEY = "mcpSessionOwnedTabs";
const _TAB_RECEIPTS_KEY = "mcpOwnedTabReceiptsV3";
const _TAB_RECEIPTS_VERSION = 3;
const _BROWSER_SESSION_EPOCH_KEY = "mcpBrowserSessionEpochV1";
// Receipts are bearer capabilities stored entirely out of band. They are never added
// to a live page URL: doing so corrupts signed queries and application hash routers.
const _receiptByToken = new Map(); // token → { tabId, windowId, receiptOrigin, identityDigest, issuedAt }
const _tokenByTabId = new Map(); // concrete live tab id → token
let _receiptMutationTail = Promise.resolve(); // serialize every mutation covered by the full persisted envelope
let _ownedTabsHydrated = false;
let _ownedTabsHydrationPromise = null;
let _browserSessionEpoch = "";
let _browserEpochInitializationPromise = null;
let _browserEpochGeneration = 0;
let _browserEpochStorageTail = Promise.resolve();
const _browserSessionStorageAvailable = !!browser.storage?.session &&
  typeof browser.storage.session.get === "function" &&
  typeof browser.storage.session.set === "function";

async function _digestTabUrl(rawUrl) {
  const bytes = new TextEncoder().encode(String(rawUrl || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function _isValidReceiptRecord(token, record) {
  return /^[A-Za-z0-9_-]{24,}$/.test(String(token || "")) &&
    record && Number.isInteger(Number(record.tabId)) &&
    Number.isInteger(Number(record.windowId)) &&
    typeof record.browserEpoch === "string" && /^[a-f0-9]{36}$/.test(record.browserEpoch) &&
    typeof record.identityDigest === "string" && /^[a-f0-9]{64}$/.test(record.identityDigest) &&
    typeof record.receiptOrigin === "string" && !!record.receiptOrigin;
}

// Rebuild the per-session window map from concrete live tabs that the same persisted
// session already owns. runtime.reload() clears in-memory window/cache state but Safari
// keeps the tabs; without this recovery, a multi-window profile rejects a legitimate
// owned tab as a cross-window target immediately after reload.
function _recoverSessionWindowsFromOwnedTabs(liveTabsById) {
  for (const [sid, ownedIds] of _sessionOwnedTabs) {
    let latestOwnedTab = null;
    for (const tabId of ownedIds) {
      const liveTab = liveTabsById.get(tabId);
      if (liveTab && Number.isInteger(liveTab.windowId)) latestOwnedTab = liveTab;
    }
    if (!latestOwnedTab) continue;
    _adoptWindowForSession(sid, latestOwnedTab.windowId);
    _setSessionTab(sid, latestOwnedTab.id, latestOwnedTab.url || "");
  }
}

function _resolveHydratedReceiptTab(liveTabsById, claimedTabIds, record, browserEpoch) {
  if (record.browserEpoch !== browserEpoch) return null;
  const direct = liveTabsById.get(record.tabId);
  // Worker suspension preserves Safari tab/window ids and the browser-session epoch.
  // URL identity is deliberately not required here: SPAs mutate it without a full load,
  // and redirects can happen while the worker sleeps. A full Safari restart rotates the
  // epoch before any receipt can be hydrated, preventing tab-id reuse across runs.
  if (!direct) return null;
  if (Number(record.windowId) !== Number(direct.windowId)) return null;
  if (claimedTabIds.has(direct.id)) return null;
  return direct;
}

function _withBrowserEpochStorageLock(operation) {
  const previous = _browserEpochStorageTail;
  const current = previous.catch(() => {}).then(operation);
  _browserEpochStorageTail = current.then(() => undefined, () => undefined);
  return current;
}

async function _ensureBrowserSessionEpoch() {
  if (!_browserSessionStorageAvailable) {
    throw new Error("Browser session storage is unavailable; refusing durable tab authority");
  }
  if (/^[a-f0-9]{36}$/.test(_browserSessionEpoch)) return _browserSessionEpoch;
  if (!_browserEpochInitializationPromise) {
    const generation = _browserEpochGeneration;
    _browserEpochInitializationPromise = _withBrowserEpochStorageLock(async () => {
      if (generation !== _browserEpochGeneration) {
        throw new Error("Browser-session identity changed during initialization");
      }
      let stored = null;
      try {
        stored = await browser.storage.session.get(_BROWSER_SESSION_EPOCH_KEY);
      } catch {
        throw new Error("Could not load browser-session identity");
      }
      const persisted = String(stored?.[_BROWSER_SESSION_EPOCH_KEY] || "");
      if (/^[a-f0-9]{36}$/.test(persisted)) {
        if (generation !== _browserEpochGeneration) {
          throw new Error("Browser-session identity changed during initialization");
        }
        _browserSessionEpoch = persisted;
        return persisted;
      }
      const epoch = _mintMcpTabMarker();
      try {
        await browser.storage.session.set({ [_BROWSER_SESSION_EPOCH_KEY]: epoch });
      } catch {
        throw new Error("Could not persist browser-session identity");
      }
      // Read back the shared in-memory value. If two worker starts raced, only the
      // value that actually remains in storage may authorize receipts.
      let confirmed;
      try {
        confirmed = await browser.storage.session.get(_BROWSER_SESSION_EPOCH_KEY);
      } catch {
        throw new Error("Could not confirm browser-session identity");
      }
      const confirmedEpoch = String(confirmed?.[_BROWSER_SESSION_EPOCH_KEY] || "");
      if (!/^[a-f0-9]{36}$/.test(confirmedEpoch)) {
        throw new Error("Browser-session identity confirmation failed");
      }
      if (generation !== _browserEpochGeneration) {
        throw new Error("Browser-session identity changed during initialization");
      }
      _browserSessionEpoch = confirmedEpoch;
      return confirmedEpoch;
    });
  }
  const initialization = _browserEpochInitializationPromise;
  try {
    return await initialization;
  } finally {
    if (_browserEpochInitializationPromise === initialization) {
      _browserEpochInitializationPromise = null;
    }
  }
}

async function _hydrateOwnedTabs() {
  if (_ownedTabsHydrated) return;
  if (_ownedTabsHydrationPromise) return _ownedTabsHydrationPromise;
  const generation = _browserEpochGeneration;
  const hydration = (async () => {
    const browserEpoch = await _ensureBrowserSessionEpoch();
    let liveTabs;
    try {
      liveTabs = await browser.tabs.query({});
    } catch {
      throw new Error("Could not verify live tabs for ownership recovery");
    }
    const liveTabsById = new Map(liveTabs.map((tab) => [tab.id, tab]));
    const liveDigests = new Map();
    try {
      await Promise.all(liveTabs.map(async (tab) => {
        liveDigests.set(tab.id, await _digestTabUrl(tab.url || ""));
      }));
    } catch {
      throw new Error("Could not verify live tab identities for ownership recovery");
    }

    // Load owner sets without trusting their tab ids yet. A set is restored only for
    // a receipt whose browser epoch and exact live tab/window identity both validate.
    const storedOwners = new Map();
    const mergeOwners = (data) => {
      if (!data || typeof data !== "object") return;
      for (const [sid, ids] of Object.entries(data)) {
        if (!Array.isArray(ids)) continue;
        if (!storedOwners.has(sid)) storedOwners.set(sid, new Set());
        for (const id of ids) if (Number.isInteger(Number(id))) storedOwners.get(sid).add(Number(id));
      }
    };
    try {
      const stored = await browser.storage.session.get(_OWNED_TABS_KEY);
      mergeOwners(stored?.[_OWNED_TABS_KEY]);
    } catch {} // storage.session may be unavailable on Safari
    let localOwned;
    try {
      localOwned = await browser.storage.local.get(_OWNED_TABS_LOCAL_KEY);
    } catch {
      throw new Error("Could not load durable tab ownership");
    }
    const ownerEnvelope = localOwned?.[_OWNED_TABS_LOCAL_KEY];
    const ownersFresh = ownerEnvelope && ownerEnvelope.browserEpoch === browserEpoch &&
      typeof ownerEnvelope.at === "number" &&
      (Date.now() - ownerEnvelope.at) < _OWNED_TABS_TTL_MS;
    if (ownersFresh) mergeOwners(ownerEnvelope.tabs);

    let receiptEnvelope = null;
    try {
      const local = await browser.storage.local.get(_TAB_RECEIPTS_KEY);
      receiptEnvelope = local?.[_TAB_RECEIPTS_KEY] || null;
    } catch {
      throw new Error("Could not load durable tab receipts");
    }
    const receiptsFresh = receiptEnvelope && receiptEnvelope.version === _TAB_RECEIPTS_VERSION &&
      receiptEnvelope.browserEpoch === browserEpoch &&
      typeof receiptEnvelope.at === "number" &&
      (Date.now() - receiptEnvelope.at) < _OWNED_TABS_TTL_MS;
    const records = receiptsFresh && Array.isArray(receiptEnvelope.records)
      ? receiptEnvelope.records
      : [];
    const claimedTabIds = new Set();
    const validatedIds = new Map();
    const recoveredReceipts = new Map();
    const recoveredTokens = new Map();
    const recoveredOwners = new Map();

    for (const storedRecord of records) {
      const token = String(storedRecord?.token || "");
      const record = {
        token,
        tabId: Number(storedRecord?.tabId),
        windowId: Number(storedRecord?.windowId),
        browserEpoch: String(storedRecord?.browserEpoch || ""),
        receiptOrigin: String(storedRecord?.receiptOrigin || ""),
        identityDigest: String(storedRecord?.identityDigest || ""),
        issuedAt: Number(storedRecord?.issuedAt) || Date.now(),
      };
      if (!_isValidReceiptRecord(token, record)) continue;

      const resolved = _resolveHydratedReceiptTab(
        liveTabsById, claimedTabIds, record, browserEpoch
      );
      if (!resolved) continue;

      const oldTabId = record.tabId;
      record.tabId = resolved.id;
      record.windowId = resolved.windowId;
      record.identityDigest = liveDigests.get(resolved.id);
      recoveredReceipts.set(token, record);
      recoveredTokens.set(resolved.id, token);
      claimedTabIds.add(resolved.id);
      validatedIds.set(oldTabId, resolved.id);
    }

    for (const [sid, oldIds] of storedOwners) {
      const restored = new Set();
      for (const oldId of oldIds) {
        const resolvedId = validatedIds.get(oldId);
        if (resolvedId !== undefined) restored.add(resolvedId);
      }
      if (restored.size) recoveredOwners.set(sid, restored);
    }

    if (generation !== _browserEpochGeneration || browserEpoch !== _browserSessionEpoch) {
      throw new Error("Browser session changed during tab ownership recovery");
    }
    _receiptByToken.clear();
    _tokenByTabId.clear();
    _sessionOwnedTabs.clear();
    for (const [token, record] of recoveredReceipts) _receiptByToken.set(token, record);
    for (const [tabId, token] of recoveredTokens) _tokenByTabId.set(tabId, token);
    for (const [sid, restored] of recoveredOwners) _sessionOwnedTabs.set(sid, restored);
    _recoverSessionWindowsFromOwnedTabs(liveTabsById);
    _ownedTabsHydrated = true;
  })();
  _ownedTabsHydrationPromise = hydration;
  try {
    await hydration;
  } finally {
    if (_ownedTabsHydrationPromise === hydration) _ownedTabsHydrationPromise = null;
  }
}
async function _persistOwnedTabs(requireDurableReceipt = false) {
  const browserEpoch = await _ensureBrowserSessionEpoch();
  const generation = _browserEpochGeneration;
  const owners = {};
  for (const [sid, set] of _sessionOwnedTabs) owners[sid] = [...set];
  const receiptEnvelope = {
    version: _TAB_RECEIPTS_VERSION,
    browserEpoch,
    at: Date.now(),
    records: [..._receiptByToken.values()].map((record) => ({ ...record })),
  };

  return _withBrowserEpochStorageLock(async () => {
    if (generation !== _browserEpochGeneration || browserEpoch !== _browserSessionEpoch) {
      throw new Error("Browser session changed before tab authority could be persisted");
    }

    let sessionWrite = Promise.resolve();
    try {
      sessionWrite = Promise.resolve(browser.storage.session.set({ [_OWNED_TABS_KEY]: owners }));
    } catch {} // Safari may not implement storage.session

    let localWrite;
    try {
      localWrite = Promise.resolve(browser.storage.local.set({
        [_TAB_RECEIPTS_KEY]: receiptEnvelope,
        [_OWNED_TABS_LOCAL_KEY]: { browserEpoch, at: Date.now(), tabs: owners },
      }));
    } catch (error) {
      localWrite = Promise.reject(error);
    }

    const results = await Promise.allSettled([sessionWrite, localWrite]);
    if (generation !== _browserEpochGeneration || browserEpoch !== _browserSessionEpoch) {
      throw new Error("Browser session changed while tab authority was being persisted");
    }
    if (requireDurableReceipt && results[1]?.status !== "fulfilled") {
      throw new Error("Could not persist tab receipt");
    }
    return results;
  });
}

function _extractMcpTabMarker(url) {
  const match = String(url || "").match(/(?:[?#&])mcp-tab=([A-Za-z0-9_-]{12,})(?:[&#]|$)/);
  return match ? match[1] : "";
}

function _receiptForOwnedTab(sessionId, tab) {
  // A receipt is a capability to adopt and mutate this exact tab after a stateless
  // reconnect. Never reveal session A's capability to session B via list_tabs.
  if (!tab || !_isTabOwnedBySession(sessionId, tab.id)) return "";
  const token = _tokenByTabId.get(tab.id) || "";
  const record = _receiptByToken.get(token);
  if (!record || record.tabId !== tab.id) return "";
  return _receiptOrigin(tab.url) === record.receiptOrigin ? token : "";
}

function _mintMcpTabMarker() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function _withReceiptMutationLock(operation) {
  const previous = _receiptMutationTail;
  const current = previous.catch(() => {}).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  _receiptMutationTail = tail;
  return current;
}

async function _issueTabReceipt(tab, options = {}) {
  if (!tab || !Number.isInteger(Number(tab.id))) return "";
  const tabId = Number(tab.id);
  return _withReceiptMutationLock(async () => {
    const receiptOrigin = String(options.receiptOrigin || _receiptOrigin(tab.url) || "");
    if (!receiptOrigin) return "";
    const browserEpoch = await _ensureBrowserSessionEpoch();
    const identityDigest = await _digestTabUrl(options.identityUrl ?? tab.url ?? "");
    const token = _mintMcpTabMarker();
    const oldToken = _tokenByTabId.get(tabId) || "";
    const oldRecord = oldToken ? _receiptByToken.get(oldToken) : null;
    const record = {
      token,
      tabId,
      windowId: Number(tab.windowId),
      browserEpoch,
      receiptOrigin,
      identityDigest,
      issuedAt: Date.now(),
    };
    if (oldToken) _receiptByToken.delete(oldToken);
    _receiptByToken.set(token, record);
    _tokenByTabId.set(record.tabId, token);
    try {
      await _persistOwnedTabs(true);
    } catch (error) {
      _receiptByToken.delete(token);
      // The global mutation queue makes this a CAS guard too: never restore over a newer token
      // if this function is ever called outside the serialized path in the future.
      if (_tokenByTabId.get(record.tabId) === token) {
        if (oldToken && oldRecord) {
          _receiptByToken.set(oldToken, oldRecord);
          _tokenByTabId.set(record.tabId, oldToken);
        } else {
          _tokenByTabId.delete(record.tabId);
        }
      }
      throw error;
    }
    return token;
  });
}

async function _refreshTabReceiptIdentity(tab) {
  return _withReceiptMutationLock(async () => {
    const token = _tokenByTabId.get(tab?.id);
    const record = token ? _receiptByToken.get(token) : null;
    if (!record || !tab) return;
    const nextIdentityDigest = await _digestTabUrl(tab.url || "");
    const previousWindowId = record.windowId;
    const previousIdentityDigest = record.identityDigest;
    record.windowId = Number(tab.windowId);
    record.identityDigest = nextIdentityDigest;
    // Deliberately keep receiptOrigin unchanged. A redirect may update identity for
    // locator-only getReceipt recovery, but never extends mutation authority.
    try {
      await _persistOwnedTabs(true);
    } catch (error) {
      record.windowId = previousWindowId;
      record.identityDigest = previousIdentityDigest;
      throw error;
    }
  });
}

async function _refreshAllReceiptIdentities() {
  return _withReceiptMutationLock(async () => {
    const updates = [];
    for (const [tabId, token] of [..._tokenByTabId]) {
      const record = _receiptByToken.get(token);
      if (!record) continue;
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (!tab) continue;
      updates.push({
        record,
        previousWindowId: record.windowId,
        previousIdentityDigest: record.identityDigest,
        nextWindowId: Number(tab.windowId),
        nextIdentityDigest: await _digestTabUrl(tab.url || ""),
      });
    }
    for (const update of updates) {
      update.record.windowId = update.nextWindowId;
      update.record.identityDigest = update.nextIdentityDigest;
    }
    try {
      await _persistOwnedTabs(true);
    } catch (error) {
      for (const update of updates) {
        update.record.windowId = update.previousWindowId;
        update.record.identityDigest = update.previousIdentityDigest;
      }
      throw error;
    }
  });
}

async function _resolveReceiptTab(token, { allowOriginChange = false } = {}) {
  return _withReceiptMutationLock(async () => {
    const normalized = String(token || "");
    if (!/^[A-Za-z0-9_-]{24,}$/.test(normalized)) return null;
    const record = _receiptByToken.get(normalized);
    if (!_isValidReceiptRecord(normalized, record)) return null;
    const browserEpoch = await _ensureBrowserSessionEpoch();
    if (record.browserEpoch !== browserEpoch) return null;

    const allTabs = await browser.tabs.query({});
    const direct = allTabs.find((tab) => tab.id === record.tabId) || null;
    if (!direct) return null;
    const directDigest = await _digestTabUrl(direct.url || "");
    if (directDigest === record.identityDigest ||
      (_tokenByTabId.get(direct.id) === normalized && _isTabOwnedByAnySession(direct.id))) {
      if (directDigest !== record.identityDigest) {
        const previousWindowId = record.windowId;
        const previousIdentityDigest = record.identityDigest;
        record.identityDigest = directDigest;
        record.windowId = direct.windowId;
        try {
          await _persistOwnedTabs(true);
        } catch (error) {
          record.windowId = previousWindowId;
          record.identityDigest = previousIdentityDigest;
          throw error;
        }
      }
    } else {
      return null;
    }

    const currentOrigin = _receiptOrigin(direct.url);
    if (!allowOriginChange && currentOrigin !== record.receiptOrigin) return null;
    return direct;
  });
}

function _addOwnedTab(sessionId, tabId) {
  return _withReceiptMutationLock(async () => {
    const sid = sessionId || _DEFAULT_SESSION;
    if (!_sessionOwnedTabs.has(sid)) _sessionOwnedTabs.set(sid, new Set());
    _sessionOwnedTabs.get(sid).add(tabId);
    return _persistOwnedTabs();
  });
}

function _removeOwnedTab(sessionId, tabId) {
  return _withReceiptMutationLock(async () => {
    const sid = sessionId || _DEFAULT_SESSION;
    const set = _sessionOwnedTabs.get(sid);
    const hadOwnership = !!set?.has(tabId);
    const previousToken = _tokenByTabId.get(tabId);
    const previousRecord = previousToken ? _receiptByToken.get(previousToken) : null;
    if (set) set.delete(tabId);
    let revokedReceipt = false;
    if (!_isTabOwnedByAnySession(tabId)) {
      _tokenByTabId.delete(tabId);
      if (previousToken) _receiptByToken.delete(previousToken);
      revokedReceipt = true;
    }
    try {
      await _persistOwnedTabs(true);
    } catch (error) {
      if (set && hadOwnership) set.add(tabId);
      if (revokedReceipt && previousToken) {
        _tokenByTabId.set(tabId, previousToken);
        if (previousRecord) _receiptByToken.set(previousToken, previousRecord);
      }
      throw error;
    }
  });
}

function _isTabOwnedBySession(sessionId, tabId) {
  const sid = sessionId || _DEFAULT_SESSION;
  const set = _sessionOwnedTabs.get(sid);
  return set ? set.has(tabId) : false;
}

function _isTabOwnedByAnySession(tabId) {
  for (const set of _sessionOwnedTabs.values()) {
    if (set.has(tabId)) return true;
  }
  return false;
}

function _hasTabReceiptAuthority(sessionId, tabId, receiptResolved) {
  return receiptResolved === true || _isTabOwnedBySession(sessionId, tabId);
}

// The browser-run epoch lives only in storage.session. Safari clears that area at the
// browser-session boundary, so old local receipt envelopes cannot become valid again
// if tab ids are reused. Worker suspension keeps the session value; absence or API
// failure is terminal for authority rather than falling back to storage.local.

// Read-only commands that don't modify the page — allowed on any tab
const _readOnlyCommands = new Set([
  "list_tabs", "read_page", "get_source", "snapshot", "accessibility_snapshot",
  "get_element", "query_all", "screenshot", "screenshot_element",
  "console_messages", "network_requests", "list_console_messages",
  "list_network_requests", "get_console_message", "get_network_request",
  "start_console", "start_network_capture", "network", "network_details",
  "console_filter", "performance_metrics", "css_coverage", "get_computed_style",
  "extract_images", "extract_links", "extract_meta", "extract_tables",
  "get_cookies", "local_storage", "session_storage",
  "get_indexed_db", "list_indexed_dbs", "detect_forms",
  "save_pdf", "analyze_page",
]);

function _getSessionCache(sessionId) {
  const sid = sessionId || _DEFAULT_SESSION;
  if (!_sessionTabCache.has(sid)) {
    _sessionTabCache.set(sid, { tabId: null, tabUrl: null, time: 0 });
  }
  return _sessionTabCache.get(sid);
}

// Prune stale sessions — runs every 60s
function _pruneSessionCache() {
  const now = Date.now();
  for (const [sid, cache] of _sessionTabCache) {
    if (sid === _DEFAULT_SESSION) continue;
    // Remove sessions with no active tab that haven't been used in 5 min
    if (!cache.tabId && (now - cache.time) > SESSION_MAX_AGE_MS) {
      _sessionTabCache.delete(sid);
    }
  }
  // Hard cap: if still too many, remove oldest
  if (_sessionTabCache.size > MAX_SESSIONS) {
    const sorted = [..._sessionTabCache.entries()]
      .filter(([sid]) => sid !== _DEFAULT_SESSION)
      .sort((a, b) => a[1].time - b[1].time);
    while (_sessionTabCache.size > MAX_SESSIONS && sorted.length) {
      const [sid] = sorted.shift();
      _sessionTabCache.delete(sid);
    }
  }
}
setInterval(_pruneSessionCache, 60000);

function _setSessionTab(sessionId, tabId, tabUrl) {
  const cache = _getSessionCache(sessionId);
  cache.tabId = tabId;
  cache.tabUrl = tabUrl || cache.tabUrl;
  cache.time = Date.now();
}

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  // Only track activations from the profile window
  if (_profileWindowId && windowId !== _profileWindowId) return;
  // Do NOT update any session cache — onActivated fires for ALL tab switches
  // (including those triggered by other sessions). Updating here is what caused
  // the cross-session interference. Sessions track their own tabs explicitly.
});

browser.tabs.onRemoved.addListener((tabId) => {
  _withReceiptMutationLock(async () => {
    // A cold worker can receive tab events before its durable maps are hydrated. Never
    // persist an empty in-memory state over valid receipts/ownership from the last worker.
    await _hydrateOwnedTabs();
    // Clean up any session that was tracking this tab
    for (const [sid, cache] of _sessionTabCache) {
      if (cache.tabId === tabId) {
        cache.tabId = null;
        cache.tabUrl = null;
      }
    }
    // Also remove from owned tabs — prevents stale ownership on externally closed tabs
    for (const [sid, ownedSet] of _sessionOwnedTabs) {
      ownedSet.delete(tabId);
    }
    const token = _tokenByTabId.get(tabId);
    _tokenByTabId.delete(tabId);
    if (token) _receiptByToken.delete(token);
    await _persistOwnedTabs();
  }).catch(() => {});
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  _hydrateOwnedTabs().then(() => {
    if (!_tokenByTabId.has(tabId)) return null;
    return tab && tab.id === tabId
      ? tab
      : browser.tabs.get(tabId).catch(() => null);
  }).then((resolved) => {
    if (resolved) return _refreshTabReceiptIdentity(resolved);
  }).catch(() => {});
});

// Verify this extension instance is running in the expected profile.
// Safari extensions see only their own profile's windows/tabs.
// If the server expects a specific profile but this worker's windows don't match, we're in the wrong profile.
async function _verifyProfileMatch(expectedProfile) {
  try {
    const expected = _canonicalProfileName(expectedProfile);
    const allWindows = await browser.windows.getAll({ populate: true });
    const stored = await browser.storage.local.get("mcpVerifiedProfile").catch(() => ({}));
    const storedProfile = _canonicalProfileName(stored.mcpVerifiedProfile);
    // No window in this profile → it cannot be the profile the server drives, and probing
    // would have to create one. Only a worker that this profile previously proved may
    // reconnect windowless; new_tab can then use browser.windows.create() with
    // focused:false inside that same verified profile.
    if (!allWindows.length) return !!expected && storedProfile === expected;
    // Check if any window's tab titles contain the profile name pattern "ProfileName —"
    // Safari profile windows show: "ProfileName — Tab Title" in window name
    // But the extension only sees its OWN profile's windows, so we check if tabs exist at all.
    // The key insight: if this extension is in the personal profile, it will see personal windows.
    // We use a stored marker to identify which profile this extension belongs to.
    if (storedProfile) {
      if (storedProfile === expected) {
        // Migrate old values such as "wrong:<profile> — <tab title>" in place.
        if (stored.mcpVerifiedProfile !== expected) {
          await browser.storage.local.set({ mcpVerifiedProfile: expected });
        }
        return true;
      }
      return false;
    }

    // First time: identify this worker's profile without creating a tab. A temporary
    // tab-creation probe used to make a tab appear and disappear in the user's
    // personal window on every transient verification failure. Instead, stamp a nonce
    // into the title of an existing background tab, let the server locate that window,
    // and restore the original title in finally. Prefer inactive web tabs so even the
    // short-lived title change stays out of the user's current page.
    const nonce = `mcp-profile-check-${Date.now()}`;
    const candidateTabs = allWindows
      .flatMap(window => window.tabs || [])
      .filter(tab => Number.isInteger(tab.id) && /^(https?|file):/i.test(String(tab.url || "")))
      .sort((a, b) => Number(a.active) - Number(b.active));
    let checkTab = null;
    let previousTitle = "";
    for (const candidate of candidateTabs) {
      try {
        const injected = await browser.scripting.executeScript({
          target: { tabId: candidate.id },
          func: (marker) => {
            const title = document.title;
            document.title = marker;
            return { applied: document.title === marker, title };
          },
          args: [nonce],
        });
        const probe = injected?.[0]?.result;
        if (probe?.applied) {
          checkTab = candidate;
          previousTitle = typeof probe.title === "string" ? probe.title : "";
          break;
        }
      } catch (_) {
        // Restricted/internal pages cannot be scripted; try another existing tab.
      }
    }
    if (!checkTab) {
      console.log("Safari MCP: no existing injectable tab for profile verification — rejecting without opening a tab");
      return false;
    }

    // Ask the server to verify which profile has this nonce
    let verifyRes;
    try {
      verifyRes = await _bridgeFetch(`${HTTP_URL}/verify-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce, expectedProfile }),
        signal: AbortSignal.timeout(5000),
      });
    } finally {
      // Restore only if this is still the same document and still carries our marker.
      // If the page navigated while verification ran, leave its new title untouched.
      await browser.scripting.executeScript({
        target: { tabId: checkTab.id },
        func: (marker, title) => {
          if (document.title === marker) document.title = title;
        },
        args: [nonce, previousTitle],
      }).catch(() => {});
    }

    if (verifyRes && verifyRes.ok) {
      let result;
      try {
        result = await verifyRes.json();
      } catch {
        console.warn("Safari MCP: profile verification response invalid JSON — rejecting");
        return false;
      }
      const detectedProfile = _canonicalProfileName(result.actualProfile);
      if (result.match || detectedProfile === expected) {
        await browser.storage.local.set({ mcpVerifiedProfile: expected });
        return true;
      } else {
        // Persist only a positive identity for this extension instance. "notfound" and
        // transient Apple Events errors are not identities and must not poison retries.
        if (detectedProfile) {
          await browser.storage.local.set({ mcpVerifiedProfile: detectedProfile });
        } else {
          await browser.storage.local.remove("mcpVerifiedProfile").catch(() => {});
        }
        return false;
      }
    }
    // Verification endpoint not available or non-200 — reject to be safe
    console.log("Safari MCP: profile verification inconclusive — rejecting connection");
    return false;
  } catch (err) {
    console.warn("Safari MCP: profile verification error:", err.message, "— rejecting connection");
    return false; // Reject on error — better to miss extension than operate in wrong profile
  }
}

// Discover which windowId belongs to the target profile.
// Safari extensions are per-profile — browser.windows/tabs APIs only see this profile's windows.
// We still need to pin _profileWindowId so commands don't drift to wrong window on focus changes.
async function _discoverProfileWindow() {
  if (!_targetProfile) return;
  try {
    // Try to restore from storage first (survives service worker restart)
    if (!_profileWindowId) {
      try {
        const stored = await browser.storage.local.get("mcpProfileWindowId");
        if (stored.mcpProfileWindowId) {
          // Verify the window still exists
          const win = await browser.windows.get(stored.mcpProfileWindowId).catch(() => null);
          if (win) {
            _profileWindowId = stored.mcpProfileWindowId;
            console.log("Safari MCP: profile window restored from storage:", _profileWindowId);
            return;
          }
        }
      } catch (_) {}
    }

    const allWindows = await browser.windows.getAll();
    if (allWindows.length === 1) {
      _profileWindowId = allWindows[0].id;
    } else {
      const focused = allWindows.find(w => w.focused);
      _profileWindowId = focused ? focused.id : allWindows[0].id;
    }
    // Persist for service worker restarts
    browser.storage.local.set({ mcpProfileWindowId: _profileWindowId }).catch(() => {});
    console.log("Safari MCP: profile window:", _profileWindowId);
  } catch (err) {
    console.warn("Safari MCP: _discoverProfileWindow error:", err.message);
  }
}

async function _getReceiptTargetTab(sessionId) {
  const sid = sessionId || _DEFAULT_SESSION;
  const cache = _getSessionCache(sid);

  // getReceipt is the recovery point after an OAuth redirect invalidates the old
  // origin-bound receipt. Prefer only a concrete tab this exact session already owns,
  // even if the redirect took longer than TAB_CACHE_MS or the tab lives in another
  // Safari window. This does not grant ownership or discover tabs by URL.
  if (cache.tabId && _isTabOwnedBySession(sid, cache.tabId)) {
    try {
      const cached = await browser.tabs.get(cache.tabId);
      if (cached) {
        _adoptWindowForSession(sid, cached.windowId);
        _setSessionTab(sid, cached.id, cached.url || "");
        return cached;
      }
    } catch {
      cache.tabId = null;
      cache.tabUrl = null;
    }
  }

  const ownedIds = _sessionOwnedTabs.get(sid);
  if (ownedIds && ownedIds.size) {
    for (const ownedId of [...ownedIds].reverse()) {
      let ownedTab = null;
      try { ownedTab = await browser.tabs.get(ownedId); }
      catch { ownedIds.delete(ownedId); continue; }
      if (!ownedTab || !_isTabOwnedBySession(sid, ownedTab.id)) continue;
      _adoptWindowForSession(sid, ownedTab.windowId);
      _setSessionTab(sid, ownedTab.id, ownedTab.url || "");
      return ownedTab;
    }
  }

  // Preserve first-command/read-only compatibility. The authority check in
  // handleCommand still rejects getReceipt unless this fallback is already owned.
  return getTargetTab(null, sid);
}

async function getTargetTab(_unusedReceipt, sessionId) {
  const cache = _getSessionCache(sessionId);
  // Resolve against THIS session's window; falls back to the shared one when the
  // session has not opened a tab yet, so first-command behaviour is unchanged.
  const winId = _windowForSession(sessionId);

  // PRIORITY 1: This session's cached tab from new_tab/switch_tab/navigate
  if (cache.tabId && (Date.now() - cache.time) < TAB_CACHE_MS) {
    try {
      const cached = await browser.tabs.get(cache.tabId);
      if (cached && (!winId || cached.windowId === winId)) return cached;
    } catch { cache.tabId = null; }
  }

  // PRIORITY 2: a tab this session actually owns. URL matching is deliberately absent:
  // duplicate/signed/redirected URLs are data, never an ownership capability.
  // With several Claude sessions sharing one Safari profile, "the active tab" is
  // whatever another session (or the user) last brought to the front — measured
  // 23.8.26: commands landed on a parallel session's Telegram tab mid-run, and the
  // ownership guard then rejected them. A session that owns tabs must never be handed
  // someone else's page; prefer its own most recent live one. Sessions that own
  // nothing still fall through to the active tab below, so first-command flows and
  // read-only helpers behave exactly as before.
  const ownedIds = _sessionOwnedTabs.get(sessionId || _DEFAULT_SESSION);
  if (ownedIds && ownedIds.size) {
    for (const ownedId of [...ownedIds].reverse()) {
      let ownedTab = null;
      try { ownedTab = await browser.tabs.get(ownedId); }
      catch { ownedIds.delete(ownedId); continue; } // closed since — forget it
      if (!ownedTab) { ownedIds.delete(ownedId); continue; }
      if (winId && ownedTab.windowId !== winId) continue;
      _setSessionTab(sessionId, ownedTab.id, ownedTab.url || "");
      return ownedTab;
    }
  }

  // PRIORITY 3: Active tab of the profile window (no session bias)
  if (winId) {
    const tabs = await browser.tabs.query({ active: true, windowId: winId });
    if (tabs[0]) return tabs[0];
    console.warn("Safari MCP: profile window has no active tab, re-discovering...");
    await _discoverProfileWindow();
    if (winId) {
      const retryTabs = await browser.tabs.query({ active: true, windowId: winId });
      if (retryTabs[0]) return retryTabs[0];
    }
  }
  return getActiveTab();
}

async function getActiveTab() {
  // Prefer profile window if known
  if (_profileWindowId) {
    const tabs = await browser.tabs.query({ active: true, windowId: _profileWindowId });
    if (tabs[0]) return tabs[0];
  }
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]) throw new Error("No active tab");
  return tabs[0];
}

// Track which tabs already have the deep query helpers injected
const _helpersInjected = new Set();
// Clean up when tabs are removed or navigated
browser.tabs.onRemoved.addListener((tabId) => {
  _helpersInjected.delete(tabId);
  _injectionBlockedTabs.delete(tabId);
});
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    _helpersInjected.delete(tabId);
    // A new page may well allow injection — never keep a tab downgraded across
    // navigations, or one hardened page would permanently slow that tab.
    _injectionBlockedTabs.delete(tabId);
  }
});

async function sendContentCommand(tabId, type, payload, timeoutMs = 1500) {
  const send = async () => {
    let timer;
    return Promise.race([
      browser.tabs.sendMessage(tabId, { type, payload }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(type + " bridge timed out")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };

  try {
    const initial = await send();
    if (initial !== undefined && initial !== null) return initial;
    throw new Error(type + " bridge returned no result");
  } catch (_) {
    // Reloading/updating a Safari extension invalidates content-script listeners in
    // already-open tabs. Safari 18 also fails to return responses from listeners
    // injected into such a tab. Schedule a small, self-contained DOM action and
    // return BEFORE it runs: page-listener exceptions then cannot be misreported as
    // an executeScript failure, and a filled form survives an extension repair.
    const scheduled = await browser.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: (commandType, commandPayload) => {
        const find = () => {
          if (commandPayload.ref) {
            const safe = String(commandPayload.ref).replace(/["\\]/g, "\\$&");
            return document.querySelector('[data-mcp-ref="' + safe + '"]');
          }
          if (commandPayload.selector) {
            try { return document.querySelector(commandPayload.selector); } catch (_) { return null; }
          }
          if (commandPayload.x !== undefined && commandPayload.y !== undefined) {
            return document.elementFromPoint(Number(commandPayload.x), Number(commandPayload.y));
          }
          if (commandPayload.text) {
            const candidates = document.querySelectorAll("button,a,[role='button'],[role='link'],[role='option'],[role='combobox']");
            for (const candidate of candidates) {
              if ((candidate.innerText || candidate.textContent || "").trim() === commandPayload.text) return candidate;
            }
          }
          return null;
        };
        setTimeout(() => {
          try {
            const el = find();
            if (!el) return;
            if (commandType === "mcp-content-fill") {
              const value = String(commandPayload.value ?? "");
              el.focus();
              if (el.isContentEditable) {
                el.textContent = value;
              } else if ("value" in el) {
                const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                setter ? setter.call(el, value) : (el.value = value);
              }
              el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
              el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
              return;
            }
            el.scrollIntoView({ block: "center", inline: "center" });
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
            let from = document.elementFromPoint(cx, cy);
            if (!from || !(from === el || el.contains(from))) from = el;
            try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
            from.dispatchEvent(new MouseEvent("click", {
              bubbles: true, cancelable: true, composed: true, view: window,
              clientX: cx, clientY: cy, button: 0, buttons: 0, detail: 1,
            }));
          } catch (_) {}
        }, 0);
        return { ok: true, result: "Scheduled " + commandType };
      },
      args: [type, payload],
    });
    return scheduled[0]?.result;
  }
}

// Every probe plus the content bridge must fit inside the server's 30s command
// timeout with room to spare: helpers 3 + MAIN 3 + ISOLATED 3 + bridge 10 ≈ 19s.
// Earlier values (8s each) added up to ~29s and the caller gave up first, so the
// bridge never got to answer and the tab was never marked as injection-blocked.
const MAIN_WORLD_INJECT_MS = 3000;
// Tabs where BOTH injection worlds stalled. Only the first command on such a page pays
// the probing cost; afterwards we go straight to the content bridge, which keeps these
// pages fast instead of merely working. Cleared when the tab navigates or closes, so a
// page that stops blocking injection is re-probed rather than downgraded forever.
const _injectionBlockedTabs = new Set();
function _withInjectionDeadline(promise, ms = MAIN_WORLD_INJECT_MS) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("MAIN world injection stalled")), ms);
    }),
  ]);
}

async function execInTab(func, args = [], tabId = null) {
  const id = tabId || (await getActiveTab()).id;
  try {
    // Auto-inject deep query helpers — skip if already injected for this tab+page
    if (!_helpersInjected.has(id)) {
      // Same stall risk as the real injection below, and this one runs first — an
      // unbounded await here would hang the command before it ever gets a chance to
      // fall back. The helpers are optional, so a stall here is simply skipped.
      await _withInjectionDeadline(
        browser.scripting.executeScript({ target: { tabId: id }, world: "MAIN", func: _deepQueryScript })
      ).catch(() => {});
      _helpersInjected.add(id);
    }

    // business.facebook.com (and other hardened SPAs) can leave a MAIN-world injection
    // pending forever instead of rejecting it — measured 23.8.26: identical evaluate
    // returns instantly on a 16,845-node Wikipedia page but never resolves there. The
    // command then died on the caller's 30s timeout with no usable error. Bound the
    // MAIN attempt and fall back to the ISOLATED world, which shares the same DOM.
    // ponytail: page globals are not visible from ISOLATED; DOM reads (the vast
    // majority of evaluate calls) behave identically. A wrong-world answer beats none.
    let results;
    try {
      results = await _withInjectionDeadline(
        browser.scripting.executeScript({ target: { tabId: id }, world: "MAIN", func, args })
      );
    } catch (mainErr) {
      if (!/injection stalled/.test(mainErr?.message || "")) throw mainErr;
      console.warn("Safari MCP: MAIN world stalled, retrying ISOLATED on tabId=" + id);
      results = await _withInjectionDeadline(
        browser.scripting.executeScript({ target: { tabId: id }, world: "ISOLATED", func, args })
      );
      // If ISOLATED stalls too the page blocks injection outright, and there is nothing
      // generic left to try — execInTab relays a FUNCTION, which the content bridge
      // cannot accept. evaluate handles that case itself (Strategy 0) with raw source.
    }
    const first = results[0];
    // Safari can report an injection exception on the result item instead of
    // rejecting executeScript(). Treating that as a successful `null` hid the
    // real click failure and triggered an unrelated AppleScript fallback.
    if (first?.error) throw new Error(first.error);
    return first?.result;
  } catch (err) {
    console.error("execInTab error on tabId=" + id + ":", err.message);
    throw new Error("execInTab failed: " + err.message);
  }
}

// Event dispatch from Safari's MAIN injection world can inherit an exception from
// a page listener as the opaque "JavaScript extension error", even though normal
// browser event dispatch would only report that exception to the page console. The
// isolated world shares the same DOM/event path but keeps page exceptions from
// aborting the WebExtension command. Clicks need that boundary; reads and framework
// introspection continue to use MAIN through execInTab().
async function execInTabIsolated(func, args = [], tabId = null) {
  const id = tabId || (await getActiveTab()).id;
  const execute = () => browser.scripting.executeScript({
    target: { tabId: id },
    world: "ISOLATED",
    func,
    args,
  });
  try {
    let results;
    try {
      results = await execute();
    } catch (initialError) {
      const message = initialError?.message || String(initialError);
      const accessIsStillSettling =
        message.includes("does not have access to this tab") ||
        message.includes("Invalid call to scripting.executeScript");
      if (!accessIsStillSettling) throw initialError;

      // Safari can finish a background navigation before its WebExtension access
      // grant settles. A rejected executeScript call has not run page code, so one
      // bounded retry cannot duplicate a click or other DOM action.
      const tab = await browser.tabs.get(id).catch(() => null);
      if (tab?.status === "loading") await waitForTabLoad(id, 3000).catch(() => {});
      await sleep(250);
      results = await execute();
    }
    const first = results[0];
    if (first?.error) throw new Error(first.error);
    return first?.result;
  } catch (err) {
    console.error("execInTabIsolated error on tabId=" + id + ":", err.message);
    throw new Error("execInTabIsolated failed: " + err.message);
  }
}

// Execute one function in every document while keeping the same bounded MAIN →
// ISOLATED recovery used by execInTab.  The previous unbounded MAIN-only path could
// consume the entire 30s command timeout on one heavy iframe and make a healthy
// extension look disconnected.
async function _executeAllFrames(func, args = [], tabId = null) {
  const id = tabId || (await getActiveTab()).id;
  const execute = (world) => _withInjectionDeadline(browser.scripting.executeScript({
    target: { tabId: id, allFrames: true },
    world,
    func,
    args,
  }));

  try {
    return await execute("MAIN");
  } catch (mainError) {
    console.warn("Safari MCP: all-frame MAIN injection failed, retrying ISOLATED on tabId=" + id + ": " + (mainError?.message || String(mainError)));
    try {
      return await execute("ISOLATED");
    } catch (isolatedError) {
      throw new Error("all-frame injection failed: " + (isolatedError?.message || String(isolatedError)));
    }
  }
}

// Mutating fallbacks must never broadcast an action to every frame or retry it after
// an ambiguous executeScript rejection. First locate one frame with a read-only probe,
// then dispatch once to that concrete frame in ISOLATED world. If the one dispatch has
// an unknown outcome, fail terminally so a caller can verify state before retrying.
async function execInFirstMatchingFrameMutating(matchFunc, matchArgs, func, args, tabId = null) {
  const id = tabId || (await getActiveTab()).id;
  const matches = await _executeAllFrames(matchFunc, matchArgs, id);
  const match = matches.find((entry) => !entry?.error && entry?.result === true);
  if (!match) return null;
  if (!Number.isInteger(match.frameId)) {
    throw new Error("Matched frame has no stable frameId; refusing mutating iframe fallback");
  }

  try {
    const results = await _withInjectionDeadline(browser.scripting.executeScript({
      target: { tabId: id, frameIds: [match.frameId] },
      world: "ISOLATED",
      func,
      args,
    }));
    const first = results[0];
    if (first?.error) throw new Error(first.error);
    return first?.result;
  } catch (error) {
    throw new Error("Mutating iframe injection outcome is unknown; refusing automatic retry: " + (error?.message || String(error)));
  }
}

// Shared exact-frame probe and MAIN-world one-shot popup capture. It stays
// self-contained because Safari serializes it into each frame; closure references
// are unavailable there. Probe mode is read-only. Capture mode dispatches one click,
// restores window.open in finally, and returns the exact URL only to this worker.
function _popupClickFrameAction(selector, ref, mode) {
  const isProbe = mode === "probe";
  const query = ref
    ? '[data-mcp-ref="' + String(ref).replace(/["\\]/g, "\\$&") + '"]'
    : String(selector || "");
  if (!query) return isProbe ? { count: 0 } : { ok: false, code: "missing_target" };

  const found = [];
  const seen = new Set();
  const visit = (root) => {
    let candidates;
    try { candidates = root.querySelectorAll(query); }
    catch { return false; }
    for (const candidate of candidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        found.push(candidate);
      }
    }
    let all;
    try { all = root.querySelectorAll("*"); } catch { all = []; }
    for (const host of all) {
      let shadow = null;
      try {
        shadow = window.__mcpGetShadowRoot
          ? window.__mcpGetShadowRoot(host)
          : host.shadowRoot;
      } catch {}
      if (shadow && visit(shadow) === false) return false;
    }
    return true;
  };
  if (visit(document) === false) {
    return isProbe
      ? { invalidSelector: true, count: 0 }
      : { ok: false, code: "invalid_selector" };
  }

  const visible = found.filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden" &&
      parseFloat(style.opacity || "1") !== 0;
  });
  if (isProbe) return { count: visible.length };
  if (visible.length !== 1) {
    return { ok: false, code: visible.length ? "ambiguous_target" : "missing_target" };
  }

  const element = visible[0];
  if (element.disabled || element.getAttribute("aria-disabled") === "true") {
    return { ok: false, code: "disabled_target" };
  }

  // This action is for ordinary OAuth/partner popups, never CAPTCHA automation.
  const captchaPattern = /(?:^|[^a-z])(recaptcha|hcaptcha|turnstile|captcha|cf-chl|challenge-platform|challenges?\.cloudflare\.com)(?:[^a-z]|$)/i;
  let safetySignal = location.hostname + " " + location.pathname;
  for (let current = element, depth = 0; current && depth < 8; current = current.parentElement, depth += 1) {
    safetySignal += " " + [
      current.id,
      current.className,
      current.getAttribute && current.getAttribute("name"),
      current.getAttribute && current.getAttribute("aria-label"),
      current.getAttribute && current.getAttribute("title"),
      current.getAttribute && current.getAttribute("data-sitekey"),
    ].filter(Boolean).join(" ");
  }
  if (captchaPattern.test(String(safetySignal))) {
    return { ok: false, code: "captcha_refused" };
  }

  let capturedUrl = "";
  let sawNonHttp = false;
  const capture = (candidate) => {
    if (capturedUrl || candidate === undefined || candidate === null || String(candidate) === "") return;
    try {
      const rawCandidate = String(candidate);
      const parsed = new URL(rawCandidate, location.href);
      if (!/^https?:$/.test(parsed.protocol)) {
        sawNonHttp = true;
        return;
      }
      // Preserve an absolute caller string byte-for-byte. OAuth providers can sign
      // query bytes, and URL reserialization is allowed only for a relative target.
      capturedUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawCandidate)
        ? rawCandidate
        : parsed.href;
    } catch {}
  };

  // OAuth helpers sometimes open about:blank first and set popup.location next.
  // A tiny inert stand-in captures both forms without creating any real popup.
  const locationStub = {
    assign: capture,
    replace: capture,
    reload() {},
    toString() { return ""; },
  };
  Object.defineProperty(locationStub, "href", {
    configurable: true,
    get() { return ""; },
    set(value) { capture(value); },
  });
  const popupStub = {
    closed: false,
    close() { this.closed = true; },
    focus() {},
    blur() {},
    postMessage() {},
  };
  Object.defineProperty(popupStub, "location", {
    configurable: true,
    get() { return locationStub; },
    set(value) { capture(value); },
  });

  const originalDescriptor = Object.getOwnPropertyDescriptor(window, "open");
  const hadOwnOpen = Object.prototype.hasOwnProperty.call(window, "open");
  const originalOpen = window.open;
  const interceptedOpen = function(url) {
    capture(url);
    return popupStub;
  };

  let installed = false;
  let clickFailed = false;
  try {
    try {
      Object.defineProperty(window, "open", {
        configurable: true,
        writable: true,
        value: interceptedOpen,
      });
      installed = window.open === interceptedOpen;
    } catch {}
    if (!installed) {
      try {
        window.open = interceptedOpen;
        installed = window.open === interceptedOpen;
      } catch {}
    }
    if (!installed) return { ok: false, code: "capture_unavailable" };

    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: 0,
      detail: 1,
    });
    // Exactly one event, no pointer prelude, no .click() fallback, no retry.
    element.dispatchEvent(event);
  } catch {
    // A page may throw after window.open (for example while touching a property on
    // the blocked popup). The captured URL remains authoritative; only fail if the
    // handler threw before producing one.
    clickFailed = true;
  } finally {
    try {
      if (hadOwnOpen && originalDescriptor) {
        Object.defineProperty(window, "open", originalDescriptor);
      } else if (!hadOwnOpen) {
        delete window.open;
      } else {
        window.open = originalOpen;
      }
    } catch {
      try { window.open = originalOpen; } catch {}
    }
  }

  if (!capturedUrl) {
    return {
      ok: false,
      code: sawNonHttp ? "non_http_popup" : (clickFailed ? "click_failed" : "no_popup"),
    };
  }
  return { ok: true, popupUrl: capturedUrl };
}

async function execInExactMatchingFrameMainOnce(matchFunc, matchArgs, func, args, tabId = null) {
  const id = tabId || (await getActiveTab()).id;
  const probes = await _executeAllFrames(matchFunc, matchArgs, id);
  if (probes.some((entry) => !entry?.error && entry?.result?.invalidSelector)) {
    throw new Error("clickAndOpenPopup received an invalid selector");
  }

  const matches = probes.filter((entry) =>
    !entry?.error && Number.isInteger(entry?.frameId) && Number(entry?.result?.count) > 0
  );
  const targetCount = matches.reduce((total, entry) => total + Number(entry.result.count), 0);
  if (targetCount === 0) return null;
  if (targetCount !== 1 || matches.length !== 1) {
    throw new Error("clickAndOpenPopup target is ambiguous across frames");
  }

  try {
    const results = await _withInjectionDeadline(browser.scripting.executeScript({
      target: { tabId: id, frameIds: [matches[0].frameId] },
      world: "MAIN",
      func,
      args,
    }));
    const first = results[0];
    if (first?.error) throw new Error(first.error);
    return first?.result;
  } catch {
    // The MAIN-world click may already have run. Never auto-retry an ambiguous mutation.
    throw new Error("One-shot popup click outcome is unknown; refusing automatic retry");
  }
}

function _isFrameMiss(value) {
  return value === null || value === undefined ||
    (typeof value === "string" && value.startsWith("Element not found"));
}

// Execute in ALL frames (including cross-origin iframes) and return the first real
// match.  A top-frame `Element not found` is a semantic miss, not a result: allowing
// it to win used to hide valid matches in every child frame behind it.
async function execInAllFrames(func, args = [], tabId = null) {
  try {
    const results = await _executeAllFrames(func, args, tabId);
    for (const r of results) {
      if (!r?.error && !_isFrameMiss(r?.result)) return r.result;
    }
    return null;
  } catch (_err) {
    // Some restricted pages reject allFrames entirely. Keep the historical safe
    // fallback to the already-bounded main-frame executor.
    return execInTab(func, args, tabId);
  }
}

// Like execInAllFrames, but for functions that return a JSON array: it skips frames
// that matched nothing instead of stopping at the first non-null result. The main
// frame nearly always returns "[]" — non-null — which would otherwise mask every
// cross-origin frame behind it.
async function execAcrossFrames(func, args = [], tabId = null) {
  try {
    const results = await _executeAllFrames(func, args, tabId);
    const merged = [];
    for (const r of results) {
      if (!r || r.result == null) continue;
      try {
        const parsed = JSON.parse(r.result);
        if (Array.isArray(parsed) && parsed.length) merged.push(...parsed);
      } catch { /* frame returned a non-array payload — ignore it */ }
    }
    return merged.length ? JSON.stringify(merged) : null;
  } catch {
    return null;
  }
}

// Snapshot-like commands need content from every matching frame, not just the first.
// Each frame is responsible for assigning collision-free refs before its text is
// merged here, so the returned tree remains directly actionable.
async function execTextAcrossFrames(func, args = [], tabId = null) {
  try {
    const results = await _executeAllFrames(func, args, tabId);
    const chunks = [];
    for (const r of results) {
      if (r?.error || _isFrameMiss(r?.result)) continue;
      if (typeof r.result === "string" && r.result.trim()) chunks.push(r.result);
    }
    return chunks.length ? chunks.join("\n") : null;
  } catch (_err) {
    return execInTab(func, args, tabId);
  }
}

async function waitForTabLoad(tabId, timeout = 30000) {
  // Check if already complete BEFORE registering listeners (prevents missing instant-complete events)
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === "complete") return;
  } catch { return; } // Tab already gone

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

  // Reset React's _valueTracker so React sees subsequent value changes as "new".
  // Without this, React compares old===new and ignores our dispatched events.
  window.__mcpResetTracker = function(el, prevValue) {
    var t = el._valueTracker;
    if (t) t.setValue(prevValue !== undefined ? prevValue : "");
  };

  // Shared Closure/Medium char-by-char typing with full keyboard event sequence.
  // Handles Enter→insertParagraph, re-acquires activeElement per iteration.
  // Used by fill (empty editor), type_text, and fill_form contenteditable.
  window.__mcpClosureType = function(text, el) {
    for (var i = 0; i < text.length; i++) {
      var target = document.activeElement || el;
      var ch = text[i];
      if (ch === "\n") {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, code: "Enter", bubbles: true, cancelable: true }));
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
  };

  window.__mcpDeepQueryAll = function(selector, limit) {
    var getSR = window.__mcpGetShadowRoot || function(e) { return e.shadowRoot; };
    const results = [];
    function collect(root) {
      root.querySelectorAll(selector).forEach(el => { if (results.length < limit) results.push(el); });
      root.querySelectorAll("*").forEach(el => {
        var sr = getSR(el);
        if (sr) collect(sr);
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

// ========== KEEP-ALIVE VIA ALARMS + HEARTBEAT ==========
// Safari kills service workers after ~30s of inactivity.
// Three-layer strategy:
// 1. Active fetch() in pollForCommands() keeps the worker alive while connected
// 2. Storage write every 20s keeps the worker alive between polls (Safari counts storage access as activity)
// 3. browser.alarms (1 min minimum) re-wakes the worker if it was terminated
let _heartbeatTimer = null;
function _startHeartbeat() {
  if (_heartbeatTimer || !_enabled || _bridgeWorkerSuperseded) return;
  _heartbeatTimer = setInterval(() => {
    if (_enabled) {
      browser.storage.local.set({ _heartbeat: Date.now() }).catch(() => {});
    }
  }, 20000); // Every 20s — keeps service worker alive between alarm intervals
}
function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

browser.alarms.create("keepalive", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" || alarm.name === "reconnect") {
    // Only reconnect if disconnected, enabled, and no reconnect already scheduled
    if (!isConnected && _enabled && !_bridgeWorkerSuperseded && !_reconnectTimer) {
      scheduleReconnect();
    }
    // Restart heartbeat in case it was lost on worker restart
    if (_enabled && !_bridgeWorkerSuperseded && !_heartbeatTimer) _startHeartbeat();
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
