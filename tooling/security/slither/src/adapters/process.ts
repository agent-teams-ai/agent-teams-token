import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { ProcessOptions, ProcessPort, ProcessResult } from "../application/ports.ts";
import { assertNotCancelled, ProcessFailure } from "../application/ports.ts";

// Complete JSON/base64 export of 64 MiB, including the 12-file framing allowance.
const STDOUT_LIMIT = 4 * Math.ceil(64 * 1024 * 1024 / 3) + 12 * 256;
const STDERR_LIMIT = 1024 * 1024;
const INSPECTION_LIMIT = 256 * 1024;
const BLOCK_BYTES = 64 * 1024;
type OutputStream = NonNullable<ChildProcess["stdout"]>;

/** Byte and allocation-count bounds; decode only after all pipe bytes arrive. */
class Output {
  private readonly blocks: Buffer[] = [];
  private size = 0;

  append(chunk: Buffer, limit: number): void {
    if (chunk.length > limit - this.size) { throw new Error(`PROCESS_OUTPUT_LIMIT: exceeds ${limit} bytes`); }
    let offset = 0;
    while (offset < chunk.length) {
      const used = this.size % BLOCK_BYTES;
      if (used === 0) { this.blocks.push(Buffer.allocUnsafe(Math.min(BLOCK_BYTES, limit - this.size))); }
      const block = this.blocks.at(-1)!;
      const count = Math.min(block.length - used, chunk.length - offset);
      chunk.copy(block, used, offset, offset + count);
      offset += count;
      this.size += count;
    }
  }

  text(): string { return Buffer.concat(this.blocks, this.size).toString("utf8"); }
}

export class OwnedProcess implements ProcessPort {
  readonly signal?: AbortSignal;

  constructor(signal?: AbortSignal) { this.signal = signal; }

