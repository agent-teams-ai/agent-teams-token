import assert from "node:assert/strict";
import fs, { access, chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as pathResolve } from "node:path";
import test from "node:test";
import { main } from "../src/composition/index.ts";
import childProcesses, { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { processStartIdentity } from "../src/adapters/process-identity.ts";

const repositoryRoot = pathResolve(import.meta.dirname, "../../..");
const platform = process.platform === "linux" && process.arch === "x64" ? "linux-x64"
  : process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : null;
const binaryRoot = platform === null ? null : join(repositoryRoot, `.tools/agave-v4.2.1-${platform}/bin`);
const available = binaryRoot !== null && await Promise.all(["solana", "solana-keygen", "solana-test-validator", "spl-token"].map(async (name) => await access(join(binaryRoot, name)).then(() => true, () => false))).then((values) => values.every(Boolean));
const required = process.env.AGTMAI_SOLANA_REAL_TESTS_REQUIRED === "1";
const parallelStressRounds = 3;

test("strict CI mode requires every checksum-pinned Solana fixture binary", { skip: required ? false : "strict real-binary mode is CI-only" }, () => {
  assert.equal(available, true, "AGTMAI_SOLANA_REAL_TESTS_REQUIRED=1 but pinned fixture binaries are unavailable");
});

test("real local validator completes mint-burn-negative-authority lifecycle", { skip: available ? false : required ? false : "checksum-pinned Agave fixture binaries are not installed" }, async () => {
  assert.equal(available, true);
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-real-local-")); await chmod(boundary, 0o700); const output = join(boundary, "output");
  try {
    const exitCode = await main(["--output", output]);
    const bundles = await readdir(output).catch(() => []);
    if (exitCode !== 0) {
      assert.equal(exitCode, 0, "real fixture failed with sanitized diagnostic " + await failureDiagnostic(output, bundles));
    }
    assert.equal(bundles.length, 1, "success must publish exactly one evidence bundle");
    const directory = join(output, bundles[0] as string); assert.match(bundles[0] as string, /^evidence-[A-Za-z0-9._-]+$/u);
    assert.deepEqual((await readdir(directory)).toSorted(), ["READY", "evidence-report.v1.json", "evidence-report.v1.md"]);
    const report = JSON.parse(await readFile(join(directory, "evidence-report.v1.json"), "utf8"));
    assert.equal(report.status, "READY"); assert.equal(report.finalSupply, "0"); assert.equal(report.freezeAuthority, null); assert.equal(report.assertions.mintAuthorityRevoked, false);
    assert.equal(report.assertions.authorityKeyRetained, false); assert.equal(report.assertions.remintPossibleUntilTeardown, true); assert.equal(report.assertions.productionHardCapProven, false);
    await access(join(directory, "READY"));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("two separately spawned real fixture processes hold distinct cross-process leases", { skip: available ? false : required ? false : "checksum-pinned Agave fixture binaries are not installed" }, async () => {
  assert.equal(available, true);
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-real-parallel-")); await chmod(boundary, 0o700);
  try {
    const script = join(repositoryRoot, "scripts/solana/local-fixture.ts");
    for (let round = 0; round < parallelStressRounds; round += 1) {
      await runFixturePair(script, join(boundary, `${round}-one`), join(boundary, `${round}-two`));
    }
  }
  finally { await rm(boundary, { recursive: true, force: true }); }
});

async function failureDiagnostic(output: string, bundles: readonly string[], fallback = "SOLANA_FAILURE_EVIDENCE_MISSING"): Promise<string> {
  if (bundles.length !== 1 || !bundles[0]?.startsWith("failure-evidence-")) { return fallback; }
  try {
    const report = JSON.parse(await readFile(join(output, bundles[0], "failure-evidence-report.v1.json"), "utf8")) as { readonly diagnosticCode?: unknown };
    return typeof report.diagnosticCode === "string" && /^[A-Z][A-Z0-9_]{2,95}$/u.test(report.diagnosticCode) ? report.diagnosticCode : "SOLANA_FAILURE_EVIDENCE_INVALID";
  } catch { return "SOLANA_FAILURE_EVIDENCE_INVALID"; }
}

test("missing private failure evidence falls back to the sanitized public boundary diagnostic", async () => {
  assert.equal(await failureDiagnostic("unused", [], "SOLANA_FIXTURE_FAILED"), "SOLANA_FIXTURE_FAILED");
  assert.equal(publicFailureDiagnostic({ status: "FAILED", diagnosticCode: "SOLANA_RPC_LISTENER_IDENTITY" }), "SOLANA_CHILD_BOUNDARY_INVALID");
});

async function runFixturePair(script: string, firstOutput: string, secondOutput: string): Promise<void> {
  const results = await Promise.allSettled([runFixtureProcess(script, firstOutput), runFixtureProcess(script, secondOutput)]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure !== undefined) { throw failure.reason; }
}

async function runFixtureProcess(script: string, output: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--output", output], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false; let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true; child.kill("SIGTERM"); killTimer = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
    }, 120_000);
    const cleanup = (): void => { clearTimeout(timer); if (killTimer !== undefined) { clearTimeout(killTimer); } };
    child.stdout.on("data", (chunk) => { stdout = bounded(stdout, String(chunk)); });
    child.stderr.on("data", (chunk) => { stderr = bounded(stderr, String(chunk)); });
    child.once("close", (code) => {
      cleanup();
      if (timedOut) { reject(new Error("fixture process exceeded bounded deadline")); return; }
      const result = publicBoundaryResult(stdout, stderr);
      if (code === 0 && result.status === "READY") { resolve(); return; }
      const fallback = publicFailureDiagnostic(result);
      void readdir(output).then(async (bundles) => await failureDiagnostic(output, bundles, fallback), () => fallback)
        .then((diagnostic) => reject(new Error("fixture process failed with sanitized diagnostic " + diagnostic)));
    });
    child.once("error", () => { cleanup(); reject(new Error("fixture process spawn failed")); });
  });
}

