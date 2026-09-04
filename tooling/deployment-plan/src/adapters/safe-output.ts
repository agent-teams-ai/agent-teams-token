import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fail } from "../domain/model.ts";

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface FileIdentity extends DirectoryIdentity {
  readonly ctimeMs: number;
  readonly size: number;
}

interface HeldLeaf { readonly handle: FileHandle; readonly identity: FileIdentity; readonly bytes: Uint8Array }

export interface PublishedOutputIdentity { readonly directoryDevice: string; readonly directoryInode: string }

export interface ClaimedOutputDirectory {
  readonly path: string;
  writeExclusive(name: string, bytes: Uint8Array): Promise<void>;
  /** Atomically exposes and durably syncs the prepared directory without READY. */
  publish(): Promise<string>;
  /** Commits READY only after the published directory is durably reachable. */
  finalizeReady(name: "READY", bytes: Uint8Array): Promise<void>;
  readCommitted(name: string): Promise<Uint8Array>; assertCommitted(): Promise<void>;
  publicationIdentity(): PublishedOutputIdentity; close(): Promise<void>;
}

export interface NoReplaceRenameRequest { readonly sourceParent: FileHandle; readonly source: FileHandle; readonly destinationParent: FileHandle; readonly sourceLeaf: string; readonly destinationLeaf: string }
export type NoReplaceDirectoryRename = (request: NoReplaceRenameRequest) => Promise<void>;

export interface OutputFaultInjection {
  readonly beforeStagingLeafOpen?: () => Promise<void>; readonly afterStagingLeafOpen?: () => Promise<void>;
  readonly afterStagingDirectoryCreate?: () => Promise<void>;
  readonly beforeStagingDirectorySync?: () => Promise<void>; readonly afterStagingDirectorySync?: () => Promise<void>;
  readonly beforePublishRename?: () => Promise<void>; readonly afterPublishRename?: () => Promise<void>;
  readonly beforeParentDirectorySync?: () => Promise<void>; readonly afterParentDirectorySync?: () => Promise<void>;
  readonly beforeFinalMarkerRename?: () => Promise<void>;
  readonly beforeFinalMarkerDirectorySync?: () => Promise<void>; readonly afterFinalMarkerDirectorySync?: () => Promise<void>;
  readonly beforeFinalIdentityCheck?: () => Promise<void>;
  readonly beforeCleanupQuarantineLeafCheck?: (path: string) => Promise<void>;
  readonly afterCleanupQuarantineAuthenticated?: (path: string) => Promise<void>;
  /** Replaces the parent fsync operation for deterministic failure injection. */
  readonly parentDirectorySync?: () => Promise<void>;
  /** Replaces the post-READY-rename directory fsync for deterministic tests. */
  readonly finalMarkerDirectorySync?: () => Promise<void>;
  /** Filesystem no-replace rename supplied by a pinned native helper. */
  readonly noReplaceDirectoryRename?: NoReplaceDirectoryRename;
}

export async function claimOwnedOutputDirectory(parent: string, bundleName: string,
  faultInjection: OutputFaultInjection = {}): Promise<ClaimedOutputDirectory> {
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
  let stagingHandle: FileHandle | undefined;
  try {
    await assertMissing(target);
    await mkdir(staging, { mode: 0o700 });
    const stagingMetadata = await lstat(staging);
    assertOwnedPrivateDirectory(stagingMetadata, "OUTPUT_TARGET_UNSAFE");
    stagingIdentity = identity(stagingMetadata);
    await faultInjection.afterStagingDirectoryCreate?.();
    stagingHandle = await openDirectory(staging);
    const openedStagingIdentity = identity(await stagingHandle.stat());
    assertSameIdentity(stagingMetadata, openedStagingIdentity, "OUTPUT_TARGET_SUBSTITUTED");
    const claimed = new LocalClaimedOutputDirectory({ parent, parentHandle, parentIdentity, staging,
      stagingHandle, stagingIdentity: openedStagingIdentity, target, faultInjection });
    await claimed.assertStagingStable();
    return claimed;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (stagingIdentity !== undefined) {
      try { await quarantineOwnedDirectory(parent, staging, stagingIdentity); }
      catch (cleanupError) { cleanupFailures.push(cleanupError); }
    }
    if (stagingHandle !== undefined) {
      try { await stagingHandle.close(); }
      catch (closeError) { cleanupFailures.push(closeError); }
    }
    try { await parentHandle.close(); }
    catch (closeError) { cleanupFailures.push(closeError); }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures], "output claim and evidence preservation failed", { cause: error },
      );
    }
    throw error;
  }
}

