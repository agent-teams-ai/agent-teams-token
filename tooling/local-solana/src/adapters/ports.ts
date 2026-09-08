import { randomBytes, randomInt } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { LocalSolanaError } from "../domain/model.ts";
import type { PortAllocator, PortLease } from "../application/ports.ts";
import { processStartIdentity } from "./process-identity.ts";

const DYNAMIC_WIDTH = 128;
const BLOCK_WIDTH = 132;
const FIRST_PORT = 20_000;
const BLOCK_COUNT = Math.floor((60_000 - FIRST_PORT) / BLOCK_WIDTH);
const MARKER = "lease.json";
const KIND = "agtmai-local-solana-port-lease";

interface EntryIdentity { readonly dev: bigint; readonly ino: bigint; }
interface LeaseRoot { readonly path: string; readonly identity: EntryIdentity; }
interface LeaseRecord {
  readonly schemaVersion: 1; readonly kind: typeof KIND; readonly pid: number; readonly processStart: string; readonly token: string;
  readonly rootDevice: string; readonly rootInode: string; readonly directoryDevice: string; readonly directoryInode: string; readonly markerDevice: string; readonly markerInode: string;
}
interface AcquiredLease { readonly directory: string; readonly token: string; readonly rootIdentity: EntryIdentity; readonly directoryIdentity: EntryIdentity; readonly markerIdentity: EntryIdentity; }

/** Cross-process lease directories serialize every fixture-owned port block. */
export class LoopbackPortAllocator implements PortAllocator {
  private readonly root: string;
  public constructor(root = defaultLeaseRoot()) { this.root = resolve(root); }

  public async allocate(): Promise<PortLease> {
    const leaseRoot = await ensureLeaseRoot(this.root); const root = leaseRoot.path;
    await reclaimStaleLeases(root, leaseRoot.identity);
    const processStart = await processStartIdentity(process.pid);
    const offset = randomInt(0, BLOCK_COUNT);
    for (let attempt = 0; attempt < Math.min(BLOCK_COUNT, 40); attempt += 1) {
      const index = (offset + attempt) % BLOCK_COUNT;
      const start = FIRST_PORT + index * BLOCK_WIDTH;
      const directory = join(root, `block-${index}`);
      let acquired = await acquire(directory, processStart, leaseRoot.identity);
      if (acquired === null) {
        await reclaimStale(root, leaseRoot.identity, directory);
        acquired = await acquire(directory, processStart, leaseRoot.identity);
        if (acquired === null) { continue; }
      }
      const held = acquired;
      try {
        for (let port = start; port < start + BLOCK_WIDTH; port += 1) {
          if (!await canListen(port)) { throw new LocalSolanaError("SOLANA_PORT_BUSY", `leased loopback block contains unavailable port ${port}`); }
        }
        let released = false;
        return {
          gossipPort: start,
          dynamicPortRange: `${start}-${start + DYNAMIC_WIDTH - 1}`,
          rpcPort: start + DYNAMIC_WIDTH,
          faucetPort: start + DYNAMIC_WIDTH + 2,
          release: async () => {
            if (released) { return; }
            await releaseAcquired(root, held);
            released = true;
          },
        };
      } catch (cause) {
        await releaseAcquired(root, held).catch(() => {});
        if (!(cause instanceof LocalSolanaError) || cause.code !== "SOLANA_PORT_BUSY") { throw cause; }
      }
    }
    throw new LocalSolanaError("SOLANA_PORT_ALLOCATION", "could not acquire a distinct cross-process loopback port block");
  }
}

function defaultLeaseRoot(): string {
  const uid = process.getuid?.() ?? 0;
  return process.platform === "darwin" ? `/private/tmp/agtmai-local-solana-port-leases-${uid}` : `/tmp/agtmai-local-solana-port-leases-${uid}`;
}

