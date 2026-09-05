import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProcessPort } from "../application/ports.ts";
import { SlitherGateError } from "../domain/model.ts";
import { AUTHORIZE_ANALYSIS } from "./container-contract.ts";
import { COMPLETION_READER, exportArguments, receiveOutput, linuxOutputDirectoryPath, MAX_FILE_BYTES, MAX_TOTAL_BYTES, type OutputDirectoryPath } from "./container-export.ts";
import { parseJsonWithoutDuplicateKeys } from "./json-schema.ts";

interface ContainerInspection {
  readonly Id?: unknown;
  readonly State?: { readonly Running?: unknown; readonly Paused?: unknown; readonly Pid?: unknown };
  readonly HostConfig?: {
    readonly PidsLimit?: unknown;
    readonly Memory?: unknown;
    readonly MemorySwap?: unknown;
    readonly NanoCpus?: unknown;
  };
}

interface CgroupIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const REQUIRED_CONTROLLERS = ["cpu", "memory", "pids"] as const;

const OVERALL_TIMEOUT_MS = 600_000;
const CLEANUP_RESERVE_MS = 30_000;

/** Production requires Linux cgroups, PID namespaces and descriptor paths. */
export const runContainerById = createContainerRunner(linuxOutputDirectoryPath);

/** Proves, exports and removes a container solely through its immutable ID. */
export function createContainerRunner(directoryPath: OutputDirectoryPath) {
  return async (port: ProcessPort, dockerPath: string, createArguments: readonly string[], output: string, allowlist: readonly string[]): Promise<{ readonly timedOut: boolean; readonly exitCode: number | null }> => {
    const deadline = performance.now() + OVERALL_TIMEOUT_MS;
    const workDeadline = deadline - CLEANUP_RESERVE_MS;
    const work = boundedPort(port, workDeadline);
    const daemon = await work.run(dockerPath, ["info", "--format", "{{json .}}"], 30_000);
    assertCgroupDaemon(daemon);
    const created = await work.run(dockerPath, createArguments, 30_000);
    const id = created.stdout.trim();
    if (!CONTAINER_ID.test(id)) {throw new SlitherGateError("CONTAINER_ID_INVALID", "container engine did not return one immutable ID");}
    const failures: unknown[] = [];
    let analysisExit: number | null = null;
    try {
      if (created.exitCode !== 0 || created.timedOut) {throw new SlitherGateError("CONTAINER_ID_INVALID", "immutable container creation did not complete");}
      await inspectContainer(work, dockerPath, id, false);
      const started = await work.run(dockerPath, ["start", id], 30_000);
      if (started.exitCode !== 0 || started.timedOut || started.stdout.trim() !== id) {throw new SlitherGateError("CONTAINER_ID_INVALID", "immutable container failed to start");}
      const inspection = await inspectContainer(work, dockerPath, id, true);
      if (inspection.State?.Paused !== false) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "container cannot authorize analysis while paused");}
      await assertLiveCgroup(id, inspection);
      const authorize = await work.run(dockerPath, ["exec", id, "/bin/bash", "-ceu", AUTHORIZE_ANALYSIS], 30_000);
      if (authorize.exitCode !== 0 || authorize.timedOut) {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "container delegation authorization failed");}
      const exitCode = await awaitCompletion(work, dockerPath, id);
      analysisExit = exitCode;
      await assertRetainedContainer(work, dockerPath, id, inspection);
      // Docker cp cannot export tmpfs, even while paused. The isolated Python
      // exec rejects live descendants and checks a coherent bounded snapshot.
      const allowed = exitCode === 0 ? allowlist : [...allowlist, "failure.stage"];
      const exported = await work.run(dockerPath, exportArguments(id, allowed, exitCode === 0), 30_000).catch((cause: unknown) => {
        const failure = new SlitherGateError("ARTIFACT_EXPORT_FAILED", "container-private export command failed");
        failure.cause = cause;
        throw failure;
      });
      if (exported.exitCode !== 0 || exported.timedOut || exported.stderr !== "") {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "container-private output export failed");}
      await assertRetainedContainer(work, dockerPath, id, inspection);
      await receiveOutput(exported.stdout, output, allowed, exitCode === 0, directoryPath);
      await authenticateTransferredOutput(output, allowed, exitCode === 0);
      assertTimeRemaining(workDeadline);
    } catch (error) {
      failures.push(error);
    }
    // A validated create response grants custody; failed inspection must not
    // abandon it. Settle both outcomes before returning or throwing, preserving
    // even an undefined primary rejection ahead of any cleanup failure.
    try {
      await removeContainer(boundedPort(port, deadline), dockerPath, id);
    } catch (cleanup) {
      const failure = new SlitherGateError("CONTAINER_FAILED", `container cleanup is unconfirmed${analysisExit === null ? "" : ` after analysis exit ${analysisExit}`}`);
      failure.cause = new AggregateError([...failures, cleanup], "container lifecycle and cleanup failures");
      throw failure;
    }
    if (failures.length > 0) {throw failures[0];}
    return {timedOut: false, exitCode: analysisExit};
  };
}

