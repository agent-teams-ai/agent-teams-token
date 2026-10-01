import assert from "node:assert/strict";
import { existsSync, renameSync, statSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { publishDeploymentFiles, readDeploymentFile, verifyDeploymentFiles } from "../src/features/genesis-manifest/adapters/deployment-store.js";
import { deploymentBytes } from "../src/features/genesis-manifest/application/compile-deployment.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";

async function temporary(): Promise<string> {
  const parent = resolve("../../../.local/deployment-store-tests");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "case-"));
}

test("exclusive durable publication and hash inventory detect altered, missing, extra and linked evidence", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "bundle"), bytes = new TextEncoder().encode('{"broadcastAllowed":false}');
  const files = { "result.json": bytes };
  const inventory = await publishDeploymentFiles(output, files);
  assert.deepEqual(await verifyDeploymentFiles(output), inventory);
  await assert.rejects(verifyDeploymentFiles(output, true), /READY_MISSING/);
  await assert.rejects(readFile(join(output, "READY")), { code: "ENOENT" });
  assert.equal(inventory.files.some(f => f.name === "inventory.json"), false);
  await assert.rejects(publishDeploymentFiles(output, files));
  assert.deepEqual(await publishDeploymentFiles(output, files, true), inventory);
  await writeFile(join(output, "result.json"), "tamper");
  await assert.rejects(verifyDeploymentFiles(output), /MISMATCH/);
  await assert.rejects(publishDeploymentFiles(output, files, true), /RESUME_MISMATCH/);
  await rm(join(output, "result.json"));
  await assert.rejects(verifyDeploymentFiles(output), /INVENTORY_FILES/);
  await writeFile(join(root, "external.json"), bytes);
  await symlink(join(root, "external.json"), join(output, "result.json"));
  await assert.rejects(verifyDeploymentFiles(output));
  await assert.rejects(readDeploymentFile(join(output, "result.json")));
});

test("final READY binds the complete inventory, reopens and resumes without changing ordinary publication", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "ready"), files = { "result.json": deploymentBytes({ broadcastAllowed: false }) };
  const inventory = await publishDeploymentFiles(output, files, false, true);
  assert.equal(await readFile(join(output, "READY"), "utf8"), `${sha256(await readFile(join(output, "inventory.json")))}\n`);
  assert.deepEqual((await readdir(output)).toSorted(), ["READY", "inventory.json", "result.json"].toSorted());
  assert.deepEqual(await verifyDeploymentFiles(output, true), inventory);
  assert.deepEqual(await publishDeploymentFiles(output, files, true, true), inventory);
});

test("READY finalization excludes a real compatible resumer and public verification rejects the live publication", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "ready"), files = { "result.json": deploymentBytes({ broadcastAllowed: false }) };
  const inventory = await publishDeploymentFiles(join(root, "ordinary"), files);
  const probe = await open(join(root, "probe"), "wx"), prototype = Object.getPrototypeOf(probe);
  const descriptorStat = probe.stat, sync = probe.sync; await probe.close();
  const parked = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  let attempted = false, scheduling = false, directory: Stats | undefined;
  let contender: Promise<unknown> | undefined;
  // Start another actual publisher at the inventory read, parking it only if
  // it acquires the lock. No filesystem result or publication is fabricated.
  const statMock = context.mock.method(prototype, "stat", async function (this: FileHandle) {
    const info = await descriptorStat.call(this);
    const inventoryFile = !attempted && info.isFile() ? await stat(join(output, "inventory.json")).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
      return null;
    }) : undefined;
    if (inventoryFile && info.dev === inventoryFile.dev && info.ino === inventoryFile.ino) {
      directory = await stat(output);
      attempted = true; scheduling = true;
      contender = publishDeploymentFiles(output, files, true, true).then(() => null, error => error);
      await Promise.race([parked.promise, contender]);
      scheduling = false;
      await assert.rejects(verifyDeploymentFiles(output), /INVENTORY_FILES/);
    }
    return info;
  });
  const syncMock = context.mock.method(prototype, "sync", async function (this: FileHandle) {
    const info = await descriptorStat.call(this);
    if (scheduling && info.dev === directory?.dev && info.ino === directory.ino) {
      parked.resolve(); await released.promise;
    }
    return sync.call(this);
  });
  try {
    assert.deepEqual(await publishDeploymentFiles(output, files, false, true), inventory);
    assert.equal(attempted, true);
    released.resolve();
    assert.equal((await contender as NodeJS.ErrnoException | null)?.code, "EEXIST");
  } finally {
    released.resolve(); await contender;
    statMock.mock.restore(); syncMock.mock.restore();
  }
  assert.deepEqual(await verifyDeploymentFiles(output, true), inventory);
  assert.equal((await readdir(output)).includes(".publication-lock"), false);
});

