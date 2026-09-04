import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import type { NoReplaceDirectoryRename, NoReplaceRenameRequest } from "./safe-output.ts";
import { canonicalJson, sha256Hex } from "../domain/identity.ts";
import type { NativeNoReplaceEvidence, NativeNoReplaceEvidenceFields } from "../application/ports.ts";
import { fail } from "../domain/model.ts";
import {
  assertHeldDirectoryAtPath,
  assertSafeCustodyAncestry,
  directoryIdentity,
  holdSafeCustodyParent,
  type HeldDirectory,
} from "./native-custody.ts";
import { ChildExitError, runBoundChild } from "./native-custody-process.ts";
import { loadCommittedNativeNoReplacePolicy } from "./native-policy.ts";
export { isCustodyAncestorSafe } from "./native-custody.ts";
export { processGroupHasLiveMembersFromPs } from "./native-custody-process.ts";

const APPROVAL_DOMAIN = "AGTMAI_NATIVE_NO_REPLACE_APPROVAL_V1\0";
const SOURCE = fileURLToPath(new URL("../../native/no-replace.c", import.meta.url));
const COMPILER_TIMEOUT_MS = 30_000;
const HELPER_TIMEOUT_MS = 5_000;
const TERM_GRACE_MS = 1_000;
const GROUP_REAP_MS = 2_000;

interface ExecutableIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly sha256: `0x${string}`;
}

