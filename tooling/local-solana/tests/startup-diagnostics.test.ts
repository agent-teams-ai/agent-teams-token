import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ValidatorStartRequest } from "../src/application/ports.ts";
import { PrivateRunStore } from "../src/adapters/filesystem.ts";
import { OwnedValidatorAdapter } from "../src/adapters/process.ts";
import { readStartupDiagnostic, recordStartupStage, reserveStartupCustody, startupFailureCode } from "../src/adapters/startup-custody.ts";

class FakeSupervisor extends EventEmitter {
  public connected = true;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public stopped = false;
  private readonly onStart?: () => void;
  public constructor(onStart?: () => void) { super(); this.onStart = onStart; }
  public send(message: { readonly type: string }): boolean {
    if (message.type === "start") { this.onStart?.(); }
    if (message.type === "stop") {
      this.stopped = true;
      queueMicrotask(() => { this.connected = false; this.exitCode = 1; this.emit("close", 1, null); });
    }
    return true;
  }
}

async function privateRun(): Promise<{ root: string; store: PrivateRunStore; paths: Awaited<ReturnType<PrivateRunStore["create"]>> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-startup-diagnostic-")));
  const store = new PrivateRunStore(join(root, "runs"), join(root, "out"));
  return { root, store, paths: await store.create() };
}

function request(paths: Awaited<ReturnType<PrivateRunStore["create"]>>, signal: AbortSignal, executable = join(paths.directory, "missing-private-key.json")): ValidatorStartRequest {
  return {
    executable, ledger: paths.ledger, config: join(paths.directory, "config"), genesisMint: "5".repeat(32),
    tokenProgram: process.execPath, associatedTokenProgram: process.execPath, rpcPort: 30_000,
    faucetPort: 30_002, gossipPort: 30_010, dynamicPortRange: "30010-30137",
    env: { PATH: "/usr/bin:/bin", PRIVATE_PASSWORD: "do-not-report-this" }, signal,
    leaseToken: paths.leaseToken, registerIdentity: async () => { assert.fail("validator must not spawn"); },
  };
}

test("stalled pre-spawn supervisor yields bounded explicit uncertainty and preserves custody", async () => {
  const { root, paths } = await privateRun(); const controller = new AbortController();
  const fake = new FakeSupervisor();
  const adapter = new OwnedValidatorAdapter((() => fake as unknown as ChildProcess) as typeof import("node:child_process").fork);
  try {
    const started = Date.now(); const pending = adapter.start(request(paths, controller.signal));
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, /SOLANA_CHILD_STOP_TIMEOUT.*stage=reserved/u);
    assert.ok(Date.now() - started < 2_000, "abort resolves without waiting for a pre-spawn promise");
    assert.equal(fake.stopped, true);
    assert.equal((await readStartupDiagnostic(paths.directory, paths.leaseToken)).stage, "reserved");
    const marker = JSON.parse(await readFile(join(paths.directory, ".agtmai-validator-startup.json"), "utf8"));
    assert.equal(marker.settled, false);
  } finally { controller.abort(); await rm(root, { recursive: true, force: true }); }
});

