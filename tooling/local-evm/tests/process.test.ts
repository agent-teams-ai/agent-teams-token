import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { authenticateProcess, processStartIdentity, startOwnedAnvil } from "../process.ts";
import { pinnedFoundryBinaries } from "../toolchain.ts";
import { assertPayloadStopped, syntheticAnvil, waitForJson } from "./fixtures/synthetic-anvil.ts";
import {
  createProvisionalRunDirectory,
  createRunLease,
  reclaimStaleRuns,
  registerRunAnvil,
} from "../run-lease.ts";

const execute = promisify(execFile);
const repositoryRoot = await realpath(resolvePath(import.meta.dirname, "../../.."));
const foundry = pinnedFoundryBinaries(repositoryRoot);
const firstAddress = "0x7000000000000000000000000000000000000001";
const secondAddress = "0x7000000000000000000000000000000000000002";
const anvilBinary = foundry.anvil;
const castBinary = foundry.cast;

test("Anvil startup failure is fail-closed and leaves no child behind", { timeout: 20_000 }, async (context) => {
  const fixture = await syntheticAnvil(context, "exit");
  await assert.rejects(fixture.start(firstAddress), /exited before listening/);
  const {pid} = await fixture.payload();
  assert.equal(processExists(pid), false);
});

test("a missing Anvil executable rejects through the owned-process API", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-anvil-missing-"));
  try {
    await assert.rejects(startOwnedAnvil(join(directory, "absent-anvil"), firstAddress), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stopping one owned PID does not affect a neighbouring Anvil", { timeout: 60_000 }, async () => {
  const first = await startOwnedAnvil(anvilBinary, firstAddress);
  const second = await startOwnedAnvil(anvilBinary, secondAddress);
  try {
    assert.notEqual(first.pid, second.pid);
    assert.equal(await chainId(first.rpcUrl), "0x7a69");
    assert.equal(await chainId(second.rpcUrl), "0x7a69");
    await first.stop();
    assert.equal(processExists(first.pid), false);
    assert.equal(processExists(second.pid), true);
    assert.equal(await chainId(second.rpcUrl), "0x7a69");
  } finally {
    await first.stop();
    await second.stop();
  }
  assert.equal(processExists(second.pid), false);
});

test("Anvil account and mnemonic output is never returned by the owned-process API", { timeout: 20_000 }, async () => {
  const anvil = await startOwnedAnvil(anvilBinary, firstAddress);
  try {
    assert.deepEqual(Object.keys(anvil).toSorted(), ["pid", "rpcUrl", "stop"]);
    assert.match(anvil.rpcUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/$/);
    assert.equal(JSON.stringify(anvil).includes("private"), false);
    assert.equal(JSON.stringify(anvil).includes("mnemonic"), false);
  } finally { await anvil.stop(); }
});

test("concurrent stop callers share cleanup through forced termination", { timeout: 20_000 }, async (context) => {
  const fixture = await syntheticAnvil(context, "stubborn");
  const anvil = await fixture.start(firstAddress);
  const payload = await fixture.payload();
  assert.equal(anvil.pid, payload.pid, "the owned PID must be the actual Node payload");
  const beforeStop = performance.now();
  const first = anvil.stop();
  const second = anvil.stop();
  assert.equal(first, second);
  assert.deepEqual(await waitForJson(fixture.signalPath), {pid: payload.pid});
  assert.equal(processExists(payload.pid), true, "the payload must really ignore SIGTERM");
  await Promise.all([first, second]);
  assert(performance.now() - beforeStop >= 5_000, "forced termination must wait for the SIGTERM grace period");
  assert.equal(processExists(anvil.pid), false);
  assert.equal(processExists(payload.pid), false);
});

test("control-channel EOF before registration acknowledgement terminates Anvil", {timeout: 20_000}, async (context) => {
  const fixture = await syntheticAnvil(context);
  const {directory, executable} = fixture;
  const identityPath = join(directory, "identity.json");
  const runner = await fixture.runner([
    `import {writeFile} from "node:fs/promises";`,
    `import {startOwnedAnvil} from ${JSON.stringify(new URL("../process.ts", import.meta.url).href)};`,
    `await startOwnedAnvil(${JSON.stringify(executable)}, ${JSON.stringify(firstAddress)}, async (identity) => {`,
    `  await writeFile(${JSON.stringify(identityPath)}, JSON.stringify(identity));`,
    `  await new Promise(() => {});`,
    `});`,
  ].join("\n"));
  const identity = await waitForJson<{pid: number; processStart: string}>(identityPath);
  const payload = await fixture.payload();
  assert.equal(identity.pid, payload.pid, "registration must identify the actual Node payload");
  assert.equal(await authenticateProcess(identity), "owned");
  await runner.kill();
  await assertPayloadStopped(payload.pid);
  assert.notEqual(await authenticateProcess(identity), "owned");
});

test("synthetic Anvil startup timeout reaps the actual payload", {timeout: 20_000}, async (context) => {
  const fixture = await syntheticAnvil(context, "silent");
  await assert.rejects(fixture.start(firstAddress), /did not publish its private listening address/);
  const payload = await fixture.payload();
  assert.equal(processExists(payload.pid), false);
});

test("synthetic Anvil registration failure reaps the actual payload", {timeout: 20_000}, async (context) => {
  const fixture = await syntheticAnvil(context);
  const failure = new Error("registration rejected");
  await assert.rejects(fixture.start(firstAddress, async (identity) => {
    assert.equal(identity.pid, (await fixture.payload()).pid);
    throw failure;
  }), (cause: unknown) => cause === failure);
  assert.equal(processExists((await fixture.payload()).pid), false);
});

test("synthetic forced termination preserves a neighbouring payload", {timeout: 20_000}, async (context) => {
  const fixture = await syntheticAnvil(context, "stubborn");
  const neighbourFixture = await syntheticAnvil(context);
  const anvil = await fixture.start(firstAddress);
  const neighbour = await neighbourFixture.start(secondAddress);
  assert.equal(anvil.pid, (await fixture.payload()).pid);
  assert.equal(neighbour.pid, (await neighbourFixture.payload()).pid);
  assert.notEqual(anvil.pid, neighbour.pid);
  const identity = {pid: neighbour.pid, processStart: await processStartIdentity(neighbour.pid)};
  await anvil.stop();
  assert.equal(processExists(anvil.pid), false);
  assert.equal(processExists(neighbour.pid), true);
  assert.equal(await authenticateProcess(identity), "owned");
  await neighbour.stop();
  assert.equal(processExists(neighbour.pid), false);
});

test("stale-run recovery fails closed instead of signaling a process from a stale identity read", { timeout: 20_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-reclaim-")));
  // macOS mkdtemp() may emit upper-case characters in its random suffix.
  const runDirectory = join(root, "run-dead-owner-Z9");
  await mkdir(runDirectory, { mode: 0o700 });
  const owned = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const neighbour = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  assert(owned.pid && neighbour.pid);
  try {
    const anvil = { pid: owned.pid, processStart: await processStartIdentity(owned.pid) };
    const staleRunnerStart = process.platform === "darwin" ? "darwin:00" : "linux:0";
    await writeFile(join(runDirectory, "lease.v1.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "agtmai-local-evm-run",
      runner: { pid: process.pid, processStart: staleRunnerStart },
      anvil,
    })}\n`, { mode: 0o600 });
    await assert.rejects(reclaimStaleRuns(root), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_RUN_ANVIL_STILL_OWNED");
    assert.equal(processExists(owned.pid), true);
    assert.equal(processExists(neighbour.pid), true);
    assert.equal((await stat(runDirectory)).isDirectory(), true);
  } finally {
    if (processExists(owned.pid)) { owned.kill("SIGKILL"); }
    if (processExists(neighbour.pid)) { neighbour.kill("SIGKILL"); }
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel recovery preserves a run while the production atomic lease writer initializes it", { timeout: 10_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-initializing-")));
  const runDirectory = await createProvisionalRunDirectory(root, "initializing-Z9");
  const writer = (async () => {
    await delay(50);
    await createRunLease(runDirectory);
  })();
  try {
    assert.equal(await reclaimStaleRuns(root), 0);
    await writer;
    assert.equal((await stat(runDirectory)).isDirectory(), true);
  } finally {
    await writer.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("initial lease publication preserves a preexisting foreign sentinel", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-sentinel-")));
  const runDirectory = await createProvisionalRunDirectory(root, "sentinel-Z9");
  const leasePath = join(runDirectory, "lease.v1.json");
  await writeFile(leasePath, "foreign-sentinel", {mode: 0o600});
  try {
    await assert.rejects(createRunLease(runDirectory));
    assert.equal(await readFile(leasePath, "utf8"), "foreign-sentinel");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("stale-run lease reads promptly reject and preserve a foreign FIFO", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-fifo-")));
  const runDirectory = join(root, "run-fifo-Z9");
  const leasePath = join(runDirectory, "lease.v1.json");
  await mkdir(runDirectory, {mode: 0o700});
  await execute("/usr/bin/mkfifo", [leasePath]);
  try {
    assert.deepEqual(
      await runBoundedLeaseFixture(["reclaim", root]),
      {status: "rejected", code: "LOCAL_EVM_RUN_LEASE_NOT_REGULAR"},
    );
    assert.equal((await lstat(leasePath)).isFIFO(), true);
    assert.deepEqual(
      (await readdir(runDirectory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("two concurrent lease creators publish exactly one owned lease", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-race-")));
  const runDirectory = await createProvisionalRunDirectory(root, "race-Z9");
  try {
    const results = await Promise.allSettled([
      createRunLease(runDirectory),
      createRunLease(runDirectory),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const entry = await lstat(join(runDirectory, "lease.v1.json"));
    assert.equal(entry.nlink, 1);
    assert.equal(entry.mode & 0o777, 0o600);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("normal create and authenticated Anvil registration retain update semantics", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-update-")));
  const runDirectory = await createProvisionalRunDirectory(root, "update-Z9");
  try {
    await createRunLease(runDirectory);
    const identity = {
      pid: process.pid,
      processStart: await processStartIdentity(process.pid),
    };
    await registerRunAnvil(runDirectory, identity);
    const lease = JSON.parse(
      await readFile(join(runDirectory, "lease.v1.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(lease.anvil, identity);
    const entry = await lstat(join(runDirectory, "lease.v1.json"));
    assert.equal(entry.nlink, 1);
    assert.equal(entry.mode & 0o777, 0o600);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("authenticated lease update preserves a substituted foreign successor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-substitution-")));
  const runDirectory = await createProvisionalRunDirectory(root, "substitution-Z9");
  const leasePath = join(runDirectory, "lease.v1.json");
  const displaced = join(runDirectory, "authenticated-predecessor");
  try {
    await createRunLease(runDirectory);
    const predecessor = await readFile(leasePath, "utf8");
    const identity = {
      pid: process.pid,
      processStart: await processStartIdentity(process.pid),
    };
    await assert.rejects(registerRunAnvil(runDirectory, identity, {
      beforePublish: async () => {
        await rename(leasePath, displaced);
        await writeFile(leasePath, "foreign-successor", {mode: 0o600});
      },
    }), (cause: unknown) => cause instanceof Error
      && "code" in cause
      && cause.code === "LOCAL_EVM_UPDATED_FILE_CHANGED");
    assert.equal(await readFile(leasePath, "utf8"), "foreign-successor");
    assert.equal(await readFile(displaced, "utf8"), predecessor);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("authenticated lease update promptly rejects and preserves a substituted FIFO", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-update-fifo-")));
  const runDirectory = await createProvisionalRunDirectory(root, "fifo-Z9");
  const leasePath = join(runDirectory, "lease.v1.json");
  const displaced = join(runDirectory, "authenticated-predecessor");
  try {
    assert.deepEqual(
      await runBoundedLeaseFixture(["register", runDirectory, displaced]),
      {status: "rejected", code: "LOCAL_EVM_UPDATED_FILE_CHANGED", predecessorPreserved: true},
    );
    assert.equal((await lstat(leasePath)).isFIFO(), true);
    assert.deepEqual(
      (await readdir(runDirectory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("authenticated lease update rejects an in-place predecessor rewrite", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-lease-rewrite-")));
  const runDirectory = await createProvisionalRunDirectory(root, "rewrite-Z9");
  const leasePath = join(runDirectory, "lease.v1.json");
  try {
    await createRunLease(runDirectory);
    const predecessor = await readFile(leasePath);
    const mutated = Buffer.alloc(predecessor.byteLength, 0x78);
    const identity = {
      pid: process.pid,
      processStart: await processStartIdentity(process.pid),
    };
    await assert.rejects(
      registerRunAnvil(runDirectory, identity, {
        beforePublish: async () => {
          await writeFile(leasePath, mutated);
        },
      }),
      (cause: unknown) => cause instanceof Error
        && "code" in cause
        && cause.code === "LOCAL_EVM_UPDATED_FILE_CHANGED",
    );
    assert.deepEqual(await readFile(leasePath), mutated);
    assert.equal((await lstat(leasePath)).nlink, 1);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("two reclaimers atomically claim one stale run without recreating it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-concurrent-reclaim-")));
  const runDirectory = join(root, "run-stale-concurrent-Z9");
  await mkdir(runDirectory, {mode: 0o700});
  await writeFile(join(runDirectory, "lease.v1.json"), `${JSON.stringify({
    schemaVersion: 1, kind: "agtmai-local-evm-run",
    runner: {pid: 2147483647, processStart: "linux:1"}, anvil: null,
  })}\n`, {mode: 0o600});
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {release = resolve;});
  const afterDirectoryList = async (): Promise<void> => {arrivals += 1; if (arrivals === 2) {release();} await barrier;};
  try {
    const results = await Promise.all([
      reclaimStaleRuns(root, {afterDirectoryList}),
      reclaimStaleRuns(root, {afterDirectoryList}),
    ]);
    assert.deepEqual(results.toSorted(), [0, 1]);
    assert.equal((await readdir(root)).some((name) => name === "run-stale-concurrent-Z9"), false);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("reclaimer never deletes a hostile directory substituted after validation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-reclaim-substitution-")));
  const runDirectory = join(root, "run-stale-substitution-Z9");
  const displaced = join(root, "displaced-owned-run");
  await mkdir(runDirectory, {mode: 0o700});
  const staleLease = `${JSON.stringify({schemaVersion: 1, kind: "agtmai-local-evm-run", runner: {pid: 2147483647, processStart: "linux:1"}, anvil: null})}\n`;
  await writeFile(join(runDirectory, "lease.v1.json"), staleLease, {mode: 0o600});
  try {
    await assert.rejects(reclaimStaleRuns(root, {afterDirectoryList: async () => {
      await rename(runDirectory, displaced);
      await mkdir(runDirectory, {mode: 0o700});
      await writeFile(join(runDirectory, "foreign-sentinel"), "preserve", {mode: 0o600});
      await writeFile(join(runDirectory, "lease.v1.json"), staleLease, {mode: 0o600});
    }}), (cause: unknown) => cause instanceof Error && "code" in cause
      && cause.code === "LOCAL_EVM_RUN_DIRECTORY_CHANGED");
    const claim = (await readdir(root)).find((name) => name.startsWith(".reclaim-v1-"));
    assert(claim);
    assert.equal(await readFile(join(root, claim, "foreign-sentinel"), "utf8"), "preserve");
    await assert.rejects(reclaimStaleRuns(root), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_RUN_DIRECTORY_CHANGED");
    assert.equal(await readFile(join(root, claim, "foreign-sentinel"), "utf8"), "preserve");
    assert.equal((await stat(displaced)).isDirectory(), true);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("a later reclaimer completes an inode-bound claim abandoned by a crashed reclaimer", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-abandoned-claim-")));
  const runName = "run-stale-abandoned-Z9";
  const runDirectory = join(root, runName);
  await mkdir(runDirectory, {mode: 0o700});
  await writeFile(join(runDirectory, "lease.v1.json"), `${JSON.stringify({
    schemaVersion: 1, kind: "agtmai-local-evm-run",
    runner: {pid: 2147483647, processStart: "linux:1"}, anvil: null,
  })}\n`, {mode: 0o600});
  const identity = await lstat(runDirectory, {bigint: true});
  const abandoned = join(root, `.reclaim-v1-${identity.dev}-${identity.ino}-${identity.birthtimeNs}-999-${"a".repeat(24)}-${runName}`);
  await rename(runDirectory, abandoned);
  try {
    assert.equal(await reclaimStaleRuns(root), 1);
    assert.deepEqual(await readdir(root), []);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("stale authenticated provisional directory is reclaimed without a lease", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-provisional-")));
  const initializer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  assert(initializer.pid);
  const identity = await processStartIdentity(initializer.pid);
  const runDirectory = await mkdtemp(join(root, `run-init-${initializer.pid}-${identity.replace(":", "x")}-killed-Z9-`));
  const closed = new Promise<void>((resolve) => {initializer.once("close", () => resolve());});
  initializer.kill("SIGKILL");
  await closed;
  try {
    assert.equal(await reclaimStaleRuns(root), 1);
    await assert.rejects(stat(runDirectory));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("unauthenticated markerless directory is preserved fail-closed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-unauthenticated-")));
  const runDirectory = join(root, "run-unknown-Z9");
  await mkdir(runDirectory, {mode: 0o700});
  try {
    await assert.rejects(reclaimStaleRuns(root), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_RUN_INITIALIZER_INVALID");
    assert.equal((await stat(runDirectory)).isDirectory(), true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface LeaseFixtureResult {
  readonly status: "fulfilled" | "rejected";
  readonly code?: string;
  readonly predecessorPreserved?: boolean;
}

async function runBoundedLeaseFixture(args: readonly string[]): Promise<LeaseFixtureResult> {
  const fixture = fileURLToPath(new URL("./fixtures/fifo-lease-child.ts", import.meta.url));
  const {stdout, stderr} = await execute(
    process.execPath,
    [fixture, ...args],
    {timeout: 2_000, killSignal: "SIGKILL"},
  );
  assert.equal(stderr, "");
  return JSON.parse(stdout) as LeaseFixtureResult;
}

async function chainId(url: string): Promise<string> {
  const { stdout } = await execute(castBinary, ["chain-id", "--rpc-url", url], { timeout: 30_000, killSignal: "SIGKILL" });
  return `0x${BigInt(stdout.trim()).toString(16)}`;
}