  async run(command: string, args: readonly string[], timeoutMs: number, options: ProcessOptions = {}): Promise<ProcessResult> {
    const signal = options.signal === null ? undefined : options.signal ?? this.signal;
    assertNotCancelled(signal);
    if (process.platform !== "linux" && process.platform !== "darwin") {
      throw new Error("PROCESS_PLATFORM_UNSUPPORTED: requires POSIX process groups");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      throw new Error("PROCESS_BUDGET_INVALID: expected a finite nonnegative timer budget");
    }
    if (timeoutMs === 0) { return { exitCode: null, stdout: "", stderr: "", timedOut: true }; }
    const deadline = performance.now() + timeoutMs;
    // The caller's budget includes spawn, capture, kill, inspection and direct-child reap.
    const stopAt = deadline - Math.min(250, timeoutMs / 2);
    const child = spawn(command, [...args], {
      detached: true, shell: false, env: options.env ?? { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return await new Promise<ProcessResult>((resolve, reject) => {
      new ProcessRun(child, deadline, stopAt, signal).start(resolve, reject);
    });
  }
}

class ProcessRun {
  private readonly child: ReturnType<typeof spawn> & { stdout: OutputStream; stderr: OutputStream };
  private deadline: number;
  private readonly stopAt: number;
  private readonly stdout = new Output();
  private readonly stderr = new Output();
  private readonly errors: unknown[] = [];
  private executionTimer: NodeJS.Timeout | undefined;
  private deadlineTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private inspection: ChildProcess | undefined;
  private exited = false;
  private closed = false;
  private stopped = false;
  private quiet = false;
  private settled = false;
  private timedOut = false;
  private cancelled = false;
  private stdoutComplete = true;
  private observationDenial: unknown;
  private exitCode: number | null = null;
  private resolve: ((result: ProcessResult) => void) | undefined;
  private reject: ((error: unknown) => void) | undefined;
  private readonly signal?: AbortSignal;

  constructor(
    child: ReturnType<typeof spawn> & { stdout: OutputStream; stderr: OutputStream },
    deadline: number,
    stopAt: number,
    signal?: AbortSignal,
  ) { this.child = child; this.deadline = deadline; this.stopAt = stopAt; this.signal = signal; }

  start(resolve: (result: ProcessResult) => void, reject: (error: unknown) => void): void {
    this.resolve = resolve;
    this.reject = reject;
    this.child.stdout.on("data", this.onStdout);
    this.child.stderr.on("data", this.onStderr);
    this.child.stdout.once("error", this.onStdoutError);
    this.child.stderr.once("error", this.onError);
    this.child.once("error", this.onError);
    this.child.once("exit", this.onExit);
    this.child.once("close", this.onClose);
    this.executionTimer = setTimeout(this.onTimeout, Math.max(0, Math.ceil(this.stopAt - performance.now())));
    this.deadlineTimer = setTimeout(this.onDeadline, Math.max(0, Math.ceil(this.deadline - performance.now())));
    this.signal?.addEventListener("abort", this.onAbort, {once: true});
    if (this.signal?.aborted) { this.onAbort(); }
  }

  private readonly onAbort = (): void => {
    if (this.cancelled || this.settled) { return; }
    this.cancelled = true;
    this.errors.unshift(this.signal!.reason);
    this.deadline = Math.min(this.deadline, performance.now() + 250);
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(this.onDeadline, Math.max(0, Math.ceil(this.deadline - performance.now())));
    this.stop();
    this.progress();
  };

  private readonly onStdout = (chunk: Buffer): void => { this.capture(this.stdout, chunk, STDOUT_LIMIT, "stdout"); };
  private readonly onStderr = (chunk: Buffer): void => { this.capture(this.stderr, chunk, STDERR_LIMIT, "stderr"); };
  private readonly onStdoutError = (error: Error): void => { this.stdoutComplete = false; this.onError(error); };
  private readonly onError = (error: Error): void => { this.errors.push(error); this.stop(); this.progress(); };
  private readonly onExit = (code: number | null): void => {
    this.exited = true;
    this.exitCode = code;
    const earlyExit = !this.stopped;
    this.stop();
    if (earlyExit && !this.quiet) {
      this.errors.push(new Error("PROCESS_DESCENDANTS: direct child exited with a remaining process group"));
    }
    this.progress();
  };
  private readonly onClose = (): void => { this.closed = true; this.progress(); };
  private readonly onTimeout = (): void => { this.timedOut = true; this.stop(); this.progress(); };
  private readonly onDeadline = (): void => {
    this.timedOut = true;
    this.stop();
    if (!this.closed || !this.quiet || this.inspection !== undefined) {
      this.errors.push(new Error("PROCESS_CLEANUP_UNCONFIRMED: deadline reached before group, pipes and reap were confirmed", {cause: this.observationDenial}));
    }
    this.finish();
  };

  private capture(output: Output, chunk: Buffer, limit: number, name: string): void {
    if (this.errors.length !== 0) {
      if (name === "stdout") { this.stdoutComplete = false; }
      return;
    }
    try { output.append(chunk, limit); }
    catch (cause) {
      if (name === "stdout") { this.stdoutComplete = false; }
      this.onError(new Error(`PROCESS_OUTPUT_LIMIT: ${name} capture failed`, { cause }));
    }
    if (!this.stopped && performance.now() >= this.stopAt) { this.onTimeout(); }
  }

  private stop(): void {
    if (this.stopped) { return; }
    this.stopped = true;
    clearTimeout(this.executionTimer);
    const pid = this.child.pid;
    if (pid === undefined) { this.quiet = true; return; }
    // detached spawn creates PGID=PID. Signal only this fresh group, once, directly
    // from its child's lifecycle; never retry a stored PGID after an async probe.
    // Node cannot atomically bind kill(2) to a process identity. Same-UID PID reuse
    // at the final syscall, setsid/setpgid escape and a hostile kernel are outside
    // this ownership boundary. SIGKILL deliberately needs no TERM grace period.
    try { process.kill(-pid, "SIGKILL"); }
    catch (cause) {
      if (errorCode(cause) === "ESRCH") { this.quiet = true; }
      else {
        this.errors.push(new Error("PROCESS_GROUP_KILL_FAILED", { cause }));
        if (!this.exited) {
          this.attempt(() => { if (!this.child.kill("SIGKILL")) { throw new Error("PROCESS_CHILD_KILL_UNCONFIRMED", { cause }); } });
        }
      }
    }
  }

  private progress(): void {
    if (this.settled) { return; }
    if (performance.now() >= this.deadline) { this.onDeadline(); return; }
    if (this.closed && this.quiet) { this.finish(); return; }
    if (this.stopped && this.exited && !this.quiet && this.inspection === undefined && this.pollTimer === undefined) {
      this.inspect();
    }
  }

  private inspect(): void {
    // ps is a fixed OS observer, never a shell or a target supplied by command env.
    // Its output, time, streams and child handle are owned by the same deadline.
    try {
      try { process.kill(-this.child.pid!, 0); }
      catch (cause) {
        if (errorCode(cause) === "ESRCH") {
          this.quiet = true;
          this.progress();
          return;
        }
        // Darwin can deny the negative-PGID signal-0 observer after reap.
        // EPERM is uncertainty, never absence: require the same bounded, fixed
        // ps observation used for a present group. This never authorizes a kill.
        if (errorCode(cause) !== "EPERM") { throw cause; }
        this.observationDenial = cause;
      }
      this.inspection = execFile("/bin/ps", ["-axo", "pgid=,stat="], {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, encoding: "utf8",
        maxBuffer: INSPECTION_LIMIT, timeout: Math.max(1, Math.ceil(this.deadline - performance.now())),
        killSignal: "SIGKILL",
      }, (error, stdout) => {
        this.inspection = undefined;
        if (this.settled) { return; }
        try {
          if (error !== null) { throw error; }
          this.quiet = !hasLiveGroup(stdout, this.child.pid!);
        } catch (cause) {
          this.errors.push(new Error("PROCESS_GROUP_INSPECTION_FAILED: cleanup is unconfirmed", { cause: this.observationDenial === undefined ? cause : new AggregateError([this.observationDenial, cause], "signal-0 and ps observation failures") }));
          this.finish();
          return;
        }
        if (!this.quiet) {
          this.pollTimer = setTimeout(() => { this.pollTimer = undefined; this.progress(); }, 10);
        }
        this.progress();
      });
    } catch (cause) {
      this.errors.push(new Error("PROCESS_GROUP_INSPECTION_FAILED: cleanup is unconfirmed", { cause }));
      this.finish();
    }
  }

  private finish(): void {
    if (this.settled) { return; }
    this.settled = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    clearTimeout(this.executionTimer);
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.pollTimer);
    this.disposeInspection();
    this.disposeChild();
    try {
      const stdout = this.stdout.text();
      const stderr = this.stderr.text();
      const result = { exitCode: this.exitCode, stdout, stderr, timedOut: this.timedOut || performance.now() >= this.deadline };
      if (this.errors.length !== 0) { this.reject!(new ProcessFailure(this.errors, result, this.stdoutComplete && this.child.stdout.readableEnded)); }
      else { this.resolve!(result); }
    } catch (cause) { this.reject!(new AggregateError([...this.errors, cause], "PROCESS_FAILED: output finalization failed")); }
  }

  private disposeInspection(): void {
    const inspection = this.inspection;
    if (inspection === undefined) { return; }
    if (inspection.exitCode === null && inspection.signalCode === null) {
      this.attempt(() => { if (!inspection.kill("SIGKILL")) { throw new Error("PROCESS_OBSERVER_KILL_UNCONFIRMED"); } });
    }
    this.attempt(() => { inspection.stdout?.destroy(); });
    this.attempt(() => { inspection.stderr?.destroy(); });
    this.attempt(() => { inspection.unref(); });
  }

  private disposeChild(): void {
    this.child.stdout.off("data", this.onStdout);
    this.child.stderr.off("data", this.onStderr);
    this.child.off("exit", this.onExit);
    this.child.off("close", this.onClose);
    // Unconfirmed failure may receive a late OS error. Drain until close without
    // retaining this run; normal completion removes every listener installed here.
    if (!this.closed) { drainLateErrors(this.child); }
    this.child.off("error", this.onError);
    this.child.stdout.off("error", this.onStdoutError);
    for (const stream of [this.child.stdout, this.child.stderr]) {
      if (!stream.closed) { drainLateErrors(stream); }
      stream.off("error", this.onError);
    }
    this.attempt(() => { this.child.stdout.destroy(); });
    this.attempt(() => { this.child.stderr.destroy(); });
    this.attempt(() => { this.child.unref(); });
  }

  private attempt(action: () => void): void {
    try { action(); } catch (cause) { this.errors.push(cause); }
  }
}

function hasLiveGroup(stdout: string, pid: number): boolean {
  const lines = stdout.trim().split("\n");
  let live = false;
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/u.exec(line);
    if (match === null) { throw new Error("PROCESS_GROUP_INSPECTION_INVALID"); }
    // A zombie cannot execute or hold pipes. Only the direct child can be reaped
    // by Node; orphan zombies belong to the system reaper, on Linux and Darwin.
    if (Number(match[1]) === pid && !match[2]!.startsWith("Z")) { live = true; }
  }
  return live;
}

function drainLateErrors(emitter: ChildProcess | OutputStream): void {
  emitter.on("error", ignoreLateError);
  emitter.once("close", () => { emitter.off("error", ignoreLateError); });
}

function ignoreLateError(): void {}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}
