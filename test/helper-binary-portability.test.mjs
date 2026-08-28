import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The shipped safari-helper is a prebuilt Mach-O, so whatever Mac last ran `swiftc`
// decides who can run it. A bare `swiftc -O` on an Apple Silicon Mac running the newest
// macOS produced an arm64-only, minos-26.0 binary — dyld then refused it on Intel Macs
// and on every older macOS, and since the helper is spawned lazily the only symptom
// users saw was "helper process exited" on every single tool call.
// Rebuild with scripts/build-helper.sh, never a bare swiftc.

const helper = join(dirname(fileURLToPath(import.meta.url)), "..", "safari-helper");
const MAX_DEPLOYMENT_TARGET = 14; // must stay runnable on macOS well behind the newest

const darwin = process.platform === "darwin";

test("the shipped helper runs on both Mac architectures", { skip: !darwin && "macOS-only toolchain" }, () => {
  assert.ok(existsSync(helper), "safari-helper must be committed — it is what npm ships");
  const archs = execFileSync("lipo", ["-archs", helper], { encoding: "utf8" }).trim().split(/\s+/);
  assert.ok(archs.includes("arm64"), `helper must carry an arm64 slice, got: ${archs.join(", ")}`);
  assert.ok(archs.includes("x86_64"), `helper must carry an x86_64 slice, got: ${archs.join(", ")}`);
});

test("the shipped helper targets a macOS old enough for real users", { skip: !darwin && "macOS-only toolchain" }, () => {
  const archs = execFileSync("lipo", ["-archs", helper], { encoding: "utf8" }).trim().split(/\s+/);
  for (const arch of archs) {
    const load = execFileSync("otool", ["-arch", arch, "-l", helper], { encoding: "utf8" });
    const minos = load.match(/LC_BUILD_VERSION[\s\S]{0,200}?minos\s+([0-9.]+)/)?.[1];
    assert.ok(minos, `${arch} slice must declare a deployment target`);
    assert.ok(
      Number.parseFloat(minos) <= MAX_DEPLOYMENT_TARGET,
      `${arch} slice targets macOS ${minos}; dyld refuses it below that, so keep it <= ${MAX_DEPLOYMENT_TARGET} (rebuild via scripts/build-helper.sh)`
    );
  }
});

test("the shipped helper keeps the stable codesign identity", { skip: !darwin && "macOS-only toolchain" }, () => {
  // The Accessibility grant is keyed to this identifier; a one-off swiftc id breaks
  // native clicks invisibly (#29).
  // codesign prints the Identifier= line on stderr, not stdout.
  const res = spawnSync("codesign", ["-d", "--verbose=2", "--", helper], { encoding: "utf8" });
  const out = (res.stdout || "") + (res.stderr || "");
  assert.match(out, /Identifier=com\.achiya-automation\.safari-mcp/);
});

test("the shipped helper loads and answers instead of dying at launch", { skip: !darwin && "macOS-only toolchain" }, () => {
  // A dyld rejection surfaces as a non-zero exit with no stdout — exactly the
  // "helper process exited" report. Garbage in, structured error out, no Safari touched.
  const out = execFileSync(helper, [], { input: "not-json\n", encoding: "utf8", timeout: 10000 });
  assert.match(out, /"error"\s*:\s*"invalid input"/);
});
