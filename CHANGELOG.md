# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.12.0] - 2026-06-02

A correctness + security pass across the engine, server, and extension.

### Fixed

#### Async tools that never actually waited (`do JavaScript` can't await a Promise)
Several tools passed an `async` IIFE straight to AppleScript `do JavaScript`, which returns the moment the synchronous portion finishes — handing back an unsettled Promise (`[object Promise]`) instead of the result. This is the same constraint already handled for `safari_evaluate`/`safari_wait_for`; these tools now poll page state from the Node side:
- **`safari_navigate_and_read`** was fully broken — it returned `[object Promise]` instead of the page content. Now polls `readyState`, then reads.
- **`safari_go_back` / `safari_go_forward`** navigated but never updated the tracked URL, so the next operation could target the wrong tab.
- **`safari_reload`** reloaded but never waited for load or refreshed the URL.
- **`safari_click_and_wait`** clicked but never waited; **`safari_fill_and_submit`** submitted but didn't wait for the result page; **`safari_scroll_to`** (text mode) scrolled once instead of looping; **`safari_emulate` / `safari_reset_emulation`** didn't wait for the reload.
- **`safari_get_indexed_db` / `safari_list_indexed_dbs`** returned `[object Promise]` — now routed through the async poller.
- **`safari_screenshot_element`** (canvas path) returned a Promise and never fell through to the reliable screencapture+crop fallback; the `safari_screenshot` canvas fallback and `safari_upload_file` drop-fallback had the same flaw.

