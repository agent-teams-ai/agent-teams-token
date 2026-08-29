import { execFile, spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";
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
  const supervisor = spawn(process.execPath, [fileURLToPath(import.meta.url), "--supervise-anvil", executable, fundedAddress], {
    stdio: ["pipe", "pipe", "pipe"], env: process.env,
  });
  supervisor.stdin.on("error", () => {});
  try {
    const identityMessage = await supervisorMessage(supervisor, "identity");
    if (typeof identityMessage.pid !== "number" || !Number.isSafeInteger(identityMessage.pid)
      || identityMessage.pid <= 0 || typeof identityMessage.processStart !== "string"
      || !/^(?:linux:[0-9]+|darwin:[a-f0-9]+)$/u.test(identityMessage.processStart)) {
      throw new LocalEvmError("LOCAL_EVM_ANVIL_SUPERVISOR_PROTOCOL", "Anvil supervisor returned an invalid process identity");
    }
    const identity: OwnedProcessIdentity = {pid: identityMessage.pid, processStart: identityMessage.processStart};
    await registerIdentity?.(identity);
    supervisor.stdin.write("ack\n");
    const ready = await supervisorMessage(supervisor, "ready");
    if (typeof ready.rpcUrl !== "string") {
      throw new LocalEvmError("LOCAL_EVM_ANVIL_SUPERVISOR_PROTOCOL", "Anvil supervisor returned an invalid listening address");
    }
    let stopPromise: Promise<void> | undefined;
    return {
      pid: identity.pid,
      rpcUrl: ready.rpcUrl,
      stop(): Promise<void> {
        stopPromise ??= stopSupervisor(supervisor);
        return stopPromise;
      },
    };
  } catch (cause) {
    await stopSupervisor(supervisor);
    throw cause;
  }
}

async function superviseAnvil(executable: string, fundedAddress: string): Promise<void> {
  const child = spawn(executable, [
    "--host", "127.0.0.1", "--port", "0", "--chain-id", "31337", "--accounts", "0",
    "--fund-accounts", `${fundedAddress}:1000000000000000000`,
  ], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  if (child.pid === undefined) {
    await listeningUrl(child);
    throw new LocalEvmError("LOCAL_EVM_ANVIL_PID_MISSING", "Anvil did not expose an owned process ID");
  }
  const startup = listeningUrl(child).then(
    (rpcUrl) => ({status: "ready" as const, rpcUrl}),
    (cause: unknown) => ({status: "failed" as const, cause}),
  );
  try {
    let processStart: string;
    try {processStart = await processStartIdentity(child.pid);}
    catch (cause) {
      const outcome = await startup;
      if (outcome.status === "failed") {throw outcome.cause;}
      throw cause;
    }
    const identity = {pid: child.pid, processStart};
    process.stdout.write(`${JSON.stringify({ type: "identity", ...identity })}\n`);
    const first = await controlMessage();
    if (first !== "ack") {return;}
    const outcome = await startup;
    if (outcome.status === "failed") {throw outcome.cause;}
    process.stdout.write(`${JSON.stringify({ type: "ready", rpcUrl: outcome.rpcUrl })}\n`);
    await controlMessage();
  } finally {
    process.stdin.pause();
    await stopExactChild(child);
  }
}

async function controlMessage(): Promise<string | undefined> {
  process.stdin.setEncoding("utf8");
  return await new Promise((resolve) => {
    let pending = "";
    const done = (value?: string): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      resolve(value);
    };
    const onData = (chunk: string): void => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline >= 0) {done(pending.slice(0, newline).trim());}
    };
    const onEnd = (): void => done();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.resume();
  });
}

async function supervisorMessage(
  supervisor: ChildProcessByStdio<Writable, Readable, Readable>,
  expected: "identity" | "ready",
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let pending = "";
    let stderr = "";
    const cleanup = (): void => {
      supervisor.stdout.removeListener("data", onData);
      supervisor.stdout.pause();
      supervisor.stderr.removeListener("data", onStderr);
      supervisor.removeListener("error", onError);
      supervisor.removeListener("close", onClose);
    };
    const fail = (cause: unknown): void => {cleanup(); reject(cause);};
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString("utf8");
      const newline = pending.indexOf("\n");
      if (newline < 0) {return;}
      try {
        const value = JSON.parse(pending.slice(0, newline)) as unknown;
        if (!isRecord(value) || value.type !== expected) {throw new Error("unexpected message");}
        cleanup(); resolve(value);
      } catch {
        fail(new LocalEvmError("LOCAL_EVM_ANVIL_SUPERVISOR_PROTOCOL", "Anvil supervisor returned an invalid message"));
      }
    };
    const onStderr = (chunk: Buffer): void => {stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);};
    const onError = (cause: unknown): void => fail(cause);
    const onClose = (code: number | null): void => fail(new LocalEvmError("LOCAL_EVM_ANVIL_EARLY_EXIT", `Anvil supervisor exited ${code ?? 1}: ${redact(stderr)}`));
    supervisor.stdout.on("data", onData);
    supervisor.stdout.resume();
    supervisor.stderr.on("data", onStderr);
    supervisor.once("error", onError);
    supervisor.once("close", onClose);
  });
}

async function stopSupervisor(supervisor: ChildProcess): Promise<void> {
  if (supervisor.exitCode !== null || supervisor.signalCode !== null) {return;}
  const closed = new Promise<void>((resolve) => {supervisor.once("close", () => resolve());});
  supervisor.stdin?.end("stop\n");
  if (!await closesWithin(closed, 11_000)) {await stopExactChild(supervisor);}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--supervise-anvil") {
  const executable = process.argv[3];
  const fundedAddress = process.argv[4];
  if (!executable || !fundedAddress) {process.exitCode = 2;}
  else {
    superviseAnvil(executable, fundedAddress).catch((cause: unknown) => {
      process.stderr.write(`${redact(cause instanceof Error ? cause.message : String(cause))}\n`);
      process.exitCode = 1;
    });
  }
}
