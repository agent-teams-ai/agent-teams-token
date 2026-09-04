import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { fail } from "../domain/model.ts";

const OUTPUT_LIMIT_BYTES = 64 * 1024;

interface BoundChildExecutable {
  readonly path: string;
  readonly handle: FileHandle;
}

export interface BoundChildRequest {
  readonly executable: BoundChildExecutable;
  readonly assertExecutableReady: () => Promise<void>;
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

export async function runBoundChild(request: BoundChildRequest): Promise<void> {
  const executableFd = 3 + request.inherited.length;
  const executablePath = (request.executeThroughHeldDescriptor ?? process.platform === "linux")
    ? `/proc/self/fd/${String(executableFd)}` : request.executable.path;
  await request.assertExecutableReady();
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
    const postSpawnCheck = checkAfterSpawn(
      child,
      request,
      (error) => { spawnError = error; },
      (error) => { terminationError = error; },
    );
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      void finishClosedChild({
        child, request, postSpawnCheck, exitCode, signal, stdout, stderr,
        timedOut: () => timedOut,
        spawnError: () => spawnError,
        terminationError: () => terminationError,
        clearKillTimer: () => { if (killTimer !== undefined) { clearTimeout(killTimer); } },
        resolve, reject,
      }).catch(reject);
    });
  });
}

function checkAfterSpawn(
  child: ChildProcess,
  request: BoundChildRequest,
  recordSpawnError: (error: Error) => void,
  recordTerminationError: (error: Error) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (process.platform !== "darwin") { resolve(); return; }
    child.once("spawn", () => {
      void request.assertExecutableReady().catch((error: unknown) => {
        recordSpawnError(asError(error));
        try { signalGroup(child.pid, "SIGKILL"); }
        catch (signalError) { recordTerminationError(asError(signalError)); }
      }).finally(resolve);
    });
    child.once("error", () => { resolve(); });
  });
}

interface ClosedChildState {
  readonly child: ChildProcess;
  readonly request: BoundChildRequest;
  readonly postSpawnCheck: Promise<void>;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: readonly Buffer[];
  readonly stderr: readonly Buffer[];
  readonly timedOut: () => boolean;
  readonly spawnError: () => Error | undefined;
  readonly terminationError: () => Error | undefined;
  readonly clearKillTimer: () => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

async function finishClosedChild(state: ClosedChildState): Promise<void> {
  await state.postSpawnCheck;
  let initiallyQuiet = false;
  let quiet = false;
  try {
    initiallyQuiet = !groupHasLiveMembers(state.child.pid);
    quiet = initiallyQuiet || await terminateAndReapGroup(
      state.child.pid, state.timedOut(), state.request.termGraceMs, state.request.groupReapMs,
    );
  } finally {
    state.clearKillTimer();
  }
  if (!quiet) {
    fail("PROCESS_GROUP_NOT_QUIESCENT",
      `${state.request.code}: child process group ${String(state.child.pid)} survived termination`);
  }
  const terminationError = state.terminationError();
  const spawnError = state.spawnError();
  if (terminationError !== undefined) {
    state.reject(new ChildExitError(state.exitCode, `${state.request.code}: ${terminationError.message}`));
  } else if (spawnError !== undefined) {
    state.reject(new ChildExitError(state.exitCode, `${state.request.code}: ${spawnError.message}`));
  } else if (state.timedOut()) {
    state.reject(new ChildExitError(state.exitCode,
      `${state.request.code}: process group timed out and was reaped`));
  } else if (!initiallyQuiet) {
    state.reject(new ChildExitError(state.exitCode,
      `${state.request.code}: child left a descendant process group and it was reaped`));
  } else if (state.exitCode === 0 && state.signal === null) {
    if (process.platform === "darwin") { await state.request.assertExecutableReady(); }
    state.resolve();
  } else {
    state.reject(new ChildExitError(state.exitCode,
      `${state.request.code}: exit=${String(state.exitCode)} signal=${String(state.signal)}`
      + ` stdout=${Buffer.concat(state.stdout).toString("utf8").trim()}`
      + ` stderr=${Buffer.concat(state.stderr).toString("utf8").trim()}`));
  }
}

async function terminateAndReapGroup(
  pid: number | undefined,
  termAlreadySent: boolean,
  termGraceMs: number,
  groupReapMs: number,
): Promise<boolean> {
  if (pid === undefined) { return true; }
  if (!termAlreadySent) { signalGroup(pid, "SIGTERM"); }
  if (await waitForGroupExit(pid, termGraceMs)) { return true; }
  signalGroup(pid, "SIGKILL");
  return waitForGroupExit(pid, groupReapMs);
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
    if (!groupHasLiveMembers(pid)) { return true; }
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
  }
  return false;
}

function groupHasLiveMembers(pid: number | undefined): boolean {
  if (pid === undefined) { return false; }
  if (process.platform === "darwin" || process.platform === "linux") {
    const result = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    if (result.error !== undefined || result.status !== 0) {
      fail("PROCESS_GROUP_INSPECTION_FAILED", "could not inspect native process group state");
    }
    return processGroupHasLiveMembersFromPs(result.stdout, pid);
  }
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (nodeErrorCode(error) === "ESRCH") { return false; }
    if (nodeErrorCode(error) === "EPERM") { return true; }
    throw error;
  }
}

export function processGroupHasLiveMembersFromPs(output: string, pid: number): boolean {
  return output.split("\n").some((line) => {
    const match = /^\s*(\d+)\s+(\S+)/u.exec(line);
    return match !== null && Number(match[1]) === pid && !match[2]?.startsWith("Z");
  });
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code) : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class ChildExitError extends Error {
  readonly exitCode: number | null;
  constructor(exitCode: number | null, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}
