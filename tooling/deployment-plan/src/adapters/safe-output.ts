import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fail } from "../domain/model.ts";

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface ClaimedOutputDirectory {
  readonly path: string;
  writeExclusive(name: string, bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export async function claimOwnedOutputDirectory(
  parent: string,
  bundleName: string,
): Promise<ClaimedOutputDirectory> {
  assertNormalizedAbsolute(parent);
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
  try {
    await assertMissing(target);
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") {
        fail("OUTPUT_TARGET_EXISTS", "output target already exists");
      }
      throw error;
    }

    const targetMetadata = await lstat(target);
    assertOwnedPrivateDirectory(targetMetadata, "OUTPUT_TARGET_UNSAFE");
    const targetHandle = await openDirectory(target);
    const targetIdentity = identity(await targetHandle.stat());
    assertSameIdentity(targetMetadata, targetIdentity, "OUTPUT_TARGET_SUBSTITUTED");
    const claimed = new LocalClaimedOutputDirectory({
      parent,
      parentHandle,
      parentIdentity,
      target,
      targetHandle,
      targetIdentity,
    });
    await claimed.assertStable();
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
  private readonly targetHandle: FileHandle;
  private readonly targetIdentity: DirectoryIdentity;

  constructor(input: {
    readonly parent: string;
    readonly parentHandle: FileHandle;
    readonly parentIdentity: DirectoryIdentity;
    readonly target: string;
    readonly targetHandle: FileHandle;
    readonly targetIdentity: DirectoryIdentity;
  }) {
    this.parent = input.parent;
    this.parentHandle = input.parentHandle;
    this.parentIdentity = input.parentIdentity;
    this.path = input.target;
    this.targetHandle = input.targetHandle;
    this.targetIdentity = input.targetIdentity;
  }

  async writeExclusive(name: string, bytes: Uint8Array): Promise<void> {
    if (!/^[a-zA-Z0-9._-]+$/u.test(name)) {
      fail("OUTPUT_FILE_NAME_INVALID", "output file name is invalid");
    }
    await this.assertStable();
    const path = join(this.path, name);
    const file = await open(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o600,
    );
    try {
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
    await this.assertStable();
  }

  async assertStable(): Promise<void> {
    await assertNoSymlinkComponents(this.parent);
    if (await realpath(this.parent) !== this.parent) {
      fail("OUTPUT_PARENT_SUBSTITUTED", "output parent path changed");
    }
    const parentPathMetadata = await lstat(this.parent);
    assertOwnedPrivateDirectory(parentPathMetadata, "OUTPUT_PARENT_SUBSTITUTED");
    assertSameIdentity(
      parentPathMetadata,
      this.parentIdentity,
      "OUTPUT_PARENT_SUBSTITUTED",
    );
    assertSameIdentity(
      await this.parentHandle.stat(),
      this.parentIdentity,
      "OUTPUT_PARENT_SUBSTITUTED",
    );

    await assertNoSymlinkComponents(this.path);
    if (await realpath(this.path) !== this.path) {
      fail("OUTPUT_TARGET_SUBSTITUTED", "output target path changed");
    }
    const targetPathMetadata = await lstat(this.path);
    assertOwnedPrivateDirectory(targetPathMetadata, "OUTPUT_TARGET_SUBSTITUTED");
    assertSameIdentity(
      targetPathMetadata,
      this.targetIdentity,
      "OUTPUT_TARGET_SUBSTITUTED",
    );
    assertSameIdentity(
      await this.targetHandle.stat(),
      this.targetIdentity,
      "OUTPUT_TARGET_SUBSTITUTED",
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.targetHandle.close(),
      this.parentHandle.close(),
    ]);
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
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.nlink < 1
    || expectedUid === undefined
    || metadata.uid !== expectedUid
    || (metadata.mode & 0o777) !== 0o700
  ) {
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
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}