test("supervisor startup failure retains sanitized code and does not claim a settled stop", async () => {
  const { root, paths } = await privateRun();
  let fake: FakeSupervisor;
  fake = new FakeSupervisor(() => queueMicrotask(() => fake.emit("message", { type: "startupFailure", phase: "reserved", code: "EACCES" })));
  const adapter = new OwnedValidatorAdapter((() => fake as unknown as ChildProcess) as typeof import("node:child_process").fork);
  try {
    await assert.rejects(adapter.start(request(paths, new AbortController().signal)), /SOLANA_CHILD_STOP_TIMEOUT.*failure=EACCES/u);
    assert.equal(fake.stopped, true);
    assert.equal((await readStartupDiagnostic(paths.directory, paths.leaseToken)).stage, "reserved");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("synchronous supervisor fork failure records only safe evidence", async () => {
  const { root, paths } = await privateRun();
  const adapter = new OwnedValidatorAdapter((() => { throw Object.assign(new Error("PASSWORD=private /private/payer.json"), { code: "EACCES" }); }) as typeof import("node:child_process").fork);
  try {
    await assert.rejects(adapter.start(request(paths, new AbortController().signal)), /SOLANA_VALIDATOR_EARLY_EXIT.*custody unsettled cause=EACCES/u);
    const diagnostic = await readStartupDiagnostic(paths.directory, paths.leaseToken);
    assert.deepEqual(diagnostic.failure, { phase: "reserved", code: "EACCES" });
    assert.equal(diagnostic.stage, "failed");
    assert.equal(JSON.stringify(diagnostic).includes("PASSWORD=private"), false);
    assert.equal(JSON.parse(await readFile(join(paths.directory, ".agtmai-validator-startup.json"), "utf8")).settled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pre-acquire failure code is durable while custody stays unsettled", async () => {
  const { root, paths } = await privateRun();
  try {
    const custody = await reserveStartupCustody(paths.ledger, paths.leaseToken);
    await recordStartupStage(custody, "failed", { phase: "reserved", cause: { code: "EACCES", message: "password=private" } });
    assert.deepEqual((await readStartupDiagnostic(paths.directory, paths.leaseToken)).failure, { phase: "reserved", code: "EACCES" });
    const marker = await readFile(join(paths.directory, ".agtmai-validator-startup.json"), "utf8");
    assert.equal(JSON.parse(marker).settled, false);
    assert.equal(marker.includes("password=private"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed fake validator spawn leaves durable stage and allowlisted failure without secrets", { timeout: 8_000 }, async () => {
  const { root, store, paths } = await privateRun();
  try {
    let thrown: unknown;
    try { await new OwnedValidatorAdapter().start(request(paths, new AbortController().signal)); }
    catch (cause) { thrown = cause; }
    assert.match(String(thrown), /SOLANA_VALIDATOR_EARLY_EXIT.*cause=ENOENT/u);
    const marker = await readFile(join(paths.directory, ".agtmai-validator-startup.json"), "utf8");
    const diagnostic = await readStartupDiagnostic(paths.directory, paths.leaseToken);
    assert.equal(diagnostic.stage, "settled");
    assert.deepEqual(diagnostic.failure, { phase: "spawned", code: "ENOENT" });
    assert.equal(JSON.parse(marker).settled, true);
    for (const secret of [paths.directory, paths.leaseToken, "do-not-report-this", "missing-private-key.json"]) {
      assert.equal(JSON.stringify(diagnostic).includes(secret), false);
      assert.equal(String(thrown).includes(secret), false);
    }
    await store.cleanup(paths);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private startup evidence and raised error exclude sensitive fake validator stderr", { timeout: 20_000 }, async () => {
  const { root, store, paths } = await privateRun();
  const executable = join(paths.directory, "fake-validator");
  const sensitive = "PASSWORD=very-private-value";
  try {
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${sensitive} ${paths.ledger} ${paths.leaseToken} /private/payer.json' >&2\nexit 17\n`, { mode: 0o700 });
    await chmod(executable, 0o700);
    let thrown: unknown;
    try { await new OwnedValidatorAdapter().start(request(paths, new AbortController().signal, executable)); }
    catch (cause) { thrown = cause; }
    assert.ok(thrown);
    const diagnostic = await readStartupDiagnostic(paths.directory, paths.leaseToken);
    assert.equal(diagnostic.stage, "settled");
    assert.equal(JSON.parse(await readFile(join(paths.directory, ".agtmai-validator-startup.json"), "utf8")).settled, true);
    for (const secret of [sensitive, paths.ledger, paths.leaseToken, "/private/payer.json"]) {
      assert.equal(JSON.stringify(diagnostic).includes(secret), false);
      assert.equal(String(thrown).includes(secret), false);
    }
    assert.equal(startupFailureCode({ code: "EPASSWORDVERYPRIVATEVALUE" }), "UNKNOWN");
    await store.cleanup(paths);
  } finally { await rm(root, { recursive: true, force: true }); }
});
