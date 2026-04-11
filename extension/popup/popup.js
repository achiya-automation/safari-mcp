function setStatus(c, t, i) {
  document.getElementById("statusDot").className = "dot " + c;
  document.getElementById("statusText").textContent = t;
  document.getElementById("info").textContent = i;
}
async function getVal(k, d) {
  try { const r = await browser.storage.local.get(k); return r[k] !== undefined ? r[k] : d; }
  catch { return d; }
}
async function check() {
  const on = await getVal("mcpEnabled", true);
  document.getElementById("enableToggle").checked = on;
  if (!on) { setStatus("paused", "Paused", "Toggle to resume"); return; }
  // Ask background script for real-time status first
  try {
    const resp = await browser.runtime.sendMessage({ action: "getStatus" });
    if (resp) {
      if (resp.connected) { setStatus("connected", "Connected", "Port 9224"); return; }
      if (!resp.enabled) { setStatus("paused", "Paused", "Toggle to resume"); return; }
    }
  } catch {}
  // Fallback: read from storage
  const s = await getVal("mcpStatus", null);
  if (s === "connected") setStatus("connected", "Connected", "Port 9224");
  else if (s === "paused") setStatus("paused", "Paused", "Toggle to resume");
  else if (s === "checking") setStatus("checking", "Connecting...", "Trying port 9224...");
  else setStatus("disconnected", "Not connected", "Start the MCP server to connect");
}
document.getElementById("enableToggle").addEventListener("change", async (e) => {
  await browser.storage.local.set({ mcpEnabled: e.target.checked });
  try { browser.runtime.sendMessage({ action: "setEnabled", enabled: e.target.checked }); } catch {}
  setTimeout(check, 500);
});
check();
