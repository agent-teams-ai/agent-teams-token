import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FileIdentity } from "../application/ports.ts";
import { LocalSolanaError } from "../domain/model.ts";
import { processStartIdentity } from "./process-identity.ts";
import { readBoundedMarker } from "./lease-marker.ts";

const MARKER = ".agtmai-validator-startup.json";
export interface StartupCustody {
  readonly directory: string;
  readonly directoryIdentity: FileIdentity;
  readonly markerIdentity: FileIdentity;
  readonly token: string;
}
interface CustodyRecord extends StartupCustody {
  readonly supervisor: { readonly pid: number; readonly start: string } | null;
  readonly settled: boolean;
}

/** Created with the private run, before any caller can start a validator. */
export async function initializeStartupCustody(directory: string, token: string): Promise<void> {
  const directoryIdentity = await privateDirectory(directory);
  const handle = await open(join(directory, MARKER), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const markerIdentity = identity(await handle.stat({ bigint: true }));
    await handle.writeFile(JSON.stringify({ directory, directoryIdentity, markerIdentity, token, supervisor: null, settled: true }));
    await handle.sync();
  } finally { await handle.close(); }
}

/** Reserve durable uncertainty while the owner is alive, before even forking. */
export async function reserveStartupCustody(ledger: string, token: string): Promise<StartupCustody> {
  const directory = await realpath(dirname(ledger)); const directoryIdentity = await privateDirectory(directory);
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
    const bytes = Buffer.from(JSON.stringify({ ...custody, supervisor: null, settled: false }));
    await handle.truncate(0); await handle.write(bytes, 0, bytes.length, 0); await handle.sync();
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    await assertDirectory(custody);
    return custody;
  } finally { await handle.close(); }
}

/** Only the supervisor that acquired this record may settle it after child close. */
export async function updateStartupCustody(custody: StartupCustody, settled: boolean): Promise<void> {
  await assertDirectory(custody);
  const handle = await open(join(custody.directory, MARKER), constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const record = await readRecord(handle, custody.directory, custody.token);
    const current = { pid: process.pid, start: await processStartIdentity(process.pid) };
    if (!same(record.markerIdentity, custody.markerIdentity) || record.settled || (settled
      ? record.supervisor?.pid !== current.pid || record.supervisor.start !== current.start
      : record.supervisor !== null)) { invalid(); }
    const bytes = Buffer.from(JSON.stringify({ ...record, supervisor: current, settled }));
    await handle.truncate(0); await handle.write(bytes, 0, bytes.length, 0); await handle.sync();
    await assertDirectory(custody);
  } finally { await handle.close(); }
}

export async function startupCustodySettled(directory: string, token: string, legacyRegistered = false): Promise<boolean> {
  const handle = await open(join(directory, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") { return null; } throw cause;
  });
  if (handle === null) { return legacyRegistered; }
  try { return (await readRecord(handle, directory, token)).settled; }
  finally { await handle.close(); }
}

async function readRecord(handle: import("node:fs/promises").FileHandle, directory: string, token: string): Promise<CustodyRecord> {
  const entry = await handle.stat({ bigint: true });
  if (!entry.isFile() || entry.nlink !== 1n || (entry.mode & 0o777n) !== 0o600n || (process.getuid !== undefined && entry.uid !== BigInt(process.getuid()))) { invalid(); }
  const record = JSON.parse(await readBoundedMarker(handle)) as CustodyRecord;
  if (record === null || Object.keys(record).toSorted().join(",") !== "directory,directoryIdentity,markerIdentity,settled,supervisor,token"
    || record.directory !== directory || record.token !== token || typeof record.settled !== "boolean"
    || !same(record.markerIdentity, identity(entry)) || !same(record.directoryIdentity, await privateDirectory(directory))) { invalid(); }
  if (record.supervisor !== null && (typeof record.supervisor !== "object" || !Number.isSafeInteger(record.supervisor.pid) || record.supervisor.pid < 1
    || typeof record.supervisor.start !== "string" || !/^(?:linux:[0-9]+|darwin:[a-f0-9]+)$/u.test(record.supervisor.start))) { invalid(); }
  const after = await handle.stat({ bigint: true });
  if (after.nlink !== 1n || after.mode !== entry.mode || after.uid !== entry.uid || !same(identity(after), identity(entry))) { invalid(); }
  return record;
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
