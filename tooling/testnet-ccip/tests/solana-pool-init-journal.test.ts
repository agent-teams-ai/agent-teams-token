import assert from "node:assert/strict";
import test from "node:test";
import { runSolanaPoolInitJournal } from "../src/application/solana-pool-init-journal.ts";
import type { SolanaPoolInitJournalRecord, SolanaPoolInitJournalPorts, PoolInitObservation, InspectedPoolInitTransaction } from "../src/application/solana-pool-init-journal.ts";
import { BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL } from "../src/domain/solana-pool-init.ts";
import { SYSTEM_PROGRAM } from "../src/domain/solana-mint.ts";
import type { SolanaPoolInitExpectation } from "../src/domain/solana-pool-init.ts";
const payer = "1".repeat(31) + "2";
const mint = "1".repeat(31) + "3";
const signature = "2".repeat(88);
const blockhash = "3".repeat(44);
const expected: SolanaPoolInitExpectation = { testOnly: true, cluster: "solana-devnet", payer, mint, pool: "DQ2LpgGVwXc62NNkqrwmhLMkUWuxVzMJhyt4p2Yw5aiJ" };
function decoded(): InspectedPoolInitTransaction {
  const accounts = [expected.pool, mint, payer, SYSTEM_PROGRAM, BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL];
  return { signature, blockhash, messageBase64: "bWVzc2FnZQ==", intent: { feePayer: payer, instructions: [{
    programId: BURNMINT_PROGRAM, dataBase64: Buffer.from("afaf6d1f0d989bed", "hex").toString("base64"),
    accounts: accounts.map((address, i) => ({ address, isSigner: i === 2, isWritable: i === 0 || i === 2 })),
  }] } };
}

const finalized = (): PoolInitObservation => ({ kind: "finalized", signature, messageBase64: "bWVzc2FnZQ==", slot: "100", err: null,
  poolState: { address: expected.pool, mint, owner: payer, verified: true } });
