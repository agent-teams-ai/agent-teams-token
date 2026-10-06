import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createForwardJournalFile, forwardJournalBinding, type ForwardJournalBinding, type BoundForwardJournalRecord } from "../src/adapters/evm-forward-journal.ts";
import { createJournalFile } from "../src/adapters/evm-journal-file.ts";
import { replacementFixture } from "../src/domain/replacement-fixture.ts";
import { validateSepoliaIntent } from "../src/domain/evm-intent.ts";
import { runEvmJournal, type EvmJournalRecord, type Observation, type ObservedTransaction } from "../src/application/evm-journal.ts";

// Disposable durable records and controlled observation ports; no public signed capture is claimed.
const fixture = replacementFixture("0x" + "11".repeat(20), "0x" + "22".repeat(20));
const router = "0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59";
function record(nonce = "5", to = fixture.token, value = "0"): EvmJournalRecord {
  const input = { chainId: "11155111", kind: "call" as const, from: fixture.administrator, nonce, to, value, data: "0x12345678" };
  return { schema: "agtmai-evm-journal-v1", intent: validateSepoliaIntent(input, input),
    signed: { bytes: "0x0201", hash: "0x" + "aa".repeat(32) }, phase: "submitting" };
}
function binding(directory: string): ForwardJournalBinding {
  return forwardJournalBinding(fixture, "BoiQxGHPgVaqxPn2TjqzmoHPd5toyfxxZ4wW2M7P3gK8", {
    approvalJournal: join(directory, "approval.json"), sendJournal: join(directory, "send.json"), approvalNonce: "5", sendNonce: "6" });
}
function transaction(saved: EvmJournalRecord): ObservedTransaction {
  return { hash: saved.signed.hash, chainId: saved.intent.chainId, from: saved.intent.from, to: saved.intent.to,
    data: saved.intent.data, value: saved.intent.value, nonce: saved.intent.nonce };
}

