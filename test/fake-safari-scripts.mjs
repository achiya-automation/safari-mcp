/**
 * How Safari runs the AppleScripts that prove a tab by the session's marker: safari.js's marker
 * scan (_scanForMarker), its one-script close (closeTabByMarker), and the script each step of a
 * load runs in the tab it proved (_inTab), which proves the tab again by its marker, follows it by
 * the marker, or, with no marker in the window, by the window's fingerprint. The test fakes answer
 * them here instead of each pattern-matching the marker out of the script: a script is answered
 * only in the exact form safari.js writes it, and the marker check it embeds runs against each tab's
 * page, so a change to the check, to the loop, to the last-tab guard or to what the script returns
 * reaches the tests instead of being answered the way the fake assumes.
 *
 * `tabs` is the addressed window's tabs (tab i is tabs[i - 1]), `windowId` its id, and
 * `pageOf(tab)` the page `window` the check reads (`name`, `__mcpTabMarker`).
 */
import vm from "node:vm";

const unescape = (js) => js.replace(/\\(["\\])/g, "$1");
const lines = (script) => script.split("\n").map((l) => l.trim()).filter(Boolean);

// The marker check a scan or close runs in `tab`, as the page runs it. A check that throws in the
// page answers nothing, which the script's `try` reads as "not this tab".
function check(js, tab, pageOf) {
  try {
    return String(vm.runInNewContext(js, { window: pageOf(tab) }));
  } catch {
    return "";
  }
}

// The scan: { ref, hint, check } when `script` is safari.js's marker scan, else null.
function parseScan(script) {
  const l = lines(script);
  const hinted = l.length === 16;
  const expected = [
    'tell application "Safari"',
    /^set w to (front window|window id \d+)$/,
    "set wid to (id of w) as text",
    "set n to count of tabs of w",
    ...(hinted
      ? [
          "try",
          /^if n is greater than or equal to (\d+) then$/,
          /^if \(do JavaScript "(.*)" in tab (\d+) of w\) is "1" then return wid & ":(\d+)"$/,
          "end if",
          "end try",
        ]
      : []),
    "repeat with i from n to 1 by -1",
    "try",
    /^if \(do JavaScript "(.*)" in tab i of w\) is "1" then return wid & ":" & i$/,
    "end try",
    "end repeat",
    'return wid & ":0"',
    "end tell",
  ];
  if (l.length !== expected.length) return null;
  const got = [];
  for (let k = 0; k < l.length; k++) {
    const want = expected[k];
    if (typeof want === "string") {
      if (l[k] !== want) return null;
    } else {
      const m = want.exec(l[k]);
      if (!m) return null;
      got.push(...m.slice(1));
    }
  }
  if (hinted) {
    const [ref, h1, hintJs, h2, h3, loopJs] = got;
    if (h1 !== h2 || h2 !== h3 || hintJs !== loopJs) return null;
    return { ref, hint: Number(h1), check: unescape(loopJs) };
  }
  const [ref, loopJs] = got;
  return { ref, hint: 0, check: unescape(loopJs) };
}

// The one-script close: { ref, check } when `script` is closeTabByMarker's, else null.
function parseClose(script) {
  const l = lines(script);
  const expected = [
    'tell application "Safari"',
    /^set w to (front window|window id \d+)$/,
    "set n to count of tabs of w",
    "repeat with i from n to 1 by -1",
    "set hit to false",
    "try",
    /^set hit to \(\(do JavaScript "(.*)" in tab i of w\) is "1"\)$/,
    "end try",
    "if hit then",
    "if n is 1 then",
    'set URL of tab i of w to "about:blank"',
    'return "blanked"',
    "end if",
    "close tab i of w",
    'return "closed"',
    "end if",
    "end repeat",
    'return ""',
    "end tell",
  ];
  if (l.length !== expected.length) return null;
  const got = [];
  for (let k = 0; k < l.length; k++) {
    const want = expected[k];
    if (typeof want === "string") {
      if (l[k] !== want) return null;
    } else {
      const m = want.exec(l[k]);
      if (!m) return null;
      got.push(...m.slice(1));
    }
  }
  return { ref: got[0], check: unescape(got[1]) };
}

// The window a scan, a close or a tab script addresses: `window id N`, or 'front window'.
export function scriptWindowRef(script) {
  return (parseScan(script) || parseClose(script) || parseTabScript(script))?.ref ?? null;
}

// Whether `script` is the marker scan or the one-script close. Anything else that embeds a
// marker check in their place is neither, and the fakes refuse to answer it.
export const isMarkerScan = (script) => !!parseScan(script);
export const isCloseByMarker = (script) => !!parseClose(script);

// Run the marker scan: the hinted tab first, then right to left, answering "<window id>:<index>"
// as the script's return statements do ("<window id>:0" when no tab carries the marker).
export function answerMarkerScan(script, { windowId, tabs, pageOf }) {
  const scan = parseScan(script);
  if (!scan) throw new Error(`the fake Safari does not answer this marker scan:\n${script}`);
  const n = tabs.length;
  if (scan.hint && n >= scan.hint && check(scan.check, tabs[scan.hint - 1], pageOf) === "1") return `${windowId}:${scan.hint}`;
  for (let i = n; i >= 1; i--) if (check(scan.check, tabs[i - 1], pageOf) === "1") return `${windowId}:${i}`;
  return `${windowId}:0`;
}

// Run the one-script close: right to left, the first tab whose check answers "1" is closed, or
// blanked when it is the window's only tab. `close(i)` and `blank(i)` apply it to the fake.
export function answerCloseByMarker(script, { tabs, pageOf, close, blank }) {
  const c = parseClose(script);
  if (!c) throw new Error(`the fake Safari does not answer this close:\n${script}`);
  const n = tabs.length;
  for (let i = n; i >= 1; i--) {
    if (check(c.check, tabs[i - 1], pageOf) !== "1") continue;
    if (n === 1) {
      blank(i);
      return "blanked";
    }
    close(i);
    return "closed";
  }
  return "";
}

// safari.js's fingerprint handler, which each _inTab() script and newTab()'s creation script start
// with: the window's id and tab count, whether tab i is its window's selected tab, and the URLs of
// the up to three tabs before it.
export const FINGERPRINT_HANDLER = [
  "on mcpFp(w, i)",
  'tell application "Safari"',
  "set n to count of tabs of w",
  'if i > n then return ""',
  'set fp to ((id of w) as text) & "|" & (n as text) & "|" & ((visible of tab i of w) as text)',
  "repeat with j from i - 3 to i - 1",
  "if j > 0 then",
  "set u to URL of tab j of w",
  'if u is missing value then set u to ""',
  "if (length of u) > 200 then set u to text 1 thru 200 of u",
  'set fp to fp & "|" & u',
  "end if",
  "end repeat",
  "return fp",
  "end tell",
  "end mcpFp",
];

// What the handler answers for tab `i` of window `windowId`'s `tabs`: `urlOf(tab)` is a tab's URL
// (null for missing value), `visibleOf(tab)` whether it is its window's selected tab.
export function fingerprint(tabs, i, { windowId, urlOf, visibleOf }) {
  if (i > tabs.length) return "";
  let fp = `${windowId}|${tabs.length}|${visibleOf(tabs[i - 1]) ? "true" : "false"}`;
  for (let j = i - 3; j <= i - 1; j++) {
    if (j <= 0) continue;
    let u = urlOf(tabs[j - 1]) ?? "";
    if (u.length > 200) u = u.slice(0, 200);
    fp += `|${u}`;
  }
  return fp;
}

// The lines `l` against `expected` (exact strings, or regexps whose groups are collected), or null.
function matchLines(l, expected) {
  if (l.length !== expected.length) return null;
  const got = [];
  for (let k = 0; k < l.length; k++) {
    const want = expected[k];
    if (typeof want === "string") {
      if (l[k] !== want) return null;
    } else {
      const m = want.exec(l[k]);
      if (!m) return null;
      got.push(...m.slice(1));
    }
  }
  return got;
}

// The script _inTab() runs: { ref, idx, byMarker, check, positional: { baseline, js } | null,
// url } when `script` is one, else null. `byMarker` is the page script it runs where the marker
// proves the tab, `positional` the one it runs at tab idx when the fingerprint does, and `url` what
// it loads into the proven tab (null when it loads nothing).
function parseTabScript(script) {
  const l = lines(script);
  const handler = l.slice(0, FINGERPRINT_HANDLER.length);
  if (handler.length !== FINGERPRINT_HANDLER.length || handler.some((x, k) => x !== FINGERPRINT_HANDLER[k])) return null;
  const body = l.slice(FINGERPRINT_HANDLER.length);
  const positional = body.includes("considering case");
  const loads = body.some((x) => x.startsWith("set URL of tab k of w to "));
  const got = matchLines(body, [
    'tell application "Safari"',
    /^set w to (window id \d+)$/,
    /^set k to (\d+)$/,
    "set r to missing value",
    "if k is less than or equal to (count of tabs of w) then",
    "try",
    /^with timeout of [1-9]\d* seconds$/,
    /^set r to \(do JavaScript "(.*)" in tab k of w\) as text$/,
    "end timeout",
    "on error errMsg number errNum",
    "if errNum is -1712 then error errMsg number errNum",
    "end try",
    "end if",
    'if r does not start with "MCP_OK:" then',
    "set k to 0",
    "set skipped to false",
    "repeat with i from (count of tabs of w) to 1 by -1",
    "try",
    "with timeout of 1 second",
    /^if \(do JavaScript "(.*)" in tab i of w\) is "1" then$/,
    "set k to i",
    "exit repeat",
    "end if",
    "end timeout",
    "on error number errNum",
    /^if errNum is -1712 and i > (\d+) then set skipped to true$/,
    "end try",
    "end repeat",
    "if k > 0 then",
    /^set r to do JavaScript "(.*)" in tab k of w$/,
    ...(positional
      ? [
          "else if not skipped then",
          /^set k to (\d+)$/,
          "considering case",
          /^if my mcpFp\(w, (\d+)\) is "(.*)" then set r to do JavaScript "(.*)" in tab (\d+) of w$/,
          "end considering",
        ]
      : []),
    "end if",
    'if r does not start with "MCP_OK:" then',
    'if skipped then return "MCP_TAB_BUSY"',
    'return "MCP_TAB_UNPROVEN"',
    "end if",
    "end if",
    ...(loads ? [/^set URL of tab k of w to "(.*)"$/] : []),
    "return (k as text) & linefeed & (my mcpFp(w, k)) & linefeed & r",
    "end tell",
  ]);
  if (!got) return null;
  const [ref, idx, byMarker, check, right, byMarkerAgain, ...rest] = got;
  if (byMarkerAgain !== byMarker || right !== idx) return null;
  let pos = null;
  if (positional) {
    const [k2, k3, baseline, js, k4] = rest.splice(0, 5);
    if (k2 !== idx || k3 !== idx || k4 !== idx) return null;
    pos = { baseline: unescape(baseline), js: unescape(js) };
  }
  return {
    ref, idx: Number(idx), byMarker: unescape(byMarker), check: unescape(check), positional: pos,
    url: loads ? unescape(rest.shift()) : null,
  };
}

export const isTabScript = (script) => !!parseTabScript(script);

// Run _inTab()'s script as Safari runs it, over the `tabs` of window `windowId`. `run(tab, js)` runs
// page JavaScript in a tab and answers its value as text, or null where no page script runs (Safari
// answers missing value, which the first `do JavaScript`'s `as text` reads as "missing value");
// `setURL(tab, url)` loads a URL into a tab. A tab marked `hung` answers no script: the first
// `do JavaScript` times out there and the script ends with that error; the search's bounded check
// times out and moves on, and one to the right of the tab's index keeps the fingerprint from
// deciding (the script answers MCP_TAB_BUSY). The search runs the embedded check against
// `pageOf(tab)`, as the scan does. The fingerprint comparison is exact: the script compares it
// considering case.
export function answerTabScript(script, { windowId, tabs, pageOf, run, setURL, urlOf, visibleOf }) {
  const s = parseTabScript(script);
  if (!s) throw new Error(`the fake Safari does not answer this tab script:\n${script}`);
  const ok = (r) => typeof r === "string" && r.startsWith("MCP_OK:");
  const fp = (i) => fingerprint(tabs, i, { windowId, urlOf, visibleOf });
  let k = s.idx;
  let r = null;
  if (k <= tabs.length) {
    if (tabs[k - 1].hung) throw new Error("Safari got an error: AppleEvent timed out. (-1712)");
    try {
      const v = run(tabs[k - 1], s.byMarker);
      r = v === null ? "missing value" : String(v);
    } catch {
      // the `try` around it: r stays missing value
    }
  }
  if (!ok(r)) {
    k = 0;
    let skipped = false;
    for (let i = tabs.length; i >= 1; i--) {
      if (tabs[i - 1].hung) {
        if (i > s.idx) skipped = true;
        continue;
      }
      if (check(s.check, tabs[i - 1], pageOf) === "1") {
        k = i;
        break;
      }
    }
    if (k > 0) {
      r = run(tabs[k - 1], s.byMarker);
    } else if (s.positional && !skipped) {
      k = s.idx;
      if (fp(s.idx) === s.positional.baseline) r = run(tabs[s.idx - 1], s.positional.js);
    }
    if (!ok(r)) return skipped ? "MCP_TAB_BUSY" : "MCP_TAB_UNPROVEN";
  }
  if (s.url !== null) setURL(tabs[k - 1], s.url);
  return `${k}\n${fp(k)}\n${r}`;
}

// newTab()'s creation script: the fingerprint handler first, and at its end, once the tab is made,
// the report of where it is, read inside a try (Safari failing there reports "", and nothing is
// stamped then), the marker stamp on the tab, bounded, and the report. `tab` is the tab the script
// made, in `tabs`, the tabs of window `windowId`; `run(tab, js)` runs the stamp in it. Answered only in
// exactly this form.
export function answerCreationScript(script, { windowId, tabs, tab, run, urlOf, visibleOf, fails = false }) {
  const l = lines(script);
  const tail = l.slice(-12);
  const stamp = /^do JavaScript "(.*)" in t$/.exec(tail[7] || "");
  const shaped = FINGERPRINT_HANDLER.every((x, k) => l[k] === x) && stamp && matchLines(tail, [
    "try",
    'set rep to ((id of w) as text) & ":" & ((index of t) as text) & linefeed & (my mcpFp(w, index of t))',
    "on error",
    'return ""',
    "end try",
    "try",
    "with timeout of 2 seconds",
    /^do JavaScript "(.*)" in t$/,
    "end timeout",
    "end try",
    "return rep",
    "end tell",
  ]);
  if (!shaped) throw new Error(`the fake Safari does not answer this creation script:\n${script}`);
  if (fails) return "";
  const i = tabs.indexOf(tab) + 1;
  const report = `${windowId}:${i}\n${fingerprint(tabs, i, { windowId, urlOf, visibleOf })}`;
  run(tab, unescape(stamp[1]));
  return report;
}
