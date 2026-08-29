import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCommandAdapter, OwnedValidatorAdapter, redact } from "../src/adapters/process.ts";

test("process adapter rejects PATH fallback and bounds execution", async () => {
  const adapter = new NodeCommandAdapter();
  await assert.rejects(adapter.run("node", ["--version"]), /SOLANA_EXECUTABLE_ABSOLUTE/u);
  await assert.rejects(adapter.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30 }), /SOLANA_COMMAND_TIMEOUT/u);
});

test("process interruption terminates only its exact child", async () => {
  const adapter = new NodeCommandAdapter(); const controller = new AbortController();
  const pending = adapter.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /SOLANA_COMMAND_ABORTED/u);
  const neighbour = await adapter.run(process.execPath, ["-e", "process.stdout.write('alive')"]);
  assert.equal(neighbour.stdout, "alive");
});

test("diagnostics redact mnemonic-like values and key paths", () => {
  const value = redact("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu /tmp/run/payer.json");
  assert.equal(value.includes("alpha beta"), false); assert.equal(value.includes("payer.json"), false);
});

test("validator startup failure terminates the spawned child before rejecting", { skip: process.platform !== "linux" ? "test helper relies on Linux procfs identity" : false }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-validator-start-")); await chmod(boundary, 0o700);
  const executable = join(boundary, "validator"); const ledger = join(boundary, "ledger"); const config = join(boundary, "config.yml");
  await writeFile(executable, "#!/bin/bash\nwhile :; do /bin/sleep 1; done\n", { mode: 0o700 }); await mkdir(ledger, { mode: 0o700 }); await writeFile(config, "fixture", { mode: 0o600 });
  let childPid: number | undefined;
  try {
    await assert.rejects(new OwnedValidatorAdapter().start({
      executable, ledger, config, genesisMint: "5".repeat(32), tokenProgram: executable, associatedTokenProgram: executable,
      rpcPort: 30_000, faucetPort: 30_002, gossipPort: 30_010, dynamicPortRange: "30010-30137", env: { PATH: "/usr/bin:/bin" },
      signal: new AbortController().signal, leaseToken: "a".repeat(64), registerIdentity: (identity) => { childPid = identity.pid; throw new Error("registration failed"); },
    }), /registration failed/u);
    assert.ok(childPid); assert.equal(processAlive(childPid), false);
  } finally { if (childPid !== undefined && processAlive(childPid)) { process.kill(childPid, "SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
