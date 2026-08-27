#!/usr/bin/env node
/**
 * Keep development dependencies compatible with every Node major promised by CI.
 *
 * Regression: a bulk dependency update moved jsdom 29 -> 30 even though jsdom 30
 * dropped Node 20. The Node 20 job then crashed inside undici before two suites
 * could load. Dependabot already ignores this major; this test also catches a
 * manual package.json/package-lock update before it reaches the matrix.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readJson = (relativePath) =>
  JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");

const matrixMatch = ci.match(/node-version:\s*\[([^\]]+)\]/);
assert.ok(matrixMatch, "could not parse the Node version matrix in .github/workflows/ci.yml");

const matrix = matrixMatch[1];
const supportedNodeMajors = matrix
  .split(",")
  .map((value) => Number(value.trim()))
  .filter(Number.isInteger);

assert.ok(supportedNodeMajors.length, "the parsed CI Node version matrix is empty");

test(
  "jsdom stays below the Node-20-incompatible major while CI supports Node 20",
  { skip: !supportedNodeMajors.includes(20) },
  () => {
    const declared = packageJson.devDependencies.jsdom;
    const resolved = packageLock.packages["node_modules/jsdom"];
    const resolvedMajor = Number(resolved.version.split(".")[0]);

    assert.ok(
      resolvedMajor < 30,
      `jsdom ${resolved.version} requires ${resolved.engines?.node}; keep jsdom 29 while Node 20 remains in CI`
    );
    assert.doesNotMatch(
      declared,
      /(?:^|\D)30(?:\D|$)/,
      `package.json declares ${declared}; jsdom 30 dropped Node 20 support`
    );
    assert.match(
      resolved.engines?.node ?? "",
      /\^20\./,
      `resolved jsdom engines must explicitly include Node 20, got ${resolved.engines?.node}`
    );
  }
);
