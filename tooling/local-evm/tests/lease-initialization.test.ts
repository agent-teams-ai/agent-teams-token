import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { PathLike } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitializingRunDirectory, publishInitializedRun } from "../run-initialization.ts";
import { test } from "node:test";
import { createRunLease, reclaimStaleRuns } from "../run-lease.ts";

test("initial publication defers scanners throughout the real two-link window", {timeout: 10_000}, async (context) => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-initial-link-")));
  const initial = await createInitializingRunDirectory(root, "initial");
  const directory = initial.directory;
  const path = join(directory, "lease.v1.json");
  const linked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalLink = fs.link;
  let temporary: PathLike | undefined;
  let publication: Promise<string> | undefined;
  try {
    context.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
      await originalLink(...args);
      if (args[1] === path) {
        temporary = args[0];
        linked.resolve();
        await release.promise;
      }
    });
    syncBuiltinESMExports();
    publication = publishInitializedRun(initial, async () => await createRunLease(directory));
    await linked.promise;
    const before = await fs.lstat(path, {bigint: true});
    const temp = await fs.lstat(temporary!, {bigint: true});
    assert.equal(before.nlink, 2n);
    assert.equal(temp.nlink, 2n);
    assert.equal(before.ino, temp.ino);
    assert.equal(before.dev, temp.dev);
    context.diagnostic(`real hardlink held: lease and temporary inode ${before.ino}, nlink=2`);
    assert.equal(await reclaimStaleRuns(root), 0);
    assert.equal((await fs.lstat(path, {bigint: true})).nlink, 2n);
    release.resolve();
    const promoted = await publication;
    assert.equal((await fs.lstat(join(promoted, "lease.v1.json"), {bigint: true})).nlink, 1n);
  } finally {
    release.resolve();
    await publication;
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, {recursive: true, force: true});
  }
});

for (const fail of [false, true]) {
  test(`initial finalization ${fail ? "failure preserves primary error" : "finishes before promotion"}`, {timeout: 10_000}, async (context) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-initial-finalize-")));
    const initial = await createInitializingRunDirectory(root, "finalize");
    const finalized = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const primary = new Error("injected finalization failure");
    const handles = new Set<Awaited<ReturnType<typeof fs.open>>>();
    const originalOpen = fs.open;
    let publication: Promise<string> | undefined;
    try {
      context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        handles.add(handle);
        const close = handle.close.bind(handle);
        context.mock.method(handle, "close", async () => {await close(); handles.delete(handle);});
        return handle;
      });
      syncBuiltinESMExports();
      publication = publishInitializedRun(initial, async () => await createRunLease(initial.directory, {
        afterPublish: async () => {
          finalized.resolve();
          await release.promise;
          if (fail) {throw primary;}
        },
      }));
      await finalized.promise;
      assert.equal((await fs.lstat(join(initial.directory, "lease.v1.json"), {bigint: true})).nlink, 1n);
      assert.deepEqual(await fs.readdir(root), [initial.directory.slice(root.length + 1)]);
      assert.equal(await reclaimStaleRuns(root), 0);
      assert(handles.size > 0);
      release.resolve();
      if (fail) {
        await assert.rejects(publication, (cause) => cause === primary);
        assert.deepEqual(await fs.readdir(root), [initial.directory.slice(root.length + 1)]);
      } else {
        const destination = await publication;
        assert(destination.includes("/run-init-"));
        assert.equal((await fs.lstat(destination, {bigint: true})).ino.toString(), initial.identity.split(":")[1]);
      }
      assert.equal(handles.size, 0);
      assert.deepEqual((await fs.readdir(fail ? initial.directory : (await publication))).filter((name) => name.endsWith(".tmp")), []);
    } finally {
      release.resolve();
      await Promise.allSettled(publication === undefined ? [] : [publication]);
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, {recursive: true, force: true});
    }
  });
}

test("initializer substitution during publication preserves both directories", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-initial-substitute-")));
  const initial = await createInitializingRunDirectory(root, "substitute");
  const displaced = join(root, "displaced");
  try {
    await assert.rejects(publishInitializedRun(initial, async () => {
      await createRunLease(initial.directory);
      await fs.rename(initial.directory, displaced);
      await fs.mkdir(initial.directory, {mode: 0o700});
      await fs.writeFile(join(initial.directory, "sentinel"), "preserve");
    }), {code: "LOCAL_EVM_RUN_DIRECTORY_CHANGED"});
    assert.equal(await fs.readFile(join(initial.directory, "sentinel"), "utf8"), "preserve");
    assert.equal((await fs.lstat(join(displaced, "lease.v1.json"))).nlink, 1);
    assert.equal((await fs.readdir(root)).some((name) => name.startsWith("run-")), false);
  } finally {await fs.rm(root, {recursive: true, force: true});}
});

