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

// Last-resort evaluate path for pages that stall scripting.executeScript outright
// (business.facebook.com: the injected evaluate never answers, so every evaluate died on
// the caller's timeout).
//
// This script is ALREADY in MAIN world from document_start, so nothing has to be
// injected to reach the page — that is the whole point. command-content.js lives in
// the ISOLATED world where it can talk to the background but where the page's CSP
// forbids eval; it hands the work here over postMessage, and we run it through the
// same grandfathered Trusted Types policy the injected strategy uses.
//
// Each request carries the evaluate's runId, and a run starts at most once per runId
// (see _evalRunner in background.js): if the injected runner already started it in this
// world we join its promise, if another world claimed it we stay out, else we claim it.
// The message tags and the guard below are new with that protocol, so a listener left
// over from an older build — which would start the script without looking — never sees
// these requests.
if (!window.__mcpEvalOnceBridge) {
  window.__mcpEvalOnceBridge = true;
  // window.postMessage, not CustomEvent: a CustomEvent's `detail` does not survive the
  // ISOLATED→MAIN world boundary (it arrives as null), so the bridge received the event
  // but never the script — it simply timed out. postMessage is structured-cloned across
  // the boundary by design.
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;                       // ignore other frames
    var d = ev.data;
    if (!d || d.__mcp !== "eval_once" || typeof d.id !== "string") return;
    var id = d.id;
    var key = "__mcp_run_" + id;
    var reply = function (result) {
      window.postMessage({ __mcp: "eval_once_res", id: id, result: result }, "*");
    };
    if (window[key]) { window[key].then(reply); return; }
    var claim = "__mcp_claim_" + id;
    if (!document.dispatchEvent(new Event(claim, { cancelable: true }))) return;
    document.addEventListener(claim, function (e) { e.preventDefault(); });
    var source = String(d.source);
    var text = function (v) {
      return v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
    };
    var fail = function (e) { return { ok: false, error: String((e && e.message) || e) }; };
    var run = (async function () {
      // Direct eval first. We are in MAIN world, so this runs under the PAGE's CSP —
      // and business.facebook.com actually allows 'unsafe-eval'. Its script-src does
      // carry a nonce, which is precisely what blocks the injected-<script> path below,
      // so trying that first would fail on the very page this bridge exists for. The
      // "0" probe tells a refused eval (nothing ran) from a script that throws by
      // itself: that one ran, and must not run again through the <script> path.
      var evalAllowed = true;
      try { (0, eval)("0"); } catch (_e) { evalAllowed = false; }
      if (evalAllowed) {
        try { return { ok: true, value: text(await (0, eval)(source)) }; } catch (e) { return fail(e); }
      }
      // An inline script runs inside appendChild, so by the next line the hook has
      // started it — or nothing ran. A nonce-based script-src (facebook.com, since it no
      // longer allows 'unsafe-eval') takes it only with the page's nonce. It goes in as an
      // expression first, so `document.title` answers as through eval; a statement list
      // is a SyntaxError there, which runs nothing, and then goes in as a function body.
      var hook = key + "_start";
      var started = null;
      window[hook] = function (fn) { started = (async function () { return fn(); })(); };
      var nonced = document.querySelector("script[nonce]");
      var bodies = ["return (" + source.replace(/[\s;]+$/, "") + "\n);", source];
      for (var i = 0; i < bodies.length && !started; i++) {
        try {
          var code = "window[" + JSON.stringify(hook) + "](function(){" + bodies[i] + "\n})";
          var s = document.createElement("script");
          if (window.__mcpTrustedPolicy && typeof window.__mcpTrustedPolicy.createScript === "function") {
            try { s.textContent = window.__mcpTrustedPolicy.createScript(code); }
            catch (_e) { s.textContent = code; }
          } else {
            s.textContent = code;
          }
          if (nonced && nonced.nonce) s.nonce = nonced.nonce;
          document.documentElement.appendChild(s);
          s.remove();
        } catch (_e) {
          // Trusted Types refused the plain string: the script did not start.
        }
      }
      delete window[hook];
      if (!started) return { ok: false, csp: true, error: "the page's CSP blocks eval and inline scripts" };
      try { return { ok: true, value: text(await started) }; } catch (e) { return fail(e); }
    })();
    Object.defineProperty(window, key, { value: run, configurable: true });
    setTimeout(function () { delete window[key]; }, d.keepMs || 30000);
    run.then(reply);
  });
}

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
