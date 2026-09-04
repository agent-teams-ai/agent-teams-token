import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { sha256Hex } from "../domain/identity.ts";
import { fail } from "../domain/model.ts";
import {
  assertHeldDirectoryAtPath,
  assertSafeCustodyAncestry,
  type HeldDirectory,
} from "./native-custody.ts";

export interface ExecutableIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly sha256: `0x${string}`;
}

export interface ExecutableCustodyMetadata {
  readonly isFile: boolean;
  readonly uid: number;
  readonly nlink: number;
  readonly mode: number;
}

export interface ExecutableCustodyPolicy {
  readonly expectedUid: number | undefined;
  readonly allowRootOwnedMultipleLinks: boolean;
}

export interface HeldExecutable {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: ExecutableIdentity;
  readonly allowRootOwnedMultipleLinks: boolean;
  readonly parentBinding?: HeldDirectory;
}

export async function snapshotExecutable(
  original: FileHandle,
  expected: ExecutableIdentity,
  custody: string,
  name: string,
  code: string,
): Promise<HeldExecutable> {
  const bytes = await readHeldBytes(original, expected.size);
  assertSameExecutable(await heldExecutableIdentity(original, code, true), expected, code);
  const path = join(custody, name);
  const snapshot = await open(path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
  try {
    await snapshot.writeFile(bytes);
    await snapshot.sync();
    await snapshot.chmod(0o500);
    const identity = await heldExecutableIdentity(snapshot, code);
    if (identity.sha256 !== expected.sha256 || identity.size !== expected.size) {
      fail(code, "native executable snapshot differs from held source bytes");
    }
    assertSameExecutable(await executableIdentityAtPath(path, code), identity, code);
    await snapshot.close();
    return await openHeldExecutable(path, code);
  } catch (error) {
    await snapshot.close().catch(() => {});
    throw error;
  }
}

export async function openHeldExecutable(
  path: string,
  code: string,
  parentBinding?: HeldDirectory,
): Promise<HeldExecutable> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await heldExecutableIdentity(handle, code);
    assertSameExecutable(await executableIdentityAtPath(path, code), identity, code);
    if (parentBinding !== undefined) { await assertHeldDirectoryAtPath(parentBinding, code); }
    return { path, handle, identity, allowRootOwnedMultipleLinks: false, parentBinding };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function assertTrustedCompilerPath(path: string): Promise<void> {
  let current = dirname(path);
  const root = parse(path).root;
  for (;;) {
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0
      || (metadata.mode & 0o022) !== 0) {
      fail("NO_REPLACE_COMPILER_UNSAFE", "compiler ancestor chain must be root-owned and non-writable");
    }
    if (current === root) { break; }
    current = dirname(current);
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== 0
    || (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o111) === 0) {
    fail("NO_REPLACE_COMPILER_UNSAFE", "compiler must be a root-owned non-writable executable");
  }
}

export async function assertExecutableReady(executable: HeldExecutable): Promise<void> {
  if (executable.parentBinding !== undefined) {
    await assertHeldDirectoryAtPath(executable.parentBinding, "NO_REPLACE_EXECUTABLE_SUBSTITUTED");
  }
  assertSameExecutableObject(
    await heldExecutableIdentity(executable.handle, "NO_REPLACE_EXECUTABLE_SUBSTITUTED",
      executable.allowRootOwnedMultipleLinks),
    executable.identity,
    "NO_REPLACE_EXECUTABLE_SUBSTITUTED",
  );
  if (process.platform === "darwin") {
    await assertSafeCustodyAncestry(dirname(executable.path));
    assertSameExecutable(
      await executableIdentityAtPath(executable.path, "NO_REPLACE_EXECUTABLE_SUBSTITUTED",
        executable.allowRootOwnedMultipleLinks),
      executable.identity,
      "NO_REPLACE_EXECUTABLE_SUBSTITUTED",
    );
  }
}

export function assertSameExecutableObject(
  actual: ExecutableIdentity,
  expected: ExecutableIdentity,
  code: string,
): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    fail(code, "held native executable object or bytes changed");
  }
}

