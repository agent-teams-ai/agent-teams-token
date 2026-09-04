import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NoReplaceDirectoryRename, NoReplaceRenameRequest } from "./safe-output.ts";
import { canonicalJson, sha256Hex } from "../domain/identity.ts";
import type {
  NativeNoReplaceEvidence,
  NativeNoReplaceEvidenceFields,
  NativeNoReplacePolicy,
  NativeNoReplaceTuple,
} from "../application/ports.ts";
import { fail } from "../domain/model.ts";
import {
  assertHeldDirectoryAtPath,
  directoryIdentity,
  holdSafeCustodyParent,
  type HeldDirectory,
} from "./native-custody.ts";
import { ChildExitError, runBoundChild } from "./native-custody-process.ts";
import {
  assertExecutableReady,
  assertLeaf,
  assertPrivateCustodyDirectory,
  assertSameExecutableObject,
  assertStableMetadata,
  assertTrustedCompilerPath,
  closePreservingEvidence,
  heldExecutableIdentity,
  openHeldExecutable,
  readHeldBytes,
  snapshotExecutable,
  type ExecutableIdentity,
  type HeldExecutable,
} from "./native-executable-custody.ts";
import { loadCommittedNativeNoReplacePolicy } from "./native-policy.ts";
export { loadCommittedNativeNoReplacePolicy } from "./native-policy.ts";
export { isCustodyAncestorSafe } from "./native-custody.ts";
export {
  isExecutableCustodySafe,
  type ExecutableCustodyMetadata,
  type ExecutableCustodyPolicy,
} from "./native-executable-custody.ts";
export { processGroupHasLiveMembersFromPs } from "./native-custody-process.ts";

const APPROVAL_DOMAIN = "AGTMAI_NATIVE_NO_REPLACE_APPROVAL_V1\0";
const SOURCE = fileURLToPath(new URL("../../native/no-replace.c", import.meta.url));
const COMPILER_TIMEOUT_MS = 30_000;
const HELPER_TIMEOUT_MS = 5_000;
const TERM_GRACE_MS = 1_000;
const GROUP_REAP_MS = 2_000;

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
interface NativeBuildResources {
  readonly source: FileHandle;
  compilerOriginal?: FileHandle;
  compilerExecutable?: HeldExecutable;
  helper?: HeldExecutable;
  custodyHandle?: FileHandle;
  custodyParent?: HeldDirectory;
  custodyDirectory?: HeldDirectory;
  custody: string;
}

interface ApprovedCompiler {
  readonly path: string;
  readonly identity: ExecutableIdentity;
  readonly strategy: "snapshot-fd" | "verified-path";
  readonly tuples: readonly NativeNoReplaceTuple[];
  readonly allowMultipleLinks: boolean;
}

interface NativeBuildResult {
  readonly compiler: ApprovedCompiler;
  readonly helper: HeldExecutable;
  readonly tuple: NativeNoReplaceTuple;
}

export async function createNativeNoReplaceCapability(
  faultInjection: NativeNoReplaceFaultInjection = {},
): Promise<NativeNoReplaceCapability> {
  assertNativeNoReplacePlatform(process.platform);
  const policy = await loadCommittedNativeNoReplacePolicy();
  const platform = nativePlatformKey(process.platform);
  const sourcePath = faultInjection.sourcePath ?? SOURCE;
  const resources: NativeBuildResources = {
    source: await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW),
    custody: "",
  };
  try {
    const sourceBytes = await authenticatedSourceBytes(resources.source, sourcePath, policy, faultInjection);
    const compiler = await openApprovedCompiler(policy, platform, resources);
    await createBuildCustody(resources, faultInjection.temporaryDirectory ?? tmpdir());
    resources.compilerExecutable = await prepareCompilerExecutable(compiler, resources);
    const result = await buildApprovedHelper(
      compiler,
      sourceBytes,
      resources,
      faultInjection,
    );
    resources.helper = result.helper;
    return assembledCapability({ platform, committedPolicy: policy, result, resources, faultInjection });
  } catch (error) {
    return preserveFailedBuild(error, resources, faultInjection);
  }
}

async function authenticatedSourceBytes(
  source: FileHandle,
  sourcePath: string,
  policy: NativeNoReplacePolicy,
  faultInjection: NativeNoReplaceFaultInjection,
): Promise<Buffer> {
  const before = await source.stat();
  if (!before.isFile() || before.nlink !== 1) {
    fail("NO_REPLACE_SOURCE_MISMATCH", "native helper source is not a single-link regular file");
  }
  const bytes = await readHeldBytes(source, before.size);
  assertStableMetadata(await source.stat(), before, "NO_REPLACE_SOURCE_MISMATCH");
  if (sha256Hex(bytes) !== policy.sourceSha256) {
    fail("NO_REPLACE_SOURCE_MISMATCH", "native no-replace helper source differs from its pinned digest");
  }
  await faultInjection.afterSourceRead?.(sourcePath);
  return bytes;
}

