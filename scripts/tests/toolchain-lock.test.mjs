import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import test from "node:test";
import { loadLock, validateLock } from "../toolchain.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");

test("committed lock schema covers Core, Solana fixture and future tools separately", () => {
  const lock = loadLock(join(repositoryRoot, "tooling/toolchain.lock.json"));
  assert.deepEqual(lock.platforms, ["darwin-arm64", "linux-x64"]);
  assert.deepEqual(lock.coreTools, ["node", "foundry", "solc"]);
  assert.deepEqual(lock.fixtureTools, ["agave"]);
  assert.equal(lock.tools.pnpm.version, "11.24.0");
  assert.equal(lock.tools.pnpm.source, "https://registry.npmjs.org/pnpm/-/pnpm-11.24.0.tgz");
  assert.equal(lock.tools.pnpm.sha256, "d1eab2433172661cc36a18ec85fce93f771db1962717329cc01ec9c2824ca24f");
  assert.equal(lock.tools.solc.platforms["darwin-arm64"].requires, "Rosetta 2 because upstream publishes macosx-amd64");
  assert.equal(lock.tools.solc.platforms["darwin-arm64"].sha256, "d4abcf0b3e24b7948ddfd64c374d26c3214648717777790ecb936979054a129d");
  assert.equal(lock.tools.foundry.platforms["linux-x64"].sha256, "8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57");
  assert.match(lock.tools.foundry.platforms["darwin-arm64"].checksumSource, /darwin_arm64\.sha256$/);
  assert.match(lock.tools.foundry.platforms["linux-x64"].checksumSource, /linux_amd64\.sha256$/);
  for (const platform of lock.platforms) {
    assert.deepEqual(
      lock.tools.foundry.platforms[platform].versionChecks.map(({ name }) => name),
      ["forge", "cast", "anvil", "chisel"],
    );
  }
  assert.equal(lock.tools.agave.scope, "local-solana-fixture");
  assert.equal(lock.tools.agave.version, "4.2.1");
  assert.equal(lock.tools.agave.splTokenVersion, "5.6.1");
  for (const platform of lock.platforms) {
    assert.equal(lock.tools.agave.platforms[platform].archive, "tar.bz2");
    assert.deepEqual(
      Object.keys(lock.tools.agave.platforms[platform].expectedFileSha256),
      lock.tools.agave.platforms[platform].expectedFiles,
    );
  }
  assert.equal(lock.securityImages.slither.versions.slither, "0.11.6");
  assert.equal(lock.securityImages.slither.versions.forge, "1.8.0");
  assert.match(lock.securityImages.slither.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  for (const name of ["ccipSdk", "ccipSolanaPrograms"]) {
    assert.equal(lock.tools[name].scope, "future-non-core");
    assert.equal(lock.tools[name].enabledForCore, false);
  }
  assert.throws(
    () => validateLock({ ...lock, platforms: ["linux-x64"] }),
    /TOOLCHAIN_LOCK_PLATFORMS/,
  );
  const floating = structuredClone(lock);
  floating.tools.node.platforms["linux-x64"].url = "https://fixtures.invalid/latest/node.tar.xz";
  assert.throws(() => validateLock(floating), /TOOLCHAIN_LOCK_FLOATING/);
});
