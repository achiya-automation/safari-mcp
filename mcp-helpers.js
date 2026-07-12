// MCP Click/Interaction Helpers — injected into every page
// This file is loaded by safari.js at startup, escaped, and injected via AppleScript `do JavaScript`.
// It is also used by the extension's execInTab for the AppleScript fallback path.
// IMPORTANT: Keep compatible with all browsers — no ES6+ modules, use var where possible.

if (window.__mcpVersion !== 6) {
  window.__mcpVersion = 6;
  window.__mcpRefs = window.__mcpRefs || {};
  window.__mcpCachedRoots = null;
  window.__mcpRootsDirty = true;
  if (!window.__mcpRootsObserver) {
    window.__mcpRootsObserver = new MutationObserver(function() { window.__mcpRootsDirty = true; });
    window.__mcpRootsObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  window.mcpCollectRoots = function() {
    if (!window.__mcpRootsDirty && window.__mcpCachedRoots) return window.__mcpCachedRoots;
    var roots = [];
    function collect(root) {
      roots.push(root);
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) collect(all[i].shadowRoot);
      }
    }
    collect(document);
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try { var doc = iframes[i].contentDocument; if (doc) collect(doc); } catch (e) {}
    }
    window.__mcpCachedRoots = roots;
    window.__mcpRootsDirty = false;
    return roots;
  };
  window.mcpQuerySelectorDeep = function(selector) {
    try {
      var direct = document.querySelector(selector);
      if (direct) return direct;
    } catch (e) { return null; }
    var roots = window.mcpCollectRoots();
    for (var i = 1; i < roots.length; i++) {
      try {
        var found = roots[i].querySelector(selector);
        if (found) return found;
      } catch (e) {}
    }
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument;
        if (doc) { var found = doc.querySelector(selector); if (found) return found; }
      } catch (e) {}
    }
    return null;
  };
  window.mcpElementFromPoint = function(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      try {
        if (typeof el.shadowRoot.elementFromPoint !== 'function') break;
        var inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      } catch (e) { break; }
    }
    return el;
  };
  window.mcpIsVisible = function(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    var cs = window.getComputedStyle(el);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  window.mcpIsActionable = function(el) {
    if (!window.mcpIsVisible(el)) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.matches && el.matches('input[type="hidden"]')) return false;
    var cs = window.getComputedStyle(el);
    if (cs && cs.pointerEvents === 'none') return false;
    return true;
  };
  window.mcpPickActionable = function(el) {
    var node = el && el.nodeType === 1 ? el : (el && el.parentElement) || null;
    while (node) {
      if (window.mcpIsActionable(node) && node.matches && node.matches('a[href],button,input:not([type="hidden"]),textarea,select,summary,label,option,[role],[onclick],[tabindex],[contenteditable=""],[contenteditable="true"]')) return node;
      node = node.parentElement;
    }
    return el && el.nodeType === 1 ? el : null;
  };
  window.mcpFindByAttr = function(attr, value, selector) {
    if (!value) return null;
    var roots = window.mcpCollectRoots();
    var sel = selector || ('[' + attr + ']');
    for (var i = 0; i < roots.length; i++) {
      var els = roots[i].querySelectorAll(sel);
      for (var j = 0; j < els.length; j++) {
        var current = attr === 'href' ? els[j].href : els[j].getAttribute(attr);
        if (current === value && window.mcpIsVisible(els[j])) return els[j];
      }
    }
    return null;
  };
  window.mcpNormalizeText = function(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  };
  window.mcpResolveTarget = function(el) {
    var base = window.mcpPickActionable(el) || el;
    if (!base) return null;
    try { base.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    var r = base.getBoundingClientRect();
    var dx = Math.min(12, Math.max(4, r.width / 4));
    var dy = Math.min(12, Math.max(4, r.height / 4));
    var pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + dx, r.top + r.height / 2],
      [r.right - dx, r.top + r.height / 2],
      [r.left + r.width / 2, r.top + dy],
      [r.left + r.width / 2, r.bottom - dy]
    ];
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0], y = pts[i][1];
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      var hit = window.mcpElementFromPoint(x, y);
      if (!hit) continue;
      if (base === hit || base.contains(hit) || hit.contains(base)) return window.mcpPickActionable(hit) || hit;
      // Overlay pattern: transparent button/link overlays a text label (e.g. dropdown items).
      // If the hit is an interactive element sharing a nearby common ancestor, prefer it.
      var hitAction = window.mcpPickActionable(hit);
      if (hitAction && hitAction !== base && hitAction.matches && hitAction.matches('button,a[href],[role="button"],[role="option"],[role="menuitem"]')) {
        var p = base.parentElement;
        for (var k = 0; k < 4 && p; k++) {
          if (p.contains(hitAction)) return hitAction;
          p = p.parentElement;
        }
      }
    }
    return base;
  };
  window.mcpClick = function(el) {
    var target = window.mcpResolveTarget(el);
    if (!window.mcpIsActionable(target)) return false;
    var r = target.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var beforeUrl = location.href;
    var anchor = target.closest ? target.closest('a[href]') : null;
    var href = anchor && anchor.href && !anchor.href.startsWith('javascript:') ? anchor.href : '';
    // Dispatch from the LEAF under the click point, not from the actionable ancestor.
    // A real click's `event.target` is the topmost node at that pixel — the inner label —
    // while `currentTarget` is the <a>/<button>. Handlers that gate on e.target (Facebook's
    // rel="dialog" links, most SPA routers) see a target they never expected when the event
    // is fired straight at the <a>, bail out, and the click silently degrades into a plain
    // navigation. Firing from the leaf reproduces the real bubble path exactly.
    var from = window.mcpElementFromPoint(x, y);
    if (!from || !(target === from || target.contains(from))) from = target;
    var s = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 };
    var p = { ...s, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 };
    from.dispatchEvent(new PointerEvent('pointerover', { ...p, buttons: 0 }));
    from.dispatchEvent(new MouseEvent('mouseover', { ...s, buttons: 0 }));
    from.dispatchEvent(new PointerEvent('pointerenter', { ...p, buttons: 0 }));
    from.dispatchEvent(new MouseEvent('mouseenter', { ...s, buttons: 0 }));
    from.dispatchEvent(new PointerEvent('pointermove', { ...p, buttons: 0 }));
    from.dispatchEvent(new MouseEvent('mousemove', { ...s, buttons: 0 }));
    from.dispatchEvent(new PointerEvent('pointerdown', { ...p, buttons: 1 }));
    from.dispatchEvent(new MouseEvent('mousedown', { ...s, buttons: 1 }));
    // Focus the actionable element, not the leaf — a <span> inside a button isn't focusable.
    if (target.focus) { try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (_) {} } }
    from.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0, pressure: 0 }));
    from.dispatchEvent(new MouseEvent('mouseup', { ...s, buttons: 0 }));
    // .click() on an anchor (or a node inside one) triggers the browser's own navigation
    // with target === the anchor, which is the exact shape the gate rejects. For anchors,
    // let the dispatched event below carry the default action instead.
    try {
      if (!href && typeof from.click === 'function') from.click();
    } catch (e) {}
    var clickEv = new MouseEvent('click', { ...s, buttons: 0 });
    var notPrevented = from.dispatchEvent(clickEv);
    // Navigate only if nothing claimed the click. A handler that called preventDefault owns
    // it — it just opened a dialog or pushed an SPA route, and forcing location.href here
    // would tear that down. (dispatchEvent returns false iff preventDefault was called.)
    if (href && notPrevented && location.href === beforeUrl) {
      location.href = href;
    }
    // Vue v-model / Lit @change / framework-agnostic toggle sync — for checkbox/radio,
    // Vue 3 listens for `change` via v-model; some Vue components subscribe to `input` instead.
    // Native target.click() fires both, but in production-stripped Vue apps (no fiber/proxy
    // visible), the reactivity sometimes misses the events when fired in the same microtask
    // as a synthetic click. Belt-and-suspenders: re-dispatch input+change with composed:true
    // and reset React's _valueTracker so subsequent submits see the new value.
    if (target.tagName === 'INPUT' && (target.type === 'checkbox' || target.type === 'radio')) {
      try { if (target._valueTracker && typeof target._valueTracker.setValue === 'function') target._valueTracker.setValue(''); } catch (_e) {}
      var toggleOpts = { bubbles: true, cancelable: true, composed: true };
      target.dispatchEvent(new Event('input', toggleOpts));
      target.dispatchEvent(new Event('change', toggleOpts));
    }
    // (Navigation is handled above, gated on notPrevented. A second unconditional
    // `location.href = href` used to live here and fired even when a handler had called
    // preventDefault — tearing down the dialog/route it had just opened.)
    var form = target.closest ? target.closest('form') : null;
    if (form && (target.type === 'submit' || (target.tagName === 'BUTTON' && target.type !== 'button' && target.type !== 'reset'))) {
      try { form.requestSubmit ? form.requestSubmit(target.type === 'submit' ? target : undefined) : form.submit(); } catch (e) {}
    }
    return true;
  };
  window.mcpReactClick = function(el) {
    var startNode = window.mcpResolveTarget(el) || el;
    if (!startNode) return false;
    // React 18-compatible SyntheticEvent — includes isDefaultPrevented/isPropagationStopped
    // methods that React internally checks. Without them, some portal-rendered components
    // (HackerNoon modal Submit, Radix dropdowns) silently no-op.
    function makeSynth(targetNode, type) {
      var r = targetNode.getBoundingClientRect();
      var native = type === 'click' || type === 'mousedown' || type === 'mouseup' || type === 'mousemove'
        ? new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })
        : type === 'pointerdown' || type === 'pointerup'
        ? new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' })
        : new Event(type || 'click', { bubbles: true, cancelable: true });
      var defaultPrevented = false, propagationStopped = false;
      return {
        type: type || 'click', target: targetNode, currentTarget: targetNode,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        pageX: r.left + r.width / 2 + window.scrollX, pageY: r.top + r.height / 2 + window.scrollY,
        screenX: r.left + r.width / 2, screenY: r.top + r.height / 2,
        button: 0, buttons: 0, detail: 1,
        altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
        preventDefault: function() { defaultPrevented = true; if (native.preventDefault) native.preventDefault(); },
        stopPropagation: function() { propagationStopped = true; if (native.stopPropagation) native.stopPropagation(); },
        stopImmediatePropagation: function() { propagationStopped = true; },
        isDefaultPrevented: function() { return defaultPrevented; },
        isPropagationStopped: function() { return propagationStopped; },
        defaultPrevented: false, cancelBubble: false,
        nativeEvent: native, persist: function() {},
        bubbles: true, cancelable: true, eventPhase: 2, isTrusted: false,
        timeStamp: Date.now(), composed: true, view: window
      };
    }
    // For React radio/checkbox inputs, onChange is the primary handler (not onClick)
    var isToggle = startNode.tagName === 'INPUT' && (startNode.type === 'radio' || startNode.type === 'checkbox');
    function tryOnChange(propsObj, targetNode) {
      if (!isToggle || !propsObj.onChange) return false;
      var newChecked = startNode.type === 'radio' ? true : !startNode.checked;
      var ev = makeSynth(targetNode, 'change');
      ev.target = { value: startNode.value, checked: newChecked, type: startNode.type, name: startNode.name, id: startNode.id, tagName: 'INPUT' };
      propsObj.onClick && propsObj.onClick(ev);
      propsObj.onChange(ev);
      return true;
    }
    // Try a single React props bag: returns true if ANY handler fired.
    // Order matters — onPointerDown/onMouseDown sometimes opens modals, then onClick commits.
    function tryProps(propsObj, targetNode) {
      if (!propsObj) return false;
      if (tryOnChange(propsObj, targetNode)) return true;
      var fired = false;
      if (typeof propsObj.onPointerDown === 'function') { try { propsObj.onPointerDown(makeSynth(targetNode, 'pointerdown')); fired = true; } catch (_e) {} }
      if (typeof propsObj.onMouseDown === 'function') { try { propsObj.onMouseDown(makeSynth(targetNode, 'mousedown')); fired = true; } catch (_e) {} }
      if (typeof propsObj.onMouseUp === 'function') { try { propsObj.onMouseUp(makeSynth(targetNode, 'mouseup')); fired = true; } catch (_e) {} }
      if (typeof propsObj.onPointerUp === 'function') { try { propsObj.onPointerUp(makeSynth(targetNode, 'pointerup')); fired = true; } catch (_e) {} }
      if (typeof propsObj.onClick === 'function') { try { propsObj.onClick(makeSynth(targetNode, 'click')); fired = true; } catch (_e) {} }
      return fired;
    }
    var node = startNode;
    for (var depth = 0; depth < 15 && node; depth++) {
      var pk = Object.keys(node).find(function(k) { return k.startsWith('__reactProps$'); });
      if (pk && node[pk] && tryProps(node[pk], node)) return true;
      var fk = Object.keys(node).find(function(k) { return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'); });
      if (fk) {
        // Walk fiber chain UP via .return (covers portals — Fiber tree is logical, not DOM-shaped).
        var f = node[fk], hops = 0;
        while (f && hops < 30) {
          if (tryProps(f.memoizedProps, node)) return true;
          // Components written as forwardRef put the click handler on stateNode.props
          if (f.stateNode && f.stateNode.props && tryProps(f.stateNode.props, node)) return true;
          f = f.return; hops++;
        }
      }
      node = node.parentElement;
    }
    return false;
  };
  window.mcpClickWithReact = function(el) {
    var target = window.mcpResolveTarget(el) || el;
    var reactFired = false;
    try { reactFired = window.mcpReactClick(target); } catch (e) {}
    var anchor = target && target.closest ? target.closest('a[href]') : null;
    if (!reactFired || anchor) window.mcpClick(target);
    return target;
  };
  window.mcpFindRef = function(ref) {
    var el = window.mcpQuerySelectorDeep('[data-mcp-ref="' + ref + '"]');
    if (el) return el;
    if (!window.__mcpRefs || !window.__mcpRefs[ref]) return null;
    var m = window.__mcpRefs[ref];
    if (m.id) { el = window.mcpFindByAttr('id', m.id); if (el) return el; }
    if (m.testid) { el = window.mcpFindByAttr('data-testid', m.testid); if (el) return el; }
    if (m.nameAttr) { el = window.mcpFindByAttr('name', m.nameAttr); if (el) return el; }
    if (m.href) { el = window.mcpFindByAttr('href', m.href, 'a[href]'); if (el) return el; }
    if (m.al) { el = window.mcpFindByAttr('aria-label', m.al); if (el) return el; }
    if (m.ph) { el = window.mcpFindByAttr('placeholder', m.ph); if (el) return el; }
    if (m.text) {
      el = window.mcpFindText(m.text, true) || window.mcpFindText(m.text, false);
      if (el) return el;
    }
    if (m.cx !== undefined && m.cy !== undefined) {
      try {
        window.scrollTo(window.scrollX, Math.max(0, m.cy - window.innerHeight / 2));
      } catch (e) {}
      el = window.mcpElementFromPoint(m.cx - window.scrollX, m.cy - window.scrollY);
      if (el) return window.mcpPickActionable(el) || el;
    }
    return null;
  };
  window.mcpFindText = function(text, exact) {
    var needle = window.mcpNormalizeText(text);
    var best = null, bestScore = Infinity;
    function consider(node) {
      var target = window.mcpPickActionable(node) || node;
      if (!window.mcpIsVisible(target)) return;
      var r = target.getBoundingClientRect();
      var area = r.width * r.height;
      var interactive = target.matches && target.matches('a[href],button,input:not([type="hidden"]),textarea,select,summary,label,[role=button],[role=link],[role=tab],[onclick],[tabindex]');
      var score = area + (interactive ? 0 : 1000000);
      if (score < bestScore) { best = target; bestScore = score; }
    }
    var roots = window.mcpCollectRoots();
    for (var i = 0; i < roots.length; i++) {
      var attrEls = roots[i].querySelectorAll('[aria-label],[placeholder],[title],[data-testid],[alt]');
      for (var j = 0; j < attrEls.length; j++) {
        var a = attrEls[j];
        var vals = [a.getAttribute('aria-label'), a.getAttribute('placeholder'), a.getAttribute('title'), a.getAttribute('data-testid'), a.getAttribute('alt')];
        for (var k = 0; k < vals.length; k++) {
          var val = vals[k];
          if (!val) continue;
          var normalized = window.mcpNormalizeText(val);
          if (exact ? normalized === needle : normalized.includes(needle)) { consider(a); break; }
        }
      }
      var tw = document.createTreeWalker(roots[i], NodeFilter.SHOW_TEXT, null);
      while (tw.nextNode()) {
        var n = tw.currentNode;
        var t = window.mcpNormalizeText(n.textContent);
        if (!t) continue;
        if (exact ? (t !== needle) : !t.includes(needle)) continue;
        if (n.parentElement) consider(n.parentElement);
      }
    }
    if (!best) {
      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        var it = window.mcpNormalizeText(el.innerText);
        if (!it) continue;
        if (exact ? (it !== needle) : !it.includes(needle)) continue;
        consider(el);
      }
    }
    return best;
  };
  // React-Select v5 / Radix-style controlled-select bypass: walks fiber up from the
  // target element to find a Select component (props.options + props.onChange), then
  // invokes onChange directly with the matching option. Avoids menu UI entirely —
  // critical for Cloudflare custom-token forms where the dropdown indicator stops
  // responding to dispatched clicks after a few rows.
  window.mcpReactSelectFindInstance = function(el) {
    if (!el) return null;
    var node = el;
    for (var d = 0; d < 25 && node; d++) {
      var keys = Object.keys(node);
      var fk;
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki].indexOf('__reactFiber$') === 0 || keys[ki].indexOf('__reactInternalInstance$') === 0) { fk = keys[ki]; break; }
      }
      if (fk) {
        var fiber = node[fk], hops = 0;
        while (fiber && hops < 60) {
          var p = fiber.memoizedProps || fiber.pendingProps || (fiber.stateNode && fiber.stateNode.props);
          if (p && Array.isArray(p.options) && typeof p.onChange === 'function') {
            return { props: p, fiber: fiber };
          }
          fiber = fiber.return;
          hops++;
        }
      }
      node = node.parentElement;
    }
    return null;
  };
  window.mcpReactSelectFlatten = function(options) {
    var flat = [];
    for (var i = 0; i < options.length; i++) {
      var o = options[i];
      if (o && Array.isArray(o.options)) {
        for (var j = 0; j < o.options.length; j++) flat.push(o.options[j]);
      } else if (o) {
        flat.push(o);
      }
    }
    return flat;
  };
  window.mcpReactSelectSet = function(el, optionLabel) {
    var found = window.mcpReactSelectFindInstance(el);
    if (!found) return JSON.stringify({ ok: false, error: 'no react-select Select component found in fiber tree' });
    var p = found.props;
    var flat = window.mcpReactSelectFlatten(p.options);
    if (!flat.length) return JSON.stringify({ ok: false, error: 'Select component has no options (try opening the menu first to populate)' });
    var needle = String(optionLabel);
    var target = null;
    for (var i = 0; i < flat.length; i++) {
      if (flat[i] && (flat[i].label === needle || flat[i].value === needle)) { target = flat[i]; break; }
    }
    if (!target) {
      var lcNeedle = needle.toLowerCase();
      for (var k = 0; k < flat.length; k++) {
        var lab = String(flat[k] && (flat[k].label !== undefined ? flat[k].label : flat[k].value) || '').toLowerCase();
        if (lab === lcNeedle) { target = flat[k]; break; }
      }
    }
    if (!target) {
      return JSON.stringify({
        ok: false,
        error: 'option not found',
        searched: needle,
        total: flat.length,
        available: flat.slice(0, 30).map(function(o) { return o && (o.label !== undefined ? o.label : o.value); })
      });
    }
    var action = { action: 'select-option', option: target, name: p.name };
    try {
      p.onChange(target, action);
      return JSON.stringify({ ok: true, selected: target.label !== undefined ? target.label : target.value });
    } catch (e) {
      return JSON.stringify({ ok: false, error: 'onChange threw: ' + e.message });
    }
  };
  window.mcpReactSelectListOptions = function(el) {
    var found = window.mcpReactSelectFindInstance(el);
    if (!found) return JSON.stringify({ ok: false, error: 'no react-select Select component found' });
    var flat = window.mcpReactSelectFlatten(found.props.options);
    return JSON.stringify({
      ok: true,
      total: flat.length,
      options: flat.map(function(o) { return { label: o && o.label, value: o && o.value }; })
    });
  };
}
