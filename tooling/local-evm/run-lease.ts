import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalEvmError } from "./model.ts";
import {
  authenticateProcess,
  processStartIdentity,
  terminateOwnedProcess,
  type OwnedProcessIdentity,
} from "./process.ts";
import { atomicWrite, ensurePrivateDirectory, readRegularFile } from "./safe-fs.ts";

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

export async function reclaimStaleRuns(root: string): Promise<number> {
  let reclaimed = 0;
  for (const name of await readdir(root)) {
    // mkdtemp(3) suffixes are case-sensitive and may contain upper-case ASCII.
    // Accept exactly the portable alphabet it can emit while still refusing
    // unrelated entries under the private root.
    if (!/^run-[A-Za-z0-9-]+$/u.test(name)) { continue; }
    const directory = join(root, name);
    await ensurePrivateDirectory(directory);
    const lease = await readLeaseAfterInitialization(directory);
    const runnerState = await authenticateProcess(lease.runner);
    if (runnerState === "owned") { continue; }
    if (runnerState === "ambiguous") {
      throw new LocalEvmError("LOCAL_EVM_RUN_OWNER_AMBIGUOUS", "stale-run owner identity is unavailable; preserving its directory");
    }
    if (lease.anvil !== null) {
      await terminateOwnedProcess(lease.anvil);
    }
    // Re-read the exact lease and directory immediately before deletion. A
    // concurrently replaced or newly-owned run must fail closed.
    const confirmed = await readLease(directory);
    if (JSON.stringify(confirmed) !== JSON.stringify(lease)) {
      throw new LocalEvmError("LOCAL_EVM_RUN_LEASE_CHANGED", "stale-run lease changed during reclamation");
    }
    await ensurePrivateDirectory(directory);
    await rm(directory, { recursive: true, force: false, maxRetries: 2 });
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

/**
 * A parallel runner can observe the directory in the tiny interval between
 * mkdtemp() and the atomic lease rename. Give that authenticated initializer a
 * bounded grace period, while malformed or persistently partial directories
 * still fail closed instead of being deleted.
 */
async function readLeaseAfterInitialization(directory: string): Promise<RunLease> {
  const attempts = 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await readLease(directory);
    } catch (cause) {
      if (!(cause instanceof LocalEvmError)
        || cause.code !== "LOCAL_EVM_RUN_LEASE_ENOENT"
        || attempt === attempts - 1) {
        throw cause;
      }
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
  }
  throw new LocalEvmError("LOCAL_EVM_RUN_LEASE_ENOENT", "run lease initialization did not complete");
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
