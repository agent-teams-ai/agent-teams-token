import { randomUUID } from "node:crypto";
import {
  constants,
  link,
  open,
  lstat,
  mkdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { LocalEvmError } from "./model.ts";

import {
  assertPolicyInteger, assertRegularFile, assertSameFile, assertWithinBounds,
  fileIdentity, type FileSizeBounds, type RegularFileIdentity,
} from "./file-state.ts";
export { allocatedBytesFromStatBlocks } from "./file-state.ts";
export type { FileSizeBounds, RegularFileIdentity } from "./file-state.ts";

export interface PublicationHooks {
  readonly beforePublish?: () => Promise<void>;
}

export async function readRegularFile(path: string, label: string): Promise<Buffer> {
  return (await readRegularFileObserved(path, label)).bytes;
}

export async function readOwnedBoundedFile(
  path: string,
  label: string,
  bounds: FileSizeBounds,
  mode = 0o600,
): Promise<{readonly bytes: Buffer; readonly identity: RegularFileIdentity}> {
  return await readRegularFileObserved(path, label, bounds, mode);
}

async function readRegularFileObserved(
  path: string,
  label: string,
  bounds?: FileSizeBounds,
  ownedMode?: number,
): Promise<{readonly bytes: Buffer; readonly identity: RegularFileIdentity}> {
  const absolute = resolve(path);
  await assertNoPathSubstitution(absolute, label);
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({bigint: true});
    assertRegularFile(before, label, ownedMode);
    assertWithinBounds(before, label, bounds);
    const identity = fileIdentity(before);
    const bytes = bounds === undefined
      ? await handle.readFile()
      : await boundedRead(handle, bounds.logicalBytes, label);
    const after = await handle.stat({bigint: true});
    assertSameFile(identity, after, label);
    assertWithinBounds(after, label, bounds);
    if (after.size !== before.size || after.blocks !== before.blocks
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || after.size !== BigInt(bytes.byteLength)) {
      throw new LocalEvmError(
        `LOCAL_EVM_${label}_CHANGED`,
        `${label} changed while it was read`,
      );
    }
    assertSameFile(identity, await lstat(absolute, {bigint: true}), label);
    return {bytes, identity};
  } catch (cause) {
    if (cause instanceof LocalEvmError) {throw cause;}
    const error = cause as NodeJS.ErrnoException;
    throw new LocalEvmError(`LOCAL_EVM_${label}_${error.code ?? "READ_FAILED"}`, `${label} could not be read safely`);
  } finally {
    await handle?.close();
  }
}

