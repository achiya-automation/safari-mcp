#!/usr/bin/env node
/**
 * Live integration test for safari_evaluate (sync + async) and safari_wait_for
 * against real Safari — verifies the v2.11.0 async-via-do-JavaScript fix end to end.
 *
 * `do JavaScript` never awaits a Promise, so before the fix every async script
 * returned "(undefined)" and safari_wait_for never actually waited. This test
 * exercises the real AppleScript bridge, not just the string-building logic.
 *
 * Run:  SAFARI_PROFILE='אוטומציות' node scripts/test-evaluate-live.js
 * Requires the profile window open and "Allow JavaScript from Apple Events".
 */
process.env.SAFARI_PROFILE = process.env.SAFARI_PROFILE || 'אוטומציות';

const safari = await import('../safari.js');

let failures = 0;
function check(name, got, expectFn) {
  let ok = false;
  try { ok = expectFn(got); } catch { ok = false; }
  console.log(`  ${ok ? '✅' : '❌'} ${name}  →  ${JSON.stringify(got)}`);
  if (!ok) failures++;
}

async function main() {
  console.log('— safari_evaluate / safari_wait_for live test —\n');
  const before = JSON.parse(await safari.listTabs());
  await safari.newTab('https://example.com/');

  // --- sync ---
  check('sync expression', await safari.evaluate({ script: 'location.hostname' }),
    v => v === 'example.com');
  check('sync IIFE', await safari.evaluate({ script: '(function(){ return 6 * 7; })()' }),
    v => String(v) === '42');
  check('sync multi-statement', await safari.evaluate({ script: 'var n = 4;\nn * n' }),
    v => String(v) === '16');

  // --- async (the Bug D fix) ---
  check('async: await Promise.resolve', await safari.evaluate({ script: 'await Promise.resolve(123)' }),
    v => String(v) === '123');
  check('async: arrow IIFE with real delay', await safari.evaluate({
      script: '(async () => { await new Promise(r => setTimeout(r, 200)); return "delayed-ok"; })()' }),
    v => v === 'delayed-ok');
  check('async: .then() chain', await safari.evaluate({ script: 'Promise.resolve(7).then(x => x * 6)' }),
    v => String(v) === '42');
  check('async: multi-statement await', await safari.evaluate({
      script: 'const a = await Promise.resolve(8);\nconst b = await Promise.resolve(9);\na + b' }),
    v => String(v) === '17');
  check('async: single-line multi-statement', await safari.evaluate({
      script: 'const r = await fetch(location.href); r.status' }),
    v => String(v) === '200');
  check('async: fetch same-origin', await safari.evaluate({ script: 'fetch(location.href).then(r => r.status)' }),
    v => String(v) === '200');
  check('async: error surfaces', await safari.evaluate({ script: 'await Promise.reject(new Error("boom"))' }),
    v => typeof v === 'string' && v.includes('boom'));

  // --- waitFor ---
  check('wait_for present element', await safari.waitFor({ selector: 'body', timeout: 3000 }),
    v => typeof v === 'string' && v.startsWith('Found'));
  // Inject an element after 700ms — proves wait_for actually waits (old code returned immediately).
  await safari.evaluate({ script:
    'setTimeout(function(){var d=document.createElement("div");d.id="mcp-delayed";document.body.appendChild(d);}, 700)' });
  check('wait_for delayed element', await safari.waitFor({ selector: '#mcp-delayed', timeout: 5000 }),
    v => typeof v === 'string' && v.startsWith('Found'));
  let timedOut = false;
  try { await safari.waitFor({ selector: '#never-xyz', timeout: 1200 }); }
  catch { timedOut = true; }
  check('wait_for times out on missing element', timedOut, v => v === true);

  // cleanup
  await safari.closeTab();
  const after = JSON.parse(await safari.listTabs());
  check('user tabs untouched', after.length, v => v === before.length);

  console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('TEST ERROR:', err); process.exit(1); });