async function ensureLeaseRoot(path: string): Promise<LeaseRoot> {
  const absolute = resolve(path);
  const parent = await realpath(dirname(absolute)).catch(() => null);
  if (parent === null) { throw new LocalSolanaError("SOLANA_PORT_LEASE_PARENT", "port lease parent is absent or substituted"); }
  const canonical = join(parent, basename(absolute));
  try { await mkdir(canonical, { mode: 0o700 }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") { throw cause; } }
  const entry = await lstat(canonical, { bigint: true });
  const expectedUid = process.getuid?.();
  const unsafe = !entry.isDirectory() || entry.isSymbolicLink() || await realpath(canonical) !== canonical
    || (entry.mode & 0o077n) !== 0n || (expectedUid !== undefined && entry.uid !== BigInt(expectedUid));
  if (unsafe) { throw new LocalSolanaError("SOLANA_PORT_LEASE_ROOT_UNSAFE", "port lease root must be owned mode-0700 with no symlink substitution"); }
  return { path: canonical, identity: identity(entry) };
}

async function acquire(directory: string, processStart: string, rootIdentity: EntryIdentity): Promise<AcquiredLease | null> {
  try { await mkdir(directory, { mode: 0o700 }); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") { return null; }
    throw cause;
  }
  const directoryIdentity = await privateDirectoryIdentity(directory);
  const token = randomBytes(32).toString("hex");
  let handle: FileHandle | undefined;
  try {
    handle = await open(join(directory, MARKER), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const markerStat = await handle.stat({ bigint: true });
    const markerIdentity = identity(markerStat);
    const record: LeaseRecord = {
      schemaVersion: 1, kind: KIND, pid: process.pid, processStart, token,
      rootDevice: `${rootIdentity.dev}`, rootInode: `${rootIdentity.ino}`,
      directoryDevice: `${directoryIdentity.dev}`, directoryInode: `${directoryIdentity.ino}`,
      markerDevice: `${markerIdentity.dev}`, markerInode: `${markerIdentity.ino}`,
    };
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    if (!markerStat.isFile() || markerStat.nlink !== 1n) { throw new LocalSolanaError("SOLANA_PORT_LEASE_MARKER_UNSAFE", "port lease marker must be singly linked"); }
    return { directory, token, rootIdentity, directoryIdentity, markerIdentity };
  } catch (cause) {
    await handle?.close().catch(() => {});
    await rollbackEmptyDirectory(directory, directoryIdentity);
    throw cause;
  } finally { await handle?.close().catch(() => {}); }
}

async function releaseAcquired(root: string, acquired: AcquiredLease): Promise<void> {
  await assertRootIdentity(root, acquired.rootIdentity);
  const record = await validateLease(acquired.directory, acquired.directoryIdentity, acquired.markerIdentity, acquired.token);
  if (record.pid !== process.pid || record.processStart !== await processStartIdentity(process.pid)) {
    throw new LocalSolanaError("SOLANA_PORT_LEASE_OWNER", "port lease no longer belongs to this process identity");
  }
  await quarantineAndDelete(root, acquired);
}

async function reclaimStale(root: string, rootIdentity: EntryIdentity, directory: string): Promise<void> {
  let directoryIdentity: EntryIdentity;
  let markerIdentity: EntryIdentity;
  let record: LeaseRecord;
  try {
    directoryIdentity = await privateDirectoryIdentity(directory);
    const snapshot = await readMarker(directory);
    markerIdentity = snapshot.identity;
    record = snapshot.record;
  } catch { return; }
  if (!await leaseOwnerIsProvablyStale(record.pid, record.processStart)) { return; }
  await assertRootIdentity(root, rootIdentity);
  await quarantineAndDelete(root, { directory, rootIdentity, directoryIdentity, markerIdentity, token: record.token });
}

async function reclaimStaleLeases(root: string, rootIdentity: EntryIdentity): Promise<void> {
  for (const name of await readdir(root)) {
    if (/^block-[0-9]+$/u.test(name)) { await reclaimStale(root, rootIdentity, join(root, name)).catch(() => {}); }
  }
}

async function quarantineAndDelete(root: string, lease: AcquiredLease): Promise<void> {
  const { rootIdentity, directory, directoryIdentity, markerIdentity, token } = lease;
  await assertRootIdentity(root, rootIdentity);
  await validateLease(directory, directoryIdentity, markerIdentity, token);
  const quarantine = join(root, `.release-${token}`);
  try { await rename(directory, quarantine); } catch (cause) {
    throw new LocalSolanaError("SOLANA_PORT_LEASE_SUBSTITUTION", `port lease changed before quarantine: ${cause instanceof Error ? cause.message : "rename failed"}`);
  }
  try {
    await assertRootIdentity(root, rootIdentity);
    await validateLease(quarantine, directoryIdentity, markerIdentity, token);
  } catch (cause) {
    await rename(quarantine, directory).catch(() => {});
    throw cause;
  }
  const names = await readdir(quarantine);
  if (names.length !== 1 || names[0] !== MARKER) {
    await rename(quarantine, directory).catch(() => {});
    throw new LocalSolanaError("SOLANA_PORT_LEASE_CONTENTS", "port lease directory contains unexpected entries");
  }
  await unlink(join(quarantine, MARKER));
  await rmdir(quarantine);
}

async function validateLease(directory: string, expectedDirectory: EntryIdentity, expectedMarker: EntryIdentity, token: string): Promise<LeaseRecord> {
  const actualDirectory = await privateDirectoryIdentity(directory);
  if (!sameIdentity(actualDirectory, expectedDirectory)) { throw new LocalSolanaError("SOLANA_PORT_LEASE_SUBSTITUTION", "port lease directory was substituted"); }
  const snapshot = await readMarker(directory);
  if (!sameIdentity(snapshot.identity, expectedMarker) || snapshot.record.token !== token) {
    throw new LocalSolanaError("SOLANA_PORT_LEASE_SUBSTITUTION", "port lease marker identity or token changed");
  }
  return snapshot.record;
}

async function readMarker(directory: string): Promise<{ readonly identity: EntryIdentity; readonly record: LeaseRecord }> {
  const marker = join(directory, MARKER);
  const entry = await lstat(marker, { bigint: true });
  const expectedUid = process.getuid?.();
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || (entry.mode & 0o077n) !== 0n || (expectedUid !== undefined && entry.uid !== BigInt(expectedUid))) {
    throw new LocalSolanaError("SOLANA_PORT_LEASE_MARKER_UNSAFE", "port lease marker must be owned, private and singly linked");
  }
  let raw: unknown;
  try { raw = JSON.parse(await readFile(marker, "utf8")); } catch { throw new LocalSolanaError("SOLANA_PORT_LEASE_INVALID", "port lease marker is invalid JSON"); }
  const record = parseRecord(raw); const markerIdentity = identity(entry); const directoryIdentity = await privateDirectoryIdentity(directory); const rootIdentity = await privateDirectoryIdentity(dirname(directory));
  const bound = record.rootDevice === `${rootIdentity.dev}` && record.rootInode === `${rootIdentity.ino}`
    && record.directoryDevice === `${directoryIdentity.dev}` && record.directoryInode === `${directoryIdentity.ino}`
    && record.markerDevice === `${markerIdentity.dev}` && record.markerInode === `${markerIdentity.ino}`;
  if (!bound) { throw new LocalSolanaError("SOLANA_PORT_LEASE_SUBSTITUTION", "port lease marker is not bound to the exact filesystem identities"); }
  return { identity: markerIdentity, record };
}

function parseRecord(raw: unknown): LeaseRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) { throw new LocalSolanaError("SOLANA_PORT_LEASE_INVALID", "port lease marker is invalid"); }
  const value = raw as Record<string, unknown>;
  const exactKeys = Object.keys(value).toSorted().join(",") === "directoryDevice,directoryInode,kind,markerDevice,markerInode,pid,processStart,rootDevice,rootInode,schemaVersion,token";
  const valid = exactKeys && value.schemaVersion === 1 && value.kind === KIND && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid >= 1
    && typeof value.processStart === "string" && /^[a-z0-9:-]{1,128}$/u.test(value.processStart)
    && typeof value.token === "string" && /^[a-f0-9]{64}$/u.test(value.token)
    && [value.rootDevice, value.rootInode, value.directoryDevice, value.directoryInode, value.markerDevice, value.markerInode].every((item) => typeof item === "string" && /^(?:0|[1-9][0-9]*)$/u.test(item));
  if (!valid) { throw new LocalSolanaError("SOLANA_PORT_LEASE_INVALID", "port lease marker fields are invalid"); }
  return value as unknown as LeaseRecord;
}

