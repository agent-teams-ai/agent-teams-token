import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ensurePrivateDirectoryPath } from "../safe-fs.ts";

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true }))); });

test("preexisting directory symlink is rejected before mutation and target permissions remain unchanged", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-directory-")));
  roots.push(root);
  const target = join(root, "target");
  const substituted = join(root, "private");
  await mkdir(target, { mode: 0o755 });
  await chmod(target, 0o755);
  const before = (await lstat(target)).mode & 0o777;
  await symlink(target, substituted, "dir");

  await assert.rejects(ensurePrivateDirectoryPath(root, substituted), (cause: unknown) => cause instanceof Error
    && "code" in cause && cause.code === "LOCAL_EVM_DIRECTORY_PATH_SUBSTITUTION");
  assert.equal((await lstat(target)).mode & 0o777, before);
});

test("a substituted intermediate directory is rejected without changing its target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-parent-")));
  roots.push(root);
  const target = join(root, "target");
  const substituted = join(root, "substituted");
  await mkdir(target, { mode: 0o755 });
  await chmod(target, 0o755);
  const before = (await lstat(target)).mode & 0o777;
  await symlink(target, substituted, "dir");

  await assert.rejects(ensurePrivateDirectoryPath(root, join(substituted, "private")), (cause: unknown) => cause instanceof Error
    && "code" in cause && cause.code === "LOCAL_EVM_DIRECTORY_PATH_SUBSTITUTION");
  assert.equal((await lstat(target)).mode & 0o777, before);
});
