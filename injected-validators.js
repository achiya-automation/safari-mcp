// Injected-JS source for the iOS/WebKit validation tools. These IIFE strings are run in
// the page via `do JavaScript` (safari.js) and are also imported directly by the test
// suite so the exact same code is exercised under jsdom — no drift between what ships and
// what's tested. Each is a SYNCHRONOUS IIFE returning JSON.stringify(...) (AppleScript
// `do JavaScript` can't await), with no `//` comments inside (runJS flattens to one line).

export const VIEWPORT_SCRIPT = `(function(){
      var meta = document.querySelector('meta[name="viewport"]');
      var content = meta ? (meta.getAttribute('content') || '') : null;
      var attrs = {};
      if (content) {
        content.split(',').forEach(function(part){
          var kv = part.split('=');
          var key = (kv[0]||'').trim();
          var val = (kv[1]||'').trim();
          if (key) attrs[key] = val;
        });
      }
      var issues = [];
      if (!content) {
        issues.push({severity:'error', message:'No viewport meta tag found. iOS Safari renders at 980px width and scales down.'});
      } else {
        if (!attrs.width) issues.push({severity:'error', message:'Missing width=device-width. Safari falls back to a 980px layout width.'});
        else if (attrs.width !== 'device-width') issues.push({severity:'warning', message:'width=' + attrs.width + ' — prefer device-width for responsive layouts.'});
        if (!attrs['initial-scale']) issues.push({severity:'warning', message:'Missing initial-scale=1. Some iOS Safari versions may not zoom correctly without it.'});
        if (attrs['user-scalable'] === 'no' || attrs['maximum-scale'] === '1') issues.push({severity:'error', message:'Zoom disabled (user-scalable=no / maximum-scale=1) — WCAG 1.4.4 violation, and Safari 10+ ignores it anyway.'});
        if (attrs['viewport-fit'] !== 'cover') issues.push({severity:'warning', message:'Missing viewport-fit=cover. Required for safe-area-inset env() values on notched devices.'});
        if (attrs['minimum-scale'] && parseFloat(attrs['minimum-scale']) < 1) issues.push({severity:'info', message:'minimum-scale=' + attrs['minimum-scale'] + ' allows zoom-out on iOS, which can cause layout issues.'});
      }
      var errors = issues.filter(function(i){return i.severity==='error';}).length;
      var warnings = issues.filter(function(i){return i.severity==='warning';}).length;
      return JSON.stringify({viewport: content, attrs: attrs, ok: issues.length===0, errors: errors, warnings: warnings, issues: issues});
    })()`;

export const SAFE_AREA_SCRIPT = `(function(){
      if (!document.body) return JSON.stringify({error:'No document.body yet'});
      var probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;top:env(safe-area-inset-top,0px);right:env(safe-area-inset-right,0px);bottom:env(safe-area-inset-bottom,0px);left:env(safe-area-inset-left,0px);pointer-events:none;visibility:hidden;';
      document.body.appendChild(probe);
      var cs = getComputedStyle(probe);
      var insets = {top: cs.top, right: cs.right, bottom: cs.bottom, left: cs.left};
      probe.remove();
      var meta = document.querySelector('meta[name="viewport"]');
      var viewportFitCover = meta ? ((meta.getAttribute('content')||'').indexOf('viewport-fit=cover') !== -1) : false;
      var usedInCSS = false;
      try {
        var sheets = document.styleSheets;
        for (var i=0; i<sheets.length; i++) {
          try {
            var rules = sheets[i].cssRules;
            var text = '';
            for (var j=0; j<rules.length; j++) text += rules[j].cssText + ' ';
            if (text.indexOf('safe-area-inset') !== -1) { usedInCSS = true; break; }
          } catch(e) {}
        }
      } catch(e) {}
      return JSON.stringify({insets: insets, viewportFitCover: viewportFitCover, usedInCSS: usedInCSS});
    })()`;

