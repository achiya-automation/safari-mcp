// Read a specific Airtable automation's trigger+script via the FIXED safari.js.
// Entry = a known automation URL (renders the automations view + sidebar), then
// click the target automation by its sidebar name, then read the panel text.
//   SAFARI_PROFILE=אוטומציות node test/read-automation.mjs "<automation name>"
import { newTab, navigate, readPage, evaluate, closeTab, getActiveTabIndex } from "../safari.js";

const ENTRY = "https://airtable.com/appXajcRyPCHkJ87k/wflrrA1NjHpwOk8Ni/wac4DooNb01DgXAoV";
const target = process.argv[2] || "עדכון משכורות אוטומטי";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function read(max = 9000) {
  for (let i = 0; i < 3; i++) {
    try { const p = await readPage({ maxLength: max }); if (p && p.length > 50) return p; } catch {}
    await sleep(1500);
  }
  return "(read failed)";
}

let opened = false;
try {
  await newTab("");
  opened = getActiveTabIndex() != null;
  await navigate(ENTRY);
  await sleep(5000);
  console.log("=== ENTRY PAGE (sidebar should list all automations) ===");
  const first = await read(4000);
  console.log(first.slice(0, 1200));

  // click the target automation in the sidebar
  const clickRes = await evaluate(`(function(){
    var t=${JSON.stringify(target)};
    var nodes=[].slice.call(document.querySelectorAll('div,span,a,button,li'));
    var el=nodes.find(function(n){return (n.textContent||'').trim()===t;});
    if(!el){ // fallback: contains
      el=nodes.find(function(n){return (n.textContent||'').trim().indexOf(t)===0 && (n.textContent||'').length<60;});
    }
    if(!el) return 'NOTFOUND';
    var c=el; for(var i=0;i<6&&c;i++){ try{c.click();}catch(e){} c=c.parentElement; }
    return 'CLICKED:'+(el.textContent||'').trim().slice(0,40);
  })()`);
  console.log("\n=== CLICK RESULT:", clickRes, "===");
  await sleep(4500);

  console.log("\n=== TARGET AUTOMATION PANEL ===");
  console.log(await read(9000));
} catch (e) {
  console.error("ERR:", e?.message || e);
  process.exitCode = 1;
} finally {
  if (opened) await Promise.race([closeTab().catch(()=>{}), sleep(3000)]);
}
process.exit(process.exitCode || 0);
