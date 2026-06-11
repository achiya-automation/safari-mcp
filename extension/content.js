// Content script — runs at document_start in MAIN world (before page scripts).
// Two responsibilities:
//   1. Monkey-patch attachShadow to capture CLOSED shadow roots (Reddit, etc.).
//   2. Pre-register a Trusted Types policy named "mcpBridge" BEFORE the page sets
//      its own require-trusted-types-for directive. Our policy is then grandfathered
//      and survives even on pages (Google Search Console, Google admin, modern banks)
//      that block new policy creation after page load. MCP evaluate strategies
//      consult `window.__mcpTrustedPolicy` first.
// Runs in MAIN world via manifest "world": "MAIN" — no script injection needed,
// so CSP cannot block it.

if (!window.__mcpShadowPatched) {
  window.__mcpShadowPatched = true;
  var _origAttachShadow = Element.prototype.attachShadow;
  var _closedRoots = new WeakMap();
  Element.prototype.attachShadow = function(init) {
    var shadow = _origAttachShadow.call(this, init);
    if (init && init.mode === "closed") {
      _closedRoots.set(this, shadow);
    }
    return shadow;
  };
  // Expose getter for MCP tools (snapshot, deepQuery, click, fill).
  // Non-enumerable + non-writable: pages that know the name can still call it
  // (inherent to MAIN-world injection), but it doesn't surface in enumeration and —
  // more importantly — page scripts can't REPLACE it to feed MCP fake shadow roots.
  var _getShadowRoot = function(el) {
    return el.shadowRoot || _closedRoots.get(el) || null;
  };
  try {
    Object.defineProperty(window, "__mcpGetShadowRoot", {
      value: _getShadowRoot, writable: false, enumerable: false, configurable: false
    });
  } catch (_e) {
    window.__mcpGetShadowRoot = _getShadowRoot;
  }
}

if (!window.__mcpTrustedPolicy && window.trustedTypes && typeof window.trustedTypes.createPolicy === "function") {
  try {
    // Register ONLY createScript — the single capability the bridge uses (background.js
    // evaluate sets script.textContent via createScript). A world-accessible pass-through
    // createHTML would let the page's own scripts wrap arbitrary HTML as trusted, defeating
    // its Trusted-Types protection; createScriptURL is likewise unused. Least privilege.
    window.__mcpTrustedPolicy = window.trustedTypes.createPolicy("mcpBridge", {
      createScript: function (s) { return s; }
    });
  } catch (_e) {
    // Page already restricts policies — rare since content script runs at document_start
    // before page scripts. Leave undefined; evaluate fallbacks will probe other paths.
  }
}
