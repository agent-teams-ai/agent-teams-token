import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, resolve as resolvePath } from "node:path";
import { fail } from "../domain/model.ts";

export interface CustodyAncestorMetadata {
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly uid: number;
  readonly mode: number;
}

export interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface HeldDirectory {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: DirectoryIdentity;
}

export function isCustodyAncestorSafe(
  metadata: CustodyAncestorMetadata,
  expectedUid?: number,
): boolean {
  if (!metadata.isDirectory || metadata.isSymbolicLink || expectedUid === undefined) { return false; }
  const rootOwned = metadata.uid === 0;
  const rootProtected = rootOwned
    && ((metadata.mode & 0o022) === 0 || (metadata.mode & 0o1000) !== 0);
  const callerPrivate = metadata.uid === expectedUid && (metadata.mode & 0o022) === 0;
  return rootProtected || callerPrivate;
}

export async function holdSafeCustodyParent(configuredPath: string): Promise<HeldDirectory> {
  if (!isAbsolute(configuredPath)) {
    fail("NO_REPLACE_CUSTODY_UNSAFE", "native helper temporary directory must be absolute");
  }
  const canonical = await realpath(configuredPath);
  if (resolvePath(configuredPath) !== canonical) {
    fail("NO_REPLACE_CUSTODY_UNSAFE", "native helper temporary directory must be canonical");
  }
  await assertSafeCustodyAncestry(canonical);
  const handle = await open(canonical,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const held: HeldDirectory = {
      path: canonical,
      handle,
      identity: directoryIdentity(await handle.stat()),
    };
    await assertHeldDirectoryAtPath(held, "NO_REPLACE_CUSTODY_UNSAFE");
    return held;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function assertSafeCustodyAncestry(path: string): Promise<void> {
  const expectedUid = process.getuid?.();
  const root = parse(path).root;
  const relative = path.slice(root.length).split("/").filter((part) => part !== "");
  let current = root;
  for (const part of ["", ...relative]) {
    if (part !== "") { current = join(current, part); }
    const metadata = await lstat(current);
    if (!isCustodyAncestorSafe({
      isDirectory: metadata.isDirectory(),
      isSymbolicLink: metadata.isSymbolicLink(),
      uid: metadata.uid,
      mode: metadata.mode,
    }, expectedUid)) {
      fail("NO_REPLACE_CUSTODY_UNSAFE",
        "native helper temporary ancestry permits cross-UID replacement");
    }
  }
}

export function directoryIdentity(metadata: Stats): DirectoryIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

export async function assertHeldDirectoryAtPath(
  directory: HeldDirectory,
  code: string,
): Promise<void> {
  const held = await directory.handle.stat();
  const atPath = await lstat(directory.path);
  if (!held.isDirectory() || !atPath.isDirectory() || atPath.isSymbolicLink()
    || held.dev !== directory.identity.dev || held.ino !== directory.identity.ino
    || atPath.dev !== directory.identity.dev || atPath.ino !== directory.identity.ino) {
    fail(code, "native helper custody parent identity changed");
  }
  await assertSafeCustodyAncestry(directory.path);
}