export function assertLeaf(leaf: string): void {
  if (leaf === "" || leaf === "." || leaf === ".." || leaf.includes("/")
    || leaf.includes("\0") || Buffer.byteLength(leaf) > 255) {
    fail("NO_REPLACE_LEAF_INVALID", "no-replace ABI requires a valid single-component leaf");
  }
}

export function isExecutableCustodySafe(
  metadata: ExecutableCustodyMetadata,
  policy: ExecutableCustodyPolicy,
): boolean {
  const ownedByCaller = policy.expectedUid !== undefined && metadata.uid === policy.expectedUid;
  const rootOwned = metadata.uid === 0;
  const linkCountSafe = metadata.nlink === 1
    || (policy.allowRootOwnedMultipleLinks && rootOwned && metadata.nlink > 1);
  return policy.expectedUid !== undefined && metadata.isFile && linkCountSafe
    && (ownedByCaller || rootOwned) && (metadata.mode & 0o022) === 0
    && (metadata.mode & constants.S_IXUSR) !== 0;
}

async function executableIdentityAtPath(path: string, code: string,
  allowRootOwnedMultipleLinks = false): Promise<ExecutableIdentity> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await heldExecutableIdentity(file, code, allowRootOwnedMultipleLinks); }
  finally { await file.close(); }
}

export async function heldExecutableIdentity(
  file: FileHandle,
  code: string,
  allowRootOwnedMultipleLinks = false,
): Promise<ExecutableIdentity> {
  const before = await file.stat();
  if (!isExecutableCustodySafe({ isFile: before.isFile(), uid: before.uid,
    nlink: before.nlink, mode: before.mode }, {
    expectedUid: process.getuid?.(), allowRootOwnedMultipleLinks,
  })) {
    fail(code, "native executable identity or custody is unsafe");
  }
  const bytes = await readHeldBytes(file, before.size);
  const after = await file.stat();
  assertStableMetadata(after, before, code);
  return { dev: after.dev, ino: after.ino, ctimeMs: after.ctimeMs,
    size: after.size, sha256: sha256Hex(bytes) };
}

export async function readHeldBytes(file: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await file.read(bytes, offset, size - offset, offset);
    if (read.bytesRead === 0) {
      fail("NO_REPLACE_EXECUTABLE_UNSAFE", "held file became shorter while it was read");
    }
    offset += read.bytesRead;
  }
  return bytes;
}

export function assertStableMetadata(actual: Stats, expected: Stats, code: string): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.ctimeMs !== expected.ctimeMs || actual.size !== expected.size) {
    fail(code, "held filesystem object changed while it was read");
  }
}

function assertSameExecutable(
  actual: ExecutableIdentity,
  expected: ExecutableIdentity,
  code: string,
): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.ctimeMs !== expected.ctimeMs || actual.size !== expected.size
    || actual.sha256 !== expected.sha256) {
    fail(code, "native executable changed after identity verification");
  }
}

export function assertPrivateCustodyDirectory(metadata: Stats, code: string): void {
  const expectedUid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || expectedUid === undefined
    || metadata.uid !== expectedUid || (metadata.mode & 0o777) !== 0o700) {
    fail(code, "native helper custody is not an owned private directory");
  }
}

export async function closePreservingEvidence(
  preserve: () => Promise<void> | undefined,
  handles: readonly (FileHandle | HeldExecutable | HeldDirectory | undefined)[],
): Promise<void> {
  let preservationError: unknown;
  try { await preserve(); } catch (error) { preservationError = error; }
  const closures = await Promise.allSettled(handles.map((item) =>
    (item !== undefined && "handle" in item ? item.handle : item)?.close()));
  const closeErrors = closures.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  ).map((result) => result.reason);
  if (preservationError !== undefined || closeErrors.length > 0) {
    throw new AggregateError(
      [...(preservationError === undefined ? [] : [preservationError]), ...closeErrors],
      "native helper evidence preservation and descriptor closure failed",
      { cause: preservationError ?? closeErrors[0] },
    );
  }
}
