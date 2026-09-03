import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { assertPinnedSolcSha256, assertPinnedSolcVersionOutput, pinnedSolcPath } from "../toolchain.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
const installed = join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`, "solc");

test("local EVM build selects an authenticated snapshot inside the pinned install", {
  skip: existsSync(installed) ? false : "pinned solc is not installed",
}, () => {
  const path = pinnedSolcPath(repositoryRoot);
  assert.equal(isAbsolute(path), true);
  assert.equal(path.startsWith(`${repositoryRoot}/.tools/solc-v0.8.36-${platform}/.authenticated-solc-`), true);
  assert.equal(path.endsWith("/solc"), true);
});

test("same-version solc substitution is rejected by the exact platform SHA-256", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-solc-pin-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const committed = JSON.parse(readFileSync(join(repositoryRoot, "tooling/toolchain.lock.json"), "utf8"));
  const artifact = structuredClone(committed.tools.solc.platforms[platform]);
  const tooling = join(root, "tooling");
  const install = join(root, ".tools", artifact.installDirectory);
  mkdirSync(tooling, { recursive: true });
  mkdirSync(install, { recursive: true, mode: 0o700 });
  writeFileSync(join(tooling, "toolchain.lock.json"), JSON.stringify({ tools: { solc: {
    version: "0.8.36",
    platforms: { [platform]: artifact },
  } } }));
  const substitute = Buffer.from("#!/bin/sh\necho 'Version: 0.8.36+commit.8a079791.Linux.g++'\n");
  writeFileSync(join(install, "solc"), substitute, { mode: 0o700 });
  assert.throws(() => pinnedSolcPath(root), (cause: unknown) => cause instanceof Error
    && "code" in cause && cause.code === "LOCAL_EVM_SOLC_CHECKSUM_MISMATCH");
  assert.throws(() => assertPinnedSolcSha256(substitute, artifact.sha256), (cause: unknown) => cause instanceof Error
    && "code" in cause && cause.code === "LOCAL_EVM_SOLC_CHECKSUM_MISMATCH");
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
