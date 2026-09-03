import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { assertValidatorRpcListener, captureValidatorIdentity } from "../src/adapters/process-identity.ts";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeCommandAdapter, OwnedValidatorAdapter, redact } from "../src/adapters/process.ts";

test("process adapter rejects PATH fallback and bounds execution", async () => {
  const adapter = new NodeCommandAdapter();
  await assert.rejects(adapter.run("node", ["--version"]), /SOLANA_EXECUTABLE_ABSOLUTE/u);
  await assert.rejects(adapter.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30 }), /SOLANA_COMMAND_TIMEOUT/u);
});

test("already-aborted command and validator paths spawn nothing", async () => {
  const controller = new AbortController(); controller.abort();
  const adapter = new NodeCommandAdapter();
  await assert.rejects(adapter.run(process.execPath, ["-e", "process.exit(0)"], { signal: controller.signal }), /SOLANA_COMMAND_ABORTED/u);
  await assert.rejects(new OwnedValidatorAdapter().start({
    executable: process.execPath, ledger: "/tmp/ledger", config: "/tmp/config", genesisMint: "5".repeat(32),
    tokenProgram: process.execPath, associatedTokenProgram: process.execPath, rpcPort: 30000, faucetPort: 30002,
    gossipPort: 30010, dynamicPortRange: "30010-30137", env: { PATH: "/usr/bin:/bin" }, signal: controller.signal,
    leaseToken: "a".repeat(64), registerIdentity: async () => { throw new Error("must not register"); },
  }), /SOLANA_COMMAND_ABORTED/u);
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
  const executable = await buildValidator(boundary); const ledger = join(boundary, "ledger"); const config = join(boundary, "config.yml");
  await mkdir(ledger, { mode: 0o700 }); await writeFile(config, "fixture", { mode: 0o600 });
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

test("validator survives only after the supervisor receives post-registration acknowledgement", { skip: process.platform !== "linux" ? "test helper relies on Linux procfs identity" : false }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-validator-ack-")); await chmod(boundary, 0o700);
  const executable = await buildValidator(boundary); const ledger = join(boundary, "ledger"); const config = join(boundary, "config.yml");
  await mkdir(ledger, { mode: 0o700 }); await writeFile(config, "fixture", { mode: 0o600 });
  let childPid: number | undefined;
  try {
    const handle = await new OwnedValidatorAdapter().start({
      executable, ledger, config, genesisMint: "5".repeat(32), tokenProgram: executable, associatedTokenProgram: executable,
      rpcPort: 30_000, faucetPort: 30_002, gossipPort: 30_010, dynamicPortRange: "30010-30137", env: { PATH: "/usr/bin:/bin" },
      signal: new AbortController().signal, leaseToken: "a".repeat(64), registerIdentity: async (identity) => { childPid = identity.pid; },
    });
    assert.equal(handle.pid, childPid); assert.ok(childPid); assert.equal(processAlive(childPid), true);
    await handle.stop(); assert.equal(processAlive(childPid), false);
  } finally { if (childPid !== undefined && processAlive(childPid)) { process.kill(childPid, "SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

test("validator capture rejects an executable other than the expected canonical binary", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native process identity unsupported" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-validator-exe-")); const ledger = join(directory, "ledger"); await mkdir(ledger); const token = "b".repeat(64);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--ledger", ledger], { env: { ...process.env, AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: token }, stdio: "ignore" });
  try { await once(child, "spawn"); await assert.rejects(captureValidatorIdentity(child.pid!, "/bin/false", ledger, token), /SOLANA_VALIDATOR_IDENTITY/u); }
  finally { child.kill("SIGKILL"); await once(child, "close"); await rm(directory, { recursive: true, force: true }); }
});

test("RPC listener acceptance is bound to the immutable validator PID and fails after replacement", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native listener identity unsupported" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-validator-listener-")); const ledger = join(directory, "ledger"); await mkdir(ledger); const token = "c".repeat(64);
  const code = "const s=require('node:http').createServer((q,r)=>r.end());s.listen(0,'127.0.0.1',()=>process.send(s.address().port));";
  const child = spawn(process.execPath, ["-e", code, "--", "--ledger", ledger], { env: { ...process.env, AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: token }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let replacement: ReturnType<typeof spawn> | undefined;
  try {
    const [port] = await once(child, "message") as [number]; const identity = await captureValidatorIdentity(child.pid!, await realpath(process.execPath), ledger, token); await assertValidatorRpcListener(identity, token, port);
    child.kill("SIGKILL"); await once(child, "close");
    replacement = spawn(process.execPath, ["-e", `require('node:http').createServer((q,r)=>r.end()).listen(${port},'127.0.0.1')`], { stdio: "ignore" }); await once(replacement, "spawn"); await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(assertValidatorRpcListener(identity, token, port), /SOLANA_VALIDATOR_IDENTITY/u);
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); } if (replacement?.exitCode === null) { replacement.kill("SIGKILL"); await once(replacement, "close"); } await rm(directory, { recursive: true, force: true }); }
});

async function buildValidator(directory: string): Promise<string> { const source = join(directory, "validator.c"); const executable = join(directory, "validator"); await writeFile(source, "#include <unistd.h>\nint main(void){for(;;) pause();}\n"); await new Promise<void>((resolve, reject) => execFile("/usr/bin/cc", [source, "-o", executable], (cause) => cause ? reject(cause) : resolve())); return executable; }

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
