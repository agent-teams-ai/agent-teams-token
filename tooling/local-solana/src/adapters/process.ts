import { fork, spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM, LocalSolanaError } from "../domain/model.ts";
import type { CommandPort, CommandResult, ValidatorHandle, ValidatorIdentity, ValidatorPort, ValidatorStartRequest } from "../application/ports.ts";
import { assertValidatorRpcListener, authenticateValidatorIdentity, processStartIdentity, validatorIdentityAuthenticationFailures } from "./process-identity.ts";

export class NodeCommandAdapter implements CommandPort {
  public async run(executable: string, args: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly stdin?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<CommandResult> {
    if (!executable.startsWith("/")) { throw new LocalSolanaError("SOLANA_EXECUTABLE_ABSOLUTE", "child executable must be absolute"); }
    if (options.signal?.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "command interrupted"); }
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
      if (options.signal?.aborted) { abort(); }
      child.stdin.end(options.stdin);
    });
  }
}

export class OwnedValidatorAdapter implements ValidatorPort {
  public async start(request: ValidatorStartRequest): Promise<ValidatorHandle> {
    if (request.signal.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "command interrupted"); }
    if (!request.executable.startsWith("/")) { throw new LocalSolanaError("SOLANA_VALIDATOR_ABSOLUTE", "validator executable must be absolute"); }
    const args = [
      "--reset", "--ledger", request.ledger, "--config", request.config,
      "--bind-address", "127.0.0.1", "--rpc-port", String(request.rpcPort),
      "--faucet-port", String(request.faucetPort), "--gossip-port", String(request.gossipPort),
      "--dynamic-port-range", request.dynamicPortRange,
      "--mint", request.genesisMint, "--faucet-sol", "10", "--ticks-per-slot", "8", "--log",
      "--bpf-program", CLASSIC_TOKEN_PROGRAM, request.tokenProgram,
      "--bpf-program", ASSOCIATED_TOKEN_PROGRAM, request.associatedTokenProgram,
    ];
    const supervisor = fork(fileURLToPath(new URL("./validator-supervisor.ts", import.meta.url)), [], {
      env: request.env, stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let output = "";
    let validatorPid: number | undefined;
    let immutableIdentity: ValidatorIdentity | undefined;
    let validatorExit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;
    const waiters = new Set<() => void>();
    const changed = (): void => { for (const waiter of waiters) { waiter(); } waiters.clear(); };
    supervisor.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) { return; }
      const value = message as Record<string, unknown>;
      if (value.type === "output" && typeof value.value === "string") { output = bounded(output, value.value); }
      if (value.type === "spawned" && typeof value.pid === "number" && isValidatorIdentity(value.identity)) { validatorPid = value.pid; immutableIdentity = value.identity; }
      if (value.type === "exit") { validatorExit = { code: typeof value.code === "number" ? value.code : null, signal: typeof value.signal === "string" ? value.signal as NodeJS.Signals : null }; }
      changed();
    });
    supervisor.once("error", changed); supervisor.once("exit", changed);
    let shutdown: Promise<void> | undefined;
    const stopOwned = (): Promise<void> => shutdown ??= stopSupervisor(supervisor, validatorPid);
    const abort = (): void => { void stopOwned().catch(() => {}); };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      if (request.signal.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "command interrupted"); }
      supervisor.send({ type: "start", executable: request.executable, args, env: request.env, leaseToken: request.leaseToken });
      await waitFor(() => (validatorPid !== undefined && immutableIdentity !== undefined) || validatorExit !== undefined || supervisorDead(supervisor), changed, waiters, 5_000);
      if (validatorPid === undefined || immutableIdentity === undefined) { throw startupFailure(validatorExit, output, request); }
      const expectedExecutable = await realpath(request.executable); const expectedLedger = await realpath(request.ledger);
      const liveAuthenticationFailures = await validatorIdentityAuthenticationFailures(
        immutableIdentity,
        request.leaseToken,
      );
      const identityMismatches = [
        immutableIdentity.pid !== validatorPid ? "pid" : undefined,
        immutableIdentity.executable !== expectedExecutable ? "executable" : undefined,
        immutableIdentity.ledger !== expectedLedger ? "ledger" : undefined,
        immutableIdentity.bindAddress !== "127.0.0.1" ? "bind-address" : undefined,
        immutableIdentity.rpcPort !== request.rpcPort ? "rpc-port" : undefined,
        ...liveAuthenticationFailures.map((failure) => `live-${failure}`),
      ].filter((value): value is string => value !== undefined);
      if (identityMismatches.length > 0) {
        throw new LocalSolanaError(
          "SOLANA_VALIDATOR_IDENTITY",
          `supervisor immutable validator identity mismatch: ${identityMismatches.join(",")}`,
        );
      }
      await boundedRegistration(request.registerIdentity(immutableIdentity), request.signal, 5_000);
      let acknowledged = false;
      const acknowledgement = (message: unknown): void => { if ((message as { readonly type?: unknown } | null)?.type === "acknowledged") { acknowledged = true; changed(); } };
      supervisor.on("message", acknowledgement);
      supervisor.send({ type: "acknowledge" });
      try { await waitFor(() => acknowledged || validatorExit !== undefined || supervisorDead(supervisor), changed, waiters, 5_000); }
      finally { supervisor.removeListener("message", acknowledgement); }
      if (!acknowledged) { throw startupFailure(validatorExit, output, request); }
      await assertSurvivedStartup(() => validatorExit, () => sanitizeValidatorOutput(output, request));
    } catch (cause) {
      request.signal.removeEventListener("abort", abort);
      await stopOwned();
      throw cause;
    }
    if (validatorPid === undefined || immutableIdentity === undefined) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator identity was not registered"); }
    const validatorProcessPid = validatorPid;
    const identity = immutableIdentity;
    let stopped = false;
    return { pid: validatorProcessPid, assertHealthy: async () => {
      if (!await authenticateValidatorIdentity(identity, request.leaseToken)) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "owned validator identity changed"); }
    }, assertRpcListener: async (port) => await assertValidatorRpcListener(identity, request.leaseToken, port), stop: () => {
      request.signal.removeEventListener("abort", abort);
      if (stopped) { return Promise.resolve(); }
      shutdown ??= (async () => {
        if (processAlive(validatorProcessPid) && !await authenticateValidatorIdentity(identity, request.leaseToken)) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "owned validator identity changed before stop"); }
        await stopSupervisor(supervisor, validatorProcessPid); stopped = true;
      })();
      return shutdown;
    } };
  }
}

