import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { main } from "../src/composition/index.ts";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const platform = process.platform === "linux" && process.arch === "x64" ? "linux-x64"
  : process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : null;
const binaryRoot = platform === null ? null : join(repositoryRoot, `.tools/agave-v4.2.1-${platform}/bin`);
const available = binaryRoot !== null && await Promise.all(["solana", "solana-keygen", "solana-test-validator", "spl-token"].map(async (name) => await access(join(binaryRoot, name)).then(() => true, () => false))).then((values) => values.every(Boolean));

test("real local validator completes mint-burn-negative-authority lifecycle", { skip: available ? false : "checksum-pinned Agave fixture binaries are not installed" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-real-local-")); await chmod(boundary, 0o700); const output = join(boundary, "output");
  try {
    await main(["--output", output]);
    const { readdir } = await import("node:fs/promises"); const bundles = await readdir(output); assert.equal(bundles.length, 1);
    const directory = join(output, bundles[0] as string); const report = JSON.parse(await readFile(join(directory, "evidence-report.v1.json"), "utf8"));
    assert.equal(report.finalSupply, "0"); assert.equal(report.freezeAuthority, null); assert.equal(report.assertions.mintAuthorityRevoked, false);
    assert.equal(report.assertions.authorityKeyRetained, false); assert.equal(report.assertions.remintPossibleUntilTeardown, true); assert.equal(report.assertions.productionHardCapProven, false);
    await access(join(directory, "READY"));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("two separately spawned real fixture processes hold distinct cross-process leases", { skip: available ? false : "checksum-pinned Agave fixture binaries are not installed" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-real-parallel-")); await chmod(boundary, 0o700);
  try {
    const script = join(repositoryRoot, "scripts/solana/local-fixture.ts");
    const run = async (output: string): Promise<void> => await new Promise((_resolve, reject) => {
      const child = spawn(process.execPath, [script, "--output", output], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] }); let diagnostics = "";
      child.stdout.on("data", (chunk) => { diagnostics += String(chunk); }); child.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
      child.once("close", (code) => { if (code === 0) { _resolve(); } else { reject(new Error(`fixture process exited ${code}: ${diagnostics}`)); } }); child.once("error", reject);
    });
    await Promise.all([run(join(boundary, "one")), run(join(boundary, "two"))]);
  }
  finally { await rm(boundary, { recursive: true, force: true }); }
});
