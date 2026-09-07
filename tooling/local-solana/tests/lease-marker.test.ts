import assert from "node:assert/strict";
import fs, { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateRunStore } from "../src/adapters/filesystem.ts";
import { reserveStartupCustody, startupCustodySettled, updateStartupCustody } from "../src/adapters/startup-custody.ts";

const markerName = ".agtmai-local-solana-lease.json";
for (const size of [16_384, 16_385, 1024 * 1024 * 1024]) {
  test(`held marker logical size ${size} is bounded and sparse oversized markers are preserved`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-marker-")));
    const store = new PrivateRunStore(join(root, "runs"), join(root, "out"));
    try {
      const paths = await store.create(); const marker = join(paths.directory, markerName);
      if (size === 16_384) {
        const content = await readFile(marker, "utf8"); await writeFile(marker, content.padEnd(size));
        await store.cleanup(paths); await assert.rejects(lstat(paths.directory));
      } else {
        const handle = await open(marker, "r+"); try { await handle.truncate(size); } finally { await handle.close(); }
        assert.equal(await store.reclaimStale(), 0); assert.equal((await lstat(marker)).size, size);
        await assert.rejects(store.cleanup(paths), /SOLANA_LEASE_INVALID/u);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const fault of ["allocated", "growing", "final-allocation"] as const) {
  test(`held marker ${fault} rejection preserves state with capped acquisition`, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-marker-fault-")));
    const store = new PrivateRunStore(join(root, "runs"), join(root, "out")); const original = fs.open;
    let bytesRequested = 0; let calls = 0;
    try {
      const paths = await store.create(); const marker = join(paths.directory, markerName);
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await original(...args);
        if (args[0] === marker) {
          const stat = handle.stat.bind(handle); const read = handle.read.bind(handle); let observations = 0;
          t.mock.method(handle, "stat", async (...values: Parameters<typeof stat>) => {
            const entry = await stat(...values); observations += 1;
            if (fault === "allocated" || (fault === "final-allocation" && observations >= 3)) { return { ...entry, blocks: 33n }; }
            return entry;
          });
          t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
            calls += 1; bytesRequested += length;
            if (fault === "growing" && calls === 1) { await writeFile(marker, " ".repeat(32_768)); }
            return await read(buffer, offset, length, position);
          });
          t.mock.method(handle, "readFile", () => { throw new Error("unbounded read forbidden"); });
        }
        return handle;
      }); syncBuiltinESMExports();
      await assert.rejects(store.cleanup(paths), /SOLANA_LEASE_INVALID/u);
      assert.ok(bytesRequested <= 32_770, "allocation/read requests stay within fixed cap plus EOF probe");
      if (fault === "allocated") { assert.equal(calls, 0); }
      await lstat(paths.directory);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
  });
}

test("pending startup survives dead owner and normal cleanup; only settled custody permits retry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-custody-")));
  const store = new PrivateRunStore(join(root, "runs"), join(root, "out"));
  try {
    const paths = await store.create(); const custody = await reserveStartupCustody(paths.ledger, paths.leaseToken);
    await assert.rejects(store.cleanup(paths), /SOLANA_VALIDATOR_ACTIVE/u);
    await assert.rejects(reserveStartupCustody(paths.ledger, paths.leaseToken), /SOLANA_STARTUP_CUSTODY/u);
    const marker = join(paths.directory, markerName); const original = await readFile(marker, "utf8"); const lease = JSON.parse(original);
    lease.pid = 2_147_483_647; await writeFile(marker, JSON.stringify(lease));
    assert.equal(await store.reclaimStale(), 0); await lstat(paths.directory);
    await writeFile(marker, original);
    await updateStartupCustody(custody, false); await updateStartupCustody(custody, true);
    const retry = await reserveStartupCustody(paths.ledger, paths.leaseToken);
    assert.equal(await startupCustodySettled(paths.directory, paths.leaseToken), false);
    await updateStartupCustody(retry, false); await updateStartupCustody(retry, true);
    await store.cleanup(paths);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy v3 lease remains unchanged without invented provenance", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-legacy-")));
  const store = new PrivateRunStore(join(root, "runs"), join(root, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, markerName); const lease = JSON.parse(await readFile(marker, "utf8"));
    lease.schemaVersion = 3; lease.pid = 2_147_483_647; delete lease.markerIdentity;
    const bytes = JSON.stringify(lease); await writeFile(marker, bytes);
    assert.equal(await store.reclaimStale(), 0); assert.equal(await readFile(marker, "utf8"), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing startup authority preserves an unregistered run", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-missing-custody-")));
  const store = new PrivateRunStore(join(root, "runs"), join(root, "out"));
  try {
    const paths = await store.create(); await reserveStartupCustody(paths.ledger, paths.leaseToken);
    await rm(join(paths.directory, ".agtmai-validator-startup.json"));
    await assert.rejects(store.cleanup(paths), /SOLANA_VALIDATOR_ACTIVE/u);
    const marker = join(paths.directory, markerName); const lease = JSON.parse(await readFile(marker, "utf8"));
    lease.pid = 2_147_483_647; await writeFile(marker, JSON.stringify(lease));
    assert.equal(await store.reclaimStale(), 0); await lstat(paths.directory);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("completed competing claim during final custody open remains a benign lost claim", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-custody-claim-")));
  const store = new PrivateRunStore(join(root, "runs"), join(root, "out")); const original = fs.open;
  try {
    const paths = await store.create(); const marker = join(paths.directory, markerName); const lease = JSON.parse(await readFile(marker, "utf8"));
    lease.pid = 2_147_483_647; await writeFile(marker, JSON.stringify(lease));
    let reads = 0; let competitor = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === join(paths.directory, ".agtmai-validator-startup.json") && !competitor) {
        reads += 1;
        if (reads === 2) { competitor = true; assert.equal(await store.reclaimStale(), 1); }
      }
      return await original(...args);
    }); syncBuiltinESMExports();
    assert.equal(await store.reclaimStale(), 0); assert.equal(competitor, true);
    await assert.rejects(lstat(paths.directory), { code: "ENOENT" });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});
