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
  await ensureDirectoryComponent(resolve(path), true);
}

export async function validatePrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (await realpath(parent).catch(() => null) !== parent) {
    throw new LocalEvmError("LOCAL_EVM_DIRECTORY_PATH_SUBSTITUTION", `${absolute} parent is absent or substituted`);
  }
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const entry = await handle.stat();
    const expectedOwner = process.getuid?.();
    if (!entry.isDirectory() || (expectedOwner !== undefined && entry.uid !== expectedOwner)
      || (entry.mode & 0o077) !== 0) {
      throw new LocalEvmError("LOCAL_EVM_DIRECTORY_NOT_PRIVATE", `${absolute} must be an owned mode-0700 directory`);
    }
  } catch (cause) {
    if (cause instanceof LocalEvmError) {throw cause;}
    const error = cause as NodeJS.ErrnoException;
    throw new LocalEvmError(`LOCAL_EVM_DIRECTORY_${error.code ?? "OPEN_FAILED"}`, `${absolute} could not be validated without creating it`);
  } finally {
    await handle?.close();
  }
}

async function ensureDirectoryComponent(absolute: string, requirePrivate: boolean): Promise<void> {
  const parent = dirname(absolute);
  if (await realpath(parent).catch(() => null) !== parent) {
    throw new LocalEvmError("LOCAL_EVM_DIRECTORY_PATH_SUBSTITUTION", `${absolute} parent is absent or substituted`);
  }
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {throw cause;}
    try {
      await mkdir(absolute, { recursive: false, mode: 0o700 });
    } catch (mkdirCause) {
      // Another local run may have created the same component after lstat.
      // Re-open and validate that winner instead of treating EEXIST as failure.
      if ((mkdirCause as NodeJS.ErrnoException).code !== "EEXIST") {throw mkdirCause;}
    }
    entry = await lstat(absolute);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new LocalEvmError("LOCAL_EVM_DIRECTORY_PATH_SUBSTITUTION", `${absolute} must be a real directory`);
  }
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    throw new LocalEvmError("LOCAL_EVM_DIRECTORY_PATH_SUBSTITUTION", `${absolute} could not be opened without following links`);
  }
  const stat = await handle.stat();
  const expectedOwner = process.getuid?.();
  try {
    if (!stat.isDirectory() || (expectedOwner !== undefined && stat.uid !== expectedOwner)
      || (requirePrivate && (stat.mode & 0o077) !== 0)) {
      throw new LocalEvmError("LOCAL_EVM_DIRECTORY_NOT_PRIVATE", `${absolute} must be an owned${requirePrivate ? " mode-0700" : ""} directory`);
    }
    if (await realpath(absolute) !== absolute) {
      throw new LocalEvmError("LOCAL_EVM_DIRECTORY_PATH_SUBSTITUTION", `${absolute} contains a substituted path component`);
    }
  } finally {
    await handle.close();
  }
}

export async function ensurePrivateDirectoryPath(boundary: string, target: string): Promise<void> {
  const absoluteBoundary = resolve(boundary);
  const absoluteTarget = resolve(target);
  if (await realpath(absoluteBoundary).catch(() => null) !== absoluteBoundary
    || (absoluteTarget !== absoluteBoundary && !absoluteTarget.startsWith(`${absoluteBoundary}/`))) {
    throw new LocalEvmError("LOCAL_EVM_DIRECTORY_PATH_SUBSTITUTION", "private directory escaped or substituted its trusted boundary");
  }
  const relative = absoluteTarget.slice(absoluteBoundary.length).split("/").filter(Boolean);
  let current = absoluteBoundary;
  for (const [index, component] of relative.entries()) {
    current = `${current}/${component}`;
    await ensureDirectoryComponent(current, index === relative.length - 1);
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
