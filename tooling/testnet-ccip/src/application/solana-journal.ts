import { SPL_TOKEN_PROGRAM, verifySolanaMintIntent } from "../domain/solana-mint.ts";
import type { SolanaMintEnvelope, SolanaMintExpectation, SolanaMintIntent } from "../domain/solana-mint.ts";

export interface SignedMintTransaction {
  readonly bytesBase64: string; readonly signature: string; readonly blockhash: string;
  /** From the same authenticated getLatestBlockhash response; not encoded in transaction bytes. */
  readonly lastValidBlockHeight: string;
}
export interface InspectedMintTransaction {
  readonly signature: string; readonly blockhash: string; readonly messageBase64: string;
  readonly intent: SolanaMintIntent;
}
export interface MintStateEvidence {
  readonly address: string; readonly tokenProgram: string; readonly decimals: number;
  readonly supply: string; readonly mintAuthority: string; readonly freezeAuthority: string | null;
}
export type MintObservation = { readonly kind: "unknown" | "not-found" | "expired" } | {
  readonly kind: "finalized"; readonly signature: string; readonly messageBase64: string;
  readonly slot: string; readonly err: null | Record<string, unknown>;
  readonly mintState: MintStateEvidence | null;
};
export interface SolanaMintJournalRecord {
  readonly schema: "agtmai-solana-mint-journal-v1"; readonly intent: SolanaMintEnvelope;
  readonly signed: SignedMintTransaction; readonly messageBase64: string;
  readonly phase: "signed" | "submitting" | "submitted" | "succeeded" | "failed";
}
export interface SolanaMintJournalPorts {
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  read(): Promise<SolanaMintJournalRecord | null>;
  /** Atomic durable write, resolved before subsequent external effects. */
  write(record: SolanaMintJournalRecord): Promise<void>;
  sign(expected: SolanaMintExpectation): Promise<SignedMintTransaction>;
  /** Must verify both cryptographic signatures and decode actual message bytes, not signer metadata. */
  inspectSigned(bytesBase64: string): Promise<InspectedMintTransaction>;
  observe(signed: SignedMintTransaction, intent: SolanaMintEnvelope): Promise<MintObservation>;
  broadcast(bytesBase64: string): Promise<string>;
}
export interface SolanaMintJournalResult {
  readonly status: "unresolved" | "succeeded" | "failed";
  readonly record: SolanaMintJournalRecord; readonly reason: string;
}
function base64(value: string): boolean {
  return typeof value === "string" && value.length > 0 && Buffer.from(value, "base64").toString("base64") === value;
}
function unsigned(value: string): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < 1n << 64n;
}
function canonical(intent: SolanaMintEnvelope, expected: SolanaMintExpectation): string {
  if (intent.schema !== "agtmai-solana-mint-v1" || intent.cluster !== expected.cluster ||
    intent.payer !== expected.payer || intent.mint !== expected.mint || intent.rentLamports !== String(expected.rentLamports) ||
    intent.decimals !== 9 || intent.initialSupply !== "0" || intent.freezeAuthority !== null) { throw new Error("Conflicting mint journal intent"); }
  return JSON.stringify(verifySolanaMintIntent({ feePayer: intent.payer, instructions: intent.instructions }, expected));
}
function validSigned(signed: SignedMintTransaction): boolean {
  return base64(signed.bytesBase64) && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signed.signature) &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signed.blockhash) && unsigned(signed.lastValidBlockHeight);
}
function mintMatches(state: MintStateEvidence | null, intent: SolanaMintEnvelope): boolean {
  return state !== null && state.address === intent.mint && state.tokenProgram === SPL_TOKEN_PROGRAM &&
    state.decimals === 9 && state.supply === "0" && state.mintAuthority === intent.payer && state.freezeAuthority === null;
}
function finalizedOutcome(observation: Extract<MintObservation, { kind: "finalized" }>, record: SolanaMintJournalRecord): "succeeded" | "failed" | null {
  if (observation.signature !== record.signed.signature || observation.messageBase64 !== record.messageBase64 || !unsigned(observation.slot)) { return null; }
  if (observation.err !== null) {
    return typeof observation.err === "object" && !Array.isArray(observation.err) ? "failed" : null;
  }
  return mintMatches(observation.mintState, record.intent) ? "succeeded" : null;
}
function validateStored(record: SolanaMintJournalRecord, expected: SolanaMintExpectation): void {
  if (!record || record.schema !== "agtmai-solana-mint-journal-v1" ||
    !["signed", "submitting", "submitted", "succeeded", "failed"].includes(record.phase)) { throw new Error("Invalid mint journal record"); }
  canonical(record.intent, expected);
}
function terminalConflict(record: SolanaMintJournalRecord, phase: "succeeded" | "failed"): boolean {
  return (record.phase === "succeeded" || record.phase === "failed") && record.phase !== phase;
}
/** A single mint transaction. Expiry or submission uncertainty never authorizes replacement. */
export async function runSolanaMintJournal(expected: SolanaMintExpectation, ports: SolanaMintJournalPorts): Promise<SolanaMintJournalResult> {
  if (expected.testOnly !== true || expected.cluster !== "solana-devnet") { throw new Error("Test-only Devnet mint required"); }
  return ports.exclusive(async () => {
    let record = await ports.read();
    if (record !== null) {
      validateStored(record, expected);
    }
    const signed = record === null ? await ports.sign(expected) : record.signed;
    if (!validSigned(signed)) { throw new Error("Invalid signed mint transaction"); }
    const decoded = await ports.inspectSigned(signed.bytesBase64);
    const intent = verifySolanaMintIntent(decoded.intent, expected);
    if (decoded.signature !== signed.signature || decoded.blockhash !== signed.blockhash || !base64(decoded.messageBase64)) { throw new Error("Signed mint identity mismatch"); }
    if (record === null) {
      record = { schema: "agtmai-solana-mint-journal-v1", intent, signed, messageBase64: decoded.messageBase64, phase: "signed" };
      await ports.write(record);
    } else if (record.messageBase64 !== decoded.messageBase64 || canonical(record.intent, expected) !== canonical(intent, expected)) {
      throw new Error("Stored mint message mismatch");
    }
    let current: SolanaMintJournalRecord = record;
    const unresolved = (reason: string): SolanaMintJournalResult => ({ status: "unresolved", record: current, reason });
    let observation: MintObservation;
    try { observation = await ports.observe(signed, intent); }
    catch { return unresolved("observation-unavailable"); }
    if (observation.kind === "finalized") {
      const phase = finalizedOutcome(observation, current);
      if (!phase) { return unresolved("finalized-evidence-mismatch"); }
      if (terminalConflict(current, phase)) { return unresolved("terminal-evidence-conflict"); }
      if (current.phase !== phase) { current = { ...current, phase }; await ports.write(current); }
      return { status: phase, record: current, reason: "exact-finalized-mint-transaction" };
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