#### Injection / escaping correctness
- **`safari_mock_route`**: escape order was reversed (`'`→`\'` before `\`→`\\`), double-escaping quotes and breaking the injected JS. Backslash is now escaped first.
- **`safari_set_cookie` / `safari_set_local_storage` / `safari_set_session_storage` / `safari_delete_cookies`**: keys/values containing a backslash produced invalid JS (only `'` was escaped). Backslash is now escaped first.
- **`safari_get_computed_style`**: CSS property names were interpolated into injected JS unsanitized — now escaped.
- **`safari_navigate` / `safari_new_tab` / `safari_navigate_and_read`**: URLs were only quote-escaped — a backslash or newline could break out of the AppleScript string literal (potential AppleScript injection). Now backslash-escaped and CR/LF stripped.
- **Extension snapshot**: page-controlled attribute values (`aria-label`, `title`, `value`, `href`, …) are now HTML-escaped, so a crafted attribute can't inject a fake `ref=`/`role=` into the snapshot and steer the agent to the wrong element.
- **Extension ref lookup**: attribute values are escaped and the query is guarded, so a page-controlled `aria-label`/`name`/`placeholder` containing `"` no longer throws a DOMException that surfaced as a misleading "element not found".

#### Filesystem safety
- **`safari_save_pdf`**: now validates the output path (allowlist + sensitive-path block) — it could previously overwrite any file. The Python conversion receives paths via `argv` instead of interpolating them into source (the old shell-style escaping was wrong for a Python `-c` string and broke on any path containing a quote).
- **`_validateFilePath`**: the `..` check was dead (`path.resolve()` already strips `..`); it now rejects traversal in the raw input and resolves symlinks, so a symlink under `/Users/` pointing outside the allowlist is caught.
- **Temp-file leaks**: `safari_screenshot_element` (crop) reconstructed the wrong filename and leaked it on error; `safari_upload_file` never deleted the PNG produced by image conversion. Both now clean up.

#### Tab safety & focus
- **Tab-ownership same-origin hole**: once the session opened a single tab on an origin (github.com, google.com, …), *every* tab on that origin — including the user's own — counted as owned, so a click/fill could land in the user's tab. The over-broad rule was removed; same-origin redirects remain covered by the path-prefix check.
- **`safari_wait_for_new_tab`** never registered the found tab as owned, so the next interaction (e.g. after an OAuth popup) was blocked by the tab-safety guard. It now tracks ownership.
- **Focus restore** runs in `finally` inside `extensionOrFallback`, so a failed operation that brought Safari to the front still hands focus back.
- **Clipboard restore** for native paste runs in `finally` — if the helper daemon dies mid-paste, the user's clipboard is restored instead of being left with the tool's text.

#### Robustness
- **HTTP body-size guard** could call `res.writeHead(413)` twice on one oversized request (`ERR_HTTP_HEADERS_SENT`); guarded with `res.headersSent`.
- **Extension poll loop**: a single malformed `/poll` body used to tear down the loop and trigger a multi-second reconnect — it's now skipped. The safety-timeout path uses `continue` instead of re-entering `pollForCommands()` (no overlapping loops).
- **Extension navigate**: sparse pages that are OAuth/redirect callbacks (`code=`/`token=`/`state=` in the URL) are no longer hard-reloaded — the reload dropped POST data and could re-submit forms.
- **`safari_get_local_storage` / `safari_get_session_storage`** no longer throw on a key whose value is `null`.
- Window IDs are validated numeric before reaching `do shell script "screencapture -l<id>"`.
- Stale-detection and proxy-recheck timers are `unref()`'d, so they never keep the Node process alive on their own.
- **Extension Trusted-Types policy** registers only `createScript` now (dropped the unused, world-accessible `createHTML`/`createScriptURL` pass-throughs).

### Deferred (tracked, intentionally not changed here)
- The local HTTP/WebSocket bridge has no auth token — any local process can drive it. The CORS guard already blocks web pages (browsers always send an `Origin`), but a no-`Origin` local request passes. A proper fix needs a native-messaging handshake or a Unix-domain socket and is tracked separately, to avoid breaking the extension transport.
- `manifest.json` `host_permissions: ["<all_urls>"]` is broader than the `http(s)` the bridge needs; narrowing it may force a permission re-grant on installed extensions, so it's deferred.

## [2.11.9] - 2026-05-28

### Fixed

- **MCP `initialize` handshake no longer blocks on profile-window detection at startup.** When launched with `SAFARI_PROFILE=<name>`, the server used to run `await refreshTargetWindow(true)` on the module's top-level await before the stdio loop began responding to the MCP `initialize` request. That call shells out to AppleScript to enumerate Safari windows and match the profile — typically ~50–200ms, but it could exceed 30s if Safari was busy (Spotlight indexing, heavy tab churn, AppleScript daemon stalled). When it did, Claude Code's 30-second MCP handshake timeout fired, the server was killed, and `safari-*` tools silently disappeared from the conversation's tool catalog until the user started a new Claude Code session. The detection now runs in a fire-and-forget async IIFE so module init completes immediately; tool calls that arrive before it finishes already trigger lazy refresh inside `getTargetWindowRef()`, so the targeting behaviour is unchanged.

## [2.11.7] - 2026-05-26

### Fixed

- **Focus theft eliminated on macOS Tahoe.** Three independent gaps in the focus-preservation pipeline let Safari steal the user's foreground app during routine tool calls (`safari_navigate`, `safari_read_page`, `safari_snapshot`, `safari_screenshot`, and any tool that ultimately ran an AppleScript). On Tahoe, Safari implicitly activates itself when an AppleScript mutates one of its windows (`set URL`, `set bounds`, `set current tab`) and `screencapture -l<id>` flashes the window forward mid-capture, so the pre-existing save/restore had race windows that became visible to the user every few calls.
  - **`osascriptFast` is now focus-guarded.** It is the hot path (~5ms via the persistent Swift daemon, 18× faster than the subprocess fallback) and is called from `safari_navigate`, `safari_snapshot`, the tab-resolution layer, the profile-window detector, and dozens of internal helpers. It previously had no guard at all — only the slower `osascript` subprocess wrapper saved and restored the frontmost app. Added a mirror guard gated on `!_focusGuardActive` so nested calls inside `extensionOrFallback` / `runJSLarge` still skip duplicate save+restore work.
  - **Awaited restores.** Three sites (`osascript` subprocess, `runJSLarge`, `screenshot`'s screencapture path) previously called `_helperActivateApp(prev).catch(() => {})` without awaiting. `NSRunningApplication.activate()` is async at the OS level, so the function returned to user-space while Safari was still frontmost — keystrokes during the ~5–50ms race landed in Safari. All three now `await restoreFocusIfStolen(prev)`.
  - **Verify-and-hide fallback inside `restoreFocusIfStolen`.** macOS Tahoe's window-server policy can silently block `NSRunningApplication.activate()`, leaving the previously activated app stuck behind Safari. The function now: activates the saved bundle → settles 5ms (Tahoe needs time to honor the activate) → re-reads frontmost → falls back to `_helperHideSafari()` only if Safari is still on top. Hiding Safari is reliable because the OS auto-picks the next app — which is the one we saved.
- **Background profile-window polling no longer participates in focus-guard.** Every 3 seconds the server polls `tell application "Safari" to return name of window N` to detect profile-window changes. Once `osascriptFast` became focus-guarded this poll became a tiny ~5ms window during which a manual user switch to Safari could be misread as "Safari stole focus" and trigger the hide fallback against them. The polling now passes `noFocusGuard: true` because the script is read-only and provably can't activate Safari.

## [2.11.6] - 2026-05-26

### Security

- **Bumped transitive `qs` 6.15.0 → 6.15.2** via `npm audit fix` to close [Dependabot alert #18](https://github.com/achiya-automation/safari-mcp/security/dependabot/18). `qs` ships with Express (pulled in by `@modelcontextprotocol/sdk` for the HTTP control surface); `qs.stringify` would crash with a `TypeError` on null/undefined entries inside comma-format arrays when `encodeValuesOnly: true`. `safari-mcp` does not set that option, so this was not exploitable in our code path, but the upgrade clears the alert and any downstream user that does set it. No API changes.

## [2.11.5] - 2026-05-26

### Security

- **Bumped `ws` 8.20.1 → 8.21.0** to pick up the upstream fix for a remote memory-exhaustion DoS (CVE-class issue, responsibly disclosed by Nadav Magier). A peer streaming a high volume of tiny fragments or data chunks over modest network traffic could OOM a `ws` server or client. `safari-mcp` uses `ws` for the Safari extension WebSocket bridge, so the receiving side now caps retained fragments and chunks. No API changes.

## [2.11.4] - 2026-05-25

### Fixed

- **`/proxy-command` no longer leaks commands to the wrong Safari profile.** Secondary MCP instances and external HTTP clients can call this endpoint to route a command through the primary instance's extension WebSocket. The endpoint sent every command straight to `sendToExtension()` without checking `SAFARI_PROFILE`, so when the host instance was configured to target a specific profile but the connected extension belonged to a different profile window (e.g. the user's "personal" profile happened to be the one that won the extension-connect race), the command executed in the wrong profile — silently. A real example: a skill ran 8 parallel safari-mcp instances, the MCP tools failed to register, the skill fell back to direct `POST /proxy-command` calls, and every Reddit action ran against the personal profile's Reddit session instead of the dedicated automation profile. `/proxy-command` now returns HTTP 503 with a clear message when `SAFARI_PROFILE` is set on the host, pointing callers at the `safari_*` MCP tools — those route through AppleScript when a profile is configured and stay inside the configured profile window. Secondary instances running under the same `SAFARI_PROFILE` already skipped `/proxy-command` (because `_preferAppleScript` forced the AppleScript path), so they're unaffected; the gate only blocks callers that would have crossed the profile boundary.

## [2.11.3] - 2026-05-19

### Fixed

- **`safari_select_option` now reaches native `<select>` elements inside iframes and shadow DOM.** The tool resolved its target with a plain top-frame `document.querySelector(selector)`, so a `<select>` rendered inside an iframe (for example an embedded Salesforce/Lightning support form) or a shadow root was unreachable — every call returned `Element not found`, even though `safari_snapshot` had captured the element and `safari_click` could resolve it. `safari_select_option` now accepts a `ref` (from `safari_snapshot`): the ref path resolves the element through `mcpFindRef` — the same deep finder `click` uses, which traverses shadow roots and same-origin frames — and the selector path falls back to `mcpQuerySelectorDeep`. Pass `ref` for any select a top-document selector cannot reach.

## [2.11.2] - 2026-05-18

### Fixed

- **Concurrent MCP instances no longer kill each other on startup.** Each `safari-mcp` process used to `SIGTERM` every other instance running more than 10 seconds, to clear "stale" processes from previous sessions. But concurrent instances are supported by design — the first to bind the HTTP port becomes the extension host and the rest proxy commands through it — so this kill was wrong: with multiple Claude Code sessions open, or a restart racing the previous instance, each new process disconnected the others mid-task and the MCP server showed up as "not connected". The cross-instance kill is removed entirely; every instance is already cleaned up by its own MCP client on shutdown.
- **`safari_evaluate` now resolves single-line async scripts that end in a bare expression.** A script such as `const r = await fetch(url); r.status` — multiple statements separated by `;` on one line — returned `(no return value)`: the return-injection only scanned newline-separated lines, so a single line beginning with `const`/`let` was left without a return slot and the async IIFE discarded the trailing expression. `evaluate` now also splits at the last top-level `;` — skipping `;` inside strings, template literals and `for (;;)` headers — so the final expression becomes the awaited result.

## [2.11.1] - 2026-05-18

### Fixed

- **Blank tabs opened via `safari_new_tab` no longer trip "no tabs opened yet" after an MCP process restart.** A tab opened without a URL stays on `about:blank`, which has no unique identity and so was never written to the persisted ownership file (`~/.safari-mcp/owned-tabs.json`). When the host recycled the MCP process, the in-memory `_openedTabs` map was wiped and nothing in the ownership file restored it — every subsequent navigate/click/read was blocked with `Tab safety: no tabs opened yet`, even though the session had legitimately opened a tab. Opening a blank tab now persists a `__mcp-blank-tab__` sentinel (TTL-bounded like every other ownership entry). The sentinel is never a real tab URL, so it cannot falsely match a user's page in `_isURLOwned()`; it only keeps blank-tab ownership alive across a restart.
- **Unhandled promise rejections no longer crash the MCP process.** A single failed async operation — a proxy fetch to the primary instance mid-restart, or an aborted fetch timeout — bubbled to the `uncaughtException` handler (Node's default path for unhandled rejections) and exited the whole process, disconnecting every concurrent session. A dedicated `unhandledRejection` handler now logs the failure and continues: the failed operation stays localized, the process stays healthy.

## [2.11.0] - 2026-05-17

### Fixed

- **Tab targeting no longer drifts to the user's tab during concurrent browsing.** When the user switched Safari tabs while the agent was working, `resolveActiveTab()` could silently resolve to the wrong tab — the agent's reads, clicks and navigations landed on the user's page. Root cause was a chain of fragile heuristics (cached index → tracked URL → `window.__mcpTabMarker`), each of which breaks under concurrent activity: indices shift when the user inserts a tab, the tracked URL is ambiguous when the user has a same-domain tab open, and `window.__mcpTabMarker` is wiped by every navigation. Tab identity reworked:
  - The session tab is now marked with `window.name` as well as `window.__mcpTabMarker`. `window.name` survives full same-origin navigations, redirects and reloads, so the marker is no longer lost on every page load.
  - `resolveActiveTab()` finds the marked tab with a single AppleScript call that loops every tab internally — was N separate daemon round-trips, slow and prone to mis-resolving when a daemon call hiccupped mid-scan. Falls back to a reliable `osascript` subprocess if the daemon call fails.
  - **Fail-safe:** when the marker and URL can no longer positively identify the session tab, resolution refuses to return a stale index — `runJS` throws a clear re-anchor error instead of silently operating on whatever tab now sits at that index.
  - `navigate()` captures its tab index once and targets it explicitly for every internal `runJS`, instead of re-resolving mid-navigation. A cross-origin load transiently clears `window.name` and the tracked URL is stale until the new page settles, which previously made `navigate` lose its own tab.
  - `newTab()` polls `document.readyState` from the Node side before stamping the marker. The previous in-page wait loop was an `async` IIFE that `do JavaScript` never awaits, so it returned immediately and the marker was stamped onto a still-loading page and lost.
  - Tab-ghost recovery now matches Safari's typographic apostrophe (`Can’t`, U+2019); the plain-ASCII check never matched, so `Can’t get tab N` errors silently skipped recovery.

- **`safari_click` no longer reports success when the click was silently ignored.** Sites that gate handlers on `event.isTrusted` (Clutch, G2, Cloudflare-class WAFs) drop synthetic `dispatchEvent` / `.click()` events without error, so `click()` returned "Clicked: …" while nothing happened. `click()` now captures a synchronous page fingerprint (URL, element count, DOM size, focused element) on both sides of the click and reports whether a React handler fired or the page observably changed. When a synthetic click triggers no handler and no effect — re-checked once after a 320ms async grace window — it escalates automatically to a real OS-level CGEvent click (`isTrusted: true`) instead of falsely claiming success.
- **`safari_evaluate` now resolves async scripts instead of returning "(undefined)".** AppleScript `do JavaScript` returns the moment the synchronous portion of a script finishes — it never awaits a Promise — so any script using `await`, `.then()` or a leading `async` had its result discarded. Async scripts are now started fire-and-forget into a page global, and that global is polled synchronously from the Node side until the work settles (the same mechanism `navigate()` uses). The expression normalizer is shared between the sync and async paths: a multi-line script whose last line is `})()` no longer crashes with a `return })()` syntax error, and `fetch(` on its own is no longer misclassified as async (an un-awaited fetch is fire-and-forget), so a sync IIFE that merely mentions `fetch` keeps its return value.
- **`safari_wait_for` actually waits now.** Its in-page wait loop was an `async` IIFE that `do JavaScript` never awaits, so the tool checked the page exactly once and returned immediately — reporting success without ever waiting. The wait loop now runs on the Node side, re-evaluating a single synchronous check against the page each tick until the selector/text appears or the timeout elapses.
- **`navigate` no longer reports a stale page as a successful navigation.** The URL is set through the Swift helper daemon; a cold or crashed daemon could make that `set URL` silently no-op. `navigate` then polled `document.readyState`, saw the OLD page already `complete`, and returned it as if the navigation had succeeded. `navigate` now records the pre-navigation URL — if the page never leaves it, it retries the `set URL` once through the daemon-independent `osascript` subprocess, then throws a clear error if the page still did not move instead of silently returning the wrong page.

### Added

- **Visibility spoofing keeps backgrounded tabs rendering.** The agent's tab is almost always backgrounded while the user browses, and many SPAs (the Meta/Facebook developer console is the canonical case) blank or stop laying out their main content when `document.visibilityState` is `hidden`. Every stamped tab now has `document.visibilityState` / `document.hidden` pinned to `visible` / `false` and `visibilitychange` events suppressed, so a backgrounded automation tab keeps rendering normally.

### Changed

- Swift-helper daemon requests are serialized on the Node side so FIFO response/callback matching holds regardless of the helper's execution model.

## [2.10.9] - 2026-05-14

### Fixed

- **Stable codesign identifier for Accessibility-permission persistence.** The shipped `safari-helper` binary is adhoc-signed with a hash-based identifier (e.g. `safari-helper-555549441c166aa237e130ddbe3d95629266ecaf`). macOS TCC keys Accessibility grants by that identifier, so every `npm install` / rebuild silently invalidated any previously-granted approval — the helper kept reporting success but CGEvent injections never reached non-frontmost Safari content (no `isTrusted` events fired on the page). The PartnerStack network application drawer was the canonical reproducer. `scripts/postinstall.cjs` now re-signs the helper with the fixed identifier `com.achiya-automation.safari-mcp` (preserving entitlements) so the Accessibility grant persists across upgrades. README now documents the one-time `Accessibility → +` step explicitly under "Granting Accessibility to safari-helper".

## [2.10.8] - 2026-05-14

### Fixed

- **Dynamic toolbar height for native click coordinates.** `_getSafariWindowGeometry` previously hardcoded `toolbarHeight: 74` for screen→viewport translation. On modern Safari (Sequoia+) the actual chrome above content is ~90 px, so `safari_native_click` was landing ~16 px above its target — close enough to hit a row but often missing button hit-targets, so the click silently no-op'd. Now computes `outerHeight - innerHeight` from JS at call time and uses that, with a 50–200 px sanity range and fallback to 74 if JS is unreachable. Restores reliable native_click on PartnerStack's network application drawer and any layout where buttons sit close to whitespace.

## [2.10.7] - 2026-05-14

### Fixed

- **Vue 3 v-model checkbox/radio sync.** `mcpClick` was calling `target.click()` and dispatching a synthetic click event for checkboxes and radios, but in some production-stripped Vue 3 apps (PartnerStack network application drawer is the canonical case) the v-model reactive binding silently dropped the state update — the DOM `.checked` flipped, but Vue's internal proxy state never updated, so the next form submission saw the OLD selection. Belt-and-suspenders: after the click, explicitly redispatch `input` and `change` events with `composed: true` (crosses Shadow DOM and Vue Teleport portals) and reset React's `_valueTracker` for the shared React-checkbox case. Restores reliable Next/Submit progression on multi-step Vue forms that gate validation on checkbox state.

## [2.10.6] - 2026-05-14

### Added

- **`safari_react_select_set`** — set a value in a react-select v5 dropdown by walking React fiber up from the target element to find the Select component, then invoking `onChange` directly with the matching option. Bypasses the menu UI entirely. Critical for forms where `safari_click` on the dropdown chevron stops responding after a few rows (Cloudflare custom token form is the canonical case — the indicator's pointer/click handlers silently no-op past row 4 even though the elements still have valid React fibers). Match priority: exact label → exact value → case-insensitive label. Returns `{ok, selected}` on success, or `{ok:false, error:'option not found', available:[…]}` listing up to 30 labels on miss. Either `ref` or `selector` required.
- **`safari_react_select_list_options`** — companion read-only tool. Returns `{ok, total, options:[{label,value}…]}` without opening the menu. Useful when `set` returns "option not found" and you need to see the exact labels (e.g. `Email Routing Rules` vs `Email Routing`).
- **`mcpReactSelectFindInstance` / `mcpReactSelectFlatten` / `mcpReactSelectSet` / `mcpReactSelectListOptions`** — underlying page-injected helpers. Bumps `__mcpVersion` to 6 so existing pages re-inject on next `ensureHelpers`.

### Implementation notes

The fiber walk has two passes: outer DOM-parent traversal (up to 25 levels) and inner fiber `.return` traversal (up to 60 hops) at each DOM level. This covers portal-rendered Select components where the React tree and DOM tree diverge. Grouped options (`{label, options:[…]}`) are flattened before matching. The synthetic action object passed to `onChange(target, action)` mirrors react-select's own `{action:'select-option', option, name}` shape so consumers that branch on `action.action` behave correctly.

### Fixed

- `ensureHelpers` check now requires `mcpReactSelectSet` in addition to `mcpClickWithReact` and `mcpFindText`, forcing re-injection on pages still holding the v5 helpers.

## [2.10.5] - 2026-05-12

### Security

- **Upgrade `fast-uri` 3.1.0 → 3.1.2 (CVE-2026-6321 / GHSA-q3j6-qgpj-74h6).** Resolves host-confusion via percent-encoded authority delimiters and path-traversal via percent-encoded dot segments. fast-uri is transitively pulled through `hono`'s URL parsing on the extension's lightweight HTTP surface.
- **Upgrade `hono` 4.12.14 → 4.12.18.** Rolls up multiple advisories — CSS declaration injection via JSX SSR style object values, JWT NumericDate claim validation in `verify()`, cache middleware ignoring `Vary: Authorization` / `Vary: Cookie`, JSX tag/attribute name HTML injection, non-breaking-space cookie-name bypass, `setCookie` cookie-name validation, IPv4-mapped IPv6 matching in `ipRestriction()`, repeated-slash bypass in `serveStatic`, path traversal in `toSSG()`, and `bodyLimit()` bypass for chunked / unknown-length requests.
- **Upgrade `ip-address` 10.1.0 → 10.2.0.** XSS in `Address6` HTML-emitting methods.

### CI

- **`npm audit` gate now fails the build on `high` or `critical` advisories in production dependencies.** Previously the gate logged but did not fail. Catches future Dependabot misses earlier.

No user-facing behavior changes. Recommended reinstall for transitive-dependency hardening.

## [2.10.4] - 2026-05-08

### Fixed

- **`safari_fill` no longer loses middle paragraphs in ProseMirror/Tiptap editors with no view access (Hashnode-style).**
  When a ProseMirror-based editor doesn't expose its `view` via `pmViewDesc` or React Fiber walk (Hashnode's contenteditable has neither), `safari_fill` previously fell through to char-by-char `beforeinput` + `execCommand('insertText')` per line. On multi-paragraph content with markdown-like first characters (`>`, `**`, `[`), the editor dropped middle paragraphs silently — the result was the first paragraph + a chain of empty paragraphs + the last paragraph. The fix verifies actual content length after the char-by-char pass; if the rendered text is less than 60% of the expected value length, it clears the editor and re-fills via `execCommand('insertHTML')` with paragraph-wrapped HTML. The new return marker `Filled CE (ProseMirror insertHTML fallback, <actual>/<expected>)` makes the path observable.
  Originally surfaced cross-posting a dev.to article body to a Hashnode draft — char-by-char filled 446 chars out of an expected 6800+, retaining only the first and last paragraphs.

- **`safari_fill` synthetic-paste path now explicitly clears pre-existing content before paste.**
  X's `tweetTextarea_0` at `/intent/post?text=...` pre-fills the textarea with the URL's `text` parameter before the page settles. Previous fill logic positioned cursor at the end of the existing content (via `selectNodeContents` + collapse) but didn't delete the selection before dispatching the synthetic `paste` event — most editors replace selection on paste, but X's React handler appended, resulting in duplicated text (`<URL prefill> <safari_fill value>`). The fix adds an explicit `document.execCommand('delete', false, null)` after the selection is set and before the `ClipboardEvent('paste')` dispatch. Affects any contenteditable whose initial content needs to be replaced via the synthetic-paste path (Quill in some configurations, X composer with URL-prefilled text, similar React-driven editors).

## [2.10.3] - 2026-05-06

### Fixed

- **Permanent tab-safety guard: `safari_navigate` (and friends) can no longer overwrite the user's active tab when MCP tab tracking is lost mid-session.**
  Previously, a 30-second `NEW_TAB_GRACE_MS` window guarded against fallback to "current tab of window" only briefly after `safari_new_tab`. After the grace expired, if `_activeTabIndex` was lost (e.g. the tab-ghost recovery path in `runJS` nullified it), `navigate` silently fell back to the user's current tab via `getFallbackTarget()` — and clobbered whatever page the user was working on.
  The fix introduces a session-scoped `_hasOwnedTab` flag set permanently the first time `safari_new_tab` succeeds. Once true, the four entry points that can target a tab — `_assertNotFallingBackToUserTab` (used by `navigate` and `navigateAndRead`), `runJS`'s tab-ghost fallback path, and `runJSLarge` — refuse to fall back to the user's current tab. They throw a descriptive error instead, prompting the caller to re-open a tab via `safari_new_tab`.
  Sessions that never call `safari_new_tab` (e.g. tools that operate on the user's current tab intentionally) are unaffected — the front-document fallback still works for them.
  Originally surfaced by an incident where `safari_navigate('https://old.reddit.com/...')` called ~30 minutes into a session navigated the user's localhost dev tab (which they had clicked back to between commands) instead of the MCP-owned tab.



### Fixed

- **`safari_fill` now handles Quill editors (the LinkedIn share composer 2026 reality).**
  LinkedIn migrated their post composer from ProseMirror to Quill in 2026, which made
  the v2.10.0 ProseMirror-targeted fix inapplicable to LinkedIn. Worse, fill attempts
  on Quill's contenteditable surface crashed the Swift helper daemon and dismissed the
  composer dialog. The fix detects `.ql-editor` ancestors first, locates the Quill
  instance via `.ql-container.__quill` (Quill 2.x) or by walking React Fiber
  (`memoizedProps.quill` / `stateNode.quill`), then commits the value through
  `quill.setContents(delta, 'api')` — bypassing the clipboard, generating no synthetic
  events, and respecting Quill's internal Delta state. If the Quill instance can't be
  located via direct or Fiber access, fill routes to `__NATIVE_PASTE_DIALOG__` (CGEvent
  Cmd+V) — Quill respects real isTrusted clipboard events. Verified post-fill that the
  Quill text actually committed; on mismatch the function returns the same fallback
  signal the wrapper uses for ProseMirror dialog-paste fallback.

## [2.10.1] - 2026-05-01

### Fixed

- **Tab tracking bug — new_tab + navigate could overwrite the user's active tab.** When
  `safari_new_tab(url)` was called with a URL that didn't load (file:// blocked by Safari,
  network error, etc.), the new tab stayed at about:blank, the marker injection ran in a
  context that was wiped by the next navigation, and the very next `safari_navigate` lost
  track of which tab was ours and silently fell back to "current tab of window" — i.e. the
  user's active tab. Real-world impact: testing v2.10.0 on the developer's own machine
  overwrote two of his open tabs (Chatwoot Meta Dashboard, n8n executions).

  Fixes:
  - New `_lastNewTabAt` grace window (30s) — within this window, ANY mutating operation
    that would otherwise fall back to the user's tab now throws a clear error pointing
    back to safari_new_tab. No more silent retargeting.
  - `safari_navigate` re-injects `window.__mcpTabMarker` after every successful navigation,
    so subsequent `resolveActiveTab` marker checks find the tab even after JS context
    was wiped by the navigation.

- **Trusted Types pages (Google Search Console, modern Google admin, banks).** Strategy 2
  of the extension's `evaluate` flow used to call `trustedTypes.createPolicy("mcpEval", …)`
  AFTER the page loaded, which fails on pages that reject new policy creation post-load.
  Now the content script (MAIN world, document_start) pre-registers `__mcpTrustedPolicy`
  BEFORE the page sets `require-trusted-types-for`, and Strategy 2 reuses it. Pages that
  used to silently fail under CSP-strict rules now have a working evaluation path. Take
  effect: reload the Safari extension after upgrading.

## [2.10.0] - 2026-05-01

### Added

- **`safari_verify_state` tool — verify framework state before Submit.** Modern editors
  (ProseMirror, Lexical, Closure, React-controlled inputs) keep state separately from the
  DOM. `el.value` or `el.textContent` can show new text while the framework store still
  holds the old value, so a Submit click sends stale data. Call `safari_verify_state`
  AFTER `safari_fill` and BEFORE clicking Submit; it returns
  `{match, mode, actual, expected, hint?}`. Modes: input, prosemirror, lexical, closure,
  contenteditable. The `hint` field surfaces `_valueTracker` desync — the most common
  Featured.com / Next.js RSC failure mode.

- **Auto-conversion of webp/heic/tiff uploads when the target rejects them.** `safari_upload_file`
  now reads the input's `accept` attribute. If the format isn't accepted (Quora's classic
  `accept="image/png,image/jpeg"` rejects webp), the file is converted to PNG via macOS
  `sips` (no extra deps) before encoding. No-op when `accept` is empty, `image/*`, or
  already includes the source format.

- **Native `<select>` guard in `safari_click`.** LinkedIn-style "select your industry"
  dropdowns look custom but are real `<select>` elements. Calling `.click()` on them
  hands off to the OS option list, which blocks AppleScript until dismissed → tool
  timeout. The click pipeline now detects `SELECT` early and throws a directive error
  pointing at `safari_select_option` plus the first 8 option labels.

### Fixed

- **`safari_fill` standard input/textarea path — Featured.com / HubSpot Formik / React 18.**
  Three coupled bugs caused silent value-mismatch on Next.js RSC and Formik forms:
  1. **`focus` was dispatched LAST** (after `blur` + `focusout`). Formik's onBlur
     validation runs on focused-state transition; firing focus after blur left the field
     in a stale state and validation never re-ran.
  2. **Plain `Event('input')` instead of `InputEvent`.** React 18's reconciler checks
     `inputType` and `data` on input events; without them, the controlled component's
     internal store rejects the change as "not a real edit."
  3. **No `composed: true`.** Events stayed inside Shadow DOM and never reached the
     framework's listeners on the host.

  All three fixed: focus first, real `InputEvent` with `inputType:"insertReplacementText"`
  + `data`, `composed: true` on every dispatched event, and post-fill verification that
  routes to native CGEvent Cmd+V paste if `el.value` doesn't match expected.

- **`safari_fill` ProseMirror dispatch verification.** LinkedIn's PM occasionally accepts
  the `tr.insertText` dispatch but rolls it back on the next tick (its readOnly plugin
  reasserts state). The dispatcher now reads back `view.state.doc.textContent` after
  `dispatch()`; if the value isn't present, fill falls through to `__NATIVE_PASTE_DIALOG__`
  → CGEvent Cmd+V (real isTrusted events).

- **`safari_fill` Reddit nested Shadow DOM events propagate.** All input/change/blur events
  ship with `composed: true`, so nested closed-shadow textareas (Reddit appeals reaches
  4 levels deep) actually notify host listeners.

- **`safari_fill_form` batch — was missing `_valueTracker` and InputEvent.** The single-call
  variant of `fill_form` skipped React state-sync entirely (only the contenteditable branch
  had treatment). Fixed: same setter + InputEvent + composed dispatch + dialog-aware blur
  as the per-field `safari_fill`. Also: prototype-correct setter for textarea and select,
  deep-query through Shadow DOM, and reports `PARTIAL` when post-fill `el.value` doesn't
  match expected.

- **Closure / Medium detection broader.** Used to only match `closure_uid_` keys on the
  element itself or `medium.com` hostname. Now also matches `closure_lm_` keys, walks 10
  levels of ancestors for closure markers, and falls back on `window.goog.events` /
  `window.goog.editor` globals — covers Closure-built editors outside Medium.

- **`mcpReactClick` Fiber walk — React 18 portals (HackerNoon Submit, Radix dropdowns).**
  The synthetic event used to omit `isDefaultPrevented()` / `isPropagationStopped()` methods
  React 18 internally checks. Some portal-rendered components silently no-op when those are
  missing. Now produces a fully-React-18-compatible SyntheticEvent (real
  `MouseEvent`/`PointerEvent` as `nativeEvent`, working flag accessors, `composed: true`,
  pageX/Y, screenX/Y, modifier keys). The walk also tries `onPointerDown` → `onMouseDown`
  → `onMouseUp` → `onPointerUp` → `onClick` in sequence — covers components that open the
  modal on pointerDown and commit on click. Fiber walk depth doubled (15 → 30) and now
  also reads `stateNode.props` for forwardRef components.

### Documented hard limits (still need manual fallback)

- **XPC Web Inspector Protocol.** Apple gates access with a private entitlement; no
  legitimate workaround exists. `safari_evaluate` continues to use AppleScript `do JavaScript`.
- **Trusted Types pages (Google Search Console, modern Google admin consoles).** Pages
  with `require-trusted-types-for 'script'` reject both `do JavaScript` and extension-issued
  evals when the policy is enforced page-wide. Recommended fallback is `safari_snapshot` +
  `ref`-based interactions which don't require JS execution.

## [2.9.3] - 2026-04-22

### Added

- **Lexical editor support (LinkedIn share composer, Meta/Shopify apps).** `safari_fill`
  locates the Lexical editor instance via three cascading strategies: (A) `[data-lexical-editor="true"]`
  ancestor with a `__lexicalEditor` property, (B) DOM-ancestor walk for the same property on
  nested wrappers, (C) React Fiber walk — duck-types any object on props/state/stateNode that
  exposes both `parseEditorState` and `setEditorState`. Once found, it drives the editor via
  its own API — entirely in-page, no CGEvent, no focus shift. Two fill strategies, both pure
  DOM events (the dialog stays open):
    1. Dispatch `beforeinput` with `inputType:"insertFromPaste"` + a synthetic `DataTransfer`.
       Lexical's `handleBeforeInput` reads `dataTransfer.getData('text/plain')` and commits
       through `editor.update()` internally, so state + DOM stay in sync.
    2. Fallback: `editor.parseEditorState()` + `editor.setEditorState()` with a minimal
       `root → paragraph → text` doc. Used when Lexical's paste path ignores the synthetic
       event (some wrapper configurations).

  Why this matters: LinkedIn's composer is a `[role="dialog"]` with a `focusout` listener
  that dismisses the modal. Our previous CGEvent Cmd+V path pasted the text correctly but
  caused the dialog to close mid-paste (the Safari window-activation side-effect briefly
  fired `focusout` on the editor). Lexical's own API never touches focus, so the dialog
  stays open and the Post button becomes enabled.

### Fixed

- **`safari_fill` now survives inside dialog-hosted rich editors.** Three issues previously
  made LinkedIn posting impossible:
  1. The contenteditable fallback dispatched a `blur` event at the end — LinkedIn's composer
     listens for `focusout` and dismissed the dialog, so every fill closed the post box.
  2. When ProseMirror was detected but its `EditorView` could not be reached via `pmViewDesc`
     or the React Fiber walk, fill fell back to `beforeinput`+`execCommand` char-by-char.
     Those events are `isTrusted:false` and ProseMirror's paste handler rejects them — text
     never landed in editor state.
  3. The synthetic `ClipboardEvent('paste')` returned "Filled CE (synthetic paste)" even when
     ProseMirror called `preventDefault` without accepting the payload.

  Primary fix is the Lexical path above. For ProseMirror editors whose view is not reachable,
  contenteditables inside `[role="dialog"]` now route to `_nativeTypeViaClipboard` (CGEvent
  Cmd+V, `isTrusted:true`) as a last resort. The `blur` dispatch is removed — React detects
  the change from `input` alone.

### Changed

- Default contenteditable fill no longer dispatches `blur`. This also fixes silent dismissal
  of other popover editors (Twitter/X composer, Medium inline-reply) that treated the blur
  as "user clicked away".

## [2.9.2] - 2026-04-21

### Documentation

- Added **Commercial Support** section to README — priority bug fixes, integration
  consulting, private deployment support, and training workshops for teams building
  on Safari MCP. Part of the OSS-to-services lead funnel pattern (Plausible, Cal.com,
  Documenso, Supabase).

## [2.9.1] - 2026-04-20

### Added

- **`safari_reload_extension` — hot-reload the Safari extension from disk.** After editing
  `extension/background.js` or `extension/content.js`, call this tool to trigger
  `browser.runtime.reload()` inside the extension. Safari re-reads the files from disk and
  the WebSocket auto-reconnects within ~2 seconds. Eliminates the manual toggle dance in
  Safari → Preferences → Extensions after every code change. This is the final piece that
  makes safari-mcp self-updating — once v2.9.1+ is loaded once, all future extension code
  changes deploy with a single MCP call.

## [2.9.0] - 2026-04-20

### Added

- **`safari_snapshot` — auto-detect open top-layer modals/dialogs.** When a dialog is visible
  (dialog[open], [role="dialog"], [aria-modal="true"], Radix/Headless/MUI containers, or
  Google's `c-wiz[role="dialog"]` / `[jscontroller][aria-modal]` overlays), the snapshot
  now walks the modal FIRST so its refs appear at the top of the tree. Solves the pattern
  where clicking a button opens a dialog but `snapshot` returns only the page behind it
  (common with Google Business Profile, Google Drive editors, Airtable rich dialogs).
  Deduplicates nested modals — the outermost visible modal wins.

## [2.8.9] - 2026-04-20

### Security

- Bump `hono` override from `^4.12.12` to `^4.12.14` to silence dependabot alert #9
  (GHSA: hono/jsx SSR HTML injection via improperly handled JSX attribute names).
  Not exploitable at runtime — safari-mcp only loads `StdioServerTransport` and does
  not render JSX on the server — but the pin is refreshed for clean `npm audit`.

## [2.8.8] - 2026-04-20

### Changed

- **`safari_replace_editor` — React wrapper onChange sync for Monaco embeds.** Two-channel
  write strategy: Monaco `model.setValue()` for the visual + walk the React fiber up from
  `.monaco-editor` until a component with `onChange` + `value` props is found, then call
  its `onChange(text)` to sync React state. Solves the "DOM updated, state stale" pattern
  on sites that wrap Monaco in React (Airtable automations, custom admin UIs) where the
  "Save" button reads from React state, not from the Monaco model.
- Preflight returns a structured JSON status (`{domOk, reactSynced, reactGuarded, hasWrapper, ...}`)
  so callers can distinguish plain Monaco embeds (`Monaco(model)`) from React-wrapped ones
  (`Monaco(model+react)`) and gracefully fall back to the native-paste CGEvent path when the
  wrapper's `onChange` is guarded (readOnly / permission check / no-op).
- Verification tightened: the React sync is only reported successful when the wrapper's
  `value` prop actually changes after the `onChange` call. If `onChange` silently swallows
  the write (common on readOnly previews), `reactGuarded=true` is reported and the fallback
  CGEvent Cmd+A/Cmd+V path runs — no false positives.

## [2.8.5] - 2026-04-19

### Changed

- **README: above-the-fold rewrite applied** — research-backed overhaul of the hero section based on patterns from the top non-corporate MCP projects (Context7 49K⭐, Serena 23K⭐, Desktop Commander 5.9K⭐, BrowserMCP 6K⭐):
  - **Tagline:** shortened from 11 words ("The only MCP server for Safari — native browser automation for AI agents") to a Serena-style category claim: **"The browser for your coding agent."** A second italic line (*"Your real Safari, logged in — no Chrome, no heat, no headless."*) carries the three wedges.
  - **Badges:** reduced from ~10 above the fold to 4 core badges (npm version, downloads, MIT, macOS). Registry/Glama/Awesome/HackerNoon/CLI-Anything moved to the "Listed On" section at the bottom where they belong.
  - **"❌ Without / ✅ With Safari MCP" block** added immediately after the hero — Context7's killer pattern. Framed against the three real alternatives (Playwright, Chrome DevTools MCP, headless scrapers) instead of the defensive "Why not just use X" question.
  - **80-tool list collapsed into `<details>`** — the full tool table is still there for depth, but no longer dominates the scroll experience. Top-level content is now skimmable in under 30 seconds.
  - **Star-scolding block removed** — the "Less than 1% star it" block was an anti-pattern per every top README analyzed. Kept the silent star-history chart at the bottom, which is what Context7/Desktop Commander/Serena all do.
  - **"What agents unlock with Safari MCP" section** added — Serena-style framing of the capabilities an LLM actually benefits from (authenticated sessions, framework-aware form setters, background operation, batched workflow calls).
  - **Community count corrected** — "2,000+ monthly" → "6,000+ monthly" to match current npm downloads (~1,500/week × 4).

No API, tool, or code changes — documentation/positioning only.

## [2.8.4] - 2026-04-16

### Fixed

- **`SESSION_ID is not defined` runtime error on `safari_new_tab`** — introduced by v2.8.3's bulletproof tab marker. The marker code at `safari.js:2151` references `SESSION_ID`, but that const was only declared in `index.js` (not exported), so the separate `safari.js` ES module threw `ReferenceError: SESSION_ID is not defined` whenever a new tab went through the marker path. Symptom: `safari_new_tab` returned `SESSION_ID is not defined` but the tab still opened in Safari — subsequent calls then failed the tab-ownership safety check, making the MCP unusable for form-driven workflows (HubSpot AEO, Semrush AI Visibility, GTmetrix, etc.). Fix: declare a local `const SESSION_ID = randomUUID().slice(0, 8)` in `safari.js` (each ES module gets its own, which is fine — the marker only needs per-process uniqueness).

## [2.8.3] - 2026-04-14

### Fixed

- **Tab tracking: bulletproof identity via `window.__mcpTabMarker`** — discovered during the v2.8.2 launch campaign that `safari_evaluate` could occasionally land on the wrong tab when `safari_new_tab` and `safari_evaluate` were called more than ~500 ms apart and a popup/redirect added a new tab in the meantime. Root cause: `resolveActiveTab` relied on URL prefix matching, which fails when the page redirects (e.g. LinkedIn `/feed/` → `/feed/?shareActive=true`) or when query strings change. Fix: every `safari_new_tab` now writes a unique marker into `window.__mcpTabMarker`, and `resolveActiveTab` uses that marker as the primary identification strategy. The URL/domain matching remains as a fallback for tabs created before the marker was set. Marker survives same-tab navigation, query changes, and history pushState.
- **Resolve cache reduced from 500 ms to 100 ms** — was masking the multi-tab race when calls were spaced more than 100 ms apart but less than 500 ms. The marker check above is cheap (~5 ms), so the tighter cache adds negligible latency.

## [2.8.2] - 2026-04-14

### Added

- **README: Featured on HackerNoon** — added prominent badge and quote linking to the new technical deep-dive [I Had to Reverse-Engineer React, Shadow DOM, and CSP to Automate Safari Without Chrome](https://hackernoon.com/i-had-to-reverse-engineer-react-shadow-dom-and-csp-to-automate-safari-without-chrome) (published 2026-04-14). The article walks through the three hardest problems behind safari-mcp: React's `_valueTracker` workaround, recursive Shadow DOM traversal with MutationObserver caching, and the 4-strategy CSP fallback chain.

## [2.8.1] - 2026-04-14

### Added

- **Auto-sync to MCP Registry on release** — `.github/workflows/release.yml` now publishes to `registry.modelcontextprotocol.io` on every GitHub release using `mcp-publisher` with GitHub OIDC. Previously, `server.json` had to be bumped manually and the publisher run by hand, which meant versions 2.7.7 → 2.8.0 never made it to the registry.

## [2.8.0] - 2026-04-14

### Added

- **Postinstall welcome banner** (`scripts/postinstall.cjs`) — printed once after `npm install`, shows next-step setup and a discoverable star CTA. Skipped silently in CI and when `SAFARI_MCP_SILENT_INSTALL=1` is set.
- **Once-per-day startup banner** in `index.js` — written to stderr (never stdout, so MCP protocol is untouched) on the first server start of the day. Includes version, capability summary, and a one-line star link. Suppressed by `SAFARI_MCP_QUIET=1`.
- **`smithery.yaml`** — Smithery deployment config, points at the existing `smithery-entry.js` (no top-level `await`).

### Changed

- **README revamp for discoverability:**
  - New social-proof badge row: MCP Registry, Glama, Awesome MCP, CLI-Anything.
  - Prominent star CTA block right after Quick Start (was buried at line 568).
  - New "Why Safari MCP and Not the Other Safari MCP Projects?" comparison table — clarifies how this project differs from `lxman/safari-mcp-server`, `Epistates/MCPSafari`, and `HayoDev/safari-devtools-mcp`.
  - Removed duplicate "vs. Chrome DevTools MCP / Playwright MCP" section.
- **GitHub topics** updated for better organic discovery — added `claude-code`, `safari-mcp`, `mcp` to the topic set.

## [2.7.14] - 2026-04-12

### Fixed

- **`safari-helper` now includes `com.apple.security.automation.apple-events` entitlement.** This helps macOS correctly identify the binary's intent and surface the TCC Automation prompt more reliably on first launch from an IDE. Previously, the ad-hoc signature had no entitlements, causing some setups to silently deny Apple Events without ever prompting.
- Added troubleshooting note for "Not authorized" errors after `npm update` — updating changes the binary's cdhash, which causes macOS to silently revoke Automation permission. Users need to re-grant via the `osascript` one-liner.
- Entitlements file (`safari-helper.entitlements`) now ships with the npm package for users building from source.

## [2.7.14] - 2026-04-12

### Fixed

- `safari_press_key` Enter on contenteditable now has a **native fallback** when the JS keydown isn't handled (isTrusted:false rejection by Discord/Slack/etc.). The fallback briefly activates Safari (~80ms), sends a real keystroke, then immediately restores the previous frontmost app — total visual flash <130ms, imperceptible to most users. This closes the last gap in Discord automation: text insertion via `cmd+v` (Slate state-aware) + Enter submission via native fallback. The fallback ONLY fires when the JS path fails (returns `__ENTER_NOT_HANDLED__`), so apps that accept synthetic events still use the zero-focus-steal JS path.

## [2.7.13] - 2026-04-12

### Fixed

- `safari_press_key` Enter on contenteditable no longer inserts a line break. Modern editors (Discord Slate, Slack, Notion, Medium) handle Enter in their own keydown handler to trigger submit/send. The old fallback `execCommand('insertLineBreak')` was double-acting — the app tries to submit AND MCP adds a newline, corrupting the editor state and preventing actual submission. Now:
  - **INPUT** → form submit (unchanged)
  - **TEXTAREA** → insertLineBreak (unchanged)
  - **ContentEditable + Enter** → keydown event only, let the app decide (fixed)
  - **ContentEditable + Shift+Enter** → insertLineBreak (newline, as expected)

## [2.7.12] - 2026-04-12

### Added

- `safari_native_type` tool — inserts text into any editor via OS-level clipboard paste (CGEvent Cmd+V targeted to Safari window). Unlike `safari_fill` which writes to the DOM directly (breaking ProseMirror/Slate/Draft.js internal state), `safari_native_type` goes through the browser's real paste pipeline. The framework processes the paste event natively, so its model stays in sync with the DOM. After calling `safari_native_type`, pressing Enter via `safari_native_keyboard` will actually submit the form — because the framework state matches the visible content. Saves and restores the user's clipboard. No focus stealing.

### Why this matters

This closes the last gap in the Discord/Slack automation chain:
1. `safari_hover` → find server by tooltip name
2. `safari_click` → enter channel
3. `safari_native_type` → paste message into ProseMirror editor (state-aware)
4. `safari_native_keyboard {key: "enter"}` → submit (no focus steal)

Previously step 3 used `safari_fill` which worked visually but the text wasn't "really there" from Discord's perspective — leading to empty submissions on Enter.

## [2.7.11] - 2026-04-12

### Added

- `safari_native_keyboard` tool — OS-level keyboard event via macOS CGEvent, targeted to the Safari window ID without activating Safari. Produces `isTrusted: true` events that bypass React trust checks in Discord ProseMirror, Slack virtualized editors, and similar trust-gated UIs. Supports all common keys (enter, tab, escape, arrows, letters, digits, punctuation) and modifiers (cmd, shift, alt, ctrl). **No focus stealing** — runs entirely in the background.

### Fixed

- Operations that required a real keypress previously had no zero-focus-steal path; users (and automation agents) had to fall back to `osascript "tell application \"Safari\" to activate"` which brings Safari to the foreground and interrupts whatever the user is doing. `safari_native_keyboard` closes this gap so pressing Enter in Discord, Slack, or any ProseMirror-backed editor no longer pops Safari in front of the user.

## [2.7.10] - 2026-04-12

### Added

- `safari_native_hover` tool — OS-level mouse move via macOS CGEvent. Triggers real `:hover` and `mouseenter` handlers on obfuscated UIs (Discord sidebars, portal-rendered tooltips) where JS-dispatched events aren't enough. Dwells for a configurable duration then restores the cursor position. Complements `safari_native_click`.

### Fixed

- **Tab ownership now survives MCP process restarts.** Previously, every time Claude Code (or any other MCP client) recycled the Safari MCP server, the in-memory `_ownedTabURLs` set was wiped, causing `⚠️ Tab safety: no tabs opened yet` errors on the next tool call. Ownership is now persisted to `~/.safari-mcp/owned-tabs.json` with a 30-minute TTL.
- **`safari-helper` now targets macOS 12.0+ instead of macOS 26.** The daemon was shipped in v2.7.9 compiled with `minos 26.0`, which silently failed to launch on macOS 15 and earlier (#15 root cause). Rebuilt with `swiftc -target arm64-apple-macos12.0` so it runs on Monterey through Tahoe.

## [2.7.9] - 2026-04-11

### Fixed

- Remove `pgrep -E` flag that doesn't exist on macOS — memory monitor was emitting `pgrep: illegal option -- E` on stderr on every check (#15)
- Move Safari extension popup inline `<script>` into `popup/popup.js` so MV3 `script-src 'self'` CSP stops blocking it; popup was stuck on "Checking..." indefinitely (#18, thanks @mikhailkogan17)
- Re-sign `safari-helper` daemon with an explicit ad-hoc signature (replaces the linker-signed fallback) so macOS TCC has a stable cdhash to anchor Automation permissions

### Documentation

- README: add **Automation → Safari** to the macOS Permissions table, plus instructions for granting it to the parent IDE and the `osascript` one-shot workaround (#16)
- README: add `codesign --sign - --force --deep` step to the extension build instructions so Safari will actually load the bundle produced by `xcodebuild` (#17)

### Security

- Pin `hono` to `^4.12.12` and `@hono/node-server` to `^1.19.13` via `package.json` overrides, silencing 6 transitive dependabot advisories (not exploitable at runtime — safari-mcp only loads `StdioServerTransport`)
- Add `.github/CODEOWNERS` and expand Dependabot to cover `github-actions` ecosystem
- Publishing to npm now uses OIDC Trusted Publisher instead of long-lived `NPM_TOKEN`; releases gate on a manual-approval `npm-publish` environment

## [2.7.3] - 2026-04-01

### Fixed

- Prevent Safari from auto-launching when closed — `tell application "Safari"` in AppleScript starts Safari automatically; added `pgrep` check before every osascript call to return an error instead of launching Safari

## [2.7.2] - 2026-03-31

### Changed

- Replace Hebrew text in code comments and author headers with English
- Use Unicode escapes for locale-dependent UI strings (Cancel button, error detection)
- Remove unused popup.js (logic is inline in popup.html)
- Add `lang="en"` to popup.html for accessibility

## [2.5.3] - 2026-03-31

### Fixed

- Tab targeting: always re-resolve tab by URL before every command (RESOLVE_CACHE_MS → 0). Cached indices go stale when tabs are opened/closed by other sessions, causing commands to land on wrong tabs

## [2.5.2] - 2026-03-31

### Fixed

- Type text in cross-origin iframes: Extension now falls back to `allFrames: true` when typing in main frame fails, preventing the AppleScript path from stealing focus

## [2.5.1] - 2026-03-31

### Fixed

- Click in cross-origin iframes: Extension now falls back to `allFrames: true` when element not found in main frame, enabling clicks on buttons inside Intercom, Zendesk, and other cross-origin iframe widgets — zero focus stealing

## [2.5.0] - 2026-03-31

### Added

- CGEvent native keyboard support in Swift helper — send keystrokes to Safari without activating the window or stealing focus
- Cross-origin iframe typing: `typeText` and `pressKey` (Cmd+V) now detect when the active element is an iframe and use native CGEvent paste instead of JavaScript

### Fixed

- Focus stealing: `_nativeTypeViaClipboard` and `pressKey` Cmd+V for iframes no longer activate Safari or use System Events — all done via background CGEvent targeting

## [2.1.5] - 2026-03-30

### Fixed

- Memory protection: prevent system crashes from WebKit memory leaks in long-running sessions

## [2.1.4] - 2026-03-29

### Fixed

- ClipboardEvent paste fallback for modern editors that block synthetic input events

## [2.1.3] - 2026-03-29

### Fixed

- Singleton process management: kill stale MCP instances on startup
- Sibling instance detection: don't kill instances started by Claude Code VSCode

## [2.1.2] - 2026-03-29

### Added

- Closure/Medium editor fill via `execCommand` line-by-line insertion
- Native paste for Closure/Medium editors via System Events `Cmd+V`
- Demo GIF in README

### Fixed

- Closure/Medium fill without focus stealing
- Closure/Medium editor fill via synthetic clipboard paste

## [2.1.1] - 2026-03-28

### Added

- Official MCP Registry support (`server.json`)
- `mcpName` field for registry identification
- `mcp.json` for Cursor Directory / Open Plugins

## [2.1.0] - 2026-03-28

### Added

- `safari_native_click` tool: OS-level mouse click via CGEvent (produces `isTrusted` events)
- Window-targeted native click: no mouse movement, no focus steal
- Extension reconnect with exponential backoff
- Architecture documentation for the dual-engine system

### Fixed

- Native click saves/restores mouse position (no cursor stealing)
- Window bounds fallback to direct osascript
- `navigate()` properly waits for page load via sync polling

## [2.0.1] - 2026-03-23

### Added

- Closed Shadow DOM support with screenshot verification
- React `_valueTracker` reset for LinkedIn/React app compatibility
- Fuzzy matching in `select_option` for RTL text and dashes
- CSP fallback strategy chain for `evaluate`
- Smart loading detection with auto hard reload
- Disabled element detection in `click` with clear error messages
- Per-session tab tracking with profile separation
- `glama.json` server metadata

### Changed

- Click text matching: 3-layer matching (exact, deepest, contains)
- `switch_tab` performs visual switch with stale ref warnings
- Richer `snapshot` output
- Closure editor fill improvements

### Fixed

- Tab targeting: commands run on the correct tab after `switch_tab`
- Extension blocked in personal profile to prevent window focus jumping
- Extension skipped when `SAFARI_PROFILE` is set (AppleScript avoids focus steal)
- LinkedIn ProseMirror view detection and paste behavior
- Medium editor: auto-detection, clear error on fill failure, character-by-character mode
- `fill_form`, `type_text`, `press_key`, `scroll`, and `click` bugs from deep audit
- Checkbox React state synchronization
- `select_option` retry via AppleScript fallback
- Screenshot fallback respects `_preferAppleScript`
- AppleScript `clearField` for contenteditable elements
- `requestSubmit` used instead of `form.submit` for WAF compatibility

### Performance

- Extension v2.1 with HTTP polling, profiles, and command queue

## [2.0.0] - 2026-03-19

### Added

- Safari Web Extension engine: 5-20ms operations with real cookies and logins
- Dual-engine architecture: Extension (preferred) + AppleScript daemon (fallback)
- WebSocket bridge connecting Safari Extension to MCP tools
- Pure JS React click with full PointerEvent sequence and Fiber fallback
- OS-level click for React/Airtable/virtual DOM apps via CGEvent
- Tab tracking by URL to prevent hijacking user tabs
- Profile separation via `SAFARI_PROFILE` environment variable

### Changed

- Extension always targets the MCP tab, not the active tab
- Reverted to AppleScript-first for `newTab` to preserve cookies/logins

### Fixed

- Handle `EADDRINUSE` on WebSocket port 9223 gracefully
- Click on `<a>` tags with href navigates directly as fallback
- React click with coordinates on synthetic events and parent traversal
- Evaluate return values and virtual DOM scroll-to-text
- Tab tracking: resolve by URL in single osascript call
- Screenshot: switch to target tab before capture, restore after
- Critical bugs in type casting, evaluate returns, virtual DOM clicks, and new tab navigation
- Removed broken persistent osascript process (136x faster)

### Performance

- Tab caching and `world:MAIN` context for faster execution
- `click_and_read` combined operation
- TreeWalker text search with cached click helpers
- Click payload reduced from 3KB to 200B with retry pattern
- Pre-inject helpers on navigate
- Cached tab resolve with attribute-aware text search
- Combined navigate + newTab into single osascript calls

## [1.0.0] - 2026-03-18

### Added

- Initial release with 80 MCP tools for native Safari browser automation
- Navigation: `navigate`, `go_back`, `go_forward`, `reload`, `new_tab`, `close_tab`, `switch_tab`, `list_tabs`
- Interaction: `click`, `fill`, `select_option`, `press_key`, `type_text`, `hover`, `drag`, `scroll`, `double_click`, `right_click`
- Forms: `fill_form`, `fill_and_submit`, `detect_forms`, `clear_field`, `upload_file`
- Reading: `read_page`, `snapshot`, `get_source`, `get_element`, `query_all`, `extract_links`, `extract_images`, `extract_tables`, `extract_meta`
- Screenshots: `screenshot`, `screenshot_element`, `save_pdf`
- JavaScript: `evaluate`, `run_script`, `click_and_read`, `click_and_wait`, `navigate_and_read`
- Network: `start_network_capture`, `network`, `network_details`, `clear_network`, `mock_route`, `clear_mocks`, `throttle_network`
- Storage: `get_cookies`, `set_cookie`, `delete_cookies`, `local_storage`, `set_local_storage`, `delete_local_storage`, `session_storage`, `set_session_storage`, `delete_session_storage`, `get_indexed_db`, `list_indexed_dbs`, `export_storage`, `import_storage`
- Console: `start_console`, `get_console`, `console_filter`, `clear_console`
- Accessibility: `accessibility_snapshot`, `analyze_page`, `get_computed_style`
- Clipboard: `clipboard_read`, `clipboard_write`, `paste_image`
- Emulation: `emulate`, `resize`, `reset_emulation`, `override_geolocation`
- Waiting: `wait`, `wait_for`, `wait_for_new_tab`
- Other: `handle_dialog`, `performance_metrics`, `css_coverage`, `replace_editor`
- Built on AppleScript + JavaScript injection via `osascript`
- Tab safety: per-session tracking to never hijack user tabs
- macOS-native: zero browser overhead, no Chrome/Chromium dependency

[2.1.5]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.4...v2.1.5
[2.1.4]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.3...v2.1.4
[2.1.3]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.2...v2.1.3
[2.1.2]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.1...v2.1.2
[2.1.1]: https://github.com/achiya-automation/safari-mcp/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/achiya-automation/safari-mcp/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/achiya-automation/safari-mcp/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/achiya-automation/safari-mcp/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/achiya-automation/safari-mcp/releases/tag/v1.0.0