test("substituted publication lock is preserved and cannot acknowledge READY", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "bundle"), lockPath = join(output, ".publication-lock"), held = join(root, "held-lock");
  const probe = await open(join(root, "probe"), "wx"), prototype = Object.getPrototypeOf(probe);
  const sync = probe.sync, descriptorStat = probe.stat; await probe.close();
  let attacked = false;
  const syncMock = context.mock.method(prototype, "sync", async function (this: FileHandle) {
    const info = await descriptorStat.call(this);
    const inventory = !attacked && info.isFile() ? await stat(join(output, "inventory.json")).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; }
      return null;
    }) : undefined;
    if (inventory && info.dev === inventory.dev && info.ino === inventory.ino) {
      attacked = true;
      renameSync(lockPath, held);
      await writeFile(lockPath, "foreign lock", { flag: "wx", mode: 0o600 });
    }
    return sync.call(this);
  });
  try {
    await assert.rejects(publishDeploymentFiles(output, { "result.json": deploymentBytes({ broadcastAllowed: false }) }, false, true), /PUBLICATION_LOCK_IDENTITY/);
    assert.equal(attacked, true);
  } finally { syncMock.mock.restore(); }
  assert.equal(await readFile(lockPath, "utf8"), "foreign lock");
  assert.equal(await readFile(held, "utf8"), "");
  await assert.rejects(readFile(join(output, "READY")), { code: "ENOENT" });
  await assert.rejects(verifyDeploymentFiles(output), /INVENTORY_FILES/);
});

test("late release substitution preserves the captured foreign inode and rejects both acknowledgements", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "bundle"), lockPath = join(output, ".publication-lock"), held = join(root, "held-lock");
  const probe = await open(join(root, "probe"), "wx"), prototype = Object.getPrototypeOf(probe);
  const descriptorStat = probe.stat; await probe.close();
  const statsPrototype = Object.getPrototypeOf(statSync(root)), isFile = statsPrototype.isFile;
  let owned: Stats | undefined, foreign: Stats | undefined, closed = false, attacked = false;
  const statMock = context.mock.method(prototype, "stat", async function (this: FileHandle) {
    const info = await descriptorStat.call(this);
    if (!owned && isFile.call(info) && existsSync(lockPath)) {
      const named = statSync(lockPath);
      if (named.dev === info.dev && named.ino === info.ino) {
        owned = named;
        const close = this.close;
        context.mock.method(this, "close", async () => { await close.call(this); closed = true; });
      }
    }
    return info;
  });
  // The natural boundary is descriptor close, followed by the final named stat.
  // Return the real owned snapshot after a real rename/create at that boundary.
  const predicateMock = context.mock.method(statsPrototype, "isFile", function (this: Stats) {
    const result = isFile.call(this);
    if (closed && !attacked && this.dev === owned?.dev && this.ino === owned.ino) {
      attacked = true;
      renameSync(lockPath, held);
      writeFileSync(lockPath, "foreign-live-lock", { flag: "wx", mode: 0o600 });
      foreign = statSync(lockPath);
    }
    return result;
  });
  let failure: unknown;
  try { failure = await publishDeploymentFiles(output, { "result.json": deploymentBytes({ broadcastAllowed: false }) }, false, true).then(() => null, error => error); }
  finally { statMock.mock.restore(); predicateMock.mock.restore(); }
  const stages = (await readdir(output)).filter(name => name.startsWith(".publication-release-"));
  const preserved = [lockPath, ...stages.map(name => join(output, name, ".publication-lock"))].filter(existsSync);
  const verification = await verifyDeploymentFiles(output, true).then(() => null, error => error);
  context.diagnostic(JSON.stringify({ attacked, publisherReturnedSuccess: failure === null, publicReadyVerificationPassed: verification === null, foreignPaths: preserved }));
  assert.equal(attacked, true);
  assert.equal(preserved.length, 1, "foreign lock must survive release");
  const captured = statSync(preserved[0]!);
  assert.equal(captured.dev, foreign?.dev); assert.equal(captured.ino, foreign?.ino);
  assert.equal(await readFile(preserved[0]!, "utf8"), "foreign-live-lock");
  assert.equal(statSync(held).ino, owned?.ino);
  assert.match(String(failure), /PUBLICATION_LOCK_IDENTITY/);
  assert.match(String(verification), /INVENTORY_FILES/);
});

