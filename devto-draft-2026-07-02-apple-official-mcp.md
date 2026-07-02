---
title: "Apple shipped an official Safari MCP. I read all 17 tools — here's why I'm keeping mine."
published: true
description: "Apple just added a Model Context Protocol server to Safari Technology Preview 247. As the author of an open-source safari-mcp, I read the whole thing. Here's the honest comparison — what Apple got right, and why the two are built for different jobs."
tags: ai, macos, opensource, webdev
cover_image: https://raw.githubusercontent.com/achiya-automation/safari-mcp/543795ad20a782053ba7d5f13c996252f8a55d02/assets/apple-mcp-cover.png
---

Yesterday Apple did something I've been half-expecting since I open-sourced [safari-mcp](https://github.com/achiya-automation/safari-mcp): they shipped their **own** Safari MCP server.

It landed in **Safari Technology Preview 247** (July 1, 2026), built by the WebKit team. Any MCP-compatible agent — Claude, Cursor, whatever — can now connect straight to a Safari window and inspect the DOM, read the console, capture network requests, and take screenshots.

I maintain a tool that does exactly this. So I did the obvious thing: I read the entire release, every one of the ~17 tools, and asked the only question that matters — **do I need to change anything?**

Here's the honest answer.

## What Apple actually shipped

Credit where it's due. The design is clean and the privacy story is excellent:

- It runs on `safaridriver`, Safari's built-in WebDriver binary. Enable *"remote automation and external agents"* in STP and connect with one command.
- It runs **entirely locally**. No network calls to Apple. Page content, screenshots, and console logs go straight to your agent — not to Apple's servers.
- The ~17 tools cover the real debugging loop: `navigate_to_url`, `get_page_content`, `evaluate_javascript`, `page_interactions` (click/type/scroll/hover), `screenshot`, `list_network_requests`, `browser_console_messages`, `browser_dialogs`, tab management, `set_viewport_size`, `set_emulated_media`.

If your job is "let an agent debug how a page renders in WebKit," this is a first-party, well-built way to do it. It's also the strongest possible validation that the category I've been building in is real.

## The one line that decides everything

From Apple's own docs:

> "The Safari MCP server does not have access to your personal information in Safari (e.g. AutoFill or other browser activity)."

That sentence is the whole story. `safaridriver` drives an **isolated WebDriver automation session** — a clean-room window with a "controlled by automation" banner. It is *not* the Safari you're already using, with your tabs and your logins.

And that's not a bug. For a debugging tool, an isolated session is the *correct* design. Reproducible, no personal-state leakage, standards-based.

But it's the opposite of what I built.

## safari-mcp was built for the other 95%

I didn't build safari-mcp to debug rendering. I built it so an agent could **drive the browser I'm already signed into** — Gmail, GitHub, Ahrefs, my bank — using native AppleScript + a Safari extension, in the background, without stealing focus, on **stable Safari**, on every Mac.

So here's the comparison I put in the README, straight up:

| | safari-mcp | Apple `safaridriver --mcp` |
|---|:---:|:---:|
| Your real logins / cookies | ✅ Your actual Safari | ⚠️ Isolated automation session |
| Runs on | ✅ Stable Safari, every Mac | ❌ Safari Technology Preview 247 only |
| Background (no focus steal) | ✅ Yes | ❌ Dedicated "automation" window |
| Tools | 96 | ~17 |
| Storage (cookies, localStorage, IndexedDB) | ✅ 10 tools | ❌ |
| Network mocking + throttling | ✅ Yes | ❌ Read-only inspection |
| Official Apple support | ❌ Community (MIT) | ✅ Apple, WebDriver-standard |

Two numbers I want to be honest about, because I checked them on my own machine before writing this:

1. **`safaridriver --mcp` only exists in STP 247.** The stable `safaridriver` that ships with Safari 26.5 has `--port`, `--bidi`, `--enable`, `--diagnose` — no `--mcp`. So today, using Apple's server means installing Technology Preview.
2. **The isolated session means no logins.** Which is exactly the wall I built safari-mcp to get around.

## So am I changing anything? Yes — three things. None of them is "switch."

**1. Positioning, not code.** Apple didn't make safari-mcp obsolete; they clarified what it's *for*. Their server is the clean-room debugger. Mine is the "drive the browser you already trust" tool. Different jobs. I updated the README to say so out loud.

**2. An opt-in `safaridriver` backend — later, not now.** My architecture is already dual-engine (extension + AppleScript). Adding a third, opt-in WebDriver backend for people who specifically want a standards-based clean session is a natural extension, not a rewrite. It's gated on STP going stable, so it waits.

**3. Steal the one thing they do better.** WebDriver input is a rock-solid, officially-supported way to synthesize events. My native-input path leans on CGEvent, which gets fragile across macOS releases. `safaridriver` is a good model for a more stable input fallback. That's a genuine improvement I owe my users.

## The takeaway

When a platform vendor ships an official version of your open-source tool, the reflex is panic. But "official" and "replacement" are different words. Read the whole thing before you react. Nine times out of ten it's built for a slightly different job than yours — and the honest comparison is better marketing than any launch post.

Apple built the clean-room debugger. I built the tool that drives the browser you're already logged into. Both should exist.

---

*safari-mcp is open source (MIT) — [github.com/achiya-automation/safari-mcp](https://github.com/achiya-automation/safari-mcp). It's native macOS Safari automation for AI agents: 96 tools, `npx safari-mcp`, no Chrome. More on what I build at [achiya-automation.com](https://achiya-automation.com).*

**What would make you reach for an isolated debugging session over your real, logged-in browser — or the other way around? I'd genuinely like to know.**
