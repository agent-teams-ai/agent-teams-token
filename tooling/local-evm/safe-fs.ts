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
import { finishWithCleanup } from "./cleanup.ts";
import { holdPublicationParent, syncPublicationDirectory as syncDirectory } from "./publication-parent.ts";
import { observeNamedHeldFile } from "./file-content.ts";

import {
  assertPolicyInteger, assertRegularFile, assertSameFile, assertWithinBounds,
  fileIdentity, mutableFileSnapshot, type FileSizeBounds,
  type RegularFileIdentity, type RegularFileObservation,
} from "./file-state.ts";
export { allocatedBytesFromStatBlocks } from "./file-state.ts";
export type {
  FileSizeBounds,
  RegularFileIdentity,
  RegularFileObservation,
} from "./file-state.ts";

export interface PublicationHooks {
  readonly beforePublish?: () => Promise<void>;
  readonly afterPublish?: () => Promise<void>;
}

export async function readRegularFile(path: string, label: string): Promise<Buffer> {
  return (await readRegularFileObserved(path, label)).bytes;
}

export async function readOwnedBoundedFile(
  path: string,
  label: string,
  bounds: FileSizeBounds,
  mode = 0o600,
): Promise<RegularFileObservation> {
  return await readRegularFileObserved(path, label, bounds, mode);
}

async function readRegularFileObserved(
  path: string,
  label: string,
  bounds?: FileSizeBounds,
  ownedMode?: number,
): Promise<RegularFileObservation> {
  const absolute = resolve(path);
  await assertNoPathSubstitution(absolute, label);
  let handle: FileHandle | undefined;
  let primary: unknown;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initial = await handle.stat({bigint: true});
    assertRegularFile(initial, label, ownedMode);
    assertWithinBounds(initial, label, bounds);
    const identity = fileIdentity(initial);
    const observed = await observeNamedHeldFile(
      absolute,
      handle,
      identity,
      {
        label,
        bounds,
        expectedMutable: mutableFileSnapshot(initial),
      },
    );
    return {identity, ...observed};
  } catch (cause) {
    primary = cause instanceof LocalEvmError
      ? cause
      : new LocalEvmError(
        `LOCAL_EVM_${label}_${(cause as NodeJS.ErrnoException).code
          ?? "READ_FAILED"}`,
        `${label} could not be read safely`,
      );
    throw primary;
  } finally {
    await finishWithCleanup(
      primary,
      [async () => await handle?.close()],
    );
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
  const parent = await holdPublicationParent(dirname(absolute));
  let handle: FileHandle | undefined;
  let created: RegularFileIdentity | undefined;
  let primary: unknown;
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
      changed("INITIAL_FILE", "length differs from the supplied bytes");
    }
    await hooks.beforePublish?.();
    await parent.assertReady();
    await assertAbsent(absolute, "INITIAL_FILE");
    await observeNamedHeldFile(
      temporary,
      handle,
      created,
      {
        label: "INITIAL_FILE",
        bounds,
        expectedBytes: bytes,
        expectedMutable: mutableFileSnapshot(written),
      },
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
    await observeNamedHeldFile(
      absolute,
      handle,
      created,
      {
        label: "INITIAL_FILE",
        bounds,
        expectedBytes: bytes,
        expectedLinks: 2n,
      },
    );
    await observeNamedHeldFile(
      temporary,
      handle,
      created,
      {
        label: "INITIAL_FILE",
        bounds,
        expectedBytes: bytes,
        expectedLinks: 2n,
      },
    );
    await unlink(temporary);
    const published = await observeNamedHeldFile(
      absolute,
      handle,
      created,
      {label: "INITIAL_FILE", bounds, expectedBytes: bytes},
    );
    await hooks.afterPublish?.();
    const verified = await observeNamedHeldFile(
      absolute,
      handle,
      created,
      {
        label: "INITIAL_FILE",
        bounds,
        expectedBytes: bytes,
        expectedMutable: published.mutable,
      },
    );
    await syncDirectory(dirname(absolute));
    await parent.assertReady();
    await observeNamedHeldFile(
      absolute,
      handle,
      created,
      {
        label: "INITIAL_FILE",
        bounds,
        expectedBytes: bytes,
        expectedMutable: verified.mutable,
      },
    );
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    await finishWithCleanup(primary, [
      async () => await handle?.close(),
      async () => {
        if (created !== undefined) {
          await unlinkIfOwnedTemporary(temporary, created);
        }
      },
      async () => await parent.close(),
    ]);
  }
}

export async function replaceObservedFile(
  path: string,
  bytes: Uint8Array,
  expected: RegularFileObservation,
  options: {readonly mode?: number; readonly bounds?: FileSizeBounds; readonly hooks?: PublicationHooks} = {},
): Promise<void> {
  const {mode = 0o600, bounds, hooks = {}} = options;
  const absolute = resolve(path);
  await validatePrivateDirectory(dirname(absolute));
  assertBytesWithinBounds(bytes, bounds, "UPDATED_FILE");
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  let created: RegularFileIdentity | undefined;
  let predecessor: FileHandle | undefined;
  const parent = await holdPublicationParent(dirname(absolute));
  let primary: unknown;
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
      changed("UPDATED_FILE", "length differs from the supplied bytes");
    }
    await hooks.beforePublish?.();
    await parent.assertReady();
    await observeNamedHeldFile(
      temporary,
      handle,
      created,
      {
        label: "UPDATED_FILE",
        bounds,
        expectedBytes: bytes,
        expectedMutable: mutableFileSnapshot(written),
      },
    );
    predecessor = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    await observeNamedHeldFile(
      absolute,
      predecessor,
      expected.identity,
      {
        label: "UPDATED_FILE",
        bounds,
        expectedBytes: expected.bytes,
        expectedMutable: expected.mutable,
      },
    );
    // This binds the authenticated predecessor immediately before rename.
    // Without a native renameat2 helper, a malicious same-UID actor may still
    // race that final syscall; no broader guarantee is claimed.
    await rename(temporary, absolute);
    const published = await observeNamedHeldFile(
      absolute,
      handle,
      created,
      {label: "UPDATED_FILE", bounds, expectedBytes: bytes},
    );
    await hooks.afterPublish?.();
    const verified = await observeNamedHeldFile(
      absolute,
      handle,
      created,
      {
        label: "UPDATED_FILE",
        bounds,
        expectedBytes: bytes,
        expectedMutable: published.mutable,
      },
    );
    await syncDirectory(dirname(absolute));
    await parent.assertReady();
    await observeNamedHeldFile(
      absolute,
      handle,
      created,
      {
        label: "UPDATED_FILE",
        bounds,
        expectedBytes: bytes,
        expectedMutable: verified.mutable,
      },
    );
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    await finishWithCleanup(primary, [
      async () => await handle?.close(),
      async () => await predecessor?.close(),
      async () => {
        if (created !== undefined) {
          await unlinkIfOwnedTemporary(temporary, created);
        }
      },
      async () => await parent.close(),
    ]);
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

function changed(label: string, detail: string): never {
  throw new LocalEvmError(
    `LOCAL_EVM_${label}_CHANGED`,
    `${label} ${detail}`,
  );
}

export function assertExpectedBasename(path: string, expected: string, label: string): void {
  if (basename(path) !== expected) {throw new LocalEvmError(`LOCAL_EVM_${label}_NAME_INVALID`, `${label} filename must be ${expected}`);}
}
