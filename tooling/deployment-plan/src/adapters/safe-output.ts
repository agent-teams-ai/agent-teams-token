import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fail } from "../domain/model.ts";

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface ClaimedOutputDirectory {
  /** The unguessable, unpublished staging directory. */
  readonly path: string;
  writeExclusive(name: string, bytes: Uint8Array): Promise<void>;
  /** Atomically exposes the complete staging directory at the requested name. */
  publish(): Promise<string>;
  close(): Promise<void>;
}

export interface OutputFaultInjection {
  readonly beforeStagingLeafOpen?: () => Promise<void>;
  readonly afterStagingLeafOpen?: () => Promise<void>;
  readonly beforePublishRename?: () => Promise<void>;
  readonly afterPublishRename?: () => Promise<void>;
}

export async function claimOwnedOutputDirectory(
  parent: string,
  bundleName: string,
  faultInjection: OutputFaultInjection = {},
): Promise<ClaimedOutputDirectory> {
  assertNormalizedAbsolute(parent);
  if (!/^[a-zA-Z0-9._-]+$/u.test(bundleName)) {
    fail("OUTPUT_FILE_NAME_INVALID", "output bundle name is invalid");
  }
  await assertNoSymlinkComponents(parent);
  const parentMetadata = await lstat(parent);
  assertOwnedPrivateDirectory(parentMetadata, "OUTPUT_PARENT_UNSAFE");
  if (await realpath(parent) !== parent) {
    fail("OUTPUT_PARENT_UNSAFE", "output parent must use its canonical path");
  }

  const parentHandle = await openDirectory(parent);
  const parentIdentity = identity(await parentHandle.stat());
  assertSameIdentity(parentMetadata, parentIdentity, "OUTPUT_PARENT_SUBSTITUTED");
  const target = join(parent, bundleName);
  const staging = join(parent, `.${bundleName}.staging-${randomBytes(16).toString("hex")}`);
  try {
    await assertMissing(target);
    await mkdir(staging, { mode: 0o700 });
    const stagingMetadata = await lstat(staging);
    assertOwnedPrivateDirectory(stagingMetadata, "OUTPUT_TARGET_UNSAFE");
    const stagingHandle = await openDirectory(staging);
    const stagingIdentity = identity(await stagingHandle.stat());
    assertSameIdentity(stagingMetadata, stagingIdentity, "OUTPUT_TARGET_SUBSTITUTED");
    const claimed = new LocalClaimedOutputDirectory({
      parent, parentHandle, parentIdentity, staging, stagingHandle,
      stagingIdentity, target, faultInjection,
    });
    await claimed.assertStagingStable();
    return claimed;
  } catch (error) {
    await parentHandle.close().catch(() => {});
    throw error;
  }
}

class LocalClaimedOutputDirectory implements ClaimedOutputDirectory {
  readonly path: string;
  private readonly parent: string;
  private readonly parentHandle: FileHandle;
  private readonly parentIdentity: DirectoryIdentity;
  private readonly stagingHandle: FileHandle;
  private readonly stagingIdentity: DirectoryIdentity;
  private readonly target: string;
  private readonly faultInjection: OutputFaultInjection;
  private published = false;

  constructor(input: {
    readonly parent: string;
    readonly parentHandle: FileHandle;
    readonly parentIdentity: DirectoryIdentity;
    readonly staging: string;
    readonly stagingHandle: FileHandle;
    readonly stagingIdentity: DirectoryIdentity;
    readonly target: string;
    readonly faultInjection: OutputFaultInjection;
  }) {
    this.parent = input.parent;
    this.parentHandle = input.parentHandle;
    this.parentIdentity = input.parentIdentity;
    this.path = input.staging;
    this.stagingHandle = input.stagingHandle;
    this.stagingIdentity = input.stagingIdentity;
    this.target = input.target;
    this.faultInjection = input.faultInjection;
  }