class LocalClaimedOutputDirectory implements ClaimedOutputDirectory {
  readonly path: string;
  private readonly parent: string; private readonly parentHandle: FileHandle;
  private readonly parentIdentity: DirectoryIdentity; private readonly stagingHandle: FileHandle;
  private readonly stagingIdentity: DirectoryIdentity; private readonly target: string;
  private readonly faultInjection: OutputFaultInjection;
  private readonly leaves = new Map<string, HeldLeaf>();
  private published = false;
  private stagingDisposed = false;
  private publishedTargetIdentity?: DirectoryIdentity;
  private closePromise?: Promise<void>;

  constructor(input: {
    readonly parent: string; readonly parentHandle: FileHandle;
    readonly parentIdentity: DirectoryIdentity; readonly staging: string;
    readonly stagingHandle: FileHandle; readonly stagingIdentity: DirectoryIdentity;
    readonly target: string; readonly faultInjection: OutputFaultInjection;
  }) {
    this.parent = input.parent; this.parentHandle = input.parentHandle;
    this.parentIdentity = input.parentIdentity; this.path = input.staging;
    this.stagingHandle = input.stagingHandle; this.stagingIdentity = input.stagingIdentity;
    this.target = input.target; this.faultInjection = input.faultInjection;
  }

  async writeExclusive(name: string, bytes: Uint8Array): Promise<void> {
    if (this.published) {
      fail("OUTPUT_ALREADY_PUBLISHED", "bundle is already published");
    }
    if (!/^[a-zA-Z0-9._-]+$/u.test(name)) {
      fail("OUTPUT_FILE_NAME_INVALID", "output file name is invalid");
    }
    if (name === "READY") {
      fail("OUTPUT_READY_PREMATURE", "READY is reserved for the final durability commit");
    }
    await this.assertStagingStable();
    await this.faultInjection.beforeStagingLeafOpen?.();
    const file = await open(join(this.path, name),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let fileIdentity: FileIdentity;
    let retained = false;
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
      this.leaves.set(name, { handle: file, identity: fileIdentity, bytes: Buffer.from(bytes) });
      retained = true;
    } finally {
      if (!retained) { await file.close(); }
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
    let renamed = false;
    try {
      await this.faultInjection.beforePublishRename?.();
      await this.assertStagingStable();
      await assertMissing(this.target);
      try {
        await noReplaceRename({ sourceParent: this.parentHandle, source: this.stagingHandle, destinationParent: this.parentHandle, sourceLeaf: basename(this.path), destinationLeaf: basename(this.target) });
      } catch (error) {
        if (nodeErrorCode(error) === "EEXIST") {fail("OUTPUT_TARGET_EXISTS", "output target already exists");}
        // A failed native invocation may have completed the atomic syscall
        // before losing its response. Preserve both pathnames from here on.
        renamed = true;
        this.stagingDisposed = true;
        throw error;
      }
      renamed = true;
      this.stagingDisposed = true;
      this.publishedTargetIdentity = this.stagingIdentity;
      await this.faultInjection.afterPublishRename?.();
      await this.assertParentStable();
      const publishedMetadata = await lstat(this.target);
      assertOwnedPrivateDirectory(publishedMetadata, "OUTPUT_PUBLISHED_SUBSTITUTED");
      if (this.publishedTargetIdentity !== undefined) {
        assertSameIdentity(publishedMetadata, this.publishedTargetIdentity, "OUTPUT_PUBLISHED_SUBSTITUTED");
      }
      await this.faultInjection.beforeParentDirectorySync?.();
      await (this.faultInjection.parentDirectorySync?.() ?? this.parentHandle.sync());
      await this.faultInjection.afterParentDirectorySync?.();
      this.published = true;
      return this.target;
    } catch (error) {
      if (renamed) {
        fail("OUTPUT_PUBLICATION_UNCERTAIN",
          "published directory durability or identity is uncertain; target preserved: " + errorMessage(error));
      }
      throw error;
    }
  }

  async finalizeReady(name: "READY", bytes: Uint8Array): Promise<void> {
    if (!this.published) {
      fail("OUTPUT_NOT_DURABLE", "READY cannot be committed before durable publication");
    }
    if (this.leaves.has(name)) {
      fail("OUTPUT_READY_EXISTS", "READY was already created");
    }
    const noReplaceRename = this.faultInjection.noReplaceDirectoryRename;
    if (noReplaceRename === undefined) {
      fail("OUTPUT_NO_REPLACE_UNAVAILABLE", "READY commit requires a native no-replace rename primitive");
    }
    await this.assertPublishedTreeUnchanged();
    const pendingName = `.READY.pending-${randomBytes(16).toString("hex")}`;
    const pending = join(this.target, pendingName);
    const ready = join(this.target, name);
    const file = await open(pending,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let pendingIdentity: FileIdentity;
    let retained = false;
    let markerMayBePublished = false;
    try {
      await file.chmod(0o600);
      await file.writeFile(bytes);
      await file.sync();
      pendingIdentity = fileIdentityOf(await file.stat());
      await this.stagingHandle.sync();
      await this.assertPublishedTreeUnchanged([...this.leaves.keys(), pendingName]);
      assertSameFileIdentity(await lstat(pending), pendingIdentity, "OUTPUT_READY_SUBSTITUTED");
      await this.faultInjection.beforeFinalMarkerRename?.();
      await this.assertPublishedTreeUnchanged([...this.leaves.keys(), pendingName]);
      try {
        await noReplaceRename({ sourceParent: this.stagingHandle, source: file, destinationParent: this.stagingHandle, sourceLeaf: pendingName, destinationLeaf: name });
      } catch (error) {
        if (nodeErrorCode(error) === "EEXIST") {
          fail("OUTPUT_READY_EXISTS", "READY was already created");
        }
        // The helper may have completed the atomic syscall before its result
        // became unavailable. From this point both target and READY are kept.
        markerMayBePublished = true;
        throw error;
      }
      markerMayBePublished = true;
      const readyMetadata = await lstat(ready);
      if (!readyMetadata.isFile() || readyMetadata.isSymbolicLink() || readyMetadata.nlink !== 1) {
        fail("OUTPUT_READY_SUBSTITUTED", "READY is not the committed regular file");
      }
      assertSameIdentity(readyMetadata, pendingIdentity, "OUTPUT_READY_SUBSTITUTED");
      if (readyMetadata.size !== pendingIdentity.size) {
        fail("OUTPUT_READY_SUBSTITUTED", "READY size changed during commit");
      }
      const readyIdentity = fileIdentityOf(readyMetadata);
      this.leaves.set(name, { handle: file, identity: readyIdentity, bytes: Buffer.from(bytes) });
      retained = true;
      await this.assertPublishedReady(bytes, readyIdentity);
      await this.faultInjection.beforeFinalMarkerDirectorySync?.();
      await (this.faultInjection.finalMarkerDirectorySync?.() ?? this.stagingHandle.sync());
      await this.faultInjection.afterFinalMarkerDirectorySync?.();
      await this.assertPublishedReady(bytes, readyIdentity);
    } catch (error) {
      if (!retained) { await file.close(); }
      if (markerMayBePublished) {
        fail("OUTPUT_PUBLICATION_UNCERTAIN",
          "READY durability is uncertain; target and READY preserved: " + errorMessage(error));
      }
      throw error;
    }
  }

  async assertStagingStable(): Promise<void> {
    await this.assertParentStable();
    await assertDirectoryIdentity(this.path, this.stagingIdentity, "OUTPUT_TARGET_SUBSTITUTED");
    assertSameIdentity(await this.stagingHandle.stat(), this.stagingIdentity, "OUTPUT_TARGET_SUBSTITUTED");
  }

  private async assertParentStable(): Promise<void> {
    await assertNoSymlinkComponents(this.parent);
    if (await realpath(this.parent) !== this.parent) {
      fail("OUTPUT_PARENT_SUBSTITUTED", "output parent path changed");
    }
    const metadata = await lstat(this.parent);
    assertOwnedPrivateDirectory(metadata, "OUTPUT_PARENT_SUBSTITUTED");
    assertSameIdentity(metadata, this.parentIdentity, "OUTPUT_PARENT_SUBSTITUTED");
    assertSameIdentity(await this.parentHandle.stat(), this.parentIdentity, "OUTPUT_PARENT_SUBSTITUTED");
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    await this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    let cleanupError: unknown;
    try {
      if (!this.published) {
        await this.cleanupStaging();
      }
    } catch (error) {
      cleanupError = error;
    }
    const closed = await Promise.allSettled([
      ...[...this.leaves.values()].map(({ handle }) => handle.close()),
      this.stagingHandle.close(), this.parentHandle.close(),
    ]);
    const closeFailures = closed
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (cleanupError !== undefined && closeFailures.length > 0) {
      throw new AggregateError(
        [cleanupError, ...closeFailures], "cleanup and handle closure failed", { cause: cleanupError },
      );
    }
    if (cleanupError !== undefined) { throw cleanupError; }
    if (closeFailures.length > 0) {
      throw new AggregateError(closeFailures, "one or more output handles failed to close");
    }
  }

  private async cleanupStaging(): Promise<void> {
    if (this.stagingDisposed) {
      // Once renamed, never pathname-delete or inspect for cleanup: identity
      // may have changed. An uncertain target is preserved for human recovery.
      return;
    }
    await this.assertStagingStable();
    await this.assertCleanupLeaves(this.path);
    const quarantine = join(this.parent, `.${randomBytes(16).toString("hex")}.cleanup`);
    await rename(this.path, quarantine);
    await assertDirectoryIdentity(quarantine, this.stagingIdentity, "OUTPUT_CLEANUP_SUBSTITUTED");
    await this.faultInjection.beforeCleanupQuarantineLeafCheck?.(quarantine);
    await this.assertCleanupLeaves(quarantine);
    await this.faultInjection.afterCleanupQuarantineAuthenticated?.(quarantine);
    // Node exposes no removal-at-a-held-directory-fd primitive. Preserve the
    // authenticated quarantine rather than cross another pathname boundary.
    await this.parentHandle.sync();
  }

  async readCommitted(name: string): Promise<Uint8Array> {
    this.assertFinalized();
    const held = this.leaves.get(name);
    if (held === undefined) { fail("OUTPUT_FILE_UNTRACKED", "output file is not tracked"); }
    await this.assertHeldLeaf(name, held);
    return Buffer.from(held.bytes);
  }

  async assertCommitted(): Promise<void> {
    this.assertFinalized();
    await this.faultInjection.beforeFinalIdentityCheck?.();
    for (const [name, held] of this.leaves) { await this.assertHeldLeaf(name, held); }
    await this.assertPublishedTreeUnchanged();
  }

  publicationIdentity(): PublishedOutputIdentity {
    this.assertFinalized();
    if (this.publishedTargetIdentity === undefined) { throw new Error("unreachable publication identity"); }
    return {
      directoryDevice: String(this.publishedTargetIdentity.dev),
      directoryInode: String(this.publishedTargetIdentity.ino),
    };
  }

  private assertFinalized(): void {
    if (!this.published || !this.leaves.has("READY")) {
      fail("OUTPUT_NOT_FINALIZED", "published output is not READY-finalized");
    }
  }

  private async assertPublishedTreeUnchanged(
    expectedNamesInput: readonly string[] = [...this.leaves.keys()],
  ): Promise<void> {
    if (this.publishedTargetIdentity === undefined) {
      fail("OUTPUT_PUBLISHED_SUBSTITUTED", "published output identity was not recorded");
    }
    const metadata = await lstat(this.target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) {
      fail("OUTPUT_PUBLISHED_SUBSTITUTED", "published output is not the owned directory that was created");
    }
    assertSameIdentity(metadata, this.publishedTargetIdentity, "OUTPUT_PUBLISHED_SUBSTITUTED");
    assertSameIdentity(await this.stagingHandle.stat(), this.publishedTargetIdentity, "OUTPUT_PUBLISHED_SUBSTITUTED");
    const names = (await readdir(this.target)).toSorted();
    const expectedNames = [...expectedNamesInput].toSorted();
    if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
      fail("OUTPUT_ROLLBACK_FOREIGN_ENTRY", "published output contains an untracked or foreign entry");
    }
    for (const [name, { identity: expected }] of this.leaves) {
      const leaf = await lstat(join(this.target, name));
      if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) {
        fail("OUTPUT_ROLLBACK_LEAF_SUBSTITUTED", "published output tracked leaf was substituted");
      }
      assertSameFileIdentity(leaf, expected, "OUTPUT_ROLLBACK_LEAF_SUBSTITUTED");
    }
    assertSameIdentity(await lstat(this.target), this.publishedTargetIdentity, "OUTPUT_PUBLISHED_SUBSTITUTED");
  }