test("private release fsync and descriptor-close failures retain exclusion diagnostics", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const probe = await open(join(root, "probe"), "wx"), prototype = Object.getPrototypeOf(probe);
  const descriptorStat = probe.stat; await probe.close();
  for (const fault of ["sync", "close"] as const) {
    const output = join(root, fault);
    let injected = false;
    const statMock = context.mock.method(prototype, "stat", async function (this: FileHandle) {
      const info = await descriptorStat.call(this);
      if (!injected && info.isDirectory()) {
        const stages = (await readdir(output)).filter(name => name.startsWith(".publication-release-"));
        for (const name of stages) {
          const named = await stat(join(output, name));
          if (named.dev !== info.dev || named.ino !== info.ino) { continue; }
          injected = true;
          const close = this.close;
          context.mock.method(this, fault, async () => {
            if (fault === "close") { await close.call(this); }
            await assert.rejects(verifyDeploymentFiles(output, true), /INVENTORY_FILES/);
            throw new Error(`TEST_RELEASE_${fault}`);
          });
        }
      }
      return info;
    });
    try {
      await assert.rejects(publishDeploymentFiles(output, { "result.json": deploymentBytes({ broadcastAllowed: false }) }, false, true), new RegExp(`TEST_RELEASE_${fault}`));
    } finally { statMock.mock.restore(); }
    assert.equal(injected, true);
    const stages = (await readdir(output)).filter(name => name.startsWith(".publication-release-"));
    assert.equal(stages.length, 1);
    assert.equal((await stat(join(output, stages[0]!))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(join(output, stages[0]!)), fault === "sync" ? [".publication-lock"] : []);
    await assert.rejects(verifyDeploymentFiles(output, true), /INVENTORY_FILES/);
  }
});

test("a compatible contender during private release cannot publish and leaves normal resume available", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "bundle"), files = { "result.json": deploymentBytes({ broadcastAllowed: false }) };
  const probe = await open(join(root, "probe"), "wx"), prototype = Object.getPrototypeOf(probe);
  const descriptorStat = probe.stat, sync = probe.sync; await probe.close();
  let attempted = false;
  const syncMock = context.mock.method(prototype, "sync", async function (this: FileHandle) {
    const info = await descriptorStat.call(this);
    if (!attempted && info.isDirectory()) {
      const entries = await readdir(output), stages = entries.filter(name => name.startsWith(".publication-release-"));
      for (const name of stages) {
        const named = await stat(join(output, name));
        if (named.dev !== info.dev || named.ino !== info.ino) { continue; }
        attempted = true;
        assert.equal(entries.includes(".publication-lock"), false);
        await assert.rejects(verifyDeploymentFiles(output, true), /INVENTORY_FILES/);
        await assert.rejects(publishDeploymentFiles(output, files, true, true), /UNEXPECTED_FILE/);
        assert.deepEqual((await readdir(output)).toSorted(), entries.toSorted());
      }
    }
    return sync.call(this);
  });
  let inventory;
  try { inventory = await publishDeploymentFiles(output, files, false, true); }
  finally { syncMock.mock.restore(); }
  assert.equal(attempted, true);
  assert.deepEqual((await readdir(output)).toSorted(), ["READY", "inventory.json", "result.json"].toSorted());
  assert.deepEqual(await verifyDeploymentFiles(output, true), inventory);
  assert.deepEqual(await publishDeploymentFiles(output, files, true, true), inventory);
});

