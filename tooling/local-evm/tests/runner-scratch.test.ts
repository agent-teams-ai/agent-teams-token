import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { privateRunRoot } from "../runner.ts";
import { createInitializingRunDirectory, publishInitializedRun } from "../run-initialization.ts";
import { createRunLease, removeOwnedRunDirectory } from "../run-lease.ts";

const fixtures: string[] = [];
after(async () => { for (const fixture of fixtures) { await rm(fixture, {recursive: true, force: true}); } });

test("local EVM selects an owned sibling of a foreign shared temp root, independent of ambient TMPDIR", async () => {
  await mkdir(join(process.cwd(), ".local"), {recursive: true, mode: 0o700});
  const fixture = await realpath(await mkdtemp(join(process.cwd(), ".local", "local-evm-scratch-test-")));
  fixtures.push(fixture);
  const repository = join(fixture, "checkout");
  const trustedTemp = join(fixture, "trusted-temp");
  const foreignSharedRoot = join(trustedTemp, "agtmai-local-evm");
  await mkdir(repository, {mode: 0o700});
  await mkdir(trustedTemp, {mode: 0o700});
  await mkdir(foreignSharedRoot, {mode: 0o700});
  await writeFile(join(foreignSharedRoot, "foreign-sentinel"), "foreign", {mode: 0o600});
  await chmod(foreignSharedRoot, 0o000);
  const previousTmpdir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = foreignSharedRoot;
    const scratch = privateRunRoot(repository, trustedTemp);
    assert.equal(dirname(scratch), trustedTemp);
    assert.match(basename(scratch), /^agtmai-local-evm-[0-9a-f]{32}$/u);
    const {prepareRunRoots} = await import("../runner.ts");
    const first = await prepareRunRoots(repository, undefined, trustedTemp);
    assert.equal(first.privateRoot, scratch);
    const entry = await lstat(scratch);
    assert.equal(entry.uid, process.getuid?.());
    assert.equal(entry.mode & 0o777, 0o700);
    assert.equal(await realpath(scratch), scratch);
    const initial = await createInitializingRunDirectory(scratch, "scratch-test");
    const runDirectory = await publishInitializedRun(initial, async () => await createRunLease(initial.directory));
    assert.equal((await readdir(scratch)).length, 1);
    await removeOwnedRunDirectory(runDirectory);
    process.env.TMPDIR = join(fixture, "ambient-private-tmp");
    await mkdir(process.env.TMPDIR, {mode: 0o700});
    assert.equal(privateRunRoot(repository, trustedTemp), scratch);
    assert.deepEqual(await prepareRunRoots(repository, undefined, trustedTemp), first);
    assert.deepEqual(await readdir(process.env.TMPDIR), [], "wrapper-private TMPDIR remains empty");
    assert.equal((await lstat(foreignSharedRoot)).mode & 0o777, 0);
    assert.deepEqual(await readdir(scratch), []);
    await chmod(scratch, 0o755);
    await assert.rejects(prepareRunRoots(repository, undefined, trustedTemp), (cause: unknown) =>
      cause instanceof Error && "code" in cause && cause.code === "LOCAL_EVM_DIRECTORY_NOT_PRIVATE");
    assert.equal((await lstat(scratch)).mode & 0o777, 0o755);
  } finally {
    if (previousTmpdir === undefined) { delete process.env.TMPDIR; }
    else { process.env.TMPDIR = previousTmpdir; }
    await chmod(foreignSharedRoot, 0o700);
  }
  assert.equal(await readFile(join(foreignSharedRoot, "foreign-sentinel"), "utf8"), "foreign");
});

test("a later process reclaims a run left by a stopped process in the same checkout", async () => {
  await mkdir(join(process.cwd(), ".local"), {recursive: true, mode: 0o700});
  const fixture = await realpath(await mkdtemp(join(process.cwd(), ".local", "local-evm-recovery-test-")));
  fixtures.push(fixture);
  const repository = join(fixture, "checkout");
  await mkdir(repository, {mode: 0o700});
  const trustedTemp = join(fixture, "trusted-temp");
  await mkdir(trustedTemp, {mode: 0o700});
  const runnerUrl = new URL("../runner.ts", import.meta.url).href;
  const initializationUrl = new URL("../run-initialization.ts", import.meta.url).href;
  const leaseUrl = new URL("../run-lease.ts", import.meta.url).href;
  const script = `
    import {prepareRunRoots} from ${JSON.stringify(runnerUrl)};
    import {createInitializingRunDirectory, publishInitializedRun} from ${JSON.stringify(initializationUrl)};
    import {createRunLease} from ${JSON.stringify(leaseUrl)};
    const roots = await prepareRunRoots(${JSON.stringify(repository)}, undefined, ${JSON.stringify(trustedTemp)});
    const initial = await createInitializingRunDirectory(roots.privateRoot, "cross-process");
    const directory = await publishInitializedRun(initial, async () => await createRunLease(initial.directory));
    process.stdout.write(directory);
  `;
  const creator = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repository, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(creator.status, 0, creator.stderr);
  const scratch = privateRunRoot(repository, trustedTemp);
  assert.equal(creator.stdout.startsWith(`${scratch}/run-`), true);
  assert.equal((await readdir(scratch)).length, 1);
  const {prepareRunRoots} = await import("../runner.ts");
  assert.equal((await prepareRunRoots(repository, undefined, trustedTemp)).privateRoot, scratch);
  assert.deepEqual(await readdir(scratch), []);
});
