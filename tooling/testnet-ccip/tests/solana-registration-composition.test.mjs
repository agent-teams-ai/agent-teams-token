import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPreviousRegistrationCheckpoint } from "../src/composition/register-solana-pool.mjs";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import { registrationInstruction, verifySolanaRegistrationIntent } from "../src/domain/solana-registration.ts";
const key = n => "1".repeat(31) + String(n);
const expected = { testOnly: true, cluster: "solana-devnet", operation: "owner-propose-administrator",
  payer: key(2), mint: key(3), pool: key(4), signer: key(5), ata: key(6), registry: key(7), routerConfig: key(8) };
test("composition reads previous durable journal under lock, reobserves it, and never signs or broadcasts a predecessor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agtmai-registration-test-"));
  try {
    const previous = { ...expected, operation: "create-token-account" };
    const intent = { feePayer: previous.payer, instructions: [registrationInstruction(previous)] };
    const signed = { bytesBase64: "c2lnbmVk", signature: "2".repeat(88), blockhash: "3".repeat(44), lastValidBlockHeight: "150" };
    const messageBase64 = "bWVzc2FnZQ==";
    const record = { schema: "agtmai-solana-registration-journal-v1", intent: verifySolanaRegistrationIntent(intent, previous), signed, messageBase64, phase: "succeeded" };
    const file = createJournalFile(join(directory, "create-token-account.json"));
    let reads = 0;
    const sdk = { inspectSigned: bytes => { assert.equal(bytes, signed.bytesBase64); return { ...signed, messageBase64, intent }; } };
    const rpc = { observe: async () => { reads++; return { kind: "finalized", signature: signed.signature, messageBase64, slot: "100", err: null,
      state: { operation: previous.operation, mint: previous.mint, verified: true } }; },
      broadcast: async () => { assert.fail("must not broadcast predecessor"); } };
    await assert.rejects(verifyPreviousRegistrationCheckpoint(directory, expected, sdk, rpc), /not finalized/);
    await file.exclusive(() => file.write(record));
    await verifyPreviousRegistrationCheckpoint(directory, expected, sdk, rpc);
    assert.equal(reads, 1);
    for (const phase of ["signed", "submitting", "submitted", "failed"]) {
      await file.exclusive(() => file.write({ ...record, phase }));
      await assert.rejects(verifyPreviousRegistrationCheckpoint(directory, expected, sdk, rpc), /not finalized/);
    }
    await file.exclusive(() => file.write(record));
    rpc.observe = async () => ({ kind: "unknown" });
    await assert.rejects(verifyPreviousRegistrationCheckpoint(directory, expected, sdk, rpc), /unreadable or unresolved/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
