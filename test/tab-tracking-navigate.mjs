// Regression test for the "fresh tab → SPA navigate" lockout bug (June 2026).
//
// Bug chain that locked the session out of its own tab:
//   A) navigate() broke its readyState poll on 'complete' without checking the URL
//      left preNavUrl. about:blank is ALWAYS 'complete', so navigating a fresh tab to
//      a slow SPA (Airtable) saw blank+complete and falsely threw "set URL had no effect".
//   B) the throw happened before _activeTabURL was updated → resolveActiveTab cleared
//      the index → every later runJS threw "Tab tracking lost".
//   C) the new URL was registered as owned only AFTER a successful navigate → switch_tab
//      recovery was refused.
//
// Run with the same profile the MCP uses:  SAFARI_PROFILE=אוטומציות node test/tab-tracking-navigate.mjs

import { newTab, navigate, readPage, closeTab, getActiveTabIndex, getActiveTabURL } from "../safari.js";

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓ PASS" : "✗ FAIL"} — ${msg}`); if (!cond) failures++; };

// ---------- UNIT: the _settled predicate (mirrors safari.js navigate) ----------
// Deterministic proof of the root-cause fix, independent of Safari timing.
function makeSettled(preNavUrl, targetUrl) {
  const isReload = !!preNavUrl && preNavUrl === targetUrl;
  return (state, landed) => {
    if (state !== "complete" && state !== "interactive") return false;
    if (isReload) return true;
    if (!landed || landed === "about:blank") return false;
    return landed !== preNavUrl;
  };
}
console.log("\n=== UNIT: _settled predicate ===");
{
  const s = makeSettled("about:blank", "https://airtable.com/app123");
  ok(s("complete", "about:blank") === false, "blank+complete is NOT settled (the bug: used to break here)");
  ok(s("complete", "https://airtable.com/app123") === true, "complete on destination URL IS settled");
  ok(s("interactive", "https://airtable.com/app123") === true, "interactive on destination URL IS settled");
  ok(s("loading", "https://airtable.com/app123") === false, "still loading is NOT settled");
}
{
  const s = makeSettled("https://old.example/page", "https://new.example/page");
  ok(s("complete", "https://old.example/page") === false, "stale OLD url + complete is NOT settled (cross-page nav)");
  ok(s("complete", "https://new.example/page") === true, "landed on NEW url IS settled");
}
{
  const s = makeSettled("https://x.com/a", "https://x.com/a");
  ok(s("complete", "https://x.com/a") === true, "same-URL reload settles on readyState (URL never changes)");
}

// ---------- INTEGRATION: the exact lockout scenario, against the real SPA ----------
console.log("\n=== INTEGRATION: fresh blank tab → Airtable SPA ===");
const AIRTABLE = "https://airtable.com/appXajcRyPCHkJ87k/tblXOLKjZhLorfEbd";
let opened = false;
try {
  await newTab("");                                  // 1. blank tab (the trigger condition)
  const blankIdx = getActiveTabIndex();
  opened = blankIdx != null;
  ok(blankIdx != null, `blank tab opened, index=${blankIdx}`);

  let threw = null;
  try { await navigate(AIRTABLE); } catch (e) { threw = e.message; }
  ok(!threw, threw ? `navigate THREW (bug A still present): ${threw}` : "navigate to SPA did not throw");

  const idx = getActiveTabIndex();
  const url = getActiveTabURL();
  ok(idx != null, `tab index preserved after navigate (bug B): index=${idx}`);
  ok(!!url && /airtable/.test(url), `tracked URL points at destination (bug B): ${url}`);

  let readErr = null, page = "";
  try { page = await readPage({ maxLength: 400 }); } catch (e) { readErr = e.message; }
  ok(!readErr, readErr ? `readPage locked out (bug B): ${readErr}` : `readPage works post-navigate (${page.length} chars)`);
} catch (e) {
  ok(false, `FATAL: ${e?.message || e}`);
} finally {
  if (opened) { try { await closeTab(); console.log("· cleanup: test tab closed"); } catch {} }
}

console.log(`\n${failures === 0 ? "✅ ALL TESTS PASSED" : `❌ ${failures} TEST(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
