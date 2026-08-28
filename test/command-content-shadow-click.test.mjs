#!/usr/bin/env node
/**
 * Behavioral regression coverage for the persistent isolated-world click bridge.
 *
 * Impact's PartnerStack signup controller renders its buttons below nested open
 * shadow roots. Snapshot can see and tag those buttons, but command-content.js used
 * document-only queries and document.elementFromPoint(), so text/ref clicks missed
 * while coordinate clicks stopped at the outer custom-element host.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const COMMAND_CONTENT = readFileSync(
  new URL("../extension/command-content.js", import.meta.url),
  "utf8"
);

function clickHarness() {
  const dom = new JSDOM("<body><on-ps-signup-controller></on-ps-signup-controller></body>", {
    url: "https://app.impact.com/signup",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const { window } = dom;
  const commandListeners = [];

  window.browser = {
    runtime: {
      connect() {
        return {
          postMessage() {},
          disconnect() {},
          onDisconnect: { addListener() {} },
        };
      },
      onMessage: {
        addListener(listener) {
          commandListeners.push(listener);
        },
        // Keep stale callbacks in the harness. Safari can invalidate the runtime
        // object before removeListener can detach them, so correctness must come
        // from the active-generation guard rather than successful removal.
        removeListener() {},
      },
    },
    storage: {
      local: {
        async get() { return { mcpEnabled: false }; },
        async set() {},
      },
      onChanged: {
        addListener() {},
        removeListener() {},
      },
    },
  };
  window.PointerEvent = window.PointerEvent || window.MouseEvent;
  window.Element.prototype.scrollIntoView = function () {};
  window.Element.prototype.getBoundingClientRect = function () {
    return { left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40, x: 10, y: 20 };
  };

  const outerHost = window.document.querySelector("on-ps-signup-controller");
  const outerRoot = outerHost.attachShadow({ mode: "open" });
  const innerHost = window.document.createElement("impact-signin-panel");
  outerRoot.appendChild(innerHost);
  const innerRoot = innerHost.attachShadow({ mode: "open" });
  innerRoot.innerHTML = '<button data-mcp-ref="shadow-signin"><span>Sign In</span></button>';
  const button = innerRoot.querySelector("button");
  const label = innerRoot.querySelector("span");

  // DocumentOrShadowRoot hit-testing retargets at each shadow boundary. Model that
  // explicitly because jsdom has no layout engine or elementFromPoint implementation.
  window.document.elementFromPoint = () => outerHost;
  Object.defineProperty(outerRoot, "elementFromPoint", { value: () => innerHost });
  Object.defineProperty(innerRoot, "elementFromPoint", { value: () => label });

  let clicks = 0;
  button.addEventListener("click", (event) => {
    clicks += 1;
    event.preventDefault();
  });

  window.eval(COMMAND_CONTENT);
  return {
    window,
    button,
    get clicks() { return clicks; },
    get commandListenerCount() { return commandListeners.length; },
    dispatchContentCommand(message) {
      const responses = [];
      const returns = commandListeners.map((listener) => listener(
        message,
        {},
        (response) => responses.push(response)
      ));
      return { responses, returns };
    },
    close() {
      try { window.__mcpContentCommandState?.cleanup?.(); } catch {}
      try { window.__mcpKeepaliveState?.cleanup?.(); } catch {}
      dom.window.close();
    },
  };
}

test("persistent click bridge traverses nested open shadow roots for text, ref, and coordinates", () => {
  const harness = clickHarness();
  try {
    const byText = harness.window.__mcpHandleContentClick({ text: "Sign In" });
    assert.equal(byText.ok, true);
    assert.match(byText.result, /^Clicked: BUTTON/);
    assert.equal(harness.clicks, 1, "text click must reach the shadow button exactly once");

    const byRef = harness.window.__mcpHandleContentClick({ ref: "shadow-signin" });
    assert.equal(byRef.ok, true);
    assert.match(byRef.result, /^Clicked: BUTTON/);
    assert.equal(harness.clicks, 2, "snapshot ref click must reach the shadow button exactly once");

    const byCoordinates = harness.window.__mcpHandleContentClick({ x: 60, y: 40 });
    assert.equal(byCoordinates.ok, true);
    assert.notEqual(byCoordinates.result, "Clicked: ON-PS-SIGNUP-CONTROLLER");
    assert.equal(harness.clicks, 3, "coordinate hit-testing must penetrate both shadow hosts");
  } finally {
    harness.close();
  }
});

test("reinjection leaves only one active command listener", () => {
  const harness = clickHarness();
  try {
    harness.window.eval(COMMAND_CONTENT);
    assert.equal(harness.commandListenerCount, 2, "both raw listener generations remain in the harness");

    const dispatched = harness.dispatchContentCommand({
      type: "mcp-content-click",
      payload: { ref: "shadow-signin" },
    });

    assert.deepEqual(dispatched.returns, [false, true]);
    assert.equal(dispatched.responses.length, 1, "only the active listener may answer");
    assert.equal(dispatched.responses[0].ok, true);
    assert.equal(harness.clicks, 1, "one safari_click must dispatch one DOM click after reinjection");
  } finally {
    harness.close();
  }
});
