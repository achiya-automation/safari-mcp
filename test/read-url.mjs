// Ad-hoc reader: open own tab → navigate → read → close. Uses the FIXED safari.js
// directly (bypasses the still-running old MCP instance). Safe: read-only, own tab.
//   SAFARI_PROFILE=אוטומציות node test/read-url.mjs "<url>" [maxLen] [waitMs]
import { newTab, navigate, readPage, closeTab, getActiveTabIndex } from "../safari.js";

const url = process.argv[2];
const max = parseInt(process.argv[3] || "6000", 10);
const wait = parseInt(process.argv[4] || "4000", 10);
if (!url) { console.error("usage: read-url.mjs <url> [maxLen] [waitMs]"); process.exit(2); }

let opened = false;
try {
  await newTab("");
  opened = getActiveTabIndex() != null;
  await navigate(url);
  await new Promise(r => setTimeout(r, wait)); // let the SPA paint
  const page = await readPage({ maxLength: max });
  console.log(page);
} catch (e) {
  console.error("ERR:", e?.message || e);
  process.exitCode = 1;
} finally {
  // closeTab can hang if the daemon is mid-restart under load — cap it and move on.
  if (opened) {
    await Promise.race([closeTab().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
  }
}
// Force exit — the safari-helper child keeps the event loop alive otherwise.
process.exit(process.exitCode || 0);
