import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { AuthenticatedToolSnapshots, stableRead, type ToolSources } from "../src/adapters/tool-snapshots.ts";

async function fixture() {
  const root = await promises.realpath(await promises.mkdtemp(join(tmpdir(), "agtmai-snapshots-test-")));
  const directory = join(root, "run"); await promises.mkdir(directory, { mode: 0o700 });
  const entry = await promises.lstat(directory, { bigint: true });
  const rootEntry = await promises.lstat(root, { bigint: true });
  const source = join(root, "tiny-tool"); const bytes = Buffer.from("authenticated synthetic bytes");
  await promises.writeFile(source, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const sources = Object.fromEntries(["solana", "keygen", "validator", "splToken", "tokenProgram", "associatedTokenProgram"].map((name) => [name, { path: source, hash }])) as ToolSources;
  const lease = new AuthenticatedToolSnapshots({ directory, directoryIdentity: { dev: String(entry.dev), ino: String(entry.ino) }, rootIdentity: { dev: String(rootEntry.dev), ino: String(rootEntry.ino) } });
  return { root, directory, source, sources, lease };
}

test("directory close failures are terminal and every held descriptor is closed once", async (t) => {
  const value = await fixture(); const open = fs.openSync; const close = fs.closeSync;
  const held = new Set<number>(); const calls: number[] = [];
  const directoryFailure = new Error("synthetic directory close failure");
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (fs.fstatSync(fd).isDirectory()) { held.add(fd); }
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => {
    if (held.has(fd)) { calls.push(fd); close(fd); throw directoryFailure; }
    close(fd);
  });
  syncBuiltinESMExports();
  try {
    await value.lease.create(value.sources);
    assert.equal(held.size, 2);
    const closing = value.lease.close();
    await assert.rejects(closing, (cause) => {
      assert.ok(cause instanceof AggregateError); assert.deepEqual(cause.errors, [directoryFailure, directoryFailure]); return true;
    });
    assert.equal(value.lease.close(), closing);
    assert.deepEqual(calls.toSorted(), [...held].toSorted());
    assert.deepEqual(await snapshotNames(value.root), []);
    for (const fd of held) { assert.throws(() => fs.fstatSync(fd), { code: "EBADF" }); }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await promises.rm(value.root, { recursive: true, force: true }); }
});

test("partial snapshot write and consumed-close failures preserve order and clean owned files", async (t) => {
  const value = await fixture(); const open = fs.openSync; const write = fs.writeFileSync; const close = fs.closeSync;
  const primary = new Error("synthetic write failure"); const secondary = new Error("synthetic file close failure");
  let target: number | undefined; let closes = 0;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args); if (String(args[0]).includes("/keygen-")) { target = fd; } return fd;
  });
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => { if (args[0] === target) { throw primary; } write(...args); });
  t.mock.method(fs, "closeSync", (fd: number) => { close(fd); if (fd === target) { closes += 1; target = undefined; throw secondary; } });
  syncBuiltinESMExports();
  try {
    await assert.rejects(value.lease.create(value.sources), (cause) => {
      assert.ok(cause instanceof AggregateError); assert.equal(cause.cause, primary); assert.deepEqual(cause.errors, [primary, secondary]); return true;
    });
    await value.lease.close();
    assert.equal(closes, 1); assert.deepEqual(await snapshotNames(value.root), []);
    assert.equal(await promises.readFile(value.source, "utf8"), "authenticated synthetic bytes");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await promises.rm(value.root, { recursive: true, force: true }); }
});

test("unknown partial directory identity retains the directory and closes all acquired handles", async (t) => {
  const value = await fixture(); const open = fs.openSync; const stat = fs.fstatSync; const close = fs.closeSync;
  const held = new Set<number>(); const closed = new Set<number>(); let target: number | undefined;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args); if (stat(fd).isDirectory()) { held.add(fd); }
    if (String(args[0]).includes("/.authenticated-tools-")) { target = fd; } return fd;
  });
  t.mock.method(fs, "fstatSync", new Proxy(stat, { apply(method, receiver, args) {
    if (args[0] === target) { throw new Error("synthetic identity capture failure"); } return Reflect.apply(method, receiver, args);
  } }));
  t.mock.method(fs, "closeSync", (fd: number) => { close(fd); if (held.has(fd)) { closed.add(fd); } });
  syncBuiltinESMExports();
  try {
    await assert.rejects(value.lease.create(value.sources), /synthetic identity capture failure/u);
    await assert.rejects(value.lease.close(), /SOLANA_TOOL_SNAPSHOT_IDENTITY/u);
    assert.deepEqual(closed, held); assert.equal(held.size, 2);
    assert.equal((await snapshotNames(value.root)).length, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await promises.rm(value.root, { recursive: true, force: true }); }
});

test("source read and close failures preserve the first failure without retrying a consumed handle", async (t) => {
  const value = await fixture(); const open = promises.open; let closes = 0;
  const primary = new Error("synthetic source read failure"); const secondary = new Error("synthetic source close failure");
  t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
    const handle = await open(...args);
    if (args[0] === value.source) {
      const close = handle.close.bind(handle);
      handle.readFile = async () => { throw primary; };
      handle.close = async () => { closes += 1; await close(); throw secondary; };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(stableRead(value.source), (cause) => {
      assert.ok(cause instanceof AggregateError); assert.equal(cause.cause, primary); assert.deepEqual(cause.errors, [primary, secondary]); return true;
    });
    assert.equal(closes, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await promises.rm(value.root, { recursive: true, force: true }); }
});

test("same-inode source mutation during reading is rejected before bytes are returned", async (t) => {
  const value = await fixture(); const open = promises.open;
  t.mock.method(promises, "open", async (...args: Parameters<typeof promises.open>) => {
    const handle = await open(...args);
    if (args[0] === value.source) {
      t.mock.method(handle, "readFile", new Proxy(handle.readFile, { async apply(method, receiver, args) {
        const bytes = await Reflect.apply(method, receiver, args); await promises.chmod(value.source, 0o700); return bytes;
      } }));
    }
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(stableRead(value.source), /SOLANA_TOOL_IDENTITY/u); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); await promises.rm(value.root, { recursive: true, force: true }); }
});

async function snapshotNames(root: string): Promise<string[]> { return (await promises.readdir(root)).filter((name) => name.startsWith(".authenticated-tools-")); }

test("snapshot ownership survives removal of the separate private run directory", async () => {
  const value = await fixture();
  try {
    const paths = await value.lease.create(value.sources);
    assert.equal(dirname(dirname(paths.solana)), value.root);
    assert.notEqual(dirname(paths.solana), value.directory);
    await promises.rm(value.directory, { recursive: true });
    assert.equal(await promises.readFile(paths.solana, "utf8"), "authenticated synthetic bytes");
    await value.lease.close();
    assert.deepEqual(await snapshotNames(value.root), []);
  } finally { await value.lease.close().catch(() => {}); await promises.rm(value.root, { recursive: true, force: true }); }
});