async function removeContainer(port: ProcessPort, dockerPath: string, id: string): Promise<void> {
  const removed = await port.run(dockerPath, ["rm", "--force", id], CLEANUP_RESERVE_MS);
  if (removed.exitCode !== 0 || removed.timedOut || removed.stdout.trim() !== id) {throw new SlitherGateError("CONTAINER_FAILED", "exact-ID container removal did not complete");}
}

function assertTimeRemaining(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) {throw new SlitherGateError("CONTAINER_TIMEOUT", "container exceeded the overall lifecycle deadline");}
  return remaining;
}

function boundedPort(port: ProcessPort, deadline: number): ProcessPort {
  return {run: async (command, args, timeoutMs, options) => {
    const timeout = Math.min(timeoutMs, assertTimeRemaining(deadline));
    const commandDeadline = Math.min(deadline, performance.now() + timeout);
    const result = await port.run(command, args, timeout, options);
    // Preserve a late create's ID for cleanup, but never accept late results.
    return {...result, timedOut: result.timedOut || performance.now() >= commandDeadline};
  }};
}

async function awaitCompletion(port: ProcessPort, dockerPath: string, id: string): Promise<number> {
  const completed = await port.run(dockerPath, ["exec", id, "/usr/bin/python3", "-I", "-S", "-c", COMPLETION_READER], OVERALL_TIMEOUT_MS);
  if (completed.timedOut) {throw new SlitherGateError("CONTAINER_TIMEOUT", "container analysis completion exceeded the lifecycle deadline");}
  const match = /^SLITHER_COMPLETED_V1 (0|[1-9][0-9]{0,2})\n$/u.exec(completed.stdout);
  if (completed.exitCode !== 0 || completed.stderr !== "" || !match || Number(match[1]) > 255) {throw new SlitherGateError("CONTAINER_FAILED", "container analysis completion is missing or malformed");}
  return Number(match[1]);
}

async function assertRetainedContainer(port: ProcessPort, dockerPath: string, id: string, initial: ContainerInspection): Promise<void> {
  const current = await inspectContainer(port, dockerPath, id, true);
  if (current.State?.Paused !== false || current.State.Pid !== initial.State?.Pid) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "container output retention is unproven");}
}

function assertCgroupDaemon(result: { readonly exitCode: number | null; readonly stdout: string; readonly timedOut: boolean }): void {
  let value: Record<string, unknown>;
  try {value = parseJsonWithoutDuplicateKeys(result.stdout) as Record<string, unknown>;} catch {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "Docker daemon cgroup metadata is unavailable");}
  if (result.exitCode !== 0 || result.timedOut || value.CgroupDriver !== "systemd" || value.CgroupVersion !== "2") {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "live cgroup v2 systemd delegation is required");}
}

async function inspectContainer(port: ProcessPort, dockerPath: string, id: string, running: boolean): Promise<ContainerInspection> {
  const result = await port.run(dockerPath, ["container", "inspect", id, "--format", "{{json .}}"], 30_000);
  let value: ContainerInspection;
  try {value = parseJsonWithoutDuplicateKeys(result.stdout) as ContainerInspection;} catch {throw new SlitherGateError("CONTAINER_ID_INVALID", "container identity inspection is malformed");}
  if (result.exitCode !== 0 || result.timedOut || value.Id !== id || (running && value.State?.Running !== true)) {throw new SlitherGateError("CONTAINER_ID_INVALID", "container identity changed or disappeared");}
  return value;
}

