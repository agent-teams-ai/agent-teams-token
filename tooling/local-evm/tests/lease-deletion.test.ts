import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createInitializingRunDirectory, publishInitializedRun } from "../run-initialization.ts";
import { simulateDarwinClaimIdentity } from "./fixtures/darwin-claim-identity.ts";
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

// Production runner: eight base36 timestamp characters + '-' + 24 hex digits.
const productionRunId = `mew12345-${"a".repeat(24)}`;
for (const phase of ["owner", "initializer", "unfinished-hardlink", "provisional", "reclaim", "abandoned-reclaim", "abandoned-delete"] as const) {
  test(`Darwin NAME_MAX255 production run: ${phase}`, async (context) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-claim-length-")));
    const darwin = simulateDarwinClaimIdentity(context);
    const rename = fs.rename;
    const remove = fs.rm;
    const claims: string[] = [];
    const interrupted = new Error("claimant interrupted");
    let interrupt = phase.startsWith("abandoned-");
    try {
      const initial = await createInitializingRunDirectory(root, productionRunId);
      let directory = initial.directory;
      if (!["initializer", "unfinished-hardlink"].includes(phase)) {
        directory = await publishInitializedRun(initial, async () => await createRunLease(initial.directory));
      }
      if (phase === "provisional") {await fs.unlink(join(directory, "lease.v1.json"));}
      if (phase === "unfinished-hardlink") {
        await fs.writeFile(join(directory, "unfinished.tmp"), "unfinished", {mode: 0o600});
        await fs.link(join(directory, "unfinished.tmp"), join(directory, "lease.v1.json"));
      }
      await darwin.bindDirectory(directory);
      context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        const name = basename(String(args[1]));
        if (/^\.(?:reclaim|delete)-v1-/u.test(name)) {
          claims.push(name);
          // Delegate first: exact old source must fail at a real filesystem syscall.
          await rename(...args);
          assert(Buffer.byteLength(name) <= 255);
          assert(name.includes(`-${darwin.directoryIdentity.replaceAll(":", "-")}-12345-${darwin.start().replace(":", "x")}-`));
          if (interrupt && phase === "abandoned-reclaim") {interrupt = false; throw interrupted;}
          return;
        }
        await rename(...args);
      });
      context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
        if (interrupt && phase === "abandoned-delete" && basename(String(args[0])).startsWith(".delete-v1-")) {
          interrupt = false;
          await fs.unlink(join(String(args[0]), "lease.v1.json"));
          throw interrupted;
        }
        await remove(...args);
      });
      syncBuiltinESMExports();
      if (phase === "owner") {await removeOwnedRunDirectory(directory);}
      else if (phase.startsWith("abandoned-")) {
        await assert.rejects(removeOwnedRunDirectory(directory), (cause) => cause === interrupted);
        assert.equal(await reclaimStaleRuns(root), 0, "live claimant retains custody");
        darwin.reusePid();
        assert.equal(await reclaimStaleRuns(root), 1);
      } else {
        darwin.reusePid();
        assert.equal(await reclaimStaleRuns(root), 1);
      }
      assert(claims.length >= 2);
      context.diagnostic(`real rename; simulated Darwin identities; claim bytes: ${claims.map((name) => Buffer.byteLength(name)).join(", ")}`);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      darwin.restore();
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await remove(root, {recursive: true, force: true});
    }
  });
}

for (const mutation of ["substitution", "symlink", "mode", "lease-hardlink"] as const) {
  test(`bounded Darwin claim preserves unsafe ${mutation}`, async (context) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-claim-unsafe-")));
    const darwin = simulateDarwinClaimIdentity(context);
    const rename = fs.rename;
    const remove = fs.rm;
    const interrupted = new Error("claimant interrupted");
    let claim = "";
    try {
      const initial = await createInitializingRunDirectory(root, productionRunId);
      const directory = await publishInitializedRun(initial, async () => await createRunLease(initial.directory));
      await darwin.bindDirectory(directory);
      context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await rename(...args);
        claim = String(args[1]);
        throw interrupted;
      });
      syncBuiltinESMExports();
      await assert.rejects(removeOwnedRunDirectory(directory), (cause) => cause === interrupted);
      assert(Buffer.byteLength(basename(claim)) <= 255);
      const preserved = join(root, "preserved");
      if (mutation === "substitution" || mutation === "symlink") {
        await rename(claim, preserved);
        if (mutation === "substitution") {await fs.mkdir(claim, {mode: 0o700});}
        else {await fs.symlink(preserved, claim);}
      }
      if (mutation === "mode") {await fs.chmod(claim, 0o755);}
      if (mutation === "lease-hardlink") {await fs.link(join(claim, "lease.v1.json"), join(root, "lease-copy"));}
      await fs.writeFile(join(claim, "sentinel"), "preserve");
      darwin.reusePid();
      await assert.rejects(reclaimStaleRuns(root), (cause: unknown) => {
        assert.notEqual(cause, interrupted, "must reject before another rename");
        return true;
      });
      assert.equal(await fs.readFile(join(claim, "sentinel"), "utf8"), "preserve");
    } finally {
      darwin.restore();
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await remove(root, {recursive: true, force: true});
    }
  });
}
