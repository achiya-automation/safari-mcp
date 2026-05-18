#!/usr/bin/env node
/**
 * Unit test for safari_evaluate's script normalization (_buildEvalExpr) and the
 * async kick-off / poll mechanism.
 *
 * Verifies the v2.11.0 fix:
 *   1. Sync expressions, IIFEs and multi-statement scripts all yield their value.
 *   2. A multi-line script whose last line is `})()` no longer crashes with a
 *      `return })()` syntax error — it falls back to indirect-eval completion value.
 *   3. `fetch(` alone is NOT treated as async (un-awaited fetch is fire-and-forget),
 *      so a sync IIFE that merely mentions `fetch` keeps its return value.
 *   4. Async scripts (await / .then() / leading async) resolve to their value
 *      instead of returning "(undefined)" — the kick-off-into-a-global + Node-side
 *      poll mechanism is exercised end to end.
 *
 * The risky normalization logic is imported from safari.js and tested directly;
 * the trivial sync/async wrappers are mirrored here.
 *
 * Run:  node scripts/test-evaluate-wrapping.js
 */
import { _buildEvalExpr } from '../safari.js';

globalThis.window = globalThis; // _evaluateAsync's kick-off writes to window.<token>

let pass = 0, fail = 0;
function check(name, got, want) {
  if (String(got) === String(want)) {
    pass++; console.log(`  ok   ${name}  →  ${got}`);
  } else {
    fail++; console.log(`FAIL   ${name}  →  got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`);
  }
}

// Mirror evaluate()'s sync path: wrap the built expression and run it.
function runSync(script) {
  const { expr } = _buildEvalExpr(script.trim());
  const wrapped = `(function(){ try { return (${expr}); } catch(__mcpErr) { return 'Error: ' + __mcpErr.message; } })()`;
  return (0, eval)(wrapped); // eslint-disable-line no-eval
}

// Mirror _evaluateAsync(): kick the work off into a page global, poll it.
async function runAsync(script) {
  const { expr } = _buildEvalExpr(script.trim());
  const token = '__mcpEval_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const slot = 'window.' + token;
  const kickoff =
    `(function(){${slot}={done:false};(async function(){try{` +
    `var __v=await (${expr});` +
    `${slot}.val=(__v===undefined||__v===null)?null:(typeof __v==='object'?JSON.stringify(__v):String(__v));` +
    `}catch(__e){${slot}.err=(__e&&__e.message)||String(__e);}` +
    `finally{${slot}.done=true;}})();return 'ok';})()`;
  const started = (0, eval)(kickoff); // eslint-disable-line no-eval
  if (started !== 'ok') throw new Error('kick-off did not return ok: ' + started);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
    const s = globalThis[token];
    if (s && s.done) {
      delete globalThis[token];
      if (s.err) return 'Error: ' + s.err;
      return s.val !== undefined && s.val !== null ? String(s.val) : '(no return value)';
    }
  }
  throw new Error('async script did not settle');
}

function noThrow(fn) {
  try { fn(); return 'ok'; } catch (e) { return 'THREW: ' + e.message; }
}

(async () => {
  console.log('--- isAsync detection ---');
  check('plain expression is sync', _buildEvalExpr('document.title').isAsync, false);
  check('un-awaited fetch() is NOT async', _buildEvalExpr('fetch("/api")').isAsync, false);
  check('await is async', _buildEvalExpr('await fetch("/api")').isAsync, true);
  check('.then() is async', _buildEvalExpr('p.then(x => x)').isAsync, true);
  check('leading async is async', _buildEvalExpr('async function f(){}').isAsync, true);

  console.log('--- sync scripts ---');
  check('number expression', runSync('2 + 2'), 4);
  check('string expression', runSync('"a" + "b"'), 'ab');
  check('member expression', runSync('[1,2,3].length'), 3);
  check('object literal', runSync('({ k: 41 + 1 }).k'), 42);
  check('function IIFE', runSync('(function(){ return 7 * 6; })()'), 42);
  check('arrow IIFE', runSync('(() => 99)()'), 99);
  check('sync IIFE mentioning fetch(', runSync('(function(){ var note = "uses fetch() here"; return note ? 77 : 0; })()'), 77);
  check('multi-statement, return injected', runSync('var x = 5;\nx * 3'), 15);
  check('multi-statement, explicit return', runSync('var x = 2;\nreturn x + x;'), 4);
  check('single-line var (eval completion value)', runSync('var a = 10; a * 2'), 20);
  check('no crash on trailing })()', noThrow(() => runSync('var out = 7;\n(function(){\nout = out * 2;\n})()')), 'ok');

  console.log('--- async scripts ---');
  check('bare await', await runAsync('await Promise.resolve(123)'), 123);
  check('async arrow IIFE', await runAsync('(async () => { return await Promise.resolve(8) * 2; })()'), 16);
  check('.then() chain', await runAsync('Promise.resolve(5).then(x => x + 100)'), 105);
  check('async multi-statement', await runAsync('const a = await Promise.resolve(3);\nconst b = await Promise.resolve(4);\na * b'), 12);
  check('async single-line multi-statement', await runAsync('const a = await Promise.resolve(3); a * 4'), 12);
  check('async single-line, two declarations', await runAsync('let x = await Promise.resolve(5); const y = await Promise.resolve(6); x + y'), 11);
  check('async single-line ending in member expr', await runAsync('const o = await Promise.resolve({ n: 8 }); o.n'), 8);
  check('async single-line with for-loop (semicolon-aware)', await runAsync('let s = 0; for (let i = 0; i < 3; i++) { s += await Promise.resolve(i); }; s'), 3);
  check('leading async statement', await runAsync('async function f(){ return 11; }\nawait f()'), 11);
  check('delayed promise (real wait)', await runAsync('await new Promise(r => setTimeout(() => r("late"), 80))'), 'late');
  check('async returning object', await runAsync('await Promise.resolve({ n: 9 })'), '{"n":9}');
  check('async error surfaces', await runAsync('await Promise.reject(new Error("boom"))'), 'Error: boom');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
