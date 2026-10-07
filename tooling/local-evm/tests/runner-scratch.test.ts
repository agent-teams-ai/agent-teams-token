import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { privateRunRoot } from "../runner.ts";
import { createInitializingRunDirectory, publishInitializedRun } from "../run-initialization.ts";
import { createRunLease, removeOwnedRunDirectory } from "../run-lease.ts";
import { authenticateProcess, type OwnedProcessIdentity } from "../process-identity.ts";

// Both subprocess bodies are typed here; serialize their stripped functions.
// Reading stdin keeps the child alive until EOF, including creator termination.
function leaseIdentityChild(): void {
  process.stdin.resume();
  process.stdout.write(`${JSON.stringify({ready: true, pid: process.pid})}\n`);
}

async function leaveStoppedRun(
  options: {
    readonly repository: string;
    readonly trustedTemp: string;
    readonly runnerUrl: string;
    readonly initializationUrl: string;
    readonly leaseUrl: string;
    readonly identityUrl: string;
  },
  childSource: string,
): Promise<{directory: string; identity: OwnedProcessIdentity}> {
  const childAssert: typeof assert = (await import("node:assert/strict")).default;
  const {spawn} = await import("node:child_process");
  const {prepareRunRoots} = await import(options.runnerUrl) as typeof import("../runner.ts");
  const {createInitializingRunDirectory: initializeRunDirectory, publishInitializedRun: publishRun} =
    await import(options.initializationUrl) as typeof import("../run-initialization.ts");
  const {createRunLease: createChildLease, registerRunAnvil} = await import(options.leaseUrl) as typeof import("../run-lease.ts");
  const {authenticateProcess: authenticateChildProcess, processStartIdentity} =
    await import(options.identityUrl) as typeof import("../process-identity.ts");
  const roots = await prepareRunRoots(options.repository, undefined, options.trustedTemp);
  const initial = await initializeRunDirectory(roots.privateRoot, "cross-process");
  const directory = await publishRun(initial, async () => await createChildLease(initial.directory));
  const child = spawn(process.execPath, ["--input-type=module", "--eval", `(${childSource})();`], {
    cwd: options.repository, stdio: ["pipe", "pipe", "pipe"],
  });
  type ProcessEnd = {readonly code: number | null; readonly signal: NodeJS.Signals | null};
  let exit: ProcessEnd | undefined;
  let stderr = "";
  const childErrors: unknown[] = [];
  const childFailure = new Promise<never>((_resolve, reject) => {
    child.on("error", (cause: Error) => {childErrors.push(cause); reject(cause);});
  });
  child.once("exit", (code, signal) => {exit = {code, signal};});
  const closed = new Promise<ProcessEnd>((resolve) => {
    child.once("close", (code, signal) => {resolve({code, signal});});
  });
  let result: {directory: string; identity: OwnedProcessIdentity};
  try {
    const {stdin, stdout, stderr: childStderr} = child;
    childAssert(stdin !== null);
    childAssert(stdout !== null);
    childAssert(childStderr !== null);
    childStderr.setEncoding("utf8");
    childStderr.on("data", (chunk: string) => {stderr += chunk;});
    const ready = new Promise<string>((resolve) => {
      let output = "";
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline !== -1) {resolve(output.slice(0, newline));}
      });
    });
    const readyLine = await Promise.race([
      ready,
      childFailure,
      closed.then(() => {throw new Error(`lease identity child closed before ready: ${stderr}`);}),
    ]);
    const pid = child.pid;
    childAssert(pid !== undefined);
    childAssert.deepEqual(JSON.parse(readyLine) as unknown, {ready: true, pid});
    const identity: OwnedProcessIdentity = {pid, processStart: await processStartIdentity(pid)};
    childAssert.equal(await authenticateChildProcess(identity), "owned");
    await registerRunAnvil(directory, identity);
    stdin.end();
    const close = await closed;
    childAssert.deepEqual(exit, {code: 0, signal: null}, stderr);
    childAssert.deepEqual(close, exit, stderr);
    childAssert.equal(await authenticateChildProcess(identity), "absent");
    result = {directory, identity};
  } finally {
    try {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        childAssert.equal(child.kill("SIGKILL"), true, "owned child cleanup must deliver SIGKILL");
      }
    } catch (cause) {
      childErrors.push(cause);
    }
    await closed;
  }
  if (childErrors.length > 0) {throw new AggregateError(childErrors, "controlled lease child failed");}
  process.stdout.write(JSON.stringify(result));
  return result;
}

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
  const identityUrl = new URL("../process-identity.ts", import.meta.url).href;

  const script = `await (${leaveStoppedRun.toString()})(${JSON.stringify({
    repository, trustedTemp, runnerUrl, initializationUrl, leaseUrl, identityUrl,
  })}, ${JSON.stringify(leaseIdentityChild.toString())});`;
  const creator = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: repository, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(creator.status, 0, creator.stderr);
  const stopped = JSON.parse(creator.stdout) as Awaited<ReturnType<typeof leaveStoppedRun>>;
  const scratch = privateRunRoot(repository, trustedTemp);
  assert.equal(stopped.directory.startsWith(`${scratch}/run-`), true);
  const lease = JSON.parse(await readFile(join(stopped.directory, "lease.v1.json"), "utf8")) as {
    readonly runner: OwnedProcessIdentity; readonly anvil: OwnedProcessIdentity | null;
  };
  assert.deepEqual(lease.anvil, stopped.identity);
  assert.equal(await authenticateProcess(lease.runner), "absent");
  assert.equal(await authenticateProcess(stopped.identity), "absent");
  assert.equal((await readdir(scratch)).length, 1);
  const {prepareRunRoots} = await import("../runner.ts");
  assert.equal((await prepareRunRoots(repository, undefined, trustedTemp)).privateRoot, scratch);
  assert.deepEqual(await readdir(scratch), []);
});
