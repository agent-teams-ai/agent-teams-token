import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileIdentity } from "../application/ports.ts";
import { LocalSolanaError } from "../domain/model.ts";
import { processStartIdentity } from "./process-identity.ts";
import { readBoundedMarker } from "./lease-marker.ts";

const MARKER = ".agtmai-validator-startup.json";
const PENDING = ".agtmai-validator-startup-pending.json";
// Reservation finishes before forking; the acquired supervisor is the sole later writer.
// Serialize its overlapping stage, failure and settlement callbacks on that inode.
const markerWrites = new Map<string, Promise<void>>();
async function serializeMarkerWrite<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = markerWrites.get(directory);
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  markerWrites.set(directory, current);
  try {
    if (previous !== undefined) { await previous; }
    return await action();
  } finally {
    if (markerWrites.get(directory) === current) { markerWrites.delete(directory); }
    release?.();
  }
}
export interface StartupCustody {
  readonly directory: string;
  readonly directoryIdentity: FileIdentity;
  readonly markerIdentity: FileIdentity;
  readonly token: string;
}
interface CustodyRecord extends StartupCustody {
  readonly supervisor: { readonly pid: number; readonly start: string } | null;
  readonly settled: boolean;
  readonly diagnostic?: StartupDiagnostic;
}
export type StartupStage = "reserved" | "supervisor-acquired" | "spawn-requested" | "spawned" | "identity-captured" | "registered" | "stopping" | "settled" | "failed";
export interface StartupDiagnostic {
  readonly stage: StartupStage;
  readonly at: string;
  readonly failure?: { readonly phase: StartupStage; readonly code: string };
}
const STAGES: readonly StartupStage[] = ["reserved", "supervisor-acquired", "spawn-requested", "spawned", "identity-captured", "registered", "stopping", "settled", "failed"];
const FAILURE_CODES: readonly string[] = ["EACCES", "EADDRINUSE", "EEXIST", "EIO", "EINVAL", "EMFILE", "ENFILE", "ENOENT", "ENOMEM", "ENOSPC", "EPERM", "ETIMEDOUT", "SOLANA_CHILD_STOP_TIMEOUT", "SOLANA_COMMAND_ABORTED", "SOLANA_STARTUP_CUSTODY", "SOLANA_VALIDATOR_EARLY_EXIT", "SOLANA_VALIDATOR_IDENTITY", "SOLANA_VALIDATOR_PORT_COLLISION", "SOLANA_VALIDATOR_SUPERVISOR_TIMEOUT", "UNKNOWN"];
export function isStartupFailureCode(value: unknown): value is string { return typeof value === "string" && FAILURE_CODES.includes(value); }
const safeCode = (cause: unknown): string => {
  try { const code = (cause as { readonly code?: unknown } | null)?.code; return isStartupFailureCode(code) ? code : "UNKNOWN"; }
  catch { return "UNKNOWN"; }
};
export function startupFailureCode(cause: unknown): string { return safeCode(cause); }

/** Created with the private run, before any caller can start a validator. */
export async function initializeStartupCustody(directory: string, token: string): Promise<void> {
  const directoryIdentity = await privateDirectory(directory);
  const handle = await open(join(directory, MARKER), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const markerIdentity = identity(await handle.stat({ bigint: true }));
    await handle.writeFile(JSON.stringify({ directory, directoryIdentity, markerIdentity, token, supervisor: null, settled: true, diagnostic: { stage: "settled", at: new Date().toISOString() } }));
    await handle.sync();
  } finally { await handle.close(); }
}

/** Reserve durable uncertainty while the owner is alive, before even forking. */
export async function reserveStartupCustody(ledger: string, token: string): Promise<StartupCustody> {
  const directory = await realpath(dirname(ledger)); const directoryIdentity = await privateDirectory(directory);
  return await serializeMarkerWrite(directory, async () => {
    let fresh = true;
    const handle = await open(join(directory, MARKER), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600).catch(async (cause) => {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") { throw cause; }
      fresh = false;
      return await open(join(directory, MARKER), constants.O_RDWR | constants.O_NOFOLLOW);
    });
    try {
      if (!fresh && !(await readRecord(handle, directory, token)).settled) { invalid(); }
      const entry = await handle.stat({ bigint: true });
      const custody = { directory, directoryIdentity, markerIdentity: identity(entry), token };
      // This durable guard precedes every possible child spawn. A failed settlement
      // sync must not make a visible `settled: true` marker sufficient for cleanup.
      await createPending(custody);
      const bytes = Buffer.from(JSON.stringify({ ...custody, supervisor: null, settled: false, diagnostic: { stage: "reserved", at: new Date().toISOString() } }));
      await publishRecord(handle, bytes);
      await syncDirectory(directory);
      await assertDirectory(custody);
      return custody;
    } finally { await handle.close(); }
  });
}