function isValidatorIdentity(value: unknown): value is ValidatorIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { return false; }
  const identity = value as Record<string, unknown>;
  return typeof identity.pid === "number" && Number.isSafeInteger(identity.pid) && identity.pid >= 1
    && (identity.platform === "linux" || identity.platform === "darwin")
    && typeof identity.startTime === "string" && typeof identity.executable === "string" && typeof identity.ledger === "string"
    && typeof identity.commandHash === "string" && typeof identity.leaseTokenHash === "string"
    && identity.bindAddress === "127.0.0.1" && typeof identity.rpcPort === "number" && Number.isSafeInteger(identity.rpcPort) && identity.rpcPort >= 1 && identity.rpcPort <= 65_535;
}

async function assertSurvivedStartup(exit: () => { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined, stderr: () => string): Promise<void> {
  await delay(500);
  const result = exit();
  if (result !== undefined) {
    const output = redact(stderr());
    const code = /address already in use|os error 98|eaddrinuse/iu.test(output) ? "SOLANA_VALIDATOR_PORT_COLLISION" : "SOLANA_VALIDATOR_EARLY_EXIT";
    throw new LocalSolanaError(code, `validator exited code=${result.code ?? "null"} signal=${result.signal ?? "none"}: ${output}`);
  }
}

function startupFailure(exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined, output: string, request: ValidatorStartRequest): LocalSolanaError {
  const sanitized = sanitizeValidatorOutput(output, request);
  const code = /address already in use|os error 98|eaddrinuse/iu.test(sanitized) ? "SOLANA_VALIDATOR_PORT_COLLISION" : "SOLANA_VALIDATOR_EARLY_EXIT";
  return new LocalSolanaError(code, `validator startup failed code=${exit?.code ?? "null"} signal=${exit?.signal ?? "none"}: ${sanitized}`);
}

async function waitFor(predicate: () => boolean, changed: () => void, waiters: Set<() => void>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { throw new LocalSolanaError("SOLANA_VALIDATOR_SUPERVISOR_TIMEOUT", "validator supervisor handshake timed out"); }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { waiters.delete(wake); resolve(); }, remaining);
      const wake = (): void => { clearTimeout(timer); resolve(); };
      waiters.add(wake);
    });
  }
  changed();
}

