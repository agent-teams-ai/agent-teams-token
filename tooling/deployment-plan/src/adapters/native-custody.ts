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

export interface DarwinCustodyAliasEvidence {
  readonly aliasPath: string;
  readonly aliasCanonicalPath: string;
  readonly aliasIsSymbolicLink: boolean;
  readonly aliasUid: number;
  readonly targetIsDirectory: boolean;
  readonly targetIsSymbolicLink: boolean;
  readonly targetUid: number;
}

export interface CustodyCanonicalPathPolicy {
  readonly platform: string;
  readonly configuredPath: string;
  readonly canonicalPath: string;
  readonly darwinAlias?: DarwinCustodyAliasEvidence;
}

const DARWIN_ROOT_ALIASES = [
  { alias: "/var", target: "/private/var" },
  { alias: "/tmp", target: "/private/tmp" },
] as const;

export function acceptedCustodyCanonicalPath(
  policy: CustodyCanonicalPathPolicy,
): string | undefined {
  if (resolvePath(policy.configuredPath) !== policy.configuredPath) { return undefined; }
  if (policy.configuredPath === policy.canonicalPath) { return policy.canonicalPath; }
  if (policy.platform !== "darwin") { return undefined; }
  const mapping = DARWIN_ROOT_ALIASES.find(({ alias }) =>
    policy.configuredPath === alias || policy.configuredPath.startsWith(`${alias}/`));
  if (mapping === undefined) { return undefined; }
  const evidence = policy.darwinAlias;
  const expectedCanonical = `${mapping.target}${policy.configuredPath.slice(mapping.alias.length)}`;
  if (evidence === undefined
    || evidence.aliasPath !== mapping.alias
    || evidence.aliasCanonicalPath !== mapping.target
    || !evidence.aliasIsSymbolicLink
    || evidence.aliasUid !== 0
    || !evidence.targetIsDirectory
    || evidence.targetIsSymbolicLink
    || evidence.targetUid !== 0
    || policy.canonicalPath !== expectedCanonical) {
    return undefined;
  }
  return policy.canonicalPath;
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
  const acceptedCanonical = acceptedCustodyCanonicalPath({
    platform: process.platform,
    configuredPath,
    canonicalPath: canonical,
    darwinAlias: await darwinCustodyAliasEvidence(configuredPath),
  });
  if (acceptedCanonical === undefined) {
    fail("NO_REPLACE_CUSTODY_UNSAFE", "native helper temporary directory must be canonical");
  }
  await assertSafeCustodyAncestry(acceptedCanonical);
  const handle = await open(acceptedCanonical,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const held: HeldDirectory = {
      path: acceptedCanonical,
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

async function darwinCustodyAliasEvidence(
  configuredPath: string,
): Promise<DarwinCustodyAliasEvidence | undefined> {
  if (process.platform !== "darwin") { return undefined; }
  const mapping = DARWIN_ROOT_ALIASES.find(({ alias }) =>
    configuredPath === alias || configuredPath.startsWith(`${alias}/`));
  if (mapping === undefined) { return undefined; }
  const [alias, aliasCanonicalPath, target] = await Promise.all([
    lstat(mapping.alias),
    realpath(mapping.alias),
    lstat(mapping.target),
  ]);
  return {
    aliasPath: mapping.alias,
    aliasCanonicalPath,
    aliasIsSymbolicLink: alias.isSymbolicLink(),
    aliasUid: alias.uid,
    targetIsDirectory: target.isDirectory(),
    targetIsSymbolicLink: target.isSymbolicLink(),
    targetUid: target.uid,
  };
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
