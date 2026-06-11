#!/usr/bin/env node
// MANUAL contract test — briefly brings Safari to the front, then verifies focus is
// returned to the previously frontmost app. Requires a GUI session + Safari running.
// Not part of `npm test` (CI has neither).
//
// Contract under test (the focus-theft rule): after a tool operation that raised
// Safari, restoreFocusIfStolen(saved) must hand focus back to the app the user was
// in — UNLESS the user interacted in the last ~2.5s (then it must NOT yank focus).
//
// Run from a terminal and DON'T touch mouse/keyboard once it starts:
//   node scripts/contract-focus-restore.mjs
import { execFileSync } from "node:child_process";
import * as safari from "../safari.js";

console.log("Hands off mouse + keyboard for ~8 seconds...");
// Let the HID-idle clock outgrow the user-activity guard (~2.5s) — the keystroke
// that launched this script counts as user activity.
await new Promise((r) => setTimeout(r, 4000));

const before = await safari.saveFrontmostApp();
console.log("1. frontmost before:", before || "(unknown)");
if (!before || before === "com.apple.Safari") {
  console.error("SKIP: run this from a non-Safari frontmost app (e.g. Terminal)");
  process.exit(2);
}

execFileSync("osascript", ["-e", 'tell application "Safari" to activate']);
await new Promise((r) => setTimeout(r, 800));
console.log("2. Safari raised — restoring...");

await safari.restoreFocusIfStolen(before);
await new Promise((r) => setTimeout(r, 800));

const after = await safari.saveFrontmostApp();
console.log("3. frontmost after restore:", after || "(unknown)");
if (after === before) {
  console.log("PASS: focus returned to the original app");
  process.exit(0);
}
console.error(`FAIL: focus left on ${after} (expected ${before})`);
process.exit(1);
