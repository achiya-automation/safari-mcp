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
  // Expose getter for MCP tools (snapshot, deepQuery, click, fill)
  window.__mcpGetShadowRoot = function(el) {
    return el.shadowRoot || _closedRoots.get(el) || null;
  };
}

if (!window.__mcpTrustedPolicy && window.trustedTypes && typeof window.trustedTypes.createPolicy === "function") {
  try {
    window.__mcpTrustedPolicy = window.trustedTypes.createPolicy("mcpBridge", {
      createScript: function (s) { return s; },
      createScriptURL: function (s) { return s; },
      createHTML: function (s) { return s; }
    });
  } catch (_e) {
    // Page already restricts policies — rare since content script runs at document_start
    // before page scripts. Leave undefined; evaluate fallbacks will probe other paths.
  }
}