for (const contents of ["markerless", "unfinished-hardlink"] as const) {
  test(`abandoned initializer reclaims ${contents} without parsing unfinished bytes`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-initial-recovery-")));
    const directory = await fs.mkdtemp(join(root, ".initialize-v1-2147483647-linuxx1-abandoned-"));
    try {
      if (contents === "unfinished-hardlink") {
        const temporary = join(directory, "unfinished.tmp");
        await fs.writeFile(temporary, "unfinished", {mode: 0o600});
        await fs.link(temporary, join(directory, "lease.v1.json"));
      }
      assert.equal(await reclaimStaleRuns(root), 1);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {await fs.rm(root, {recursive: true, force: true});}
  });
}

for (const unsafe of ["mode", "symlink", "substitution"] as const) {
  test(`initializer recovery preserves ${unsafe}`, async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-initial-unsafe-")));
    const directory = await fs.mkdtemp(join(root, ".initialize-v1-2147483647-linuxx1-unsafe-"));
    const foreign = join(root, "foreign");
    await fs.mkdir(foreign, {mode: 0o700});
    await fs.writeFile(join(foreign, "sentinel"), "preserve");
    try {
      if (unsafe === "mode") {await fs.chmod(directory, 0o755);}
      if (unsafe === "symlink") {
        await fs.rmdir(directory);
        await fs.symlink(foreign, directory);
      }
      await assert.rejects(reclaimStaleRuns(root, {afterDirectoryList: async () => {
        if (unsafe === "substitution") {
          await fs.rename(directory, join(root, "displaced"));
          await fs.rename(foreign, directory);
        }
      }}));
      const names = await fs.readdir(root);
      const sentinelDirectory = unsafe === "substitution" ? join(root, names.find((name) => name.startsWith(".reclaim-v1-"))!) : foreign;
      assert.equal(await fs.readFile(join(sentinelDirectory, "sentinel"), "utf8"), "preserve");
    } finally {await fs.rm(root, {recursive: true, force: true});}
  });
}

test("ambiguous initializer identity is preserved", {skip: process.platform !== "linux"}, async (context) => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-initial-ambiguous-")));
  const initial = await createInitializingRunDirectory(root, "ambiguous");
  const read = fs.readFile;
  try {
    context.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === `/proc/${process.pid}/stat`) {throw new Error("identity unavailable");}
      return await read(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(reclaimStaleRuns(root), {code: "LOCAL_EVM_RUN_OWNER_AMBIGUOUS"});
    assert.equal((await fs.lstat(initial.directory)).isDirectory(), true);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(root, {recursive: true, force: true});
  }
});

for (const mutation of ["substituted", "occupied"] as const) {
  test(`promotion preserves an exclusively reserved destination when ${mutation}`, async (context) => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-promotion-custody-")));
    const initial = await createInitializingRunDirectory(root, "custody");
    const stat = fs.lstat;
    let observations = 0;
    let destination: string | undefined;
    try {
      context.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
        if (String(args[0]).startsWith(join(root, "run-init-"))) {
          destination = String(args[0]);
          observations += 1;
          if (observations === 2) {
            if (mutation === "substituted") {
              await fs.rename(destination, join(root, "displaced-reservation"));
              await fs.mkdir(destination, {mode: 0o700});
            }
            await fs.writeFile(join(destination, "sentinel"), "preserve");
          }
        }
        return await stat(...args);
      });
      syncBuiltinESMExports();
      await assert.rejects(publishInitializedRun(initial, async () => await createRunLease(initial.directory)));
      assert(destination);
      assert.equal(await fs.readFile(join(destination, "sentinel"), "utf8"), "preserve");
      assert.equal((await stat(initial.directory, {bigint: true})).ino.toString(), initial.identity.split(":")[1]);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await fs.rm(root, {recursive: true, force: true});
    }
  });
}


test("SIGKILLed initializer is reclaimed after its actual process exits", {timeout: 10_000}, async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "evm-initial-killed-")));
  const moduleUrl = new URL("../run-initialization.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {createInitializingRunDirectory} from ${JSON.stringify(moduleUrl)};
    const initial = await createInitializingRunDirectory(${JSON.stringify(root)}, "killed");
    process.stdout.write(JSON.stringify(initial) + "\\n");
    process.stdin.resume();
  `], {stdio: ["pipe", "pipe", "pipe"]});
  const closed = once(child, "close");
  try {
    const [bytes] = await once(child.stdout, "data");
    const initial = JSON.parse(String(bytes));
    assert.equal(await reclaimStaleRuns(root), 0);
    assert.equal((await fs.lstat(initial.directory)).isDirectory(), true);
    child.kill("SIGKILL");
    await closed;
    assert.equal(await reclaimStaleRuns(root), 1);
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    child.kill("SIGKILL");
    await closed;
    await fs.rm(root, {recursive: true, force: true});
  }
});
