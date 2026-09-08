import assert from "node:assert/strict";
import test from "node:test";
import { REGISTRATION_OPERATIONS, registrationInstruction, verifySolanaRegistrationIntent } from "../src/domain/solana-registration.ts";
import type { SolanaRegistrationExpectation } from "../src/domain/solana-registration.ts";
import { runSolanaRegistrationJournal } from "../src/application/solana-registration-journal.ts";
import type { SolanaRegistrationRecord, SolanaRegistrationPorts, RegistrationStateEvidence } from "../src/application/solana-registration-journal.ts";
import type { SolanaObservation } from "../src/application/solana-transaction-journal.ts";
const key = (n: number) => "1".repeat(31) + String(n);
const expected: SolanaRegistrationExpectation = { testOnly: true, cluster: "solana-devnet", operation: "create-token-account",
  payer: key(2), mint: key(3), pool: key(4), signer: key(5), ata: key(6), registry: key(7), routerConfig: key(8) };
const signature = "2".repeat(88), blockhash = "3".repeat(44), messageBase64 = "bWVzc2FnZQ==";
test("each operation rejects every ordered account/privilege, data/program mutation and extra instruction", () => {
  for (const operation of REGISTRATION_OPERATIONS) {
    const e = { ...expected, operation }, ix = registrationInstruction(e);
    const verify = (instruction = ix) => verifySolanaRegistrationIntent({ feePayer: e.payer, instructions: [instruction] }, e);
    assert.equal(verify().operation, operation);
    for (let index = 0; index < ix.accounts.length; index++) {
      for (const field of ["address", "isSigner", "isWritable"] as const) {
        const accounts = ix.accounts.map((a, i) => index === i ? { ...a, [field]: field === "address" ? key(9) : !a[field] } : a);
        assert.throws(() => verify({ ...ix, accounts }));
      }
    }
    assert.throws(() => verify({ ...ix, programId: key(9) }));
    const data = Buffer.from(ix.dataBase64, "base64");
    for (let index = 0; index < data.length; index++) {
      const bad = Buffer.from(data); bad[index] ^= 1;
      assert.throws(() => verify({ ...ix, dataBase64: bad.toString("base64") }));
    }
    assert.throws(() => verifySolanaRegistrationIntent({ feePayer: e.payer, instructions: [ix, ix] }, e));
    assert.throws(() => verifySolanaRegistrationIntent({ feePayer: key(9), instructions: [ix] }, e));
  }
});
function setup(operation: SolanaRegistrationExpectation["operation"]) {
  const e = { ...expected, operation }, ix = registrationInstruction(e);
  const state = { record: null as SolanaRegistrationRecord | null, signs: 0, sends: 0,
    observation: { kind: "not-found" } as SolanaObservation<RegistrationStateEvidence>, failWrite: "", crashAfterWrite: false };
  const ports: SolanaRegistrationPorts = {
    exclusive: async fn => fn(), read: async () => state.record,
    write: async record => {
      if (state.failWrite === record.phase && !state.crashAfterWrite) { throw new Error("crash before write"); }
      state.record = structuredClone(record);
      if (state.failWrite === record.phase) { throw new Error("crash after write"); }
    },
    sign: async () => { state.signs++; return { bytesBase64: "c2lnbmVk", signature, blockhash, lastValidBlockHeight: "150" }; },
    inspectSigned: async () => ({ signature, blockhash, messageBase64, intent: { feePayer: e.payer, instructions: [ix] } }),
    observe: async () => state.observation,
    broadcast: async bytes => { assert.equal(state.record?.phase, "submitting"); assert.equal(bytes, "c2lnbmVk"); state.sends++; return signature; },
  };
  const finalized = (): SolanaObservation<RegistrationStateEvidence> => ({ kind: "finalized", signature, messageBase64, slot: "100", err: null,
    state: { operation, mint: e.mint, verified: true } });
  return { state, ports, e, finalized, run: () => runSolanaRegistrationJournal(e, ports) };
}
test("all four operations survive ambiguous submission without resend or replacement", async () => {
  for (const operation of REGISTRATION_OPERATIONS) {
    const { state, run, finalized } = setup(operation);
    state.failWrite = "submitting"; state.crashAfterWrite = true;
    await assert.rejects(run()); assert.equal(state.sends, 0);
    state.failWrite = "";
    for (const kind of ["unknown", "expired", "not-found"] as const) {
      state.observation = { kind }; assert.equal((await run()).status, "unresolved");
    }
    assert.equal(state.signs, 1); assert.equal(state.sends, 0);
    state.observation = finalized(); assert.equal((await run()).status, "succeeded");
    state.observation = { kind: "unknown" }; assert.equal((await run()).status, "unresolved");
    assert.equal(state.record?.phase, "succeeded");
  }
});
test("operation identity and poststate cannot cross journals; failed execution remains terminal", async () => {
  const { state, e, ports, run, finalized } = setup("accept-admin-role");
  await run();
  await assert.rejects(runSolanaRegistrationJournal({ ...e, operation: "transfer-mint-authority" }, ports));
  const outcome = finalized(); if (outcome.kind !== "finalized") { assert.fail(); }
  state.observation = { ...outcome, state: { operation: "create-token-account", mint: e.mint, verified: true } };
  assert.equal((await run()).status, "unresolved");
  state.observation = { ...outcome, err: { transactionError: "InvalidAccount" }, state: null };
  assert.equal((await run()).status, "failed");
  state.observation = finalized(); assert.equal((await run()).reason, "terminal-evidence-conflict");
  assert.equal(state.signs, 1); assert.equal(state.sends, 1);
});
test("failed signed persistence prevents all broadcasts", async () => {
  const { state, run } = setup("transfer-mint-authority"); state.failWrite = "signed";
  await assert.rejects(run()); assert.equal(state.sends, 0); assert.equal(state.record, null);
});