  async writeExclusive(name: string, bytes: Uint8Array): Promise<void> {
    if (this.published) {
      fail("OUTPUT_ALREADY_PUBLISHED", "bundle is already published");
    }
    if (!/^[a-zA-Z0-9._-]+$/u.test(name)) {
      fail("OUTPUT_FILE_NAME_INVALID", "output file name is invalid");
    }
    await this.assertStagingStable();
    await this.faultInjection.beforeStagingLeafOpen?.();
    const file = await open(
      join(this.path, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let fileIdentity: DirectoryIdentity;
    try {
      fileIdentity = identity(await file.stat());
      await this.faultInjection.afterStagingLeafOpen?.();
      await file.chmod(0o600);
      await file.writeFile(bytes);
      await file.sync();
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) {
        fail("OUTPUT_FILE_UNSAFE", "output file is not an owned regular file");
      }
    } finally {
      await file.close();
    }
    // A swap or ABA around the pathname open can only write elsewhere: the
    // held staging identity must still contain the complete bundle before it
    // can ever be atomically exposed.
    await this.assertStagingStable();
    const leaf = await lstat(join(this.path, name));
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) {
      fail("OUTPUT_FILE_SUBSTITUTED", "staging file was substituted");
    }
    assertSameIdentity(leaf, fileIdentity, "OUTPUT_FILE_SUBSTITUTED");
  }

  async publish(): Promise<string> {
    if (this.published) {
      fail("OUTPUT_ALREADY_PUBLISHED", "bundle is already published");
    }
    await this.assertStagingStable();
    await assertMissing(this.target);
    await this.faultInjection.beforePublishRename?.();
    await rename(this.path, this.target);
    this.published = true;
    await this.faultInjection.afterPublishRename?.();
    await this.assertParentStable();
    await assertDirectoryIdentity(this.target, this.stagingIdentity, "OUTPUT_PUBLISHED_SUBSTITUTED");
    assertSameIdentity(
      await this.stagingHandle.stat(), this.stagingIdentity, "OUTPUT_PUBLISHED_SUBSTITUTED",
    );
    return this.target;
  }

  async assertStagingStable(): Promise<void> {
    await this.assertParentStable();
    await assertDirectoryIdentity(this.path, this.stagingIdentity, "OUTPUT_TARGET_SUBSTITUTED");
    assertSameIdentity(
      await this.stagingHandle.stat(), this.stagingIdentity, "OUTPUT_TARGET_SUBSTITUTED",
    );
  }

  private async assertParentStable(): Promise<void> {
    await assertNoSymlinkComponents(this.parent);
    if (await realpath(this.parent) !== this.parent) {
      fail("OUTPUT_PARENT_SUBSTITUTED", "output parent path changed");
    }
    const metadata = await lstat(this.parent);
    assertOwnedPrivateDirectory(metadata, "OUTPUT_PARENT_SUBSTITUTED");
    assertSameIdentity(metadata, this.parentIdentity, "OUTPUT_PARENT_SUBSTITUTED");
    assertSameIdentity(
      await this.parentHandle.stat(), this.parentIdentity, "OUTPUT_PARENT_SUBSTITUTED",
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.stagingHandle.close(), this.parentHandle.close()]);
  }
}

async function assertDirectoryIdentity(
  path: string,
  expected: DirectoryIdentity,
  code: string,
): Promise<void> {
  await assertNoSymlinkComponents(path);
  const metadata = await lstat(path);
  assertOwnedPrivateDirectory(metadata, code);
  assertSameIdentity(metadata, expected, code);
  if (await realpath(path) !== path) {
    fail(code, "output directory path changed");
  }
}

function assertNormalizedAbsolute(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail("OUTPUT_PATH_INVALID", "output parent must be a normalized absolute path");
  }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      fail("OUTPUT_PATH_SYMLINK", "output path contains a symbolic link");
    }
  }
}

function assertOwnedPrivateDirectory(metadata: Stats, code: string): void {
  const expectedUid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1
    || expectedUid === undefined || metadata.uid !== expectedUid
    || (metadata.mode & 0o777) !== 0o700) {
    fail(code, "output directory must be owned by this user with mode 0700");
  }
}

async function openDirectory(path: string): Promise<FileHandle> {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  fail("OUTPUT_TARGET_EXISTS", "output target already exists");
}

function identity(metadata: Stats): DirectoryIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function assertSameIdentity(
  metadata: Pick<Stats, "dev" | "ino">,
  expected: DirectoryIdentity,
  code: string,
): void {
  if (metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
    fail(code, "output directory identity changed");
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code) : undefined;
}
