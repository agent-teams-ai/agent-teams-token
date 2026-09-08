import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join, resolve } from "node:path";
import { FAILURE_PHASES, LocalSolanaError, type EvidenceReport, type FailureEvidenceReport, type FixtureObservations } from "../domain/model.ts";
import type { FileIdentity, RunPaths, RunStorePort, ValidatorIdentity } from "../application/ports.ts";
import { assertEvidenceReport } from "../application/evidence.ts";
import { verifyObservations } from "../application/verifier.ts";
import { validatorIdentityAuthenticationFailures, processStartIdentity } from "./process-identity.ts";

import { readBoundedMarker, assertMarkerBounds } from "./lease-marker.ts";
import { initializeStartupCustody, startupCustodySettled } from "./startup-custody.ts";

const PREFIX = "run-";
const MARKER = ".agtmai-local-solana-lease.json";

export class PrivateRunStore implements RunStorePort {
  private readonly root: string;
  private readonly outputRoot: string;
  public constructor(runRoot: string, outputRoot: string) { this.root = resolve(runRoot); this.outputRoot = resolve(outputRoot); }
  public async create(): Promise<RunPaths> {
    const root = await ensurePrivateRoot(this.root); const rootIdentity = await privateDirectoryIdentity(root);
    const processStart = await processStartIdentity(process.pid); const directory = await mkdtemp(join(root, PREFIX)); await chmod(directory, 0o700);
    const directoryIdentity = await privateDirectoryIdentity(directory); const payerKey = join(directory, "payer.json"); const token = randomBytes(32).toString("hex");
    const markerPath = join(directory, MARKER); const handle = await open(markerPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    let markerIdentity: FileIdentity;
    try {
      const markerStat = await handle.stat({ bigint: true }); assertPrivateMarkerStat(markerStat); markerIdentity = fileIdentity(markerStat);
      const lease = leaseRecord({ processStart, token, rootIdentity, directoryIdentity, markerIdentity, validator: null });
      await handle.writeFile(`${JSON.stringify(lease)}\n`); await handle.sync();
    } finally { await handle.close(); }
    await assertDirectoryIdentity(root, rootIdentity); await assertDirectoryIdentity(directory, directoryIdentity);
    await atomicWrite(join(directory, "config.yml"), `json_rpc_url: http://127.0.0.1:0/\nwebsocket_url: ''\nkeypair_path: ${payerKey}\naddress_labels: {}\ncommitment: finalized\n`, 0o600);
    const ledger = join(directory, "ledger"); await mkdir(ledger, { mode: 0o700 });
    await initializeStartupCustody(directory, token);
    return { directory, ledger, config: join(directory, "config.yml"), payerKey, mintKey: join(directory, "mint.json"), ownerKey: join(directory, "owner.json"), leaseToken: token, rootIdentity, directoryIdentity, markerIdentity };
  }
  public async registerValidator(paths: RunPaths, identity: ValidatorIdentity): Promise<void> {
    const root = await canonicalTarget(this.root); const validated = await validateOwnedRun(root, paths.directory, false, paths);
    if (validated.lease.token !== paths.leaseToken || identity.ledger !== await realpath(paths.ledger) || validated.lease.validator !== null) { throw new LocalSolanaError("SOLANA_VALIDATOR_LEASE", "validator identity is not bound to this unregistered owned run"); }
    const updated = leaseRecord({ processStart: validated.lease.processStart, token: validated.lease.token, rootIdentity: paths.rootIdentity, directoryIdentity: paths.directoryIdentity, markerIdentity: paths.markerIdentity, validator: identity });
    await rewriteLease(paths.directory, updated, paths); await validateOwnedRun(root, paths.directory, false, paths);
  }
  public async cleanup(paths: RunPaths): Promise<void> {
    const entry = await lstat(paths.directory).catch((cause) => { if ((cause as NodeJS.ErrnoException).code === "ENOENT") { return null; } throw cause; });
    if (entry === null) { return; }
    const root = await canonicalTarget(this.root); const validated = await validateOwnedRun(root, paths.directory, false, paths);
    if (validated.lease.token !== paths.leaseToken) { throw new LocalSolanaError("SOLANA_LEASE_TOKEN", "run lease token changed before cleanup"); }
    if (!await startupCustodySettled(paths.directory, validated.lease.token, validated.lease.validator !== null) || (validated.lease.validator !== null && !await processExited(validated.lease.validator.pid, validated.lease.validator.startTime))) { throw new LocalSolanaError("SOLANA_VALIDATOR_ACTIVE", "refusing to delete a run while its registered validator is alive"); }
    await quarantineAndDeleteRun(root, paths.directory, validated);
    if (await exists(paths.directory)) { throw new LocalSolanaError("SOLANA_CLEANUP_INCOMPLETE", "private run directory still exists after cleanup"); }
  }
  public async reclaimStale(): Promise<number> {
    const root = await ensurePrivateRoot(this.root); const rootIdentity = await privateDirectoryIdentity(root); const { readdir } = await import("node:fs/promises"); const entries = await readdir(root); let reclaimed = 0;
    for (const name of entries) {
      if (!name.startsWith(PREFIX)) { continue; }
      const directory = join(root, name); const validated = await validateOwnedRun(root, directory, true).catch(() => null);
      if (!validated || !sameIdentity(validated.lease.rootIdentity, rootIdentity) || await leaseOwnerIsLive(validated.lease)) { continue; }
      if (!await startupCustodySettled(directory, validated.lease.token, validated.lease.validator !== null).catch(() => false)) { continue; }
      if (await quarantineAndDeleteRun(root, directory, validated, true)) { reclaimed += 1; }
    }
    return reclaimed;
  }
  public async publish(observations: FixtureObservations, verified: unknown): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
    const report = verified as EvidenceReport;
    assertEvidenceReport(report);
    const recomputed = verifyObservations(observations);
    if (stableValue(report) !== stableValue(recomputed)) {
      throw new LocalSolanaError("SOLANA_EVIDENCE_MISMATCH", "supplied evidence differs from independently recomputed observations");
    }
    const outputRoot = await ensurePrivateRoot(this.outputRoot);
    const directory = await mkdtemp(join(outputRoot, "evidence-")); await chmod(directory, 0o700);
    const jsonPath = join(directory, "evidence-report.v1.json"); const markdownPath = join(directory, "evidence-report.v1.md");
    const serialized = `${JSON.stringify(recomputed, null, 2)}\n`;
    assertEvidenceReport(JSON.parse(serialized));
    await atomicWrite(jsonPath, serialized, 0o600);
    await atomicWrite(markdownPath, markdown(recomputed), 0o600);
    await atomicWrite(join(directory, "READY"), `${recomputed.genesisHash}\n`, 0o600);
    return { jsonPath, markdownPath };
  }
  public async publishFailure(report: FailureEvidenceReport): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
    assertFailureEvidence(report);
    const outputRoot = await ensurePrivateRoot(this.outputRoot);
    const directory = await mkdtemp(join(outputRoot, "failure-evidence-")); await chmod(directory, 0o700);
    const jsonPath = join(directory, "failure-evidence-report.v1.json");
    const markdownPath = join(directory, "failure-evidence-report.v1.md");
    await atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 0o600);
    await atomicWrite(markdownPath, failureMarkdown(report), 0o600);
    await atomicWrite(join(directory, "READY"), "FAILED\n", 0o600);
    return { jsonPath, markdownPath };
  }
}