test("durable wrapper reopens the exact bound pair and preserves ordinary journal fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-pair-"));
  try {
    const expected = binding(directory), approval = record(), send = record("6", router, "5");
    for (const [step, saved, path] of [["approval", approval, expected.approvalJournal], ["send", send, expected.sendJournal]] as const) {
      const file = createForwardJournalFile(path, expected);
      await file.exclusive(() => file.write(saved));
      const reopened = createForwardJournalFile(path, expected);
      const actual = await reopened.exclusive(() => reopened.read());
      assert.deepEqual(actual, { ...saved, forwardBinding: expected, forwardStep: step });
      const bytes = await readFile(path, "utf8");
      assert.equal(bytes, JSON.stringify({ ...saved, forwardBinding: expected, forwardStep: step }) + "\n");
    }
    assert.ok(Object.isFrozen(expected));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("every binding field, step and pair path conflict refuses read and write without modifying bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-conflict-"));
  try {
    const expected = binding(directory), file = createForwardJournalFile(expected.approvalJournal, expected);
    await file.exclusive(() => file.write(record()));
    const raw = createJournalFile<BoundForwardJournalRecord>(expected.approvalJournal);
    const saved = await raw.exclusive(() => raw.read());
    assert.ok(saved);
    for (const key of Object.keys(expected)) {
      // Runtime mutation of untrusted persisted metadata; no cast supplies a false contract.
      const mutant = { ...expected };
      Object.defineProperty(mutant, key, { value: "conflicting-value" });
      await raw.exclusive(() => raw.write({ ...saved, forwardBinding: mutant }));
      const bytes = await readFile(expected.approvalJournal, "utf8");
      await assert.rejects(file.exclusive(() => file.read()), /binding/);
      await assert.rejects(file.exclusive(() => file.write(record())), /binding/);
      assert.equal(await readFile(expected.approvalJournal, "utf8"), bytes);
    }
    for (const mutant of [{ ...saved, forwardStep: "send" as const }, { ...saved, forwardBinding: { ...expected, extra: true } }]) {
      await raw.exclusive(() => raw.write(mutant));
      const before = await readFile(expected.approvalJournal, "utf8");
      await assert.rejects(file.exclusive(() => file.read()), /binding/);
      await assert.rejects(file.exclusive(() => file.write(record())), /binding/);
      assert.equal(await readFile(expected.approvalJournal, "utf8"), before);
    }
    assert.throws(() => createForwardJournalFile(join(directory, "other.json"), expected), /outside selected pair/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an unbound replacement record stays unresolved and byte-identical, including direct writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-unbound-"));
  try {
    const expected = binding(directory), raw = createJournalFile(expected.approvalJournal), saved = record();
    await raw.exclusive(() => raw.write(saved));
    const bytes = await readFile(expected.approvalJournal, "utf8"), file = createForwardJournalFile(expected.approvalJournal, expected);
    await assert.rejects(file.exclusive(() => file.read()), /Unresolved.*missing binding/);
    await assert.rejects(file.exclusive(() => file.write(saved)), /Unresolved.*missing binding/);
    assert.equal(await readFile(expected.approvalJournal, "utf8"), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("historical journal bytes stay ordinary; forward metadata cannot target setup nonce0..4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-setup-"));
  try {
    const pair = binding(directory);
    for (const nonce of ["0", "1", "2", "3", "4"]) {
      const saved = record(nonce), path = join(directory, "setup-" + nonce + ".json"), raw = createJournalFile(path);
      await raw.exclusive(() => raw.write(saved));
      const bytes = await readFile(path, "utf8");
      assert.throws(() => forwardJournalBinding(fixture, pair.selectedRecipient,
        { ...pair, approvalNonce: nonce, sendNonce: (BigInt(nonce) + 1n).toString() }), /setup nonce0\.\.4/);
      assert.equal(await readFile(path, "utf8"), bytes);
      assert.equal(bytes, JSON.stringify(saved) + "\n");
    }
    for (const changed of [{ ...pair, sendJournal: join(directory, "unused", "..", "approval.json") },
      { ...pair, approvalNonce: "05" }, { ...pair, sendNonce: "7" }, { ...pair, approvalJournal: "relative" }]) {
      assert.throws(() => forwardJournalBinding(fixture, pair.selectedRecipient, changed));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the real EVM journal core reconciles persisted uncertain phases without signing or resending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-recovery-"));
  try {
    const expected = binding(directory);
    const evidence: readonly Observation[] = [{ kind: "unknown" }, { kind: "not-found" },
      { kind: "observed", transaction: transaction(record()) }];
    for (const phase of ["submitting", "submitted"] as const) {
      const file = createForwardJournalFile(expected.approvalJournal, expected);
      await file.exclusive(() => file.write({ ...record(), phase }));
      const before = await readFile(expected.approvalJournal, "utf8");
      for (const observation of [...evidence, "throw"] as const) {
        const saved = record();
        const intent = { chainId: saved.intent.chainId, kind: "call" as const, from: saved.intent.from,
          nonce: saved.intent.nonce, value: saved.intent.value, data: saved.intent.data, to: fixture.token };
        const result = await runEvmJournal(intent, intent, {
          ...file, inspectSigned: async () => transaction(record()),
          observe: async () => { if (observation === "throw") { throw new Error("captured observer unavailable"); } return observation; },
          sign: async () => assert.fail("Recovery cannot sign"), broadcast: async () => assert.fail("Recovery cannot resend") });
        assert.equal(result.status, "unresolved");
        assert.equal(result.record.phase, phase);
        assert.equal(await readFile(expected.approvalJournal, "utf8"), before);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("terminal reconciliation preserves binding; a forged signature projection cannot rely on metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forward-terminal-"));
  try {
    const expected = binding(directory), saved = record(), file = createForwardJournalFile(expected.approvalJournal, expected);
    await file.exclusive(() => file.write(saved));
    const intent = { chainId: saved.intent.chainId, kind: "call" as const, from: saved.intent.from,
      to: fixture.token, data: saved.intent.data, value: saved.intent.value, nonce: saved.intent.nonce };
    const forbidden = { sign: async () => assert.fail("Cannot sign a saved operation"), broadcast: async () => assert.fail("Cannot resend a saved operation") };
    const before = await readFile(expected.approvalJournal, "utf8");
    await assert.rejects(runEvmJournal(intent, intent, { ...file, ...forbidden,
      inspectSigned: async () => ({ ...transaction(saved), nonce: "99" }), observe: async () => assert.fail("Cannot observe invalid bytes") }), /Stored signed transaction/);
    assert.equal(await readFile(expected.approvalJournal, "utf8"), before);
    const receipt = { transactionHash: saved.signed.hash, blockHash: "0x" + "bb".repeat(32), blockNumber: "100", status: 1 as const };
    const result = await runEvmJournal(intent, intent, { ...file, ...forbidden, inspectSigned: async () => transaction(saved),
      observe: async () => ({ kind: "observed", transaction: transaction(saved), receipt,
        finalizedBlock: { hash: receipt.blockHash, number: receipt.blockNumber } }) });
    assert.equal(result.status, "succeeded");
    const reopened = await file.exclusive(() => file.read());
    assert.deepEqual(reopened, { ...saved, phase: "succeeded", receipt, forwardBinding: expected, forwardStep: "approval" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function contracts(pair: ForwardJournalBinding): void {
  // @ts-expect-error selectors/nonces/amounts never use JavaScript number
  forwardJournalBinding(fixture, pair.selectedRecipient, { ...pair, sendNonce: 6 });
  // @ts-expect-error only the literal replacement A or B can be captured
  forwardJournalBinding(fixture, "recipient nickname", pair);
  // @ts-expect-error exact binding amount is a decimal string
  const invalid: ForwardJournalBinding = { ...pair, amount: 1000000000 };
  void invalid;
}
void contracts;