test("present READY rejects malformed, inventory-drifted, symlink and hardlinked markers even when optional", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  for (const fault of ["malformed", "drift", "symlink", "hardlink"] as const) {
    const output = join(root, fault), files = { "result.json": new TextEncoder().encode("before") };
    await publishDeploymentFiles(output, files, false, true);
    const marker = join(output, "READY");
    if (fault === "malformed") { await writeFile(marker, "invalid\n"); }
    else if (fault === "drift") {
      const replacement = new TextEncoder().encode("after"); await writeFile(join(output, "result.json"), replacement);
      await writeFile(join(output, "inventory.json"), deploymentBytes({ schema: "agtmai-delivery-inventory-v1", files: [{ name: "result.json", sha256: sha256(replacement), bytes: replacement.length }] }));
    } else {
      const external = join(root, `${fault}-marker`); await writeFile(external, await readFile(marker)); await rm(marker);
      if (fault === "symlink") { await symlink(external, marker); } else { await link(external, marker); }
    }
    for (const required of [false, true]) { await assert.rejects(verifyDeploymentFiles(output, required)); }
    await assert.rejects(publishDeploymentFiles(output, files, true, true));
  }
});

test("failed partial delivery cannot publish READY", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "partial"); await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, "second.json"), "unexpected");
  await assert.rejects(publishDeploymentFiles(output, { "first.json": new Uint8Array(), "second.json": new Uint8Array() }, true, true), /RESUME_MISMATCH/);
  await assert.rejects(readFile(join(output, "READY")), { code: "ENOENT" });
});

test("partial publication can resume without overwriting inputs or repeating external work", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "bundle"), bytes = new TextEncoder().encode("known-output");
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, "first.json"), bytes, { flag: "wx", mode: 0o600 });
  await publishDeploymentFiles(output, { "first.json": bytes, "second.json": bytes }, true);
  assert.equal((await verifyDeploymentFiles(output)).files.length, 2);
  assert.equal(await readFile(join(output, "first.json"), "utf8"), "known-output");
  await writeFile(join(output, "unexpected.json"), "surprise");
  await assert.rejects(verifyDeploymentFiles(output), /INVENTORY_FILES/);
});

test("bounded reads and crash locks fail closed", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "large.json"), "12345");
  await assert.rejects(readDeploymentFile(join(root, "large.json"), 4), /BOUND/);
  const output = join(root, "bundle"); await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, ".publication-lock"), "old lock");
  await assert.rejects(publishDeploymentFiles(output, { "result.json": new Uint8Array() }, true));
  assert.equal(await readFile(join(output, ".publication-lock"), "utf8"), "old lock");
});

test("a parent replaced after its directory check cannot redirect reads outside the trusted directory", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const trusted = join(root, "trusted"), outside = join(root, "outside"), moved = join(root, "held");
  await mkdir(trusted); await mkdir(outside);
  await writeFile(join(trusted, "result.json"), "approved");
  await writeFile(join(outside, "result.json"), "foreign");
  const parent = await stat(trusted), isDirectory = parent.isDirectory;
  let attacked = false;
  // Replace the checked parent synchronously while the reader still holds its
  // pre-substitution stat. No production hook or scheduler timing is involved.
  const replacement = context.mock.method(Object.getPrototypeOf(parent), "isDirectory", function (this: Stats) {
    const directory = isDirectory.call(this);
    if (!attacked && this.dev === parent.dev && this.ino === parent.ino) {
      attacked = true;
      renameSync(trusted, moved);
      symlinkSync(outside, trusted);
    }
    return directory;
  });
  try {
    await assert.rejects(readDeploymentFile(join(trusted, "result.json")), /DIRECTORY_IDENTITY|ENOTDIR|ELOOP/);
    assert.equal(attacked, true);
  } finally { replacement.mock.restore(); }
  assert.equal(await readFile(join(outside, "result.json"), "utf8"), "foreign");
  assert.equal(await readFile(join(moved, "result.json"), "utf8"), "approved");
});
