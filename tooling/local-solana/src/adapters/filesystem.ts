import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join, resolve } from "node:path";
import { LocalSolanaError, type EvidenceReport, type FixtureObservations } from "../domain/model.ts";
import type { RunPaths, RunStorePort, ValidatorIdentity } from "../application/ports.ts";
import { assertEvidenceReport } from "../application/evidence.ts";
import { authenticateValidatorIdentity, processStartIdentity } from "./process-identity.ts";

const PREFIX = "run-";
const MARKER = ".agtmai-local-solana-lease.json";

export class PrivateRunStore implements RunStorePort {
  private readonly root: string;
  private readonly outputRoot: string;
  public constructor(runRoot: string, outputRoot: string) { this.root = resolve(runRoot); this.outputRoot = resolve(outputRoot); }
  public async create(): Promise<RunPaths> {
    const root = await ensurePrivateRoot(this.root);
    const processStart = await processStartIdentity(process.pid);
    const directory = await mkdtemp(join(root, PREFIX));
    await chmod(directory, 0o700);
    const payerKey = join(directory, "payer.json");
    const token = randomBytes(32).toString("hex");
    const lease = { schemaVersion: 3, kind: "agtmai-local-solana", pid: process.pid, processStart, token, validator: null };
    await atomicWrite(join(directory, MARKER), `${JSON.stringify(lease)}\n`, 0o600);
    await atomicWrite(join(directory, "config.yml"), `json_rpc_url: http://127.0.0.1:0/\nwebsocket_url: ''\nkeypair_path: ${payerKey}\naddress_labels: {}\ncommitment: finalized\n`, 0o600);
    const ledger = join(directory, "ledger"); await mkdir(ledger, { mode: 0o700 });
    return { directory, ledger, config: join(directory, "config.yml"), payerKey, mintKey: join(directory, "mint.json"), ownerKey: join(directory, "owner.json"), leaseToken: token };
  }
  public async registerValidator(paths: RunPaths, identity: ValidatorIdentity): Promise<void> {
    const root = await canonicalTarget(this.root); const lease = await validateOwnedRun(root, paths.directory, false);
    if (lease.token !== paths.leaseToken || identity.ledger !== await realpath(paths.ledger)) { throw new LocalSolanaError("SOLANA_VALIDATOR_LEASE", "validator identity is not bound to this owned run"); }
    const updated = { schemaVersion: 3, kind: "agtmai-local-solana", pid: process.pid, processStart: lease.processStart, token: lease.token, validator: identity };
    await atomicWrite(join(paths.directory, MARKER), `${JSON.stringify(updated)}\n`, 0o600);
  }
  public async cleanup(paths: RunPaths): Promise<void> {
    if (!await exists(paths.directory)) { return; }
    const lease = await validateOwnedRun(await canonicalTarget(this.root), paths.directory, false);
    if (lease.token !== paths.leaseToken) { throw new LocalSolanaError("SOLANA_LEASE_TOKEN", "run lease token changed before cleanup"); }
    if (lease.validator !== null && processAlive(lease.validator.pid)) { throw new LocalSolanaError("SOLANA_VALIDATOR_ACTIVE", "refusing to delete a run while its registered validator is alive"); }
    await rm(paths.directory, { recursive: true, force: false, maxRetries: 2 });
  }
  public async reclaimStale(): Promise<number> {
    const root = await ensurePrivateRoot(this.root);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(root);
    let reclaimed = 0;
    for (const name of entries) {
      if (!name.startsWith(PREFIX)) { continue; }
      const directory = join(root, name);
      const lease = await validateOwnedRun(root, directory, true).catch(() => null);
      if (!lease || await leaseOwnerIsLive(lease)) { continue; }
      if (lease.validator !== null) { await terminateAuthenticatedValidator(lease, directory); }
      await rm(directory, { recursive: true, force: false, maxRetries: 2 }); reclaimed += 1;
    }
    return reclaimed;
  }
  public async publish(_observations: FixtureObservations, verified: unknown): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
    const report = verified as EvidenceReport;
    assertEvidenceReport(report);
    const outputRoot = await ensurePrivateRoot(this.outputRoot);
    const directory = await mkdtemp(join(outputRoot, "evidence-")); await chmod(directory, 0o700);
    const jsonPath = join(directory, "evidence-report.v1.json"); const markdownPath = join(directory, "evidence-report.v1.md");
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    assertEvidenceReport(JSON.parse(serialized));
    await atomicWrite(jsonPath, serialized, 0o600);
    await atomicWrite(markdownPath, markdown(report), 0o600);
    await atomicWrite(join(directory, "READY"), `${report.genesisHash}\n`, 0o600);
    return { jsonPath, markdownPath };
  }
}

