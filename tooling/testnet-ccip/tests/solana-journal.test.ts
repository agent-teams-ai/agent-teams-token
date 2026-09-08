import assert from "node:assert/strict";
import test from "node:test";
import { runSolanaMintJournal } from "../src/application/solana-journal.ts";
import type { SolanaMintJournalRecord, SolanaMintJournalPorts, MintObservation, InspectedMintTransaction } from "../src/application/solana-journal.ts";
import { SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM } from "../src/domain/solana-mint.ts";
import type { SolanaMintExpectation } from "../src/domain/solana-mint.ts";
const payer = "1".repeat(31) + "2";
const mint = "1".repeat(31) + "3";
const signature = "2".repeat(88);
const blockhash = "3".repeat(44);
const expected: SolanaMintExpectation = { testOnly: true, cluster: "solana-devnet", payer, mint, rentLamports: "1461600" };
function decoded(): InspectedMintTransaction {
  const create = Buffer.alloc(52); create.writeBigUInt64LE(1461600n, 4); create.writeBigUInt64LE(82n, 12);
  Buffer.from("06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9", "hex").copy(create, 20);
  const init = Buffer.alloc(35); init[0] = 20; init[1] = 9; init[33] = 1;
  const payerMeta = { address: payer, isSigner: true, isWritable: true };
  const mintMeta = { address: mint, isSigner: true, isWritable: true };
  return { signature, blockhash, messageBase64: "bWVzc2FnZQ==", intent: { feePayer: payer, instructions: [
    { programId: SYSTEM_PROGRAM, dataBase64: create.toString("base64"), accounts: [payerMeta, mintMeta] },
    { programId: SPL_TOKEN_PROGRAM, dataBase64: init.toString("base64"), accounts: [mintMeta] },
  ] } };
}
const finalized = (): MintObservation => ({ kind: "finalized", signature, messageBase64: "bWVzc2FnZQ==", slot: "100", err: null,
  mintState: { address: mint, tokenProgram: SPL_TOKEN_PROGRAM, decimals: 9, supply: "0", mintAuthority: payer, freezeAuthority: null } });
function setup() {
  const state = { record: null as SolanaMintJournalRecord | null, signs: 0, sends: 0, failWrite: "", writeThenCrash: false,
    failSend: false, inspect: decoded(), observation: { kind: "not-found" } as MintObservation, trace: [] as string[] };
  const ports: SolanaMintJournalPorts = {
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
  return { state, ports, run: (expectation = expected) => runSolanaMintJournal(expectation, ports) };
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
  state.observation = { ...finalized(), kind: "finalized", signature, messageBase64: "bWVzc2FnZQ==", slot: "100", err: { InstructionError: [0, "Custom"] }, mintState: null };
  assert.equal((await run()).status, "failed"); assert.equal(state.sends, 0);
  state.observation = finalized(); assert.equal((await run()).reason, "terminal-evidence-conflict");
});
test("wrong raw message/signature and incorrect mint state never succeed", async () => {
  const base = finalized(); if (base.kind !== "finalized") { assert.fail(); }
  for (const change of [{ signature: "4".repeat(88) }, { messageBase64: "b3RoZXI=" }, { slot: "-1" },
    { mintState: null }, { mintState: { ...base.mintState!, supply: "1" } },
    { mintState: { ...base.mintState!, freezeAuthority: payer } },
    { mintState: { ...base.mintState!, mintAuthority: mint } }]) {
    const { state, run } = setup(); state.observation = { ...base, ...change };
    assert.equal((await run()).status, "unresolved"); assert.equal(state.sends, 0);
  }
});
test("stored intent/blockhash/message conflicts reject without signing or network effects", async () => {
  const { state, run } = setup(); await run();
  await assert.rejects(run({ ...expected, rentLamports: "1461601" }));
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
  await assert.rejects(run(), /Invalid mint journal/); assert.equal(state.signs, 1);
});
