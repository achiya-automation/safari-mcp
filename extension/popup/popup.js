// Check connection status
async function checkStatus() {
  try {
    const response = await fetch("http://localhost:9223/status");
    const data = await response.json();
    document.getElementById("statusDot").className = "dot connected";
    document.getElementById("statusText").textContent = "Connected to MCP Server";
    document.getElementById("info").textContent = "Port: 9223 | Tools: " + (data.tools || "ready");
  } catch {
    document.getElementById("statusDot").className = "dot disconnected";
    document.getElementById("statusText").textContent = "MCP Server not running";
    document.getElementById("info").textContent = "Start the MCP server to connect";
  }
}
checkStatus();
