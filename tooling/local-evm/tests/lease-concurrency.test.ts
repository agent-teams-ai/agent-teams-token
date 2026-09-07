import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProvisionalRunDirectory, createRunLease, reclaimStaleRuns, registerRunAnvil } from "../run-lease.ts";
import { processStartIdentity } from "../process.ts";

// Intercept only the scheduling boundary; every open/stat/rename is real.
for (const boundary of ["before-fstat", "after-fstat", "during-finalization"] as const) {
  test(`reclaimer survives registration ${boundary}`, {timeout: 10_000}, async (context) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-lease-barrier-")));
    const directory = await createProvisionalRunDirectory(root, "overlap");
    const path = join(directory, "lease.v1.json");
    const identity = {pid: process.pid, processStart: await processStartIdentity(process.pid)};
    await createRunLease(directory);
    await fs.writeFile(join(directory, "foreign-sentinel"), "preserve");
    const originalOpen = fs.open;
    let intercepted = false;
    const finalizing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let registration: Promise<void> | undefined;
    try {
      context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (args[0] === path && !intercepted) {
          intercepted = true;
          const before = await handle.stat({bigint: true});
          assert.equal(before.nlink, 1n);
          registration = registerRunAnvil(directory, identity, boundary === "during-finalization" ? {
            afterPublish: async () => {finalizing.resolve(); await release.promise;},
          } : {});
          if (boundary === "during-finalization") {await finalizing.promise;}
          else {await registration;}
          const after = await handle.stat({bigint: true});
          assert.equal(after.nlink, 0n);
          assert.equal(after.ino, before.ino);
          assert.notEqual((await fs.lstat(path, {bigint: true})).ino, before.ino);
          if (boundary === "after-fstat") {
            const originalStat = handle.stat.bind(handle);
            let firstStat = true;
            context.mock.method(handle, "stat", (...statArgs: Parameters<typeof handle.stat>) => {
              if (firstStat) {firstStat = false; return Promise.resolve(before);}
              return originalStat(...statArgs);
            });
          }
          context.diagnostic("real predecessor opened at nlink=1; public registerRunAnvil replaced it; held inode nlink=0 before scanner fstat");
        }
        return handle;
      });
      syncBuiltinESMExports();
      assert.equal(await reclaimStaleRuns(root), 0);
      assert.equal(intercepted, true);
      assert.deepEqual(JSON.parse(await fs.readFile(path, "utf8")).anvil, identity);
      assert.equal(await fs.readFile(join(directory, "foreign-sentinel"), "utf8"), "preserve");
    } finally {
      release.resolve();
      await registration;
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, {recursive: true, force: true});
    }
  });

}

for (const mutation of ["hardlink", "symlink", "mode", "oversize", "schema", "owner-identity", "directory"] as const) {
  test(`replacement retry rejects ${mutation} and preserves foreign files`, {timeout: 10_000}, async (context) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-lease-reject-")));
    const directory = await createProvisionalRunDirectory(root, "reject");
    const path = join(directory, "lease.v1.json");
    const identity = {pid: process.pid, processStart: await processStartIdentity(process.pid)};
    await createRunLease(directory);
    const sentinel = join(root, "foreign-sentinel");
    await fs.writeFile(sentinel, "preserve", {mode: 0o600});
    const originalOpen = fs.open;
    let intercepted = false;
    try {
      context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (args[0] === path && !intercepted) {
          intercepted = true;
          await registerRunAnvil(directory, identity);
          if (mutation === "hardlink") {await fs.link(path, join(root, "foreign-link"));}
          if (mutation === "symlink") {
            await fs.unlink(path);
            await fs.symlink(sentinel, path);
          }
          if (mutation === "mode") {await fs.chmod(path, 0o644);}
          if (mutation === "oversize") {await fs.writeFile(path, Buffer.alloc(17 * 1024));}
          if (mutation === "schema") {await fs.writeFile(path, "{}");}
          if (mutation === "owner-identity") {
            const lease = JSON.parse(await fs.readFile(path, "utf8"));
            lease.runner.processStart = process.platform === "linux" ? "linux:0" : "darwin:00";
            await fs.writeFile(path, JSON.stringify(lease));
          }
          if (mutation === "directory") {
            await fs.rename(directory, join(root, "displaced"));
            await fs.mkdir(directory, {mode: 0o700});
            await fs.writeFile(path, "foreign-directory-sentinel");
          }
        }
        return handle;
      });
      syncBuiltinESMExports();
      await assert.rejects(reclaimStaleRuns(root));
      assert.equal(intercepted, true);
      assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
      assert.equal((await fs.lstat(directory)).isDirectory(), true);
      if (mutation === "hardlink") {assert.equal((await fs.lstat(path)).nlink, 2);}
      if (mutation === "symlink") {assert.equal((await fs.lstat(path)).isSymbolicLink(), true);}
      if (mutation === "directory") {assert.equal(await fs.readFile(path, "utf8"), "foreign-directory-sentinel");}
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, {recursive: true, force: true});
    }
  });
}
