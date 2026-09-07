import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProvisionalRunDirectory, createRunLease, reclaimStaleRuns, removeOwnedRunDirectory } from "../run-lease.ts";

for (const owner of ["runner", "stale-reclaimer"] as const) {
  test(`scanner overlaps ${owner} deleting a still-present claim`, {timeout: 10_000}, async (context) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-delete-overlap-")));
    const directory = await createProvisionalRunDirectory(root, "delete");
    const path = join(directory, "lease.v1.json");
    await createRunLease(directory);
    if (owner === "stale-reclaimer") {
      const lease = JSON.parse(await fs.readFile(path, "utf8"));
      lease.runner = {pid: 2147483647, processStart: "linux:1"};
      await fs.writeFile(path, JSON.stringify(lease));
    }
    const foreign = join(root, "foreign");
    await fs.mkdir(foreign, {mode: 0o700});
    await fs.writeFile(join(foreign, "sentinel"), "preserve");
    const originalRm = fs.rm;
    const originalOpen = fs.open;
    let deleting = false;
    let heldScanner = false;
    let claimLeaseRemoved = false;
    let deletionFailure: unknown;
    try {
      context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        try {
          if (args[0] === path && !heldScanner) {
            heldScanner = true;
            assert.equal((await handle.stat({bigint: true})).nlink, 1n);
            if (owner === "runner") {await removeOwnedRunDirectory(directory);}
            else {assert.equal(await reclaimStaleRuns(root), 1);}
            assert.equal((await handle.stat({bigint: true})).nlink, 0n);
          }
          if (deleting && /\.(?:reclaim|delete)-v/u.test(String(args[0])) && String(args[0]).endsWith("lease.v1.json") && !claimLeaseRemoved) {
            claimLeaseRemoved = true;
            assert.equal((await handle.stat({bigint: true})).nlink, 1n);
            await fs.unlink(args[0]);
            assert.equal((await handle.stat({bigint: true})).nlink, 0n);
          }
          return handle;
        } catch (cause) {await handle.close(); throw cause;}
      });
      context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
        if (/\.(?:reclaim|delete)-v/u.test(String(args[0])) && !deleting) {
          deleting = true;
          const claim = String(args[0]);
          assert.equal((await fs.lstat(claim)).isDirectory(), true);
          context.diagnostic("real scanner descriptor retained while deletion unlinked lease and left claim present");
          try {assert.equal(await reclaimStaleRuns(root), 0);}
          catch (cause) {deletionFailure = cause; throw cause;}
          if (!claimLeaseRemoved) {await fs.unlink(join(claim, "lease.v1.json"));}
          assert.equal((await fs.lstat(claim)).isDirectory(), true);
          assert.equal(await reclaimStaleRuns(root), 0);
        }
        await originalRm(...args);
      });
      syncBuiltinESMExports();
      assert.equal(await reclaimStaleRuns(root), 0);
      assert.equal(deletionFailure, undefined, "deletion overlap must not produce or swallow an unsafe lease error");
      assert.equal(heldScanner, true);
      assert.equal(deleting, true);
      assert.equal(await fs.readFile(join(foreign, "sentinel"), "utf8"), "preserve");
      assert.deepEqual(await fs.readdir(root), ["foreign"]);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await originalRm(root, {recursive: true, force: true});
    }
  });
}

for (const mutation of ["none", "substituted", "mode"] as const) {
  test(`abandoned authenticated deletion claim ${mutation}`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-delete-abandoned-")));
    const directory = join(root, "original");
    await fs.mkdir(directory, {mode: 0o700});
    const identity = await fs.lstat(directory, {bigint: true});
    const claim = join(root, `.delete-v1-${identity.dev}-${identity.ino}-${identity.birthtimeNs}-2147483647-linuxx1-${"a".repeat(24)}-run-stale`);
    await fs.rename(directory, claim);
    try {
      if (mutation === "substituted") {
        await fs.rename(claim, directory);
        await fs.mkdir(claim, {mode: 0o700});
      }
      if (mutation === "mode") {await fs.chmod(claim, 0o755);}
      await fs.writeFile(join(claim, "sentinel"), "preserve");
      if (mutation === "none") {
        assert.equal(await reclaimStaleRuns(root), 1);
        assert.deepEqual(await fs.readdir(root), []);
      } else {
        await assert.rejects(reclaimStaleRuns(root));
        assert.equal(await fs.readFile(join(claim, "sentinel"), "utf8"), "preserve");
      }
    } finally {await fs.rm(root, {recursive: true, force: true});}
  });
}
