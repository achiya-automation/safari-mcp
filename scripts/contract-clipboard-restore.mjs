#!/usr/bin/env node
// MANUAL contract test — touches the SYSTEM CLIPBOARD. Run only when you are not
// actively copying/pasting. Not part of `npm test` (CI has no pasteboard).
//
// Contract under test (the clipboard-safety rule): clipboardWrite({restore:true})
// must put the user's ORIGINAL clipboard back after the ~2s restore window, and a
// process exiting inside that window must flush the restore synchronously.
//
// Run: node scripts/contract-clipboard-restore.mjs
import { execFileSync } from "node:child_process";
import * as safari from "../safari.js";

const pbpaste = () => {
  try { return execFileSync("pbpaste", { encoding: "utf8" }); } catch { return ""; }
};

const original = pbpaste();
console.log(`1. saved current clipboard (${original.length} chars)`);

await safari.clipboardWrite({ text: "__MCP_CONTRACT_TEST__", restore: true });
if (pbpaste() !== "__MCP_CONTRACT_TEST__") {
  console.error("FAIL: tool text never landed on the clipboard");
  process.exit(1);
}
console.log("2. tool text on clipboard — waiting out the restore window...");

await new Promise((r) => setTimeout(r, 2600));
const after = pbpaste();
if (after === original) {
  console.log("PASS: original clipboard restored after the window");
} else {
  console.error(`FAIL: clipboard left as: ${JSON.stringify(after.slice(0, 60))}`);
  process.exit(1);
}

// Second leg: exit INSIDE the window — flushClipboardRestore must restore synchronously.
await safari.clipboardWrite({ text: "__MCP_CONTRACT_TEST_2__", restore: true });
safari.flushClipboardRestore();
const flushed = pbpaste();
if (flushed === original) {
  console.log("PASS: flushClipboardRestore restored synchronously (shutdown path)");
  process.exit(0);
}
console.error(`FAIL: shutdown-path restore left clipboard as: ${JSON.stringify(flushed.slice(0, 60))}`);
process.exit(1);
