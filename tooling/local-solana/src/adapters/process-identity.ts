import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { LocalSolanaError } from "../domain/model.ts";
import type { ValidatorRpcListenerFact } from "../domain/model.ts";
import type { ValidatorIdentity } from "../application/ports.ts";

export async function captureValidatorIdentity(pid: number, executable: string, ledger: string, leaseToken: string): Promise<ValidatorIdentity> {
  try {
    const expectedLedger = await canonicalExistingPath(ledger, "directory");
    const expectedExecutable = await canonicalExistingPath(executable, "file");
    const platform = validatorPlatform();
    const observed = platform === "linux" ? await observeLinux(pid) : await observeDarwin(pid, expectedExecutable);
    if (observed.executable !== expectedExecutable || observed.ledgerArgument !== expectedLedger || observed.bindAddress !== "127.0.0.1" || observed.rpcPort === null || !observedLeaseMatches(platform, observed, leaseToken)) {
      throw identityError("validator process does not authenticate its executable, ledger and lease token");
    }
    return { pid, platform, startTime: observed.startTime, executable: expectedExecutable, ledger: expectedLedger, commandHash: observed.commandHash, leaseTokenHash: digest(Buffer.from(leaseToken)), bindAddress: "127.0.0.1", rpcPort: observed.rpcPort };
  } catch (cause) {
    if (cause instanceof LocalSolanaError && cause.code === "SOLANA_VALIDATOR_IDENTITY") { throw cause; }
    throw identityError("validator process identity or canonical path observation failed", cause);
  }
}

export async function authenticateValidatorIdentity(identity: ValidatorIdentity, leaseToken: string): Promise<boolean> {
  return (await validatorIdentityAuthenticationFailures(identity, leaseToken)).length === 0;
}

export async function validatorIdentityAuthenticationFailures(
  identity: ValidatorIdentity,
  leaseToken: string,
): Promise<readonly string[]> {
  const failures = [
    identity.leaseTokenHash !== digest(Buffer.from(leaseToken)) ? "lease-record" : undefined,
    identity.platform !== process.platform ? "platform" : undefined,
    process.platform !== "linux" && process.platform !== "darwin" ? "unsupported-platform" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (failures.length > 0 || (process.platform !== "linux" && process.platform !== "darwin")) {
    return failures;
  }
  const observed = process.platform === "linux"
    ? await observeLinux(identity.pid).catch(() => null)
    : await observeDarwin(identity.pid, identity.executable).catch(() => null);
  if (observed === null) { return ["observation"]; }
  return [
    observed.startTime !== identity.startTime ? "start-time" : undefined,
    observed.executable !== identity.executable ? "executable" : undefined,
    observed.ledgerArgument !== identity.ledger ? "ledger" : undefined,
    observed.bindAddress !== identity.bindAddress ? "bind-address" : undefined,
    observed.rpcPort !== identity.rpcPort ? "rpc-port" : undefined,
    observed.commandHash !== identity.commandHash ? "command" : undefined,
    !observedLeaseMatches(identity.platform, observed, leaseToken) ? "lease-process" : undefined,
  ].filter((value): value is string => value !== undefined);
}

export async function assertValidatorRpcListener(identity: ValidatorIdentity, leaseToken: string, port: number): Promise<ValidatorRpcListenerFact> {
  if (identity.rpcPort !== port || !await authenticateValidatorIdentity(identity, leaseToken)) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator identity or requested RPC port changed before listener check"); }
  const fact = process.platform === "linux" ? await linuxListenerFact(identity.pid, port) : process.platform === "darwin" ? await darwinListenerFact(identity.pid, port) : null;
  if (fact === null) { throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "RPC listener is not owned by the immutable validator identity"); }
  if (!await authenticateValidatorIdentity(identity, leaseToken)) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator identity changed after RPC listener check"); }
  return fact;
}

async function linuxListenerFact(pid: number, port: number): Promise<ValidatorRpcListenerFact | null> {
  const targetPort = port.toString(16).toUpperCase().padStart(4, "0");
  const tables = await Promise.all([readFile("/proc/net/tcp", "utf8"), readFile("/proc/net/tcp6", "utf8")]);
  const inodes = new Map<string, ValidatorRpcListenerFact>();
  for (const table of tables) {
    for (const line of table.trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/u); const local = fields[1]?.split(":"); const scope = linuxListenerScope(local?.[0]);
      if (fields[3] === "0A" && local?.[1] === targetPort && scope !== null) { const inode = fields[9]; if (inode) { inodes.set(inode, { scope }); } }
    }
  }
  if (inodes.size === 0) { return null; }
  const owned = new Map<string, ValidatorRpcListenerFact>();
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ""); const match = /^socket:\[([0-9]+)\]$/u.exec(link);
    if (match?.[1]) { const fact = inodes.get(match[1]); if (fact !== undefined) { owned.set(match[1], fact); } }
  }
  return owned.size === 1 ? [...owned.values()][0] ?? null : null;
}

