#!/usr/bin/env node
/**
 * safari_wait_for_new_tab keeps a new tab it saw but could not claim yet (still on about:blank,
 * not matching urlContains, refused) out of the baseline while the window's other tabs change,
 * and finds it again in the next listing by its URL alone: AppleScript gives tabs no id. If that
 * ever picks a tab that was there before the wait, the tab is later claimed with the session's own
 * marker, and every close path would close it.
 *
 * This runs index.js's own intact() and stillNew() over every window of 2 to 5 tabs (the session's
 * tab, tabs of the user's on two pages, one or two pending new tabs) and every listing one or two
 * changes away (a tab closes, navigates to any of the pages, opens anywhere, or is dragged), and
 * checks that a listing the handler would take as a new baseline never carries a tab that was
 * already there as a pending one. A tab that opened in that listing may be carried: it is new.
 *
 * Found on 30.9.26 by the reviews of the carry-over: a tab of the user's that joined a pending tab
 * on its URL, landed on it as the pending tab closed, or had a twin that stood in for it.
 *
 * Run:  node --test test/wait-new-tab-carry.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not extract ${start}`);
  return source.slice(from, to);
}

const { intact, stillNew } = new Function(
  "urlOf",
  `${between(index, "    const intact = (was, is) => {", "    // Get current tab list")}\nreturn { intact, stillNew };`
)((t) => t.url);

// Every window: the session's tab ("s") anywhere, the other tabs the user's (on "a" or "b") or
// pending new tabs (the first on "u", a second on "v").
function* windows() {
  for (let n = 2; n <= 5; n++) {
    for (let mask = 0; mask < 3 ** (n - 1); mask++) {
      const kinds = [];
      for (let m = mask, i = 0; i < n - 1; i++, m = Math.floor(m / 3)) kinds.push(m % 3);
      const pending = kinds.filter((k) => k === 2).length;
      if (pending < 1 || pending > 2) continue;
      for (let at = 0; at < n; at++) {
        const tabs = [];
        let k = 0, p = 0;
        for (let i = 0; i < n; i++) {
          if (i === at) { tabs.push({ id: i, url: "s" }); continue; }
          const kind = kinds[k++];
          tabs.push(kind === 2 ? { id: i, url: p++ ? "v" : "u", pending: true } : { id: i, url: ["a", "b"][kind] });
        }
        yield tabs;
      }
    }
  }
}

function changes(tabs) {
  const out = [];
  for (let i = 0; i < tabs.length; i++) out.push({ close: i });
  for (let i = 0; i < tabs.length; i++) for (const url of ["a", "b", "s", "u", "v", "f"]) if (url !== tabs[i].url) out.push({ nav: i, url });
  for (let at = 0; at <= tabs.length; at++) for (const url of ["a", "b", "u", "g"]) out.push({ open: at, url });
  for (let i = 0; i < tabs.length; i++) for (let to = 0; to < tabs.length; to++) if (to !== i) out.push({ drag: i, to });
  return out;
}

let opened = 1000;
function change(tabs, c) {
  const t = tabs.map((x) => ({ ...x }));
  if ("close" in c) t.splice(c.close, 1);
  else if ("nav" in c) t[c.nav].url = c.url;
  else if ("open" in c) t.splice(c.open, 0, { id: opened++, url: c.url, fresh: true });
  else t.splice(c.to, 0, ...t.splice(c.drag, 1));
  return t;
}

const show = (tabs) => tabs.map((t) => `${t.id}:${t.url}${t.pending ? "*" : ""}`).join(" ");

test("no listing carries a tab that was already there as the new tab", () => {
  const carried = [];
  let listings = 0;
  for (const last of windows()) {
    const urls = last.filter((t) => t.pending).map((t) => t.url);
    const before = last.filter((t) => !t.pending);
    const check = (is, how) => {
      listings++;
      if (intact(before, is)) return; // not a new baseline: its new tabs are claimed, as the tests show
      const wrong = (stillNew(last, urls, is) || []).filter((t) => !t.pending && !t.fresh);
      if (wrong.length) carried.push(`${show(last)} --${JSON.stringify(how)}--> ${show(is)} carries ${wrong.map((t) => t.id)}`);
    };
    for (const c1 of changes(last)) {
      const one = change(last, c1);
      check(one, [c1]);
      for (const c2 of changes(one)) check(change(one, c2), [c1, c2]);
    }
  }
  assert.ok(listings > 1_000_000, `only ${listings} listings checked`);
  assert.deepEqual(carried.slice(0, 5), [], `${carried.length} listings carry a tab that was already there`);
});