export async function ensurePrivateRoot(path: string): Promise<string> {
  const absolute = await canonicalTarget(path);
  try { await mkdir(absolute, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") { throw cause; } }
  const entry = await lstat(absolute); const resolved = await realpath(absolute); const expectedUid = process.getuid?.();
  if (!entry.isDirectory() || entry.isSymbolicLink() || resolved !== absolute || (entry.mode & 0o777) !== 0o700 || (expectedUid !== undefined && entry.uid !== expectedUid)) {
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

interface Lease {
  readonly pid: number; readonly processStart: string; readonly token: string; readonly validator: ValidatorIdentity | null;
  readonly rootIdentity: FileIdentity; readonly directoryIdentity: FileIdentity; readonly markerIdentity: FileIdentity;
}
interface ValidatedRun { readonly lease: Lease; readonly rootIdentity: FileIdentity; readonly directoryIdentity: FileIdentity; readonly markerIdentity: FileIdentity; }

function leaseRecord(value: Omit<Lease, "pid">): Record<string, unknown> {
  return { schemaVersion: 4, kind: "agtmai-local-solana", pid: process.pid, ...value };
}

async function validateOwnedRun(root: string, directory: string, allowStale: boolean, expected?: Pick<RunPaths, "rootIdentity" | "directoryIdentity" | "markerIdentity">): Promise<ValidatedRun> {
  if (dirname(directory) !== root || !basename(directory).startsWith(PREFIX)) { throw new LocalSolanaError("SOLANA_CLEANUP_BOUNDARY", "refusing cleanup outside owned run root"); }
  const rootIdentity = await privateDirectoryIdentity(root); const directoryIdentity = await privateDirectoryIdentity(directory);
  const marker = await readLease(directory); const lease = parseLease(marker.raw);
  const identitiesMatch = sameIdentity(lease.rootIdentity, rootIdentity) && sameIdentity(lease.directoryIdentity, directoryIdentity) && sameIdentity(lease.markerIdentity, marker.identity)
    && (expected === undefined || (sameIdentity(expected.rootIdentity, rootIdentity) && sameIdentity(expected.directoryIdentity, directoryIdentity) && sameIdentity(expected.markerIdentity, marker.identity)));
  if (!identitiesMatch) { throw new LocalSolanaError("SOLANA_CLEANUP_IDENTITY", "root, run directory or lease marker identity changed"); }
  await assertDirectoryIdentity(root, rootIdentity); await assertDirectoryIdentity(directory, directoryIdentity);
  if (!allowStale && (lease.pid !== process.pid || lease.processStart !== await processStartIdentity(process.pid))) { throw new LocalSolanaError("SOLANA_LEASE_OWNER", "run belongs to another process identity"); }
  return { lease, rootIdentity, directoryIdentity, markerIdentity: marker.identity };
}

async function privateDirectoryIdentity(directory: string): Promise<FileIdentity> {
  const entry = await lstat(directory, { bigint: true }); const expectedUid = process.getuid?.();
  const unsafe = !entry.isDirectory() || entry.isSymbolicLink() || entry.nlink < 2n || (entry.mode & 0o777n) !== 0o700n || await realpath(directory) !== directory || (expectedUid !== undefined && entry.uid !== BigInt(expectedUid));
  if (unsafe) { throw new LocalSolanaError("SOLANA_CLEANUP_SUBSTITUTION", "private directory was substituted"); }
  return fileIdentity(entry);
}
async function assertDirectoryIdentity(directory: string, expected: FileIdentity): Promise<void> { if (!sameIdentity(await privateDirectoryIdentity(directory), expected)) { throw new LocalSolanaError("SOLANA_CLEANUP_IDENTITY", "private directory identity changed"); } }

async function readLease(directory: string): Promise<{ readonly raw: Record<string, unknown>; readonly identity: FileIdentity }> {
  const handle = await open(join(directory, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await handle.stat({ bigint: true }); assertPrivateMarkerStat(entry); const identity = fileIdentity(entry);
    const content = await readBoundedMarker(handle);
    let raw: unknown; try { raw = JSON.parse(content); } catch { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "lease is not valid JSON"); }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "lease is not an object"); }
    const after = await handle.stat({ bigint: true }); assertPrivateMarkerStat(after); if (!sameIdentity(identity, fileIdentity(after))) { throw new LocalSolanaError("SOLANA_CLEANUP_IDENTITY", "lease marker identity changed while reading"); }
    return { raw: raw as Record<string, unknown>, identity };
  } finally { await handle.close(); }
}

async function rewriteLease(directory: string, raw: Record<string, unknown>, expected: Pick<RunPaths, "rootIdentity" | "directoryIdentity" | "markerIdentity">): Promise<void> {
  await assertDirectoryIdentity(dirname(directory), expected.rootIdentity); await assertDirectoryIdentity(directory, expected.directoryIdentity);
  const handle = await open(join(directory, MARKER), constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const entry = await handle.stat({ bigint: true }); assertPrivateMarkerStat(entry); if (!sameIdentity(fileIdentity(entry), expected.markerIdentity)) { throw new LocalSolanaError("SOLANA_CLEANUP_IDENTITY", "lease marker identity changed before update"); }
    await handle.truncate(0); await handle.writeFile(`${JSON.stringify(raw)}\n`); await handle.sync();
    const after = await handle.stat({ bigint: true }); assertPrivateMarkerStat(after); if (!sameIdentity(fileIdentity(after), expected.markerIdentity)) { throw new LocalSolanaError("SOLANA_CLEANUP_IDENTITY", "lease marker identity changed during update"); }
  } finally { await handle.close(); }
  await assertDirectoryIdentity(dirname(directory), expected.rootIdentity); await assertDirectoryIdentity(directory, expected.directoryIdentity);
}

function assertPrivateMarkerStat(entry: import("node:fs").BigIntStats): void {
  assertMarkerBounds(entry);
  const expectedUid = process.getuid?.();
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || (entry.mode & 0o777n) !== 0o600n || (expectedUid !== undefined && entry.uid !== BigInt(expectedUid))) { throw new LocalSolanaError("SOLANA_LEASE_UNSAFE", "lease must be an owned private singly-linked regular file"); }
}
function fileIdentity(entry: { readonly dev: bigint; readonly ino: bigint }): FileIdentity { return { dev: entry.dev.toString(), ino: entry.ino.toString() }; }
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
function parseFileIdentity(value: unknown): FileIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "filesystem identity is invalid"); }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).toSorted().join(",") !== "dev,ino" || typeof raw.dev !== "string" || typeof raw.ino !== "string" || !/^[0-9]+$/u.test(raw.dev) || !/^[0-9]+$/u.test(raw.ino)) { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "filesystem identity is invalid"); }
  return { dev: raw.dev, ino: raw.ino };
}

