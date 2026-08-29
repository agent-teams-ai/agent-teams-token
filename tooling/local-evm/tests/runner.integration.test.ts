import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import type { Readable } from "node:stream";
import { privateRunRoot } from "../runner.ts";
import { authenticateProcess, processStartIdentity } from "../process.ts";

const repositoryRoot = resolvePath(import.meta.dirname, "../../..");
const runnerPath = join(repositoryRoot, "scripts/genesis/local-evm.ts");
const privateRoot = privateRunRoot(repositoryRoot);
const generatedReports = new Set<string>();
const activeChildren = new Set<ChildProcessByStdio<null, Readable, Readable>>();

after(async () => {
  await Promise.all([...activeChildren].map(stopChild));
  for (const path of generatedReports) {await rm(path, { recursive: true, force: true });}
});

test("two repeated clean chains prove stable normalized evidence", { timeout: 120_000 }, async () => {
  const first = await run();
  const second = await run();
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(second.exitCode, 0, second.stderr);
  const firstResult = lastJson(first.stdout);
  const secondResult = lastJson(second.stdout);
  rememberReport(firstResult); rememberReport(secondResult);
  assert.notEqual(firstResult.runId, secondResult.runId);
  assert.notEqual(firstResult.targetAddress, secondResult.targetAddress);
  assert.notEqual(firstResult.transactionHash, secondResult.transactionHash);
  assert.notEqual(firstResult.reportDirectory, secondResult.reportDirectory);
  assert.equal(firstResult.normalizedEvidenceSha256, secondResult.normalizedEvidenceSha256);
  await assertNoPrivateRunDirectories();
  await assertRedactedReport(firstResult.reportDirectory as string);
  await assertRedactedReport(secondResult.reportDirectory as string);
});

test("two parallel runs use isolated ports, processes, private directories and reports", { timeout: 90_000 }, async () => {
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(second.exitCode, 0, second.stderr);
  const firstResult = lastJson(first.stdout);
  const secondResult = lastJson(second.stdout);
  rememberReport(firstResult); rememberReport(secondResult);
  assert.notEqual(firstResult.runId, secondResult.runId);
  assert.notEqual(firstResult.reportDirectory, secondResult.reportDirectory);
  assert.equal(firstResult.normalizedEvidenceSha256, secondResult.normalizedEvidenceSha256);
  await assertNoPrivateRunDirectories();
});

test("interrupting one run removes only its owned directory and does not affect its neighbour", { timeout: 90_000 }, async () => {
  await assertNoPrivateRunDirectories();
  const interrupted = start();
  const neighbour = start();
  await waitFor(async () => (await runDirectories()).length === 2, 15_000, "two private run directories");
  await waitFor(async () => (await anvilPids()).length === 2, 30_000, "both owned Anvil PIDs");
  const pidsBeforeInterrupt = await anvilPids();
  assert.equal(pidsBeforeInterrupt.every(processExists), true);
  assert.equal(interrupted.child.kill("SIGTERM"), true);
  await waitFor(async () => (await runDirectories()).length === 1, 30_000, "only interrupted run cleanup");
  const [neighbourAnvilPid] = await anvilPids();
  assert.notEqual(neighbourAnvilPid, undefined);
  const interruptedAnvilPid = pidsBeforeInterrupt.find((pid) => pid !== neighbourAnvilPid);
  assert.notEqual(interruptedAnvilPid, undefined);
  assert.equal(neighbour.child.exitCode, null);
  assert.equal(processExists(interruptedAnvilPid!), false);
  assert.equal(processExists(neighbourAnvilPid!), true);
  assert.equal((await runDirectories()).length, 1);
  const interruptedResult = await interrupted.result;
  assert.equal(processExists(interrupted.pid), false);
  const neighbourResult = await neighbour.result;
  assert.equal(processExists(neighbour.pid), false);
  assert.equal(processExists(neighbourAnvilPid!), false);
  assert.notEqual(interruptedResult.exitCode, 0);
  assert.equal(neighbourResult.exitCode, 0, neighbourResult.stderr);
  const output = lastJson(neighbourResult.stdout);
  rememberReport(output);
  await assertNoPrivateRunDirectories();
});

test("a later run reclaims a registered run after runner SIGKILL", { timeout: 120_000 }, async () => {
  await assertNoPrivateRunDirectories();
  const killed = start();
  await waitFor(async () => (await anvilPids()).length === 1, 30_000, "owned Anvil PID");
  const [orphanPid] = await anvilPids();
  assert.notEqual(orphanPid, undefined);
  const orphanIdentity = { pid: orphanPid!, processStart: await processStartIdentity(orphanPid!) };
  assert.equal(processExists(orphanPid!), true);
  assert.equal(killed.child.kill("SIGKILL"), true);
  const killedResult = await killed.result;
  assert.notEqual(killedResult.exitCode, 0);
  await waitFor(async () => await authenticateProcess(orphanIdentity) !== "owned", 15_000, "supervised Anvil termination");

  const recovered = await run();
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  const output = lastJson(recovered.stdout);
  rememberReport(output);
  assert.notEqual(await authenticateProcess(orphanIdentity), "owned");
  await assertNoPrivateRunDirectories();
});