  private async assertPublishedReady(bytes: Uint8Array, expected: FileIdentity): Promise<void> {
    await this.assertPublishedTreeUnchanged();
    const ready = await open(join(this.target, "READY"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const beforeRead = await ready.stat();
      if (!beforeRead.isFile() || beforeRead.nlink !== 1) {
        fail("OUTPUT_READY_SUBSTITUTED", "READY is not the committed regular file"); }
      assertSameFileIdentity(beforeRead, expected, "OUTPUT_READY_SUBSTITUTED");
      const actual = await ready.readFile();
      assertSameFileIdentity(await ready.stat(), expected, "OUTPUT_READY_SUBSTITUTED");
      await this.assertPublishedTreeUnchanged();
      if (!actual.equals(Buffer.from(bytes))) {
        fail("OUTPUT_READY_SUBSTITUTED", "READY bytes differ from the committed marker"); }
    } finally {
      await ready.close();
    }
  }

  private async assertHeldLeaf(name: string, held: HeldLeaf): Promise<void> {
    const before = await held.handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      fail("OUTPUT_FILE_SUBSTITUTED", "held output leaf is not an owned regular file"); }
    assertSameFileIdentity(before, held.identity, "OUTPUT_FILE_SUBSTITUTED");
    const actual = Buffer.alloc(held.identity.size);
    const { bytesRead } = await held.handle.read(actual, 0, actual.length, 0);
    assertSameFileIdentity(await held.handle.stat(), held.identity, "OUTPUT_FILE_SUBSTITUTED");
    if (bytesRead !== actual.length || !actual.equals(Buffer.from(held.bytes))) {
      fail("OUTPUT_CONTENT_SUBSTITUTED", "held output bytes changed"); }
  }

