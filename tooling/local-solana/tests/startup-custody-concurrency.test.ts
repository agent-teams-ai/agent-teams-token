import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants, readFileSync, type BigIntStats } from "node:fs";
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateRunStore } from "../src/adapters/filesystem.ts";
import { readBoundedMarker } from "../src/adapters/lease-marker.ts";
import { processStartIdentity } from "../src/adapters/process-identity.ts";
import { recordStartupStage, reserveStartupCustody, startupCustodySettled, updateStartupCustody } from "../src/adapters/startup-custody.ts";

test("a registered write cannot overwrite stopping or settled custody", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agtmai-startup-race-")));
  const marker = join(directory, ".agtmai-validator-startup.json");
  const originalOpen = fs.open;
  let releaseWrite: (() => void) | undefined;
  let enteredWrite: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
  const release = new Promise<void>((resolve) => { releaseWrite = resolve; });
  try {
    await mkdir(join(directory, "ledger"));
    const custody = await reserveStartupCustody(join(directory, "ledger"), "a".repeat(64));
    await updateStartupCustody(custody, false);
    let pause = true;
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === marker && pause) {
        pause = false;
        const truncate = handle.truncate.bind(handle);
        handle.truncate = async (size?: number) => {
          enteredWrite?.();
          await release;
          return await truncate(size);
        };
      }
      return handle;
    }) as typeof fs.open;
    syncBuiltinESMExports();
    const registered = recordStartupStage(custody, "registered");
    await entered;
    const stopping = recordStartupStage(custody, "stopping");
    const settled = updateStartupCustody(custody, true);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    releaseWrite?.();
    await Promise.all([registered, stopping, settled]);
    const record = JSON.parse(await readFile(marker, "utf8")) as { settled: boolean; diagnostic: { stage: string } };
    assert.equal(record.settled, true);
    assert.equal(record.diagnostic.stage, "settled");
  } finally {
    releaseWrite?.();
    fs.open = originalOpen;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing startup marker cannot invoke legacy fallback while a pending guard exists", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agtmai-startup-missing-")));
  try {
    await mkdir(join(directory, "ledger"));
    const token = "c".repeat(64);
    await reserveStartupCustody(join(directory, "ledger"), token);
    await unlink(join(directory, ".agtmai-validator-startup.json"));
    assert.equal(await startupCustodySettled(directory, token, true), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed settlement sync retains durable uncertainty even when marker bytes say settled", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agtmai-startup-sync-fail-")));
  const marker = join(directory, ".agtmai-validator-startup.json");
  const originalOpen = fs.open;
  try {
    await mkdir(join(directory, "ledger"));
    const token = "b".repeat(64);
    const custody = await reserveStartupCustody(join(directory, "ledger"), token);
    await updateStartupCustody(custody, false);
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === marker) {
        const write = handle.write.bind(handle);
        const sync = handle.sync.bind(handle);
        let settlementWritten = false;
        handle.write = ((...values: Parameters<typeof write>) => {
          if (Buffer.isBuffer(values[0]) && values[0].toString("utf8").includes('"stage":"settled"')) { settlementWritten = true; }
          return write(...values);
        }) as typeof handle.write;
        handle.sync = async () => {
          if (settlementWritten) { throw Object.assign(new Error("injected sync failure"), { code: "ENOSPC" }); }
          return await sync();
        };
      }
      return handle;
    }) as typeof fs.open;
    syncBuiltinESMExports();
    await assert.rejects(updateStartupCustody(custody, true), { code: "ENOSPC" });
    assert.equal(await startupCustodySettled(directory, token), false);
    await assert.rejects(reserveStartupCustody(join(directory, "ledger"), token), /SOLANA_STARTUP_CUSTODY|EEXIST/u);
  } finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

type FixtureProcess = { readonly pid: number; readonly start: string };

interface GuardianCustodyExpectation {
  readonly directory: string;
  readonly token: string;
  readonly directoryIdentity: unknown;
  readonly validatorPid: number;
  readonly fixturePid: number | undefined;
}