/** Only the supervisor that acquired this record may settle it after child close. */
export async function updateStartupCustody(custody: StartupCustody, settled: boolean): Promise<void> {
  await serializeMarkerWrite(custody.directory, async () => {
    await assertDirectory(custody);
    const handle = await open(join(custody.directory, MARKER), constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const record = await readRecord(handle, custody.directory, custody.token);
      const current = { pid: process.pid, start: await processStartIdentity(process.pid) };
      if (!same(record.markerIdentity, custody.markerIdentity) || record.settled || (settled
        ? record.supervisor?.pid !== current.pid || record.supervisor.start !== current.start
        : record.supervisor !== null)) { invalid(); }
      if (settled) { await assertPending(custody); }
      const bytes = Buffer.from(JSON.stringify({ ...record, supervisor: current, settled, diagnostic: { ...record.diagnostic, stage: settled ? "settled" : "supervisor-acquired", at: new Date().toISOString() } }));
      await publishRecord(handle, bytes);
      await assertDirectory(custody);
      if (settled) { await clearPending(custody); }
    } finally { await handle.close(); }
  });
}

/** Durable, bounded, allowlisted diagnosis; exception text and child output never enter the marker. */
export async function recordStartupStage(custody: StartupCustody, stage: StartupStage, failure?: { readonly phase: StartupStage; readonly cause: unknown }): Promise<void> {
  await serializeMarkerWrite(custody.directory, async () => {
    await assertDirectory(custody);
    const handle = await open(join(custody.directory, MARKER), constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const record = await readRecord(handle, custody.directory, custody.token);
      const preAcquireFailure = record.supervisor === null && stage === "failed" && failure?.phase === "reserved";
      const currentStart = preAcquireFailure ? null : await processStartIdentity(process.pid);
      assertStageWriter(record, custody, stage, currentStart);
      const failureEvidence = failure === undefined ? record.diagnostic?.failure : { phase: failure.phase, code: safeCode(failure.cause) };
      const diagnostic: StartupDiagnostic = { stage, at: new Date().toISOString(), ...(failureEvidence === undefined ? {} : { failure: failureEvidence }) };
      const bytes = Buffer.from(JSON.stringify({ ...record, diagnostic }));
      await publishRecord(handle, bytes);
      await assertDirectory(custody);
    } finally { await handle.close(); }
  });
}

function assertStageWriter(record: CustodyRecord, custody: StartupCustody, stage: StartupStage, currentStart: string | null): void {
  if (!same(record.markerIdentity, custody.markerIdentity) || record.settled || (record.diagnostic?.stage === "stopping" && stage !== "failed")
    || (record.diagnostic?.stage === "failed" && stage !== "stopping" && stage !== "failed")
    || (currentStart !== null && (record.supervisor?.pid !== process.pid || record.supervisor.start !== currentStart))) { invalid(); }
}

async function publishRecord(handle: import("node:fs/promises").FileHandle, bytes: Buffer): Promise<void> {
  // Keep the inode bound to custody. A short or failed write remains uncertain.
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, written);
    if (result.bytesWritten < 1) { invalid(); }
    written += result.bytesWritten;
  }
  await handle.truncate(bytes.length);
  await handle.sync();
}

async function createPending(custody: StartupCustody): Promise<void> {
  const handle = await open(join(custody.directory, PENDING), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(custody)); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(custody.directory);
}

async function assertPending(custody: StartupCustody): Promise<void> {
  await assertDirectory(custody);
  const handle = await open(join(custody.directory, PENDING), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await handle.stat({ bigint: true });
    if (!entry.isFile() || entry.nlink !== 1n || (entry.mode & 0o777n) !== 0o600n || (process.getuid !== undefined && entry.uid !== BigInt(process.getuid()))) { invalid(); }
    const record = JSON.parse(await readBoundedMarker(handle)) as StartupCustody;
    if (record === null || typeof record !== "object" || Object.keys(record).toSorted().join(",") !== "directory,directoryIdentity,markerIdentity,token"
      || record.directory !== custody.directory || record.token !== custody.token || !same(record.directoryIdentity, custody.directoryIdentity)
      || !same(record.markerIdentity, custody.markerIdentity)) { invalid(); }
  } finally { await handle.close(); }
  await assertDirectory(custody);
}