function setup() {
  const state = { record: null as SolanaPoolInitJournalRecord | null, signs: 0, sends: 0, failWrite: "", writeThenCrash: false,
    failSend: false, inspect: decoded(), observation: { kind: "not-found" } as PoolInitObservation, trace: [] as string[] };
  const ports: SolanaPoolInitJournalPorts = {
    exclusive: async fn => fn(), read: async () => state.record,
    write: async record => {
      state.trace.push(record.phase);
      if (state.failWrite === record.phase && !state.writeThenCrash) { throw new Error("crash"); }
      state.record = structuredClone(record);
      if (state.failWrite === record.phase) { throw new Error("crash after write"); }
    },
    sign: async () => { state.signs++; return { bytesBase64: "c2lnbmVk", signature, blockhash, lastValidBlockHeight: "150" }; },
    inspectSigned: async () => state.inspect,
    observe: async () => { state.trace.push("observe"); return state.observation; },
    broadcast: async bytes => {
      assert.equal(bytes, "c2lnbmVk"); assert.equal(state.record?.phase, "submitting");
      state.trace.push("send"); state.sends++;
      if (state.failSend) { throw new Error("timeout"); }
      return signature;
    },
  };
  return { state, ports, run: (expectation = expected) => runSolanaPoolInitJournal(expectation, ports) };
}
test("persists signed bytes, signature and validity identity before submitting and sending", async () => {
  const { state, run } = setup(); await run();
  assert.deepEqual(state.trace, ["signed", "observe", "submitting", "send", "submitted"]);
  assert.equal(state.record?.signed.lastValidBlockHeight, "150");
  await run(); assert.equal(state.signs, 1); assert.equal(state.sends, 1);
});
test("crashes before signed persistence or submitting persistence cannot broadcast", async () => {
  for (const phase of ["signed", "submitting"]) {
    const { state, run } = setup(); state.failWrite = phase;
    await assert.rejects(run()); assert.equal(state.sends, 0);
    if (phase === "submitting") {
      state.failWrite = ""; await run(); assert.equal(state.signs, 1); assert.equal(state.sends, 1);
    }
  }
});
test("crash after submitting marker, send timeout and expired signature never replace or resend", async () => {
  for (const failure of ["marker", "send", "submitted-write"]) {
    const { state, run } = setup();
    if (failure === "marker") { state.failWrite = "submitting"; state.writeThenCrash = true; }
    if (failure === "send") { state.failSend = true; }
    if (failure === "submitted-write") { state.failWrite = "submitted"; }
    if (failure === "send") { await run(); } else { await assert.rejects(run()); }
    const sends = state.sends; state.failWrite = "";
    for (const kind of ["not-found", "expired", "unknown"] as const) {
      state.observation = { kind }; assert.equal((await run()).status, "unresolved");
    }
    assert.equal(state.sends, sends); assert.equal(state.signs, 1);
    state.observation = finalized(); assert.equal((await run()).status, "succeeded");
  }
});
test("finalized execution error is terminal failure only for exact signature and message", async () => {
  const { state, run } = setup();
  state.observation = { ...finalized(), kind: "finalized", signature, messageBase64: "bWVzc2FnZQ==", slot: "100", err: { InstructionError: [0, "Custom"] }, poolState: null };
  assert.equal((await run()).status, "failed"); assert.equal(state.sends, 0);
  state.observation = finalized(); assert.equal((await run()).reason, "terminal-evidence-conflict");
});
test("wrong raw message/signature and incorrect pool state never succeed", async () => {
  const base = finalized(); if (base.kind !== "finalized") { assert.fail(); }
  for (const change of [{ signature: "4".repeat(88) }, { messageBase64: "b3RoZXI=" }, { slot: "-1" },
    { poolState: null }, { poolState: { ...base.poolState!, mint: payer } },
    { poolState: { ...base.poolState!, address: payer } },
    { poolState: { ...base.poolState!, owner: mint } }]) {
    const { state, run } = setup(); state.observation = { ...base, ...change };
    assert.equal((await run()).status, "unresolved"); assert.equal(state.sends, 0);
  }
});
test("stored intent/blockhash/message conflicts reject without signing or network effects", async () => {
  const { state, run } = setup(); await run();
  await assert.rejects(run({ ...expected, pool: mint }));
  state.inspect = { ...state.inspect, blockhash: "4".repeat(44) };
  await assert.rejects(run(), /identity mismatch/);
  assert.equal(state.signs, 1); assert.equal(state.sends, 1);
});
test("expired signed record and unavailable observations never submit", async () => {
  const { state, ports, run } = setup(); state.observation = { kind: "expired" };
  assert.equal((await run()).status, "unresolved"); assert.equal(state.sends, 0);
  ports.observe = async () => { throw new Error("unavailable"); };
  assert.equal((await run()).reason, "observation-unavailable"); assert.equal(state.sends, 0);
});
test("wrong chain expectation, corrupted journal and invalid actual instruction stop before effects", async () => {
  const { state, run } = setup();
  await assert.rejects(run({ ...expected, testOnly: false } as never)); assert.equal(state.signs, 0);
  state.inspect = { ...state.inspect, intent: { ...state.inspect.intent, instructions: [] } };
  await assert.rejects(run()); assert.equal(state.record, null); assert.equal(state.sends, 0);
  state.record = false as never;
  await assert.rejects(run(), /Invalid pool init journal/); assert.equal(state.signs, 1);
});
test("every ordered instruction account and privilege is exact; extra instructions are rejected", async () => {
  for (let index = 0; index < 7; index++) {
    for (const field of ["address", "isSigner", "isWritable"] as const) {
      const { state, run } = setup();
      const intent = structuredClone(state.inspect.intent);
      const account = intent.instructions[0]!.accounts[index]!;
      const changed = { ...account, [field]: field === "address" ? "1".repeat(31) + "9" : !account[field] };
      state.inspect = { ...state.inspect, intent: { ...intent, instructions: [{ ...intent.instructions[0]!,
        accounts: intent.instructions[0]!.accounts.map((a, i) => i === index ? changed : a) }] } };
      await assert.rejects(run()); assert.equal(state.sends, 0); assert.equal(state.record, null);
    }
  }
  const { state, run } = setup();
  state.inspect = { ...state.inspect, intent: { ...state.inspect.intent, instructions: [...state.inspect.intent.instructions, ...state.inspect.intent.instructions] } };
  await assert.rejects(run()); assert.equal(state.sends, 0);
});
