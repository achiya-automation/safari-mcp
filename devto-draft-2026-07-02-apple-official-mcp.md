---
title: "Apple shipped an official Safari MCP. I read all 17 tools. Here's why I'm keeping mine."
published: true
description: "Apple's WebKit team just shipped a Safari MCP server. I maintain an open-source one. So I read all 17 of their tools and found the single sentence that told me not to delete my repo."
tags: webdev, ai, opensource, apple
cover_image: https://raw.githubusercontent.com/achiya-automation/safari-mcp/543795ad20a782053ba7d5f13c996252f8a55d02/assets/apple-mcp-cover.png
---

Apple shipped the tool I've spent a year building as open source.

For about ten minutes on Tuesday night, I thought I was cooked. Safari Technology Preview 247 dropped with an official Safari MCP server, built by the WebKit team, the people who actually make the browser. I maintain a scrappy AppleScript version of the same idea. David, meet Goliath's in-house team.

So I did the only thing that made sense. I read all 17 of their tools, one by one. Somewhere around tool #9 I stopped feeling cooked. By the end I knew I wasn't deleting my repo, and the reason is a single sentence Apple wrote themselves.

## First, credit where it's due

The design is clean. It runs on `safaridriver`, the WebDriver binary already shipping inside Safari, so setup is one command. It runs entirely on your machine. No page content, no screenshots, nothing phones home to Apple. The 17 tools cover the boring-but-essential debugging loop: open a URL, read the DOM, click things, watch the network tab, grab the console, screenshot the result.

If what you want is an agent that debugs how a page renders in WebKit, this is a first-party, well-built way to get it. And honestly? It's the best validation I could ask for. A year ago people asked me why anyone would let an AI drive a browser. Apple just answered that for me.

## The one sentence

Here's the line, straight from Apple's own docs:

> "The Safari MCP server does not have access to your personal information in Safari (e.g. AutoFill or other browser activity)."

Read that again if you build automation. `safaridriver` spins up a clean, isolated WebDriver session. Fresh window. A "controlled by automation" banner across the top. None of your logins. None of your cookies. Not the twelve tabs you already have open.

For a debugging tool, that's the right call. Reproducible, sandboxed, no personal state leaking into a test run. I'd have designed it the same way.

It's also the exact problem I built my tool to avoid.

## Why mine exists at all

I never built safari-mcp to debug rendering. I built it because I wanted an agent to drive the Safari I'm *already* logged into: my Gmail, my GitHub, my Ahrefs dashboard, my bank. No re-auth, no fresh profile, no QR code. It runs on native AppleScript in the background, on the stable Safari you already have, on any Mac. No Technology Preview required.

That's the whole difference. Apple's server opens a sterile room and hands your agent a key. Mine walks into the room you're already sitting in.

Here's the honest scorecard I dropped into my README:

| | safari-mcp | Apple `safaridriver --mcp` |
|---|:---:|:---:|
| Your real logins / cookies | ✅ Your actual Safari | ⚠️ Isolated automation session |
| Runs on | ✅ Stable Safari, every Mac | ❌ Technology Preview 247 only |
| Background, no focus steal | ✅ Yes | ❌ Dedicated automation window |
| Tools | 96 | ~17 |
| Cookies / localStorage / IndexedDB | ✅ 10 tools | ❌ |
| Network mocking + throttling | ✅ Yes | ❌ Read-only |
| Official Apple support | ❌ Community, MIT | ✅ Apple, WebDriver-standard |

I checked two of those rows on my own machine before writing this, because I didn't want to bluff. Stable `safaridriver` in Safari 26.5 has `--port`, `--bidi`, `--enable`, `--diagnose`. No `--mcp`. It only exists in the Preview today. And the isolated session really does mean no logins. That's the wall, and I built safari-mcp to climb over it.

## So am I changing anything? Yes. Three things, none of them "switch."

**Positioning.** Apple didn't kill safari-mcp. They told the world what it's for. Theirs is the clean-room debugger; mine drives the browser you live in. I rewrote my README to say that out loud instead of pretending we compete.

**A safaridriver backend, eventually.** My tool already runs two engines under the hood, a Safari extension and AppleScript. Bolting on a third opt-in WebDriver backend, for people who genuinely want a sterile session, isn't a rewrite. It's a weekend. But it waits until `--mcp` reaches stable Safari, because right now it only lives in the Preview.

**Stealing their best idea.** WebDriver synthesizes input events the official, rock-solid way. My native-click path leans on CGEvent, which macOS quietly breaks every other release (ask me how I know). Apple just handed me a sturdier fallback. I'd be silly not to take it.

## The takeaway

When the company that makes the browser ships an official version of your side project, the reflex is to panic. Don't. "Official" and "replacement" are different words. I read all 17 tools before I reacted, and the honest comparison turned out to be better marketing than any launch-day panic post could have been.

Apple built the sterile room. I built the tool for the room you already live in. Both should exist.

I just know which one I'll actually reach for on a Tuesday.

---

*safari-mcp is open source (MIT): [github.com/achiya-automation/safari-mcp](https://github.com/achiya-automation/safari-mcp). 96 tools, `npx safari-mcp`, no Chrome, native macOS. I write about the things I build at [achiya-automation.com](https://achiya-automation.com).*

**Genuine question, because I keep flip-flopping on it: would you ever trade your logged-in browser for a clean automation session? What would have to be true to make that worth it?**
