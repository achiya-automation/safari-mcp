#!/usr/bin/env node
/**
 * The tool count in the docs has drifted from the code three times (80 -> 96, 96 -> 97,
 * 97 -> 98), each time because a tool was registered without touching README.md.  Every
 * fix so far corrected the numbers by hand, which leaves the next tool free to do it
 * again.  These assertions derive the count from the registrations and fail the build
 * when any document disagrees, so adding a tool and forgetting the table is a red CI run
 * rather than something a reader finds months later.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const serverJson = readFileSync(new URL("../server.json", import.meta.url), "utf8");

const registered = [...index.matchAll(/server\.tool\(\s*\n?\s*"([a-zA-Z_0-9]+)"/g)].map((m) => m[1]);
const TOOL_COUNT = registered.length;

/** The `## Tools (N)` section, which is the only place the full table lives. */
function toolsSection() {
  const start = readme.indexOf("## Tools (");
  assert.ok(start >= 0, "README must carry a `## Tools (N)` section");
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end === -1 ? readme.length : end);
}

test("every registered tool is unique and documented in the README table", () => {
  assert.ok(TOOL_COUNT > 0, "index.js should register tools");
  assert.equal(new Set(registered).size, TOOL_COUNT, "two tools share a name");

  const table = toolsSection();
  const undocumented = registered.filter((name) => !table.includes(`\`${name}\``));
  assert.deepEqual(undocumented, [], "these tools are registered but missing from the README table");
});

test("the README tool count matches the number of registrations", () => {
  const heading = readme.match(/## Tools \((\d+)\)/);
  assert.ok(heading, "README must carry a `## Tools (N)` heading");
  assert.equal(Number(heading[1]), TOOL_COUNT, "`## Tools (N)` disagrees with index.js");

  // The table itself, independent of the heading: one row per registered tool.
  const rows = toolsSection().match(/^\| `safari_[a-z_0-9]+` \|/gm) || [];
  assert.equal(rows.length, TOOL_COUNT, "the tool table has a different number of rows than index.js registers");

  // The anchor the header links to has to follow the heading, or the TOC 404s in-page.
  assert.ok(
    readme.includes(`[All ${TOOL_COUNT} Tools](#tools-${TOOL_COUNT})`),
    `the above-the-fold link must read "All ${TOOL_COUNT} Tools" and point at #tools-${TOOL_COUNT}`
  );
});

test("each tool category header counts its own rows", () => {
  const section = toolsSection().split("\n");
  let declared = null;
  let actual = 0;
  const wrong = [];
  const close = () => {
    if (declared && actual !== declared[1]) wrong.push(`${declared[0]} says ${declared[1]}, has ${actual}`);
  };
  for (const line of section) {
    const header = line.match(/^### (.+?) \((\d+)\)\s*$/);
    if (header) {
      close();
      declared = [header[1], Number(header[2])];
      actual = 0;
    } else if (/^\| `safari_[a-z_0-9]+` \|/.test(line)) {
      actual += 1;
    }
  }
  close();
  assert.deepEqual(wrong, [], "category headers disagree with the rows beneath them");
});

test("every prose mention of the tool count agrees with the code", () => {
  // Prose only: comparison-table rows legitimately count one category ("10 tools" for
  // storage) or a competitor's total, so a row starting with "|" is not a claim about
  // this server. Badge URLs carry unrelated digits and are skipped for the same reason.
  const prose = readme
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("|"))
    .join("\n");
  const mentions = [...prose.matchAll(/(\d+) tools/g)].map((m) => Number(m[1]));
  assert.ok(mentions.length > 0, "README should state the tool count in prose");
  assert.deepEqual(
    [...new Set(mentions)],
    [TOOL_COUNT],
    "README states a tool count that index.js does not register"
  );

  // The share link ships the count too, URL-encoded, and it is the copy that travels.
  const shared = readme.match(/browse\.%20(\d+)%20tools/);
  assert.ok(shared && Number(shared[1]) === TOOL_COUNT, "the share-link text states a stale tool count");

  const alt = readme.match(/alt="Safari MCP Server — (\d+) native browser automation tools/);
  assert.ok(alt && Number(alt[1]) === TOOL_COUNT, "the social-preview alt text states a stale tool count");

  // server.json is what the MCP Registry publishes, so a stale count there reaches every
  // directory that ingests the registry rather than only readers of this repo.
  const registryDesc = serverJson.match(/(\d+) tools/);
  assert.ok(registryDesc && Number(registryDesc[1]) === TOOL_COUNT, "server.json states a stale tool count");
});