  private async assertCleanupLeaves(directory: string): Promise<void> {
    const names = (await readdir(directory)).toSorted();
    const expectedNames = [...this.leaves.keys()].toSorted();
    if (names.length !== expectedNames.length
      || names.some((name, index) => name !== expectedNames[index])) {
      fail("OUTPUT_CLEANUP_FOREIGN_ENTRY", "cleanup directory contains a foreign entry");
    }
    for (const [name, { identity: expected }] of this.leaves) {
      const metadata = await lstat(join(directory, name));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        fail("OUTPUT_CLEANUP_SUBSTITUTED", "cleanup leaf was substituted"); }
      assertSameFileIdentity(metadata, expected, "OUTPUT_CLEANUP_SUBSTITUTED");
    }
  }
}

async function quarantineOwnedDirectory(
  parent: string, staging: string, expected: DirectoryIdentity,
): Promise<void> {
  const quarantine = join(parent, `.${randomBytes(16).toString("hex")}.cleanup`);
  await assertDirectoryIdentity(staging, expected, "OUTPUT_CLEANUP_SUBSTITUTED");
  await rename(staging, quarantine);
  await assertDirectoryIdentity(quarantine, expected, "OUTPUT_CLEANUP_SUBSTITUTED");
}

async function assertDirectoryIdentity(
  path: string, expected: DirectoryIdentity, code: string,
): Promise<void> {
  await assertNoSymlinkComponents(path);
  const metadata = await lstat(path);
  assertOwnedPrivateDirectory(metadata, code);
  assertSameIdentity(metadata, expected, code);
  if (await realpath(path) !== path) { fail(code, "output directory path changed"); }
}

