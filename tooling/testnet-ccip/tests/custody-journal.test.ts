import assert from "node:assert/strict";
import test from "node:test";
import { runCustodyJournal, type CustodyJournalPorts, type CustodyJournalRecord, type Observation } from "../src/application/evm-journal.ts";
import { canonicalCustodyIntent, validateCustodyIntent, type CustodyIntent } from "../src/domain/custody-intent.ts";

const from = "0x1111111111111111111111111111111111111111", to = "0x2222222222222222222222222222222222222222";
const hash = `0x${"a".repeat(64)}` as const, blockHash = `0x${"b".repeat(64)}` as const;
const intent: CustodyIntent = { schema: "agtmai-custody-intent-v2", configurationSha256: hash, prerequisiteSha256: blockHash,
  operationId: "fund-team", operation: "fund", environment: "local-test", chainId: "31337", from, to, kind: "call", nonce: "0", value: "0",
  data: "0xb60d4288", callerRole: "reserve", gasLimit: "200000", maxFeePerGasWei: "2000000000", maxPriorityFeePerGasWei: "0", deployment: null, safe: null };
function setup() {
  const tx = { hash, chainId: intent.chainId, from, to, data: intent.data, value: "0", nonce: "0" };
  const state = { record: null as CustodyJournalRecord | null, signs: 0, sends: 0,
    observation: { kind: "not-found" } as Observation };
  const ports: CustodyJournalPorts = { exclusive: async work => work(), read: async () => state.record,
    write: async record => { state.record = structuredClone(record); },
    sign: async () => { state.signs++; return { hash, bytes: "0x1234" }; }, inspectSigned: async () => tx,
    observe: async () => state.observation, broadcast: async () => { state.sends++; throw new Error("accepted then interrupted"); } };
  return { state, ports, tx };
}
test("V2 persists signed identity before uncertainty and reconciles the same local transaction", async () => {
  const { state, ports, tx } = setup();
  assert.equal((await runCustodyJournal(intent, intent, ports)).reason, "broadcast-outcome-unknown");
  assert.equal(state.record?.schema, "agtmai-custody-journal-v2");
  assert.equal(state.record?.phase, "submitting");
  assert.equal((await runCustodyJournal(intent, intent, ports)).reason, "prior-submission-not-observed");
  state.observation = { kind: "observed", transaction: tx, receipt: { transactionHash: hash, blockHash, blockNumber: "7", status: 1 }, finalizedBlock: { hash: blockHash, number: "7" } };
  assert.equal((await runCustodyJournal(intent, intent, ports)).status, "succeeded");
  assert.equal(state.signs, 1); assert.equal(state.sends, 1);
  state.observation = { kind: "unknown" };
  assert.equal((await runCustodyJournal(intent, intent, ports)).status, "unresolved");
});
test("V2 rejects changed config, prerequisites, fees, chain and caller before signer access", async () => {
  for (const patch of [{ chainId: "1" }, { environment: "mainnet-dry-run" }, { configurationSha256: blockHash },
    { prerequisiteSha256: hash }, { gasLimit: "200001" }, { maxFeePerGasWei: "2000000001" }, { callerRole: "beneficiary" }, { nonce: "1" }, { operationId: "fund-other" }]) {
    const { state, ports } = setup();
    await assert.rejects(runCustodyJournal({ ...intent, ...patch } as CustodyIntent, intent, ports), /CUSTODY_INTENT/);
    assert.equal(state.signs, 0); assert.equal(state.sends, 0);
  }
});
test("V1 and V2 cannot be reinterpreted across record schemas; finalized conflicts stay unresolved", async () => {
  const { state, ports, tx } = setup(); await runCustodyJournal(intent, intent, ports);
  const saved = state.record!;
  state.record = { ...saved, schema: "agtmai-evm-journal-v1" } as unknown as CustodyJournalRecord;
  await assert.rejects(runCustodyJournal(intent, intent, ports), /Conflicting journal/);
  state.record = { ...saved, phase: "reverted", receipt: { transactionHash: hash, blockHash, blockNumber: "7", status: 0 } };
  state.observation = { kind: "observed", transaction: tx, receipt: { transactionHash: hash, blockHash: hash, blockNumber: "7", status: 1 }, finalizedBlock: { hash, number: "7" } };
  assert.equal((await runCustodyJournal(intent, intent, ports)).reason, "previous-finalized-receipt-conflict");
  assert.equal(state.sends, 1);
});
test("vault constructor binds four immutable addresses instead of a token administrator word", () => {
  const words = [from, to, from, to].map(a => a.slice(2).padStart(64, "0")).join("") + "0".repeat(6 * 64);
  const deployment = { contract: "GrantVault" as const, artifactSha256: hash, creationBytecode: "0x6000" as const,
    constructorBytes: `0x${words}` as const, token: from, beneficiary: to, reserve: from, controller: to } as const;
  const creation: CustodyIntent = { ...intent, operation: "deploy-grant", kind: "deploy", callerRole: "deployer", to: null,
    deployment, data: `0x6000${words}` };
  assert.equal(validateCustodyIntent(creation, creation).deployment?.contract, "GrantVault");
  for (const patch of [{ controller: from }, { reserve: to }, { token: to }, { beneficiary: from }] as const) {
    assert.throws(() => canonicalCustodyIntent({ ...creation, deployment: { ...deployment, ...patch } }), /CUSTODY_INTENT/);
  }
  assert.throws(() => canonicalCustodyIntent({ ...creation, deployment: { ...deployment, administratorBinding: "constructor-word-2" } } as CustodyIntent), /CUSTODY_INTENT/);
});

test("reconcile never marks a signed record as submitted or calls broadcast", async () => {
  const { state, ports } = setup();
  const persistedWrite = ports.write;
  ports.write = async record => { await persistedWrite(record); if (record.phase === "signed") { throw new Error("interrupted before first observation"); } };
  await assert.rejects(runCustodyJournal(intent, intent, ports));
  ports.write = persistedWrite;
  assert.equal((await runCustodyJournal(intent, intent, ports, "observe")).reason, "signed-not-submitted");
  assert.equal(state.record?.phase, "signed"); assert.equal(state.sends, 0); assert.equal(state.signs, 1);
});
