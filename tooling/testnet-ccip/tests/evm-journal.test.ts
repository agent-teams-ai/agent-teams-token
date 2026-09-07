import assert from "node:assert/strict";
import test from "node:test";
import { runEvmJournal } from "../src/application/evm-journal.ts";
import type { EvmJournalPorts, EvmJournalRecord, Observation, ObservedTransaction } from "../src/application/evm-journal.ts";
import type { SepoliaIntentInput } from "../src/domain/evm-intent.ts";

const intent: SepoliaIntentInput = { chainId: "11155111", kind: "call",
  from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20),
  nonce: "4", value: "0", data: "0x12345678" };
const hash = "0x" + "11".repeat(32);
const blockHash = "0x" + "22".repeat(32);
const tx: ObservedTransaction = { hash, chainId: "11155111", from: intent.from,
  to: intent.to!, nonce: "4", value: "0", data: intent.data };
function final(status: 0 | 1 = 1): Observation {
  return { kind: "observed", transaction: tx,
    receipt: { transactionHash: hash, blockHash, blockNumber: "99", status },
    finalizedBlock: { hash: blockHash, number: "99" } };
}
function setup() {
  const state = { record: null as EvmJournalRecord | null, observation: { kind: "not-found" } as Observation,
    signs: 0, sends: 0, trace: [] as string[], failWrite: "", sendThrows: false, inspect: tx };
  const ports: EvmJournalPorts = {
    exclusive: async work => work(), read: async () => state.record,
    write: async record => {
      state.trace.push(record.phase);
      if (state.failWrite === record.phase) { throw new Error("crash"); }
      state.record = structuredClone(record);
    },
    sign: async () => { state.signs++; return { bytes: "0xaabb", hash }; },
    inspectSigned: async () => state.inspect,
    observe: async () => { state.trace.push("observe"); return state.observation; },
    broadcast: async bytes => {
      assert.equal(bytes, "0xaabb");
      assert.equal(state.record?.phase, "submitting");
      state.trace.push("send"); state.sends++;
      if (state.sendThrows) { throw new Error("timeout after acceptance"); }
      return hash;
    },
  };
  const run = (input = intent) => runEvmJournal(input, input, ports);
  return { state, ports, run };
}
test("signed bytes and submitting marker persist before first broadcast", async () => {
  const { state, run } = setup();
  assert.equal((await run()).status, "unresolved");
  assert.deepEqual(state.trace, ["signed", "observe", "submitting", "send", "submitted"]);
  assert.equal(state.record?.signed.hash, hash);
  await run();
  assert.equal(state.signs, 1); assert.equal(state.sends, 1);
});
test("failed signed persistence cannot cause any network effect", async () => {
  const { state, run } = setup(); state.failWrite = "signed";
  await assert.rejects(run(), /crash/);
  assert.equal(state.sends, 0); assert.equal(state.record, null);
});
test("restart from signed observes before using the same persisted signature", async () => {
  const { state, run } = setup(); state.failWrite = "submitting";
  await assert.rejects(run());
  assert.equal(state.record?.phase, "signed"); assert.equal(state.sends, 0);
  state.failWrite = ""; state.trace = [];
  await run();
  assert.equal(state.signs, 1); assert.deepEqual(state.trace, ["observe", "submitting", "send", "submitted"]);
});
test("crash after submitting marker but before network cannot trigger automatic resend", async () => {
  const { state, ports, run } = setup();
  const write = ports.write;
  ports.write = async record => { await write(record); if (record.phase === "submitting") { throw new Error("crash after durable marker"); } };
  await assert.rejects(run());
  ports.write = write;
  assert.equal((await run()).reason, "prior-submission-not-observed");
  assert.equal(state.sends, 0); assert.equal(state.signs, 1);
});
test("timeout after send and failed submitted write both reconcile without duplicate sends", async () => {
  for (const failure of ["send", "submitted-write"]) {
    const { state, run } = setup();
    state.sendThrows = failure === "send"; state.failWrite = failure === "submitted-write" ? "submitted" : "";
    if (failure === "send") { assert.equal((await run()).reason, "broadcast-outcome-unknown"); }
    else { await assert.rejects(run()); }
    state.failWrite = ""; state.observation = final();
    assert.equal((await run()).status, "succeeded");
    assert.equal((await run()).status, "succeeded");
    assert.equal(state.signs, 1); assert.equal(state.sends, 1);
  }
});
test("unknown observation never submits; pending/reverted receipts require exact finality", async () => {
  const { state, run } = setup(); state.observation = { kind: "unknown" };
  assert.equal((await run()).status, "unresolved"); assert.equal(state.sends, 0);
  state.observation = { kind: "observed", transaction: tx };
  assert.equal((await run()).status, "unresolved");
  state.observation = final(0);
  assert.equal((await run()).status, "reverted"); assert.equal(state.sends, 0);
});
test("conflicting journal intent or signed bytes cannot reach network", async () => {
  const { state, run } = setup(); await run();
  await assert.rejects(run({ ...intent, nonce: "5" }), /Conflicting journal intent/);
  state.inspect = { ...tx, data: "0x87654321" };
  await assert.rejects(run(), /Stored signed transaction/);
  assert.equal(state.sends, 1);
});
test("each observed identity and finality mismatch stays unresolved", async () => {
  for (const change of [{ hash: blockHash }, { chainId: "1" }, { from: intent.to! },
    { to: null }, { data: "0x87654321" }, { value: "1" }, { nonce: "5" }]) {
    const { state, run } = setup(); const evidence = final();
    assert.equal(evidence.kind, "observed");
    state.observation = { ...evidence, kind: "observed", transaction: { ...tx, ...change } };
    assert.equal((await run()).reason, "observed-transaction-mismatch"); assert.equal(state.sends, 0);
  }
  const { state, run } = setup();
  state.observation = { kind: "observed", transaction: tx,
    receipt: { transactionHash: hash, blockHash, blockNumber: "99", status: 1 },
    finalizedBlock: { hash, number: "99" } };
  assert.equal((await run()).reason, "receipt-finalized-block-mismatch");
});
test("terminal replay re-observes canonical evidence rather than trusting cached success", async () => {
  const { state, run } = setup(); state.observation = final();
  assert.equal((await run()).status, "succeeded");
  state.observation = { kind: "unknown" };
  assert.equal((await run()).status, "unresolved");
});
test("wrong signed identity fails before persistence and wrong broadcast hash stays uncertain", async () => {
  const forged = setup(); forged.state.inspect = { ...tx, hash: blockHash };
  await assert.rejects(forged.run(), /Signed transaction/);
  assert.equal(forged.state.record, null); assert.equal(forged.state.sends, 0);
  const { state, ports, run } = setup();
  ports.broadcast = async () => { state.sends++; return blockHash; };
  assert.equal((await run()).reason, "broadcast-hash-mismatch");
  assert.equal((await run()).reason, "prior-submission-not-observed");
  assert.equal(state.sends, 1);
});
