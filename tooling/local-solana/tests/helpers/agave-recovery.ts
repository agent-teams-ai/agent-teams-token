import assert from "node:assert/strict";
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PortLease, RunPaths, ToolLease, ToolPaths, ValidatorIdentity } from "../../src/application/ports.ts";
import { PrivateRunStore } from "../../src/adapters/filesystem.ts";
import { NodeCommandAdapter } from "../../src/adapters/process.ts";
import { PinnedToolResolver } from "../../src/adapters/toolchain.ts";
import { LoopbackPortAllocator } from "../../src/adapters/ports.ts";
import { authenticateValidatorIdentity, processStartIdentity } from "../../src/adapters/process-identity.ts";

/** Controller-only genuine Agave regression. No installation or synthetic fallback. */
export async function genuineAgaveRecovery(repositoryRoot: string): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agtmai-genuine-agave-recovery-")));
  const runRoot = join(root, "runs"); const outputRoot = join(root, "out");
  const store = new PrivateRunStore(runRoot, outputRoot); const neighbourRun = await store.create();
  await writeFile(neighbourRun.payerKey, "NEIGHBOUR_SENTINEL", { mode: 0o600 });
  const neighbour = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  let ports: PortLease | undefined;
  let snapshots: ToolLease | undefined; let owner: ChildProcess | undefined; let paths: RunPaths | undefined;
  let tools: ToolPaths | undefined;
  let identity: ValidatorIdentity | undefined; let custodian: { pid: number; start: string } | undefined;
  try {
    ports = await new LoopbackPortAllocator(join(root, "ports")).allocate();
    tools = await new PinnedToolResolver(repositoryRoot, new NodeCommandAdapter()).resolve({ run: neighbourRun, own: (lease) => { snapshots = lease; } });
    owner = fork(new URL("./start-unregistered-agave.ts", import.meta.url), [runRoot, outputRoot], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const run = await message(owner, "run") as { paths: RunPaths }; paths = run.paths;
    const captured = message(owner, "captured"); owner.send({ tools, rpcPort: ports.rpcPort, faucetPort: ports.faucetPort, gossipPort: ports.gossipPort, dynamicPortRange: ports.dynamicPortRange });
    identity = (await captured as { identity: ValidatorIdentity }).identity;
    assert.equal(identity.executable, await realpath(tools.validator));
    assert.equal(await authenticateValidatorIdentity(identity, paths.leaseToken), true);
    const startup = JSON.parse(await readFile(join(paths.directory, ".agtmai-validator-startup.json"), "utf8"));
    custodian = startup.supervisor as { pid: number; start: string };
    assert.equal(await processStartIdentity(custodian.pid), custodian.start);
    assert.equal(JSON.parse(await readFile(join(paths.directory, ".agtmai-local-solana-lease.json"), "utf8")).validator, null);
    // Freeze disconnect handling so reclamation MUST run first while Agave is captured and live.
    process.kill(custodian.pid, "SIGSTOP");
    const ownerClosed = once(owner, "close"); owner.kill("SIGKILL"); await ownerClosed;
    assert.equal(await store.reclaimStale(), 0); await lstat(paths.ledger);
    assert.equal(await authenticateValidatorIdentity(identity, paths.leaseToken), true);
    process.kill(custodian.pid, "SIGCONT");
    let claimed = 0;
    for (let attempt = 0; attempt < 600 && claimed === 0; attempt += 1) { claimed += await store.reclaimStale(); if (claimed === 0) { await delay(25); } }
    assert.equal(claimed, 1, "settled genuine Agave run must be reclaimable within 15 seconds");
    await requireExited(identity.pid); await requireExited(custodian.pid);
    await assert.rejects(lstat(paths.directory), { code: "ENOENT" });
    process.kill(neighbour.pid!, 0); assert.equal(await readFile(neighbourRun.payerKey, "utf8"), "NEIGHBOUR_SENTINEL");
    await lstat(neighbourRun.directory);
  } finally {
    if (custodian !== undefined && await processStartIdentity(custodian.pid).catch(() => null) === custodian.start) { process.kill(custodian.pid, "SIGCONT"); }
    if (owner !== undefined && owner.exitCode === null && owner.signalCode === null) { const closed = once(owner, "close"); owner.kill("SIGKILL"); await closed; }
    if (identity !== undefined && paths !== undefined && !await exited(identity.pid) && await authenticateValidatorIdentity(identity, paths.leaseToken)) { process.kill(identity.pid, "SIGKILL"); }
    const neighbourClosed = once(neighbour, "close"); neighbour.kill("SIGKILL"); await neighbourClosed;
    // Uncertain processes retain their ledger and executable snapshots, including on test failure.
    if (identity !== undefined) { await requireExited(identity.pid); }
    if (custodian !== undefined) { await requireExited(custodian.pid); }
    // Even a lost capture message cannot authorize removing executable snapshots.
    // Settle every other run first, using the same durable recovery authority.
    await cleanupRecoveryRuns(store, runRoot, neighbourRun, snapshots, ports, tools);
    await rm(root, { recursive: true, force: true });
  }
}

/** Called only after the owner, validator and custodian have terminated. */
export async function cleanupRecoveryRuns(store: PrivateRunStore, runRoot: string, neighbourRun: RunPaths,
  snapshots: ToolLease | undefined, ports: PortLease | undefined, tools: ToolPaths | undefined, attempts = 600): Promise<void> {
  // Only directories named by this resolver's returned tools are expected.
  // Prefix discovery would silently authorize foreign snapshot-looking entries.
  const snapshotDirectories = [...new Set(Object.values(tools ?? {}).map((path) => dirname(path)))];
  for (const directory of snapshotDirectories) { assert.equal(dirname(directory), runRoot); }
  const expected = [basename(neighbourRun.directory), ...snapshotDirectories.map((directory) => basename(directory))].toSorted();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await store.reclaimStale();
    if (JSON.stringify((await readdir(runRoot)).toSorted()) === JSON.stringify(expected)) { break; }
    await delay(25);
  }
  assert.deepEqual((await readdir(runRoot)).toSorted(), expected, "uncertain recovery run retains snapshots and private state");
  await ports?.release(); await snapshots?.close();
  assert.deepEqual(await readdir(runRoot), [basename(neighbourRun.directory)], "snapshot close must remove the owned inventory");
  await store.cleanup(neighbourRun);
  assert.deepEqual(await readdir(runRoot), [], "recovery cleanup must leave no run or snapshot residue");
}

async function message(child: ChildProcess, type: string): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { finish(); reject(new Error(`genuine Agave recovery ${type} deadline exceeded`)); }, 60_000);
    const receive = (value: { type?: string }): void => { if (value.type === type) { finish(); resolve(value); } };
    const closed = (): void => { finish(); reject(new Error(`genuine Agave helper exited before ${type}`)); };
    const finish = (): void => { clearTimeout(timer); child.removeListener("message", receive); child.removeListener("close", closed); };
    child.on("message", receive); child.once("close", closed);
  });
}
async function requireExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) { if (await exited(pid)) { return; } await delay(25); }
  assert.fail("genuine Agave recovery did not prove bounded process termination");
}
async function exited(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch (cause) { return (cause as NodeJS.ErrnoException).code === "ESRCH"; }
  if (process.platform === "linux") {
    const value = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    return value.slice(value.lastIndexOf(")") + 2).startsWith("Z ");
  }
  return await new Promise((resolve) => { execFile("/bin/ps", ["-o", "stat=", "-p", String(pid)], { timeout: 2_000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }, (cause, stdout) => { resolve(cause === null && stdout.trim().startsWith("Z")); }); });
}
