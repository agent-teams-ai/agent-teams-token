import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import fs, { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateRunStore } from "../src/adapters/filesystem.ts";
import { captureValidatorIdentity } from "../src/adapters/process-identity.ts";

const markerName = ".agtmai-local-solana-lease.json";
async function boundary(): Promise<string> { return await realpath(await mkdtemp(join(tmpdir(), "agtmai-recovery-remediation-"))); }
async function stale(directory: string): Promise<void> {
  const marker = join(directory, markerName); const lease = JSON.parse(await readFile(marker, "utf8"));
  lease.pid = 2_147_483_647; await writeFile(marker, JSON.stringify(lease));
}

test("oversized lease is rejected before any payload read", async () => {
  const root = await boundary(); const store = new PrivateRunStore(join(root, "runs"), join(root, "out"));
  const original = fs.open; let reads = 0;
  try {
    const paths = await store.create(); const marker = join(paths.directory, markerName);
    await writeFile(marker, " ".repeat(16_385));
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[0] === marker) {
        const read = handle.read.bind(handle); const readFile = handle.readFile.bind(handle);
        handle.read = ((...values: Parameters<typeof read>) => { reads += 1; return read(...values); }) as typeof handle.read;
        handle.readFile = ((...values: Parameters<typeof readFile>) => { reads += 1; return readFile(...values); }) as typeof handle.readFile;
      }
      return handle;
    }) as typeof fs.open; syncBuiltinESMExports();
    assert.equal(await store.reclaimStale(), 0);
    assert.equal(reads, 0, "oversized held marker must fail before allocation/read");
    await lstat(marker);
  } finally { fs.open = original; syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

for (const observation of ["exact", "replacement", "ambiguous"] as const) {
test(`zombie reclamation requires proven exit: ${observation}`, { skip: process.platform !== "linux" }, async (t) => {
  const root = await boundary(); const store = new PrivateRunStore(join(root, "runs"), join(root, "out"));
  const paths = await store.create();
  // The helper blocks its event loop to deliberately withhold waitpid/reaping.
  const holder = fork(join(import.meta.dirname, "helpers/zombie-validator.ts"), [paths.ledger, paths.leaseToken], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let pid: number | undefined;
  try {
    const [message] = await once(holder, "message") as [{ pid: number }]; pid = message.pid;
    const identity = await captureValidatorIdentity(pid, process.execPath, paths.ledger, paths.leaseToken);
    await store.registerValidator(paths, observation === "replacement" ? { ...identity, startTime: "linux:0" } : identity); await stale(paths.directory);
    holder.send("exit-child");
    for (let i = 0; i < 200; i += 1) {
      const value = await readFile(`/proc/${pid}/stat`, "utf8");
      if (value.slice(value.lastIndexOf(")") + 2).startsWith("Z ")) { break; }
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    const value = await readFile(`/proc/${pid}/stat`, "utf8"); assert.ok(value.slice(value.lastIndexOf(")") + 2).startsWith("Z "));
    process.kill(pid, 0);
    const kill = process.kill.bind(process); let signals = 0;
    t.mock.method(process, "kill", (target: number, signal: NodeJS.Signals | number = "SIGTERM") => {
      if (target === pid && signal !== 0) { signals += 1; throw new Error("zombie/replacement must never be signalled"); }
      return kill(target, signal);
    });
    if (observation === "ambiguous") {
      const originalRead = fs.readFile;
      t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
        if (args[0] === `/proc/${pid}/stat`) { throw Object.assign(new Error("observation unavailable"), { code: "EIO" }); }
        return await originalRead(...args);
      }); syncBuiltinESMExports();
    }
    if (observation === "exact") { assert.equal(await store.reclaimStale(), 1); await assert.rejects(lstat(paths.directory)); }
    else { await assert.rejects(store.reclaimStale(), /SOLANA_RECLAIM_IDENTITY/u); await lstat(paths.directory); }
    assert.equal(signals, 0);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    holder.kill("SIGKILL"); await once(holder, "close");
    if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
}

test("reclamation preserves captured child custody before supervisor disconnect handling", { skip: process.platform !== "linux", timeout: 20_000 }, async () => {
  const root = await boundary(); const runRoot = join(root, "runs"); const outputRoot = join(root, "out");
  const owner = fork(join(import.meta.dirname, "helpers/captured-validator.ts"), [runRoot, outputRoot], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const neighbour = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const store = new PrivateRunStore(runRoot, outputRoot); let child: number | undefined; let supervisor: number | undefined;
  try {
    const [ready] = await once(owner, "message") as [{ pid: number; supervisor: number; directory: string }]; child = ready.pid; supervisor = ready.supervisor;
    const neighbourRun = await store.create();
    process.kill(supervisor, "SIGSTOP"); owner.kill("SIGKILL"); await once(owner, "close");
    assert.equal(await store.reclaimStale(), 0, "live unsettled custodian must prevent deletion even with validator:null");
    await lstat(join(ready.directory, "ledger")); process.kill(child, 0);
    process.kill(supervisor, "SIGCONT");
    let reclaimed = 0;
    for (let i = 0; i < 300 && reclaimed === 0; i += 1) {
      reclaimed += await store.reclaimStale();
      if (reclaimed === 0) { await new Promise((resolve) => { setTimeout(resolve, 20); }); }
    }
    assert.equal(reclaimed, 1);
    for (const pid of [child, supervisor]) {
      let exited = false;
      for (let attempt = 0; attempt < 200 && !exited; attempt += 1) {
        const value = await readFile(`/proc/${pid}/stat`, "utf8").catch((cause) => {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") { return null; } throw cause;
        });
        exited = value === null || value.slice(value.lastIndexOf(")") + 2).startsWith("Z ");
        if (!exited) { await new Promise((resolve) => { setTimeout(resolve, 10); }); }
      }
      assert.equal(exited, true, "custodian and captured validator must terminate before test cleanup");
    }
    await lstat(neighbourRun.directory); process.kill(neighbour.pid!, 0);
    await store.cleanup(neighbourRun);
  } finally {
    if (supervisor !== undefined) { try { process.kill(supervisor, "SIGCONT"); } catch {} }
    if (child !== undefined) { try { process.kill(child, "SIGKILL"); } catch {} }
    if (supervisor !== undefined) { try { process.kill(supervisor, "SIGKILL"); } catch {} }
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill("SIGKILL"); }
    neighbour.kill("SIGKILL"); await once(neighbour, "close"); await rm(root, { recursive: true, force: true });
  }
});
