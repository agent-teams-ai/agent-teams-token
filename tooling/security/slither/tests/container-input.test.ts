import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureContainerReadableDirectory,
  writeContainerReadableFile,
} from "../src/adapters/container-input.ts";

test("container staging permissions are explicit under a private process umask", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "slither-container-input-"));
  const input = join(boundary, "input");
  try {
    await ensureContainerReadableDirectory(boundary, "input/contracts/evm/src");
    const source = join(input, "contracts/evm/src/Token.sol");
    await writeContainerReadableFile(source, "contract Token {}\n");
    for (const directory of [input, join(input, "contracts"), join(input, "contracts/evm"), join(input, "contracts/evm/src")]) {
      assert.equal((await lstat(directory)).mode & 0o777, 0o755);
    }
    assert.equal((await lstat(source)).mode & 0o777, 0o444);
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});

test("container staging rejects traversal and directory substitution", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "slither-container-input-hostile-"));
  const target = join(boundary, "target");
  try {
    await assert.rejects(ensureContainerReadableDirectory(boundary, "../escape"));
    await ensureContainerReadableDirectory(boundary, "target");
    await chmod(target, 0o700);
    await symlink(target, join(boundary, "alias"));
    await assert.rejects(ensureContainerReadableDirectory(boundary, "alias/child"));
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});