export interface NativeNoReplaceFaultInjection {
  readonly sourcePath?: string;
  readonly temporaryDirectory?: string;
  readonly afterSourceRead?: (source: string) => Promise<void>;
  readonly afterCompilerSnapshot?: (snapshot: string, original: string) => Promise<void>;
  readonly beforeCompilerSpawn?: (snapshot: string) => Promise<void>;
  readonly beforeHelperSpawn?: (snapshot: string) => Promise<void>;
  readonly beforeCleanup?: (custody: string) => Promise<void>;
  readonly afterBuildFailureBeforeCleanup?: (custody: string) => Promise<void>;
  readonly compilerTimeoutMs?: number;
  readonly helperTimeoutMs?: number;
  readonly termGraceMs?: number;
  readonly groupReapMs?: number;
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

export interface NativeNoReplaceCapability {
  readonly rename: NoReplaceDirectoryRename;
  readonly executableSha256: `0x${string}`;
  readonly compilerSha256: `0x${string}`;
  readonly platform: "darwin-arm64" | "linux-x64";
  readonly sourcePath: "tooling/deployment-plan/native/no-replace.c";
  readonly sourceSha256: `0x${string}`;
  readonly compileProfile: "c11-o2-werror-stdin-v1";
  readonly strategy: "snapshot-fd" | "verified-path";
  readonly compilerPath: string;
  readonly approvalSha256: `0x${string}`;
  readonly evidence: NativeNoReplaceEvidence;
  readonly custodyPath: string;
  close(): Promise<void>;
}

export function assertNativeNoReplacePlatform(platform: string): void {
  if (platform !== "linux" && platform !== "darwin") {
    fail("OUTPUT_NO_REPLACE_UNAVAILABLE", "native no-replace helper supports only Linux and macOS"); }
}

export function nativeCompilerExecutionStrategy(platform: string): "snapshot-fd" | "verified-path" {
  assertNativeNoReplacePlatform(platform);
  return platform === "linux" ? "snapshot-fd" : "verified-path";
}

/**
 * Builds a descriptor-bound no-replace capability. This hardens ordinary
 * filesystem races; malicious concurrent code running as the same UID remains
 * outside the trust boundary and can interfere with this process and its FDs.
 */
export async function createNativeNoReplaceCapability(
  faultInjection: NativeNoReplaceFaultInjection = {},
): Promise<NativeNoReplaceCapability> {
  assertNativeNoReplacePlatform(process.platform);
  const policy = await loadCommittedNativeNoReplacePolicy();
  const platform = nativePlatformKey(process.platform);
  const platformPolicy = policy.platforms[platform];
  const sourcePath = faultInjection.sourcePath ?? SOURCE;
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let compilerOriginal: FileHandle | undefined;
  let compilerExecutable: HeldExecutable | undefined;
  let helper: HeldExecutable | undefined;
  let custodyHandle: FileHandle | undefined;
  let custodyParent: HeldDirectory | undefined;
  let custodyDirectory: HeldDirectory | undefined;
  let custody = "";
  try {
    const sourceBefore = await source.stat();
    if (!sourceBefore.isFile() || sourceBefore.nlink !== 1) { fail("NO_REPLACE_SOURCE_MISMATCH", "native helper source is not a single-link regular file"); }
    const sourceBytes = await readHeldBytes(source, sourceBefore.size);
    assertStableMetadata(await source.stat(), sourceBefore, "NO_REPLACE_SOURCE_MISMATCH");
    if (sha256Hex(sourceBytes) !== policy.sourceSha256) { fail("NO_REPLACE_SOURCE_MISMATCH", "native no-replace helper source differs from its pinned digest"); }
    await faultInjection.afterSourceRead?.(sourcePath);

    const configuredCompiler = process.env.AGTMAI_CC_BINARY ?? "/usr/bin/cc";
    if (!isAbsolute(configuredCompiler)) { fail("NO_REPLACE_COMPILER_UNSAFE", "AGTMAI_CC_BINARY must be an absolute path"); }
    const strategy = nativeCompilerExecutionStrategy(process.platform);
    if (strategy !== platformPolicy.strategy) { fail("NO_REPLACE_COMPILER_UNAPPROVED", "native compiler execution strategy is not approved"); }
    const compilerPath = await realpath(configuredCompiler);
    await assertTrustedCompilerPath(compilerPath);
    const allowTrustedCompilerMultipleLinks = true;
    compilerOriginal = await open(compilerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const compilerIdentity = await heldExecutableIdentity(
      compilerOriginal, "NO_REPLACE_COMPILER_UNSAFE", allowTrustedCompilerMultipleLinks,
    );
    const approvedCompilerTuples = platformPolicy.tuples.filter((tuple) =>
      tuple.compilerPath === compilerPath && tuple.compilerSha256 === compilerIdentity.sha256);
    if (approvedCompilerTuples.length === 0) {
      fail("NO_REPLACE_COMPILER_UNAPPROVED", "native compiler path and digest tuple is not approved");
    }
    custodyParent = await holdSafeCustodyParent(faultInjection.temporaryDirectory ?? tmpdir());
    custody = await realpath(await mkdtemp(join(custodyParent.path, "agtmai-no-replace-")));
    await assertHeldDirectoryAtPath(custodyParent, "NO_REPLACE_CUSTODY_UNSAFE");
    if (dirname(custody) !== custodyParent.path) {
      fail("NO_REPLACE_CUSTODY_UNSAFE", "native helper custody escaped its held parent");
    }
    await chmod(custody, 0o700);
    const custodyMetadata = await lstat(custody);
    assertPrivateCustodyDirectory(custodyMetadata, "NO_REPLACE_CUSTODY_UNSAFE");
    custodyHandle = await open(custody,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    custodyDirectory = {
      path: custody,
      handle: custodyHandle,
      identity: directoryIdentity(custodyMetadata),
    };

    if (strategy === "snapshot-fd") {
      compilerExecutable = await snapshotExecutable(
        compilerOriginal, compilerIdentity, custody, "compiler", "NO_REPLACE_COMPILER_UNSAFE",
      );
    } else {
      compilerExecutable = { path: compilerPath, handle: compilerOriginal, identity: compilerIdentity,
        allowRootOwnedMultipleLinks: allowTrustedCompilerMultipleLinks };
      compilerOriginal = undefined;
    }
    const heldCompiler = compilerExecutable;
    await faultInjection.afterCompilerSnapshot?.(heldCompiler.path, compilerPath);
    await faultInjection.beforeCompilerSpawn?.(heldCompiler.path);
    await assertHeldDirectoryAtPath(custodyParent, "NO_REPLACE_CUSTODY_UNSAFE");
    await assertHeldDirectoryAtPath(custodyDirectory, "NO_REPLACE_CUSTODY_UNSAFE");
    await runBoundChild({
      executable: heldCompiler,
      assertExecutableReady: () => assertExecutableReady(heldCompiler),
      executeThroughHeldDescriptor: strategy === "snapshot-fd",
      argv0: compilerPath,
      arguments: ["-x", "c", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
        "-o", join(custody, "no-replace"), "-"],
      stdin: sourceBytes,
      inherited: [],
      timeoutMs: faultInjection.compilerTimeoutMs ?? COMPILER_TIMEOUT_MS,
      termGraceMs: faultInjection.termGraceMs ?? TERM_GRACE_MS,
      groupReapMs: faultInjection.groupReapMs ?? GROUP_REAP_MS,
      code: "NO_REPLACE_BUILD_FAILED",
    });
    assertSameExecutableObject(
      await heldExecutableIdentity(
        compilerOriginal ?? compilerExecutable.handle, "NO_REPLACE_COMPILER_UNSAFE", allowTrustedCompilerMultipleLinks,
      ),
      compilerIdentity,
      "NO_REPLACE_COMPILER_SUBSTITUTED",
    );
    await chmod(join(custody, "no-replace"), 0o500);
    helper = await openHeldExecutable(
      join(custody, "no-replace"), "NO_REPLACE_EXECUTABLE_UNSAFE",
      custodyDirectory,
    );
    const approvedTuple = approvedCompilerTuples.find((tuple) => tuple.executableSha256 === helper?.identity.sha256);
    if (approvedTuple === undefined) {
      fail("NO_REPLACE_EXECUTABLE_UNAPPROVED", "native helper digest is not approved for this compiler tuple");
    }
    const evidenceFields: NativeNoReplaceEvidenceFields = {
      platform, sourcePath: policy.sourcePath, sourceSha256: policy.sourceSha256,
      compileProfile: policy.compileProfile, compilerExecution: strategy,
      compilerPath: approvedTuple.compilerPath, compilerSha256: approvedTuple.compilerSha256,
      executableSha256: approvedTuple.executableSha256,
    };
    const evidence: NativeNoReplaceEvidence = {
      schemaVersion: 1, kind: "native-no-replace-evidence", ...evidenceFields,
      approvalSha256: nativeNoReplaceApprovalSha256(evidenceFields),
    };

    let closed = false;
    const heldHelper = helper;
    const heldCustody = custodyHandle;
    return {
      platform, sourcePath: policy.sourcePath, sourceSha256: policy.sourceSha256,
      compileProfile: policy.compileProfile, strategy, compilerPath: approvedTuple.compilerPath,
      approvalSha256: evidence.approvalSha256, evidence,
      executableSha256: heldHelper.identity.sha256,
      compilerSha256: compilerIdentity.sha256,
      custodyPath: custody,
      async rename(request: NoReplaceRenameRequest): Promise<void> {
        if (closed) {
          fail("NO_REPLACE_CAPABILITY_CLOSED", "native no-replace capability is closed"); }
        assertLeaf(request.sourceLeaf);
        assertLeaf(request.destinationLeaf);
        await faultInjection.beforeHelperSpawn?.(heldHelper.path);
        try {
          await runBoundChild({
            executable: heldHelper,
            assertExecutableReady: () => assertExecutableReady(heldHelper),
            arguments: ["v1", request.sourceLeaf, request.destinationLeaf],
            inherited: [request.sourceParent, request.source, request.destinationParent],
            timeoutMs: faultInjection.helperTimeoutMs ?? HELPER_TIMEOUT_MS,
            termGraceMs: faultInjection.termGraceMs ?? TERM_GRACE_MS,
            groupReapMs: faultInjection.groupReapMs ?? GROUP_REAP_MS,
            code: "NO_REPLACE_FAILED",
          });
        } catch (error) {
          if (error instanceof ChildExitError && error.exitCode === 73) {
            const exists = new Error("target already exists") as NodeJS.ErrnoException;
            exists.code = "EEXIST";
            throw exists;
          }
          throw error;
        }
      },
      async close(): Promise<void> {
        if (closed) { return; }
        closed = true;
        await closePreservingEvidence(
          () => faultInjection.beforeCleanup?.(custody),
          [heldHelper.handle, compilerExecutable, compilerOriginal, source, heldCustody, custodyParent],
        );
        // Deliberately preserve the private custody directory and every leaf.
      },
    };
  } catch (error) {
    try {
      await closePreservingEvidence(
        () => custody === "" ? undefined : faultInjection.afterBuildFailureBeforeCleanup?.(custody),
        [helper, compilerExecutable, compilerOriginal, source, custodyHandle, custodyParent],
      );
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "native helper build failed; evidence was preserved but descriptor closure also failed",
        { cause: closeError },
      );
    }
    // Failure evidence is preserved. A pathname cleanup could delete a successor.
    throw error;
  }
}

export function nativeNoReplaceApprovalSha256(fields: NativeNoReplaceEvidenceFields): `0x${string}` {
  return sha256Hex(Buffer.concat([Buffer.from(APPROVAL_DOMAIN), Buffer.from(canonicalJson(fields))]));
}

export function nativePlatformKey(platform: string): "darwin-arm64" | "linux-x64" {
  assertNativeNoReplacePlatform(platform);
  return platform === "darwin" ? "darwin-arm64" : "linux-x64";
}

interface HeldExecutable {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: ExecutableIdentity;
  readonly allowRootOwnedMultipleLinks: boolean;
  readonly parentBinding?: HeldDirectory;
}

async function snapshotExecutable(
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

async function openHeldExecutable(
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

async function assertTrustedCompilerPath(path: string): Promise<void> {
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

async function assertExecutableReady(executable: HeldExecutable): Promise<void> {
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

function assertSameExecutableObject(
  actual: ExecutableIdentity,
  expected: ExecutableIdentity,
  code: string,
): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    fail(code, "held native executable object or bytes changed");
  }
}

function assertLeaf(leaf: string): void {
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

async function heldExecutableIdentity(
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

async function readHeldBytes(file: FileHandle, size: number): Promise<Buffer> {
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

function assertStableMetadata(actual: Stats, expected: Stats, code: string): void {
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

function assertPrivateCustodyDirectory(metadata: Stats, code: string): void {
  const expectedUid = process.getuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || expectedUid === undefined
    || metadata.uid !== expectedUid || (metadata.mode & 0o777) !== 0o700) {
    fail(code, "native helper custody is not an owned private directory");
  }
}

async function closePreservingEvidence(
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
