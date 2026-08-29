import { execFile, spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { LocalEvmError } from "./model.ts";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export async function command(
  executable: string,
  arguments_: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let terminating = false;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timeout = setTimeout(() => {
      void terminate(new LocalEvmError("LOCAL_EVM_COMMAND_TIMEOUT", `${executable} exceeded its ${timeoutMs}ms deadline`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const terminate = async (cause: unknown): Promise<void> => {
      if (terminating) {return;}
      terminating = true;
      try {
        await stopExactChild(child);
      } catch (stopCause) {
        cleanup();
        reject(stopCause);
        return;
      }
      cleanup();
      reject(cause);
    };
    const onAbort = (): void => {
      void terminate(new LocalEvmError("LOCAL_EVM_COMMAND_ABORTED", `${executable} was interrupted`));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    child.once("error", (cause) => { cleanup(); reject(cause); });
    child.once("close", (code) => {
      if (terminating) {return;}
      cleanup();
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {onAbort();}
    child.stdin.end(options.stdin);
  });
}

export async function checkedCommand(
  executable: string,
  arguments_: readonly string[],
  options: CommandOptions & { readonly code?: string } = {},
): Promise<CommandResult> {
  const result = await command(executable, arguments_, options);
  if (result.exitCode !== 0) {
    throw new LocalEvmError(options.code ?? "LOCAL_EVM_COMMAND_FAILED", `${executable} exited ${result.exitCode}: ${redact(result.stderr)}`);
  }
  return result;
}

export function redact(text: string): string {
  return text
    .replace(/\b0x[0-9a-fA-F]{64}\b/g, "[REDACTED_32_BYTE_VALUE]")
    .replace(/(?:(?:test test test test test test test test test test test junk)|(?:\b[a-z]+(?:\s+[a-z]+){11,23}\b))/gi, "[REDACTED_MNEMONIC]");
}

export interface OwnedAnvil {
  readonly pid: number;
  readonly rpcUrl: string;
  stop(): Promise<void>;
}

export interface OwnedProcessIdentity {
  readonly pid: number;
  readonly processStart: string;
}

export async function startOwnedAnvil(
  executable: string,
  fundedAddress: string,
  registerIdentity?: (identity: OwnedProcessIdentity) => Promise<void>,
): Promise<OwnedAnvil> {
  const child = spawn(executable, [
    "--host", "127.0.0.1", "--port", "0", "--chain-id", "31337", "--accounts", "0",
    "--fund-accounts", `${fundedAddress}:1000000000000000000`,
  ], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  if (child.pid === undefined) {
    // A spawn error (for example ENOENT) owns no OS process. Reuse the
    // startup observer so the original error is delivered without waiting on
    // a close event that Node does not guarantee for an unspawned child.
    await listeningUrl(child);
    throw new LocalEvmError("LOCAL_EVM_ANVIL_PID_MISSING", "Anvil did not expose an owned process ID");
  }
  // Subscribe to exit/output immediately. A fast-failing executable can leave
  // Linux /proc before its process-start identity is read; keeping this
  // observer armed preserves the stable early-exit diagnostic in that race.
  const startup = listeningUrl(child).then(
    (rpcUrl) => ({ status: "ready" as const, rpcUrl }),
    (cause: unknown) => ({ status: "failed" as const, cause }),
  );
  try {
    const identity = { pid: child.pid, processStart: await processStartIdentity(child.pid) };
    await registerIdentity?.(identity);
  } catch (cause) {
    if (!processAlive(child.pid) || child.exitCode !== null || child.signalCode !== null) {
      const outcome = await startup;
      await stopExactChild(child);
      if (outcome.status === "failed") { throw outcome.cause; }
      throw new LocalEvmError("LOCAL_EVM_ANVIL_EARLY_EXIT", "Anvil exited before listening identity registration");
    }
    await stopExactChild(child);
    throw cause;
  }
  const outcome = await startup;
  if (outcome.status === "failed") {
    await stopExactChild(child);
    throw outcome.cause;
  }
  let stopPromise: Promise<void> | undefined;
  return {
    pid: child.pid,
    rpcUrl: outcome.rpcUrl,
    stop(): Promise<void> {
      stopPromise ??= stopExactChild(child);
      return stopPromise;
    },
  };
}

export async function processStartIdentity(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const field = end < 0 ? undefined : stat.slice(end + 2).trim().split(/\s+/u)[19];
    if (field === undefined || !/^[0-9]+$/u.test(field)) {
      throw new LocalEvmError("LOCAL_EVM_PROCESS_IDENTITY", "Linux process start identity is unavailable");
    }
    return `linux:${field}`;
  }
  if (process.platform === "darwin") {
    const output = await new Promise<string>((resolve, reject) => {
      execFile("/bin/ps", ["-o", "lstart=", "-p", `${pid}`], { encoding: "utf8" }, (cause, stdout) => {
        if (cause) { reject(cause); } else { resolve(stdout); }
      });
    });
    if (output.trim().length === 0) {
      throw new LocalEvmError("LOCAL_EVM_PROCESS_IDENTITY", "Darwin process start identity is unavailable");
    }
    return `darwin:${Buffer.from(output.trim()).toString("hex")}`;
  }
  throw new LocalEvmError("LOCAL_EVM_PROCESS_IDENTITY", "cross-process identity is unsupported on this platform");
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function terminateOwnedProcess(identity: OwnedProcessIdentity): Promise<void> {
  const state = await authenticateProcess(identity);
  if (state === "absent" || state === "reused") { return; }
  if (state === "ambiguous") {
    throw new LocalEvmError("LOCAL_EVM_PROCESS_IDENTITY_AMBIGUOUS", "refusing to terminate a live PID whose start identity is unavailable");
  }
  process.kill(identity.pid, "SIGTERM");
  if (!await waitForProcessExit(identity.pid, 5_000)) {
    const again = await authenticateProcess(identity);
    if (again !== "owned") {
      if (again === "absent" || again === "reused") { return; }
      throw new LocalEvmError("LOCAL_EVM_PROCESS_IDENTITY_AMBIGUOUS", "refusing SIGKILL after process identity became ambiguous");
    }
    process.kill(identity.pid, "SIGKILL");
    if (!await waitForProcessExit(identity.pid, 5_000)) {
      throw new LocalEvmError("LOCAL_EVM_PROCESS_STOP_TIMEOUT", `owned process ${identity.pid} did not exit after SIGKILL`);
    }
  }
}

export async function authenticateProcess(
  identity: OwnedProcessIdentity,
): Promise<"owned" | "absent" | "reused" | "ambiguous"> {
  if (!processAlive(identity.pid)) { return "absent"; }
  try {
    return await processStartIdentity(identity.pid) === identity.processStart ? "owned" : "reused";
  } catch {
    return processAlive(identity.pid) ? "ambiguous" : "absent";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) { return true; }
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  return !processAlive(pid);
}

type AnvilChild = ChildProcessByStdio<null, Readable, Readable>;

async function listeningUrl(child: AnvilChild): Promise<string> {
  return await new Promise((resolve, reject) => {
    let pending = "";
    const timeout = setTimeout(() => fail(new LocalEvmError("LOCAL_EVM_ANVIL_START_TIMEOUT", "Anvil did not publish its private listening address")), 10_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.removeListener("data", onStdout);
      child.removeListener("error", fail);
      child.removeListener("close", onClose);
    };
    const fail = (cause: unknown): void => {
      cleanup();
      reject(cause);
    };
    // Account and mnemonic output is deliberately neither accumulated nor forwarded.
    child.stderr.resume();
    const onStdout = (chunk: Buffer): void => {
      pending = `${pending}${chunk.toString("utf8")}`.slice(-4096);
      for (const line of pending.split(/\r?\n/u)) {
        const match = /^Listening on 127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(line.trim());
        if (match) {
          cleanup();
          child.stdout.resume();
          resolve(`http://127.0.0.1:${match[1]}/`);
          return;
        }
      }
    };
    const onClose = (code: number | null): void => fail(new LocalEvmError("LOCAL_EVM_ANVIL_EARLY_EXIT", `Anvil exited before listening (${code ?? 1})`));
    child.stdout.on("data", onStdout);
    child.once("error", fail);
    child.once("close", onClose);
  });
}

async function stopExactChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {return;}
  const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  child.kill("SIGTERM");
  let exited = await closesWithin(closed, 5_000);
  if (!exited) {
    child.kill("SIGKILL");
    exited = await closesWithin(closed, 5_000);
  }
  if (!exited) {throw new LocalEvmError("LOCAL_EVM_PROCESS_STOP_TIMEOUT", `owned child ${child.pid ?? "unknown"} did not close after SIGKILL`);}
}

async function closesWithin(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) {clearTimeout(timer);}
  }
}