function parseLease(raw: Record<string, unknown>): Lease {
  const valid = Object.keys(raw).toSorted().join(",") === "directoryIdentity,kind,markerIdentity,pid,processStart,rootIdentity,schemaVersion,token,validator"
    && raw.schemaVersion === 4 && raw.kind === "agtmai-local-solana" && typeof raw.pid === "number" && Number.isSafeInteger(raw.pid) && raw.pid >= 1
    && typeof raw.token === "string" && /^[a-f0-9]{64}$/u.test(raw.token) && typeof raw.processStart === "string" && /^(?:linux:[0-9]+|darwin:[a-f0-9]+)$/u.test(raw.processStart);
  if (!valid) { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "owned lease is invalid"); }
  return { pid: raw.pid as number, processStart: raw.processStart as string, token: raw.token as string,
    rootIdentity: parseFileIdentity(raw.rootIdentity), directoryIdentity: parseFileIdentity(raw.directoryIdentity), markerIdentity: parseFileIdentity(raw.markerIdentity),
    validator: raw.validator === null ? null : parseValidatorIdentity(raw.validator) };
}

function parseValidatorIdentity(child: unknown): ValidatorIdentity {
  if (typeof child !== "object" || child === null || Array.isArray(child)) { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "validator identity is invalid"); }
  const identity = child as Record<string, unknown>;
  const childValid = Object.keys(identity).toSorted().join(",") === "bindAddress,commandHash,executable,leaseTokenHash,ledger,pid,platform,rpcPort,startTime"
    && validValidatorProcess(identity) && validValidatorCommand(identity) && validValidatorNetwork(identity);
  if (!childValid) { throw new LocalSolanaError("SOLANA_LEASE_INVALID", "validator identity is invalid"); }
  return identity as unknown as ValidatorIdentity;
}