function publicBoundaryResult(stdout: string, stderr: string): { readonly status?: unknown; readonly diagnosticCode?: unknown } {
  for (const line of (stdout + "\n" + stderr).split("\n").toReversed()) {
    try {
      const value = JSON.parse(line) as { readonly status?: unknown; readonly diagnosticCode?: unknown };
      if (value.status === "READY" || value.status === "FAILED") { return value; }
    } catch {}
  }
  return {};
}

function publicFailureDiagnostic(value: { readonly status?: unknown; readonly diagnosticCode?: unknown }): string {
  return value.status === "FAILED" && (value.diagnosticCode === "SOLANA_CLI_USAGE" || value.diagnosticCode === "SOLANA_FIXTURE_FAILED")
    ? value.diagnosticCode : "SOLANA_CHILD_BOUNDARY_INVALID";
}

function bounded(previous: string, chunk: string): string { return (previous + chunk).slice(-4096); }

test("genuine pinned Agave owner SIGKILL preserves pre-registration custody before immediate reclamation", { skip: available ? false : required ? false : "checksum-pinned Agave fixture binaries are not installed", timeout: 120_000 }, async () => {
  assert.equal(available, true);
  const { genuineAgaveRecovery } = await import("./helpers/agave-recovery.ts");
  await genuineAgaveRecovery(repositoryRoot);
});

