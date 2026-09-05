import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { assertValidatorRpcListener, authenticateValidatorIdentity, captureValidatorIdentity, parseDarwinLsofListener } from "../src/adapters/process-identity.ts";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

test("aborting a running validator terminates the authenticated child", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native process identity unsupported" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-validator-abort-")); await chmod(boundary, 0o700);
  const executable = await buildValidator(boundary); const ledger = join(boundary, "ledger"); const config = join(boundary, "config.yml"); await mkdir(ledger); await writeFile(config, "fixture");
  const controller = new AbortController(); let validatorPid: number | undefined;
  try {
    const handle = await new OwnedValidatorAdapter().start({
      executable, ledger, config, genesisMint: "5".repeat(32), tokenProgram: executable, associatedTokenProgram: executable,
      rpcPort: 30_100, faucetPort: 30_102, gossipPort: 30_110, dynamicPortRange: "30110-30237", env: { PATH: "/usr/bin:/bin" },
      signal: controller.signal, leaseToken: "f".repeat(64), registerIdentity: async (identity) => { validatorPid = identity.pid; },
    });
    controller.abort(); const deadline = Date.now() + 3_000;
    while (processAlive(handle.pid) && Date.now() < deadline) { await new Promise<void>((resolve) => { setTimeout(resolve, 20); }); }
    assert.equal(processAlive(handle.pid), false); await handle.stop();
  } finally { controller.abort(); if (validatorPid !== undefined && processAlive(validatorPid)) { process.kill(validatorPid, "SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

test("registration failure reaps both the observed direct child and its supervisor", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native process identity unsupported", timeout: 10_000 }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-validator-capture-failure-")); await chmod(boundary, 0o700);
  const executable = await buildValidator(boundary); const ledger = join(boundary, "ledger"); const config = join(boundary, "config.yml"); await mkdir(ledger); await writeFile(config, "fixture");
  let childPid: number | undefined;
  try {
    await assert.rejects(new OwnedValidatorAdapter().start({
      executable, ledger, config, genesisMint: "5".repeat(32), tokenProgram: executable, associatedTokenProgram: executable,
      rpcPort: 30_103, faucetPort: 30_105, gossipPort: 30_113, dynamicPortRange: "30113-30240", env: { PATH: "/usr/bin:/bin" },
      signal: new AbortController().signal, leaseToken: "9".repeat(64), registerIdentity: async (identity) => {
        childPid = identity.pid; assert.equal(processAlive(identity.pid), true); throw new Error("forced registration failure");
      },
    }), /forced registration failure/u);
    assert.ok(childPid); assert.equal(processAlive(childPid), false);
    await assertNoProcessUsesBoundary(boundary, 3_000);
  } finally { if (childPid !== undefined && processAlive(childPid)) { process.kill(childPid, "SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

test("abort bounds a registration callback that never settles and reaps the validator", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native process identity unsupported", timeout: 10_000 }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-validator-registration-abort-")); await chmod(boundary, 0o700);
  const executable = await buildValidator(boundary); const ledger = join(boundary, "ledger"); const config = join(boundary, "config.yml"); await mkdir(ledger); await writeFile(config, "fixture");
  const controller = new AbortController(); let childPid: number | undefined;
  try {
    const start = new OwnedValidatorAdapter().start({
      executable, ledger, config, genesisMint: "5".repeat(32), tokenProgram: executable, associatedTokenProgram: executable,
      rpcPort: 30_106, faucetPort: 30_108, gossipPort: 30_116, dynamicPortRange: "30116-30243", env: { PATH: "/usr/bin:/bin" },
      signal: controller.signal, leaseToken: "8".repeat(64), registerIdentity: async (identity) => { childPid = identity.pid; controller.abort(); await new Promise(() => {}); },
    });
    await assert.rejects(start, /SOLANA_COMMAND_ABORTED/u); assert.ok(childPid); assert.equal(processAlive(childPid), false);
  } finally { controller.abort(); if (childPid !== undefined && processAlive(childPid)) { process.kill(childPid, "SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

test("registration timeout reaps the validator and supervisor", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native process identity unsupported", timeout: 10_000 }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-validator-registration-timeout-")); await chmod(boundary, 0o700);
  const executable = await buildValidator(boundary); const ledger = join(boundary, "ledger"); const config = join(boundary, "config.yml"); await mkdir(ledger); await writeFile(config, "fixture");
  let childPid: number | undefined;
  try {
    await assert.rejects(new OwnedValidatorAdapter().start({
      executable, ledger, config, genesisMint: "5".repeat(32), tokenProgram: executable, associatedTokenProgram: executable,
      rpcPort: 30_109, faucetPort: 30_111, gossipPort: 30_119, dynamicPortRange: "30119-30246", env: { PATH: "/usr/bin:/bin" },
      signal: new AbortController().signal, leaseToken: "7".repeat(64), registerIdentity: async (identity) => { childPid = identity.pid; await new Promise(() => {}); },
    }), /SOLANA_VALIDATOR_SUPERVISOR_TIMEOUT/u);
    assert.ok(childPid); assert.equal(processAlive(childPid), false);
  } finally { if (childPid !== undefined && processAlive(childPid)) { process.kill(childPid, "SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

test("validator capture normalizes a missing expected executable to typed identity failure", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native process identity unsupported" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-validator-exe-")); const ledger = join(directory, "ledger"); await mkdir(ledger); const token = "b".repeat(64);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--ledger", ledger, "--bind-address", "127.0.0.1", "--rpc-port", "30000"], { env: { ...process.env, AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: token }, stdio: "ignore" });
  try { await once(child, "spawn"); const childPid = child.pid; assert.ok(childPid); await assert.rejects(captureValidatorIdentity(childPid, join(directory, "missing-validator"), ledger, token), /SOLANA_VALIDATOR_IDENTITY/u); }
  finally { child.kill("SIGKILL"); await once(child, "close"); await rm(directory, { recursive: true, force: true }); }
});

test("RPC listener acceptance is bound to the immutable validator PID and fails after replacement", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native listener identity unsupported" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-validator-listener-")); const ledger = join(directory, "ledger"); await mkdir(ledger); const token = "c".repeat(64);
  const port = await availableTestPort();
  const code = "const s=require('node:http').createServer((q,r)=>r.end());s.listen(Number(process.argv.at(-1)),'127.0.0.1',()=>process.send(s.address().port));";
  const child = spawn(process.execPath, ["-e", code, "--", "--ledger", ledger, "--bind-address", "127.0.0.1", "--rpc-port", String(port)], { env: { ...process.env, AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: token }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let replacement: ReturnType<typeof spawn> | undefined;
  try {
    const [observedPort] = await once(child, "message") as [number]; assert.equal(observedPort, port); const identity = await captureValidatorIdentity(child.pid!, await realpath(process.execPath), ledger, token); await assertValidatorRpcListener(identity, token, port);
    child.kill("SIGKILL"); await once(child, "close");
    replacement = spawn(process.execPath, ["-e", `require('node:http').createServer((q,r)=>r.end()).listen(${port},'127.0.0.1')`], { stdio: "ignore" }); await once(replacement, "spawn"); await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    await assert.rejects(assertValidatorRpcListener(identity, token, port), /SOLANA_VALIDATOR_IDENTITY/u);
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); } if (replacement?.exitCode === null) { replacement.kill("SIGKILL"); await once(replacement, "close"); } await rm(directory, { recursive: true, force: true }); }
});

test("validator capture canonicalizes a ledger path alias", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native process identity unsupported" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-validator-alias-")); const ledger = join(directory, "ledger"); const alias = join(directory, "ledger-alias"); await mkdir(ledger); await symlink(ledger, alias); const token = "d".repeat(64);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--ledger", alias, "--bind-address", "127.0.0.1", "--rpc-port", "30001"], { env: { ...process.env, AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: token }, stdio: "ignore" });
  try {
    await once(child, "spawn"); const childPid = child.pid; assert.ok(childPid);
    const identity = await captureValidatorIdentity(childPid, process.execPath, ledger, token);
    assert.equal(identity.ledger, await realpath(ledger));
    assert.equal(await authenticateValidatorIdentity(identity, token), true);
    assert.equal(await authenticateValidatorIdentity(identity, "f".repeat(64)), false);
  }
  finally { child.kill("SIGKILL"); await once(child, "close"); await rm(directory, { recursive: true, force: true }); }
});

