import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs, { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { PrivateRunStore, ensurePrivateRoot } from "../src/adapters/filesystem.ts";
import { processStartIdentity } from "../src/adapters/process-identity.ts";
import { verifyObservations } from "../src/application/verifier.ts";
import type { EvidenceReport } from "../src/domain/model.ts";
import type { RunPaths } from "../src/application/ports.ts";
import { observationFixture } from "./helpers/observations.ts";

function report(): EvidenceReport {
  return verifyObservations(observationFixture());
}

test("private store deletes keys and ledger while retaining READY-last sanitized evidence", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-test-")); await chmod(boundary, 0o700);
  const runs = join(boundary, "runs"); const output = join(boundary, "output");
  try {
    const store = new PrivateRunStore(runs, output); const paths = await store.create();
    await writeFile(paths.payerKey, "SENTINEL_SECRET"); await chmod(paths.payerKey, 0o600);
    await store.cleanup(paths); await assert.rejects(lstat(paths.directory));
    const observations = observationFixture();
    const published = await store.publish(observations, verifyObservations(observations));
    const directory = join(published.jsonPath, "..");
    assert.equal(JSON.parse(await readFile(published.jsonPath, "utf8")).assertions.mintAuthorityRevoked, false);
    assert.equal((await readFile(published.markdownPath, "utf8")).includes("SENTINEL_SECRET"), false);
    const ready = await lstat(join(directory, "READY")); const json = await lstat(published.jsonPath); const markdown = await lstat(published.markdownPath);
    assert.equal(ready.mtimeMs >= json.mtimeMs && ready.mtimeMs >= markdown.mtimeMs, true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("publication rejects schema drift before creating READY", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-schema-")); await chmod(boundary, 0o700); const output = join(boundary, "output");
  try {
    const store = new PrivateRunStore(join(boundary, "runs"), output); const invalid = { ...report(), transactions: report().transactions.slice(1) };
    await assert.rejects(store.publish(observationFixture(), invalid), /SOLANA_EVIDENCE_SCHEMA/u);
    await assert.rejects(lstat(output));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("publication rejects a valid but observation-inconsistent report", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-mismatch-")); await chmod(boundary, 0o700); const output = join(boundary, "output");
  try {
    const store = new PrivateRunStore(join(boundary, "runs"), output);
    const observations = observationFixture();
    const inconsistent = { ...verifyObservations(observations), validatorVersion: "different-valid-version" };
    await assert.rejects(store.publish(observations, inconsistent), /SOLANA_EVIDENCE_MISMATCH/u);
    await assert.rejects(lstat(output));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("publication independently rejects observations moved to a non-loopback RPC", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-rpc-")); await chmod(boundary, 0o700); const output = join(boundary, "output");
  try {
    const store = new PrivateRunStore(join(boundary, "runs"), output);
    const observations = observationFixture();
    await assert.rejects(store.publish({ ...observations, rpcUrl: "http://192.0.2.1:8899/" }, verifyObservations(observations)), /SOLANA_RPC_NOT_EXACT_LOOPBACK/u);
    await assert.rejects(lstat(output));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("post-mutation failure publication is sanitized and READY-last", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-failure-")); await chmod(boundary, 0o700); const output = join(boundary, "output");
  try {
    const store = new PrivateRunStore(join(boundary, "runs"), output);
    const published = await store.publishFailure({
      schemaVersion: 1, status: "FAILED", failedPhase: "burn",
      diagnosticCode: "SOLANA_CLI_FAILED", mutationsMayHaveOccurred: true,
      cleanupCompleted: true, validatorStopped: true, portLeaseReleased: true, privateDirectoryRemoved: true, publicNetwork: false, realAssetCostUsd: 0,
      secretsRetained: false, productionApproved: false,
    });
    const directory = join(published.jsonPath, "..");
    const json = await readFile(published.jsonPath, "utf8");
    const markdown = await readFile(published.markdownPath, "utf8");
    assert.doesNotMatch(`${json}${markdown}`, /rpcUrl|\/tmp|seed phrase|private key|http/iu);
    const ready = await lstat(join(directory, "READY"));
    assert.equal(ready.mtimeMs >= (await lstat(published.jsonPath)).mtimeMs, true);
    assert.equal(ready.mtimeMs >= (await lstat(published.markdownPath)).mtimeMs, true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("private roots reject symlinks and permissive directories", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-hostile-")); const target = join(boundary, "target"); await mkdir(target, { mode: 0o700 });
  try {
    const linked = join(boundary, "linked"); await symlink(target, linked); await assert.rejects(ensurePrivateRoot(linked), /SOLANA_DIRECTORY_UNSAFE/u);
    const open = join(boundary, "open"); await mkdir(open, { mode: 0o755 }); await chmod(open, 0o755); await assert.rejects(ensurePrivateRoot(open), /SOLANA_DIRECTORY_UNSAFE/u);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("cleanup rejects stale READY-like directories and hardlinked lease markers", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-attack-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json"); await link(marker, join(paths.directory, "lease-copy"));
    await assert.rejects(store.cleanup(paths), /SOLANA_LEASE_UNSAFE/u);
    await rm(paths.directory, { recursive: true, force: true });
    const fake = join(boundary, "runs", "run-fake"); await mkdir(fake, { mode: 0o700 }); await writeFile(join(fake, "READY"), "forged");
    assert.equal(await store.reclaimStale(), 0); assert.equal((await lstat(fake)).isDirectory(), true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("a subsequent invocation reclaims only a valid dead owned lease", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-reclaim-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json");
    const lease = JSON.parse(await readFile(marker, "utf8")); lease.pid = 2_000_000_000; await writeFile(marker, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    assert.equal(await store.reclaimStale(), 1); await assert.rejects(lstat(paths.directory));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("concurrent stores reclaim a genuine dead run exactly once and create independent runs", async () => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-concurrent-")));
  try {
    for (let round = 0; round < 3; round += 1) {
      const runs = join(boundary, `runs-${round}`); const output = join(boundary, "out");
      const dead = await createDeadRun(runs, output);
      const stores = [new PrivateRunStore(runs, output), new PrivateRunStore(runs, output)];
      const live = await stores[0]!.create(); await writeFile(live.payerKey, "LIVE_SENTINEL", { mode: 0o600 });
      const foreign = join(runs, "run-foreign"); await mkdir(foreign, { mode: 0o700 }); await writeFile(join(foreign, "sentinel"), "FOREIGN_SENTINEL");
      const results = await Promise.allSettled(stores.map(async (store) => ({ reclaimed: await store.reclaimStale(), paths: await store.create() })));
      const values = results.map((result) => { assert.ok(result.status === "fulfilled"); return result.value; });
      assert.deepEqual(values.map((value) => value.reclaimed).toSorted(), [0, 1]);
      assert.notEqual(values[0]!.paths.directory, values[1]!.paths.directory);
      await assert.rejects(lstat(dead.directory), { code: "ENOENT" });
      assert.equal(await readFile(live.payerKey, "utf8"), "LIVE_SENTINEL");
      assert.equal(await readFile(join(foreign, "sentinel"), "utf8"), "FOREIGN_SENTINEL");
      await Promise.all(values.map((value, index) => stores[index]!.cleanup(value.paths)));
      await stores[0]!.cleanup(live); assert.deepEqual(await readdir(runs), ["run-foreign"]);
    }
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("two separately spawned reclaimers settle a genuine dead lease and their independent runs", async () => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-process-reclaim-")));
  try {
    for (let round = 0; round < 3; round += 1) {
      const runs = join(boundary, `runs-${round}`); const output = join(boundary, "out"); await createDeadRun(runs, output);
      const source = `import { once } from "node:events"; import { PrivateRunStore } from ${JSON.stringify(new URL("../src/adapters/filesystem.ts", import.meta.url).href)};
        const store = new PrivateRunStore(${JSON.stringify(runs)}, ${JSON.stringify(output)});
        const start = once(process, "message"); process.send("ready"); await start; process.disconnect();
        const reclaimed = await store.reclaimStale(); const paths = await store.create(); await store.cleanup(paths);
        console.log(JSON.stringify({ reclaimed, directory: paths.directory }));`;
      const children = [0, 1].map(() => spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "pipe", "pipe", "ipc"], timeout: 10_000, killSignal: "SIGKILL" }));
      const results = children.map(async (child) => {
        let stdout = ""; let stderr = "";
        child.stdout!.on("data", (chunk) => { stdout += String(chunk); }); child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
        const [code, signal] = await once(child, "close"); assert.equal(code, 0, stderr); assert.equal(signal, null);
        return JSON.parse(stdout) as { readonly reclaimed: number; readonly directory: string };
      });
      try {
        await Promise.all(children.map(async (child, index) => {
          const [message] = await Promise.race([once(child, "message"), results[index]!.then(() => { throw new Error("reclaimer exited before its start barrier"); })]);
          assert.equal(message, "ready");
        }));
        for (const child of children) { child.send("reclaim"); }
        const settled = await Promise.allSettled(results);
        const values = settled.map((result) => { assert.ok(result.status === "fulfilled", JSON.stringify(result)); return result.value; });
        assert.deepEqual(values.map((value) => value.reclaimed).toSorted(), [0, 1]);
        assert.notEqual(values[0]!.directory, values[1]!.directory); assert.deepEqual(await readdir(runs), []);
      } finally {
        const liveChildren = children.filter((child) => child.exitCode === null && child.signalCode === null);
        for (const child of liveChildren) { child.kill("SIGKILL"); }
        await Promise.allSettled(results);
      }
    }
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("a stale reclaimer losing the rename to a completed claim reports zero", async (t) => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-lost-rename-")));
  const runs = join(boundary, "runs"); const output = join(boundary, "out"); const originalRename = fs.rename;
  try {
    const dead = await createDeadRun(runs, output); let raced = false;
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (args[0] === dead.directory && !raced) {
        raced = true; assert.equal(await new PrivateRunStore(runs, output).reclaimStale(), 1);
      }
      return originalRename(...args);
    });
    syncBuiltinESMExports();
    assert.equal(await new PrivateRunStore(runs, output).reclaimStale(), 0);
    assert.equal(raced, true); assert.deepEqual(await readdir(runs), []);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(boundary, { recursive: true, force: true }); }
});

test("a stale reclaimer tolerates an in-progress claim without counting or deleting it", async (t) => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-in-progress-")));
  const runs = join(boundary, "runs"); const output = join(boundary, "out"); const originalStat = fs.stat; const originalRm = fs.rm;
  const claimed = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>(); let winner: Promise<number> | undefined;
  try {
    const dead = await createDeadRun(runs, output); const quarantine = join(runs, `.quarantine-${dead.leaseToken}`); let raced = false; let removals = 0;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === quarantine) { removals += 1; claimed.resolve(); await finish.promise; }
      return originalRm(...args);
    });
    t.mock.method(fs, "stat", new Proxy(originalStat, { async apply(method, receiver, args) {
      if (args[0] === quarantine && !raced) {
        raced = true; winner = new PrivateRunStore(runs, output).reclaimStale();
        await Promise.race([claimed.promise, winner.then(() => { throw new Error("winner did not pause at deletion"); })]);
      }
      return Reflect.apply(method, receiver, args);
    } }));
    syncBuiltinESMExports();
    const loser = new PrivateRunStore(runs, output);
    assert.equal(await loser.reclaimStale(), 0); assert.equal(removals, 1);
    assert.equal((await lstat(quarantine, { bigint: true })).ino.toString(), dead.directoryIdentity.ino);
    const independent = await loser.create(); await loser.cleanup(independent);
    finish.resolve(); assert.equal(await winner, 1); assert.deepEqual(await readdir(runs), []);
  } finally { finish.resolve(); await winner?.catch(() => {}); t.mock.restoreAll(); syncBuiltinESMExports(); await rm(boundary, { recursive: true, force: true }); }
});

test("a stale reclaimer tolerates a completed claim during pre-claim validation", async (t) => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-lost-validation-")));
  const runs = join(boundary, "runs"); const output = join(boundary, "out"); const originalOpen = fs.open;
  try {
    const dead = await createDeadRun(runs, output); const marker = join(dead.directory, ".agtmai-local-solana-lease.json"); let reads = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === marker && ++reads === 2) { assert.equal(await new PrivateRunStore(runs, output).reclaimStale(), 1); }
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    assert.equal(await new PrivateRunStore(runs, output).reclaimStale(), 0); assert.ok(reads >= 2);
    assert.deepEqual(await readdir(runs), []);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(boundary, { recursive: true, force: true }); }
});

for (const substitution of ["missing-marker", "marker-inode", "token", "directory", "dangling-symlink", "root", "missing-root"] as const) {
  test(`stale reclaim preserves foreign state after pre-claim ${substitution} substitution`, async (t) => {
    const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-reclaim-substitution-")));
    const runs = join(boundary, "runs"); const output = join(boundary, "out"); const originalOpen = fs.open; const displaced = join(boundary, "displaced");
    try {
      const dead = await createDeadRun(runs, output); const marker = join(dead.directory, ".agtmai-local-solana-lease.json");
      await writeFile(dead.payerKey, "OWNED_SENTINEL", { mode: 0o600 }); const bytes = await readFile(marker, "utf8"); let reads = 0; let preserved = dead.payerKey;
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === marker && ++reads === 2) {
          if (substitution === "missing-marker" || substitution === "marker-inode") {
            await rename(marker, marker + ".saved");
            if (substitution === "marker-inode") { await writeFile(marker, bytes, { mode: 0o600 }); }
          } else if (substitution === "token") {
            const lease = JSON.parse(bytes); lease.token = "f".repeat(64); await writeFile(marker, JSON.stringify(lease));
          } else if (substitution === "directory" || substitution === "dangling-symlink") {
            await rename(dead.directory, displaced); preserved = join(displaced, "payer.json");
            if (substitution === "directory") { await mkdir(dead.directory, { mode: 0o700 }); await writeFile(join(dead.directory, "foreign"), "FOREIGN_SENTINEL"); }
            else { await symlink(join(boundary, "absent"), dead.directory); }
          } else {
            await rename(runs, displaced); preserved = join(displaced, dead.directory.slice(runs.length + 1), "payer.json");
            if (substitution === "root") { await mkdir(runs, { mode: 0o700 }); await writeFile(join(runs, "foreign"), "FOREIGN_SENTINEL"); }
          }
        }
        return originalOpen(...args);
      });
      syncBuiltinESMExports();
      await assert.rejects(new PrivateRunStore(runs, output).reclaimStale(), /ENOENT|SOLANA_CLEANUP_IDENTITY/u);
      assert.equal(reads, 2); assert.equal(await readFile(preserved, "utf8"), "OWNED_SENTINEL");
      if (substitution === "directory" || substitution === "root") { assert.equal(await readFile(join(substitution === "root" ? runs : dead.directory, "foreign"), "utf8"), "FOREIGN_SENTINEL"); }
      if (substitution === "dangling-symlink") { assert.equal((await lstat(dead.directory)).isSymbolicLink(), true); }
      if (substitution === "missing-marker" || substitution === "marker-inode") { assert.equal(await readFile(marker + ".saved", "utf8"), bytes); }
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(boundary, { recursive: true, force: true }); }
  });
}

test("stale reclaim preserves a conflicting quarantine and its foreign sentinel", async () => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-quarantine-conflict-")));
  const runs = join(boundary, "runs"); const output = join(boundary, "out");
  try {
    const dead = await createDeadRun(runs, output); const quarantine = join(runs, `.quarantine-${dead.leaseToken}`);
    await mkdir(quarantine, { mode: 0o700 }); await writeFile(join(quarantine, "foreign"), "FOREIGN_SENTINEL");
    await assert.rejects(new PrivateRunStore(runs, output).reclaimStale(), /SOLANA_CLEANUP_QUARANTINE/u);
    assert.equal(await readFile(join(quarantine, "foreign"), "utf8"), "FOREIGN_SENTINEL");
    assert.equal((await lstat(dead.directory, { bigint: true })).ino.toString(), dead.directoryIdentity.ino);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("ENOENT from cleanup after a successful stale claim remains a failure", async (t) => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-post-claim-")));
  const runs = join(boundary, "runs"); const output = join(boundary, "out"); const originalRm = fs.rm;
  try {
    const dead = await createDeadRun(runs, output); const quarantine = join(runs, `.quarantine-${dead.leaseToken}`); const displaced = join(boundary, "displaced"); let raced = false;
    await writeFile(dead.payerKey, "PRESERVED_SENTINEL", { mode: 0o600 });
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === quarantine) { raced = true; await rename(quarantine, displaced); }
      return originalRm(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(new PrivateRunStore(runs, output).reclaimStale(), { code: "ENOENT" });
    assert.equal(raced, true); assert.equal(await readFile(join(displaced, "payer.json"), "utf8"), "PRESERVED_SENTINEL");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(boundary, { recursive: true, force: true }); }
});

test("normal cleanup does not tolerate losing its own quarantine rename", async (t) => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-cleanup-lost-claim-")));
  const runs = join(boundary, "runs"); const store = new PrivateRunStore(runs, join(boundary, "out")); const originalRename = fs.rename;
  try {
    const paths = await store.create(); const displaced = join(boundary, "displaced");
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      if (args[0] === paths.directory) { await originalRename(paths.directory, displaced); }
      return originalRename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(store.cleanup(paths), { code: "ENOENT" });
    assert.equal((await lstat(displaced, { bigint: true })).ino.toString(), paths.directoryIdentity.ino);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(boundary, { recursive: true, force: true }); }
});

test("pre-claim validation stays bound to the original run when another valid lease replaces it", async (t) => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-valid-successor-")));
  const runs = join(boundary, "runs"); const output = join(boundary, "out"); const originalOpen = fs.open;
  try {
    await createDeadRun(runs, output); await createDeadRun(runs, output);
    const names = await readdir(runs); const directory = join(runs, names[0]!); const successor = join(runs, names[1]!);
    const marker = join(directory, ".agtmai-local-solana-lease.json"); const displaced = join(boundary, "displaced"); let reads = 0;
    await writeFile(join(successor, "foreign"), "FOREIGN_SENTINEL");
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === marker && ++reads === 2) { await rename(directory, displaced); await rename(successor, directory); }
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(new PrivateRunStore(runs, output).reclaimStale(), /SOLANA_CLEANUP_IDENTITY/u);
    assert.equal(reads, 2); assert.equal(await readFile(join(directory, "foreign"), "utf8"), "FOREIGN_SENTINEL");
    assert.equal((await lstat(displaced)).isDirectory(), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(boundary, { recursive: true, force: true }); }
});

test("concurrent stale scans preserve malformed and hardlinked genuine leases", async () => {
  const boundary = await realpath(await mkdtemp(join(tmpdir(), "agtmai-fs-invalid-stale-")));
  const runs = join(boundary, "runs"); const output = join(boundary, "out");
  try {
    const malformed = await createDeadRun(runs, output); const linked = await createDeadRun(runs, output);
    const marker = join(malformed.directory, ".agtmai-local-solana-lease.json"); await writeFile(marker, "{not-json");
    await link(join(linked.directory, ".agtmai-local-solana-lease.json"), join(linked.directory, "lease-copy"));
    await writeFile(linked.payerKey, "PRESERVED_SENTINEL", { mode: 0o600 });
    assert.deepEqual(await Promise.all([new PrivateRunStore(runs, output).reclaimStale(), new PrivateRunStore(runs, output).reclaimStale()]), [0, 0]);
    assert.equal(await readFile(marker, "utf8"), "{not-json"); assert.equal(await readFile(linked.payerKey, "utf8"), "PRESERVED_SENTINEL");
    assert.equal((await lstat(join(linked.directory, "lease-copy"))).nlink, 2);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

async function createDeadRun(runRoot: string, outputRoot: string): Promise<RunPaths> {
  const source = `import { PrivateRunStore } from ${JSON.stringify(new URL("../src/adapters/filesystem.ts", import.meta.url).href)}; console.log(JSON.stringify(await new PrivateRunStore(${JSON.stringify(runRoot)}, ${JSON.stringify(outputRoot)}).create()));`;
  const paths = await new Promise<RunPaths>((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "--eval", source], { timeout: 10_000 }, (cause, stdout) => {
      if (cause) { reject(cause); } else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
  const lease = JSON.parse(await readFile(join(paths.directory, ".agtmai-local-solana-lease.json"), "utf8"));
  assert.equal(processAlive(lease.pid), false, "the lease creator must really have exited");
  return paths;
}

test("run reclamation treats a reused PID with a different process start as stale", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "kernel process-start identity requires Linux or Darwin" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-reused-pid-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json");
    const lease = JSON.parse(await readFile(marker, "utf8")); lease.processStart = process.platform === "linux" ? "linux:0" : "darwin:00";
    await writeFile(marker, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    assert.equal(await store.reclaimStale(), 1); await assert.rejects(lstat(paths.directory));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("run reclamation retains the exact live owner and records the native kernel identity", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "kernel process-start identity requires Linux or Darwin" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-live-owner-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const lease = JSON.parse(await readFile(join(paths.directory, ".agtmai-local-solana-lease.json"), "utf8"));
    assert.equal(lease.processStart, await processStartIdentity(process.pid));
    assert.match(lease.processStart, process.platform === "linux" ? /^linux:[0-9]+$/u : /^darwin:[a-f0-9]+$/u);
    assert.equal(await store.reclaimStale(), 0); assert.equal((await lstat(paths.directory)).isDirectory(), true);
    await store.cleanup(paths);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("run reclamation fails closed when process-start identity is missing", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-missing-identity-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json");
    const lease = JSON.parse(await readFile(marker, "utf8")); delete lease.processStart;
    await writeFile(marker, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    assert.equal(await store.reclaimStale(), 0); assert.equal((await lstat(paths.directory)).isDirectory(), true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("reused owner PID never authenticates a neighbouring process as its validator", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "validator identity requires Linux or Darwin" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-neighbour-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  const neighbour = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const neighbourPid = neighbour.pid; assert.ok(neighbourPid); const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json"); const lease = JSON.parse(await readFile(marker, "utf8"));
    lease.processStart = process.platform === "linux" ? "linux:0" : "darwin:00";
    lease.validator = { pid: neighbourPid, platform: process.platform, startTime: process.platform === "linux" ? "linux:0" : "darwin:00", executable: await realpath(process.execPath), ledger: paths.ledger, commandHash: "a".repeat(64), bindAddress: "127.0.0.1", rpcPort: 30_000, leaseTokenHash: createHash("sha256").update(lease.token).digest("hex") };
    await writeFile(marker, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    await assert.rejects(store.reclaimStale(), /SOLANA_RECLAIM_IDENTITY/u);
    assert.equal(processAlive(neighbourPid), true); assert.equal((await lstat(paths.directory)).isDirectory(), true);
  } finally { if (neighbour.exitCode === null) { neighbour.kill("SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

test("normal cleanup refuses to delete state beneath a registered live validator", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "validator leases support Linux and Darwin" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-active-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json"); const lease = JSON.parse(await readFile(marker, "utf8"));
    lease.validator = { pid: process.pid, platform: process.platform, startTime: process.platform === "linux" ? "linux:1" : "darwin:61", executable: "/bin/validator", ledger: paths.ledger, commandHash: "a".repeat(64), bindAddress: "127.0.0.1", rpcPort: 30_000, leaseTokenHash: createHash("sha256").update(lease.token).digest("hex") };
    await writeFile(marker, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    await assert.rejects(store.cleanup(paths), /SOLANA_VALIDATOR_ACTIVE/u); assert.equal((await lstat(paths.directory)).isDirectory(), true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("real parent SIGKILL reclaim authenticates, terminates and awaits its validator child", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "authenticated stale-child reclaim requires Linux procfs or native Darwin ps identity" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-sigkill-")); await chmod(boundary, 0o700);
  const runRoot = join(boundary, "runs"); const outputRoot = join(boundary, "out"); const readyPath = join(boundary, "ready.json");
  const parent = spawn(process.execPath, [join(import.meta.dirname, "helpers/start-owned-validator.ts"), runRoot, outputRoot, readyPath], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = ""; parent.stdout.on("data", (chunk) => { diagnostics += String(chunk); }); parent.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
  const neighbour = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    let ready: { readonly validatorPid: number; readonly runDirectory: string } | undefined;
    for (let attempt = 0; attempt < 600 && ready === undefined && parent.exitCode === null; attempt += 1) { try { ready = JSON.parse(await readFile(readyPath, "utf8")); } catch { await new Promise((resolve) => { setTimeout(resolve, 50); }); } }
    assert.ok(ready, `validator helper did not become ready: ${diagnostics}`); parent.kill("SIGKILL"); await new Promise<void>((resolve) => { parent.once("close", () => resolve()); });
    assert.equal(processAlive(ready.validatorPid), true);
    assert.equal(await new PrivateRunStore(runRoot, outputRoot).reclaimStale(), 1);
    assert.equal(processAlive(ready.validatorPid), false); assert.equal(processAlive(neighbour.pid!), true); await assert.rejects(lstat(ready.runDirectory));
  } finally { if (parent.exitCode === null) { parent.kill("SIGKILL"); } if (neighbour.exitCode === null) { neighbour.kill("SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

test("pre-registration SIGKILL cannot orphan an unregistered validator", { skip: process.platform !== "linux" ? "fault injector uses a Linux validator shim" : false }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-preregister-sigkill-")); await chmod(boundary, 0o700);
  const runRoot = join(boundary, "runs"); const outputRoot = join(boundary, "out"); const readyPath = join(boundary, "spawned-before-registration.json");
  const executable = await buildValidator(boundary);
  const fixture = spawn(process.execPath, [join(import.meta.dirname, "helpers/start-unregistered-validator.ts"), runRoot, outputRoot, readyPath, executable], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = ""; fixture.stdout.on("data", (chunk) => { diagnostics += String(chunk); }); fixture.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
  let validatorPid: number | undefined;
  try {
    let ready: { readonly validatorPid: number; readonly runDirectory: string } | undefined;
    for (let attempt = 0; attempt < 200 && ready === undefined && fixture.exitCode === null; attempt += 1) {
      try { ready = JSON.parse(await readFile(readyPath, "utf8")); } catch { await new Promise((resolve) => { setTimeout(resolve, 25); }); }
    }
    assert.ok(ready, `fixture did not enter the injected pre-registration window: ${diagnostics}`);
    validatorPid = ready.validatorPid;
    const lease = JSON.parse(await readFile(join(ready.runDirectory, ".agtmai-local-solana-lease.json"), "utf8"));
    assert.equal(lease.validator, null, "fault must occur before durable validator registration");
    fixture.kill("SIGKILL"); await new Promise<void>((resolve) => { fixture.once("close", () => { resolve(); }); });
    for (let attempt = 0; attempt < 200 && processAlive(validatorPid); attempt += 1) { await new Promise((resolve) => { setTimeout(resolve, 25); }); }
    assert.equal(processAlive(validatorPid), false, "supervisor must terminate the validator when the unacknowledged control channel closes");
    assert.equal(await new PrivateRunStore(runRoot, outputRoot).reclaimStale(), 1);
    await assert.rejects(lstat(ready.runDirectory));
  } finally {
    if (fixture.exitCode === null) { fixture.kill("SIGKILL"); }
    if (validatorPid !== undefined && processAlive(validatorPid)) { process.kill(validatorPid, "SIGKILL"); }
    await rm(boundary, { recursive: true, force: true });
  }
});

test("a copied lease in a substituted run directory never authorizes deletion", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-copied-lease-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const displaced = paths.directory + "-displaced"; const markerName = ".agtmai-local-solana-lease.json";
    const copiedLease = await readFile(join(paths.directory, markerName), "utf8"); await rename(paths.directory, displaced); await mkdir(paths.directory, { mode: 0o700 }); await writeFile(join(paths.directory, markerName), copiedLease, { mode: 0o600 });
    await assert.rejects(store.cleanup(paths), /SOLANA_CLEANUP_IDENTITY/u); assert.equal((await lstat(paths.directory)).isDirectory(), true); assert.equal((await lstat(displaced)).isDirectory(), true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("marker inode replacement is rejected even when lease bytes are identical", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-marker-inode-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json"); const bytes = await readFile(marker, "utf8"); await rename(marker, marker + ".original"); await writeFile(marker, bytes, { mode: 0o600 });
    await assert.rejects(store.cleanup(paths), /SOLANA_CLEANUP_IDENTITY/u); assert.equal((await lstat(paths.directory)).isDirectory(), true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

async function buildValidator(directory: string): Promise<string> { const source = join(directory, "validator.c"); const executable = join(directory, "validator"); await writeFile(source, "#include <unistd.h>\nint main(void){for(;;) pause();}\n"); await new Promise<void>((resolve, reject) => { execFile("/usr/bin/cc", [source, "-o", executable], (cause) => { if (cause) { reject(cause); } else { resolve(); } }); }); return executable; }

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      if (end >= 0 && stat.slice(end + 2).trim().split(/\s+/u)[0] === "Z") { return false; }
    }
    return true;
  } catch { return false; }
}