async function boundedRegistration(registration: Promise<void>, signal: AbortSignal, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) { return; }
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); action();
    };
    const timer = setTimeout(() => { finish(() => { reject(new LocalSolanaError("SOLANA_VALIDATOR_SUPERVISOR_TIMEOUT", "validator identity registration timed out")); }); }, timeoutMs);
    const abort = (): void => { finish(() => { reject(new LocalSolanaError("SOLANA_COMMAND_ABORTED", "command interrupted")); }); };
    signal.addEventListener("abort", abort, { once: true });
    void registration.then(() => { finish(resolve); return null; }, (cause) => { finish(() => { reject(cause); }); return null; });
    if (signal.aborted) { abort(); }
  });
}

async function stopSupervisor(supervisor: ChildProcess, validatorPid: number | undefined): Promise<void> {
  if (supervisorDead(supervisor)) {
    if (validatorPid !== undefined && processAlive(validatorPid)) { throw new LocalSolanaError("SOLANA_CHILD_STOP_TIMEOUT", "validator supervisor exited without proving child termination"); }
    return;
  }
  let stopFailed = false;
  const failure = (message: unknown): void => { if ((message as { readonly type?: unknown } | null)?.type === "stopFailed") { stopFailed = true; } };
  supervisor.on("message", failure);
  const closed = new Promise<void>((resolve) => { supervisor.once("close", () => { resolve(); }); });
  if (supervisor.connected) { supervisor.send({ type: "stop" }); }
  const exited = await within(closed, 10_500);
  supervisor.removeListener("message", failure);
  if (!exited || stopFailed || (validatorPid !== undefined && processAlive(validatorPid))) { throw new LocalSolanaError("SOLANA_CHILD_STOP_TIMEOUT", "validator supervisor could not prove child termination"); }
}

function supervisorDead(supervisor: ChildProcess): boolean { return supervisor.exitCode !== null || supervisor.signalCode !== null; }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; } }

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) { return; }
  const pid = child.pid;
  const start = pid === undefined ? null : await processStartIdentity(pid).catch(() => null);
  const verify = async (): Promise<void> => {
    if (pid === undefined || start === null) { return; }
    const current = await processStartIdentity(pid).catch(() => null);
    if (current !== null && current !== start) { throw new LocalSolanaError("SOLANA_CHILD_IDENTITY", "child PID identity changed before signal"); }
  };
  const closed = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });
  await verify(); child.kill("SIGTERM");
  if (!await within(closed, 5_000)) { await verify(); child.kill("SIGKILL"); if (!await within(closed, 5_000)) { throw new LocalSolanaError("SOLANA_CHILD_STOP_TIMEOUT", `owned child ${child.pid ?? "unknown"} did not exit`); } }
}
async function within(promise: Promise<void>, ms: number): Promise<boolean> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false); }, ms); })]); } finally { if (timer) { clearTimeout(timer); } } }
function bounded(previous: string, chunk: string): string { return `${previous}${chunk}`.slice(-64 * 1024); }
function sanitizeValidatorOutput(value: string, request: ValidatorStartRequest): string {
  return redact(value).replaceAll(dirname(request.ledger), "[REDACTED_RUN_PATH]");
}
export function redact(value: string): string { return value.replace(/(?:\[[0-9]+(?:,[0-9]+){31,}\])|(?:\b[a-z]+(?:\s+[a-z]+){11,23}\b)/giu, "[REDACTED_SECRET]").replace(/\/[A-Za-z0-9_./-]*(?:payer|mint|owner|freeze)\.json/gu, "[REDACTED_KEY_PATH]"); }
