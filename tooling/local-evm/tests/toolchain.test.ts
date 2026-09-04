import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import {
  assertPinnedSolcSha256,
  assertPinnedSolcVersionOutput,
  containsAsciiControlCharacter,
  pinnedSolcPath,
} from "../toolchain.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
const installed = join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`, "solc");

test("local EVM build selects an authenticated snapshot inside caller-owned custody", {
  skip: existsSync(installed) ? false : "pinned solc is not installed",
}, (context) => {
  const custody = mkdtempSync(join(tmpdir(), "agtmai-solc-custody-"));
  context.after(() => rmSync(custody, { recursive: true, force: true }));
  const installEntries = readdirSync(join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`));
  const path = pinnedSolcPath(repositoryRoot, custody);
  assert.equal(isAbsolute(path), true);
  assert.equal(path.startsWith(`${custody}/authenticated-solc-`), true);
  assert.equal(path.endsWith("/solc"), true);
  assert.deepEqual(readdirSync(join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`)), installEntries);
});

test("same-version solc substitution is rejected by the exact platform SHA-256", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-solc-pin-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const committed = JSON.parse(readFileSync(join(repositoryRoot, "tooling/toolchain.lock.json"), "utf8"));
  const artifact = structuredClone(committed.tools.solc.platforms[platform]);
  const tooling = join(root, "tooling");
  const install = join(root, ".tools", artifact.installDirectory);
  const custody = join(root, "custody");
  mkdirSync(tooling, { recursive: true });
  mkdirSync(install, { recursive: true, mode: 0o700 });
  mkdirSync(custody, { mode: 0o700 });
  writeFileSync(join(tooling, "toolchain.lock.json"), JSON.stringify({ tools: { solc: {
    version: "0.8.36",
    platforms: { [platform]: artifact },
  } } }));
  const substitute = Buffer.from("#!/bin/sh\necho 'Version: 0.8.36+commit.8a079791.Linux.g++'\n");
  writeFileSync(join(install, "solc"), substitute, { mode: 0o700 });
  assert.throws(() => pinnedSolcPath(root, custody), (cause: unknown) => cause instanceof Error
    && "code" in cause && cause.code === "LOCAL_EVM_SOLC_CHECKSUM_MISMATCH");
  assert.throws(() => assertPinnedSolcSha256(substitute, artifact.sha256), (cause: unknown) => cause instanceof Error
    && "code" in cause && cause.code === "LOCAL_EVM_SOLC_CHECKSUM_MISMATCH");
});

test("unsafe and symlink solc snapshot custody are rejected before use", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-solc-custody-validation-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const unsafe = join(root, "unsafe");
  const target = join(root, "target");
  const link = join(root, "link");
  mkdirSync(unsafe, { mode: 0o700 });
  chmodSync(unsafe, 0o777);
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, link, "dir");
  for (const custody of [unsafe, link, join(repositoryRoot, ".tools")]) {
    assert.throws(() => pinnedSolcPath(repositoryRoot, custody), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_SOLC_CUSTODY_INVALID");
  }
});

test("only the pinned long solc version is accepted for evidence", () => {
  assert.equal(
    assertPinnedSolcVersionOutput("solc, the solidity compiler commandline interface\nVersion: 0.8.36+commit.8a079791.Linux.g++\n"),
    "Version: 0.8.36+commit.8a079791.Linux.g++",
  );
  for (const output of ["Version: 0.8.36", "Version: 0.8.35+commit.abcdef01.Linux.g++", "Version: 0.8.36+commit.deadbeef.Linux.g++", "Version: 0.8.36+commit.8a079791.Linux.g++.forged"]) {
    assert.throws(() => assertPinnedSolcVersionOutput(output), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_SOLC_VERSION_MISMATCH");
  }
});

test("ASCII control characters are rejected without rejecting printable or non-ASCII text", () => {
  for (const value of ["\0", "safe\0path", "\u0001", "\u001f", "\u007f"]) {
    assert.equal(containsAsciiControlCharacter(value), true, JSON.stringify(value));
  }
  for (const value of [
    "",
    "Version: 0.8.36+commit.8a079791.Linux.g++",
    "\u0020",
    "\u007e",
    "\u0080",
  ]) {
    assert.equal(containsAsciiControlCharacter(value), false, JSON.stringify(value));
  }
});