function validValidatorProcess(identity: Record<string, unknown>): boolean {
  return typeof identity.pid === "number" && Number.isSafeInteger(identity.pid) && identity.pid >= 1 && (identity.platform === "linux" || identity.platform === "darwin")
    && typeof identity.startTime === "string" && /^(?:linux:[0-9]+|darwin:[a-f0-9]+)$/u.test(identity.startTime);
}
function validValidatorCommand(identity: Record<string, unknown>): boolean {
  return typeof identity.executable === "string" && identity.executable.startsWith("/") && typeof identity.ledger === "string" && identity.ledger.startsWith("/")
    && typeof identity.commandHash === "string" && /^[a-f0-9]{64}$/u.test(identity.commandHash) && typeof identity.leaseTokenHash === "string" && /^[a-f0-9]{64}$/u.test(identity.leaseTokenHash);
}
function validValidatorNetwork(identity: Record<string, unknown>): boolean {
  return identity.bindAddress === "127.0.0.1" && typeof identity.rpcPort === "number" && Number.isSafeInteger(identity.rpcPort) && identity.rpcPort >= 1 && identity.rpcPort <= 65_535;
}

async function quarantineAndDeleteRun(root: string, directory: string, validated: ValidatedRun, stale = false): Promise<boolean> {
  const quarantine = join(root, ".quarantine-" + validated.lease.token);
  if (!await claimRunQuarantine(root, directory, validated, stale)) { return false; }
  try {
    await assertDirectoryIdentity(root, validated.rootIdentity); await assertDirectoryIdentity(quarantine, validated.directoryIdentity);
    const marker = await readLease(quarantine); const lease = parseLease(marker.raw);
    if (!sameIdentity(marker.identity, validated.markerIdentity) || lease.token !== validated.lease.token || !sameIdentity(lease.rootIdentity, validated.rootIdentity) || !sameIdentity(lease.directoryIdentity, validated.directoryIdentity)) { throw new LocalSolanaError("SOLANA_CLEANUP_IDENTITY", "quarantined run identity changed"); }
    await assertDirectoryIdentity(root, validated.rootIdentity); await assertDirectoryIdentity(quarantine, validated.directoryIdentity); const finalMarker = await readLease(quarantine); if (!sameIdentity(finalMarker.identity, validated.markerIdentity)) { throw new LocalSolanaError("SOLANA_CLEANUP_IDENTITY", "quarantined marker changed before deletion"); }
    await rm(quarantine, { recursive: true, force: false, maxRetries: 2 }); await assertDirectoryIdentity(root, validated.rootIdentity);
  } catch (cause) { const currentRoot = await privateDirectoryIdentity(root).catch(() => null); if (currentRoot !== null && sameIdentity(currentRoot, validated.rootIdentity)) { await rename(quarantine, directory).catch(() => {}); } throw cause; }
  return true;
}

