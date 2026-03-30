// MCP Click/Interaction Helpers — injected into every page
// This file is loaded by safari.js at startup, escaped, and injected via AppleScript `do JavaScript`.
// It is also used by the extension's execInTab for the AppleScript fallback path.
// IMPORTANT: Keep this file compatible with all browsers — no ES6+ modules, use var where possible.

if (window.__mcpVersion !== 5) {
  window.__mcpVersion = 5;
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
    var s = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 };
    var p = { ...s, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 };
    target.dispatchEvent(new PointerEvent('pointerover', { ...p, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseover', { ...s, buttons: 0 }));
    target.dispatchEvent(new PointerEvent('pointerenter', { ...p, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseenter', { ...s, buttons: 0 }));
    target.dispatchEvent(new PointerEvent('pointermove', { ...p, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mousemove', { ...s, buttons: 0 }));
    target.dispatchEvent(new PointerEvent('pointerdown', { ...p, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown', { ...s, buttons: 1 }));
    if (target.focus) { try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (_) {} } }
    target.dispatchEvent(new PointerEvent('pointerup', { ...p, buttons: 0, pressure: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { ...s, buttons: 0 }));
    try {
      if (typeof target.click === 'function') {
        target.click();
        if (href && href !== beforeUrl) {
          location.href = href;
        }
      }
    } catch (e) {}
    target.dispatchEvent(new MouseEvent('click', { ...s, buttons: 0 }));
    if (href && href !== beforeUrl) {
      location.href = href;
    }
    var form = target.closest ? target.closest('form') : null;
    if (form && (target.type === 'submit' || (target.tagName === 'BUTTON' && target.type !== 'button' && target.type !== 'reset'))) {
      try { form.requestSubmit ? form.requestSubmit(target.type === 'submit' ? target : undefined) : form.submit(); } catch (e) {}
    }
    return true;
  };
  window.mcpReactClick = function(el) {
    var startNode = window.mcpResolveTarget(el) || el;
    if (!startNode) return false;
    function makeSynth(targetNode, type) {
      var r = targetNode.getBoundingClientRect();
      return { type: type || 'click', target: targetNode, currentTarget: targetNode,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pageX: r.left + r.width / 2 + window.scrollX, pageY: r.top + r.height / 2 + window.scrollY,
        preventDefault: function() {}, stopPropagation: function() {}, nativeEvent: new MouseEvent(type || 'click'), persist: function() {}, bubbles: true, cancelable: true };
    }
    // For React radio/checkbox inputs, onChange is the primary handler (not onClick)
    var isToggle = startNode.tagName === 'INPUT' && (startNode.type === 'radio' || startNode.type === 'checkbox');
    function tryOnChange(propsObj, targetNode) {
      if (!isToggle || !propsObj.onChange) return false;
      var newChecked = startNode.type === 'radio' ? true : !startNode.checked;
      propsObj.onChange({ target: { value: startNode.value, checked: newChecked, type: startNode.type, name: startNode.name, id: startNode.id, tagName: 'INPUT' },
        currentTarget: targetNode, preventDefault: function() {}, stopPropagation: function() {}, nativeEvent: new Event('change'), persist: function() {}, bubbles: true, cancelable: true, type: 'change' });
      return true;
    }
    var node = startNode;
    for (var depth = 0; depth < 15 && node; depth++) {
      var pk = Object.keys(node).find(function(k) { return k.startsWith('__reactProps$'); });
      if (pk && node[pk]) {
        var props = node[pk];
        if (tryOnChange(props, node)) return true;
        if (props.onClick) { props.onClick(makeSynth(node, 'click')); return true; }
        if (props.onMouseDown) { props.onMouseDown(makeSynth(node, 'mousedown')); return true; }
        if (props.onPointerDown) { props.onPointerDown(makeSynth(node, 'pointerdown')); return true; }
      }
      var fk = Object.keys(node).find(function(k) { return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'); });
      if (fk) {
        var f = node[fk];
        while (f) {
          if (f.memoizedProps) {
            if (tryOnChange(f.memoizedProps, node)) return true;
            if (f.memoizedProps.onClick) { f.memoizedProps.onClick(makeSynth(node, 'click')); return true; }
            if (f.memoizedProps.onMouseDown) { f.memoizedProps.onMouseDown(makeSynth(node, 'mousedown')); return true; }
            if (f.memoizedProps.onPointerDown) { f.memoizedProps.onPointerDown(makeSynth(node, 'pointerdown')); return true; }
          }
          f = f.return;
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
}
