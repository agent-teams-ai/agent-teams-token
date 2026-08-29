import assert from "node:assert/strict";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateRunStore, ensurePrivateRoot } from "../src/adapters/filesystem.ts";
import { CLASSIC_TOKEN_PROGRAM, type EvidenceReport } from "../src/domain/model.ts";

function report(): EvidenceReport {
  return {
    schemaVersion: 1, status: "READY", identity: { name: "Agent Teams AI", symbol: "AGTMAI" }, programId: CLASSIC_TOKEN_PROGRAM, decimals: 9,
    testAmountBaseUnits: "1000000000000", initialSupply: "0", intermediateSupply: "1000000000000", finalSupply: "0", freezeAuthority: null,
    mintAuthority: "1".repeat(32), genesisHash: "1".repeat(32), validatorVersion: "4.2.1", transactions: [],
    assertions: { productionAuthorityProven: false, ccip: false, publicNetwork: false, realAssetCostUsd: 0, mintAuthorityRevoked: false, authorityKeyRetained: false, remintPossibleUntilTeardown: true, productionHardCapProven: false, signedRestoreReachedTokenProgramAndFailed: true, signedFreezeReachedTokenProgramAndFailed: true },
  };
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