test("supervisor closes the pre-registration SIGKILL window", {timeout: 120_000}, async () => {
  await assertNoPrivateRunDirectories();
  const killed = start({AGTMAI_LOCAL_EVM_FAULT: "after-anvil-spawn-before-registration"});
  const fault = await waitForFault(killed, "after-anvil-spawn-before-registration", 30_000);
  const identity = fault.childIdentity as {pid: number; processStart: string};
  assert.equal(await authenticateProcess(identity), "owned");
  assert.equal(killed.child.kill("SIGKILL"), true);
  assert.notEqual((await killed.result).exitCode, 0);
  await waitFor(async () => await authenticateProcess(identity) !== "owned", 15_000, "supervised Anvil termination");

  const recovered = await run();
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  rememberReport(lastJson(recovered.stdout));
  assert.notEqual(await authenticateProcess(identity), "owned");
  await assertNoPrivateRunDirectories();
});

test("a later run reclaims a killed markerless initializer", {timeout: 120_000}, async () => {
  await assertNoPrivateRunDirectories();
  const killed = start({AGTMAI_LOCAL_EVM_FAULT: "after-run-directory-before-lease"});
  await waitForFault(killed, "after-run-directory-before-lease", 15_000);
  const [directory] = await runDirectories();
  assert(directory);
  await assert.rejects(readFile(join(privateRoot, directory, "lease.v1.json")));
  assert.equal(killed.child.kill("SIGKILL"), true);
  assert.notEqual((await killed.result).exitCode, 0);

  const recovered = await run();
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  rememberReport(lastJson(recovered.stdout));
  await assertNoPrivateRunDirectories();
});

interface StartedRun {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly pid: number;
  readonly result: Promise<RunResult>;
  stdout(): string;
}

function start(extraEnv: NodeJS.ProcessEnv = {}): StartedRun {
  const child = spawn(process.execPath, [runnerPath], { cwd: repositoryRoot, env: {...process.env, ...extraEnv}, stdio: ["ignore", "pipe", "pipe"] });
  assert.notEqual(child.pid, undefined);
  const pid = child.pid!;
  activeChildren.add(child);
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  let stdout = ""; let stderr = "";
  let timedOut = false;
  let escalation: NodeJS.Timeout | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    stderr += "\nrunner exceeded its 60s child-process deadline";
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
  }, 60_000);
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const result = new Promise<RunResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (escalation) {clearTimeout(escalation);}
      activeChildren.delete(child);
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : code ?? (signal ? 128 : 1) });
    });
  });
  return {child, pid, result, stdout: () => stdout};
}

interface RunResult { readonly stdout: string; readonly stderr: string; readonly exitCode: number }
async function run(): Promise<RunResult> { return await start().result; }

async function runDirectories(): Promise<string[]> {
  try { return (await readdir(privateRoot)).filter((name) => name.startsWith("run-")); } catch { return []; }
}

async function readPid(path: string): Promise<number | undefined> {
  try {
    const pid = Number(await readFile(path, "utf8"));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

async function anvilPids(): Promise<number[]> {
  const values = await Promise.all((await runDirectories()).map((directory) => readPid(join(privateRoot, directory, "anvil.pid"))));
  return values.filter((value): value is number => value !== undefined);
}

async function waitForFault(started: StartedRun, point: string, timeout: number): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await waitFor(async () => {
    for (const line of started.stdout().trim().split(/\r?\n/u)) {
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)
          && "faultPoint" in value && value.faultPoint === point) {
          found = value as Record<string, unknown>;
          return true;
        }
      } catch { /* continue */ }
    }
    return false;
  }, timeout, point);
  return found!;
}

async function assertNoPrivateRunDirectories(): Promise<void> {
  assert.deepEqual(await runDirectories(), []);
}

async function waitFor(predicate: () => Promise<boolean>, timeout: number, label: string): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) {return;} await delay(50); }
  assert.fail(`timed out waiting for ${label}`);
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopChild(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {return;}
  const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  child.kill("SIGTERM");
  if (!await Promise.race([closed.then(() => true), delay(5_000).then(() => false)])) {
    child.kill("SIGKILL");
    await closed;
  }
}

function lastJson(output: string): Record<string, unknown> {
  for (const line of output.trim().split(/\r?\n/u).toReversed()) {
    try { const value: unknown = JSON.parse(line); if (value && typeof value === "object" && !Array.isArray(value)) {return value as Record<string, unknown>;} } catch { /* continue */ }
  }
  assert.fail(`missing JSON output: ${output}`);
}

function rememberReport(result: Record<string, unknown>): void {
  assert.equal(typeof result.reportDirectory, "string");
  generatedReports.add(result.reportDirectory as string);
}

async function assertRedactedReport(directory: string): Promise<void> {
  const json = await readFile(join(directory, "verification-report.v1.json"), "utf8");
  const markdown = await readFile(join(directory, "verification-summary.md"), "utf8");
  for (const text of [json, markdown]) {
    assert.doesNotMatch(text, /private[_-]?key|mnemonic|seed phrase|https?:\/\/(?!127\.0\.0\.1)/iu);
    assert.doesNotMatch(text, /test test test test test test test test test test test junk/iu);
  }
}
