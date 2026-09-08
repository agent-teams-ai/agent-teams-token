import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPoolConfigPredecessor, broadcastPoolConfig } from "../src/composition/configure-solana-pool.mjs";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import { poolConfigInstructions, verifySolanaPoolConfigIntent } from "../src/domain/solana-pool-config.ts";
import { runSolanaPoolConfigJournal } from "../src/application/solana-pool-config-journal.ts";
import { repairRates } from "./solana-pool-config-fixture.mjs";
const key = n => "1".repeat(31) + "123456789ABCDEFG"[n];
const base = { testOnly: true, cluster: "solana-devnet", payer: key(1), mint: key(2), pool: key(3), chain: key(4),
  signer: key(5), ata: key(6), registry: key(7), routerConfig: key(8), feeTokenConfig: key(9), routerPoolSigner: key(10),
  alt: key(11), recentSlot: "100", altBump: 255 };
for (const operation of ["set-pool", "repair-remote-pool-encoding"]) {
test(`${operation} reobserves predecessor under durable lock, binds ALT and never replaces or resends it`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-pool-config-test-"));
  try {
    const previous = { ...base, operation: operation === "set-pool" ? "create-lookup-table" : "set-pool" }, expected = { ...base, operation };
    const intent = { feePayer: previous.payer, instructions: poolConfigInstructions(previous) };
    const signed = { bytesBase64: "c2lnbmVk", signature: "2".repeat(88), blockhash: "3".repeat(44), lastValidBlockHeight: "150" }, messageBase64 = "bWVzc2FnZQ==";
    const record = { schema: "agtmai-solana-pool-config-journal-v1", phase: "succeeded", signed, messageBase64, intent: verifySolanaPoolConfigIntent(intent, previous) };
    const file = createJournalFile(join(directory, previous.operation + ".json"));
    let reads = 0;
    const sdk = { derive: () => previous, inspectSigned: () => ({ ...signed, messageBase64, intent }) };
    const rpc = { observe: async () => { reads++; return { kind: "finalized", signature: signed.signature, messageBase64, slot: "150", err: null,
      state: { operation: previous.operation, mint: previous.mint, verified: true } }; }, broadcast: async () => { assert.fail("no predecessor send"); } };
    rpc.observeRepairPredecessor = rpc.observe;
    const settings = { journalDirectory: directory }, ports = { sdk, rpc };
    await assert.rejects(verifyPoolConfigPredecessor(settings, expected, ports), /not finalized/);
    await file.exclusive(() => file.write(record));
    await verifyPoolConfigPredecessor(settings, expected, ports); assert.equal(reads, 1);
    await assert.rejects(verifyPoolConfigPredecessor(settings, { ...expected, alt: key(12) }, ports), /predecessor ALT/);
    await assert.rejects(verifyPoolConfigPredecessor(settings, { ...expected, recentSlot: "101" }, ports), /predecessor ALT/);
    for (const phase of ["signed", "submitting", "submitted", "failed"]) {
      await file.exclusive(() => file.write({ ...record, phase }));
      await assert.rejects(verifyPoolConfigPredecessor(settings, expected, ports), /not finalized/);
    }
    await file.exclusive(() => file.write(record));
    rpc.observe = async () => ({ kind: "unknown" });
    rpc.observeRepairPredecessor = rpc.observe;
    await assert.rejects(verifyPoolConfigPredecessor(settings, expected, ports), /unreadable or unresolved/);
    assert.equal(reads, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
}


test("resumed signed repair rechecks prerequisites before network send and never retries after guard failure", async () => {
  const expected = { ...base, operation: "repair-remote-pool-encoding", repairRateLimitsBase64: repairRates.toString("base64") };
  const intent = { feePayer: expected.payer, instructions: poolConfigInstructions(expected) };
  const signed = { bytesBase64: "c2lnbmVk", signature: "2".repeat(88), blockhash: "3".repeat(44), lastValidBlockHeight: "150" };
  const messageBase64 = "bWVzc2FnZQ==";
  let record = { schema: "agtmai-solana-pool-config-journal-v1", phase: "signed", signed, messageBase64, intent: verifySolanaPoolConfigIntent(intent, expected) };
  let sends = 0, chains = 0, snapshots = 0;
  const rpc = { chain: async () => { chains++; }, readRpc: async () => ({ context: { slot: 200 }, value: [] }),
    broadcast: async () => { sends++; return signed.signature; } };
  const sdk = { snapshotAddresses: () => [], verifySnapshot: () => { snapshots++; throw new Error("repair prerequisite changed"); } };
  const ports = { exclusive: async f => f(), read: async () => record, write: async next => { record = next; },
    sign: async () => { assert.fail("must not replace signed repair"); }, inspectSigned: async () => ({ ...signed, messageBase64, intent }),
    observe: async () => ({ kind: "not-found" }), broadcast: bytes => broadcastPoolConfig(bytes, expected, rpc, sdk) };
  assert.equal((await runSolanaPoolConfigJournal(expected, ports)).status, "unresolved");
  assert.equal(record.phase, "submitting"); assert.equal(chains, 1); assert.equal(snapshots, 1); assert.equal(sends, 0);
  assert.equal((await runSolanaPoolConfigJournal(expected, ports)).status, "unresolved");
  assert.equal(snapshots, 1); assert.equal(sends, 0);
});
