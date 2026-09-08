import { canonicalIntentJson, validateSepoliaIntent } from "../domain/evm-intent.ts";
import type { SepoliaIntentEnvelope, SepoliaIntentInput } from "../domain/evm-intent.ts";

export interface SignedTransaction { readonly bytes: string; readonly hash: string; }
export interface ObservedTransaction {
  readonly hash: string;
  readonly chainId: string;
  readonly from: string;
  readonly to: string | null;
  readonly data: string;
  readonly value: string;
  readonly nonce: string;
}
export interface ReceiptEvidence {
  readonly transactionHash: string;
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly status: 0 | 1;
}
export type Observation = { readonly kind: "unknown" | "not-found" } | {
  readonly kind: "observed";
  readonly transaction: ObservedTransaction;
  readonly receipt?: ReceiptEvidence;
  /** Observer verifies this exact canonical finalized block against the configured Sepolia chain. */
  readonly finalizedBlock?: { readonly hash: string; readonly number: string };
};
export interface EvmJournalRecord {
  readonly schema: "agtmai-evm-journal-v1";
  readonly intent: SepoliaIntentEnvelope;
  readonly signed: SignedTransaction;
  readonly phase: "signed" | "submitting" | "submitted" | "succeeded" | "reverted";
  readonly receipt?: ReceiptEvidence;
}
export interface EvmJournalPorts {
  /** Exclusive across processes for this journal, including signing and durable writes. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  read(): Promise<EvmJournalRecord | null>;
  /** Atomic durable write; resolve only after persistence. A thrown result may still have persisted. */
  write(record: EvmJournalRecord): Promise<void>;
  sign(intent: SepoliaIntentEnvelope): Promise<SignedTransaction>;
  /** Independently decode/recover sender and recompute hash from signed bytes, never trust signer metadata. */
  inspectSigned(bytes: string): Promise<ObservedTransaction>;
  observe(hash: string): Promise<Observation>;
  broadcast(bytes: string): Promise<string>;
}
export interface EvmJournalResult {
  readonly status: "unresolved" | "succeeded" | "reverted";
  readonly record: EvmJournalRecord;
  readonly reason: string;
}
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;
function equalHex(a: string, b: string): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}
function exactTransaction(tx: ObservedTransaction, record: EvmJournalRecord): boolean {
  const intent = record.intent;
  return equalHex(tx.hash, record.signed.hash) && tx.chainId === "11155111" &&
    equalHex(tx.from, intent.from) &&
    (intent.to === null ? tx.to === null : tx.to !== null && equalHex(tx.to, intent.to)) &&
    equalHex(tx.data, intent.data) && tx.value === intent.value && tx.nonce === intent.nonce;
}
function validReceipt(receipt: ReceiptEvidence, hash: string): boolean {
  return equalHex(receipt.transactionHash, hash) && hashPattern.test(receipt.blockHash) &&
    decimalPattern.test(receipt.blockNumber) && (receipt.status === 0 || receipt.status === 1);
}
function validateRecord(record: EvmJournalRecord, intent: SepoliaIntentEnvelope): void {
  if (record.schema !== "agtmai-evm-journal-v1" ||
    canonicalIntentJson(record.intent) !== canonicalIntentJson(intent)) {
    throw new Error("Conflicting journal intent");
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(record.signed.bytes) || !hashPattern.test(record.signed.hash) ||
    !["signed", "submitting", "submitted", "succeeded", "reverted"].includes(record.phase)) {
    throw new Error("Invalid journal record");
  }
  if (record.phase === "succeeded" || record.phase === "reverted") {
    if (!record.receipt || !validReceipt(record.receipt, record.signed.hash) ||
      record.receipt.status !== (record.phase === "succeeded" ? 1 : 0)) {
      throw new Error("Invalid terminal journal receipt");
    }
  }
}

function receiptMatchesBlock(receipt: ReceiptEvidence, block: { hash: string; number: string }, hash: string): boolean {
  return validReceipt(receipt, hash) && equalHex(receipt.blockHash, block.hash) && receipt.blockNumber === block.number;
}
function conflictsWithPrevious(previous: ReceiptEvidence | undefined, next: ReceiptEvidence): boolean {
  return previous !== undefined && (!equalHex(previous.blockHash, next.blockHash) ||
    previous.blockNumber !== next.blockNumber || previous.status !== next.status);
}

/** One exact transaction. No nonce replacement, automatic re-signing or uncertain-send retries. */
export async function runEvmJournal(
  input: SepoliaIntentInput, expected: SepoliaIntentInput, ports: EvmJournalPorts,
): Promise<EvmJournalResult> {
  const intent = validateSepoliaIntent(input, expected);
  return ports.exclusive(async () => {
    const loaded = await ports.read();
    let record: EvmJournalRecord;
    if (!loaded) {
      const signed = await ports.sign(intent);
      record = { schema: "agtmai-evm-journal-v1", intent, signed, phase: "signed" };
      validateRecord(record, intent);
      if (!exactTransaction(await ports.inspectSigned(signed.bytes), record)) {
        throw new Error("Signed transaction does not match intent/hash");
      }
      await ports.write(record);
    } else {
      record = loaded;
      validateRecord(record, intent);
      if (!exactTransaction(await ports.inspectSigned(record.signed.bytes), record)) {
        throw new Error("Stored signed transaction does not match intent/hash");
      }
    }
    const unresolved = (reason: string): EvmJournalResult => ({ status: "unresolved", record, reason });
    let observation: Observation;
    try { observation = await ports.observe(record.signed.hash); }
    catch { return unresolved("observation-unavailable"); }
    if (observation.kind === "unknown") { return unresolved("observation-unknown"); }
    if (observation.kind === "observed") {
      if (!exactTransaction(observation.transaction, record)) {
        return unresolved("observed-transaction-mismatch");
      }
      const { receipt, finalizedBlock } = observation;
      if (!receipt || !finalizedBlock) { return unresolved("awaiting-finalized-receipt"); }
      if (!receiptMatchesBlock(receipt, finalizedBlock, record.signed.hash)) {
        return unresolved("receipt-finalized-block-mismatch");
      }
      if (conflictsWithPrevious(record.receipt, receipt)) {
        return unresolved("previous-finalized-receipt-conflict");
      }
      const phase = receipt.status === 1 ? "succeeded" : "reverted";
      if (record.phase !== phase) {
        record = { ...record, phase, receipt };
        await ports.write(record);
      }
      return { status: phase, record, reason: "exact-finalized-receipt" };
    }
    // Only a durable signed record proves no earlier network attempt was started.
    // A submitting record with no visible transaction is ambiguous, even after expiry.
    if (record.phase !== "signed") { return unresolved("prior-submission-not-observed"); }
    record = { ...record, phase: "submitting" };
    await ports.write(record);
    let returnedHash: string;
    try { returnedHash = await ports.broadcast(record.signed.bytes); }
    catch { return unresolved("broadcast-outcome-unknown"); }
    if (!equalHex(returnedHash, record.signed.hash)) { return unresolved("broadcast-hash-mismatch"); }
    record = { ...record, phase: "submitted" };
    await ports.write(record);
    return unresolved("submitted-awaiting-observation");
  });
}
