import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { processStartIdentity, startOwnedAnvil } from "../process.ts";
import { reclaimStaleRuns } from "../run-lease.ts";

const execute = promisify(execFile);
const firstAddress = "0x7000000000000000000000000000000000000001";
const secondAddress = "0x7000000000000000000000000000000000000002";

test("Anvil startup failure is fail-closed and leaves no child behind", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-anvil-failure-"));
  const pidPath = join(directory, "pid");
  const executable = join(directory, "fail-anvil.sh");
  await writeFile(executable, `#!/bin/sh\nprintf '%s' "$$" > '${pidPath}'\nexit 17\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  await assert.rejects(startOwnedAnvil(executable, firstAddress), /exited before listening/);
  const pid = Number(await readFile(pidPath, "utf8"));
  assert.equal(processExists(pid), false);
  await rm(directory, { recursive: true, force: true });
});

test("a missing Anvil executable rejects through the owned-process API", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-anvil-missing-"));
  try {
    await assert.rejects(startOwnedAnvil(join(directory, "absent-anvil"), firstAddress), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stopping one owned PID does not affect a neighbouring Anvil", { timeout: 20_000 }, async () => {
  const first = await startOwnedAnvil("anvil", firstAddress);
  const second = await startOwnedAnvil("anvil", secondAddress);
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
  const anvil = await startOwnedAnvil("anvil", firstAddress);
  try {
    assert.deepEqual(Object.keys(anvil).toSorted(), ["pid", "rpcUrl", "stop"]);
    assert.match(anvil.rpcUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/$/);
    assert.equal(JSON.stringify(anvil).includes("private"), false);
    assert.equal(JSON.stringify(anvil).includes("mnemonic"), false);
  } finally { await anvil.stop(); }
});

test("concurrent stop callers share cleanup through forced termination", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-anvil-concurrent-stop-"));
  const executable = join(directory, "stubborn-anvil.mjs");
  await writeFile(executable, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nprocess.stdout.write('Listening on 127.0.0.1:18545\\n');\nsetInterval(() => {}, 1000);\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  try {
    const anvil = await startOwnedAnvil(executable, firstAddress);
    const first = anvil.stop();
    const second = anvil.stop();
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal(processExists(anvil.pid), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale-run recovery terminates only the exact recorded child identity", { timeout: 20_000 }, async () => {
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
    assert.equal(await reclaimStaleRuns(root), 1);
    assert.equal(processExists(owned.pid), false);
    assert.equal(processExists(neighbour.pid), true);
    await assert.rejects(stat(runDirectory));
  } finally {
    if (processExists(owned.pid)) { owned.kill("SIGKILL"); }
    if (processExists(neighbour.pid)) { neighbour.kill("SIGKILL"); }
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel recovery waits for an atomically initializing run lease", { timeout: 10_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-local-evm-initializing-")));
  const runDirectory = join(root, "run-initializing-Z9");
  await mkdir(runDirectory, { mode: 0o700 });
  const processStart = await processStartIdentity(process.pid);
  const writer = (async () => {
    await delay(50);
    await writeFile(join(runDirectory, "lease.v1.json"), `${JSON.stringify({
      schemaVersion: 1,
      kind: "agtmai-local-evm-run",
      runner: { pid: process.pid, processStart },
      anvil: null,
    })}\n`, { mode: 0o600 });
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

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function chainId(url: string): Promise<string> {
  const { stdout } = await execute("cast", ["chain-id", "--rpc-url", url], { timeout: 10_000, killSignal: "SIGKILL" });
  return `0x${BigInt(stdout.trim()).toString(16)}`;
}
