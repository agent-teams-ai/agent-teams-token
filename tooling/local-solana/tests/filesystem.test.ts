import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { PrivateRunStore, ensurePrivateRoot } from "../src/adapters/filesystem.ts";
import { verifyObservations } from "../src/application/verifier.ts";
import type { EvidenceReport } from "../src/domain/model.ts";
import { observationFixture } from "./helpers/observations.ts";

function report(): EvidenceReport {
  return verifyObservations(observationFixture());
}

test("private store deletes keys and ledger while retaining READY-last sanitized evidence", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-test-")); await chmod(boundary, 0o700);
  const runs = join(boundary, "runs"); const output = join(boundary, "output");
  try {
    const store = new PrivateRunStore(runs, output); const paths = await store.create();
    await writeFile(paths.payerKey, "SENTINEL_SECRET"); await chmod(paths.payerKey, 0o600);
    await store.cleanup(paths); await assert.rejects(lstat(paths.directory));
    const published = await store.publish({} as never, report());
    const directory = join(published.jsonPath, "..");
    assert.equal(JSON.parse(await readFile(published.jsonPath, "utf8")).assertions.mintAuthorityRevoked, false);
    assert.equal((await readFile(published.markdownPath, "utf8")).includes("SENTINEL_SECRET"), false);
    const ready = await lstat(join(directory, "READY")); const json = await lstat(published.jsonPath); const markdown = await lstat(published.markdownPath);
    assert.equal(ready.mtimeMs >= json.mtimeMs && ready.mtimeMs >= markdown.mtimeMs, true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("publication rejects schema drift before creating READY", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-schema-")); await chmod(boundary, 0o700); const output = join(boundary, "output");
  try {
    const store = new PrivateRunStore(join(boundary, "runs"), output); const invalid = { ...report(), transactions: report().transactions.slice(1) };
    await assert.rejects(store.publish({} as never, invalid), /SOLANA_EVIDENCE_SCHEMA/u);
    await assert.rejects(lstat(output));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("private roots reject symlinks and permissive directories", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-hostile-")); const target = join(boundary, "target"); await mkdir(target, { mode: 0o700 });
  try {
    const linked = join(boundary, "linked"); await symlink(target, linked); await assert.rejects(ensurePrivateRoot(linked), /SOLANA_DIRECTORY_UNSAFE/u);
    const open = join(boundary, "open"); await mkdir(open, { mode: 0o755 }); await assert.rejects(ensurePrivateRoot(open), /SOLANA_DIRECTORY_UNSAFE/u);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("cleanup rejects stale READY-like directories and hardlinked lease markers", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-attack-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json"); await link(marker, join(paths.directory, "lease-copy"));
    await assert.rejects(store.cleanup(paths), /SOLANA_LEASE_UNSAFE/u);
    await rm(paths.directory, { recursive: true, force: true });
    const fake = join(boundary, "runs", "run-fake"); await mkdir(fake, { mode: 0o700 }); await writeFile(join(fake, "READY"), "forged");
    assert.equal(await store.reclaimStale(), 0); assert.equal((await lstat(fake)).isDirectory(), true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("a subsequent invocation reclaims only a valid dead owned lease", async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-reclaim-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json");
    const lease = JSON.parse(await readFile(marker, "utf8")); lease.pid = 2_000_000_000; await writeFile(marker, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    assert.equal(await store.reclaimStale(), 1); await assert.rejects(lstat(paths.directory));
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("normal cleanup refuses to delete state beneath a registered live validator", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "validator leases support Linux and Darwin" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-active-")); await chmod(boundary, 0o700); const store = new PrivateRunStore(join(boundary, "runs"), join(boundary, "out"));
  try {
    const paths = await store.create(); const marker = join(paths.directory, ".agtmai-local-solana-lease.json"); const lease = JSON.parse(await readFile(marker, "utf8"));
    lease.validator = { pid: process.pid, platform: process.platform, startTime: process.platform === "linux" ? "linux:1" : "darwin:61", executable: "/bin/validator", ledger: paths.ledger, commandHash: "a".repeat(64) };
    await writeFile(marker, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    await assert.rejects(store.cleanup(paths), /SOLANA_VALIDATOR_ACTIVE/u); assert.equal((await lstat(paths.directory)).isDirectory(), true);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("real parent SIGKILL reclaim authenticates, terminates and awaits its validator child", { skip: process.platform === "linux" || process.platform === "darwin" ? false : "authenticated stale-child reclaim requires Linux procfs or native Darwin ps identity" }, async () => {
  const boundary = await mkdtemp(join(tmpdir(), "agtmai-fs-sigkill-")); await chmod(boundary, 0o700);
  const runRoot = join(boundary, "runs"); const outputRoot = join(boundary, "out"); const readyPath = join(boundary, "ready.json");
  const parent = spawn(process.execPath, [join(import.meta.dirname, "helpers/start-owned-validator.ts"), runRoot, outputRoot, readyPath], { stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = ""; parent.stdout.on("data", (chunk) => { diagnostics += String(chunk); }); parent.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
  const neighbour = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    let ready: { readonly validatorPid: number; readonly runDirectory: string } | undefined;
    for (let attempt = 0; attempt < 600 && ready === undefined && parent.exitCode === null; attempt += 1) { try { ready = JSON.parse(await readFile(readyPath, "utf8")); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); } }
    assert.ok(ready, `validator helper did not become ready: ${diagnostics}`); parent.kill("SIGKILL"); await new Promise<void>((resolve) => parent.once("close", () => resolve()));
    assert.equal(processAlive(ready.validatorPid), true);
    assert.equal(await new PrivateRunStore(runRoot, outputRoot).reclaimStale(), 1);
    assert.equal(processAlive(ready.validatorPid), false); assert.equal(processAlive(neighbour.pid!), true); await assert.rejects(lstat(ready.runDirectory));
  } finally { if (parent.exitCode === null) { parent.kill("SIGKILL"); } if (neighbour.exitCode === null) { neighbour.kill("SIGKILL"); } await rm(boundary, { recursive: true, force: true }); }
});

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
