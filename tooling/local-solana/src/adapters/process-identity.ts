import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { LocalSolanaError } from "../domain/model.ts";
import type { ValidatorIdentity } from "../application/ports.ts";

export async function captureValidatorIdentity(pid: number, executable: string, ledger: string, leaseToken: string): Promise<ValidatorIdentity> {
  const expectedLedger = await realpath(ledger);
  const expectedExecutable = await realpath(executable);
  const observed = process.platform === "linux" ? await observeLinux(pid) : process.platform === "darwin" ? await observeDarwin(pid, expectedExecutable) : null;
  if (observed === null || observed.ledgerArgument !== expectedLedger || (process.platform === "linux" && !observed.environment.includes(`AGTMAI_LOCAL_SOLANA_LEASE_TOKEN=${leaseToken}`))) {
    throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "validator process does not authenticate its ledger and lease token");
  }
  return { pid, platform: process.platform as "linux" | "darwin", startTime: observed.startTime, executable: process.platform === "darwin" ? expectedExecutable : observed.executable, ledger: expectedLedger, commandHash: observed.commandHash };
}

export async function authenticateValidatorIdentity(identity: ValidatorIdentity, leaseToken: string): Promise<boolean> {
  if (identity.platform !== process.platform || (process.platform !== "linux" && process.platform !== "darwin")) { return false; }
  const observed = process.platform === "linux" ? await observeLinux(identity.pid).catch(() => null) : await observeDarwin(identity.pid, identity.executable).catch(() => null);
  return observed !== null && observed.startTime === identity.startTime && observed.executable === identity.executable
    && observed.ledgerArgument === identity.ledger && observed.commandHash === identity.commandHash
    && (process.platform === "darwin" || observed.environment.includes(`AGTMAI_LOCAL_SOLANA_LEASE_TOKEN=${leaseToken}`));
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
    executable: await realpath(`/proc/${pid}/exe`),
    ledgerArgument: ledgerIndex < 0 ? null : commandFields[ledgerIndex + 1] ?? null,
    commandHash: digest(command),
    environment: environment.toString("utf8").split("\0").filter(Boolean),
  };
}

async function observeDarwin(pid: number, expectedExecutable: string): Promise<Observation> {
  const [start, command] = await Promise.all([
    ps(["-o", "lstart=", "-p", `${pid}`]),
    ps(["-ww", "-p", `${pid}`, "-o", "command="]),
  ]);
  const argv = parseDarwinCommand(command.trim());
  if (argv[0] !== expectedExecutable) { throw new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "Darwin command is not bound to the expected validator executable"); }
  const ledgerIndex = argv.indexOf("--ledger");
  return {
    startTime: `darwin:${Buffer.from(start.trim()).toString("hex")}`,
    executable: expectedExecutable,
    ledgerArgument: ledgerIndex < 0 ? null : argv[ledgerIndex + 1] ?? null,
    commandHash: digest(Buffer.from(command)),
    environment: [],
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

async function ps(args: readonly string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => execFile("/bin/ps", [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (cause, stdout) => {
    if (cause) { reject(cause); } else if (stdout.trim().length === 0) { reject(new LocalSolanaError("SOLANA_VALIDATOR_IDENTITY", "Darwin process identity is unavailable")); } else { resolvePromise(stdout); }
  }));
}

function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
