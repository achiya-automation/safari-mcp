// Safari automation layer via AppleScript/JXA
// כל הפקודות רצות ברקע - בלי להקפיץ חלון Safari לקדמה
// Persistent osascript process for fast execution (~5ms vs ~80ms per call)

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, unlink } from "node:fs/promises";

const execFileAsync = promisify(execFile);

// ========== ACTIVE TAB TRACKING ==========
// Instead of visually switching tabs (which interrupts the user),
// we track which tab we're "working on" by URL (not index, because indices shift
// when the user opens/closes tabs). Before each operation we resolve the URL
// to the current index.
let _activeTabIndex = null; // null = use front document (default)
let _activeTabURL = null;   // URL-based tracking (stable even when tabs shift)

export function getActiveTabIndex() { return _activeTabIndex; }
export function setActiveTabIndex(idx) { _activeTabIndex = idx; }

// Resolve our tracked URL to current tab index — single osascript call (fast!)
async function resolveActiveTab() {
  if (!_activeTabURL) return _activeTabIndex;
  try {
    const safeUrl = _activeTabURL.replace(/"/g, '\\"');
    // If we have a known index, verify it first (O(1) instead of searching all tabs)
    if (_activeTabIndex) {
      const currentUrl = await osascriptFast(
        `tell application "Safari" to return URL of tab ${_activeTabIndex} of front window`
      ).catch(() => "");
      if (currentUrl && currentUrl.startsWith(_activeTabURL)) {
        return _activeTabIndex; // Same tab, same URL — no change needed
      }
    }
    // Index shifted — search from the END (our tab is usually the newest)
    const idx = await osascriptFast(
      `tell application "Safari"
        set tabCount to count of tabs of front window
        repeat with i from tabCount to 1 by -1
          if URL of tab i of front window starts with "${safeUrl}" then return i
        end repeat
        return 0
      end tell`
    );
    const num = Number(idx);
    if (num > 0) {
      _activeTabIndex = num;
      return num;
    }
    // Try partial match (URL may have changed due to redirects/navigation)
    const domain = _activeTabURL.replace(/^https?:\/\//, '').split('/')[0];
    const safeDomain = domain.replace(/"/g, '\\"');
    const idx2 = await osascriptFast(
      `tell application "Safari"
        set tabCount to count of tabs of front window
        repeat with i from tabCount to 1 by -1
          if URL of tab i of front window contains "${safeDomain}" then return i
        end repeat
        return 0
      end tell`
    );
    const num2 = Number(idx2);
    if (num2 > 0) {
      _activeTabIndex = num2;
      return num2;
    }
    // URL not found — tab may have navigated. Don't clear _activeTabIndex!
    _activeTabURL = null;
    return _activeTabIndex; // Keep using saved index as best guess
  } catch {
    return _activeTabIndex;
  }
}

// ========== FAST OSASCRIPT VIA TEMP FILE REUSE ==========
// osascript -i doesn't work with pipes. Instead, we use a shared temp file
// and direct execFile — which is ~80ms but reliable.
// For runJS specifically, we batch when possible.

let _osaProc = null;
let _osaReady = false;

function getOsaProcess() {
  // Persistent process doesn't work with osascript — return null to use fallback
  return null;

  return _osaProc;
}

// withoutStealingFocus: just run the function.
// All Safari MCP operations use `tell application "Safari"` (not `activate`)
// and `do JavaScript` — neither steals focus. No restore needed.
async function withoutStealingFocus(fn) {
  // Save the frontmost app BEFORE touching Safari
  let prevApp = null;
  try {
    prevApp = await osascriptFast(
      'tell application "System Events" to return name of first application process whose frontmost is true'
    );
  } catch (_) {}

  const result = await fn();

  // If Safari stole focus, give it back to the previous app
  if (prevApp && prevApp !== "Safari") {
    try {
      await osascriptFast(
        `tell application "${prevApp}" to activate`
      );
    } catch (_) {}
  }

  return result;
}

// Helper: get title + URL in a single call (instead of 2)
async function getTitleAndURL() {
  const result = await runJS(
    "JSON.stringify({title:document.title,url:location.href})"
  );
  try { return JSON.parse(result); } catch { return { title: result, url: "" }; }
}

// Run AppleScript — uses execFile (safe, isolated, for complex scripts)
async function osascript(script, { timeout = 10000 } = {}) {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`AppleScript error: ${err.stderr || err.message}`);
  }
}

// Fast osascript via persistent process — for simple tell commands
async function osascriptFast(script, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = getOsaProcess();
    if (!proc || proc.killed) {
      // Fallback to regular osascript if persistent process is dead
      return osascript(script, { timeout }).then(resolve, reject);
    }

    let output = "";
    let timer = setTimeout(() => {
      cleanup();
      // Fallback on timeout
      osascript(script, { timeout }).then(resolve, reject);
    }, timeout);

    function onData(chunk) {
      output += chunk.toString();
      // osascript -i returns result then a new prompt
      if (output.includes("\r\n")) {
        cleanup();
        // Remove prompt artifacts
        const result = output.split("\r\n")[0].trim();
        resolve(result);
      }
    }

    function onError(chunk) {
      const err = chunk.toString().trim();
      if (err && !err.startsWith(">>")) {
        cleanup();
        reject(new Error(`AppleScript error: ${err}`));
      }
    }

    function cleanup() {
      clearTimeout(timer);
      proc.stdout.removeListener("data", onData);
      proc.stderr.removeListener("data", onError);
    }

    proc.stdout.on("data", onData);
    proc.stderr.on("data", onError);

    // Send the script as a single line
    proc.stdin.write(script.replace(/\n/g, "\r") + "\n");
  });
}

// Run JavaScript in Safari — fastest path, no focus stealing
// Uses osascriptFast (persistent process, ~5ms) for short scripts,
// falls back to osascript (~80ms) for long scripts that exceed stdin limits
async function runJS(js, { tabIndex, timeout = 15000 } = {}) {
  const escaped = js
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  // Resolve tab: explicit tabIndex > URL-tracked tab > saved index > front document
  let idx = tabIndex;
  if (!idx && _activeTabURL && _activeTabURL !== 'about:blank' && _activeTabURL !== '') {
    const resolved = await resolveActiveTab();
    if (resolved) idx = resolved;
  }
  // ALWAYS fall back to _activeTabIndex — never clear it from resolve failures
  if (!idx) idx = _activeTabIndex;
  const target = idx
    ? `tab ${idx} of front window`
    : "front document";
  const script = `tell application "Safari" to do JavaScript "${escaped}" in ${target}`;
  // Use fast path for scripts under 50KB (persistent process handles these well)
  if (script.length < 50000) {
    return osascriptFast(script, { timeout });
  }
  return osascript(script, { timeout });
}

