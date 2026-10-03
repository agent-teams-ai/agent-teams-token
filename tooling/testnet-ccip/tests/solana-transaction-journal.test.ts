import assert from "node:assert/strict";
import test from "node:test";
import { runSolanaTransactionJournal } from "../src/application/solana-transaction-journal.ts";
import type { SolanaObservation, SolanaTransactionPorts, SolanaTransactionRecord } from "../src/application/solana-transaction-journal.ts";

const expected = { testOnly: true as const, cluster: "solana-devnet" as const };
const signed = { bytesBase64: "c2lnbmVk", signature: "2".repeat(88), blockhash: "3".repeat(44), lastValidBlockHeight: "150" };
const messageBase64 = "bWVzc2FnZQ==", intent = { payer: "1".repeat(32) };
const contract = {
  schema: "test-solana-journal-v1", label: "test", successReason: "finalized",
  verify: () => intent, canonical: () => JSON.stringify(intent),
  stateMatches: (state: boolean | null) => state === true,
};
function fixture(phase: SolanaTransactionRecord<typeof intent>["phase"] = "signed") {
  const original: SolanaTransactionRecord<typeof intent> = { schema: contract.schema, intent, signed, messageBase64, phase };
  let record = original, sends = 0;
  const events: string[] = [];
  const ports: SolanaTransactionPorts<typeof expected, typeof intent, boolean> = {
    exclusive: async work => work(), read: async () => record,
    write: async next => { events.push(next.phase); record = next; },
    sign: async () => { assert.fail("stored transaction cannot be signed again"); },
    inspectSigned: async () => ({ ...signed, messageBase64, intent: { feePayer: intent.payer, instructions: [] } }),
    observe: async () => { events.push("observe"); return { kind: "not-found" }; },
    beforeBroadcast: async () => { events.push("guard"); throw new Error("prerequisite unavailable"); },
    broadcast: async bytes => {
      assert.equal(record.phase, "submitting"); assert.equal(bytes, signed.bytesBase64);
      events.push("broadcast"); sends++; return signed.signature;
    },
  };
  const finalized: SolanaObservation<boolean> = { kind: "finalized", signature: signed.signature,
    messageBase64, slot: "200", err: null, state: true };
  return { ports, events, original, finalized, record: () => record, sends: () => sends,
    run: () => runSolanaTransactionJournal(expected, ports, contract) };
}

test("pre-send rejection preserves the signed record and permits one send of the same bytes after repair", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.reason, "before-broadcast-precondition-failed");
  assert.equal(result.status, "unresolved"); assert.equal(result.record, f.original);
  assert.equal(f.record(), f.original); assert.equal(f.sends(), 0);
  assert.deepEqual(f.events, ["observe", "guard"]);
  f.events.length = 0;
  f.ports.beforeBroadcast = async () => { f.events.push("guard"); };
  assert.equal((await f.run()).reason, "submitted-awaiting-finality");
  assert.deepEqual(f.events, ["observe", "guard", "submitting", "broadcast", "submitted"]);
  f.events.length = 0;
  await f.run(); assert.deepEqual(f.events, ["observe"]);
  f.ports.observe = async () => f.finalized;
  assert.equal((await f.run()).status, "succeeded");
  assert.equal((await f.run()).status, "succeeded");
  assert.equal(f.sends(), 1);
});

test("guards never run for unavailable/expired observations or uncertain and terminal records", async () => {
  for (const phase of ["signed", "submitting", "submitted", "succeeded", "failed"] as const) {
    const f = fixture(phase);
    for (const kind of ["unknown", "expired", "not-found"] as const) {
      if (phase === "signed" && kind === "not-found") { continue; }
      f.ports.observe = async () => ({ kind });
      assert.equal((await f.run()).reason, "submission-unresolved-or-expired");
      assert.equal(f.record(), f.original);
    }
    f.ports.observe = async () => { throw new Error("observation unavailable"); };
    assert.equal((await f.run()).reason, "observation-unavailable");
    f.ports.observe = async () => phase === "failed" ? { ...f.finalized, err: { failure: true }, state: null } : f.finalized;
    assert.equal((await f.run()).status, phase === "failed" ? "failed" : "succeeded");
    assert.equal(f.sends(), 0); assert.ok(!f.events.includes("guard"));
  }
});

test("a crash after durable submitting or a failed broadcast still prevents every retry", async () => {
  for (const failure of ["submitting-write", "broadcast"] as const) {
    const f = fixture();
    f.ports.beforeBroadcast = async () => { f.events.push("guard"); };
    if (failure === "submitting-write") {
      const write = f.ports.write;
      f.ports.write = async record => { await write(record); throw new Error("crash after persistence"); };
      await assert.rejects(f.run(), /crash after persistence/);
    } else {
      f.ports.broadcast = async () => { f.events.push("broadcast"); throw new Error("response lost"); };
      assert.equal((await f.run()).reason, "broadcast-outcome-unknown");
    }
    assert.equal(f.record().phase, "submitting");
    f.events.length = 0;
    assert.equal((await f.run()).reason, "submission-unresolved-or-expired");
    assert.deepEqual(f.events, ["observe"]);
  }
});