export const PWA_SCRIPT = `(function(){
      function getMeta(name){ var el = document.querySelector('meta[name="'+name+'"]'); return el ? el.getAttribute('content') : null; }
      function getLink(rel){ var el = document.querySelector('link[rel="'+rel+'"]'); return el ? el.getAttribute('href') : null; }
      var touchIcons = [].slice.call(document.querySelectorAll('link[rel="apple-touch-icon"]')).map(function(el){ return {sizes: el.getAttribute('sizes')||'unspecified', href: el.getAttribute('href')||''}; });
      var splash = document.querySelectorAll('link[rel="apple-touch-startup-image"]').length;
      var capable = getMeta('apple-mobile-web-app-capable');
      var themeColor = getMeta('theme-color');
      var statusBar = getMeta('apple-mobile-web-app-status-bar-style');
      var manifest = getLink('manifest');
      var has180 = touchIcons.some(function(i){return i.sizes==='180x180';});
      var checks = [];
      checks.push({pass: capable==='yes', label:'apple-mobile-web-app-capable', detail: capable==='yes' ? 'standalone mode enabled' : 'not set to yes — opens in Safari, not standalone'});
      checks.push({pass: touchIcons.length>0, label:'apple-touch-icon', detail: touchIcons.length>0 ? (touchIcons.length+' icon(s): '+touchIcons.map(function(i){return i.sizes;}).join(', ')+(has180?'':' (missing 180x180 for iPhone)')) : 'none — iOS uses a screenshot as the icon'});
      checks.push({pass: themeColor!==null, label:'theme-color', detail: themeColor!==null ? ('set to '+themeColor) : 'not set — Safari 15+ tints the tab bar with it'});
      checks.push({pass: statusBar!==null, label:'apple-mobile-web-app-status-bar-style', detail: statusBar!==null ? ('set to '+statusBar) : 'not set — defaults to black-on-white'});
      checks.push({pass: manifest!==null, label:'web app manifest', detail: manifest!==null ? ('found: '+manifest) : 'no manifest link — required for PWA install prompts'});
      checks.push({pass: splash>0, label:'apple-touch-startup-image', detail: splash>0 ? (splash+' splash screen(s)') : 'none — white screen while the app loads'});
      var passed = checks.filter(function(c){return c.pass;}).length;
      return JSON.stringify({passed: passed, total: checks.length, checks: checks});
    })()`;

export const WEBKIT_COMPAT_SCRIPT = `(function(){
      var seen = {};
      function collectFromStyle(style){
        for (var k=0; k<style.length; k++){
          var prop = style[k];
          if (prop.indexOf('--')===0) continue;
          if (seen.hasOwnProperty(prop)) continue;
          seen[prop] = (style.getPropertyValue(prop)||'').trim();
        }
      }
      function processRules(rules){
        for (var r=0; r<rules.length; r++){
          var rule = rules[r];
          if (rule.constructor && rule.constructor.name === 'CSSFontFaceRule') continue;
          if (rule.style) collectFromStyle(rule.style);
          if (rule.cssRules){ try { processRules(rule.cssRules); } catch(e){} }
        }
      }
      var sheets = document.styleSheets;
      for (var i=0; i<sheets.length; i++){ try { processRules(sheets[i].cssRules); } catch(e){} }
      var inline = document.querySelectorAll('[style]');
      for (var n=0; n<inline.length; n++) collectFromStyle(inline[n].style);
      var unsupported = [];
      var needsPrefix = [];
      var total = 0;
      for (var prop in seen){
        if (!seen.hasOwnProperty(prop)) continue;
        total++;
        var value = seen[prop];
        var supported = false;
        try { supported = CSS.supports(prop, value); } catch(e){}
        if (!supported){ try { supported = CSS.supports(prop, 'initial'); } catch(e){} }
        if (supported) continue;
        var wk = '-webkit-' + prop;
        var wkOk = false;
        try { wkOk = CSS.supports(wk, value); } catch(e){}
        if (!wkOk){ try { wkOk = CSS.supports(wk, 'initial'); } catch(e){} }
        if (wkOk) needsPrefix.push({property: prop, value: value.slice(0,60)});
        else unsupported.push({property: prop, value: value.slice(0,60)});
      }
      var quirks = [];
      if (seen.hasOwnProperty('position') && (seen['position']||'').indexOf('sticky') !== -1) {
        quirks.push('position:sticky silently fails inside an overflow:hidden/auto ancestor in Safari — use overflow:clip on the ancestor.');
      }
      return JSON.stringify({totalProperties: total, ok: (unsupported.length+needsPrefix.length+quirks.length)===0, unsupported: unsupported, needsPrefix: needsPrefix, quirks: quirks});
    })()`;