async function assertLiveCgroup(id: string, inspection: ContainerInspection): Promise<void> {
  const pid = assertConfiguredLimits(inspection);
  const cgroupPath = await readCgroupPath(id, pid);
  const leaf = join("/sys/fs/cgroup", cgroupPath);
  const parent = dirname(leaf);
  const parentBefore = await safeCgroupDirectory(parent);
  const leafBefore = await safeCgroupDirectory(leaf);
  const [controllers, delegated, pids, memory, cpu] = await readCgroupLimits(parent, leaf);
  await assertCgroupIdentity(parent, parentBefore);
  await assertCgroupIdentity(leaf, leafBefore);
  assertControllerDelegation(controllers, delegated);
  if (pids.trim() !== "128" || memory.trim() !== "2147483648" || cpu.trim() !== "200000 100000") {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "live cgroup leaf limits differ from the contract");}
}

function assertConfiguredLimits(inspection: ContainerInspection): number {
  const pid = inspection.State?.Pid;
  const host = inspection.HostConfig;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1 || host?.PidsLimit !== 128 || host.Memory !== 2147483648 || host.MemorySwap !== 2147483648 || host.NanoCpus !== 2000000000) {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "container PID and configured limits are not exact");}
  return Number(pid);
}

async function readCgroupPath(id: string, pid: number): Promise<string> {
  const values = await Promise.all([readlink("/proc/self/ns/pid"), readlink(`/proc/${pid}/ns/pid`), readFile(`/proc/${pid}/cgroup`, "utf8")]).catch(() => {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "live PID namespace or cgroup is unreadable");});
  const [hostNamespace, leafNamespace, cgroup] = values;
  const match = /^0::(\/[A-Za-z0-9_.@:/-]+)\n$/u.exec(cgroup);
  const path = match?.[1];
  if (hostNamespace === leafNamespace || path === undefined || !path.includes(id) || path.split("/").some((part) => part === "." || part === "..")) {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "container PID namespace or immutable cgroup leaf is not isolated");}
  return path;
}

async function safeCgroupDirectory(path: string): Promise<CgroupIdentity> {
  const value = await lstat(path, {bigint: true});
  if (!value.isDirectory() || value.isSymbolicLink()) {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "cgroup identities are unsafe");}
  return {dev: value.dev, ino: value.ino};
}

async function readCgroupLimits(parent: string, leaf: string): Promise<readonly [string, string, string, string, string]> {
  return await Promise.all([
    readFile(join(parent, "cgroup.controllers"), "utf8"),
    readFile(join(parent, "cgroup.subtree_control"), "utf8"),
    readFile(join(leaf, "pids.max"), "utf8"),
    readFile(join(leaf, "memory.max"), "utf8"),
    readFile(join(leaf, "cpu.max"), "utf8"),
  ]).catch(() => {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "cgroup parent, leaf or delegation is unreadable");});
}

async function assertCgroupIdentity(path: string, before: CgroupIdentity): Promise<void> {
  const after = await lstat(path, {bigint: true});
  if (after.dev !== before.dev || after.ino !== before.ino) {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "cgroup identities changed during proof");}
}

function assertControllerDelegation(controllers: string, delegated: string): void {
  const available = controllers.split(/\s+/u);
  const enabled = delegated.split(/\s+/u);
  for (const controller of REQUIRED_CONTROLLERS) {
    if (!available.includes(controller) || !enabled.includes(controller)) {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "required cgroup controllers are not delegated");}
  }
}

export async function authenticateTransferredOutput(directory: string, allowlist: readonly string[], exact = true): Promise<void> {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777n) !== 0o700n || info.uid !== BigInt(process.getuid?.() ?? -1)) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "host transfer directory is not private and owned");}
  const names = (await readdir(directory)).toSorted();
  const expected = allowlist.toSorted();
  const allowed = new Set(expected);
  if (names.length === 0 || names.some((name) => !allowed.has(name)) || (exact && JSON.stringify(names) !== JSON.stringify(expected))) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "container output violates the run-specific allowlist");}
  let total = 0n;
  for (const name of names) {
    const entry = await lstat(join(directory, name), { bigint: true });
    total += entry.size;
    if (entry.size > BigInt(MAX_FILE_BYTES) || total > BigInt(MAX_TOTAL_BYTES)) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "transferred output exceeds the byte limits");}
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.uid !== info.uid || (entry.mode & 0o077n) !== 0n) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "transferred output ownership, mode or identity is unsafe");}
  }
}
