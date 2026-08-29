import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, LocalSolanaError } from "../domain/model.ts";
import type { CommandPort, CommandResult, ValidatorHandle, ValidatorPort, ValidatorStartRequest } from "../application/ports.ts";

export class NodeCommandAdapter implements CommandPort {
  public async run(executable: string, args: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly stdin?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<CommandResult> {
    if (!executable.startsWith("/")) { throw new LocalSolanaError("SOLANA_EXECUTABLE_ABSOLUTE", "child executable must be absolute"); }
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = ""; let stopping = false;
      const timer = setTimeout(() => stop(new LocalSolanaError("SOLANA_COMMAND_TIMEOUT", "command exceeded bounded deadline")), options.timeoutMs ?? 60_000);
      const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      const stop = (cause: unknown): void => {
        if (stopping) { return; }
        stopping = true;
        void (async () => {
          try { await stopChild(child); cleanup(); reject(cause); } catch (stopCause) { reject(stopCause); }
        })();
      };
      const abort = (): void => stop(new LocalSolanaError("SOLANA_COMMAND_ABORTED", "command interrupted"));
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout = bounded(stdout, chunk); });
      child.stderr.on("data", (chunk: string) => { stderr = bounded(stderr, chunk); });
      child.once("error", (cause) => { cleanup(); reject(cause); });
      child.once("close", (code) => { if (!stopping) { cleanup(); resolve({ stdout, stderr: redact(stderr), exitCode: code ?? 1 }); } });
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end(options.stdin);
    });
  }
}

export class OwnedValidatorAdapter implements ValidatorPort {
  public async start(request: ValidatorStartRequest): Promise<ValidatorHandle> {
    if (!request.executable.startsWith("/")) { throw new LocalSolanaError("SOLANA_VALIDATOR_ABSOLUTE", "validator executable must be absolute"); }
    const child = spawn(request.executable, [
      "--reset", "--ledger", request.ledger, "--config", request.config,
      "--bind-address", "127.0.0.1", "--rpc-port", String(request.rpcPort),
      "--faucet-port", String(request.faucetPort), "--gossip-port", String(request.gossipPort),
      "--dynamic-port-range", request.dynamicPortRange,
      "--mint", request.genesisMint, "--faucet-sol", "10", "--ticks-per-slot", "8", "--log",
      "--bpf-program", CLASSIC_TOKEN_PROGRAM, request.tokenProgram,
      "--bpf-program", ASSOCIATED_TOKEN_PROGRAM, request.associatedTokenProgram,
    ], { env: request.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output = bounded(output, chunk); });
    child.stderr.on("data", (chunk: string) => { output = bounded(output, chunk); });
    if (child.pid === undefined) { throw new LocalSolanaError("SOLANA_VALIDATOR_PID", "validator did not expose a PID"); }
    const abort = (): void => { void stopChild(child); };
    request.signal.addEventListener("abort", abort, { once: true });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    await assertSurvivedStartup(child, () => sanitizeValidatorOutput(output, request));
    let promise: Promise<void> | undefined;
    return { pid: child.pid, stop: () => { request.signal.removeEventListener("abort", abort); promise ??= stopChild(child); return promise; } };
  }
}

async function assertSurvivedStartup(child: ChildProcess, stderr: () => string): Promise<void> {
  const exit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => { resolve({ code, signal }); });
  });
  const result = await Promise.race([exit, delay(500).then(() => null)]);
  if (result !== null) {
    throw new LocalSolanaError("SOLANA_VALIDATOR_EARLY_EXIT", `validator exited code=${result.code ?? "null"} signal=${result.signal ?? "none"}: ${redact(stderr())}`);
  }
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { return; }
  const closed = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });
  child.kill("SIGTERM");
  if (!await within(closed, 5_000)) { child.kill("SIGKILL"); if (!await within(closed, 5_000)) { throw new LocalSolanaError("SOLANA_CHILD_STOP_TIMEOUT", `owned child ${child.pid ?? "unknown"} did not exit`); } }
}
async function within(promise: Promise<void>, ms: number): Promise<boolean> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, ms); })]); } finally { if (timer) { clearTimeout(timer); } } }
function bounded(previous: string, chunk: string): string { return `${previous}${chunk}`.slice(-64 * 1024); }
function sanitizeValidatorOutput(value: string, request: ValidatorStartRequest): string {
  return redact(value).replaceAll(dirname(request.ledger), "[REDACTED_RUN_PATH]");
}
export function redact(value: string): string { return value.replace(/(?:\[[0-9]+(?:,[0-9]+){31,}\])|(?:\b[a-z]+(?:\s+[a-z]+){11,23}\b)/giu, "[REDACTED_SECRET]").replace(/\/[A-Za-z0-9_./-]*(?:payer|mint|owner|freeze)\.json/gu, "[REDACTED_KEY_PATH]"); }