/** Acquire the quarantine before deletion; only authenticated pre-claim absence is benign. */
async function claimRunQuarantine(root: string, directory: string, validated: ValidatedRun, stale: boolean): Promise<boolean> {
  const quarantine = join(root, ".quarantine-" + validated.lease.token);
  try {
    await assertDirectoryIdentity(root, validated.rootIdentity);
    let settled: boolean;
    try { settled = await startupCustodySettled(directory, validated.lease.token, validated.lease.validator !== null); }
    catch (cause) {
      // A competitor can unlink the already-open marker during stat/read too.
      // Only authenticated source absence before our rename makes this benign.
      if (stale && await staleRunIsAbsent(root, directory, validated.rootIdentity)) { return false; }
      throw cause;
    }
    if (!settled) {
      if (stale && await staleRunIsAbsent(root, directory, validated.rootIdentity)) { return false; }
      throw new LocalSolanaError("SOLANA_STARTUP_CUSTODY", "startup custody has not settled");
    }
    if (stale && validated.lease.validator !== null) { await terminateAuthenticatedValidator(validated.lease, directory); }
    const before = await validateOwnedRun(root, directory, true, validated);
    if (before.lease.token !== validated.lease.token) { throw new LocalSolanaError("SOLANA_CLEANUP_IDENTITY", "run identity changed before quarantine"); }
    if (await exists(quarantine)) {
      if (stale && await staleRunIsAbsent(root, directory, validated.rootIdentity)) { return false; }
      throw new LocalSolanaError("SOLANA_CLEANUP_QUARANTINE", "quarantine target already exists");
    }
    await rename(directory, quarantine);
  } catch (cause) {
    // Only a lost pre-claim source is benign. Failures after our rename remain errors.
    if (stale && (cause as NodeJS.ErrnoException).code === "ENOENT" && await staleRunIsAbsent(root, directory, validated.rootIdentity)) { return false; }
    throw cause;
  }
  return true;
}

