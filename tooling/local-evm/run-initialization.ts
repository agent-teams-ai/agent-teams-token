import { lstat, mkdtemp, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { LocalEvmError } from "./model.ts";
import { authenticateProcess, processStartIdentity, type OwnedProcessIdentity } from "./process.ts";
import { validatePrivateDirectory } from "./safe-fs.ts";

export interface InitializingRun {
  readonly directory: string;
  readonly identity: string;
}

export async function createInitializingRunDirectory(root: string, runId: string): Promise<InitializingRun> {
  if (!/^[A-Za-z0-9-]+$/u.test(runId)) {
    throw new LocalEvmError("LOCAL_EVM_RUN_ID_INVALID", "run ID cannot be encoded into its initializer identity");
  }
  await validatePrivateDirectory(root);
  const start = (await processStartIdentity(process.pid)).replace(":", "x");
  const directory = await mkdtemp(join(root, `.initialize-v1-${process.pid}-${start}-${runId}-`));
  return {directory, identity: await initializationIdentity(directory)};
}

// The caller awaits the complete publisher, including its finally block, before
// moving the initialized inode over an exclusively created empty reservation.
// Both names are revalidated immediately before rename; the repository's
// documented same-UID final-syscall limitation still applies.
export async function publishInitializedRun(
  initial: InitializingRun,
  publish: () => Promise<void>,
): Promise<string> {
  await assertInitializingRun(initial);
  await publish();
  await assertInitializingRun(initial);
  const suffix = basename(initial.directory).slice(".initialize-v1-".length);
  const destination = await mkdtemp(join(dirname(initial.directory), `run-init-${suffix}-`));
  const reservedIdentity = await initializationIdentity(destination);
  await validatePrivateDirectory(destination);
  await assertInitializingRun(initial);
  if (await initializationIdentity(destination) !== reservedIdentity) {
    throw new LocalEvmError("LOCAL_EVM_RUN_DIRECTORY_CHANGED", "initialization destination was substituted");
  }
  await rename(initial.directory, destination);
  await validatePrivateDirectory(destination);
  if (await initializationIdentity(destination) !== initial.identity) {
    throw new LocalEvmError("LOCAL_EVM_RUN_DIRECTORY_CHANGED", "promoted directory was substituted");
  }
  return destination;
}

async function assertInitializingRun(initial: InitializingRun): Promise<void> {
  const start = (await processStartIdentity(process.pid)).replace(":", "x");
  if (!basename(initial.directory).startsWith(`.initialize-v1-${process.pid}-${start}-`)) {
    throw new LocalEvmError("LOCAL_EVM_RUN_LEASE_OWNER", "initializer is not owned by this process");
  }
  await validatePrivateDirectory(initial.directory);
  if (await initializationIdentity(initial.directory) !== initial.identity) {
    throw new LocalEvmError("LOCAL_EVM_RUN_DIRECTORY_CHANGED", "initializing directory was substituted");
  }
}

async function initializationIdentity(directory: string): Promise<string> {
  const entry = await lstat(directory, {bigint: true});
  return `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
}

// Only absence of this directory is a benign namespace transition. Permission,
// custody and process-identity errors remain fail-closed.
export async function authenticateRunPhase(
  directory: string, expectedIdentity: string, owner: OwnedProcessIdentity,
): Promise<"owned" | "stale" | "missing"> {
  try {
    await validatePrivateDirectory(directory);
    const state = await authenticateProcess(owner);
    if (await initializationIdentity(directory) !== expectedIdentity) {
      throw new LocalEvmError("LOCAL_EVM_RUN_DIRECTORY_CHANGED", "lifecycle directory changed during authentication");
    }
    if (state === "ambiguous") {
      throw new LocalEvmError("LOCAL_EVM_RUN_OWNER_AMBIGUOUS", "lifecycle owner identity unavailable; preserving directory");
    }
    return state === "owned" ? "owned" : "stale";
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "LOCAL_EVM_DIRECTORY_ENOENT") {return "missing";}
    throw cause;
  }
}