async function privateDirectoryIdentity(directory: string): Promise<EntryIdentity> {
  const entry = await lstat(directory, { bigint: true });
  const expectedUid = process.getuid?.();
  const unsafe = !entry.isDirectory() || entry.isSymbolicLink() || await realpath(directory) !== directory
    || (entry.mode & 0o077n) !== 0n || (expectedUid !== undefined && entry.uid !== BigInt(expectedUid));
  if (unsafe) { throw new LocalSolanaError("SOLANA_PORT_LEASE_DIRECTORY_UNSAFE", "port lease directory was substituted or is not private"); }
  return identity(entry);
}

async function assertRootIdentity(root: string, expected: EntryIdentity): Promise<void> {
  let actual: EntryIdentity;
  try { actual = await privateDirectoryIdentity(root); } catch { throw new LocalSolanaError("SOLANA_PORT_LEASE_ROOT_UNSAFE", "port lease root was substituted"); }
  if (!sameIdentity(actual, expected)) { throw new LocalSolanaError("SOLANA_PORT_LEASE_ROOT_UNSAFE", "port lease root identity changed"); }
}
async function rollbackEmptyDirectory(directory: string, expected: EntryIdentity): Promise<void> {
  try { if (sameIdentity(await privateDirectoryIdentity(directory), expected) && (await readdir(directory)).length === 0) { await rmdir(directory); } } catch { /* Never delete an entry that failed identity validation. */ }
}
function identity(entry: { readonly dev: bigint; readonly ino: bigint }): EntryIdentity { return { dev: entry.dev, ino: entry.ino }; }
function sameIdentity(left: EntryIdentity, right: EntryIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function leaseOwnerIsProvablyStale(
  pid: number,
  recordedStart: string,
  readIdentity: (candidate: number) => Promise<string> = processStartIdentity,
  alive: (candidate: number) => boolean = processAlive,
): Promise<boolean> {
  if (!alive(pid)) { return true; }
  try { return await readIdentity(pid) !== recordedStart; }
  catch {
    // A live PID with unreadable identity is ambiguous, not stale.
    return !alive(pid);
  }
}

async function canListen(port: number): Promise<boolean> {
  return await new Promise((_resolve) => {
    const server = createServer(); server.unref(); server.once("error", () => _resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => { server.close((cause) => _resolve(cause === undefined)); });
  });
}
