import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import test from "node:test";
import { main } from "../src/composition/index.ts";
import { spawn } from "node:child_process";

const repositoryRoot = pathResolve(import.meta.dirname, "../../..");
const platform = process.platform === "linux" && process.arch === "x64" ? "linux-x64"
  : process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : null;
const binaryRoot = platform === null ? null : join(repositoryRoot, `.tools/agave-v4.2.1-${platform}/bin`);
const available = binaryRoot !== null && await Promise.all(["solana", "solana-keygen", "solana-test-validator", "spl-token"].map(async (name) => await access(join(binaryRoot, name)).then(() => true, () => false))).then((values) => values.every(Boolean));
const required = process.env.AGTMAI_SOLANA_REAL_TESTS_REQUIRED === "1";

test("strict CI mode requires every checksum-pinned Solana fixture binary", { skip: required ? false : "strict real-binary mode is CI-only" }, () => {
  assert.equal(available, true, "AGTMAI_SOLANA_REAL_TESTS_REQUIRED=1 but pinned fixture binaries are unavailable");
});

test("real local validator completes mint-burn-negative-authority lifecycle", { skip: available ? false : required ? false : "checksum-pinned Agave fixture binaries are not installed" }, async () => {
  assert.equal(available, true);
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-real-local-")); await chmod(boundary, 0o700); const output = join(boundary, "output");
  try {
    const exitCode = await main(["--output", output]);
    const { readdir } = await import("node:fs/promises"); const bundles = await readdir(output).catch(() => []);
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
    await Promise.all([runFixtureProcess(script, join(boundary, "one")), runFixtureProcess(script, join(boundary, "two"))]);
  }
  finally { await rm(boundary, { recursive: true, force: true }); }
});

async function failureDiagnostic(output: string, bundles: readonly string[]): Promise<string> {
  if (bundles.length !== 1 || !bundles[0]?.startsWith("failure-evidence-")) { return "SOLANA_FAILURE_EVIDENCE_MISSING"; }
  try {
    const report = JSON.parse(await readFile(join(output, bundles[0], "failure-evidence-report.v1.json"), "utf8")) as { readonly diagnosticCode?: unknown };
    return typeof report.diagnosticCode === "string" && /^[A-Z][A-Z0-9_]{2,95}$/u.test(report.diagnosticCode) ? report.diagnosticCode : "SOLANA_FAILURE_EVIDENCE_INVALID";
  } catch { return "SOLANA_FAILURE_EVIDENCE_INVALID"; }
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
      const diagnostic = typeof result.diagnosticCode === "string" && /^[A-Z][A-Z0-9_]{2,95}$/u.test(result.diagnosticCode) ? result.diagnosticCode : "SOLANA_CHILD_BOUNDARY_INVALID";
      reject(new Error("fixture process failed with sanitized diagnostic " + diagnostic));
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

function bounded(previous: string, chunk: string): string { return (previous + chunk).slice(-4096); }