function linuxListenerScope(address: string | undefined): ValidatorRpcListenerFact["scope"] | null {
  if (address === "0100007F") { return "ipv4-loopback"; }
  if (address === "00000000000000000000000001000000") { return "ipv6-loopback"; }
  if (address === "00000000" || address === "00000000000000000000000000000000") { return "wildcard"; }
  return null;
}

async function darwinListenerFact(pid: number, port: number): Promise<ValidatorRpcListenerFact> {
  try {
    const output = await command("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-FnPT"]);
    return parseDarwinLsofListener(output, pid, port);
  } catch (cause) {
    if (cause instanceof LocalSolanaError && cause.code === "SOLANA_RPC_LISTENER_IDENTITY") { throw cause; }
    throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "Darwin RPC listener observation failed");
  }
}

interface DarwinListenerRecord { protocol: string | null; name: string | null; listening: boolean; }
interface DarwinListenerParse { processPid: number | null; readonly records: DarwinListenerRecord[]; current: DarwinListenerRecord | null; }

export function parseDarwinLsofListener(output: string, expectedPid: number, port: number): ValidatorRpcListenerFact {
  const state: DarwinListenerParse = { processPid: null, records: [], current: null };
  for (const line of output.split("\n").filter(Boolean)) { parseDarwinLsofLine(state, line); }
  if (state.processPid !== expectedPid || state.records.length !== 1) { listenerInvalid(); }
  const record = state.records[0];
  if (record === undefined || record.protocol !== "TCP" || !record.listening || record.name === null) { listenerInvalid(); }
  const scope = darwinListenerScope(record.name, port);
  if (scope === null) { listenerInvalid(); }
  return { scope };
}

function parseDarwinLsofLine(state: DarwinListenerParse, line: string): void {
  const prefix = line[0]; const value = line.slice(1);
  if (prefix === "p") {
    if (state.processPid !== null || !/^[1-9][0-9]*$/u.test(value)) { listenerInvalid(); }
    const pid = Number(value); if (!Number.isSafeInteger(pid)) { listenerInvalid(); } state.processPid = pid; return;
  }
  if (prefix === "f") {
    if (state.processPid === null || value.length === 0) { listenerInvalid(); }
    state.current = { protocol: null, name: null, listening: false }; state.records.push(state.current); return;
  }
  const record = state.current;
  if (record === null) { listenerInvalid(); }
  if (prefix === "P") { if (record.protocol !== null) { listenerInvalid(); } record.protocol = value; return; }
  if (prefix === "n") { if (record.name !== null) { listenerInvalid(); } record.name = value; return; }
  if (prefix === "T") { if (value === "ST=LISTEN") { record.listening = true; } return; }
  listenerInvalid();
}

function darwinListenerScope(name: string, port: number): ValidatorRpcListenerFact["scope"] | null {
  if (name === `127.0.0.1:${port}`) { return "ipv4-loopback"; }
  if (name === `[::1]:${port}`) { return "ipv6-loopback"; }
  if (name === `*:${port}` || name === `[::]:${port}`) { return "wildcard"; }
  return null;
}

/** Kernel-backed process identity shared by run and port leases. */
export async function processStartIdentity(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const statValue = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = statValue.lastIndexOf(")");
    const field = end < 0 ? undefined : statValue.slice(end + 2).trim().split(/\s+/u)[19];
    if (field === undefined || !/^[0-9]+$/u.test(field)) {
      throw new LocalSolanaError("SOLANA_PROCESS_IDENTITY", "Linux process start identity is unavailable");
    }
    return `linux:${field}`;
  }
  if (process.platform === "darwin") {
    const output = (await ps(["-o", "lstart=", "-p", `${pid}`])).trim();
    if (output.length === 0) { throw new LocalSolanaError("SOLANA_PROCESS_IDENTITY", "Darwin process start identity is unavailable"); }
    return `darwin:${Buffer.from(output).toString("hex")}`;
  }
  throw new LocalSolanaError("SOLANA_PROCESS_IDENTITY", "cross-process identity is unsupported on this platform");
}

interface Observation {
  readonly startTime: string;
  readonly executable: string;
  readonly ledgerArgument: string | null;
  readonly commandHash: string;
  readonly bindAddress: string | null;
  readonly rpcPort: number | null;
  readonly environment: readonly string[];
}