async function staleRunIsAbsent(root: string, directory: string, rootIdentity: FileIdentity): Promise<boolean> {
  await assertDirectoryIdentity(root, rootIdentity);
  // lstat must observe dangling symlinks and other replacements as present.
  const entry = await lstat(directory).catch((cause) => { if ((cause as NodeJS.ErrnoException).code === "ENOENT") { return null; } throw cause; });
  await assertDirectoryIdentity(root, rootIdentity);
  return entry === null;
}

async function terminateAuthenticatedValidator(lease: Lease, directory: string): Promise<void> {
  const identity = lease.validator;
  if (identity === null || exitProven(await observeExit(identity.pid, identity.startTime))) { return; }
  const expectedLedger = await realpath(join(directory, "ledger"));
  if (identity.ledger !== expectedLedger) { throw new LocalSolanaError("SOLANA_RECLAIM_IDENTITY", "validator ledger changed before termination"); }
  if (!await authenticateBeforeSignal(identity, lease.token)) { return; }
  await signalValidator(identity, "SIGTERM");
  if (!await awaitExit(identity, lease.token, 5_000)) {
    if (!await authenticateBeforeSignal(identity, lease.token)) { return; }
    await signalValidator(identity, "SIGKILL");
    if (!await awaitExit(identity, lease.token, 5_000)) { throw new LocalSolanaError("SOLANA_RECLAIM_TIMEOUT", "owned stale validator did not exit"); }
  }
}

async function authenticateBeforeSignal(identity: ValidatorIdentity, token: string): Promise<boolean> {
  const failures = await validatorIdentityAuthenticationFailures(identity, token);
  rejectIdentityMismatch(failures);
  if (failures.length === 0) { return true; }
  if (exitProven(await observeExit(identity.pid, identity.startTime))) { return false; }
  throw new LocalSolanaError("SOLANA_RECLAIM_IDENTITY", "validator identity unavailable before signal");
}

function rejectIdentityMismatch(failures: readonly string[]): void {
  if (failures.some((failure) => failure !== "observation")) { throw new LocalSolanaError("SOLANA_RECLAIM_IDENTITY", "validator identity changed during termination"); }
}

async function signalValidator(identity: ValidatorIdentity, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  try { process.kill(identity.pid, signal); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ESRCH" && exitProven(await observeExit(identity.pid, identity.startTime))) { return; }
    throw cause;
  }
}

async function awaitExit(identity: ValidatorIdentity, token: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const outcome = await observeExit(identity.pid, identity.startTime);
    if (exitProven(outcome)) { return true; }
    rejectIdentityMismatch(await validatorIdentityAuthenticationFailures(identity, token));
    if (Date.now() >= deadline) { return exitProven(await observeExit(identity.pid, identity.startTime)); }
    await delay(50);
  }
}

function exitProven(outcome: ExitObservation): boolean {
  if (outcome === "replaced") { throw new LocalSolanaError("SOLANA_RECLAIM_IDENTITY", "validator process start changed during termination"); }
  return outcome === "exited";
}

type ExitObservation = "exited" | "live" | "replaced" | "unproven";

async function processExited(pid: number, startTime: string): Promise<boolean> {
  return await observeExit(pid, startTime) === "exited";
}

