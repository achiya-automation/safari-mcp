// Content script — runs at document_start (before page scripts)
// Purpose: Monkey-patch attachShadow to capture CLOSED shadow roots.
// Without this, Reddit 2026 and other sites using closed shadow DOM
// are invisible to snapshot/click/fill — they only see the header.

// Inject into MAIN world so the patch runs on the page's Element.prototype
const script = document.createElement("script");
script.textContent = `(function() {
  if (window.__mcpShadowPatched) return;
  window.__mcpShadowPatched = true;
  var orig = Element.prototype.attachShadow;
  var closedRoots = new WeakMap();
  Element.prototype.attachShadow = function(init) {
    var shadow = orig.call(this, init);
    if (init && init.mode === "closed") {
      closedRoots.set(this, shadow);
    }
    return shadow;
  };
  // Expose getter for MCP tools (snapshot, deepQuery, click, fill)
  window.__mcpGetShadowRoot = function(el) {
    return el.shadowRoot || closedRoots.get(el) || null;
  };
})();`;
(document.head || document.documentElement).prepend(script);
script.remove();
