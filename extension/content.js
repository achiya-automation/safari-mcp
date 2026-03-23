// Content script — runs at document_start in MAIN world (before page scripts)
// Purpose: Monkey-patch attachShadow to capture CLOSED shadow roots.
// Without this, Reddit 2026 and other sites using closed shadow DOM
// are invisible to snapshot/click/fill.
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