async function clearPending(custody: StartupCustody): Promise<void> {
  await assertPending(custody);
  await unlink(join(custody.directory, PENDING));
  await syncDirectory(custody.directory);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readStartupDiagnostic(directory: string, token: string): Promise<StartupDiagnostic> {
  const handle = await open(join(directory, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return (await readRecord(handle, directory, token)).diagnostic ?? { stage: "reserved", at: "unknown" }; }
  finally { await handle.close(); }
}

export async function startupCustodySettled(directory: string, token: string, legacyRegistered = false): Promise<boolean> {
  const handle = await open(join(directory, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") { return null; } throw cause;
  });
  if (handle === null) { return legacyRegistered && !await pendingExists(directory); }
  try {
    const record = await readRecord(handle, directory, token);
    if (!record.settled) { return false; }
    const pending = await pendingExists(directory);
    if (!same(record.directoryIdentity, await privateDirectory(directory))) { invalid(); }
    return !pending;
  }
  finally { await handle.close(); }
}

async function pendingExists(directory: string): Promise<boolean> {
  return await lstat(join(directory, PENDING)).then(() => true, (cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") { return false; }
    throw cause;
  });
}

async function readRecord(handle: import("node:fs/promises").FileHandle, directory: string, token: string): Promise<CustodyRecord> {
  const entry = await handle.stat({ bigint: true });
  assertPrivateMarker(entry);
  const record = JSON.parse(await readBoundedMarker(handle)) as CustodyRecord;
  assertRecordShape(record, entry, directory, token);
  if (!same(record.directoryIdentity, await privateDirectory(directory))) { invalid(); }
  assertSupervisor(record.supervisor);
  assertDiagnostic(record.diagnostic);
  const after = await handle.stat({ bigint: true });
  if (after.nlink !== 1n || after.mode !== entry.mode || after.uid !== entry.uid || !same(identity(after), identity(entry))) { invalid(); }
  return record;
}
function assertPrivateMarker(entry: import("node:fs").BigIntStats): void {
  if (!entry.isFile() || entry.nlink !== 1n || (entry.mode & 0o777n) !== 0o600n || (process.getuid !== undefined && entry.uid !== BigInt(process.getuid()))) { invalid(); }
}
function assertRecordShape(record: CustodyRecord, entry: import("node:fs").BigIntStats, directory: string, token: string): void {
  if (record === null || typeof record !== "object" || !["directory,directoryIdentity,markerIdentity,settled,supervisor,token", "diagnostic,directory,directoryIdentity,markerIdentity,settled,supervisor,token"].includes(Object.keys(record).toSorted().join(","))
    || record.directory !== directory || record.token !== token || typeof record.settled !== "boolean"
    || !same(record.markerIdentity, identity(entry))) { invalid(); }
}
function assertDiagnostic(diagnostic: StartupDiagnostic | undefined): void {
  if (diagnostic !== undefined && (diagnostic === null || typeof diagnostic !== "object" || !STAGES.includes(diagnostic.stage) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(diagnostic.at)
    || !["at,stage", "at,failure,stage"].includes(Object.keys(diagnostic).toSorted().join(","))
    || (diagnostic.failure !== undefined && (diagnostic.failure === null || typeof diagnostic.failure !== "object" || !STAGES.includes(diagnostic.failure.phase) || !isStartupFailureCode(diagnostic.failure.code)
      || Object.keys(diagnostic.failure).toSorted().join(",") !== "code,phase")))) { invalid(); }
}
function assertSupervisor(supervisor: CustodyRecord["supervisor"]): void {
  if (supervisor !== null && (typeof supervisor !== "object" || !Number.isSafeInteger(supervisor.pid) || supervisor.pid < 1
    || typeof supervisor.start !== "string" || !/^(?:linux:[0-9]+|darwin:[a-f0-9]+)$/u.test(supervisor.start))) { invalid(); }
}
async function privateDirectory(directory: string): Promise<FileIdentity> {
  const entry = await lstat(directory, { bigint: true });
  if (!entry.isDirectory() || (entry.mode & 0o777n) !== 0o700n || await realpath(directory) !== directory
    || (process.getuid !== undefined && entry.uid !== BigInt(process.getuid()))) { invalid(); }
  return identity(entry);
}
async function assertDirectory(custody: StartupCustody): Promise<void> {
  if (!same(await privateDirectory(custody.directory), custody.directoryIdentity)) { invalid(); }
}
function identity(entry: { readonly dev: bigint; readonly ino: bigint }): FileIdentity { return { dev: String(entry.dev), ino: String(entry.ino) }; }
function same(left: FileIdentity | undefined, right: FileIdentity): boolean { return left?.dev === right.dev && left.ino === right.ino; }
function invalid(): never { throw new LocalSolanaError("SOLANA_STARTUP_CUSTODY", "startup custody is uncertain or substituted; preserving run"); }
