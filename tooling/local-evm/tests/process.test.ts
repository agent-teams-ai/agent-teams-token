import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { startOwnedAnvil } from "../process.ts";

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

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function chainId(url: string): Promise<string> {
  const { stdout } = await execute("cast", ["chain-id", "--rpc-url", url], { timeout: 10_000, killSignal: "SIGKILL" });
  return `0x${BigInt(stdout.trim()).toString(16)}`;
}