async function openApprovedCompiler(
  policy: NativeNoReplacePolicy,
  platform: "darwin-arm64" | "linux-x64",
  resources: NativeBuildResources,
): Promise<ApprovedCompiler> {
  const configured = process.env.AGTMAI_CC_BINARY ?? "/usr/bin/cc";
  if (!isAbsolute(configured)) {
    fail("NO_REPLACE_COMPILER_UNSAFE", "AGTMAI_CC_BINARY must be an absolute path");
  }
  const strategy = nativeCompilerExecutionStrategy(process.platform);
  if (strategy !== policy.platforms[platform].strategy) {
    fail("NO_REPLACE_COMPILER_UNAPPROVED", "native compiler execution strategy is not approved");
  }
  const path = await realpath(configured);
  await assertTrustedCompilerPath(path);
  const allowMultipleLinks = true;
  resources.compilerOriginal = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const identity = await heldExecutableIdentity(
    resources.compilerOriginal,
    "NO_REPLACE_COMPILER_UNSAFE",
    allowMultipleLinks,
  );
  const tuples = policy.platforms[platform].tuples.filter((tuple) =>
    tuple.compilerPath === path && tuple.compilerSha256 === identity.sha256);
  if (tuples.length === 0) {
    fail("NO_REPLACE_COMPILER_UNAPPROVED", "native compiler path and digest tuple is not approved");
  }
  return { path, identity, strategy, tuples, allowMultipleLinks };
}

