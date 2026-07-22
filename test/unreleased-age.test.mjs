#!/usr/bin/env node
/**
 * Guard for the [Unreleased] parser behind .github/workflows/unreleased-fix.yml.
 *
 * A false empty here silences the observer completely — main could carry a shipped-nowhere
 * fix indefinitely and nothing would say so. A false non-empty opens a nagging issue on
 * every release day. Both failure modes are quiet, so the parser gets its own test.
 *
 * Run:  node --test test/unreleased-age.test.mjs
 */
import assert from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { unreleasedBody } from "../.github/scripts/unreleased-age.mjs";

const header = `# Changelog\n\nSome preamble.\n\n`;

test("empty [Unreleased] followed by a release reads as empty", () => {
  assert.equal(
    unreleasedBody(`${header}## [Unreleased]\n\n## [2.15.4] - 2026-07-21\n\n### Fixed\n- thing\n`),
    ""
  );
});

test("content under [Unreleased] is returned without the next release section", () => {
  const body = unreleasedBody(
    `${header}## [Unreleased]\n\n### Fixed\n- a real fix\n\n## [2.15.4] - 2026-07-21\n\n### Fixed\n- old thing\n`
  );
  assert.equal(body, "### Fixed\n- a real fix");
});

test("[Unreleased] as the last section still reads its content", () => {
  assert.equal(
    unreleasedBody(`${header}## [Unreleased]\n\n### Added\n- brand new\n`),
    "### Added\n- brand new"
  );
});

test("a changelog with no [Unreleased] heading reads as empty", () => {
  assert.equal(unreleasedBody(`${header}## [2.15.4] - 2026-07-21\n\n### Fixed\n- thing\n`), "");
});

test("the link-reference footer is not mistaken for content", () => {
  assert.equal(
    unreleasedBody(
      `${header}## [Unreleased]\n\n## [2.15.4] - 2026-07-21\n\n- thing\n\n[unreleased]: https://example/compare\n`
    ),
    ""
  );
});

test("the repo's own CHANGELOG parses without throwing", () => {
  assert.doesNotThrow(() =>
    unreleasedBody(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"))
  );
});