async function boundedRead(
  handle: FileHandle,
  cap: number,
  label: string,
): Promise<Buffer> {
  assertPolicyInteger(cap, label, "logical byte", true);
  const allocation = Buffer.alloc(cap + 1);
  let offset = 0;
  while (offset < allocation.length) {
    const result = await handle.read(
      allocation,
      offset,
      allocation.length - offset,
      null,
    );
    if (!Number.isSafeInteger(result.bytesRead)
      || result.bytesRead < 0
      || result.bytesRead > allocation.length - offset) {
      throw new LocalEvmError(
        `LOCAL_EVM_${label}_STAT_INVALID`,
        `${label} returned an invalid read count`,
      );
    }
    if (result.bytesRead === 0) {break;}
    offset += result.bytesRead;
  }
  if (offset > cap) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_TOO_LARGE`,
      `${label} exceeds its logical byte limit`,
    );
  }
  return allocation.subarray(0, offset);
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

export async function publishInitialFile(
  path: string,
  bytes: Uint8Array,
  mode = 0o600,
  bounds?: FileSizeBounds,
  hooks: PublicationHooks = {},
): Promise<void> {
  const absolute = resolve(path);
  await validatePrivateDirectory(dirname(absolute));
  assertBytesWithinBounds(bytes, bounds, "INITIAL_FILE");
  await assertAbsent(absolute, "INITIAL_FILE");
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await assertAbsent(temporary, "INITIAL_TEMP");
  let handle: FileHandle | undefined;
  let created: RegularFileIdentity | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | constants.O_NOFOLLOW,
      mode,
    );
    await handle.chmod(mode);
    const initial = await handle.stat({bigint: true});
    assertRegularFile(initial, "INITIAL_TEMP", mode);
    created = fileIdentity(initial);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({bigint: true});
    assertSameFile(created, written, "INITIAL_TEMP");
    assertWithinBounds(written, "INITIAL_FILE", bounds);
    if (written.size !== BigInt(bytes.byteLength)) {
      throw new LocalEvmError(
        "LOCAL_EVM_INITIAL_FILE_CHANGED",
        "initial file length differs from the supplied bytes",
      );
    }
    await assertExpectedBytes(handle, bytes, "INITIAL_FILE");
    await hooks.beforePublish?.();
    await assertAbsent(absolute, "INITIAL_FILE");
    assertSameFile(
      created,
      await lstat(temporary, {bigint: true}),
      "INITIAL_TEMP",
    );
    try {
      await link(temporary, absolute);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new LocalEvmError(
          "LOCAL_EVM_INITIAL_FILE_EXISTS",
          "initial file already exists",
        );
      }
      throw cause;
    }
    assertSameFile(
      created,
      await lstat(absolute, {bigint: true}),
      "INITIAL_FILE",
      2n,
    );
    assertSameFile(
      created,
      await lstat(temporary, {bigint: true}),
      "INITIAL_TEMP",
      2n,
    );
    await unlink(temporary);
    assertSameFile(
      created,
      await lstat(absolute, {bigint: true}),
      "INITIAL_FILE",
    );
    await syncDirectory(dirname(absolute));
  } finally {
    await handle?.close();
    if (created !== undefined) {
      await unlinkIfOwnedTemporary(temporary, created);
    }
  }
}

export async function replaceObservedFile(
  path: string,
  bytes: Uint8Array,
  expected: RegularFileIdentity,
  options: {readonly mode?: number; readonly bounds?: FileSizeBounds; readonly hooks?: PublicationHooks} = {},
): Promise<void> {
  const {mode = 0o600, bounds, hooks = {}} = options;
  const absolute = resolve(path);
  await validatePrivateDirectory(dirname(absolute));
  assertBytesWithinBounds(bytes, bounds, "UPDATED_FILE");
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  let created: RegularFileIdentity | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | constants.O_NOFOLLOW,
      mode,
    );
    await handle.chmod(mode);
    const initial = await handle.stat({bigint: true});
    assertRegularFile(initial, "UPDATED_TEMP", mode);
    created = fileIdentity(initial);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({bigint: true});
    assertSameFile(created, written, "UPDATED_TEMP");
    assertWithinBounds(written, "UPDATED_FILE", bounds);
    if (written.size !== BigInt(bytes.byteLength)) {
      throw new LocalEvmError(
        "LOCAL_EVM_UPDATED_FILE_CHANGED",
        "updated file length differs from the supplied bytes",
      );
    }
    await assertExpectedBytes(handle, bytes, "UPDATED_FILE");
    await hooks.beforePublish?.();
    assertSameFile(
      expected,
      await lstat(absolute, {bigint: true}),
      "UPDATED_FILE",
    );
    // This binds the authenticated predecessor immediately before rename.
    // Without a native renameat2 helper, a malicious same-UID actor may still
    // race that final syscall; no broader guarantee is claimed.
    await rename(temporary, absolute);
    assertSameFile(
      created,
      await lstat(absolute, {bigint: true}),
      "UPDATED_FILE",
    );
    await syncDirectory(dirname(absolute));
  } finally {
    await handle?.close();
    if (created !== undefined) {
      await unlinkIfOwnedTemporary(temporary, created);
    }
  }
}

function assertBytesWithinBounds(
  bytes: Uint8Array,
  bounds: FileSizeBounds | undefined,
  label: string,
): void {
  if (bounds === undefined) {return;}
  assertPolicyInteger(bounds.logicalBytes, label, "logical byte", true);
  assertPolicyInteger(bounds.allocatedBytes, label, "allocated byte");
  if (!Number.isSafeInteger(bytes.byteLength)
    || bytes.byteLength > bounds.logicalBytes) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_TOO_LARGE`,
      `${label} exceeds its logical byte limit`,
    );
  }
}

async function assertExpectedBytes(
  handle: FileHandle,
  expected: Uint8Array,
  label: string,
): Promise<void> {
  const actual = Buffer.alloc(expected.byteLength + 1);
  let offset = 0;
  while (offset < actual.length) {
    const result = await handle.read(
      actual,
      offset,
      actual.length - offset,
      offset,
    );
    if (result.bytesRead === 0) {break;}
    offset += result.bytesRead;
  }
  if (offset !== expected.byteLength
    || !actual.subarray(0, offset).equals(Buffer.from(expected))) {
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_CHANGED`,
      `${label} does not contain the supplied bytes`,
    );
  }
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
    throw new LocalEvmError(
      `LOCAL_EVM_${label}_EXISTS`,
      `${label} already exists`,
    );
  } catch (cause) {
    if (cause instanceof LocalEvmError) {throw cause;}
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {throw cause;}
  }
}

async function unlinkIfOwnedTemporary(
  path: string,
  expected: RegularFileIdentity,
): Promise<void> {
  try {
    const current = await lstat(path, {bigint: true});
    const sameOwnedInode = current.dev === expected.dev
      && current.ino === expected.ino
      && current.uid === expected.uid
      && current.mode === expected.mode
      && (current.nlink === 1n || current.nlink === 2n);
    if (!sameOwnedInode) {return;}
    // The random private-directory name and inode check establish ownership.
    // A hostile same-UID last-syscall race remains outside the portable model.
    await unlink(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {throw cause;}
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export function assertExpectedBasename(path: string, expected: string, label: string): void {
  if (basename(path) !== expected) {throw new LocalEvmError(`LOCAL_EVM_${label}_NAME_INVALID`, `${label} filename must be ${expected}`);}
}
