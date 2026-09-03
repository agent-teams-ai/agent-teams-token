import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fail } from "../domain/model.ts";

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface FileIdentity extends DirectoryIdentity {
  readonly ctimeMs: number;
  readonly size: number;
}

export interface ClaimedOutputDirectory {
  /** The unguessable, unpublished staging directory. */
  readonly path: string;
  writeExclusive(name: string, bytes: Uint8Array): Promise<void>;
  /** Atomically exposes the complete staging directory at the requested name. */
  publish(): Promise<string>;
  close(): Promise<void>;
}

export type NoReplaceDirectoryRename = (source: string, target: string) => Promise<void>;

export interface OutputFaultInjection {
  readonly beforeStagingLeafOpen?: () => Promise<void>;
  readonly afterStagingLeafOpen?: () => Promise<void>;
  readonly afterStagingDirectoryCreate?: () => Promise<void>;
  readonly beforeStagingDirectorySync?: () => Promise<void>;
  readonly afterStagingDirectorySync?: () => Promise<void>;
  readonly beforePublishRename?: () => Promise<void>;
  readonly afterPublishRename?: () => Promise<void>;
  readonly beforeParentDirectorySync?: () => Promise<void>;
  readonly afterParentDirectorySync?: () => Promise<void>;
  /** Replaces the parent fsync operation for deterministic failure injection. */
  readonly parentDirectorySync?: () => Promise<void>;
  /** Directory no-replace rename supplied by a pinned native helper. */
  readonly noReplaceDirectoryRename?: NoReplaceDirectoryRename;
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
  if (/^\.staging-/iu.test(bundleName)) {
    fail("OUTPUT_FILE_NAME_INVALID", "staging names are reserved");
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
  let stagingIdentity: DirectoryIdentity | undefined;
  try {
    await assertMissing(target);
    await mkdir(staging, { mode: 0o700 });
    const stagingMetadata = await lstat(staging);
    assertOwnedPrivateDirectory(stagingMetadata, "OUTPUT_TARGET_UNSAFE");
    stagingIdentity = identity(stagingMetadata);
    await faultInjection.afterStagingDirectoryCreate?.();
    const stagingHandle = await openDirectory(staging);
    const openedStagingIdentity = identity(await stagingHandle.stat());
    assertSameIdentity(stagingMetadata, openedStagingIdentity, "OUTPUT_TARGET_SUBSTITUTED");
    const claimed = new LocalClaimedOutputDirectory({
      parent, parentHandle, parentIdentity, staging, stagingHandle,
      stagingIdentity: openedStagingIdentity, target, faultInjection,
    });
    await claimed.assertStagingStable();
    return claimed;
  } catch (error) {
    if (stagingIdentity !== undefined) {
      await removeEmptyOwnedDirectory(parent, staging, stagingIdentity).catch(() => {});
    }
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
  private readonly leaves = new Map<string, FileIdentity>();
  private published = false;
  private stagingDisposed = false;
  private publishedTargetIdentity?: DirectoryIdentity;

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
    let fileIdentity: FileIdentity;
    try {
      fileIdentity = fileIdentityOf(await file.stat());
      await this.faultInjection.afterStagingLeafOpen?.();
      await file.chmod(0o600);
      await file.writeFile(bytes);
      await file.sync();
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) {
        fail("OUTPUT_FILE_UNSAFE", "output file is not an owned regular file");
      }
      fileIdentity = fileIdentityOf(metadata);
      this.leaves.set(name, fileIdentity);
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
    assertSameFileIdentity(leaf, fileIdentity, "OUTPUT_FILE_SUBSTITUTED");
  }

  async publish(): Promise<string> {
    if (this.published) {
      fail("OUTPUT_ALREADY_PUBLISHED", "bundle is already published");
    }
    await this.assertStagingStable();
    const noReplaceRename = this.faultInjection.noReplaceDirectoryRename;
    if (noReplaceRename === undefined) {
      fail("OUTPUT_NO_REPLACE_UNAVAILABLE", "publication requires a native no-replace directory rename primitive");
    }
    await this.faultInjection.beforeStagingDirectorySync?.();
    await this.stagingHandle.sync();
    await this.faultInjection.afterStagingDirectorySync?.();
    try {
      await this.faultInjection.beforePublishRename?.();
      await this.assertStagingStable();
      await assertMissing(this.target);
      try {
        await noReplaceRename(this.path, this.target);
      } catch (error) {
        if (nodeErrorCode(error) === "EEXIST") {fail("OUTPUT_TARGET_EXISTS", "output target already exists");}
        throw error;
      }
      this.publishedTargetIdentity = identity(await lstat(this.target));
      this.stagingDisposed = true;
      await this.faultInjection.afterPublishRename?.();
      await this.assertParentStable();
      const publishedMetadata = await lstat(this.target);
      assertOwnedPrivateDirectory(publishedMetadata, "OUTPUT_PUBLISHED_SUBSTITUTED");
      if (this.publishedTargetIdentity !== undefined) {assertSameIdentity(publishedMetadata, this.publishedTargetIdentity, "OUTPUT_PUBLISHED_SUBSTITUTED");}
      await this.faultInjection.beforeParentDirectorySync?.();
      await (this.faultInjection.parentDirectorySync?.() ?? this.parentHandle.sync());
      await this.faultInjection.afterParentDirectorySync?.();
      this.published = true;
      return this.target;
    } catch (error) {
      try {
        await this.rollbackUndurablePublication();
      } catch (rollbackError) {
        throw rollbackError;
      }
      throw error;
    }
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
    let cleanupError: unknown;
    try {
      if (!this.published) {
        await this.cleanupStaging();
      }
    } catch (error) {
      cleanupError = error;
    }
    const closed = await Promise.allSettled([this.stagingHandle.close(), this.parentHandle.close()]);
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
    const closeFailure = closed.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (closeFailure !== undefined) {
      throw closeFailure.reason;
    }
  }

  private async rollbackUndurablePublication(): Promise<void> {
    await this.assertParentStable();
    if (this.publishedTargetIdentity === undefined) return;
    await this.assertPublishedTreeUnchanged();
    const expectedNames = [...this.leaves.keys()].toSorted();
    for (const name of expectedNames) await unlink(join(this.target, name));
    await rmdir(this.target);
    await this.parentHandle.sync().catch(() => {});
  }

  private async cleanupStaging(): Promise<void> {
    if (this.stagingDisposed) {
      // A post-rename failure has already consumed staging. Check that the
      // reserved target was not replaced; rollback may legitimately remove it.
      try {
        const targetMetadata = await lstat(this.target);
        if (this.publishedTargetIdentity !== undefined) {
          assertSameIdentity(targetMetadata, this.publishedTargetIdentity, "OUTPUT_PUBLISHED_SUBSTITUTED");
          await this.assertPublishedTreeUnchanged();
        }
      } catch (error) {
        if (nodeErrorCode(error) !== "ENOENT") {
          throw error;
        }
      }
      return;
    }
    await this.assertStagingStable();
    await this.assertCleanupLeaves(this.path);
    const quarantine = join(
      this.parent,
      `.${randomBytes(16).toString("hex")}.cleanup`,
    );
    await rename(this.path, quarantine);
    await assertDirectoryIdentity(
      quarantine,
      this.stagingIdentity,
      "OUTPUT_CLEANUP_SUBSTITUTED",
    );
    await this.assertCleanupLeaves(quarantine);
    for (const [name, expected] of this.leaves) {
      const leaf = join(quarantine, name);
      const quarantinedLeaf = join(
        quarantine,
        `.${randomBytes(16).toString("hex")}.cleanup-leaf`,
      );
      const metadata = await lstat(leaf);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        fail("OUTPUT_CLEANUP_SUBSTITUTED", "cleanup leaf was substituted");
      }
      assertSameFileIdentity(metadata, expected, "OUTPUT_CLEANUP_SUBSTITUTED");
      await rename(leaf, quarantinedLeaf);
      const moved = await lstat(quarantinedLeaf);
      assertSameIdentity(moved, expected, "OUTPUT_CLEANUP_SUBSTITUTED");
      if (moved.size !== expected.size) {
        fail("OUTPUT_CLEANUP_SUBSTITUTED", "cleanup leaf size changed");
      }
      await unlink(quarantinedLeaf);
    }
    await rmdir(quarantine);
    await this.parentHandle.sync();
  }