// Run large JavaScript via temp file — bypasses osascript arg length limit (~260KB)
// Used for operations that embed file data (upload, paste image)
async function runJSLarge(js, { tabIndex, timeout = 30000 } = {}) {
  const idx = tabIndex || _activeTabIndex;
  const target = idx
    ? `tab ${idx} of front window`
    : "front document";
  // Write AppleScript to temp file — the JS is embedded inside the AppleScript
  const escaped = js
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  const appleScript = `tell application "Safari" to do JavaScript "${escaped}" in ${target}`;
  const tmpFile = join(tmpdir(), `safari-mcp-${Date.now()}.scpt`);
  await writeFile(tmpFile, appleScript, "utf8");
  try {
    const { stdout } = await execFileAsync("osascript", [tmpFile], {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.trim();
  } finally {
    unlink(tmpFile).catch(() => {});
  }
}

// ========== NAVIGATION ==========

export async function navigate(url) {
  // No withoutStealingFocus needed — set URL + do JavaScript don't steal focus
  // Safari 17+ auto-upgrades HTTP→HTTPS. If user gives http://, try https:// first.
    // If user gives no protocol, default to https://
    let targetUrl = url;
    if (!/^https?:\/\//i.test(targetUrl)) {
      targetUrl = "https://" + targetUrl;
    }
    const safeUrl = targetUrl.replace(/"/g, '\\"');
    // Resolve tab by URL first (in case indices shifted)
    if (_activeTabURL) await resolveActiveTab();
    const navTarget = _activeTabIndex
      ? `tab ${_activeTabIndex} of front window`
      : "front document";
    await osascriptFast(
      `tell application "Safari" to set URL of ${navTarget} to "${safeUrl}"`
    );
    // Single JS call: poll readyState inside JS, then return title+URL — 1 call instead of 40
    const result = await runJS(
      `(async function(){
        for(var i=0;i<80;i++){
          if(document.readyState==='complete')break;
          await new Promise(function(r){setTimeout(r,i<10?200:500)});
        }
        // Check if page failed to load (Safari HTTPS-only block shows error page)
        var failed = document.title.includes('cannot open') || document.title.includes('אין אפשרות') ||
                     document.body?.innerText?.includes('not secure') || document.body?.innerText?.includes('אינו מאובטח');
        return JSON.stringify({title:document.title,url:location.href,blocked:failed});
      })()`
    );

    // If HTTPS failed and original was HTTP, try original HTTP URL
    try {
      const parsed = JSON.parse(result);
      if (parsed.blocked && url.startsWith("http://")) {
        // Try the original HTTP URL — Safari may still block it, but at least we tried
        const httpUrl = url.replace(/"/g, '\\"');
        await osascriptFast(
          `tell application "Safari" to set URL of front document to "${httpUrl}"`
        );
        const retry = await runJS(
          `(async function(){
            for(var i=0;i<40;i++){
              if(document.readyState==='complete')break;
              await new Promise(function(r){setTimeout(r,300)});
            }
            return JSON.stringify({title:document.title,url:location.href});
          })()`
        );
        return retry;
      }
    } catch (_) {}

    // Update URL tracking after navigation
    try {
      const parsed = JSON.parse(result);
      if (parsed.url) _activeTabURL = parsed.url;
    } catch {}

    return result;
}

export async function goBack() {
  // Single call: go back + wait + return title+URL
  return runJS(
    `(async function(){history.back();await new Promise(function(r){setTimeout(r,500)});return JSON.stringify({title:document.title,url:location.href});})()`
  );
}

export async function goForward() {
  return runJS(
    `(async function(){history.forward();await new Promise(function(r){setTimeout(r,500)});return JSON.stringify({title:document.title,url:location.href});})()`
  );
}

export async function reload(hardReload = false) {
  const reload = hardReload ? "location.reload(true)" : "location.reload()";
  await runJS(reload);
  // Must wait separately since page reloads and JS context is lost
  await new Promise((r) => setTimeout(r, 800));
  return runJS("JSON.stringify({title:document.title,url:location.href})");
}

// ========== PAGE INFO ==========

export async function getTitle() {
  return osascript(
    'tell application "Safari" to return name of front document'
  );
}

export async function getURL() {
  return osascript(
    'tell application "Safari" to return URL of front document'
  );
}

export async function readPage({ selector, maxLength = 50000 } = {}) {
  if (selector) {
    const sel = selector.replace(/'/g, "\\'");
    return runJS(
      `(function(){
        var el = document.querySelector('${sel}');
        if (!el) return 'Element not found: ${sel}';
        if (el.value !== undefined && el.value !== '') return el.value.substring(0,${Number(maxLength)});
        return (el.innerText || el.textContent || '').substring(0,${Number(maxLength)});
      })()`
    );
  }
  return runJS(
    `JSON.stringify({title:document.title,url:location.href,text:document.body.innerText.substring(0,${Number(maxLength)})})`
  );
}

export async function getPageSource({ maxLength = 200000 } = {}) {
  return runJS(`document.documentElement.outerHTML.substring(0,${Number(maxLength)})`);
}

// ========== CLICK ==========

// OS-level click: gets element screen coordinates, then uses AppleScript to perform
// a REAL mouse click that macOS sends to Safari. Works on React, Airtable, any framework.
// switchToTab: if true, temporarily switch Safari to our tab for the click (needed for background tabs)
async function osClick(pageX, pageY, { switchToTab = true } = {}) {
  // Calculate screen coordinates dynamically using JS window.screenX/screenY
  // This accounts for Safari toolbar, tab bar, bookmarks bar — any configuration
  const offset = await runJS(
    "JSON.stringify({sx:window.screenX, sy:window.screenY, oh:window.outerHeight, ih:window.innerHeight})"
  );
  const { sx, sy, oh, ih } = JSON.parse(offset);
  const toolbarHeight = oh - ih; // Dynamic: includes tab bar + address bar + bookmarks
  const screenX = sx + Math.round(pageX);
  const screenY = sy + toolbarHeight + Math.round(pageY);

  // If working on a background tab, temporarily switch to it for the click
  let savedTabIdx = null;
  if (switchToTab && _activeTabIndex) {
    try {
      const currentIdx = await osascriptFast(
        'tell application "Safari" to return index of current tab of front window'
      );
      if (Number(currentIdx) !== _activeTabIndex) {
        savedTabIdx = Number(currentIdx);
        await osascriptFast(
          `tell application "Safari" to set current tab of front window to tab ${_activeTabIndex} of front window`
        );
        await new Promise(r => setTimeout(r, 150)); // Let Safari render the tab
      }
    } catch (_) {}
  }

  // Perform real OS click via cliclick (preferred — precise, reliable)
  try {
    await execFileAsync("cliclick", ["c:" + screenX + "," + screenY], { timeout: 3000 });
  } catch (_) {
    // Fallback: AppleScript System Events
    await osascript(
      `tell application "System Events" to click at {${screenX}, ${screenY}}`,
      { timeout: 5000 }
    );
  }

  // Restore the user's tab if we switched
  if (savedTabIdx) {
    await new Promise(r => setTimeout(r, 200)); // Let the click register
    try {
      await osascriptFast(
        `tell application "Safari" to set current tab of front window to tab ${savedTabIdx} of front window`
      );
    } catch (_) {}
  }

  return true;
}

export async function click({ selector, text, x, y, ref, force }) {
  // Ref-based click (from takeSnapshot) — fastest and most reliable
  if (ref) {
    selector = refSelector(ref);
  }

  // force=true → always use OS-level click (for React/virtual DOM apps like Airtable)
  // Otherwise: try JS first, then fall back to OS click if needed

  if (selector) {
    const sel = selector.replace(/'/g, "\\'");

    // Step 1: Find element and get coordinates
    const info = await runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return JSON.stringify({error:'Element not found: ${sel}'});el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();return JSON.stringify({tag:el.tagName,text:el.textContent.trim().substring(0,50),cx:r.left+r.width/2,cy:r.top+r.height/2,w:r.width,h:r.height});})()`
    );
    let parsed;
    try { parsed = JSON.parse(info); } catch { return info; }
    if (parsed.error) return parsed.error;

    // Step 2: Try JS click first (unless force=true)
    if (!force) {
      const jsResult = await runJS(
        `(function(){var el=document.querySelector('${sel}');if(!el)return 'not found';var r=el.getBoundingClientRect();var cx=r.left+r.width/2;var cy=r.top+r.height/2;var opts={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0};el.dispatchEvent(new PointerEvent('pointerdown',opts));el.dispatchEvent(new MouseEvent('mousedown',opts));el.dispatchEvent(new PointerEvent('pointerup',opts));el.dispatchEvent(new MouseEvent('mouseup',opts));el.dispatchEvent(new MouseEvent('click',opts));return 'js_clicked';})()`
      );
      if (jsResult === 'js_clicked') {
        return `Clicked: ${parsed.tag} "${parsed.text}"`;
      }
    }

    // Step 3: OS-level click (works on React, Airtable, any framework)
    await osClick(parsed.cx, parsed.cy);
    return `Clicked (OS): ${parsed.tag} "${parsed.text}"`;
  }

  if (text) {
    const safeText = text.replace(/'/g, "\\'");
    // Find element by text and get its coordinates
    const info = await runJS(
      `(function(){
        var safeText = '${safeText}';
        var interactive = [...document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button],[role=link],[role=tab],[role=menuitem],[onclick],label,[data-testid],[class*=btn],[class*=Button]')];
        var el = interactive.find(function(e){ return e.textContent.trim().includes(safeText); });
        if (!el) {
          var all = [...document.querySelectorAll('*')].filter(function(e) {
            var r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && e.textContent.trim().includes(safeText);
          });
          el = all.sort(function(a, b) { return a.textContent.length - b.textContent.length; })[0];
        }
        if (!el) return JSON.stringify({error:'Element not found with text: ${safeText}'});
        el.scrollIntoView({block:'center'});
        var r = el.getBoundingClientRect();
        return JSON.stringify({tag:el.tagName,text:el.textContent.trim().substring(0,50),cx:r.left+r.width/2,cy:r.top+r.height/2});
      })()`
    );
    let parsed;
    try { parsed = JSON.parse(info); } catch { return info; }
    if (parsed.error) return parsed.error;

    if (!force) {
      // Try JS click first
      const jsResult = await runJS(
        `(function(){
          var safeText = '${safeText}';
          var interactive = [...document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button],[role=link],[role=tab],[role=menuitem],[onclick],label,[data-testid],[class*=btn],[class*=Button]')];
          var el = interactive.find(function(e){ return e.textContent.trim().includes(safeText); });
          if (!el) {
            var all = [...document.querySelectorAll('*')].filter(function(e) {
              var r = e.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && e.textContent.trim().includes(safeText);
            });
            el = all.sort(function(a, b) { return a.textContent.length - b.textContent.length; })[0];
          }
          if (!el) return 'not found';
          var r=el.getBoundingClientRect();var cx=r.left+r.width/2;var cy=r.top+r.height/2;
          var opts={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0};
          el.dispatchEvent(new PointerEvent('pointerdown',opts));el.dispatchEvent(new MouseEvent('mousedown',opts));
          el.dispatchEvent(new PointerEvent('pointerup',opts));el.dispatchEvent(new MouseEvent('mouseup',opts));
          el.dispatchEvent(new MouseEvent('click',opts));
          return 'js_clicked';
        })()`
      );
      if (jsResult === 'js_clicked') {
        return `Clicked: ${parsed.tag} "${parsed.text}"`;
      }
    }

    // OS-level click
    await osClick(parsed.cx, parsed.cy);
    return `Clicked (OS): ${parsed.tag} "${parsed.text}"`;
  }

  if (x !== undefined && y !== undefined) {
    if (force) {
      await osClick(Number(x), Number(y));
      return `Clicked (OS) at (${x}, ${y})`;
    }
    return runJS(
      `(function(){var el=document.elementFromPoint(${Number(x)},${Number(y)});if(!el)return 'No element at (${Number(x)},${Number(y)})';el.click();return 'Clicked: '+el.tagName+' at (${Number(x)},${Number(y)})';})()`
    );
  }
  throw new Error("click requires selector, text, or x/y coordinates");
}

export async function doubleClick({ selector, x, y, ref }) {
  if (ref) selector = refSelector(ref);
  if (selector) {
    const sel = selector.replace(/'/g, "\\'");
    return runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found: ${sel}';el.scrollIntoView({block:'center'});el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));return 'Double-clicked: '+el.tagName;})()`
    );
  }
  if (x !== undefined && y !== undefined) {
    return runJS(
      `(function(){var el=document.elementFromPoint(${Number(x)},${Number(y)});if(!el)return 'No element at (${x},${y})';el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));return 'Double-clicked: '+el.tagName+' at (${x},${y})';})()`
    );
  }
  throw new Error("doubleClick requires selector or x/y coordinates");
}

export async function rightClick({ selector, x, y }) {
  if (selector) {
    const sel = selector.replace(/'/g, "\\'");
    return runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found: ${sel}';el.scrollIntoView({block:'center'});el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));return 'Right-clicked: '+el.tagName;})()`
    );
  }
  if (x !== undefined && y !== undefined) {
    return runJS(
      `(function(){var el=document.elementFromPoint(${Number(x)},${Number(y)});if(!el)return 'No element at (${x},${y})';el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));return 'Right-clicked: '+el.tagName+' at (${x},${y})';})()`
    );
  }
  throw new Error("rightClick requires selector or x/y coordinates");
}

// ========== FORM INPUT ==========

export async function fill({ selector, value, ref }) {
  if (ref) selector = refSelector(ref);
  const sel = selector.replace(/'/g, "\\'");
  // Proper escaping order: backslashes first, then quotes
  const val = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "");
  return runJS(
    `(function(){
      var el = document.querySelector('${sel}');
      if (!el) return 'Element not found: ${sel}';
      el.focus();
      // For contenteditable elements (Rich text editors like Medium, ProseMirror)
      if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
        el.textContent = '';
        document.execCommand('insertText', false, '${val}');
        return 'Filled contenteditable with "' + el.textContent.substring(0, 50) + '"';
      }
      // For regular inputs/textareas (React-compatible via native setter)
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                         Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (nativeSetter && nativeSetter.set) {
        nativeSetter.set.call(el, '${val}');
      } else {
        el.value = '${val}';
      }
      el.dispatchEvent(new Event('input', {bubbles: true}));
      el.dispatchEvent(new Event('change', {bubbles: true}));
      return 'Filled: ' + el.tagName + '[' + (el.type || '') + '] with "' + el.value.substring(0, 50) + '"';
    })()`
  );
}

export async function clearField({ selector }) {
  const sel = selector.replace(/'/g, "\\'");
  return runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found';el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'Cleared';})()`
  );
}

export async function selectOption({ selector, value }) {
  const sel = selector.replace(/'/g, "\\'");
  const val = value.replace(/'/g, "\\'");
  return runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found';el.value='${val}';el.dispatchEvent(new Event('change',{bubbles:true}));return 'Selected: '+el.value;})()`
  );
}

export async function fillForm({ fields }) {
  // Single JS call for ALL fields (instead of N separate osascript calls)
  const fieldsJSON = JSON.stringify(fields.map(f => ({
    s: f.selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
    v: f.value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n"),
  })));
  return runJS(
    `(function(){
      var fields = ${fieldsJSON};
      var results = [];
      fields.forEach(function(f) {
        var el = document.querySelector(f.s);
        if (!el) { results.push('Not found: ' + f.s); return; }
        el.focus();
        if (el.isContentEditable) {
          el.textContent = '';
          document.execCommand('insertText', false, f.v);
        } else {
          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                       Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (setter && setter.set) setter.set.call(el, f.v);
          else el.value = f.v;
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        }
        results.push('Filled: ' + el.tagName + ' with "' + f.v.substring(0, 30) + '"');
      });
      return results.join('\\n');
    })()`
  );
}

// ========== KEYBOARD ==========

// JS key names for KeyboardEvent
const jsKeyMap = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", space: " ",
  delete: "Backspace", backspace: "Backspace", up: "ArrowUp", down: "ArrowDown",
  left: "ArrowLeft", right: "ArrowRight", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
};

// System Events key codes — only used for paste_image, upload_file, save_pdf
// (functions that truly require OS-level UI interaction)

export async function pressKey({ key, modifiers = [] }) {
  const hasCmdOrCtrl = modifiers.some((m) => ["cmd", "ctrl"].includes(m.toLowerCase()));
  const hasShift = modifiers.some((m) => m.toLowerCase() === "shift");
  const k = key.toLowerCase();

  // Try to handle EVERYTHING via JavaScript — no System Events, no focus stealing
  if (hasCmdOrCtrl) {
    // Map Cmd/Ctrl shortcuts to JS execCommand equivalents
    const jsShortcuts = {
      a: "document.execCommand('selectAll')",
      c: `(function(){
        var sel = window.getSelection();
        if (sel.toString()) { navigator.clipboard.writeText(sel.toString()).catch(function(){}); }
        return 'Copied';
      })()`,
      x: "document.execCommand('cut')",
      z: hasShift ? "document.execCommand('redo')" : "document.execCommand('undo')",
      b: "document.execCommand('bold')",
      i: "document.execCommand('italic')",
      u: "document.execCommand('underline')",
    };

    if (jsShortcuts[k]) {
      await runJS(jsShortcuts[k]);
      return `Pressed: ${modifiers.join("+")}+${key} (via JS)`;
    }

    // Cmd+V (paste) — the ONE shortcut that truly needs System Events
    // because JS can't access system clipboard for paste without user gesture
    if (k === "v") {
      // Use Safari's Edit menu instead of keystroke — more reliable, targets Safari directly
      await osascript(
        `tell application "System Events"
          tell process "Safari"
            click menu item "Paste" of menu "Edit" of menu bar 1
          end tell
        end tell`
      );
      return `Pressed: ${modifiers.join("+")}+v (via menu)`;
    }

    // Other Cmd shortcuts — dispatch JS KeyboardEvent
    await runJS(
      `(function(){
        var el = document.activeElement || document.body;
        var e = new KeyboardEvent('keydown', {key:'${k}',code:'Key${k.toUpperCase()}',metaKey:true,ctrlKey:false,bubbles:true,cancelable:true});
        el.dispatchEvent(e);
        el.dispatchEvent(new KeyboardEvent('keyup', {key:'${k}',metaKey:true,bubbles:true}));
        return 'Pressed';
      })()`
    );
    return `Pressed: ${modifiers.join("+")}+${key}`;
  }

  // Non-modifier keys: pure JavaScript (no System Events)
  const jsKey = jsKeyMap[k] || key;
  const safeKey = jsKey.replace(/'/g, "\\'");
  const shiftKey = hasShift;
  const altKey = modifiers.some((m) => m.toLowerCase() === "alt");

  await runJS(
    `(function(){
      var el = document.activeElement || document.body;
      var opts = {key:'${safeKey}',code:'Key${safeKey.length === 1 ? safeKey.toUpperCase() : safeKey}',bubbles:true,cancelable:true,shiftKey:${shiftKey},altKey:${altKey}};
      var down = new KeyboardEvent('keydown', opts);
      var prevented = !el.dispatchEvent(down);
      if (!prevented) {
        if ('${safeKey}' === 'Enter') {
          if (el.tagName === 'INPUT') { el.form && el.form.dispatchEvent(new Event('submit',{bubbles:true})); }
          else { document.execCommand('insertLineBreak'); }
        } else if ('${safeKey}' === 'Tab') {
          var focusable = [...document.querySelectorAll('input,textarea,select,button,a,[tabindex]')].filter(function(e){return e.tabIndex>=0;});
          var idx = focusable.indexOf(el);
          var next = ${shiftKey} ? focusable[idx-1] : focusable[idx+1];
          if (next) next.focus();
        } else if ('${safeKey}' === 'Backspace') {
          document.execCommand('delete');
        } else if ('${safeKey}' === 'Escape') {
          el.blur();
        }
      }
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      return 'OK';
    })()`
  );
  return `Pressed: ${modifiers.length ? modifiers.join("+") + "+" : ""}${key}`;
}

export async function typeText({ text, selector, ref }) {
  if (ref) selector = refSelector(ref);
  if (selector) {
    const sel = selector.replace(/'/g, "\\'");
    await runJS(`document.querySelector('${sel}')?.focus()`);
    await new Promise((r) => setTimeout(r, 200));
  }

  // Use JavaScript insertText — works in inputs, textareas, and contenteditable
  // No System Events = no keyboard conflict with user
  const safeText = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n");
  const result = await runJS(
    `(function(){
      var el = document.activeElement;
      if (!el) return 'No focused element';

      // Method 1: execCommand insertText (works in contenteditable, inputs, textareas)
      var ok = document.execCommand('insertText', false, '${safeText}');
      if (ok) return 'Typed ' + ${text.length} + ' chars via insertText';

      // Method 2: InputEvent (for modern editors like ProseMirror, Draft.js, Slate)
      try {
        el.dispatchEvent(new InputEvent('beforeinput', {inputType:'insertText', data:'${safeText}', bubbles:true, cancelable:true}));
        el.dispatchEvent(new InputEvent('input', {inputType:'insertText', data:'${safeText}', bubbles:true}));
        return 'Typed ' + ${text.length} + ' chars via InputEvent';
      } catch(e) {}

      // Method 3: Direct value set (for plain inputs/textareas)
      if ('value' in el) {
        var start = el.selectionStart || 0;
        el.value = el.value.substring(0, start) + '${safeText}' + el.value.substring(el.selectionEnd || start);
        el.selectionStart = el.selectionEnd = start + ${text.length};
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return 'Typed ' + ${text.length} + ' chars via value set';
      }

      return 'Could not type — no compatible input method';
    })()`
  );

  return result;
}

// ========== SCREENSHOT ==========

export async function screenshot({ fullPage = false } = {}) {
  const tmpFile = join(tmpdir(), `safari-screenshot-${Date.now()}.png`);
  try {
    // If working on a background tab, temporarily switch to it for screenshot
    let savedTabIdx = null;
    if (_activeTabIndex) {
      try {
        const currentIdx = await osascriptFast(
          `tell application "Safari" to return index of current tab of front window`
        );
        if (Number(currentIdx) !== _activeTabIndex) {
          savedTabIdx = Number(currentIdx);
          await osascriptFast(
            `tell application "Safari" to set current tab of front window to tab ${_activeTabIndex} of front window`
          );
          await new Promise(r => setTimeout(r, 200)); // Let Safari render the tab
        }
      } catch (_) {}
    }
    const skipScreencapture = false; // Always try screencapture now

    // Try screencapture — use osascript's do shell script to bypass VS Code permission issue
    const windowId = !skipScreencapture ? await osascript(
      'tell application "Safari" to return id of window 1'
    ).catch(() => null) : null;

    if (windowId) {
      try {
        if (fullPage) {
          const bounds = await osascript(
            'tell application "Safari" to return bounds of front window'
          );
          const dims = await runJS("JSON.stringify({h:document.documentElement.scrollHeight,w:document.documentElement.scrollWidth})");
          const { h, w } = JSON.parse(dims);
          await osascript(
            `tell application "Safari" to set bounds of front window to {0, 0, ${Number(w)}, ${Math.min(Number(h) + 100, 5000)}}`
          );
          await new Promise((r) => setTimeout(r, 500));
          // Use do shell script to inherit osascript's Screen Recording permission
          await osascript(
            `do shell script "screencapture -l${windowId} -o -x '${tmpFile}'"`,
            { timeout: 15000 }
          );
          await osascript(
            `tell application "Safari" to set bounds of front window to {${bounds}}`
          );
        } else {
          // Try direct execFile first (works if VS Code has Screen Recording permission)
          try {
            await execFileAsync("screencapture", ["-l" + windowId, "-o", "-x", tmpFile]);
            const testData = await readFile(tmpFile);
            if (testData.length < 100) throw new Error("empty");
          } catch (_) {
            // Fallback: use do shell script (osascript may have permission)
            await osascript(
              `do shell script "screencapture -l${windowId} -o -x '${tmpFile}'"`,
              { timeout: 15000 }
            );
          }
        }
        const data = await readFile(tmpFile);
        await unlink(tmpFile).catch(() => {});
        if (data.length > 100) return data.toString("base64");
      } catch (_) {
        // screencapture failed, fall through to JS method
      }
    }

    // Fallback: JS-based screenshot via canvas (no permissions needed)
    const dataUrl = await runJS(
      `(async function(){` +
      `var c=document.createElement('canvas');var ctx=c.getContext('2d');` +
      `c.width=window.innerWidth;c.height=${fullPage ? 'document.documentElement.scrollHeight' : 'window.innerHeight'};` +
      `var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+c.width+'" height="'+c.height+'">' +` +
      `'<foreignObject width="100%" height="100%">' +` +
      `'<div xmlns="http://www.w3.org/1999/xhtml">' + document.documentElement.outerHTML + '</div>' +` +
      `'</foreignObject></svg>';` +
      `var blob=new Blob([svg],{type:'image/svg+xml'});` +
      `var url=URL.createObjectURL(blob);` +
      `var img=new Image();` +
      `return new Promise(function(resolve){` +
      `img.onload=function(){ctx.drawImage(img,0,0);resolve(c.toDataURL('image/png').split(',')[1]);};` +
      `img.onerror=function(){resolve('FALLBACK_TEXT')};` +
      `img.src=url;});})()`,
      { timeout: 30000 }
    );

    if (dataUrl && dataUrl !== "FALLBACK_TEXT") {
      return dataUrl;
    }

    // Final fallback: return page text description
    throw new Error("Screenshot unavailable. Grant Screen Recording permission to VS Code/Terminal in System Settings → Privacy & Security → Screen Recording, then restart.");
  } finally {
    await unlink(tmpFile).catch(() => {});
    // Restore user's tab if we switched
    if (savedTabIdx) {
      try {
        await osascriptFast(
          `tell application "Safari" to set current tab of front window to tab ${savedTabIdx} of front window`
        );
      } catch (_) {}
    }
  }
}

// ========== ELEMENT SCREENSHOT ==========

export async function screenshotElement({ selector }) {
  const sel = selector.replace(/'/g, "\\'");
  // Use html2canvas-like approach: capture element via SVG foreignObject
  const result = await runJS(
    `(async function(){
      var el = document.querySelector('${sel}');
      if (!el) return 'Element not found: ${sel}';
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return 'Element has no dimensions';

      // Scroll element into view
      el.scrollIntoView({block:'center'});
      await new Promise(r => setTimeout(r, 100));
      rect = el.getBoundingClientRect();

      // Use canvas + drawImage from window screenshot approach
      var c = document.createElement('canvas');
      c.width = Math.ceil(rect.width * window.devicePixelRatio);
      c.height = Math.ceil(rect.height * window.devicePixelRatio);
      var ctx = c.getContext('2d');
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

      // Clone element to avoid cross-origin issues
      var clone = el.cloneNode(true);
      var styles = window.getComputedStyle(el);
      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:absolute;left:-99999px;top:0;width:'+rect.width+'px;height:'+rect.height+'px;overflow:hidden;background:'+styles.backgroundColor;
      wrapper.appendChild(clone);
      document.body.appendChild(wrapper);

      // Serialize to SVG foreignObject
      var html = new XMLSerializer().serializeToString(wrapper);
      document.body.removeChild(wrapper);
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+rect.width+'" height="'+rect.height+'">' +
        '<foreignObject width="100%" height="100%">' + html + '</foreignObject></svg>';
      var blob = new Blob([svg], {type:'image/svg+xml;charset=utf-8'});
      var url = URL.createObjectURL(blob);
      var img = new Image();
      return new Promise(function(resolve){
        img.onload = function(){
          ctx.drawImage(img, 0, 0, rect.width, rect.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = function(){ resolve('SVG_RENDER_FAILED'); };
        img.src = url;
      });
    })()`,
    { timeout: 15000 }
  );

  if (result === "SVG_RENDER_FAILED" || result.startsWith("Element")) {
    // Fallback: use screencapture + crop
    const tmpFile = join(tmpdir(), `safari-el-${Date.now()}.png`);
    try {
      const windowId = await osascript('tell application "Safari" to return id of window 1').catch(() => null);
      if (!windowId) throw new Error("Cannot get Safari window ID");

      // Get element bounds relative to screen
      const bounds = await runJS(
        `(function(){var el=document.querySelector('${sel}');if(!el)return '';var r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)});})()`
      );
      if (!bounds) throw new Error(result);

      // Full window screenshot then crop with sips
      await execFileAsync("screencapture", ["-l" + windowId, "-o", "-x", tmpFile]);
      const { x, y, w, h } = JSON.parse(bounds);
      // Use sips to crop (macOS built-in)
      const toolbarHeight = 52; // Safari toolbar approximate height
      const cropFile = join(tmpdir(), `safari-el-crop-${Date.now()}.png`);
      await execFileAsync("sips", [
        "-c", String(h), String(w),
        "--cropOffset", String(y + toolbarHeight), String(x),
        tmpFile, "--out", cropFile
      ]);
      const data = await readFile(cropFile);
      await unlink(tmpFile).catch(() => {});
      await unlink(cropFile).catch(() => {});
      if (data.length > 100) return data.toString("base64");
    } catch (e) {
      await unlink(tmpFile).catch(() => {});
      throw new Error(`Element screenshot failed: ${e.message}`);
    }
  }

  return result;
}

// ========== SCROLL ==========

export async function scroll({ direction = "down", amount = 500 }) {
  const y = direction === "up" ? -Number(amount) : Number(amount);
  // Single call: scroll + return position
  return runJS(
    `(function(){window.scrollBy(0,${y});return 'Scrolled ${direction} ${amount}px. Position: '+JSON.stringify({x:window.scrollX,y:window.scrollY,height:document.documentElement.scrollHeight});})()`
  );
}

export async function scrollTo({ x = 0, y = 0 }) {
  return runJS(`(function(){window.scrollTo(${Number(x)},${Number(y)});return 'Scrolled to (${x},${y})';})()`);
}

// ========== TAB MANAGEMENT ==========

export async function listTabs() {
  // If we have a tracked URL, re-resolve the index (it may have shifted)
  // If no URL tracked, reset index (new session should open its own tab)
  if (_activeTabURL) {
    await resolveActiveTab();
  } else {
    _activeTabIndex = null;
  }

  const result = await osascript(
    `tell application "Safari"
      set output to ""
      set tabIndex to 1
      repeat with t in every tab of front window
        if tabIndex > 1 then set output to output & linefeed
        set output to output & (tabIndex as text) & (ASCII character 9) & name of t & (ASCII character 9) & URL of t
        set tabIndex to tabIndex + 1
      end repeat
      return output
    end tell`
  );
  if (!result.trim()) return JSON.stringify([]);
  const tabs = result.split("\n").map((line) => {
    const parts = line.split("\t");
    return { index: parseInt(parts[0]), title: parts[1] || "", url: parts[2] || "" };
  });
  return JSON.stringify(tabs, null, 2);
}

export async function newTab(url = "") {
  return withoutStealingFocus(async () => {
    const safeUrl = url ? url.replace(/"/g, '\\"') : "";
    try {
      // Save user's current tab, create new tab, restore user's tab — all in ONE osascript call
      // This minimizes the visual "flash" to nearly zero
      if (url) {
        await osascript(
          `tell application "Safari"
            tell front window
              set userTab to current tab
              make new tab with properties {URL:"${safeUrl}"}
              set current tab to userTab
            end tell
          end tell`
        );
      } else {
        await osascript(
          `tell application "Safari"
            tell front window
              set userTab to current tab
              make new tab
              set current tab to userTab
            end tell
          end tell`
        );
      }
    } catch {
      // No window exists — create one
      if (url) {
        await osascript(`tell application "Safari" to make new document with properties {URL:"${safeUrl}"}`);
      } else {
        await osascript('tell application "Safari" to make new document');
      }
    }

    // Get the index of the newly created tab (always the last one)
    const tabCount = await osascriptFast(
      'tell application "Safari" to return count of tabs of front window'
    );
    const newIndex = Number(tabCount);
    _activeTabIndex = newIndex;

    // Wait for the new tab to start loading (especially if URL was provided)
    if (url) {
      // Poll until URL changes from about:blank/empty or readyState is complete
      const waitResult = await runJS(
        `(async function(){
          for(var i=0;i<40;i++){
            if(location.href !== 'about:blank' && location.href !== '' && document.readyState !== 'loading') break;
            await new Promise(function(r){setTimeout(r,250)});
          }
          return 'ready';
        })()`,
        { tabIndex: newIndex, timeout: 15000 }
      );
    } else {
      await new Promise((r) => setTimeout(r, 200));
    }
    // Track by URL — use TARGET url if tab hasn't loaded yet
    const info = await runJS(`JSON.stringify({title:document.title,url:location.href,tabIndex:${newIndex}})`, { tabIndex: newIndex });
    try {
      const parsed = JSON.parse(info);
      // If tab is still about:blank, use the target URL for tracking
      if (parsed.url === 'about:blank' || parsed.url === '' || !parsed.url) {
        _activeTabURL = url || null;
      } else {
        _activeTabURL = parsed.url;
      }
    } catch {
      _activeTabURL = url || null;
    }
    return info;
  });
}

export async function closeTab() {
  if (_activeTabIndex) {
    await osascript(
      `tell application "Safari" to close tab ${_activeTabIndex} of front window`
    );
    _activeTabIndex = null;
    _activeTabURL = null;
  } else {
    await osascript(
      `tell application "Safari" to close current tab of front window`
    );
  }
  return "Tab closed";
}

export async function switchTab(index) {
  // NO visual tab switch — just update internal tracking.
  // All subsequent runJS calls will target this tab by index.
  // The user's visible tab stays unchanged.
  const idx = Number(index);
  _activeTabIndex = idx;
  // Get title+URL from the target tab without switching visually
  const result = await runJS(
    `JSON.stringify({title:document.title,url:location.href})`,
    { tabIndex: idx }
  );
  // Track by URL so we can find this tab even if indices shift
  try {
    const parsed = JSON.parse(result);
    _activeTabURL = parsed.url || null;
  } catch {}
  return result;
}

// ========== WAIT ==========

export async function waitFor({ selector, text, timeout = 10000 }) {
  // Single JS call with internal polling loop — 1 call instead of 20+
  const safeSelector = selector ? selector.replace(/'/g, "\\'") : "";
  const safeText = text ? text.replace(/'/g, "\\'") : "";
  const result = await runJS(
    `(async function(){
      var deadline = Date.now() + ${Number(timeout)};
      while (Date.now() < deadline) {
        ${safeSelector ? `if (document.querySelector('${safeSelector}')) return 'Found: ${safeSelector}';` : ""}
        ${safeText ? `if (document.body && document.body.innerText.includes('${safeText}')) return 'Found text: ${safeText}';` : ""}
        await new Promise(function(r){setTimeout(r, 200)});
      }
      return 'TIMEOUT';
    })()`,
    { timeout: timeout + 2000 }
  );
  if (result === "TIMEOUT") {
    throw new Error(`Timeout waiting for ${selector || text} (${timeout}ms)`);
  }
  return result;
}

// ========== EVALUATE ==========

export async function evaluate({ script }) {
  // Wrap in IIFE if the script uses `return` outside a function
  // or if it's a multi-statement script that might not return a value
  let js = script.trim();

  // If already wrapped in IIFE or is a simple expression, use as-is
  const isIIFE = /^\((?:async\s+)?function/.test(js) || /^\((?:async\s+)?\(/.test(js);
  const isSimpleExpression = !js.includes(';') && !js.includes('\n') && !js.startsWith('var ') && !js.startsWith('let ') && !js.startsWith('const ');

  if (!isIIFE && !isSimpleExpression) {
    // Wrap in IIFE so `return` works and last expression is returned
    // Also add implicit return of last expression if no explicit return
    if (!js.includes('return ') && !js.includes('return;')) {
      // Add return to last line
      const lines = js.split('\n');
      const lastLine = lines[lines.length - 1].trim();
      if (lastLine && !lastLine.startsWith('//') && !lastLine.endsWith('}') && !lastLine.startsWith('var ') && !lastLine.startsWith('let ') && !lastLine.startsWith('const ')) {
        lines[lines.length - 1] = 'return ' + lastLine;
      }
      js = '(function(){' + lines.join('\n') + '})()';
    } else {
      js = '(function(){' + js + '})()';
    }
  }

  const result = await runJS(js);
  // Convert empty/null results to informative message
  if (result === null || result === undefined || result === '') {
    return '(no return value — script executed but returned nothing. Use explicit return or ensure last expression has a value)';
  }
  return result;
}

// ========== ELEMENT INFO ==========

export async function getElementInfo({ selector }) {
  const sel = selector.replace(/'/g, "\\'");
  return runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found';var r=el.getBoundingClientRect();return JSON.stringify({tag:el.tagName,text:el.textContent.trim().substring(0,200),href:el.href||'',value:el.value||'',visible:r.width>0&&r.height>0,rect:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)},attrs:Object.fromEntries([...el.attributes].map(function(a){return[a.name,a.value.substring(0,100)]}))})})()`
  );
}

export async function querySelectorAll({ selector, limit = 20 }) {
  const sel = selector.replace(/'/g, "\\'");
  return runJS(
    `JSON.stringify([...document.querySelectorAll('${sel}')].slice(0,${Number(limit)}).map(function(el,i){return{index:i,tag:el.tagName,text:el.textContent.trim().substring(0,100),href:el.href||undefined,value:el.value||undefined}}))`
  );
}

// ========== HOVER ==========

export async function hover({ selector, x, y, ref }) {
  if (ref) selector = refSelector(ref);
  if (selector) {
    const sel = selector.replace(/'/g, "\\'");
    return runJS(
      `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found';el.scrollIntoView({block:'center'});el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));return 'Hovered: '+el.tagName;})()`
    );
  }
  if (x !== undefined && y !== undefined) {
    return runJS(
      `(function(){var el=document.elementFromPoint(${Number(x)},${Number(y)});if(!el)return 'No element';el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));el.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));return 'Hovered: '+el.tagName+' at (${Number(x)},${Number(y)})';})()`
    );
  }
  throw new Error("hover requires selector or x/y coordinates");
}

// ========== DIALOG HANDLING ==========

export async function handleDialog({ action = "accept", text }) {
  if (text !== undefined) {
    const safeText = text.replace(/'/g, "\\'");
    await runJS(
      `window.__mcp_dialog_response='${safeText}';window.__origPrompt=window.prompt;window.prompt=function(){var r=window.__mcp_dialog_response;window.prompt=window.__origPrompt;return r;}`
    );
  }
  if (action === "accept") {
    await runJS(
      "window.__origConfirm=window.confirm;window.confirm=function(){window.confirm=window.__origConfirm;return true;};window.__origAlert=window.alert;window.alert=function(){window.alert=window.__origAlert;};"
    );
  } else {
    await runJS(
      "window.__origConfirm=window.confirm;window.confirm=function(){window.confirm=window.__origConfirm;return false;};"
    );
  }
  return `Dialog handler set: ${action}${text ? ' with "' + text + '"' : ""}`;
}

// ========== WINDOW ==========

export async function resizeWindow({ width, height }) {
  await osascript(
    `tell application "Safari" to set bounds of front window to {0, 0, ${Number(width)}, ${Number(height)}}`
  );
  return `Resized to ${width}x${height}`;
}

// ========== COOKIES & STORAGE ==========

export async function getCookies() {
  return runJS("document.cookie");
}

export async function getLocalStorage({ key }) {
  if (key) {
    const safeKey = key.replace(/'/g, "\\'");
    return runJS(`localStorage.getItem('${safeKey}')`);
  }
  return runJS(
    "JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(function(k){return[k,localStorage.getItem(k).substring(0,200)]})))"
  );
}

// ========== NETWORK (via Performance API) ==========

export async function getNetworkRequests({ limit = 50 } = {}) {
  return runJS(
    `JSON.stringify(performance.getEntriesByType('resource').slice(-${Number(limit)}).map(function(r){return{name:r.name,type:r.initiatorType,duration:Math.round(r.duration),size:r.transferSize||0}}))`
  );
}

// ========== DRAG ==========

export async function drag({ sourceSelector, targetSelector, sourceX, sourceY, targetX, targetY }) {
  if (sourceSelector && targetSelector) {
    const srcSel = sourceSelector.replace(/'/g, "\\'");
    const tgtSel = targetSelector.replace(/'/g, "\\'");
    return runJS(
      `(function(){` +
      `var src=document.querySelector('${srcSel}');var tgt=document.querySelector('${tgtSel}');` +
      `if(!src)return 'Source not found: ${srcSel}';if(!tgt)return 'Target not found: ${tgtSel}';` +
      `var sr=src.getBoundingClientRect();var tr=tgt.getBoundingClientRect();` +
      `var sx=sr.x+sr.width/2,sy=sr.y+sr.height/2,tx=tr.x+tr.width/2,ty=tr.y+tr.height/2;` +
      `src.dispatchEvent(new MouseEvent('mousedown',{clientX:sx,clientY:sy,bubbles:true}));` +
      `src.dispatchEvent(new MouseEvent('mousemove',{clientX:sx,clientY:sy,bubbles:true}));` +
      `tgt.dispatchEvent(new MouseEvent('mousemove',{clientX:tx,clientY:ty,bubbles:true}));` +
      `tgt.dispatchEvent(new MouseEvent('mouseup',{clientX:tx,clientY:ty,bubbles:true}));` +
      `tgt.dispatchEvent(new DragEvent('drop',{bubbles:true}));` +
      `return 'Dragged from '+src.tagName+' to '+tgt.tagName;})()`
    );
  }
  if (sourceX !== undefined && sourceY !== undefined && targetX !== undefined && targetY !== undefined) {
    return runJS(
      `(function(){` +
      `var src=document.elementFromPoint(${Number(sourceX)},${Number(sourceY)});` +
      `if(!src)return 'No element at source';` +
      `src.dispatchEvent(new MouseEvent('mousedown',{clientX:${Number(sourceX)},clientY:${Number(sourceY)},bubbles:true}));` +
      `src.dispatchEvent(new MouseEvent('mousemove',{clientX:${Number(sourceX)},clientY:${Number(sourceY)},bubbles:true}));` +
      `document.elementFromPoint(${Number(targetX)},${Number(targetY)})?.dispatchEvent(new MouseEvent('mousemove',{clientX:${Number(targetX)},clientY:${Number(targetY)},bubbles:true}));` +
      `document.elementFromPoint(${Number(targetX)},${Number(targetY)})?.dispatchEvent(new MouseEvent('mouseup',{clientX:${Number(targetX)},clientY:${Number(targetY)},bubbles:true}));` +
      `return 'Dragged from (${Number(sourceX)},${Number(sourceY)}) to (${Number(targetX)},${Number(targetY)})';})()`
    );
  }
  throw new Error("drag requires sourceSelector+targetSelector or sourceX/Y+targetX/Y");
}

// ========== UPLOAD FILE ==========

export async function uploadFile({ selector, filePath }) {
  // Read file in Node.js, send as base64 to Safari JS, create File + DataTransfer
  // NO file dialog, NO System Events, NO focus stealing

  // Safety: close any open file dialog first (in case Claude clicked the input before calling this)
  await osascript(
    `tell application "System Events"
      tell process "Safari"
        if exists sheet 1 of window 1 then
          click button "ביטול" of sheet 1 of window 1
        end if
      end tell
    end tell`
  ).catch(() => {}); // Ignore if no dialog open

  const sel = selector.replace(/'/g, "\\'");
  const { basename, extname } = await import("node:path");
  const fileName = basename(filePath);
  const ext = extname(filePath).toLowerCase().replace(".", "");

  // Read file as base64
  const fileData = await readFile(filePath);
  const base64 = fileData.toString("base64");

  // Determine MIME type
  const mimeMap = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
    mp4: "video/mp4", mp3: "audio/mpeg", txt: "text/plain", csv: "text/csv",
    json: "application/json", zip: "application/zip", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  const mime = mimeMap[ext] || "application/octet-stream";
  const safeName = fileName.replace(/'/g, "\\'");

  // Send to Safari via runJSLarge (handles files >260KB via temp file)
  const result = await runJSLarge(
    `(function(){
      var el = document.querySelector('${sel}');
      if (!el) return 'Element not found: ${sel}';

      // Decode base64 to binary
      var b64 = '${base64}';
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      var file = new File([bytes], '${safeName}', { type: '${mime}' });
      var dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;

      // Trigger events for frameworks
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'Uploaded: ${safeName} (' + Math.round(bytes.length / 1024) + ' KB)';
    })()`,
    { timeout: 30000 }
  );

  return result;
}

// ========== PASTE IMAGE FROM FILE ==========

export async function pasteImageFromFile({ filePath }) {
  // Paste image via JS ClipboardEvent — NO clipboard touch, NO System Events, NO focus steal
  const { extname } = await import("node:path");
  const ext = extname(filePath).toLowerCase().replace(".", "");
  const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const mime = mimeMap[ext] || "image/png";

  // Read image as base64
  const fileData = await readFile(filePath);
  const base64 = fileData.toString("base64");
  const fileName = filePath.split("/").pop().replace(/'/g, "\\'");

  // Use runJSLarge — images are often >260KB as base64
  const result = await runJSLarge(
    `(function(){
      var el = document.activeElement;
      if (!el) return 'No focused element';

      // Decode base64 to blob
      var b64 = '${base64}';
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var blob = new Blob([bytes], { type: '${mime}' });
      var file = new File([blob], '${fileName}', { type: '${mime}' });

      // Method 1: Synthetic paste event with DataTransfer (works on Medium, dev.to, etc.)
      var dt = new DataTransfer();
      dt.items.add(file);
      var pasteEvent = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      var handled = el.dispatchEvent(pasteEvent);

      // Method 2: If paste didn't work, try drop event (works on drag-drop zones)
      if (!handled || !document.querySelector('img[src^="blob:"],img[src^="data:"]')) {
        var dropDt = new DataTransfer();
        dropDt.items.add(file);
        var dropEvent = new DragEvent('drop', { dataTransfer: dropDt, bubbles: true, cancelable: true });
        el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dropDt, bubbles: true }));
        el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dropDt, bubbles: true }));
        el.dispatchEvent(dropEvent);
      }

      return 'Pasted image: ${fileName} (' + Math.round(bytes.length / 1024) + ' KB)';
    })()`,
    { timeout: 30000 }
  );

  return result;
}

// ========== EMULATE (VIEWPORT) ==========

export async function emulate({ device, width, height, userAgent, scale = 1 }) {
  const devices = {
    "iphone-14": { width: 390, height: 844, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    "iphone-14-pro-max": { width: 430, height: 932, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    "ipad": { width: 820, height: 1180, ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    "ipad-pro": { width: 1024, height: 1366, ua: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
    "pixel-7": { width: 412, height: 915, ua: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" },
    "galaxy-s24": { width: 412, height: 915, ua: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" },
  };

  const d = device ? devices[device.toLowerCase()] : null;
  const w = d ? d.width : (width || 375);
  const h = d ? d.height : (height || 812);
  const ua = d ? d.ua : (userAgent || "");

  // Resize Safari window to match device
  await osascript(
    `tell application "Safari" to set bounds of front window to {0, 0, ${w}, ${h + 100}}`
  );

  // Override viewport meta and user agent if specified
  if (ua) {
    await runJS(
      `Object.defineProperty(navigator,'userAgent',{get:function(){return '${ua.replace(/'/g, "\\'")}'},configurable:true})`
    );
  }

  // Set viewport meta tag
  await runJS(
    `(function(){var m=document.querySelector('meta[name=viewport]');if(!m){m=document.createElement('meta');m.name='viewport';document.head.appendChild(m);}m.content='width=${w},initial-scale=${scale}';})()`
  );

  // Reload to apply changes
  // Reload and wait via inline JS polling (not fixed sleep)
  await runJS(
    `(async function(){location.reload();await new Promise(function(r){setTimeout(r,300)});for(var i=0;i<30;i++){if(document.readyState==='complete')break;await new Promise(function(r){setTimeout(r,200)});}return 'done';})()`
  );

  return JSON.stringify({
    device: device || "custom",
    width: w,
    height: h,
    userAgent: ua ? ua.substring(0, 60) + "..." : "(default)",
  });
}

export async function resetEmulation() {
  // Reset user agent
  await runJS(
    "delete Object.getOwnPropertyDescriptor(Navigator.prototype,'userAgent')||true"
  );
  // Maximize window
  await osascript(
    `tell application "Safari" to set bounds of front window to {0, 0, 1440, 900}`
  );
  await runJS(
    `(async function(){location.reload();await new Promise(function(r){setTimeout(r,300)});for(var i=0;i<30;i++){if(document.readyState==='complete')break;await new Promise(function(r){setTimeout(r,200)});}return 'done';})()`
  );
  return "Emulation reset to desktop";
}

// ========== CONSOLE CAPTURE ==========

export async function startConsoleCapture() {
  await runJS(
    "if(!window.__mcp_console){window.__mcp_console=[];var orig={log:console.log,warn:console.warn,error:console.error,info:console.info};['log','warn','error','info'].forEach(function(level){console[level]=function(){window.__mcp_console.push({level:level,message:[].slice.call(arguments).map(String).join(' '),time:Date.now()});orig[level].apply(console,arguments);};});window.addEventListener('error',function(e){window.__mcp_console.push({level:'error',message:e.message,time:Date.now()});});}"
  );
  return "Console capture started";
}

export async function getConsoleMessages() {
  return runJS("JSON.stringify(window.__mcp_console||[])");
}

export async function clearConsoleCapture() {
  return runJS("window.__mcp_console=[]; 'Console cleared'");
}

// ========== PDF SAVE ==========

export async function savePDF({ path: pdfPath }) {
  const safePath = pdfPath.replace(/"/g, '\\"');
  // Use window.print() API + AppleScript to save as PDF
  // Strategy: use osascript to print to PDF directly via CUPS (no UI at all)
  try {
    // Method 1: Use Safari's native "Export as PDF" via AppleScript menu + clipboard paste for path
    await osascript(
      `tell application "Safari" to activate
      delay 0.3
      tell application "System Events"
        tell process "Safari"
          click menu item "Export as PDF…" of menu "File" of menu bar 1
          delay 1
          -- Use clipboard to paste path (immune to keyboard layout)
          set the clipboard to "${safePath}"
          delay 0.1
          keystroke "g" using {command down, shift down}
          delay 0.8
          keystroke "a" using {command down}
          delay 0.1
          keystroke "v" using {command down}
          delay 0.3
          key code 36
          delay 1
          key code 36
        end tell
      end tell`,
      { timeout: 20000 }
    );
  } catch (err) {
    throw new Error(`PDF save failed: ${err.message}. Try granting Accessibility permission to Terminal/VS Code.`);
  }
  await new Promise((r) => setTimeout(r, 2000));
  return `PDF saved to: ${pdfPath}`;
}

// ========== SNAPSHOT — ref-based interaction (like Chrome DevTools MCP) ==========
// Assigns numeric refs to interactive/visible elements so Claude can say "click ref 5"
// instead of guessing CSS selectors. Much faster, no hallucination risk.

let _snapshotGen = 0;

export async function takeSnapshot({ selector } = {}) {
  const gen = _snapshotGen++;
  const root = selector ? `document.querySelector('${selector.replace(/'/g, "\\'")}')` : "document.body";

  const result = await runJS(
    `(function(){
      var gen = ${gen};
      var id = 0;
      var lines = [];
      // Clear old refs
      document.querySelectorAll('[data-mcp-ref]').forEach(function(el){ el.removeAttribute('data-mcp-ref'); });

      function getRole(el) {
        var role = el.getAttribute('role');
        if (role) return role;
        var tag = el.tagName.toLowerCase();
        var map = {
          a:'link', button:'button', input:'textbox', textarea:'textbox',
          select:'combobox', img:'img', h1:'heading', h2:'heading', h3:'heading',
          h4:'heading', h5:'heading', h6:'heading', nav:'navigation', main:'main',
          header:'banner', footer:'contentinfo', form:'form', table:'table',
          tr:'row', th:'columnheader', td:'cell', ul:'list', ol:'list', li:'listitem',
          dialog:'dialog', details:'group', summary:'button', label:'label',
          iframe:'document', video:'video', audio:'audio', canvas:'canvas',
          progress:'progressbar', meter:'meter'
        };
        if (tag === 'input') {
          var type = (el.type || 'text').toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'submit' || type === 'button') return 'button';
          if (type === 'file') return 'file';
          if (type === 'range') return 'slider';
          return 'textbox';
        }
        return map[tag] || null;
      }

      function getName(el) {
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel;
        var ariaLabelledBy = el.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
          var ref = document.getElementById(ariaLabelledBy);
          if (ref) return ref.textContent.trim().substring(0,80);
        }
        if (el.tagName === 'IMG') return el.alt || '';
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          var label = el.closest('label') || (el.id && document.querySelector('label[for=\"'+el.id+'\"]'));
          if (label) return label.textContent.trim().substring(0,80);
          if (el.placeholder) return el.placeholder;
          if (el.name) return el.name;
        }
        if (el.title) return el.title;
        // For links/buttons, use text content
        if (['A','BUTTON','LABEL','SUMMARY'].includes(el.tagName)) {
          return el.textContent.trim().substring(0,80);
        }
        return '';
      }

      function isInteractive(el) {
        var tag = el.tagName;
        if (['A','BUTTON','INPUT','TEXTAREA','SELECT','SUMMARY','DETAILS'].includes(tag)) return true;
        if (el.getAttribute('role')) return true;
        if (el.getAttribute('tabindex') !== null) return true;
        if (el.onclick || el.getAttribute('onclick')) return true;
        if (el.isContentEditable) return true;
        return false;
      }

      function isVisible(el) {
        if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }

      function walk(el, depth) {
        if (depth > 8) return;
        if (!isVisible(el)) return;

        var role = getRole(el);
        var interactive = isInteractive(el);
        var isHeading = /^H[1-6]$/.test(el.tagName);
        var isText = !role && el.children.length === 0 && el.textContent.trim().length > 0 && el.textContent.trim().length < 200;

        // Include: interactive elements, headings, images, text nodes with content
        if (role || interactive || isHeading || isText) {
          var ref = gen + '_' + (id++);
          el.setAttribute('data-mcp-ref', ref);
          var indent = '  '.repeat(depth);
          var line = indent + 'ref=' + ref + ' ';

          if (role) line += role;
          else if (isText) line += 'text';
          else line += el.tagName.toLowerCase();

          var name = getName(el);
          if (name) line += ' "' + name.replace(/"/g, "'") + '"';

          // Value for inputs
          if (el.value !== undefined && el.value !== '' && el.tagName !== 'BUTTON') {
            line += ' value="' + String(el.value).substring(0,50).replace(/"/g, "'") + '"';
          }
          // Checked state
          if (el.checked) line += ' checked';
          // Disabled
          if (el.disabled) line += ' disabled';
          // Required
          if (el.required) line += ' required';
          // Selected (option)
          if (el.selected) line += ' selected';
          // Expanded (details, aria-expanded)
          if (el.open !== undefined) line += el.open ? ' expanded' : ' collapsed';
          if (el.getAttribute('aria-expanded') === 'true') line += ' expanded';
          if (el.getAttribute('aria-expanded') === 'false') line += ' collapsed';
          // Heading level
          if (isHeading) line += ' level=' + el.tagName[1];
          // Focusable
          if (el.tabIndex >= 0) line += ' focusable';
          // Link href
          if (el.tagName === 'A' && el.href) line += ' href="' + el.href.substring(0,100) + '"';
          // Content editable
          if (el.isContentEditable && el.getAttribute('contenteditable') !== 'inherit') line += ' editable';

          lines.push(line);
        }

        // Recurse into children
        for (var i = 0; i < el.children.length; i++) {
          walk(el.children[i], depth + (role ? 1 : 0));
        }
      }

      var root = ${root};
      if (!root) return 'Element not found';
      walk(root, 0);
      return lines.join('\\n');
    })()`
  );

  return result;
}

// Click/fill/type by ref — resolves data-mcp-ref attribute
export function refSelector(ref) {
  return `[data-mcp-ref="${ref}"]`;
}

// ========== RUN SCRIPT (multi-step automation in one call) ==========

// Execute multiple safari.js operations in a single tool call
// Avoids round-trip overhead of calling tools one by one
// script is a JSON array of steps: [{action: "navigate", args: {url: "..."}}, {action: "click", args: {selector: "..."}}, ...]
export async function runScript({ steps }) {
  const results = [];
  for (const step of steps) {
    const { action, args = {} } = step;
    try {
      // Map action names to safari.js functions
      const actions = {
        navigate, click, doubleClick, rightClick, fill, clearField, typeText,
        pressKey, scroll, scrollTo, scrollToElement, readPage, getPageSource,
        screenshot, screenshotElement, evaluate, waitFor, waitForTime, hover,
        selectOption, fillForm, fillAndSubmit, navigateAndRead, clickAndWait,
        goBack, goForward, reload, newTab, closeTab, switchTab, listTabs,
        getLocalStorage, setLocalStorage, deleteLocalStorage,
        getSessionStorage, setSessionStorage, deleteSessionStorage,
        getCookies, setCookie, deleteCookies, getElementInfo, querySelectorAll,
        extractTables, extractMeta, extractImages, extractLinks,
        analyzePage, detectForms, getAccessibilityTree, getPerformanceMetrics,
      };
      const fn = actions[action];
      if (!fn) {
        results.push({ action, error: `Unknown action: ${action}` });
        continue;
      }
      const result = await fn(args);
      results.push({ action, result: typeof result === "string" ? result.substring(0, 2000) : result });
    } catch (err) {
      results.push({ action, error: err.message });
    }
  }
  return JSON.stringify(results);
}

// ========== ACCESSIBILITY SNAPSHOT ==========

export async function getAccessibilityTree({ selector, maxDepth = 5 }) {
  const sel = selector ? `'${selector.replace(/'/g, "\\'")}'` : "null";
  return runJS(
    `(function(){
      function buildTree(el, depth) {
        if (!el || depth > ${Number(maxDepth)}) return null;
        var role = el.getAttribute('role') || el.tagName.toLowerCase();
        var ariaLabel = el.getAttribute('aria-label') || '';
        var ariaDescribedBy = el.getAttribute('aria-describedby') || '';
        var ariaExpanded = el.getAttribute('aria-expanded');
        var ariaChecked = el.getAttribute('aria-checked');
        var ariaSelected = el.getAttribute('aria-selected');
        var ariaDisabled = el.getAttribute('aria-disabled');
        var ariaHidden = el.getAttribute('aria-hidden');
        var tabIndex = el.tabIndex;
        var text = '';
        if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
          text = el.childNodes[0].textContent.trim().substring(0, 100);
        }
        var node = { role: role };
        if (ariaLabel) node.name = ariaLabel;
        if (text) node.text = text;
        if (el.id) node.id = el.id;
        if (ariaExpanded !== null) node.expanded = ariaExpanded;
        if (ariaChecked !== null) node.checked = ariaChecked;
        if (ariaSelected !== null) node.selected = ariaSelected;
        if (ariaDisabled !== null) node.disabled = ariaDisabled;
        if (ariaHidden === 'true') node.hidden = true;
        if (tabIndex >= 0) node.focusable = true;
        if (el.tagName === 'A' && el.href) node.href = el.href;
        if (el.tagName === 'IMG') { node.alt = el.alt || '(missing)'; node.src = el.src; }
        if (['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) {
          node.type = el.type || el.tagName.toLowerCase();
          node.value = (el.value || '').substring(0, 100);
          if (el.required) node.required = true;
          if (el.placeholder) node.placeholder = el.placeholder;
        }
        var children = [];
        for (var i = 0; i < el.children.length; i++) {
          if (el.children[i].getAttribute('aria-hidden') === 'true') continue;
          var child = buildTree(el.children[i], depth + 1);
          if (child) children.push(child);
        }
        if (children.length > 0) node.children = children;
        return node;
      }
      var root = ${sel} ? document.querySelector(${sel}) : document.body;
      if (!root) return JSON.stringify({ error: 'Element not found' });
      return JSON.stringify(buildTree(root, 0));
    })()`,
    { timeout: 30000 }
  );
}

// ========== COOKIE CRUD ==========

export async function setCookie({ name, value, domain, path: cookiePath, expires, secure, sameSite, httpOnly }) {
  const safeName = name.replace(/'/g, "\\'");
  const safeValue = value.replace(/'/g, "\\'");
  let cookie = `${safeName}=${safeValue}`;
  if (cookiePath) cookie += `; path=${cookiePath}`;
  if (domain) cookie += `; domain=${domain}`;
  if (expires) cookie += `; expires=${expires}`;
  if (secure) cookie += '; secure';
  if (sameSite) cookie += `; samesite=${sameSite}`;
  return runJS(`document.cookie='${cookie.replace(/'/g, "\\'")}'; 'Cookie set: ${safeName}'`);
}

export async function deleteCookies({ name, all }) {
  if (all) {
    return runJS(
      `(function(){var cookies=document.cookie.split(';');var count=0;cookies.forEach(function(c){var name=c.split('=')[0].trim();document.cookie=name+'=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';count++;});return 'Deleted '+count+' cookies';})()`
    );
  }
  if (name) {
    const safeName = name.replace(/'/g, "\\'");
    return runJS(
      `document.cookie='${safeName}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'; 'Deleted cookie: ${safeName}'`
    );
  }
  throw new Error("deleteCookies requires name or all:true");
}

// ========== SESSION STORAGE ==========

export async function getSessionStorage({ key }) {
  if (key) {
    const safeKey = key.replace(/'/g, "\\'");
    return runJS(`sessionStorage.getItem('${safeKey}')`);
  }
  return runJS(
    "JSON.stringify(Object.fromEntries(Object.keys(sessionStorage).map(function(k){return[k,sessionStorage.getItem(k).substring(0,200)]})))"
  );
}

export async function setSessionStorage({ key, value }) {
  const safeKey = key.replace(/'/g, "\\'");
  const safeValue = value.replace(/'/g, "\\'");
  return runJS(`sessionStorage.setItem('${safeKey}','${safeValue}'); 'Set sessionStorage: ${safeKey}'`);
}

export async function setLocalStorage({ key, value }) {
  const safeKey = key.replace(/'/g, "\\'");
  const safeValue = value.replace(/'/g, "\\'");
  return runJS(`localStorage.setItem('${safeKey}','${safeValue}'); 'Set localStorage: ${safeKey}'`);
}

export async function deleteLocalStorage({ key }) {
  if (key) {
    const safeKey = key.replace(/'/g, "\\'");
    return runJS(`localStorage.removeItem('${safeKey}'); 'Deleted localStorage: ${safeKey}'`);
  }
  return runJS("var n=localStorage.length; localStorage.clear(); 'Cleared localStorage: '+n+' items'");
}

export async function deleteSessionStorage({ key }) {
  if (key) {
    const safeKey = key.replace(/'/g, "\\'");
    return runJS(`sessionStorage.removeItem('${safeKey}'); 'Deleted sessionStorage: ${safeKey}'`);
  }
  return runJS("var n=sessionStorage.length; sessionStorage.clear(); 'Cleared sessionStorage: '+n+' items'");
}

// Export all storage state (cookies + localStorage + sessionStorage) as JSON
export async function exportStorageState() {
  return runJS(
    `JSON.stringify({
      url: location.href,
      cookies: document.cookie,
      localStorage: Object.fromEntries(Object.keys(localStorage).map(function(k){return[k,localStorage.getItem(k)]})),
      sessionStorage: Object.fromEntries(Object.keys(sessionStorage).map(function(k){return[k,sessionStorage.getItem(k)]}))
    })`
  );
}

// Import storage state from JSON
export async function importStorageState({ state }) {
  const parsed = typeof state === "string" ? JSON.parse(state) : state;
  const cmds = [];
  if (parsed.cookies) cmds.push(`document.cookie='${parsed.cookies.replace(/'/g, "\\'")}'`);
  if (parsed.localStorage) {
    for (const [k, v] of Object.entries(parsed.localStorage)) {
      cmds.push(`localStorage.setItem('${k.replace(/'/g, "\\'")}','${String(v).replace(/'/g, "\\'")}')`);
    }
  }
  if (parsed.sessionStorage) {
    for (const [k, v] of Object.entries(parsed.sessionStorage)) {
      cmds.push(`sessionStorage.setItem('${k.replace(/'/g, "\\'")}','${String(v).replace(/'/g, "\\'")}')`);
    }
  }
  return runJS(cmds.join(";") + "; 'Imported ' + " + cmds.length + " + ' items'");
}

// ========== CLIPBOARD ==========

export async function clipboardRead() {
  try {
    const text = await execFileAsync("pbpaste", []);
    return text.stdout;
  } catch {
    return "(clipboard empty or contains non-text data)";
  }
}

export async function clipboardWrite({ text, restore = true }) {
  // Save current clipboard
  let oldClipboard = null;
  if (restore) {
    try {
      const { stdout } = await execFileAsync("pbpaste", []);
      oldClipboard = stdout;
    } catch {}
  }

  const safeText = text.replace(/"/g, '\\"');
  await execFileAsync("bash", ["-c", `echo -n "${safeText}" | pbcopy`]);

  // Schedule clipboard restore after 5 seconds (gives time to paste)
  if (restore && oldClipboard !== null) {
    setTimeout(async () => {
      try {
        const safeOld = oldClipboard.replace(/"/g, '\\"');
        await execFileAsync("bash", ["-c", `echo -n "${safeOld}" | pbcopy`]);
      } catch {}
    }, 5000);
  }

  return `Copied ${text.length} chars to clipboard${restore ? " (will restore in 5s)" : ""}`;
}

// ========== NETWORK MOCKING ==========

// Intercept fetch/XHR requests matching a URL pattern and return mock responses
export async function mockNetworkRoute({ urlPattern, response }) {
  const safePattern = urlPattern.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
  const safeBody = (response.body || "").replace(/'/g, "\\'").replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
  const status = response.status || 200;
  const contentType = response.contentType || "application/json";

  return runJS(
    `(function(){
      if (!window.__mcp_mocks) window.__mcp_mocks = [];
      window.__mcp_mocks.push({pattern: '${safePattern}', status: ${status}, body: '${safeBody}', contentType: '${contentType}'});

      // Patch fetch (once)
      if (!window.__mcp_fetch_patched) {
        window.__mcp_fetch_patched = true;
        var origFetch = window.fetch;
        window.fetch = function(url, opts) {
          var reqUrl = typeof url === 'string' ? url : url.url;
          var mock = window.__mcp_mocks.find(function(m) {
            return reqUrl.includes(m.pattern) || new RegExp(m.pattern).test(reqUrl);
          });
          if (mock) {
            return Promise.resolve(new Response(mock.body, {
              status: mock.status,
              headers: {'Content-Type': mock.contentType}
            }));
          }
          return origFetch.apply(this, arguments);
        };

        // Patch XHR
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__mcp_url = url;
          this.__mcp_method = method;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(body) {
          var mock = (window.__mcp_mocks || []).find(function(m) {
            return this.__mcp_url && (this.__mcp_url.includes(m.pattern) || new RegExp(m.pattern).test(this.__mcp_url));
          }.bind(this));
          if (mock) {
            Object.defineProperty(this, 'status', {get: function(){return mock.status;}});
            Object.defineProperty(this, 'responseText', {get: function(){return mock.body;}});
            Object.defineProperty(this, 'response', {get: function(){return mock.body;}});
            Object.defineProperty(this, 'readyState', {get: function(){return 4;}});
            this.dispatchEvent(new Event('readystatechange'));
            this.dispatchEvent(new Event('load'));
            return;
          }
          return origSend.apply(this, arguments);
        };
      }
      return 'Mock added: ' + '${safePattern}' + ' → ' + ${status} + ' (' + window.__mcp_mocks.length + ' total mocks)';
    })()`
  );
}

// Remove all network mocks
export async function clearNetworkMocks() {
  return runJS(
    "window.__mcp_mocks=[]; 'All network mocks cleared'"
  );
}

// ========== WAIT FOR TIME ==========

export async function waitForTime({ ms }) {
  await new Promise((r) => setTimeout(r, Number(ms)));
  return `Waited ${ms}ms`;
}

// ========== NETWORK CAPTURE (Detailed) ==========

export async function startNetworkCapture() {
  await runJS(
    `if(!window.__mcp_network){window.__mcp_network=[];
    var origFetch=window.fetch;
    window.fetch=function(){var url=arguments[0];var opts=arguments[1]||{};var start=Date.now();
      return origFetch.apply(this,arguments).then(function(resp){
        var entry={url:typeof url==='string'?url:url.url,method:opts.method||'GET',status:resp.status,statusText:resp.statusText,
          type:'fetch',duration:Date.now()-start,headers:Object.fromEntries([...resp.headers.entries()].slice(0,20)),time:new Date().toISOString()};
        window.__mcp_network.push(entry);return resp;
      }).catch(function(err){
        window.__mcp_network.push({url:typeof url==='string'?url:url.url,method:opts.method||'GET',error:err.message,type:'fetch',time:new Date().toISOString()});
        throw err;
      });
    };
    var origXHR=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url){
      this.__mcp_method=method;this.__mcp_url=url;this.__mcp_start=Date.now();
      this.addEventListener('load',function(){
        window.__mcp_network.push({url:this.__mcp_url,method:this.__mcp_method,status:this.status,statusText:this.statusText,
          type:'xhr',duration:Date.now()-this.__mcp_start,responseSize:this.responseText.length,time:new Date().toISOString()});
      });
      this.addEventListener('error',function(){
        window.__mcp_network.push({url:this.__mcp_url,method:this.__mcp_method,error:'Network error',type:'xhr',time:new Date().toISOString()});
      });
      return origXHR.apply(this,arguments);
    };}`
  );
  return "Network capture started (fetch + XHR interception)";
}

export async function clearNetworkCapture() {
  return runJS("window.__mcp_network=[]; 'Network capture cleared'");
}

export async function getNetworkDetails({ limit = 50, filter } = {}) {
  const filterStr = filter ? `.filter(function(r){return r.url.includes('${filter.replace(/'/g, "\\'")}')})` : "";
  return runJS(
    `JSON.stringify((window.__mcp_network||[])${filterStr}.slice(-${Number(limit)}))`
  );
}

// ========== PERFORMANCE METRICS ==========

export async function getPerformanceMetrics() {
  return runJS(
    `(function(){
      var nav = performance.getEntriesByType('navigation')[0] || {};
      var paint = performance.getEntriesByType('paint');
      var fcp = paint.find(function(p){return p.name==='first-contentful-paint'});
      var lcp = null;
      try {
        var entries = performance.getEntriesByType('largest-contentful-paint');
        if (entries.length) lcp = entries[entries.length - 1];
      } catch(e) {}
      var cls = 0;
      try {
        var entries = performance.getEntriesByType('layout-shift');
        entries.forEach(function(e){ if (!e.hadRecentInput) cls += e.value; });
      } catch(e) {}
      var resources = performance.getEntriesByType('resource');
      var totalTransfer = resources.reduce(function(sum, r){ return sum + (r.transferSize || 0); }, 0);
      return JSON.stringify({
        navigation: {
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          tcp: Math.round(nav.connectEnd - nav.connectStart),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          download: Math.round(nav.responseEnd - nav.responseStart),
          domInteractive: Math.round(nav.domInteractive),
          domComplete: Math.round(nav.domComplete),
          loadEvent: Math.round(nav.loadEventEnd),
        },
        webVitals: {
          fcp: fcp ? Math.round(fcp.startTime) : null,
          lcp: lcp ? Math.round(lcp.startTime) : null,
          cls: Math.round(cls * 1000) / 1000,
        },
        resources: {
          total: resources.length,
          totalTransferKB: Math.round(totalTransfer / 1024),
          byType: resources.reduce(function(acc, r) {
            var type = r.initiatorType || 'other';
            if (!acc[type]) acc[type] = { count: 0, sizeKB: 0 };
            acc[type].count++;
            acc[type].sizeKB += Math.round((r.transferSize || 0) / 1024);
            return acc;
          }, {}),
        },
        memory: window.performance.memory ? {
          usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
          totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
          limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
        } : null,
      });
    })()`
  );
}

// ========== NETWORK THROTTLING ==========

export async function throttleNetwork({ profile, latency, downloadKbps, uploadKbps }) {
  const profiles = {
    "slow-3g": { latency: 2000, download: 50, upload: 50 },
    "fast-3g": { latency: 560, download: 150, upload: 75 },
    "4g": { latency: 170, download: 400, upload: 150 },
    offline: { latency: 0, download: 0, upload: 0 },
  };
  const p = profile ? profiles[profile.toLowerCase()] : null;
  const lat = p ? p.latency : (latency || 0);
  const dl = p ? p.download : (downloadKbps || 0);

  if (profile === "offline") {
    await runJS(
      `window.__mcp_throttle={active:true,profile:'offline'};
      var origFetch=window.__mcp_origFetch||window.fetch;
      window.__mcp_origFetch=origFetch;
      window.fetch=function(){return Promise.reject(new TypeError('Network request failed (simulated offline)'));};`
    );
    return "Network throttled: offline";
  }

  if (lat > 0) {
    await runJS(
      `window.__mcp_throttle={active:true,profile:'${profile || "custom"}',latency:${lat},downloadKbps:${dl}};
      var origFetch=window.__mcp_origFetch||window.fetch;
      window.__mcp_origFetch=origFetch;
      window.fetch=function(){var args=arguments;return new Promise(function(resolve){
        setTimeout(function(){resolve(origFetch.apply(window,args));},${lat});
      });};`
    );
    return JSON.stringify({ profile: profile || "custom", latency: lat, downloadKbps: dl });
  }

  // Reset
  await runJS(
    `if(window.__mcp_origFetch){window.fetch=window.__mcp_origFetch;delete window.__mcp_origFetch;}
    delete window.__mcp_throttle; 'Throttle removed'`
  );
  return "Network throttle removed";
}

// ========== CONSOLE FILTER ==========

export async function getConsoleByLevel({ level }) {
  const safeLevel = level.replace(/'/g, "\\'");
  return runJS(
    `JSON.stringify((window.__mcp_console||[]).filter(function(m){return m.level==='${safeLevel}'}))`
  );
}

// ========== DATA EXTRACTION ==========

export async function extractTables({ selector, limit = 10 }) {
  const sel = selector ? `'${selector.replace(/'/g, "\\'")}'` : "'table'";
  return runJS(
    `(function(){
      var tables = [...document.querySelectorAll(${sel})].slice(0, ${Number(limit)});
      return JSON.stringify(tables.map(function(table, ti) {
        var headers = [...table.querySelectorAll('thead th, thead td, tr:first-child th')].map(function(th){ return th.textContent.trim(); });
        var rows = [...table.querySelectorAll('tbody tr, tr')].slice(headers.length ? 0 : 1).map(function(tr) {
          return [...tr.querySelectorAll('td, th')].map(function(td){ return td.textContent.trim().substring(0, 200); });
        });
        return { index: ti, headers: headers, rows: rows.slice(0, 100), rowCount: rows.length };
      }));
    })()`
  );
}

export async function extractMeta() {
  return runJS(
    `(function(){
      var meta = {};
      meta.title = document.title;
      meta.description = (document.querySelector('meta[name="description"]') || {}).content || '';
      meta.canonical = (document.querySelector('link[rel="canonical"]') || {}).href || '';
      meta.robots = (document.querySelector('meta[name="robots"]') || {}).content || '';
      meta.viewport = (document.querySelector('meta[name="viewport"]') || {}).content || '';
      meta.charset = (document.querySelector('meta[charset]') || {}).getAttribute('charset') || document.characterSet;
      meta.language = document.documentElement.lang || '';
      meta.og = {};
      document.querySelectorAll('meta[property^="og:"]').forEach(function(m) {
        meta.og[m.getAttribute('property').replace('og:','')] = m.content;
      });
      meta.twitter = {};
      document.querySelectorAll('meta[name^="twitter:"]').forEach(function(m) {
        meta.twitter[m.getAttribute('name').replace('twitter:','')] = m.content;
      });
      meta.jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map(function(s) {
        try { return JSON.parse(s.textContent); } catch(e) { return null; }
      }).filter(Boolean);
      meta.alternateLanguages = [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map(function(l) {
        return { lang: l.hreflang, href: l.href };
      });
      meta.feeds = [...document.querySelectorAll('link[type="application/rss+xml"], link[type="application/atom+xml"]')].map(function(l) {
        return { title: l.title, href: l.href, type: l.type };
      });
      return JSON.stringify(meta);
    })()`
  );
}

export async function extractImages({ limit = 50 }) {
  return runJS(
    `JSON.stringify([...document.querySelectorAll('img')].slice(0,${Number(limit)}).map(function(img){
      var r = img.getBoundingClientRect();
      return {
        src: img.src, alt: img.alt || '(missing)', width: img.naturalWidth, height: img.naturalHeight,
        displayWidth: Math.round(r.width), displayHeight: Math.round(r.height),
        loading: img.loading || 'eager', srcset: img.srcset || '',
        inViewport: r.top < window.innerHeight && r.bottom > 0,
        decoded: img.complete,
      };
    }))`
  );
}

export async function extractLinks({ limit = 100, filter }) {
  const filterStr = filter
    ? `.filter(function(a){return a.href.includes('${filter.replace(/'/g, "\\'")}')||a.textContent.includes('${filter.replace(/'/g, "\\'")}')})`
    : "";
  return runJS(
    `JSON.stringify([...document.querySelectorAll('a[href]')]${filterStr}.slice(0,${Number(limit)}).map(function(a){
      return {
        href: a.href, text: a.textContent.trim().substring(0,100),
        rel: a.rel || '', target: a.target || '',
        isExternal: a.hostname !== location.hostname,
        isNofollow: a.rel.includes('nofollow'),
      };
    }))`
  );
}

// ========== GEOLOCATION OVERRIDE ==========

export async function overrideGeolocation({ latitude, longitude, accuracy = 100 }) {
  return runJS(
    `navigator.geolocation.getCurrentPosition = function(success) {
      success({ coords: { latitude: ${Number(latitude)}, longitude: ${Number(longitude)}, accuracy: ${Number(accuracy)}, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
    };
    navigator.geolocation.watchPosition = function(success) {
      success({ coords: { latitude: ${Number(latitude)}, longitude: ${Number(longitude)}, accuracy: ${Number(accuracy)}, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
      return 1;
    };
    'Geolocation set to: ${Number(latitude)}, ${Number(longitude)}'`
  );
}

// ========== COMPUTED STYLES ==========

export async function getComputedStyles({ selector, properties }) {
  const sel = selector.replace(/'/g, "\\'");
  const propsFilter = properties
    ? `.filter(function(p){return [${properties.map((p) => `'${p}'`).join(",")}].includes(p)})`
    : "";
  return runJS(
    `(function(){
      var el = document.querySelector('${sel}');
      if (!el) return JSON.stringify({ error: 'Element not found' });
      var styles = window.getComputedStyle(el);
      var result = {};
      var props = [...styles]${propsFilter};
      props.forEach(function(p) { result[p] = styles.getPropertyValue(p); });
      return JSON.stringify(result);
    })()`
  );
}

// ========== INDEXEDDB ==========

export async function getIndexedDB({ dbName, storeName, limit = 20 }) {
  const safeDb = dbName.replace(/'/g, "\\'");
  const safeStore = storeName.replace(/'/g, "\\'");
  return runJS(
    `(async function(){
      return new Promise(function(resolve, reject) {
        var request = indexedDB.open('${safeDb}');
        request.onerror = function() { resolve(JSON.stringify({ error: 'Cannot open database: ${safeDb}' })); };
        request.onsuccess = function(e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('${safeStore}')) {
            resolve(JSON.stringify({ error: 'Store not found: ${safeStore}', stores: [...db.objectStoreNames] }));
            db.close(); return;
          }
          var tx = db.transaction('${safeStore}', 'readonly');
          var store = tx.objectStore('${safeStore}');
          var results = [];
          var cursor = store.openCursor();
          cursor.onsuccess = function(e) {
            var c = e.target.result;
            if (c && results.length < ${Number(limit)}) { results.push({ key: c.key, value: c.value }); c.continue(); }
            else { resolve(JSON.stringify({ database: '${safeDb}', store: '${safeStore}', count: results.length, records: results })); db.close(); }
          };
          cursor.onerror = function() { resolve(JSON.stringify({ error: 'Cursor error' })); db.close(); };
        };
      });
    })()`,
    { timeout: 15000 }
  );
}

export async function listIndexedDBs() {
  return runJS(
    `(async function(){
      try {
        var dbs = await indexedDB.databases();
        return JSON.stringify(dbs.map(function(db){ return { name: db.name, version: db.version }; }));
      } catch(e) {
        return JSON.stringify({ error: 'indexedDB.databases() not supported, try getIndexedDB with a known db name' });
      }
    })()`
  );
}

// ========== CSS COVERAGE ==========

export async function getCSSCoverage() {
  return runJS(
    `(function(){
      var results = [];
      for (var i = 0; i < document.styleSheets.length; i++) {
        try {
          var sheet = document.styleSheets[i];
          var rules = sheet.cssRules || sheet.rules;
          var total = rules.length;
          var used = 0;
          var unused = [];
          for (var j = 0; j < rules.length; j++) {
            var rule = rules[j];
            if (rule.selectorText) {
              try {
                if (document.querySelector(rule.selectorText)) { used++; }
                else { unused.push(rule.selectorText); }
              } catch(e) { used++; }
            } else { used++; }
          }
          results.push({
            href: sheet.href || '(inline)',
            totalRules: total,
            usedRules: used,
            unusedRules: total - used,
            coveragePercent: total > 0 ? Math.round(used / total * 100) : 100,
            unusedSelectors: unused.slice(0, 20),
          });
        } catch(e) {
          results.push({ href: sheet.href || '(inline)', error: 'CORS blocked' });
        }
      }
      return JSON.stringify(results);
    })()`
  );
}

// ========== FORM AUTO-DETECT ==========

export async function detectForms() {
  return runJS(
    `(function(){
      var forms = [...document.querySelectorAll('form')];
      if (forms.length === 0) {
        var inputs = document.querySelectorAll('input, textarea, select');
        if (inputs.length > 0) {
          return JSON.stringify([{
            index: 0, action: '(no form tag)', method: '', fields: [...inputs].slice(0, 30).map(function(el) {
              return { tag: el.tagName, type: el.type || '', name: el.name || '', id: el.id || '',
                placeholder: el.placeholder || '', required: el.required, value: (el.value || '').substring(0, 50),
                selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName.toLowerCase() + '[type="' + el.type + '"]') };
            })
          }]);
        }
        return JSON.stringify([]);
      }
      return JSON.stringify(forms.map(function(form, i) {
        var fields = [...form.querySelectorAll('input, textarea, select')].map(function(el) {
          return { tag: el.tagName, type: el.type || '', name: el.name || '', id: el.id || '',
            placeholder: el.placeholder || '', required: el.required, value: (el.value || '').substring(0, 50),
            selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName.toLowerCase()) };
        });
        return { index: i, action: form.action || '', method: form.method || 'GET', id: form.id || '',
          fieldCount: fields.length, fields: fields.slice(0, 30),
          hasSubmit: !!form.querySelector('[type="submit"], button:not([type])') };
      }));
    })()`
  );
}

// ========== SCROLL TO ELEMENT ==========

export async function scrollToElement({ selector, block = "center" }) {
  const sel = selector.replace(/'/g, "\\'");
  return runJS(
    `(function(){var el=document.querySelector('${sel}');if(!el)return 'Element not found: ${sel}';el.scrollIntoView({behavior:'smooth',block:'${block}'});var r=el.getBoundingClientRect();return 'Scrolled to: '+el.tagName+' at y='+Math.round(r.y);})()`
  );
}

// ========== COMBO TOOLS (multi-step operations in a single call) ==========

// Navigate + wait + read — the most common 3-step workflow
export async function navigateAndRead(url, { maxLength = 50000 } = {}) {
  let targetUrl = url;
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = "https://" + targetUrl;
  const safeUrl = targetUrl.replace(/"/g, '\\"');
  const navTarget = _activeTabIndex ? `tab ${_activeTabIndex} of front window` : "front document";
  await osascriptFast(`tell application "Safari" to set URL of ${navTarget} to "${safeUrl}"`);
  // Single JS call: poll readyState + return page data — 1 call instead of 30+
  return runJS(
    `(async function(){
      for(var i=0;i<60;i++){
        if(document.readyState==='complete')break;
        await new Promise(function(r){setTimeout(r,i<10?200:500)});
      }
      return JSON.stringify({title:document.title,url:location.href,text:document.body.innerText.substring(0,${Number(maxLength)})});
    })()`,
    { timeout: 30000 }
  );
}

// Click + wait for navigation or element — common after clicking a link/button
export async function clickAndWait({ selector, text, waitFor: waitSelector, timeout = 10000 }) {
  const safeSel = selector ? selector.replace(/'/g, "\\'") : "";
  const safeText = text ? text.replace(/'/g, "\\'") : "";
  const safeWait = waitSelector ? waitSelector.replace(/'/g, "\\'") : "";
  // Single JS call: click + wait — 1 call instead of 20+
  return runJS(
    `(async function(){
      // Find and click
      var el;
      ${safeSel ? `el = document.querySelector('${safeSel}');` : ""}
      ${safeText && !safeSel ? `
        el = [...document.querySelectorAll('a,button,[role=button],label,[onclick]')].find(function(e){return e.textContent.trim().includes('${safeText}');});
        if(!el) el = [...document.querySelectorAll('*')].filter(function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.textContent.trim().includes('${safeText}');}).sort(function(a,b){return a.textContent.length-b.textContent.length;})[0];
      ` : ""}
      if(!el) return JSON.stringify({error:'Element not found'});
      el.scrollIntoView({block:'center'});
      el.click();
      // Wait
      var deadline = Date.now() + ${Number(timeout)};
      ${safeWait ? `
        while(Date.now()<deadline){
          if(document.querySelector('${safeWait}'))break;
          await new Promise(function(r){setTimeout(r,200)});
        }
      ` : `
        await new Promise(function(r){setTimeout(r,300)});
        while(Date.now()<deadline){
          if(document.readyState==='complete')break;
          await new Promise(function(r){setTimeout(r,200)});
        }
      `}
      return JSON.stringify({title:document.title,url:location.href,clicked:el.tagName+' "'+el.textContent.trim().substring(0,50)+'"'});
    })()`,
    { timeout: timeout + 5000 }
  );
}

// Fill form + submit — common for login, search, etc.
export async function fillAndSubmit({ fields, submitSelector }) {
  await fillForm({ fields });
  if (submitSelector) {
    const sel = submitSelector.replace(/'/g, "\\'");
    await runJS(
      `(function(){var el=document.querySelector('${sel}');if(el)el.click();})()`
    );
  } else {
    // Auto-find and click submit button
    await runJS(
      `(function(){var btn=document.querySelector('[type=submit],button:not([type])');if(btn)btn.click();})()`
    );
  }
  // Wait for navigation/reload via inline JS (not fixed sleep)
  return runJS(
    `(async function(){
      await new Promise(function(r){setTimeout(r,300)});
      for(var i=0;i<30;i++){if(document.readyState==='complete')break;await new Promise(function(r){setTimeout(r,200)});}
      return JSON.stringify({title:document.title,url:location.href});
    })()`,
    { timeout: 15000 }
  );
}

// Full page analysis — extracts everything in ONE call
export async function analyzePage() {
  return runJS(
    `(function(){
      var result = {};
      result.title = document.title;
      result.url = location.href;
      result.meta = {};
      result.meta.description = (document.querySelector('meta[name="description"]')||{}).content||'';
      result.meta.canonical = (document.querySelector('link[rel="canonical"]')||{}).href||'';
      result.meta.robots = (document.querySelector('meta[name="robots"]')||{}).content||'';
      result.meta.og = {};
      document.querySelectorAll('meta[property^="og:"]').forEach(function(m){result.meta.og[m.getAttribute('property').replace('og:','')]=m.content;});
      result.headings = {};
      for(var i=1;i<=3;i++){result.headings['h'+i]=[...document.querySelectorAll('h'+i)].map(function(h){return h.textContent.trim().substring(0,100);});}
      result.links = {internal:0,external:0,nofollow:0};
      document.querySelectorAll('a[href]').forEach(function(a){
        if(a.hostname===location.hostname)result.links.internal++;
        else result.links.external++;
        if(a.rel&&a.rel.includes('nofollow'))result.links.nofollow++;
      });
      result.images = {total:document.querySelectorAll('img').length,withoutAlt:[...document.querySelectorAll('img:not([alt]),img[alt=""]')].length};
      result.forms = document.querySelectorAll('form').length;
      result.text = document.body.innerText.substring(0,5000);
      return JSON.stringify(result);
    })()`
  );
}
