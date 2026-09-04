import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  allocatedBytesFromStatBlocks,
  ensurePrivateDirectoryPath,
  publishInitialFile,
  readOwnedBoundedFile,
  readRegularFile,
} from "../safe-fs.ts";

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

test("parallel cold creation shares safely validated directory components", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-concurrent-")));
  roots.push(root);
  const target = join(root, "cold", "nested", "private");

  await Promise.all(Array.from({ length: 16 }, async () => await ensurePrivateDirectoryPath(root, target)));

  const entry = await lstat(target);
  assert.equal(entry.isDirectory(), true);
  assert.equal(entry.isSymbolicLink(), false);
  assert.equal(entry.mode & 0o077, 0);
  assert.equal(await realpath(target), target);
});

test("initial publication preserves every preexisting destination class", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-initial-")));
  roots.push(root);
  const sentinel = join(root, "sentinel");
  await writeFile(sentinel, "preserve", {mode: 0o600});
  const destinations = [
    join(root, "regular"),
    join(root, "symbolic"),
    join(root, "directory"),
  ];
  await writeFile(destinations[0]!, "regular-sentinel", {mode: 0o600});
  await symlink(sentinel, destinations[1]!);
  await mkdir(destinations[2]!, {mode: 0o700});

  for (const destination of destinations) {
    await assert.rejects(publishInitialFile(destination, Buffer.from("new")));
  }

  assert.equal(await readFile(destinations[0]!, "utf8"), "regular-sentinel");
  assert.equal((await lstat(destinations[1]!)).isSymbolicLink(), true);
  assert.equal(await readFile(sentinel, "utf8"), "preserve");
  assert.equal((await lstat(destinations[2]!)).isDirectory(), true);
});

test("two concurrent initial publishers produce exactly one winner", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-race-")));
  roots.push(root);
  const destination = join(root, "winner");
  const results = await Promise.allSettled([
    publishInitialFile(destination, Buffer.from("first")),
    publishInitialFile(destination, Buffer.from("second")),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(await readFile(destination, "utf8"), /^(?:first|second)$/u);
  const entry = await lstat(destination);
  assert.equal(entry.nlink, 1);
  assert.equal(entry.mode & 0o777, 0o600);
});

test("destination injected at publication boundary is preserved", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-inject-")));
  roots.push(root);
  const destination = join(root, "destination");
  await assert.rejects(publishInitialFile(
    destination,
    Buffer.from("owned"),
    0o600,
    undefined,
    {beforePublish: async () => {
      await writeFile(destination, "foreign", {mode: 0o600});
    }},
  ));
  assert.equal(await readFile(destination, "utf8"), "foreign");
});

test("bounded publication rejects logical excess before creating a target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-write-cap-")));
  roots.push(root);
  const destination = join(root, "destination");
  await assert.rejects(
    publishInitialFile(
      destination,
      Buffer.alloc(17),
      0o600,
      {logicalBytes: 16, allocatedBytes: 64 * 1024},
    ),
    (cause: unknown) => cause instanceof Error
      && "code" in cause
      && cause.code === "LOCAL_EVM_INITIAL_FILE_TOO_LARGE",
  );
  await assert.rejects(lstat(destination));
});

test("bounded reads reject sparse logical excess before allocating its size", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-sparse-")));
  roots.push(root);
  const path = join(root, "sparse");
  await writeFile(path, "", {mode: 0o600});
  await truncate(path, 1024 * 1024 * 1024);
  await assert.rejects(
    readOwnedBoundedFile(
      path,
      "TEST_LEASE",
      {logicalBytes: 16 * 1024, allocatedBytes: 64 * 1024},
    ),
    (cause: unknown) => cause instanceof Error
      && "code" in cause
      && cause.code === "LOCAL_EVM_TEST_LEASE_TOO_LARGE",
  );
});

test("allocated block arithmetic is exact and malformed values fail closed", () => {
  assert.equal(allocatedBytesFromStatBlocks(0n, "TEST"), 0n);
  assert.equal(allocatedBytesFromStatBlocks(7n, "TEST"), 3584n);
  assert.throws(
    () => allocatedBytesFromStatBlocks(-1n, "TEST"),
    (cause: unknown) => cause instanceof Error
      && "code" in cause
      && cause.code === "LOCAL_EVM_TEST_STAT_INVALID",
  );
  assert.throws(
    () => allocatedBytesFromStatBlocks(1, "TEST"),
    (cause: unknown) => cause instanceof Error
      && "code" in cause
      && cause.code === "LOCAL_EVM_TEST_STAT_INVALID",
  );
});

test("invalid bounded-read policy fails closed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-policy-")));
  roots.push(root);
  const path = join(root, "lease");
  await writeFile(path, "{}", {mode: 0o600});
  await assert.rejects(
    readOwnedBoundedFile(
      path,
      "TEST_LEASE",
      {logicalBytes: Number.NaN, allocatedBytes: 64 * 1024},
    ),
    (cause: unknown) => cause instanceof Error
      && "code" in cause
      && cause.code === "LOCAL_EVM_TEST_LEASE_POLICY_INVALID",
  );
});

test("actual filesystem allocation exceeding policy is rejected when observable", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-allocation-")));
  roots.push(root);
  const path = join(root, "allocated");
  await writeFile(path, Buffer.alloc(4096, 1), {mode: 0o600});
  const allocated = BigInt((await lstat(path)).blocks) * 512n;
  if (allocated <= 512n) {
    context.skip("filesystem does not expose physical allocation for this fixture");
    return;
  }
  await assert.rejects(
    readOwnedBoundedFile(
      path,
      "TEST_LEASE",
      {logicalBytes: 16 * 1024, allocatedBytes: 512},
    ),
    (cause: unknown) => cause instanceof Error
      && "code" in cause
      && cause.code === "LOCAL_EVM_TEST_LEASE_TOO_LARGE",
  );
});

test("lease-only bounds do not truncate ordinary large artifact reads", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-safe-artifact-")));
  roots.push(root);
  const path = join(root, "artifact.json");
  const expected = Buffer.alloc(256 * 1024, 0x61);
  await writeFile(path, expected, {mode: 0o600});
  assert.deepEqual(await readRegularFile(path, "CONTRACT_ARTIFACT"), expected);
});