  private async assertPublishedTreeUnchanged(): Promise<void> {
    if (this.publishedTargetIdentity === undefined) {
      fail("OUTPUT_PUBLISHED_SUBSTITUTED", "published output identity was not recorded");
    }
    const metadata = await lstat(this.target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) {
      fail("OUTPUT_PUBLISHED_SUBSTITUTED", "published output is not the owned directory that was created");
    }
    assertSameIdentity(metadata, this.publishedTargetIdentity, "OUTPUT_PUBLISHED_SUBSTITUTED");
    const names = (await readdir(this.target)).toSorted();
    const expectedNames = [...this.leaves.keys()].toSorted();
    if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
      fail("OUTPUT_ROLLBACK_FOREIGN_ENTRY", "published output contains an untracked or foreign entry");
    }
    for (const [name, expected] of this.leaves) {
      const leaf = await lstat(join(this.target, name));
      if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) {
        fail("OUTPUT_ROLLBACK_LEAF_SUBSTITUTED", "published output tracked leaf was substituted");
      }
      assertSameFileIdentity(leaf, expected, "OUTPUT_ROLLBACK_LEAF_SUBSTITUTED");
    }
  }

  private async assertCleanupLeaves(directory: string): Promise<void> {
    const names = (await readdir(directory)).toSorted();
    const expectedNames = [...this.leaves.keys()].toSorted();
    if (
      names.length !== expectedNames.length
      || names.some((name, index) => name !== expectedNames[index])
    ) {
      fail("OUTPUT_CLEANUP_FOREIGN_ENTRY", "cleanup directory contains a foreign entry");
    }
    for (const [name, expected] of this.leaves) {
      const metadata = await lstat(join(directory, name));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        fail("OUTPUT_CLEANUP_SUBSTITUTED", "cleanup leaf was substituted");
      }
      assertSameFileIdentity(metadata, expected, "OUTPUT_CLEANUP_SUBSTITUTED");
    }
  }
}

async function removeEmptyOwnedDirectory(
  parent: string,
  staging: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const quarantine = join(parent, `.${randomBytes(16).toString("hex")}.cleanup`);
  await assertDirectoryIdentity(staging, expected, "OUTPUT_CLEANUP_SUBSTITUTED");
  await rename(staging, quarantine);
  await assertDirectoryIdentity(quarantine, expected, "OUTPUT_CLEANUP_SUBSTITUTED");
  await rmdir(quarantine);
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

function fileIdentityOf(metadata: Stats): FileIdentity {
  return { ...identity(metadata), ctimeMs: metadata.ctimeMs, size: metadata.size };
}

function assertSameFileIdentity(
  actual: Stats,
  expected: FileIdentity,
  code: string,
): void {
  assertSameIdentity(actual, expected, code);
  if (actual.ctimeMs !== expected.ctimeMs || actual.size !== expected.size) {
    fail(code, "filesystem file identity changed");
  }
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
