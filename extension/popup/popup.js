const $ = (id) => document.getElementById(id);
const VIEWS = {
  connected: ["connected", "Connected", "Port 9224"],
  paused: ["paused", "Paused", "Toggle to resume"],
  checking: ["checking", "Connecting...", "Trying port 9224..."],
  disconnected: ["disconnected", "Not connected", "Start the MCP server to connect"],
  unpaired: ["unpaired", "Not paired", "Pair this extension with your Safari MCP server:"],
  rejected: ["unpaired", "Pairing needed", "The Safari MCP server did not accept this extension. Pair it again:"],
};
function show(status) {
  const [dot, text, info] = VIEWS[status] || VIEWS.disconnected;
  $("statusDot").className = "dot " + dot;
  $("statusText").textContent = text;
  $("info").textContent = info;
  $("pairForm").hidden = status !== "unpaired" && status !== "rejected";
}
async function getVal(k, d) {
  try { const r = await browser.storage.local.get(k); return r[k] !== undefined ? r[k] : d; }
  catch { return d; }
}
async function currentStatus() {
  if (!(await getVal("mcpEnabled", true))) return "paused";
  // Ask background script for real-time status first, then fall back to storage
  try {
    const resp = await browser.runtime.sendMessage({ action: "getStatus" });
    if (resp?.connected) return "connected";
    if (resp && !resp.enabled) return "paused";
    if (resp?.auth) return resp.auth;
  } catch {}
  return getVal("mcpStatus", null);
}
async function check() {
  $("enableToggle").checked = await getVal("mcpEnabled", true);
  show(await currentStatus());
}
function say(kind, text) {
  $("pairMessage").className = "pair-message " + kind;
  $("pairMessage").textContent = text;
}
$("enableToggle").addEventListener("change", async (e) => {
  await browser.storage.local.set({ mcpEnabled: e.target.checked });
  try { browser.runtime.sendMessage({ action: "setEnabled", enabled: e.target.checked }); } catch {}
  setTimeout(check, 500);
});
$("copyCommand").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("pairCommand").textContent);
    $("copyCommand").textContent = "Copied";
  } catch {
    getSelection().selectAllChildren($("pairCommand")); // Cmd+C still works
  }
  setTimeout(() => { $("copyCommand").textContent = "Copy"; }, 1500);
});
// Shown as XXXX-XXXX however it is typed or pasted.
$("pairCode").addEventListener("input", () => {
  const raw = $("pairCode").value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  $("pairCode").value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
});
$("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pairButton").disabled = true;
  say("", "Pairing...");
  let result;
  try {
    result = await browser.runtime.sendMessage({ action: "pairBridge", code: $("pairCode").value });
  } catch {
    result = { ok: false, error: "The extension did not answer. Close this popup and try again." };
  }
  $("pairButton").disabled = false;
  if (!result?.ok) {
    say("error", result?.error || "Pairing failed. Try again.");
    return;
  }
  say("ok", "Paired. Connecting...");
  $("pairCode").value = "";
  setTimeout(check, 1500);
  setTimeout(check, 4000);
});
check();