export async function ensurePrivateRoot(path: string): Promise<string> {
  const absolute = await canonicalTarget(path);
  try { await mkdir(absolute, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") { throw cause; } }
  const entry = await lstat(absolute); const resolved = await realpath(absolute); const expectedUid = process.getuid?.();
  if (!entry.isDirectory() || entry.isSymbolicLink() || resolved !== absolute || (entry.mode & 0o077) !== 0 || (expectedUid !== undefined && entry.uid !== expectedUid)) {
    throw new LocalSolanaError("SOLANA_DIRECTORY_UNSAFE", "directory must be owned mode-0700 with no symlink substitution");
  }
  return absolute;
}

async function canonicalTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  const parent = await realpath(dirname(absolute)).catch(() => null);
  if (parent === null) { throw new LocalSolanaError("SOLANA_DIRECTORY_PARENT", "directory parent is absent or substituted"); }
  return join(parent, basename(absolute));
}

interface Lease { readonly pid: number; readonly processStart: string; readonly token: string; readonly validator: ValidatorIdentity | null; }
async function validateOwnedRun(root: string, directory: string, allowStale: boolean): Promise<Lease> {
  if (dirname(directory) !== root || !basename(directory).startsWith(PREFIX)) { throw new LocalSolanaError("SOLANA_CLEANUP_BOUNDARY", "refusing cleanup outside owned run root"); }
  await assertOwnedDirectory(directory);
  const raw = await readLease(directory);
  const lease = parseLease(raw);
  if (!allowStale && (lease.pid !== process.pid || lease.processStart !== await processStartIdentity(process.pid))) {
    throw new LocalSolanaError("SOLANA_LEASE_OWNER", "run belongs to another process identity");
  }
  return lease;
}

async function assertOwnedDirectory(directory: string): Promise<void> {
  const entry = await lstat(directory);
  const expectedUid = process.getuid?.();
  const unsafe = !entry.isDirectory() || entry.isSymbolicLink() || entry.nlink < 2 || (entry.mode & 0o077) !== 0
    || await realpath(directory) !== directory || (expectedUid !== undefined && entry.uid !== expectedUid);
  if (unsafe) { throw new LocalSolanaError("SOLANA_CLEANUP_SUBSTITUTION", "owned run directory was substituted"); }
}

async function readLease(directory: string): Promise<Record<string, unknown>> {
  const markerPath = join(directory, MARKER);
  const markerEntry = await lstat(markerPath);
  if (!markerEntry.isFile() || markerEntry.isSymbolicLink() || markerEntry.nlink !== 1 || (markerEntry.mode & 0o077) !== 0) {
    throw new LocalSolanaError("SOLANA_LEASE_UNSAFE", "lease must be a private singly-linked regular file");
  }
  return JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
}

function parseLease(raw: Record<string, unknown>): Lease {
  const valid = Object.keys(raw).toSorted().join(",") === "kind,pid,processStart,schemaVersion,token,validator"
    && raw.schemaVersion === 3 && raw.kind === "agtmai-local-solana" && typeof raw.pid === "number"
    && Number.isSafeInteger(raw.pid) && raw.pid >= 1 && typeof raw.token === "string" && /^[a-f0-9]{64}$/u.test(raw.token);
  const startValid = typeof raw.processStart === "string" && /^(?:linux:[0-9]+|darwin:[a-f0-9]+)$/u.test(raw.processStart);
  if (!valid || !startValid) { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "owned lease is invalid"); }
  if (raw.validator === null) { return { pid: raw.pid as number, processStart: raw.processStart as string, token: raw.token as string, validator: null }; }
  return { pid: raw.pid as number, processStart: raw.processStart as string, token: raw.token as string, validator: parseValidatorIdentity(raw.validator) };
}

function parseValidatorIdentity(child: unknown): ValidatorIdentity {
  if (typeof child !== "object" || child === null || Array.isArray(child)) { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "validator identity is invalid"); }
  const identity = child as Record<string, unknown>;
  const childValid = Object.keys(identity).toSorted().join(",") === "commandHash,executable,ledger,pid,platform,startTime"
    && typeof identity.pid === "number" && Number.isSafeInteger(identity.pid) && identity.pid >= 1
    && (identity.platform === "linux" || identity.platform === "darwin")
    && typeof identity.startTime === "string" && /^(?:linux:[0-9]+|darwin:[a-f0-9]+)$/u.test(identity.startTime)
    && typeof identity.executable === "string" && identity.executable.startsWith("/")
    && typeof identity.ledger === "string" && identity.ledger.startsWith("/")
    && typeof identity.commandHash === "string" && /^[a-f0-9]{64}$/u.test(identity.commandHash);
  if (!childValid) { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "validator identity is invalid"); }
  return identity as unknown as ValidatorIdentity;
}

async function terminateAuthenticatedValidator(lease: Lease, directory: string): Promise<void> {
  const identity = lease.validator;
  if (identity === null || !processAlive(identity.pid)) { return; }
  const expectedLedger = await realpath(join(directory, "ledger"));
  const authenticated = identity.ledger === expectedLedger && await authenticateValidatorIdentity(identity, lease.token);
  if (!authenticated) { throw new LocalSolanaError("SOLANA_RECLAIM_IDENTITY", "refusing to terminate a PID that does not authenticate as the owned validator"); }
  process.kill(identity.pid, "SIGTERM");
  if (!await awaitExit(identity.pid, 5_000)) { process.kill(identity.pid, "SIGKILL"); if (!await awaitExit(identity.pid, 5_000)) { throw new LocalSolanaError("SOLANA_RECLAIM_TIMEOUT", "owned stale validator did not exit"); } }
}

async function awaitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!processAlive(pid)) { return true; } await delay(50); }
  return !processAlive(pid);
}

async function leaseOwnerIsLive(lease: Lease): Promise<boolean> {
  try { return await processStartIdentity(lease.pid) === lease.processStart; }
  catch { return processAlive(lease.pid); }
}

export async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY); try { await directory.sync(); } finally { await directory.close(); }
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; } }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") { return false; } throw cause; } }
function markdown(report: EvidenceReport): string { return `# Local Solana SPL fixture evidence\n\n- Status: READY\n- Mint: ${report.mintAddress}\n- Program: ${report.programId}\n- Decimals: ${report.decimals}\n- Supply: ${report.initialSupply} -> ${report.intermediateSupply} -> ${report.finalSupply}\n- Freeze authority: None\n- Signed restore/freeze attempts: reached Token Program and failed\n- Public network: false\n- Real asset cost USD: 0\n- Mint authority revoked: false\n- Authority key retained: false\n- Remint possible until teardown: true\n- Production hard cap proven: false\n`;
}
