// v6 — asks background script for real-time status, falls back to storage
async function checkStatus() {
  const enabled = await getVal("mcpEnabled", true);
  document.getElementById("enableToggle").checked = enabled;

  if (!enabled) {
    setStatus("paused", "Paused", "Toggle to resume");
    return;
  }

  // Ask background script for real-time status
  try {
    const resp = await browser.runtime.sendMessage({ action: "getStatus" });
    if (resp) {
      if (resp.connected) { setStatus("connected", "Connected", "Port 9224"); return; }
      if (!resp.enabled) { setStatus("paused", "Paused", "Toggle to resume"); return; }
    }
  } catch {}

  // Fallback: read from storage
  const status = await getVal("mcpStatus", "checking");
  switch (status) {
    case "connected":
      setStatus("connected", "Connected", "Port 9224");
      break;
    case "paused":
      setStatus("paused", "Paused", "Toggle to resume");
      break;
    case "checking":
      setStatus("checking", "Connecting...", "Trying port 9224...");
      break;
    default:
      setStatus("disconnected", "Not connected", "Start the MCP server to connect");
  }
}

function setStatus(dotClass, text, info) {
  document.getElementById("statusDot").className = "dot " + dotClass;
  document.getElementById("statusText").textContent = text;
  document.getElementById("info").textContent = info;
}

document.getElementById("enableToggle").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await browser.storage.local.set({ mcpEnabled: enabled });
  try { browser.runtime.sendMessage({ action: "setEnabled", enabled }); } catch {}
  setTimeout(checkStatus, 500);
});

async function getVal(key, defaultVal) {
  try {
    const data = await browser.storage.local.get(key);
    return data[key] !== undefined ? data[key] : defaultVal;
  } catch { return defaultVal; }
}

checkStatus();
