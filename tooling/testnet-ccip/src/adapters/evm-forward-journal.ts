import { isAbsolute, resolve } from "node:path";
import { createJournalFile } from "./evm-journal-file.ts";
import { forwardRecipient, forwardRoute, FORWARD_RECIPIENT_B } from "../domain/evm-forward.mjs";
import { REPLACEMENT, validateReplacementFixture, type ReplacementFixture } from "../domain/replacement-fixture.ts";
import { canonicalIntentJson } from "../domain/evm-intent.ts";
import type { EvmJournalPorts, EvmJournalRecord } from "../application/evm-journal.ts";

export type ForwardStep = "approval" | "send";
export interface ForwardJournalBinding {
  readonly schema: "agtmai-forward-binding-v1";
  readonly fixtureIdentity: string;
  readonly direction: "ethereum-to-solana";
  readonly selectedRecipient: typeof REPLACEMENT.recipient | typeof FORWARD_RECIPIENT_B;
  readonly sourceToken: string;
  readonly destinationMint: string;
  readonly pool: string;
  readonly router: string;
  readonly amount: string;
  readonly approvalJournal: string;
  readonly sendJournal: string;
  readonly approvalNonce: string;
  readonly sendNonce: string;
}
export interface BoundForwardJournalRecord extends EvmJournalRecord {
  readonly forwardBinding: ForwardJournalBinding;
  readonly forwardStep: ForwardStep;
}
type Store = Pick<EvmJournalPorts, "read" | "write" | "exclusive">;
type Pair = Pick<ForwardJournalBinding, "approvalJournal" | "sendJournal" | "approvalNonce" | "sendNonce">;

/** Capture one immutable replacement pair. Recipient policy stays with forwardRecipient. */
export function forwardJournalBinding(
  fixture: ReplacementFixture, selectedRecipient: ForwardJournalBinding["selectedRecipient"], pair: Pair,
): Readonly<ForwardJournalBinding> {
  const f = validateReplacementFixture(fixture), route = forwardRoute(f);
  if (forwardRecipient(selectedRecipient, f) !== selectedRecipient) { throw new Error("Forward binding recipient conflict"); }
  for (const path of [pair.approvalJournal, pair.sendJournal]) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) { throw new Error("Absolute forward journal paths required"); }
  }
  const approvalJournal = resolve(pair.approvalJournal), sendJournal = resolve(pair.sendJournal);
  if (approvalJournal === sendJournal) { throw new Error("Forward journal paths alias"); }
  if (![pair.approvalNonce, pair.sendNonce].every(n => typeof n === "string" && /^(0|[1-9][0-9]*)$/.test(n)) ||
    BigInt(pair.approvalNonce) < 5n || BigInt(pair.sendNonce) !== BigInt(pair.approvalNonce) + 1n ||
    BigInt(pair.sendNonce) > (1n << 64n) - 2n) {
    throw new Error("Forward pair requires new consecutive nonces; setup nonce0..4 are immutable");
  }
  return Object.freeze({ schema: "agtmai-forward-binding-v1", fixtureIdentity: f.identity,
    direction: "ethereum-to-solana", selectedRecipient, sourceToken: route.token, destinationMint: f.mint,
    pool: route.pool, router: route.router, amount: route.amount.toString(),
    approvalJournal, sendJournal, approvalNonce: pair.approvalNonce, sendNonce: pair.sendNonce });
}

function assertPairMetadata(
  record: EvmJournalRecord, binding: ForwardJournalBinding, step: ForwardStep,
): void {
  if (!Object.hasOwn(record, "forwardBinding")) {
    throw new Error("Unresolved replacement forward journal: missing binding; public inspection required");
  }
  const stored = "forwardBinding" in record ? record.forwardBinding : undefined;
  if (!stored || typeof stored !== "object" || Array.isArray(stored) ||
    Reflect.ownKeys(stored).length !== Object.keys(binding).length ||
    Object.entries(binding).some(([key, value]) => !Object.hasOwn(stored, key) || Reflect.get(stored, key) !== value) ||
    !("forwardStep" in record) || record.forwardStep !== step) {
    throw new Error("Conflicting or malformed forward journal binding/step");
  }
}
function assertRecordIntent(record: EvmJournalRecord, binding: ForwardJournalBinding, step: ForwardStep): void {
  const intent = record.intent;
  if (record.schema !== "agtmai-evm-journal-v1" || !intent || intent.kind !== "call" || intent.chainId !== "11155111" ||
    intent.nonce !== (step === "approval" ? binding.approvalNonce : binding.sendNonce) ||
    intent.to !== (step === "approval" ? binding.sourceToken : binding.router) ||
    (step === "approval" && intent.value !== "0") ||
    !record.signed || !/^0x(?:[0-9a-fA-F]{2})+$/.test(record.signed.bytes) ||
    !/^0x[0-9a-fA-F]{64}$/.test(record.signed.hash) ||
    !["signed", "submitting", "submitted", "succeeded", "reverted"].includes(record.phase)) {
    throw new Error("Invalid bound forward journal record/intent");
  }
  canonicalIntentJson(intent);
}
function assertTerminalReceipt(record: EvmJournalRecord): void {
  if ((record.phase === "succeeded" || record.phase === "reverted") &&
    (!record.receipt || record.receipt.transactionHash.toLowerCase() !== record.signed.hash.toLowerCase() ||
    !/^0x[0-9a-fA-F]{64}$/.test(record.receipt.blockHash) || !/^(0|[1-9][0-9]*)$/.test(record.receipt.blockNumber) ||
    record.receipt.status !== (record.phase === "succeeded" ? 1 : 0))) {
    throw new Error("Invalid bound forward terminal receipt");
  }
}

/** Shared by both composition pre-reads and the executor's store. Metadata is never signature proof. */
export function assertForwardJournalRecord(
  record: EvmJournalRecord, binding: ForwardJournalBinding, step: ForwardStep,
): asserts record is BoundForwardJournalRecord {
  assertPairMetadata(record, binding, step);
  assertRecordIntent(record, binding, step);
  assertTerminalReceipt(record);
}

/** Only forward supplies this store. The common engine and durable file writes stay unchanged. */
export function createForwardJournalFile(
  path: string, binding: ForwardJournalBinding, journal: (path: string) => Store = createJournalFile,
): Store {
  // Detach the captured scalar fields from callers before any asynchronous IO.
  const captured = Object.freeze({ ...binding });
  const canonical = resolve(path);
  const step = canonical === captured.approvalJournal ? "approval" : canonical === captured.sendJournal ? "send" : undefined;
  if (!isAbsolute(path) || !step) { throw new Error("Forward journal path outside selected pair"); }
  const store = journal(canonical);
  return {
    exclusive: work => store.exclusive(work),
    async read() {
      const record = await store.read();
      if (record) { assertForwardJournalRecord(record, captured, step); }
      return record;
    },
    async write(record) {
      // Never upgrade an unbound old record, even through a direct write caller.
      const previous = await store.read();
      if (previous) { assertForwardJournalRecord(previous, captured, step); }
      if (Object.hasOwn(record, "forwardBinding") || Object.hasOwn(record, "forwardStep")) {
        assertForwardJournalRecord(record, captured, step);
      }
      const bound: BoundForwardJournalRecord = { ...record, forwardBinding: captured, forwardStep: step };
      assertForwardJournalRecord(bound, captured, step);
      await store.write(bound);
    },
  };
}
