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
// (business.facebook.com: BOTH worlds hang forever instead of rejecting, so every
// evaluate strategy above them dies on the caller's timeout).
//
// This script is ALREADY in MAIN world from document_start, so nothing has to be
// injected to reach the page — that is the whole point. command-content.js lives in
// the ISOLATED world where it can talk to the background but where the page's CSP
// forbids eval; it hands the work here over a CustomEvent, and we run it through the
// same grandfathered Trusted Types policy the injected strategy uses.
if (!window.__mcpEvalBridge) {
  window.__mcpEvalBridge = true;
  // window.postMessage, not CustomEvent: a CustomEvent's `detail` does not survive the
  // ISOLATED→MAIN world boundary (it arrives as null), so the bridge received the event
  // but never the script — it simply timed out. postMessage is structured-cloned across
  // the boundary by design.
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;                       // ignore other frames
    var d = ev.data;
    if (!d || d.__mcp !== "eval_req" || typeof d.id !== "string") return;
    var id = d.id;
    var outKey = "__mcp_eval_out_" + id;
    var answered = false;
    var reply = function (detail) {
      if (answered) return;
      answered = true;
      try { delete window[outKey]; } catch (_e) {}
      window.postMessage({ __mcp: "eval_res", id: id, result: detail }, "*");
    };
    var settle = function (v) {
      if (v === undefined || v === null) { reply({ ok: true, value: null }); return; }
      if (typeof v === "object") {
        try { reply({ ok: true, value: JSON.stringify(v) }); }
        catch (_e) { reply({ ok: true, value: String(v) }); }
      } else {
        reply({ ok: true, value: String(v) });
      }
    };

    // Direct eval first. We are in MAIN world, so this runs under the PAGE's CSP —
    // and business.facebook.com actually allows 'unsafe-eval'. Its script-src does
    // carry a nonce, which is precisely what blocks the injected-<script> path below,
    // so trying that first would fail on the very page this bridge exists for.
    try {
      var direct = (0, eval)(String(d.source));
      if (direct && typeof direct.then === "function") {
        direct.then(settle, function (e) { reply({ ok: false, error: String((e && e.message) || e) }); });
      } else {
        settle(direct);
      }
      return;
    } catch (evalErr) {
      var m = String((evalErr && evalErr.message) || evalErr);
      // A real script error must surface as-is; only a CSP refusal justifies the
      // slower injected path.
      if (!/unsafe-eval|Content Security Policy|trusted-types|Trusted Type/i.test(m)) {
        reply({ ok: false, error: m });
        return;
      }
    }

    try {
      var code =
        "try{var __r=(function(){" + String(d.source) + "})();" +
        "if(__r&&typeof __r.then==='function'){__r.then(function(v){window['" + outKey + "']={done:true,v:v};}," +
        "function(e){window['" + outKey + "']={done:true,e:String((e&&e.message)||e)};});}" +
        "else{window['" + outKey + "']={done:true,v:__r};}}" +
        "catch(e){window['" + outKey + "']={done:true,e:String((e&&e.message)||e)};}";
      var s = document.createElement("script");
      if (window.__mcpTrustedPolicy && typeof window.__mcpTrustedPolicy.createScript === "function") {
        try { s.textContent = window.__mcpTrustedPolicy.createScript(code); }
        catch (_e) { s.textContent = code; }
      } else {
        s.textContent = code;
      }
      document.documentElement.appendChild(s);
      s.remove();
      var tries = 0;
      var poll = function () {
        var r = window[outKey];
        if (r && r.done) {
          if (r.e) { reply({ ok: false, error: r.e }); return; }
          var v = r.v;
          if (v === undefined || v === null) { reply({ ok: true, value: null }); return; }
          // Serialise here: a CustomEvent detail crossing into the ISOLATED world must
          // survive structured clone, and page objects (DOM nodes, class instances) do not.
          if (typeof v === "object") {
            try { reply({ ok: true, value: JSON.stringify(v) }); }
            catch (_e) { reply({ ok: true, value: String(v) }); }
          } else {
            reply({ ok: true, value: String(v) });
          }
          return;
        }
        if (++tries > 160) { reply({ ok: false, error: "eval bridge timeout" }); return; }
        setTimeout(poll, 50);
      };
      poll();
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
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
