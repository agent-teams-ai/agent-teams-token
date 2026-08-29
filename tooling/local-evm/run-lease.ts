import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LocalEvmError } from "./model.ts";
import {
  authenticateProcess,
  processStartIdentity,
  type OwnedProcessIdentity,
} from "./process.ts";
import { atomicWrite, readRegularFile, validatePrivateDirectory } from "./safe-fs.ts";

const KIND = "agtmai-local-evm-run";
const LEASE = "lease.v1.json";

interface RunLease {
  readonly schemaVersion: 1;
  readonly kind: typeof KIND;
  readonly runner: OwnedProcessIdentity;
  readonly anvil: OwnedProcessIdentity | null;
}

export async function createRunLease(directory: string): Promise<void> {
  await writeLease(directory, {
    schemaVersion: 1,
    kind: KIND,
    runner: { pid: process.pid, processStart: await processStartIdentity(process.pid) },
    anvil: null,
  });
}

export async function createProvisionalRunDirectory(root: string, runId: string): Promise<string> {
  if (!/^[A-Za-z0-9-]+$/u.test(runId)) {
    throw new LocalEvmError("LOCAL_EVM_RUN_ID_INVALID", "run ID cannot be encoded into its provisional identity");
  }
  const initializer = {pid: process.pid, processStart: await processStartIdentity(process.pid)};
  const encodedStart = initializer.processStart.replace(":", "x");
  return await mkdtemp(join(root, `run-init-${initializer.pid}-${encodedStart}-${runId}-`));
}

export async function registerRunAnvil(
  directory: string,
  anvil: OwnedProcessIdentity,
): Promise<void> {
  const lease = await readLease(directory);
  if (lease.runner.pid !== process.pid
    || lease.runner.processStart !== await processStartIdentity(process.pid)
    || lease.anvil !== null) {
    throw new LocalEvmError("LOCAL_EVM_RUN_LEASE_OWNER", "run lease cannot register this Anvil identity");
  }
  await writeLease(directory, { ...lease, anvil });
}

interface ReclaimHooks { readonly afterDirectoryList?: (directory: string) => Promise<void> }

interface ReclaimEntry {
  readonly runName: string;
  readonly claimedIdentity?: string;
}

export async function reclaimStaleRuns(root: string, hooks: ReclaimHooks = {}): Promise<number> {
  let reclaimed = 0;
  for (const name of await readdir(root)) {
    // mkdtemp(3) suffixes are case-sensitive and may contain upper-case ASCII.
    // Accept exactly the portable alphabet it can emit while still refusing
    // unrelated entries under the private root.
    const entry = parseReclaimEntry(name);
    if (entry === undefined) {continue;}
    const directory = join(root, name);
    const expectedDirectory = await existingDirectoryIdentity(directory);
    if (expectedDirectory === undefined) {continue;}
    if (entry.claimedIdentity !== undefined && entry.claimedIdentity !== expectedDirectory) {
      throw new LocalEvmError("LOCAL_EVM_RUN_DIRECTORY_CHANGED", "abandoned claim no longer names the inode originally claimed");
    }
    let lease: RunLease;
    try {
      await validatePrivateDirectory(directory);
      lease = await readLease(directory);
    } catch (cause) {
      if (await existingDirectoryIdentity(directory) === undefined) {continue;}
      if (!(cause instanceof LocalEvmError) || cause.code !== "LOCAL_EVM_RUN_LEASE_ENOENT") {throw cause;}
      if (!await provisionalIsStale(entry.runName)) {continue;}
      await hooks.afterDirectoryList?.(directory);
      const claim = await claimDirectory(directory, expectedDirectory);
      if (claim === undefined) {continue;}
      await validatePrivateDirectory(claim);
      await assertProvisionalName(entry.runName);
      await rm(claim, {recursive: true, force: false, maxRetries: 2});
      reclaimed += 1;
      continue;
    }
    const runnerState = await authenticateProcess(lease.runner);
    if (runnerState === "owned") { continue; }
    if (runnerState === "ambiguous") {
      throw new LocalEvmError("LOCAL_EVM_RUN_OWNER_AMBIGUOUS", "stale-run owner identity is unavailable; preserving its directory");
    }
    if (lease.anvil !== null) {
      const anvilState = await authenticateProcess(lease.anvil);
      if (anvilState === "owned" || anvilState === "ambiguous") {
        throw new LocalEvmError("LOCAL_EVM_RUN_ANVIL_STILL_OWNED", "supervisor did not close its owned Anvil; refusing unauthenticated cross-process termination");
      }
    }
    await hooks.afterDirectoryList?.(directory);
    const claim = await claimDirectory(directory, expectedDirectory);
    if (claim === undefined) {continue;}
    await validatePrivateDirectory(claim);
    const confirmed = await readLease(claim);
    if (JSON.stringify(confirmed) !== JSON.stringify(lease)) {
      throw new LocalEvmError("LOCAL_EVM_RUN_LEASE_CHANGED", "stale-run lease changed during reclamation");
    }
    await rm(claim, { recursive: true, force: false, maxRetries: 2 });
    reclaimed += 1;
  }
  return reclaimed;
}

async function writeLease(directory: string, lease: RunLease): Promise<void> {
  await atomicWrite(join(directory, LEASE), Buffer.from(`${JSON.stringify(lease)}\n`, "utf8"));
}

