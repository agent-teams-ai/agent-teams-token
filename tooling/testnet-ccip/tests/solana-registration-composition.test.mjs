import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPreviousRegistrationCheckpoint, broadcastRegistration } from "../src/composition/register-solana-pool.mjs";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import { registrationInstruction, verifySolanaRegistrationIntent } from "../src/domain/solana-registration.ts";
import { runSolanaRegistrationJournal } from "../src/application/solana-registration-journal.ts";
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

function signedTransferFixture(phase = "signed") {
  const e = { ...expected, operation: "transfer-mint-authority" };
  // Independent SPL SetAuthority instruction: MintTokens authority to key(5).
  const intent = { feePayer: e.payer, instructions: [{
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    accounts: [{ address: e.mint, isSigner: false, isWritable: true },
      { address: e.payer, isSigner: true, isWritable: true }],
    dataBase64: Buffer.from([6, 0, 1, ...Array(31).fill(0), 4]).toString("base64"),
  }] };
  const signed = { bytesBase64: "c2lnbmVk", signature: "2".repeat(88), blockhash: "3".repeat(44), lastValidBlockHeight: "150" };
  const messageBase64 = "bWVzc2FnZQ==", events = [];
  let record = { schema: "agtmai-solana-registration-journal-v1", phase, signed, messageBase64,
    intent: verifySolanaRegistrationIntent(intent, e) };
  const rpc = {
    chain: async () => { events.push("chain"); },
    readRpc: async (method, params) => {
      assert.equal(method, "getMultipleAccounts");
      assert.deepEqual(params, [[e.mint, e.pool, e.ata, e.registry, e.routerConfig, e.signer],
        { encoding: "base64", commitment: "finalized", minContextSlot: 0 }]);
      return { context: { slot: 200 }, value: Array(6).fill(null) };
    },
    broadcast: async bytes => {
      assert.equal(record.phase, "submitting"); assert.equal(bytes, signed.bytesBase64);
      events.push("broadcast"); return signed.signature;
    },
  };
  const sdk = {
    snapshotAddresses: () => [e.mint, e.pool, e.ata, e.registry, e.routerConfig, e.signer],
    verifySnapshot: (values, actual, when) => {
      assert.equal(values.length, 6); assert.equal(actual, e); assert.equal(when, "before");
      events.push("before"); throw new Error("pool ownership/registry prerequisites changed");
    },
  };
  const ports = {
    exclusive: async work => work(), read: async () => record, write: async next => { record = next; },
    sign: async () => { assert.fail("signed restart must not sign again"); },
    inspectSigned: async bytes => { assert.equal(bytes, signed.bytesBase64); return { ...signed, messageBase64, intent }; },
    observe: async () => { events.push("observe"); return { kind: "not-found" }; },
    broadcast: bytes => broadcastRegistration(bytes, e, rpc, sdk),
  };
  const finalized = { kind: "finalized", signature: signed.signature, messageBase64, slot: "200", err: null,
    state: { operation: e.operation, mint: e.mint, verified: true } };
  return { e, signed, rpc, sdk, ports, events, finalized, record: () => record,
    run: () => runSolanaRegistrationJournal(e, ports) };
}

test("signed transfer restart rejects changed prerequisites before first broadcast, then remains observation-only", async () => {
  const f = signedTransferFixture();
  await assert.rejects(broadcastRegistration(f.signed.bytesBase64, f.e, f.rpc, f.sdk), /prerequisites changed/);
  f.events.length = 0;
  const result = await f.run();
  assert.equal(result.status, "unresolved"); assert.equal(result.reason, "broadcast-outcome-unknown");
  assert.equal(f.record().phase, "submitting");
  assert.deepEqual(f.events, ["observe", "chain", "before"]);
  f.events.length = 0;
  await f.run(); assert.deepEqual(f.events, ["observe"]);
  f.ports.observe = async () => f.finalized;
  assert.equal((await f.run()).status, "succeeded");
  assert.equal(f.record().phase, "succeeded");
});

test("signed transfer restart checks chain identity before prerequisites or sending", async () => {
  const f = signedTransferFixture();
  f.rpc.chain = async () => { f.events.push("wrong-chain"); throw new Error("not Devnet"); };
  assert.equal((await f.run()).status, "unresolved");
  assert.deepEqual(f.events, ["observe", "wrong-chain"]);
});

test("unchanged signed transfer restart broadcasts once after the current before snapshot", async () => {
  const f = signedTransferFixture();
  f.sdk.verifySnapshot = (_values, _expected, when) => {
    assert.equal(when, "before"); f.events.push("before"); return { verified: true };
  };
  assert.equal((await f.run()).reason, "submitted-awaiting-finality");
  assert.equal(f.record().phase, "submitted");
  assert.deepEqual(f.events, ["observe", "chain", "before", "broadcast"]);
  f.events.length = 0;
  await f.run(); assert.deepEqual(f.events, ["observe"]);
});

test("already submitted transfer can be observed with changed before prerequisites and never resent", async () => {
  const f = signedTransferFixture("submitted");
  for (const kind of ["unknown", "not-found", "expired"]) {
    f.ports.observe = async () => ({ kind });
    assert.equal((await f.run()).status, "unresolved");
    assert.equal(f.record().phase, "submitted");
  }
  f.ports.observe = async () => f.finalized;
  assert.equal((await f.run()).status, "succeeded");
  assert.equal((await f.run()).status, "succeeded");
  assert.deepEqual(f.events, []);
});
