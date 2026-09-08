import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPoolConfigPredecessor } from "../src/composition/configure-solana-pool.mjs";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import { poolConfigInstructions, verifySolanaPoolConfigIntent } from "../src/domain/solana-pool-config.ts";
const key = n => "1".repeat(31) + "123456789ABCDEFG"[n];
const base = { testOnly: true, cluster: "solana-devnet", payer: key(1), mint: key(2), pool: key(3), chain: key(4),
  signer: key(5), ata: key(6), registry: key(7), routerConfig: key(8), feeTokenConfig: key(9), routerPoolSigner: key(10),
  alt: key(11), recentSlot: "100", altBump: 255 };
test("setPool reobserves predecessor under durable lock, binds ALT and never replaces or resends it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-pool-config-test-"));
  try {
    const previous = { ...base, operation: "create-lookup-table" }, expected = { ...base, operation: "set-pool" };
    const intent = { feePayer: previous.payer, instructions: poolConfigInstructions(previous) };
    const signed = { bytesBase64: "c2lnbmVk", signature: "2".repeat(88), blockhash: "3".repeat(44), lastValidBlockHeight: "150" }, messageBase64 = "bWVzc2FnZQ==";
    const record = { schema: "agtmai-solana-pool-config-journal-v1", phase: "succeeded", signed, messageBase64, intent: verifySolanaPoolConfigIntent(intent, previous) };
    const file = createJournalFile(join(directory, previous.operation + ".json"));
    let reads = 0;
    const sdk = { derive: () => previous, inspectSigned: () => ({ ...signed, messageBase64, intent }) };
    const rpc = { observe: async () => { reads++; return { kind: "finalized", signature: signed.signature, messageBase64, slot: "150", err: null,
      state: { operation: previous.operation, mint: previous.mint, verified: true } }; }, broadcast: async () => { assert.fail("no predecessor send"); } };
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
    await assert.rejects(verifyPoolConfigPredecessor(settings, expected, ports), /unreadable or unresolved/);
    assert.equal(reads, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