test("pre-registration SIGKILL cannot orphan an unregistered validator", { skip: process.platform !== "linux" ? "fault injector uses a Linux validator shim" : false }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-preregister-sigkill-")); await chmod(boundary, 0o700);
  const runRoot = join(boundary, "runs"); const outputRoot = join(boundary, "out"); const readyPath = join(boundary, "spawned-before-registration.json");
  const executable = await buildValidator(boundary);
  const fixture = spawn(process.execPath, [join(import.meta.dirname, "helpers/start-unregistered-validator.ts"), runRoot, outputRoot, readyPath, executable], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = ""; fixture.stdout.on("data", (chunk) => { diagnostics += String(chunk); }); fixture.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
  let fixtureDidClose = false;
  const fixtureClosed = new Promise<void>((resolve) => { fixture.once("close", () => { fixtureDidClose = true; resolve(); }); });
  let validator: FixtureProcess | undefined; let guardian: FixtureProcess | undefined;
  try {
    let ready: { readonly validatorPid: number; readonly runDirectory: string } | undefined;
    for (let attempt = 0; attempt < 200 && ready === undefined && fixture.exitCode === null; attempt += 1) {
      try { ready = JSON.parse(await readFile(readyPath, "utf8")); } catch { await new Promise((resolve) => { setTimeout(resolve, 25); }); }
    }
    assert.ok(ready, `fixture did not enter the injected pre-registration window: ${diagnostics}`);
    assert.ok(Number.isSafeInteger(ready.validatorPid) && ready.validatorPid >= 1);
    assert.notEqual(ready.validatorPid, process.pid);
    assert.notEqual(ready.validatorPid, fixture.pid);
    const runDirectory = ready.runDirectory;
    const lease = JSON.parse(await readFile(join(runDirectory, ".agtmai-local-solana-lease.json"), "utf8")) as Record<string, unknown>;
    assert.equal(lease.validator, null, "fault must occur before durable validator registration");
    const token = lease.token; assert.ok(typeof token === "string" && /^[a-f0-9]{64}$/u.test(token));
    validator = { pid: ready.validatorPid, start: await processStartIdentity(ready.validatorPid) };
    assert.match(validator.start, /^linux:[0-9]+$/u);
    // Capture the existing guardian record before closing its owner's channel.
    const handle = await fs.open(join(runDirectory, ".agtmai-validator-startup.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const entry = await handle.stat({ bigint: true });
      guardian = await readGuardianIdentity(handle, entry, {
        directory: runDirectory,
        token,
        directoryIdentity: lease.directoryIdentity,
        validatorPid: validator.pid,
        fixturePid: fixture.pid,
      });
      const after = await handle.stat({ bigint: true });
      assert.equal(after.dev, entry.dev); assert.equal(after.ino, entry.ino); assert.equal(after.nlink, 1n);
      assert.equal(after.mode, entry.mode); assert.equal(after.uid, entry.uid);
    } finally { await handle.close(); }
    assert.ok(guardian);
    assert.equal(await processStartIdentity(guardian.pid), guardian.start, "recorded guardian must retain its captured kernel identity before SIGKILL");
    assert.equal(exited(guardian), false, "guardian must be alive at the injected fault");
    assert.equal(exited(validator), false, "validator must be alive at the injected fault");
    assert.equal(fixture.exitCode, null); assert.equal(fixture.signalCode, null);
    // One budget includes fixture close, both independent exit proofs and custody.
    const deadline = Date.now() + 5_000;
    assert.equal(fixture.kill("SIGKILL"), true, "fixture must receive the injected SIGKILL");
    while (true) {
      const guardianExited = exited(guardian); const validatorExited = exited(validator);
      if (fixtureDidClose && guardianExited && validatorExited) { break; }
      const remaining = deadline - Date.now();
      assert.ok(remaining > 0, `fixture, guardian and validator must exit within five seconds: closed=${fixtureDidClose} guardianExited=${guardianExited} validatorExited=${validatorExited}`);
      await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(25, remaining)); });
    }
    assert.ok(Date.now() < deadline, "exit proofs must fit the same five-second observation budget");
    assert.equal(fixture.signalCode, "SIGKILL");
    assert.equal(exited(guardian), true, "guardian must have exited independently before custody observation and reclamation");
    assert.equal(exited(validator), true, "supervisor must terminate the validator when the unacknowledged control channel closes");
    // The guardian is now dead, so an ineligible record is a failure, not a
    // reason to retry reclamation. Join the read; do not abandon it in a race.
    const custodyEligible = await startupCustodySettled(runDirectory, token);
    assert.ok(Date.now() < deadline, "completed custody observation must fit the same five-second budget");
    assert.equal(custodyEligible, true, "exited guardian must leave settled startup custody with no pending guard");
    assert.equal(exited(guardian), true, "guardian must already be dead before the reclaimer is allowed to act");
    assert.equal(exited(validator), true, "validator must already be dead before the reclaimer is allowed to act");
    assert.ok(Date.now() < deadline, "all independent preconditions must hold inside the five-second budget");
    assert.equal(await new PrivateRunStore(runRoot, outputRoot).reclaimStale(), 1);
    await assert.rejects(lstat(runDirectory), { code: "ENOENT" });
    assert.equal(exited(validator), true, "reclamation must leave no orphan validator");
    assert.equal(exited(guardian), true, "reclamation must leave no surviving guardian");
  } finally {
    if (!fixtureDidClose && fixture.exitCode === null && fixture.signalCode === null) { fixture.kill("SIGKILL"); }
    await fixtureClosed;
    await cleanupFixtureBoundary(boundary, validator, guardian);
  }
});