for (const signalFailure of ["ESRCH", "EACCES"] as const) {
test(`genuine Agave cleanup preserves the primary failure after custodian exit: ${signalFailure}`, {
  skip: process.platform !== "linux" ? "race uses Linux procfs" : available ? false : required ? false : "checksum-pinned Agave fixture binaries are not installed",
  timeout: 10_000,
}, async (t) => {
  assert.equal(available, true);
  const { genuineAgaveRecovery } = await import("./helpers/agave-recovery.ts");
  const originalSpawn = childProcesses.spawn; const originalFork = childProcesses.fork; const originalRead = fs.readFile;
  const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
  const observe = (child: ChildProcess): ChildProcess => { children.push({ child, closed: once(child, "close") }); return child; };
  let custodian: { pid: number; start: string; directory: string } | undefined;
  const primary = new Error("genuine recovery primary fixture failure"); let injected = false; let raced = false;
  const denied = Object.assign(new Error("injected recovery signal denial"), { code: "EACCES" });
  let timer: NodeJS.Timeout | undefined;
  if (signalFailure === "EACCES") {
    const originalKill = process.kill;
    // Fault injection checks that non-ESRCH failures retain real snapshots;
    // all other signals and every process/filesystem effect remain genuine.
    t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
      if (raced && pid === custodian?.pid && signal === "SIGCONT") { throw denied; }
      return originalKill(pid, signal);
    });
  }
  t.mock.method(childProcesses, "spawn", (...args: Parameters<typeof originalSpawn>) => {
    const child = originalSpawn(...args); return args[0] === process.execPath ? observe(child) : child;
  });
  t.mock.method(childProcesses, "fork", (...args: Parameters<typeof originalFork>) => observe(originalFork(...args)));
  t.mock.method(fs, "readFile", (async (...args: Parameters<typeof originalRead>) => {
    const value = await originalRead(...args);
    if (typeof args[0] === "string" && args[0].endsWith("/.agtmai-validator-startup.json")) {
      const record = JSON.parse(String(value)); custodian = { ...record.supervisor, directory: record.directory };
    }
    if (custodian !== undefined && args[0] === join(custodian.directory, ".agtmai-local-solana-lease.json") && !injected) {
      injected = true; throw primary;
    }
    if (injected && !raced && custodian !== undefined && args[0] === `/proc/${custodian.pid}/stat`) {
      raced = true;
      // Hold a real, exact identity observation across orderly native shutdown.
      // The still-live owner reaps the custodian; no syscall result is fabricated.
      assert.equal(await processStartIdentity(custodian.pid), custodian.start);
      process.kill(custodian.pid, "SIGTERM");
      let absent = false;
      for (let attempt = 0; attempt < 200 && !absent; attempt += 1) {
        absent = await originalRead(...args).then(() => false, (cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT" || cause.code === "ESRCH") { return true; } throw cause;
        });
        if (!absent) { await delay(10); }
      }
      assert.equal(absent, true, "owned custodian must be reaped before the stale observation returns");
      assert.throws(() => { process.kill(custodian!.pid, 0); }, { code: "ESRCH" });
    }
    return value;
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  try {
    const recovery = genuineAgaveRecovery(repositoryRoot);
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error("genuine recovery failed to drain owned children")); }, 4_000);
    });
    const cause = await Promise.race([recovery, deadline]).then(() => null, (failure: unknown) => failure);
    assert.equal(raced, true, `fixture must reach the authenticated custodian race: ${String(cause)}`); assert.equal(children.length, 2);
    if (signalFailure === "ESRCH" && cause !== primary) {
      const neighbour = children[0]!.child; assert.ok(neighbour.pid); process.kill(neighbour.pid, 0);
      t.diagnostic(`cleanup failure left the genuine fixture neighbour live: ${String(cause)}`);
    }
    if (signalFailure === "ESRCH") { assert.equal(cause, primary, "cleanup must preserve the original failure instead of kill ESRCH"); }
    else {
      assert.ok(cause instanceof AggregateError); assert.deepEqual(cause.errors, [primary, denied]); assert.equal(cause.cause, primary);
    }
    for (const { child, closed } of children) { await closed; assert.equal(child.signalCode, "SIGKILL"); }
    assert.ok(custodian);
    const fixtureRoot = dirname(dirname(custodian.directory));
    if (signalFailure === "ESRCH") { await assert.rejects(lstat(fixtureRoot), { code: "ENOENT" }); }
    else {
      const runs = join(fixtureRoot, "runs"); const entries = await fs.readdir(runs);
      assert.equal(entries.length, 3, "signal denial retains both runs and the authenticated snapshot inventory");
      for (const entry of entries) { assert.equal((await lstat(join(runs, entry))).isDirectory(), true); }
      t.diagnostic(`signal denial retains genuine fixture state and snapshots: ${fixtureRoot}`);
    }
  } finally {
    if (timer !== undefined) { clearTimeout(timer); }
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); }
      await closed;
    }
  }
});
}
