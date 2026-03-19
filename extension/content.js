// Safari MCP Bridge — Content Script
// Runs in every page, handles evaluate requests from background script

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "evaluate") {
    try {
      // Execute the script in page context using a script element
      // This ensures full access to page's JS environment (React, etc.)
      const scriptEl = document.createElement("script");
      const resultId = "__mcp_eval_" + Date.now() + "_" + Math.random().toString(36).slice(2);

      // Store result in a global variable that we can read back
      scriptEl.textContent = `
        try {
          const __result = (function() { ${message.script} })();
          if (__result instanceof Promise) {
            __result.then(v => {
              window.${resultId} = { value: v, done: true };
            }).catch(e => {
              window.${resultId} = { error: e.message, done: true };
            });
          } else {
            window.${resultId} = { value: __result, done: true };
          }
        } catch (e) {
          window.${resultId} = { error: e.message, done: true };
        }
      `;
      document.documentElement.appendChild(scriptEl);
      scriptEl.remove();

      // Poll for result (handles both sync and async)
      let attempts = 0;
      const poll = () => {
        const result = window[resultId];
        if (result?.done) {
          delete window[resultId];
          if (result.error) {
            sendResponse({ error: result.error });
          } else {
            const val = result.value;
            sendResponse(val !== undefined && val !== null ?
              (typeof val === "object" ? JSON.stringify(val) : String(val)) :
              null
            );
          }
          return;
        }
        attempts++;
        if (attempts > 300) { // 30 seconds
          delete window[resultId];
          sendResponse({ error: "Timeout" });
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
      return true; // Keep sendResponse channel open for async
    } catch (e) {
      sendResponse({ error: e.message });
    }
  }
});
