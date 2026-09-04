import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProcessPort } from "../application/ports.ts";
import { SlitherGateError } from "../domain/model.ts";
import { parseJsonWithoutDuplicateKeys } from "./json-schema.ts";

interface ContainerInspection {
  readonly Id?: unknown;
  readonly State?: { readonly Running?: unknown; readonly Pid?: unknown };
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

/** Creates, proves, copies and removes a container solely through its immutable engine ID. */
export async function runContainerById(port: ProcessPort, dockerPath: string, createArguments: readonly string[], output: string, allowlist: readonly string[]): Promise<{ readonly timedOut: boolean; readonly exitCode: number | null }> {
  const daemon = await port.run(dockerPath, ["info", "--format", "{{json .}}"], 30_000);
  assertCgroupDaemon(daemon);
  const created = await port.run(dockerPath, createArguments, 30_000);
  const id = created.stdout.trim();
  if (!CONTAINER_ID.test(id)) {throw new SlitherGateError("CONTAINER_ID_INVALID", "container engine did not return one immutable ID");}
  let cleanupAuthorized = false;
  try {
    if (created.exitCode !== 0 || created.timedOut) {throw new SlitherGateError("CONTAINER_ID_INVALID", "immutable container creation did not complete");}
    await inspectContainer(port, dockerPath, id, false);
    const started = await port.run(dockerPath, ["start", id], 30_000);
    if (started.exitCode !== 0 || started.timedOut || started.stdout.trim() !== id) {throw new SlitherGateError("CONTAINER_ID_INVALID", "immutable container failed to start");}
    const inspection = await inspectContainer(port, dockerPath, id, true);
    await assertLiveCgroup(id, inspection);
    const authorize = await port.run(dockerPath, ["exec", id, "/usr/bin/touch", "/work/host-authorized"], 30_000);
    if (authorize.exitCode !== 0 || authorize.timedOut) {throw new SlitherGateError("CGROUP_RUNTIME_UNPROVEN", "container delegation authorization failed");}
    const waited = await port.run(dockerPath, ["wait", id], 600_000);
    const exitCode = /^(?:0|[1-9][0-9]{0,2})\n?$/u.test(waited.stdout) ? Number.parseInt(waited.stdout, 10) : null;
    const copied = await port.run(dockerPath, ["cp", `${id}:/work/gate-output/.`, output], 30_000);
    if (copied.exitCode !== 0 || copied.timedOut) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "container-private output transfer failed");}
    await authenticateTransferredOutput(output, exitCode === 0 ? allowlist : [...allowlist, "failure.stage"], exitCode === 0);
    cleanupAuthorized = true;
    return {timedOut: waited.timedOut, exitCode};
  } finally {
    try {await inspectContainer(port, dockerPath, id, false); cleanupAuthorized = true;} catch {cleanupAuthorized = false;}
    if (cleanupAuthorized) {await port.run(dockerPath, ["rm", "--force", id], 30_000).catch(() => {});}
  }
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

async function readCgroupLimits(parent: string, leaf: string): Promise<readonly string[]> {
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
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777n) !== 0o700n || info.uid !== BigInt(process.getuid?.() ?? -1)) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "host transfer directory is not private and owned");}
  const names = (await readdir(directory)).toSorted();
  const expected = [...allowlist].toSorted();
  const allowed = new Set(expected);
  if (names.length === 0 || names.some((name) => !allowed.has(name)) || (exact && JSON.stringify(names) !== JSON.stringify(expected))) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "container output violates the run-specific allowlist");}
  for (const name of names) {
    const entry = await lstat(join(directory, name), { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.uid !== info.uid || (entry.mode & 0o077n) !== 0n) {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "transferred output ownership, mode or identity is unsafe");}
  }
}
