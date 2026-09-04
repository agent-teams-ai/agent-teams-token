import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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


test("Core and Agave lock paths reject traversal, separators, controls and options", () => {
  const lock = loadLock(join(repositoryRoot, "tooling/toolchain.lock.json"));
  const segmentEscapes = [".", "..", "/absolute", "-option", "nested/name", "nested\\name", "control\u0000name"];
  for (const toolName of ["node", "foundry", "solc", "agave"]) {
    for (const field of ["archiveName", "installDirectory"]) {
      for (const value of segmentEscapes) {
        const mutated = structuredClone(lock);
        mutated.tools[toolName].platforms["linux-x64"][field] = value;
        assert.throws(() => validateLock(mutated), /TOOLCHAIN_LOCK_PATH/);
      }
    }
    for (const value of [".", "..", "/absolute", "-option", "bin\\tool", "bin//tool", "bin/../tool", "bin/control\u0000tool"]) {
      const mutated = structuredClone(lock);
      mutated.tools[toolName].platforms["linux-x64"].expectedFiles[0] = value;
      assert.throws(() => validateLock(mutated), /TOOLCHAIN_LOCK_RELATIVE_PATH/);
    }
  }
});

test("native no-replace policy is exact, bounded, atomic, and not downloadable", () => {
  const lock = loadLock(join(repositoryRoot, "tooling/toolchain.lock.json"));
  const policy = lock.nativeBuilds.noReplace;
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.kind, "native-no-replace-build-policy");
  assert.equal(policy.sourcePath, "tooling/deployment-plan/native/no-replace.c");
  assert.equal(policy.sourceSha256, "0xf3bd0279809e011933eb6ed92d55c2c7ee3bb28dedb2294ea47fe49a25483f09");
  assert.equal(policy.compileProfile, "c11-o2-werror-stdin-v1");
  assert.equal(`0x${createHash("sha256").update(readFileSync(join(repositoryRoot, policy.sourcePath))).digest("hex")}`, policy.sourceSha256);
  assert.equal(lock.coreTools.includes("noReplace"), false);
  assert.deepEqual(policy.platforms["darwin-arm64"].tuples[0], { compilerPath: "/usr/bin/cc", compilerSha256: "0x7588ceab299393618d6f8861502ac0588d1594025f301d9a61a898215b5571d3", executableSha256: "0x333d90f849c3116bf477678e9439abce54bcf2eed1c724652e70172f69ae584e" });
  assert.deepEqual(policy.platforms["linux-x64"].tuples[0], { compilerPath: "/usr/bin/x86_64-linux-gnu-gcc-13", compilerSha256: "0x1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26", executableSha256: "0x814aba8dfb8f176c252a3fc8f4aa8564723c0790613ee101a9a45fc41f629e9b" });
  for (const mutate of [
    (copy) => { delete copy.nativeBuilds.noReplace.sourcePath; },
    (copy) => { copy.nativeBuilds.noReplace.unknown = true; },
    (copy) => { copy.nativeBuilds.noReplace.platforms["linux-x64"].strategy = "verified-path"; },
    (copy) => { copy.nativeBuilds.noReplace.platforms["linux-x64"].tuples[0].compilerSha256 = "bad"; },
    (copy) => { copy.nativeBuilds.noReplace.platforms["linux-x64"].tuples.push(structuredClone(copy.nativeBuilds.noReplace.platforms["linux-x64"].tuples[0])); },
    (copy) => { const tuple = copy.nativeBuilds.noReplace.platforms["linux-x64"].tuples[0]; copy.nativeBuilds.noReplace.platforms["linux-x64"].tuples = [tuple, { ...tuple, compilerSha256: `0x${"e".repeat(64)}` }, { ...tuple, compilerSha256: `0x${"f".repeat(64)}` }]; },
  ]) {
    const copy = structuredClone(lock); mutate(copy); assert.throws(() => validateLock(copy), /TOOLCHAIN_LOCK_NATIVE/);
  }
});