async function observeLinux(pid: number): Promise<Observation> {
  const statValue = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = statValue.lastIndexOf(")"); const fields = end < 0 ? [] : statValue.slice(end + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  if (startTime === undefined || !/^[0-9]+$/u.test(startTime)) { throw identityError("validator process start identity is unavailable"); }
  const commandBytes = await readFile(`/proc/${pid}/cmdline`); const environment = await readFile(`/proc/${pid}/environ`);
  const commandFields = commandBytes.toString("utf8").split("\0").filter(Boolean);
  const ledgerIndex = commandFields.indexOf("--ledger");
  const ledgerPath = ledgerIndex < 0 ? undefined : commandFields[ledgerIndex + 1];
  const ledgerArgument = ledgerPath === undefined ? null : await canonicalExistingPath(ledgerPath, "directory");
  return {
    startTime: `linux:${startTime}`,
    executable: await canonicalExistingPath(`/proc/${pid}/exe`, "file"),
    ledgerArgument,
    commandHash: digest(commandBytes),
    bindAddress: singleOption(commandFields, "--bind-address"),
    rpcPort: parseRpcPort(singleOption(commandFields, "--rpc-port")),
    environment: environment.toString("utf8").split("\0").filter(Boolean),
  };
}

async function observeDarwin(pid: number, expectedExecutable: string): Promise<Observation> {
  const [start, commandOutput] = await Promise.all([
    ps(["-o", "lstart=", "-p", `${pid}`]),
    ps(["-ww", "-p", `${pid}`, "-o", "command="]),
  ]);
  const argv = parseDarwinCommand(commandOutput.trim());
  const executablePath = argv[0];
  const observedExecutable = executablePath === undefined ? null : await canonicalExistingPath(executablePath, "file");
  if (observedExecutable !== expectedExecutable) { throw identityError("Darwin command is not bound to the expected validator executable"); }
  const ledgerIndex = argv.indexOf("--ledger");
  const ledgerPath = ledgerIndex < 0 ? undefined : argv[ledgerIndex + 1];
  const ledgerArgument = ledgerPath === undefined ? null : await canonicalExistingPath(ledgerPath, "directory");
  return {
    startTime: `darwin:${Buffer.from(start.trim()).toString("hex")}`,
    executable: observedExecutable,
    ledgerArgument,
    commandHash: digest(Buffer.from(commandOutput)),
    bindAddress: singleOption(argv, "--bind-address"),
    rpcPort: parseRpcPort(singleOption(argv, "--rpc-port")),
    environment: [],
  };
}

function observedLeaseMatches(
  platform: "linux" | "darwin",
  observed: Observation,
  leaseToken: string,
): boolean {
  // Darwin's supported ps interface does not expose another process's launch
  // environment on current macOS. The token still binds the immutable lease
  // record; live identity is bound to PID/start, executable, ledger and argv.
  return platform === "darwin"
    || observed.environment.includes(`AGTMAI_LOCAL_SOLANA_LEASE_TOKEN=${leaseToken}`);
}

async function canonicalExistingPath(path: string, kind: "directory" | "file"): Promise<string> {
  const canonical = await realpath(path);
  const first = await stat(canonical, { bigint: true });
  if (kind === "directory" ? !first.isDirectory() : !first.isFile()) { throw identityError(`validator ${kind} path has the wrong type`); }
  const confirmed = await realpath(path);
  const second = await stat(confirmed, { bigint: true });
  if (canonical !== confirmed || first.dev !== second.dev || first.ino !== second.ino || (kind === "directory" ? !second.isDirectory() : !second.isFile())) {
    throw identityError(`validator ${kind} path changed during observation`);
  }
  return canonical;
}

function singleOption(argv: readonly string[], option: string): string | null {
  const indexes = argv.flatMap((value, index) => value === option ? [index] : []);
  const index = indexes[0];
  if (indexes.length !== 1 || index === undefined) { return null; }
  return argv[index + 1] ?? null;
}
function parseRpcPort(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,4}$/u.test(value)) { return null; }
  const port = Number(value); return port <= 65_535 ? port : null;
}

function validatorPlatform(): "linux" | "darwin" {
  if (process.platform === "linux" || process.platform === "darwin") { return process.platform; }
  throw identityError("native process identity is unsupported on this platform");
}

function parseDarwinCommand(commandValue: string): readonly string[] {
  const fields: string[] = []; let current = ""; let quote: "'" | '"' | null = null; let escaped = false;
  for (const character of commandValue) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== null) { if (character === quote) { quote = null; } else { current += character; } continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/u.test(character)) { if (current.length > 0) { fields.push(current); current = ""; } continue; }
    current += character;
  }
  if (escaped || quote !== null) { throw identityError("Darwin command identity is malformed"); }
  if (current.length > 0) { fields.push(current); }
  return fields;
}

async function ps(args: readonly string[]): Promise<string> { return await command("/bin/ps", args); }

async function command(executable: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(executable, [...args], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
      maxBuffer: 1024 * 1024,
      timeout: 2_000,
      killSignal: "SIGKILL",
    }, (cause, stdout) => {
      if (cause) { reject(cause); } else if (stdout.trim().length === 0) { reject(identityError("process observation is unavailable")); } else { resolve(stdout); }
    });
  });
}

function listenerInvalid(): never { throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "Darwin RPC listener observation is malformed, ambiguous or outside the allowed scope"); }
function identityError(message: string, cause?: unknown): LocalSolanaError { return new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", cause instanceof Error && cause.message.length > 0 ? `${message}: observation unavailable` : message); }
function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
