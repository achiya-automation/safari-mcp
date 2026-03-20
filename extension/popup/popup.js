// Check connection status against the HTTP polling server
async function checkStatus() {
  try {
    const response = await fetch("http://127.0.0.1:9224/connect", { method: "POST" });
    if (response.ok) {
      document.getElementById("statusDot").className = "dot connected";
      document.getElementById("statusText").textContent = "Connected to MCP Server";
      document.getElementById("info").textContent = "HTTP polling on port 9224";
    } else {
      throw new Error("Not OK");
    }
  } catch {
    document.getElementById("statusDot").className = "dot disconnected";
    document.getElementById("statusText").textContent = "MCP Server not running";
    document.getElementById("info").textContent = "Start the MCP server to connect";
  }
}
checkStatus();