async function readLease(directory: string): Promise<RunLease> {
  let raw: unknown;
  try { raw = JSON.parse((await readRegularFile(join(directory, LEASE), "RUN_LEASE")).toString("utf8")); }
  catch (cause) {
    if (cause instanceof LocalEvmError) { throw cause; }
    throw new LocalEvmError("LOCAL_EVM_RUN_LEASE_INVALID", "run lease is invalid JSON");
  }
  if (!isRecord(raw)
    || Object.keys(raw).toSorted().join(",") !== "anvil,kind,runner,schemaVersion"
    || raw.schemaVersion !== 1 || raw.kind !== KIND
    || !isIdentity(raw.runner) || (raw.anvil !== null && !isIdentity(raw.anvil))) {
    throw new LocalEvmError("LOCAL_EVM_RUN_LEASE_INVALID", "run lease fields are invalid");
  }
  return raw as unknown as RunLease;
}

async function provisionalIsStale(name: string): Promise<boolean> {
  const initializer = await assertProvisionalName(name);
  const state = await authenticateProcess(initializer);
  if (state === "owned") {return false;}
  if (state === "ambiguous") {
    throw new LocalEvmError("LOCAL_EVM_RUN_OWNER_AMBIGUOUS", "run initializer identity is unavailable; preserving its directory");
  }
  return true;
}

async function assertProvisionalName(name: string): Promise<OwnedProcessIdentity> {
  const match = /^run-init-([1-9][0-9]*)-((?:linuxx[0-9]+)|(?:darwinx[a-f0-9]+))-[A-Za-z0-9-]+$/u.exec(name);
  if (!match) {
    throw new LocalEvmError("LOCAL_EVM_RUN_INITIALIZER_INVALID", "markerless run has no authenticated initializer identity");
  }
  const encodedStart = match[2]!;
  const processStart = encodedStart.startsWith("linuxx")
    ? `linux:${encodedStart.slice("linuxx".length)}`
    : `darwin:${encodedStart.slice("darwinx".length)}`;
  const initializer = {pid: Number(match[1]), processStart};
  if (!Number.isSafeInteger(initializer.pid)) {
    throw new LocalEvmError("LOCAL_EVM_RUN_INITIALIZER_INVALID", "markerless run initializer PID is invalid");
  }
  return initializer;
}

async function claimDirectory(directory: string, expectedIdentity: string): Promise<string | undefined> {
  const entry = parseReclaimEntry(basename(directory));
  if (entry === undefined) {
    throw new LocalEvmError("LOCAL_EVM_RUN_DIRECTORY_NAME_INVALID", "run directory cannot be represented by an atomic claim");
  }
  const encodedIdentity = expectedIdentity.replaceAll(":", "-");
  const claim = join(dirname(directory), `.reclaim-v1-${encodedIdentity}-${process.pid}-${randomBytes(12).toString("hex")}-${entry.runName}`);
  try {
    await rename(directory, claim);
    if (await directoryIdentity(claim) !== expectedIdentity) {
      throw new LocalEvmError("LOCAL_EVM_RUN_DIRECTORY_CHANGED", "claimed run directory is not the inode that was validated");
    }
    return claim;
  }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {return undefined;}
    throw cause;
  }
}

export async function removeOwnedRunDirectory(directory: string): Promise<void> {
  const expectedDirectory = await directoryIdentity(directory).catch((cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {return undefined;}
    throw cause;
  });
  if (expectedDirectory === undefined) {return;}
  const claim = await claimDirectory(directory, expectedDirectory);
  if (claim === undefined) {return;}
  await validatePrivateDirectory(claim);
  const lease = await readLease(claim);
  const current = await processStartIdentity(process.pid);
  if (lease.runner.pid !== process.pid || lease.runner.processStart !== current) {
    throw new LocalEvmError("LOCAL_EVM_RUN_LEASE_OWNER", "refusing to delete a claimed directory not owned by this runner");
  }
  await rm(claim, {recursive: true, force: false, maxRetries: 2});
}

async function directoryIdentity(directory: string): Promise<string> {
  const entry = await lstat(directory, {bigint: true});
  return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
}

async function existingDirectoryIdentity(directory: string): Promise<string | undefined> {
  try {return await directoryIdentity(directory);}
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {return undefined;}
    throw cause;
  }
}

function parseReclaimEntry(name: string): ReclaimEntry | undefined {
  if (/^run-[A-Za-z0-9-]+$/u.test(name)) {return {runName: name};}
  const claim = /^\.reclaim-v1-([0-9]+)-([0-9]+)-([0-9]+)-[1-9][0-9]*-[0-9a-f]{24}-(run-[A-Za-z0-9-]+)$/u.exec(name);
  if (!claim) {return undefined;}
  return {runName: claim[4]!, claimedIdentity: `${claim[1]}:${claim[2]}:${claim[3]}`};
}

function isIdentity(value: unknown): value is OwnedProcessIdentity {
  return isRecord(value)
    && Object.keys(value).toSorted().join(",") === "pid,processStart"
    && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.processStart === "string"
    && /^(?:linux:[0-9]+|darwin:[a-f0-9]+)$/u.test(value.processStart);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