function assertNormalizedAbsolute(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail("OUTPUT_PATH_INVALID", "output parent must be a normalized absolute path"); }
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      fail("OUTPUT_PATH_SYMLINK", "output path contains a symbolic link"); }
  }
}

function assertOwnedPrivateDirectory(metadata: Stats, code: string): void {
  const expectedUid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1
    || expectedUid === undefined || metadata.uid !== expectedUid || (metadata.mode & 0o777) !== 0o700) {
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
    if (nodeErrorCode(error) === "ENOENT") { return; }
    throw error;
  }
  fail("OUTPUT_TARGET_EXISTS", "output target already exists");
}

function fileIdentityOf(metadata: Stats): FileIdentity {
  return { ...identity(metadata), ctimeMs: metadata.ctimeMs, size: metadata.size };
}

function assertSameFileIdentity(actual: Stats, expected: FileIdentity, code: string): void {
  assertSameIdentity(actual, expected, code);
  if (actual.ctimeMs !== expected.ctimeMs || actual.size !== expected.size) {
    fail(code, "filesystem file identity changed"); }
}

function identity(metadata: Stats): DirectoryIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function assertSameIdentity(
  metadata: Pick<Stats, "dev" | "ino">, expected: DirectoryIdentity, code: string,
): void {
  if (metadata.dev !== expected.dev || metadata.ino !== expected.ino) {
    fail(code, "output directory identity changed"); }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
