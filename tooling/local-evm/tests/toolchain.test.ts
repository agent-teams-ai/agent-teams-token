import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import { test } from "node:test";
import { assertPinnedSolcVersionOutput, pinnedSolcPath } from "../toolchain.ts";

test("local EVM build selects the repository-pinned solc by absolute platform path", () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const path = pinnedSolcPath(repositoryRoot);
  assert.equal(isAbsolute(path), true);
  assert.equal(path.startsWith(`${repositoryRoot}/.tools/solc-v0.8.36-`), true);
  assert.equal(path.endsWith("/solc"), true);
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
