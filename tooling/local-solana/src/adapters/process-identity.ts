import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { LocalSolanaError } from "../domain/model.ts";
import type { ValidatorIdentity } from "../application/ports.ts";

export async function captureValidatorIdentity(pid: number, executable: string, ledger: string, leaseToken: string): Promise<ValidatorIdentity> {
  const expectedLedger = await realpath(ledger);
  const expectedExecutable = await realpath(executable);
  const observed = process.platform === "linux" ? await observeLinux(pid) : process.platform === "darwin" ? await observeDarwin(pid, expectedExecutable) : null;
  if (observed === null || observed.executable !== expectedExecutable || observed.ledgerArgument !== expectedLedger || !observed.environment.includes(`AGTMAI_LOCAL_SOLANA_LEASE_TOKEN=${leaseToken}`)) {
    throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator process does not authenticate its ledger and lease token");
  }
  return { pid, platform: process.platform as "linux" | "darwin", startTime: observed.startTime, executable: expectedExecutable, ledger: expectedLedger, commandHash: observed.commandHash, leaseTokenHash: digest(Buffer.from(leaseToken)) };
}

export async function authenticateValidatorIdentity(identity: ValidatorIdentity, leaseToken: string): Promise<boolean> {
  if (identity.leaseTokenHash !== digest(Buffer.from(leaseToken)) || identity.platform !== process.platform || (process.platform !== "linux" && process.platform !== "darwin")) { return false; }
  const observed = process.platform === "linux" ? await observeLinux(identity.pid).catch(() => null) : await observeDarwin(identity.pid, identity.executable).catch(() => null);
  return observed !== null && observed.startTime === identity.startTime && observed.executable === identity.executable
    && observed.ledgerArgument === identity.ledger && observed.commandHash === identity.commandHash
    && observed.environment.includes(`AGTMAI_LOCAL_SOLANA_LEASE_TOKEN=${leaseToken}`);
}

export async function assertValidatorRpcListener(identity: ValidatorIdentity, leaseToken: string, port: number): Promise<void> {
  if (!await authenticateValidatorIdentity(identity, leaseToken)) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator identity changed before RPC listener check"); }
  const owned = process.platform === "linux" ? await linuxOwnsListener(identity.pid, port) : process.platform === "darwin" ? await darwinOwnsListener(identity.pid, port) : false;
  if (!owned) { throw new LocalSolanaError("SOLANA_RPC_LISTENER_IDENTITY", "RPC listener is not owned by the immutable validator identity"); }
  if (!await authenticateValidatorIdentity(identity, leaseToken)) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator identity changed after RPC listener check"); }
}

async function linuxOwnsListener(pid: number, port: number): Promise<boolean> {
  const targetPort = port.toString(16).toUpperCase().padStart(4, "0");
  const tables = await Promise.all([readFile("/proc/net/tcp", "utf8"), readFile("/proc/net/tcp6", "utf8")]);
  const inodes = new Set<string>();
  for (const table of tables) for (const line of table.trim().split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/u); const local = fields[1]?.split(":");
    if (fields[3] === "0A" && local?.[1] === targetPort && (local[0] === "0100007F" || local[0] === "00000000000000000000000001000000")) { const inode = fields[9]; if (inode) { inodes.add(inode); } }
  }
  if (inodes.size === 0) { return false; }
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ""); const match = /^socket:\[([0-9]+)\]$/u.exec(link);
    if (match?.[1] && inodes.has(match[1])) { return true; }
  }
  return false;
}

async function darwinOwnsListener(pid: number, port: number): Promise<boolean> {
  const output = await command("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-FnPT"]);
  return output.split("\n").some((line) => line === `n127.0.0.1:${port}`);
}

/** Kernel-backed process identity shared by run and port leases. */
export async function processStartIdentity(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const field = end < 0 ? undefined : stat.slice(end + 2).trim().split(/\s+/u)[19];
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
  readonly environment: readonly string[];
}

async function observeLinux(pid: number): Promise<Observation> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(")"); const fields = end < 0 ? [] : stat.slice(end + 2).trim().split(/\s+/u);
  const startTime = fields[19];
  if (startTime === undefined || !/^[0-9]+$/u.test(startTime)) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator process start identity is unavailable"); }
  const command = await readFile(`/proc/${pid}/cmdline`); const environment = await readFile(`/proc/${pid}/environ`);
  const commandFields = command.toString("utf8").split("\0").filter(Boolean);
  const ledgerIndex = commandFields.indexOf("--ledger");

  return {
    startTime: `linux:${startTime}`,
    executable: await realpath("/proc/" + pid + "/exe"),
    ledgerArgument: ledgerIndex < 0 ? null : commandFields[ledgerIndex + 1] ?? null,
    commandHash: digest(command),
    environment: environment.toString("utf8").split("\0").filter(Boolean),
  };
}


async function observeDarwin(pid: number, expectedExecutable: string): Promise<Observation> {
  const [start, command, environmentCommand] = await Promise.all([
    ps(["-o", "lstart=", "-p", `${pid}`]),
    ps(["-ww", "-p", `${pid}`, "-o", "command="]),
    ps(["eww", "-p", `${pid}`, "-o", "command="]),
  ]);
  const argv = parseDarwinCommand(command.trim());
  if (argv[0] !== expectedExecutable) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "Darwin command is not bound to the expected validator executable"); }
  const ledgerIndex = argv.indexOf("--ledger");
  return {
    startTime: `darwin:${Buffer.from(start.trim()).toString("hex")}`,
    executable: expectedExecutable,
    ledgerArgument: ledgerIndex < 0 ? null : argv[ledgerIndex + 1] ?? null,
    commandHash: digest(Buffer.from(command)),
    environment: environmentCommand.split(/\s+/u).filter((field) => /^AGTMAI_LOCAL_SOLANA_LEASE_TOKEN=[a-f0-9]{64}$/u.test(field)),
  };
}

function parseDarwinCommand(command: string): readonly string[] {
  const fields: string[] = []; let current = ""; let quote: "'" | '"' | null = null; let escaped = false;
  for (const character of command) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== null) { if (character === quote) { quote = null; } else { current += character; } continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/u.test(character)) { if (current.length > 0) { fields.push(current); current = ""; } continue; }
    current += character;
  }
  if (escaped || quote !== null) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "Darwin command identity is malformed"); }
  if (current.length > 0) { fields.push(current); }
  return fields;
}

async function ps(args: readonly string[]): Promise<string> { return await command("/bin/ps", args); }

async function command(executable: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(executable, [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (cause, stdout) => {
      if (cause) { reject(cause); } else if (stdout.trim().length === 0) { reject(new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "Darwin process identity is unavailable")); } else { resolve(stdout); }
    });
  });
}

function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