test("validator capture rejects missing, non-directory and substituted observed ledgers with a typed error", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "native process identity unsupported" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-validator-paths-")); const expected = join(directory, "ledger"); const other = join(directory, "other"); const file = join(directory, "ledger-file"); await mkdir(expected); await mkdir(other); await writeFile(file, "not a directory"); const token = "e".repeat(64);
  try {
    for (const observed of [join(directory, "missing"), file, other]) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", "--ledger", observed, "--bind-address", "127.0.0.1", "--rpc-port", "30002"], { env: { ...process.env, AGTMAI_LOCAL_SOLANA_LEASE_TOKEN: token }, stdio: "ignore" });
      try { await once(child, "spawn"); const childPid = child.pid; assert.ok(childPid); await assert.rejects(captureValidatorIdentity(childPid, process.execPath, expected, token), /SOLANA_VALIDATOR_IDENTITY/u); }
      finally { child.kill("SIGKILL"); await once(child, "close"); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Darwin lsof parser accepts one exact-PID wildcard listener and reports its honest scope", () => {
  assert.deepEqual(parseDarwinLsofListener("p21782\nf67\nPTCP\nn*:49564\nTST=LISTEN\nTQR=0\n", 21782, 49564), { scope: "wildcard" });
  assert.deepEqual(parseDarwinLsofListener("p21782\nf67\nPTCP\nn[::1]:49564\nTST=LISTEN\n", 21782, 49564), { scope: "ipv6-loopback" });
});

test("Darwin lsof parser rejects wrong PID, malformed, port-only and multiple records", () => {
  const invalid = [
    "p21783\nf67\nPTCP\nn*:49564\nTST=LISTEN\n",
    "p21782\nf67\nPTCP\nn*:49564\n",
    "p21782\nf67\nPTCP\nn192.0.2.1:49564\nTST=LISTEN\n",
    "p21782\nf67\nPTCP\nn*:49564\nTST=LISTEN\nf68\nPTCP\nn127.0.0.1:49564\nTST=LISTEN\n",
    "p21782\nPTCP\nn*:49564\nTST=LISTEN\n",
  ];
  for (const output of invalid) { assert.throws(() => parseDarwinLsofListener(output, 21782, 49564), /SOLANA_RPC_LISTENER_IDENTITY/u); }
});

async function availableTestPort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); await new Promise<void>((resolve, reject) => { server.close((cause) => cause === undefined ? resolve() : reject(cause)); });
  if (address === null || typeof address === "string") { throw new Error("test listener has no TCP port"); }
  return address.port;
}

async function buildValidator(directory: string): Promise<string> { const source = join(directory, "validator.c"); const executable = join(directory, "validator"); await writeFile(source, "#include <unistd.h>\nint main(void){for(;;) pause();}\n"); await new Promise<void>((resolve, reject) => { execFile("/usr/bin/cc", [source, "-o", executable], (cause) => { if (cause) { reject(cause); } else { resolve(); } }); }); return executable; }

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function assertNoProcessUsesBoundary(boundary: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let matches: readonly string[] = [];
  do {
    matches = await processesUsingBoundary(boundary);
    if (matches.length === 0) { return; }
    await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))); });
  } while (Date.now() < deadline);
  assert.fail("processes retained the unique validator boundary: " + matches.join(" | "));
}

async function processesUsingBoundary(boundary: string): Promise<readonly string[]> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,command="], { maxBuffer: 1024 * 1024 }, (cause, stdout) => cause ? reject(cause) : resolve(stdout));
  });
  return output.split("\n").filter((line) => line.includes(boundary));
}
