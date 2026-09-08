import type { SolanaMintIntent } from "../domain/solana-mint.ts";
import { verifySolanaPoolInitIntent } from "../domain/solana-pool-init.ts";
import type { SolanaPoolInitEnvelope, SolanaPoolInitExpectation } from "../domain/solana-pool-init.ts";

export interface SignedPoolInitTransaction {
  readonly bytesBase64: string; readonly signature: string; readonly blockhash: string;
  /** From the same authenticated getLatestBlockhash response; not encoded in transaction bytes. */
  readonly lastValidBlockHeight: string;
}
export interface InspectedPoolInitTransaction {
  readonly signature: string; readonly blockhash: string; readonly messageBase64: string;
  readonly intent: SolanaMintIntent;
}
export interface PoolStateEvidence {
  readonly address: string; readonly mint: string; readonly owner: string; readonly verified: true;
}
export type PoolInitObservation = { readonly kind: "unknown" | "not-found" | "expired" } | {
  readonly kind: "finalized"; readonly signature: string; readonly messageBase64: string;
  readonly slot: string; readonly err: null | Record<string, unknown>;
  readonly poolState: PoolStateEvidence | null;
};
export interface SolanaPoolInitJournalRecord {
  readonly schema: "agtmai-solana-pool-init-journal-v1"; readonly intent: SolanaPoolInitEnvelope;
  readonly signed: SignedPoolInitTransaction; readonly messageBase64: string;
  readonly phase: "signed" | "submitting" | "submitted" | "succeeded" | "failed";
}
export interface SolanaPoolInitJournalPorts {
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  read(): Promise<SolanaPoolInitJournalRecord | null>;
  /** Atomic durable write, resolved before subsequent external effects. */
  write(record: SolanaPoolInitJournalRecord): Promise<void>;
  sign(expected: SolanaPoolInitExpectation): Promise<SignedPoolInitTransaction>;
  /** Must verify both cryptographic signatures and decode actual message bytes, not signer metadata. */
  inspectSigned(bytesBase64: string): Promise<InspectedPoolInitTransaction>;
  observe(signed: SignedPoolInitTransaction, intent: SolanaPoolInitEnvelope): Promise<PoolInitObservation>;
  broadcast(bytesBase64: string): Promise<string>;
}
export interface SolanaPoolInitJournalResult {
  readonly status: "unresolved" | "succeeded" | "failed";
  readonly record: SolanaPoolInitJournalRecord; readonly reason: string;
}
function base64(value: string): boolean {
  return typeof value === "string" && value.length > 0 && Buffer.from(value, "base64").toString("base64") === value;
}
function unsigned(value: string): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < 1n << 64n;
}
function canonical(intent: SolanaPoolInitEnvelope, expected: SolanaPoolInitExpectation): string {
  if (intent.schema !== "agtmai-solana-pool-init-v1" || intent.cluster !== expected.cluster ||
    intent.payer !== expected.payer || intent.mint !== expected.mint || intent.pool !== expected.pool || intent.testOnly !== true) { throw new Error("Conflicting pool init journal intent"); }
  return JSON.stringify(verifySolanaPoolInitIntent({ feePayer: intent.payer, instructions: intent.instructions }, expected));
}
function validSigned(signed: SignedPoolInitTransaction): boolean {
  return base64(signed.bytesBase64) && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signed.signature) &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signed.blockhash) && unsigned(signed.lastValidBlockHeight);
}
function poolMatches(state: PoolStateEvidence | null, intent: SolanaPoolInitEnvelope): boolean {
  return state !== null && state.address === intent.pool && state.mint === intent.mint &&
    state.owner === intent.payer && state.verified === true;
}
function finalizedOutcome(observation: Extract<PoolInitObservation, { kind: "finalized" }>, record: SolanaPoolInitJournalRecord): "succeeded" | "failed" | null {
  if (observation.signature !== record.signed.signature || observation.messageBase64 !== record.messageBase64 || !unsigned(observation.slot)) { return null; }
  if (observation.err !== null) {
    return typeof observation.err === "object" && !Array.isArray(observation.err) ? "failed" : null;
  }
  return poolMatches(observation.poolState, record.intent) ? "succeeded" : null;
}
function validateStored(record: SolanaPoolInitJournalRecord, expected: SolanaPoolInitExpectation): void {
  if (!record || record.schema !== "agtmai-solana-pool-init-journal-v1" ||
    !["signed", "submitting", "submitted", "succeeded", "failed"].includes(record.phase)) { throw new Error("Invalid pool init journal record"); }
  canonical(record.intent, expected);
}
function terminalConflict(record: SolanaPoolInitJournalRecord, phase: "succeeded" | "failed"): boolean {
  return (record.phase === "succeeded" || record.phase === "failed") && record.phase !== phase;
}
/** A single pool init transaction. Expiry or submission uncertainty never authorizes replacement. */
export async function runSolanaPoolInitJournal(expected: SolanaPoolInitExpectation, ports: SolanaPoolInitJournalPorts): Promise<SolanaPoolInitJournalResult> {
  if (expected.testOnly !== true || expected.cluster !== "solana-devnet") { throw new Error("Test-only Devnet pool initialization required"); }
  return ports.exclusive(async () => {
    let record = await ports.read();
    if (record !== null) {
      validateStored(record, expected);
    }
    const signed = record === null ? await ports.sign(expected) : record.signed;
    if (!validSigned(signed)) { throw new Error("Invalid signed pool init transaction"); }
    const decoded = await ports.inspectSigned(signed.bytesBase64);
    const intent = verifySolanaPoolInitIntent(decoded.intent, expected);
    if (decoded.signature !== signed.signature || decoded.blockhash !== signed.blockhash || !base64(decoded.messageBase64)) { throw new Error("Signed pool init identity mismatch"); }
    if (record === null) {
      record = { schema: "agtmai-solana-pool-init-journal-v1", intent, signed, messageBase64: decoded.messageBase64, phase: "signed" };
      await ports.write(record);
    } else if (record.messageBase64 !== decoded.messageBase64 || canonical(record.intent, expected) !== canonical(intent, expected)) {
      throw new Error("Stored pool init message mismatch");
    }
    let current: SolanaPoolInitJournalRecord = record;
    const unresolved = (reason: string): SolanaPoolInitJournalResult => ({ status: "unresolved", record: current, reason });
    let observation: PoolInitObservation;
    try { observation = await ports.observe(signed, intent); }
    catch { return unresolved("observation-unavailable"); }
    if (observation.kind === "finalized") {
      const phase = finalizedOutcome(observation, current);
      if (!phase) { return unresolved("finalized-evidence-mismatch"); }
      if (terminalConflict(current, phase)) { return unresolved("terminal-evidence-conflict"); }
      if (current.phase !== phase) { current = { ...current, phase }; await ports.write(current); }
      return { status: phase, record: current, reason: "exact-finalized-pool-init-transaction" };
    }
    if (observation.kind !== "not-found" || current.phase !== "signed") { return unresolved("submission-unresolved-or-expired"); }
    current = { ...current, phase: "submitting" }; await ports.write(current);
    let signature: string;
    try { signature = await ports.broadcast(signed.bytesBase64); }
    catch { return unresolved("broadcast-outcome-unknown"); }
    if (signature !== signed.signature) { return unresolved("broadcast-signature-mismatch"); }
    current = { ...current, phase: "submitted" }; await ports.write(current);
    return unresolved("submitted-awaiting-finality");
  });
}