async function createBuildCustody(
  resources: NativeBuildResources,
  temporaryDirectory: string,
): Promise<void> {
  resources.custodyParent = await holdSafeCustodyParent(temporaryDirectory);
  resources.custody = await realpath(await mkdtemp(join(
    resources.custodyParent.path,
    "agtmai-no-replace-",
  )));
  await assertHeldDirectoryAtPath(resources.custodyParent, "NO_REPLACE_CUSTODY_UNSAFE");
  if (dirname(resources.custody) !== resources.custodyParent.path) {
    fail("NO_REPLACE_CUSTODY_UNSAFE", "native helper custody escaped its held parent");
  }
  await chmod(resources.custody, 0o700);
  const metadata = await lstat(resources.custody);
  assertPrivateCustodyDirectory(metadata, "NO_REPLACE_CUSTODY_UNSAFE");
  resources.custodyHandle = await open(
    resources.custody,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  resources.custodyDirectory = {
    path: resources.custody,
    handle: resources.custodyHandle,
    identity: directoryIdentity(metadata),
  };
}

async function prepareCompilerExecutable(
  compiler: ApprovedCompiler,
  resources: NativeBuildResources,
): Promise<HeldExecutable> {
  const original = resources.compilerOriginal;
  if (original === undefined) {
    fail("NO_REPLACE_COMPILER_UNSAFE", "held compiler descriptor is absent");
  }
  if (compiler.strategy === "snapshot-fd") {
    return snapshotExecutable(
      original,
      compiler.identity,
      resources.custody,
      "compiler",
      "NO_REPLACE_COMPILER_UNSAFE",
    );
  }
  resources.compilerOriginal = undefined;
  return {
    path: compiler.path,
    handle: original,
    identity: compiler.identity,
    allowRootOwnedMultipleLinks: compiler.allowMultipleLinks,
  };
}

async function buildApprovedHelper(
  compiler: ApprovedCompiler,
  sourceBytes: Buffer,
  resources: NativeBuildResources,
  faultInjection: NativeNoReplaceFaultInjection,
): Promise<NativeBuildResult> {
  const executable = resources.compilerExecutable;
  const custodyParent = resources.custodyParent;
  const custodyDirectory = resources.custodyDirectory;
  if (executable === undefined || custodyParent === undefined || custodyDirectory === undefined) {
    fail("NO_REPLACE_CUSTODY_UNSAFE", "native build custody is incomplete");
  }
  await faultInjection.afterCompilerSnapshot?.(executable.path, compiler.path);
  await faultInjection.beforeCompilerSpawn?.(executable.path);
  await assertHeldDirectoryAtPath(custodyParent, "NO_REPLACE_CUSTODY_UNSAFE");
  await assertHeldDirectoryAtPath(custodyDirectory, "NO_REPLACE_CUSTODY_UNSAFE");
  await runBoundChild({
    executable,
    assertExecutableReady: () => assertExecutableReady(executable),
    executeThroughHeldDescriptor: compiler.strategy === "snapshot-fd",
    argv0: compiler.path,
    arguments: ["-x", "c", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-o", join(resources.custody, "no-replace"), "-"],
    stdin: sourceBytes,
    inherited: [],
    timeoutMs: faultInjection.compilerTimeoutMs ?? COMPILER_TIMEOUT_MS,
    termGraceMs: faultInjection.termGraceMs ?? TERM_GRACE_MS,
    groupReapMs: faultInjection.groupReapMs ?? GROUP_REAP_MS,
    code: "NO_REPLACE_BUILD_FAILED",
  });
  assertSameExecutableObject(
    await heldExecutableIdentity(
      resources.compilerOriginal ?? executable.handle,
      "NO_REPLACE_COMPILER_UNSAFE",
      compiler.allowMultipleLinks,
    ),
    compiler.identity,
    "NO_REPLACE_COMPILER_SUBSTITUTED",
  );
  const helperPath = join(resources.custody, "no-replace");
  await chmod(helperPath, 0o500);
  const helper = await openHeldExecutable(
    helperPath,
    "NO_REPLACE_EXECUTABLE_UNSAFE",
    custodyDirectory,
  );
  const tuple = compiler.tuples.find((candidate) =>
    candidate.executableSha256 === helper.identity.sha256);
  if (tuple === undefined) {
    await helper.handle.close();
    fail("NO_REPLACE_EXECUTABLE_UNAPPROVED", "native helper digest is not approved for this compiler tuple");
  }
  return { compiler, helper, tuple };
}

interface CapabilityAssembly {
  readonly platform: "darwin-arm64" | "linux-x64";
  readonly committedPolicy: NativeNoReplacePolicy;
  readonly result: NativeBuildResult;
  readonly resources: NativeBuildResources;
  readonly faultInjection: NativeNoReplaceFaultInjection;
}

function assembledCapability(assembly: CapabilityAssembly): NativeNoReplaceCapability {
  const { platform, committedPolicy: policy, result } = assembly;
  const evidenceFields: NativeNoReplaceEvidenceFields = {
    platform,
    sourcePath: policy.sourcePath,
    sourceSha256: policy.sourceSha256,
    compileProfile: policy.compileProfile,
    compilerExecution: result.compiler.strategy,
    compilerPath: result.tuple.compilerPath,
    compilerSha256: result.tuple.compilerSha256,
    executableSha256: result.tuple.executableSha256,
  };
  const evidence: NativeNoReplaceEvidence = {
    schemaVersion: 1,
    kind: "native-no-replace-evidence",
    ...evidenceFields,
    approvalSha256: nativeNoReplaceApprovalSha256(evidenceFields),
  };
  return capabilityWithCleanup(assembly, evidence);
}

function capabilityWithCleanup(
  assembly: CapabilityAssembly,
  evidence: NativeNoReplaceEvidence,
): NativeNoReplaceCapability {
  const { platform, committedPolicy: policy, result, resources, faultInjection } = assembly;
  let closed = false;
  return {
    platform,
    sourcePath: policy.sourcePath,
    sourceSha256: policy.sourceSha256,
    compileProfile: policy.compileProfile,
    strategy: result.compiler.strategy,
    compilerPath: result.tuple.compilerPath,
    approvalSha256: evidence.approvalSha256,
    evidence,
    executableSha256: result.helper.identity.sha256,
    compilerSha256: result.compiler.identity.sha256,
    custodyPath: resources.custody,
    rename: async (request) => runNoReplaceRename(request, result.helper, faultInjection, closed),
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await closePreservingEvidence(
        () => faultInjection.beforeCleanup?.(resources.custody),
        resourceHandles(resources),
      );
    },
  };
}

async function runNoReplaceRename(
  request: NoReplaceRenameRequest,
  helper: HeldExecutable,
  faultInjection: NativeNoReplaceFaultInjection,
  closed: boolean,
): Promise<void> {
  if (closed) {
    fail("NO_REPLACE_CAPABILITY_CLOSED", "native no-replace capability is closed");
  }
  assertLeaf(request.sourceLeaf);
  assertLeaf(request.destinationLeaf);
  await faultInjection.beforeHelperSpawn?.(helper.path);
  try {
    await runBoundChild({
      executable: helper,
      assertExecutableReady: () => assertExecutableReady(helper),
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
}

function resourceHandles(
  resources: NativeBuildResources,
): readonly (FileHandle | HeldExecutable | HeldDirectory | undefined)[] {
  return [
    resources.helper,
    resources.compilerExecutable,
    resources.compilerOriginal,
    resources.source,
    resources.custodyHandle,
    resources.custodyParent,
  ];
}

async function preserveFailedBuild(
  error: unknown,
  resources: NativeBuildResources,
  faultInjection: NativeNoReplaceFaultInjection,
): Promise<never> {
  try {
    await closePreservingEvidence(
      () => resources.custody === ""
        ? undefined
        : faultInjection.afterBuildFailureBeforeCleanup?.(resources.custody),
      resourceHandles(resources),
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

export function nativeNoReplaceApprovalSha256(fields: NativeNoReplaceEvidenceFields): `0x${string}` {
  return sha256Hex(Buffer.concat([Buffer.from(APPROVAL_DOMAIN), Buffer.from(canonicalJson(fields))]));
}

export function nativePlatformKey(platform: string): "darwin-arm64" | "linux-x64" {
  assertNativeNoReplacePlatform(platform);
  return platform === "darwin" ? "darwin-arm64" : "linux-x64";
}
