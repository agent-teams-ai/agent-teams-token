import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { NoReplaceDirectoryRename, NoReplaceRenameRequest } from "./safe-output.ts";
import { sha256Hex } from "../domain/identity.ts";
import { fail } from "../domain/model.ts";

const SOURCE_SHA256 = "0xf3bd0279809e011933eb6ed92d55c2c7ee3bb28dedb2294ea47fe49a25483f09";
const SOURCE = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../native/no-replace.c");
const COMPILER_TIMEOUT_MS = 30_000;
const HELPER_TIMEOUT_MS = 5_000;
const TERM_GRACE_MS = 1_000;
const GROUP_REAP_MS = 2_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

interface ExecutableIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly sha256: `0x${string}`;
}

export interface NativeNoReplaceFaultInjection {
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
  readonly custodyPath: string;
  close(): Promise<void>;
}

export function assertNativeNoReplacePlatform(platform: string): void {
  if (platform !== "linux" && platform !== "darwin") {
    fail("OUTPUT_NO_REPLACE_UNAVAILABLE", "native no-replace helper supports only Linux and macOS");
  }
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
  const source = await open(SOURCE, constants.O_RDONLY | constants.O_NOFOLLOW);
  let compilerOriginal: FileHandle | undefined;
  let compilerExecutable: HeldExecutable | undefined;
  let helper: HeldExecutable | undefined;
  let custodyHandle: FileHandle | undefined;
  let custody = "";
  try {
    const sourceBefore = await source.stat();
    if (!sourceBefore.isFile() || sourceBefore.nlink !== 1) {
      fail("NO_REPLACE_SOURCE_MISMATCH", "native helper source is not a single-link regular file");
    }
    const sourceBytes = await readHeldBytes(source, sourceBefore.size);
    assertStableMetadata(await source.stat(), sourceBefore, "NO_REPLACE_SOURCE_MISMATCH");
    if (sha256Hex(sourceBytes) !== SOURCE_SHA256) {
      fail("NO_REPLACE_SOURCE_MISMATCH", "native no-replace helper source differs from its pinned digest");
    }
    await faultInjection.afterSourceRead?.(SOURCE);

    const configuredCompiler = process.env.AGTMAI_CC_BINARY ?? "/usr/bin/cc";
    if (!isAbsolute(configuredCompiler)) {
      fail("NO_REPLACE_COMPILER_UNSAFE", "AGTMAI_CC_BINARY must be an absolute path");
    }
    const strategy = nativeCompilerExecutionStrategy(process.platform);
    const compilerPath = await realpath(configuredCompiler);
    await assertTrustedCompilerPath(compilerPath);
    compilerOriginal = await open(compilerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const compilerIdentity = await heldExecutableIdentity(
      compilerOriginal, "NO_REPLACE_COMPILER_UNSAFE", true,
    );
    custody = await realpath(await mkdtemp(join(tmpdir(), "agtmai-no-replace-")));
    await chmod(custody, 0o700);
    const custodyMetadata = await lstat(custody);
    assertPrivateCustodyDirectory(custodyMetadata, "NO_REPLACE_CUSTODY_UNSAFE");
    custodyHandle = await open(custody,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

    if (strategy === "snapshot-fd") {
      compilerExecutable = await snapshotExecutable(
        compilerOriginal, compilerIdentity, custody, "compiler", "NO_REPLACE_COMPILER_UNSAFE",
      );
    } else {
      compilerExecutable = { path: compilerPath, handle: compilerOriginal, identity: compilerIdentity };
      compilerOriginal = undefined;
    }
    await faultInjection.afterCompilerSnapshot?.(compilerExecutable.path, compilerPath);
    await faultInjection.beforeCompilerSpawn?.(compilerExecutable.path);
    await runBoundChild({
      executable: compilerExecutable,
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
        compilerOriginal ?? compilerExecutable.handle, "NO_REPLACE_COMPILER_UNSAFE", true,
      ),
      compilerIdentity,
      "NO_REPLACE_COMPILER_SUBSTITUTED",
    );
    await chmod(join(custody, "no-replace"), 0o500);
    helper = await openHeldExecutable(join(custody, "no-replace"), "NO_REPLACE_EXECUTABLE_UNSAFE");

    let closed = false;
    const heldHelper = helper;
    const heldCustody = custodyHandle;
    return {
      executableSha256: heldHelper.identity.sha256,
      compilerSha256: compilerIdentity.sha256,
      custodyPath: custody,
      async rename(request: NoReplaceRenameRequest): Promise<void> {
        if (closed) {
          fail("NO_REPLACE_CAPABILITY_CLOSED", "native no-replace capability is closed");
        }
        assertLeaf(request.sourceLeaf);
        assertLeaf(request.destinationLeaf);
        await faultInjection.beforeHelperSpawn?.(heldHelper.path);
        try {
          await runBoundChild({
            executable: heldHelper,
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
          [heldHelper.handle, compilerExecutable, compilerOriginal, source, heldCustody],
        );
        // Deliberately preserve the private custody directory and every leaf.
      },
    };
  } catch (error) {
    try {
      await closePreservingEvidence(
        () => custody === "" ? undefined : faultInjection.afterBuildFailureBeforeCleanup?.(custody),
        [helper, compilerExecutable, compilerOriginal, source, custodyHandle],
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

interface HeldExecutable {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: ExecutableIdentity;
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

async function openHeldExecutable(path: string, code: string): Promise<HeldExecutable> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await heldExecutableIdentity(handle, code);
    assertSameExecutable(await executableIdentityAtPath(path, code), identity, code);
    return { path, handle, identity };
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

interface ChildRequest {
  readonly executable: HeldExecutable;
  readonly executeThroughHeldDescriptor?: boolean;
  readonly argv0?: string;
  readonly arguments: readonly string[];
  readonly stdin?: Uint8Array;
  readonly inherited: readonly FileHandle[];
  readonly timeoutMs: number;
  readonly termGraceMs: number;
  readonly groupReapMs: number;
  readonly code: string;
}

async function runBoundChild(request: ChildRequest): Promise<void> {
  const executableFd = 3 + request.inherited.length;
  const executablePath = (request.executeThroughHeldDescriptor ?? process.platform === "linux")
    ? `/proc/self/fd/${String(executableFd)}` : request.executable.path;
  await assertExecutableReady(request.executable);
  await new Promise<void>((resolve, reject) => {
    const stdio: StdioOptions = [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe",
      ...request.inherited.map((handle) => handle.fd), request.executable.handle.fd];
    const child: ChildProcess = spawn(executablePath, request.arguments, {
      detached: true,
      argv0: request.argv0,
      shell: false,
      stdio,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let spawnError: Error | undefined;
    let terminationError: Error | undefined;
    const capture = (chunks: Buffer[], used: number, chunk: Buffer): number => {
      const remaining = OUTPUT_LIMIT_BYTES - used;
      if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); }
      return used + Math.min(remaining, chunk.length);
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes = capture(stdout, stdoutBytes, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderrBytes = capture(stderr, stderrBytes, chunk); });
    child.once("error", (error) => { spawnError = error; });
    child.stdin?.once("error", (error) => { spawnError ??= error; });
    if (request.stdin !== undefined) { child.stdin?.end(request.stdin); }
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { signalGroup(child.pid, "SIGTERM"); }
      catch (error) { terminationError = asError(error); }
      killTimer = setTimeout(() => {
        try { signalGroup(child.pid, "SIGKILL"); }
        catch (error) { terminationError = asError(error); }
      }, request.termGraceMs);
      killTimer.unref();
    }, request.timeoutMs);
    timeout.unref();
    const postSpawnCheck = new Promise<void>((_resolve) => {
      if (process.platform !== "darwin") { _resolve(); return; }
      child.once("spawn", () => {
        void assertExecutableReady(request.executable).catch((error: unknown) => {
          spawnError = error instanceof Error ? error : new Error(String(error));
          try { signalGroup(child.pid, "SIGKILL"); }
          catch (signalError) { terminationError = asError(signalError); }
        }).finally(_resolve);
      });
      child.once("error", () => { _resolve(); });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (killTimer !== undefined) { clearTimeout(killTimer); }
      void (async () => {
        await postSpawnCheck;
        const quiet = await waitForGroupExit(child.pid, request.groupReapMs);
        if (!quiet) {
          fail("PROCESS_GROUP_NOT_QUIESCENT", `${request.code}: child process group ${String(child.pid)} survived termination`);
        }
        if (terminationError !== undefined) {
          reject(new ChildExitError(exitCode, `${request.code}: ${terminationError.message}`));
        } else if (spawnError !== undefined) {
          reject(new ChildExitError(exitCode, `${request.code}: ${spawnError.message}`));
        } else if (timedOut) {
          reject(new ChildExitError(exitCode, `${request.code}: process group timed out and was reaped`));
        } else if (exitCode === 0 && signal === null) {
          if (process.platform === "darwin") {
            await assertExecutableReady(request.executable);
          }
          resolve();
        } else {
          reject(new ChildExitError(exitCode,
            `${request.code}: exit=${String(exitCode)} signal=${String(signal)}`
            + ` stdout=${Buffer.concat(stdout).toString("utf8").trim()}`
            + ` stderr=${Buffer.concat(stderr).toString("utf8").trim()}`));
        }
      })().catch(reject);
    });
  });
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) { return; }
  try { process.kill(-pid, signal); }
  catch (error) { if (nodeErrorCode(error) !== "ESRCH") { throw error; } }
}

async function waitForGroupExit(pid: number | undefined, limitMs: number): Promise<boolean> {
  if (pid === undefined) { return true; }
  const deadline = Date.now() + limitMs;
  while (Date.now() <= deadline) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if (nodeErrorCode(error) === "ESRCH") { return true; }
      if (nodeErrorCode(error) !== "EPERM") { throw error; }
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
  return false;
}

async function assertExecutableReady(executable: HeldExecutable): Promise<void> {
  assertSameExecutableObject(
    await heldExecutableIdentity(executable.handle, "NO_REPLACE_EXECUTABLE_SUBSTITUTED"),
    executable.identity,
    "NO_REPLACE_EXECUTABLE_SUBSTITUTED",
  );
  if (process.platform === "darwin") {
    assertSameExecutable(
      await executableIdentityAtPath(executable.path, "NO_REPLACE_EXECUTABLE_SUBSTITUTED"),
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

async function executableIdentityAtPath(path: string, code: string): Promise<ExecutableIdentity> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await heldExecutableIdentity(file, code); }
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

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code) : undefined;
}

async function closePreservingEvidence(
  preserve: () => Promise<void> | undefined,
  handles: readonly (FileHandle | HeldExecutable | undefined)[],
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class ChildExitError extends Error {
  readonly exitCode: number | null;
  constructor(exitCode: number | null, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}
