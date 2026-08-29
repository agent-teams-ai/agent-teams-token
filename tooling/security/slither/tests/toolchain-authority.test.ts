import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertSlitherToolchainBinding, type SlitherRuntimeIdentity, type ToolchainLock } from "../src/adapters/runner.ts";
import { IMAGE, IMAGE_REVISION, PINNED_PYTHONPATH } from "../src/adapters/container-contract.ts";

const lock = JSON.parse(await readFile("tooling/toolchain.lock.json", "utf8")) as ToolchainLock;
const runtime: SlitherRuntimeIdentity = {
  image: IMAGE, revision: IMAGE_REVISION, platform: "linux/amd64", slither: "0.11.6", cryticCompile: "0.4.2",
  forge: "1.8.0", solcPrefix: "0.8.36+commit.8a079791", containerUser: "1000:1000", pythonPath: PINNED_PYTHONPATH,
  forgeMountPath: "/tools/forge", solcMountPath: "/tools/solc",
};

test("canonical toolchain lock exactly binds the Slither runtime", () => assert.doesNotThrow(() => assertSlitherToolchainBinding(lock, runtime)));

test("toolchain-lock-side identity, revision, version and path drift fail closed", async (context) => {
  const image = lock.securityImages.slither;
  const cases: readonly [string, ToolchainLock][] = [
    ["image", { ...lock, securityImages: { slither: { ...image, manifestDigest: `sha256:${"0".repeat(64)}` } } }],
    ["revision", { ...lock, securityImages: { slither: { ...image, sourceRevision: "0".repeat(40) } } }],
    ["version", { ...lock, securityImages: { slither: { ...image, versions: { ...image.versions, slither: "0.0.0" } } } }],
    ["path", { ...lock, securityImages: { slither: { ...image, runtime: { ...image.runtime, pythonPath: "/forged/python" } } } }],
  ];
  for (const [name, mutated] of cases) {
    await context.test(name, () => assert.throws(() => assertSlitherToolchainBinding(mutated, runtime),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "TOOLCHAIN_LOCK_INVALID"));
  }
});

test("runtime-side identity, revision, version and path drift fail closed", async (context) => {
  const cases: readonly [string, SlitherRuntimeIdentity][] = [
    ["image", { ...runtime, image: runtime.image.replace("ghcr.io", "forged.invalid") }],
    ["revision", { ...runtime, revision: "0".repeat(40) }],
    ["version", { ...runtime, slither: "0.0.0" }],
    ["path", { ...runtime, forgeMountPath: "/forged/forge" }],
  ];
  for (const [name, mutated] of cases) {
    await context.test(name, () => assert.throws(() => assertSlitherToolchainBinding(lock, mutated),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "TOOLCHAIN_LOCK_INVALID"));
  }
});
