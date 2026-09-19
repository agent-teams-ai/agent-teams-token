import { constants, lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { deploymentBytes } from "../application/compile-deployment.js";
import type { Hex } from "../domain/deployment.js";
import { sha256 } from "./digest.js";

export interface DeliveryInventory {
  readonly schema: "agtmai-delivery-inventory-v1";
  readonly files: readonly { readonly name: string; readonly sha256: Hex; readonly bytes: number }[];
}
const FILE_LIMIT = 16 * 1024 * 1024;
const leaf = (name: string): boolean => /^[a-z0-9][a-z0-9.-]{0,95}$/.test(name) && !name.includes("..");
const io = (reason: string): never => { throw new Error(`DEPLOYMENT_IO_${reason}`); };
const integrity = (reason: string): never => { throw new Error(`DEPLOYMENT_EVIDENCE_${reason}`); };
async function realParents(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) { io("DIRECTORY_IDENTITY"); }
    if (current === dirname(current)) { return; }
    current = dirname(current);
  }
}

/** Bound allocation before reading and reject substituted/symlink/hardlinked public inputs. */
export async function readDeploymentFile(path: string, limit = FILE_LIMIT): Promise<Uint8Array> {
  // Node has no openat. Linux descriptor paths let O_NOFOLLOW protect every
  // component, even if an already opened ancestor is replaced concurrently.
  if (process.platform !== "linux") { io("DESCRIPTOR_TRAVERSAL_UNAVAILABLE"); }
  const directories: { file: FileHandle; path: string }[] = [];
  let parent = "/";
  try {
    for (const component of [...dirname(resolve(path)).split("/").filter(Boolean), basename(path)]) {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) { io("DIRECTORY_IDENTITY"); }
      const file = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push({ file, path: parent });
      const opened = await file.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino) { io("DIRECTORY_IDENTITY"); }
      parent = `/proc/self/fd/${file.fd}/${component}`;
    }
    const bytes = await readBoundedFile(parent, limit);
    for (const directory of directories) {
      const opened = await directory.file.stat(), named = await lstat(directory.path);
      if (!named.isDirectory() || named.dev !== opened.dev || named.ino !== opened.ino) { io("DIRECTORY_IDENTITY"); }
    }
    return bytes;
  } finally { await Promise.all(directories.map(directory => directory.file.close())); }
}
async function readBoundedFile(path: string, limit: number): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) { io("FILE_BOUND_OR_IDENTITY"); }
    const bytes = new Uint8Array(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) { break; }
      length += read.bytesRead;
    }
    const after = await file.stat(), named = await lstat(path);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || named.dev !== before.dev || named.ino !== before.ino || named.isSymbolicLink() || named.nlink !== 1) { io("FILE_CHANGED"); }
    return bytes.slice(0, length);
  } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function exclusive(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

/** One owned directory; inventory is written last and does not hash itself. Retry never repeats transactions. */
export async function publishDeploymentFiles(directory: string, files: Readonly<Record<string, Uint8Array>>, resume = false): Promise<DeliveryInventory> {
  const names = Object.keys(files).toSorted();
  if (!names.length || names.length > 64 || names.some(name => !leaf(name) || name === "inventory.json" || files[name]!.length > FILE_LIMIT)) { io("PUBLICATION_FILES"); }
  const target = resolve(directory);
  await realParents(dirname(target));
  if (!resume) { await mkdir(target, { mode: 0o700 }); }
  await realParents(target);
  const owned = await lstat(target);
  if ((owned.mode & 0o777) !== 0o700 || owned.uid !== process.getuid?.()) { io("OUTPUT_NOT_OWNED"); }
  // A publication lock excludes concurrent publishers. No automatic stale-lock deletion.
  const lockPath = join(target, ".publication-lock");
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const existing = await readdir(target);
    if (existing.some(name => !names.includes(name) && name !== "inventory.json" && name !== ".publication-lock")) { integrity("UNEXPECTED_FILE"); }
    const inventory: DeliveryInventory = { schema: "agtmai-delivery-inventory-v1", files: names.map(name => ({ name, sha256: sha256(files[name]!), bytes: files[name]!.length })) };
    for (const name of [...names, "inventory.json"]) {
      const bytes = name === "inventory.json" ? deploymentBytes(inventory) : files[name]!;
      try { await exclusive(join(target, name), bytes); }
      catch (error) {
        if (!resume || (error as NodeJS.ErrnoException).code !== "EEXIST") { throw error; }
        const previous = await readDeploymentFile(join(target, name));
        if (sha256(previous) !== sha256(bytes)) { integrity("RESUME_MISMATCH"); }
      }
      await syncDirectory(target);
    }
    await syncDirectory(dirname(target));
    return inventory;
  } finally {
    await lock.close();
    // Preserve a crash lock; only a normal completion/error releases our live-process lock.
    await unlink(lockPath);
    await syncDirectory(target);
  }
}

export async function verifyDeploymentFiles(directory: string): Promise<DeliveryInventory> {
  const bytes = await readDeploymentFile(join(directory, "inventory.json"));
  let inventory: DeliveryInventory;
  try { inventory = JSON.parse(new TextDecoder().decode(bytes)) as DeliveryInventory; } catch { return integrity("INVENTORY_INVALID"); }
  if (inventory.schema !== "agtmai-delivery-inventory-v1" || Object.keys(inventory).toSorted().join() !== "files,schema"
    || !Array.isArray(inventory.files) || !inventory.files.length || inventory.files.length > 64
    || inventory.files.some(f => !f || !leaf(f.name) || f.name === "inventory.json" || !/^0x[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > FILE_LIMIT || Object.keys(f).toSorted().join() !== "bytes,name,sha256")
    || new Set(inventory.files.map(f => f.name)).size !== inventory.files.length) { return integrity("INVENTORY_INVALID"); }
  const names = inventory.files.map(f => f.name).toSorted();
  if (JSON.stringify((await readdir(directory)).toSorted()) !== JSON.stringify([...names, "inventory.json"].toSorted())) { io("INVENTORY_FILES"); }
  if (sha256(bytes) !== sha256(deploymentBytes(inventory))) { integrity("INVENTORY_NONCANONICAL"); }
  for (const file of inventory.files) {
    const content = await readDeploymentFile(join(directory, file.name));
    if (content.length !== file.bytes || sha256(content) !== file.sha256) { integrity("INVENTORY_MISMATCH"); }
  }
  return inventory;
}