/** Only fresh PID absence or the original-start zombie proves termination. */
async function observeExit(pid: number, startTime: string): Promise<ExitObservation> {
  try { process.kill(pid, 0); }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === "ESRCH" ? "exited" : "unproven"; }
  if (process.platform !== "linux") { return "unproven"; }
  try {
    const procStat = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = procStat.lastIndexOf(")");
    const fields = end < 0 ? [] : procStat.slice(end + 2).trim().split(/\s+/u);
    if (fields[19] === undefined || !/^[0-9]+$/u.test(fields[19]) || fields[0] === undefined || !/^[RSDZTtWXxKIP]$/u.test(fields[0])) { return "unproven"; }
    if (`linux:${fields[19]}` !== startTime) { return "replaced"; }
    return fields[0] === "Z" ? "exited" : "live";
  } catch (cause) {
    if (["ENOENT", "ESRCH"].includes((cause as NodeJS.ErrnoException).code ?? "")) {
      // A missing procfs entry alone is not proof: re-probe the PID now.
      try { process.kill(pid, 0); }
      catch (probeCause) { if ((probeCause as NodeJS.ErrnoException).code === "ESRCH") { return "exited"; } }
    }
    return "unproven";
  }
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
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ESRCH"; } }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") { return false; } throw cause; } }
function markdown(report: EvidenceReport): string { return `# Local Solana SPL fixture evidence\n\n- Status: READY\n- Mint: ${report.mintAddress}\n- Program: ${report.programId}\n- Authenticated RPC listener scope: ${report.rpcListener.scope}\n- Decimals: ${report.decimals}\n- Supply: ${report.initialSupply} -> ${report.intermediateSupply} -> ${report.finalSupply}\n- Freeze authority: None\n- Signed restore/freeze attempts: reached Token Program and failed\n- Public network: false\n- Real asset cost USD: 0\n- Mint authority revoked: false\n- Authority key retained: false\n- Remint possible until teardown: true\n- Production hard cap proven: false\n`; }
function assertFailureEvidence(value: FailureEvidenceReport): void {
  const keys = Object.keys(value).toSorted().join(",");
  const expected = "cleanupCompleted,diagnosticCode,failedPhase,mutationsMayHaveOccurred,portLeaseReleased,privateDirectoryRemoved,productionApproved,publicNetwork,realAssetCostUsd,schemaVersion,secretsRetained,status,validatorStopped";
  const valid = keys === expected && value.schemaVersion === 1 && value.status === "FAILED"
    && FAILURE_PHASES.includes(value.failedPhase) && /^[A-Z][A-Z0-9_]{2,95}$/u.test(value.diagnosticCode)
    && value.mutationsMayHaveOccurred === true && typeof value.cleanupCompleted === "boolean"
    && typeof value.validatorStopped === "boolean" && typeof value.portLeaseReleased === "boolean" && typeof value.privateDirectoryRemoved === "boolean"
    && value.publicNetwork === false && value.realAssetCostUsd === 0
    && value.cleanupCompleted === (value.validatorStopped && value.portLeaseReleased && value.privateDirectoryRemoved)
    && value.secretsRetained === !value.privateDirectoryRemoved && value.productionApproved === false;
  if (!valid) { throw new LocalSolanaError("SOLANA_FAILURE_EVIDENCE_SCHEMA", "failure evidence fields are invalid"); }
}
function failureMarkdown(report: FailureEvidenceReport): string { return `# Local Solana SPL fixture failure evidence\n\n- Status: FAILED\n- Failed phase: ${report.failedPhase}\n- Diagnostic: ${report.diagnosticCode}\n- Mutation may have occurred: true\n- Cleanup completed: ${report.cleanupCompleted}\n- Validator stopped: ${report.validatorStopped}\n- Port lease released: ${report.portLeaseReleased}\n- Private directory removed: ${report.privateDirectoryRemoved}\n- Public network: false\n- Real asset cost USD: 0\n- Secrets retained: ${report.secretsRetained}\n- Production approved: false\n`; }
function stableValue(value: unknown): string {
  if (Array.isArray(value)) { return `[${value.map(stableValue).join(",")}]`; }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
