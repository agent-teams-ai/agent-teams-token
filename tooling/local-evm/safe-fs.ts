import { constants, open, lstat, mkdir, realpath, rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { LocalEvmError } from "./model.ts";

export async function readRegularFile(path: string, label: string): Promise<Buffer> {
  const absolute = resolve(path);
  await assertNoPathSubstitution(absolute, label);
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {throw new LocalEvmError(`LOCAL_EVM_${label}_NOT_REGULAR`, `${label} must be a singly linked regular file`);}
    return await handle.readFile();
  } catch (cause) {
    if (cause instanceof LocalEvmError) {throw cause;}
    const error = cause as NodeJS.ErrnoException;
    throw new LocalEvmError(`LOCAL_EVM_${label}_${error.code ?? "READ_FAILED"}`, `${label} could not be read safely`);
  } finally {
    await handle?.close();
  }
}

export async function assertNoPathSubstitution(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  let resolvedParent: string;
  try {
    resolvedParent = await realpath(parent);
  } catch {
    throw new LocalEvmError(`LOCAL_EVM_${label}_PARENT_INVALID`, `${label} parent is absent or substituted`);
  }
  if (resolvedParent !== parent) {throw new LocalEvmError(`LOCAL_EVM_${label}_PATH_SUBSTITUTION`, `${label} parent contains a symlink`);}
  try {
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink()) {throw new LocalEvmError(`LOCAL_EVM_${label}_SYMLINK`, `${label} cannot be a symlink`);}
  } catch (cause) {
    if (cause instanceof LocalEvmError) {throw cause;}
    const error = cause as NodeJS.ErrnoException;
    if (error.code !== "ENOENT") {throw cause;}
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  const expectedOwner = process.getuid?.();
  const substituted = await realpath(path) !== resolve(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || substituted || (stat.mode & 0o077) !== 0
    || (expectedOwner !== undefined && stat.uid !== expectedOwner)) {
    throw new LocalEvmError("LOCAL_EVM_DIRECTORY_NOT_PRIVATE", `${path} must be a real mode-0700 directory`);
  }
}

export async function atomicWrite(path: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
  const absolute = resolve(path);
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, absolute);
  const directory = await open(dirname(absolute), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function assertExpectedBasename(path: string, expected: string, label: string): void {
  if (basename(path) !== expected) {throw new LocalEvmError(`LOCAL_EVM_${label}_NAME_INVALID`, `${label} filename must be ${expected}`);}
}
