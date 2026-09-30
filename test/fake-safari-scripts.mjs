/**
 * How Safari runs the two AppleScripts that prove a tab by the session's marker: safari.js's
 * marker scan (_scanForMarker) and its one-script close (closeTabByMarker). The test fakes answer
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

// The window a scan or close addresses: `window id N`, or 'front window'.
export function scriptWindowRef(script) {
  return (parseScan(script) || parseClose(script))?.ref ?? null;
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