async function readGuardianIdentity(handle: FileHandle, entry: BigIntStats, expected: GuardianCustodyExpectation): Promise<FixtureProcess> {
  const expectedUid = process.getuid?.();
  assert.ok(
    entry.isFile() && entry.nlink === 1n && (entry.mode & 0o777n) === 0o600n
      && (expectedUid === undefined || entry.uid === BigInt(expectedUid)),
    "guardian custody marker must remain private and singly linked",
  );
  const raw: unknown = JSON.parse(await readBoundedMarker(handle));
  assert.ok(typeof raw === "object" && raw !== null && !Array.isArray(raw));
  const record = raw as Record<string, unknown>;
  assert.equal(record.directory, expected.directory);
  assert.equal(record.token, expected.token);
  assert.equal(record.settled, false, "startup custody must still be reserved at the injected fault");
  assert.deepEqual(record.directoryIdentity, expected.directoryIdentity);
  assert.deepEqual(record.markerIdentity, { dev: entry.dev.toString(), ino: entry.ino.toString() });
  const supervisor = record.supervisor;
  assert.ok(typeof supervisor === "object" && supervisor !== null && !Array.isArray(supervisor));
  const recorded = supervisor as Record<string, unknown>;
  assert.equal(Object.keys(recorded).toSorted().join(","), "pid,start");
  const guardianPid = recorded.pid;
  const guardianStart = recorded.start;
  assert.ok(typeof guardianPid === "number" && Number.isSafeInteger(guardianPid) && guardianPid >= 1);
  assert.ok(typeof guardianStart === "string" && /^linux:[0-9]+$/u.test(guardianStart));
  assert.notEqual(guardianPid, process.pid);
  assert.notEqual(guardianPid, expected.fixturePid);
  assert.notEqual(guardianPid, expected.validatorPid);
  return { pid: guardianPid, start: guardianStart };
}

// Only fresh PID absence or the captured-start zombie proves termination.
// Permission errors, malformed observations and PID replacement fail closed.
function exited(identity: FixtureProcess): boolean {
  try { process.kill(identity.pid, 0); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") { return true; } throw cause; }
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    assert.ok(end >= 0, "fixture process stat must contain a command boundary");
    const fields = stat.slice(end + 2).trim().split(/\s+/u);
    assert.ok(fields[19] !== undefined && /^[0-9]+$/u.test(fields[19]), "fixture process start must be available");
    assert.ok(fields[0] !== undefined && /^[RSDZTtWXxKIP]$/u.test(fields[0]), "fixture process state must be available");
    assert.equal(`linux:${fields[19]}`, identity.start, "fixture process PID was replaced");
    return fields[0] === "Z";
  } catch (cause) {
    if (["ENOENT", "ESRCH"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
      try { process.kill(identity.pid, 0); }
      catch (probeCause) { if ((probeCause as NodeJS.ErrnoException).code === "ESRCH") { return true; } throw probeCause; }
    }
    throw cause;
  }
}

function killExact(identity: FixtureProcess): void {
  if (exited(identity)) { return; }
  try { process.kill(identity.pid, "SIGKILL"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH" || !exited(identity)) { throw cause; } }
}

async function cleanupFixtureBoundary(boundary: string, validator: FixtureProcess | undefined, guardian: FixtureProcess | undefined): Promise<void> {
  if (validator !== undefined) { killExact(validator); }
  if (guardian !== undefined) { killExact(guardian); }
  // Preserve private state on an unproved failure-path identity or exit.
  // Teardown must not remove custody beneath a surviving captured process.
  if (validator !== undefined && guardian !== undefined && exited(validator) && exited(guardian)) {
    await rm(boundary, { recursive: true, force: true });
  }
}

async function buildValidator(directory: string): Promise<string> {
  const source = join(directory, "validator.c");
  const executable = join(directory, "validator");
  await writeFile(source, "#include <unistd.h>\nint main(void){for(;;) pause();}\n");
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/cc", [source, "-o", executable], (cause) => {
      if (cause) { reject(cause); } else { resolve(); }
    });
  });
  return executable;
}
