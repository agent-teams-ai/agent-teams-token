import type { SolanaMintIntent } from "../domain/solana-mint.ts";
export interface SignedSolanaTransaction {
  readonly bytesBase64: string; readonly signature: string; readonly blockhash: string;
  readonly lastValidBlockHeight: string;
}
export interface InspectedSolanaTransaction {
  readonly signature: string; readonly blockhash: string; readonly messageBase64: string;
  readonly intent: SolanaMintIntent;
}
export type SolanaObservation<State> = { readonly kind: "unknown" | "not-found" | "expired" } | {
  readonly kind: "finalized"; readonly signature: string; readonly messageBase64: string;
  readonly slot: string; readonly err: null | Record<string, unknown>; readonly state: State | null;
};
export interface SolanaTransactionRecord<Envelope> {
  readonly schema: string; readonly intent: Envelope; readonly signed: SignedSolanaTransaction;
  readonly messageBase64: string; readonly phase: "signed" | "submitting" | "submitted" | "succeeded" | "failed";
}
export interface SolanaTransactionPorts<Expected, Envelope, State> {
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  read(): Promise<SolanaTransactionRecord<Envelope> | null>;
  write(record: SolanaTransactionRecord<Envelope>): Promise<void>;
  sign(expected: Expected): Promise<SignedSolanaTransaction>;
  inspectSigned(bytes: string): Promise<InspectedSolanaTransaction>;
  observe(signed: SignedSolanaTransaction, intent: Envelope): Promise<SolanaObservation<State>>;
  broadcast(bytes: string): Promise<string>;
}
export interface SolanaTransactionContract<Expected, Envelope, State> {
  readonly schema: string; readonly label: string; readonly successReason: string;
  verify(intent: SolanaMintIntent, expected: Expected): Envelope;
  canonical(intent: Envelope, expected: Expected): string;
  stateMatches(state: State | null, intent: Envelope): boolean;
}
export interface SolanaTransactionResult<Envelope> {
  readonly status: "unresolved" | "succeeded" | "failed";
  readonly record: SolanaTransactionRecord<Envelope>; readonly reason: string;
}
function base64(value: string): boolean {
  return typeof value === "string" && value.length > 0 && Buffer.from(value, "base64").toString("base64") === value;
}
function unsigned(value: string): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < 1n << 64n;
}
function validSigned(signed: SignedSolanaTransaction): boolean {
  return base64(signed.bytesBase64) && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signed.signature) &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signed.blockhash) && unsigned(signed.lastValidBlockHeight);
}
function finalizedOutcome<Envelope, State>(observation: Extract<SolanaObservation<State>, { kind: "finalized" }>, record: SolanaTransactionRecord<Envelope>, matches: (state: State | null, intent: Envelope) => boolean): "succeeded" | "failed" | null {
  if (observation.signature !== record.signed.signature || observation.messageBase64 !== record.messageBase64 || !unsigned(observation.slot)) { return null; }
  if (observation.err !== null) {
    return typeof observation.err === "object" && !Array.isArray(observation.err) ? "failed" : null;
  }
  return matches(observation.state, record.intent) ? "succeeded" : null;
}
function terminalConflict<Envelope>(record: SolanaTransactionRecord<Envelope>, phase: "succeeded" | "failed"): boolean {
  return (record.phase === "succeeded" || record.phase === "failed") && record.phase !== phase;
}
function validateStored<Envelope>(record: SolanaTransactionRecord<Envelope>, schema: string, label: string): void {
  if (!record || record.schema !== schema || !["signed", "submitting", "submitted", "succeeded", "failed"].includes(record.phase)) {
    throw new Error("Invalid " + label + " journal record");
  }
}
/** One signed Solana transaction. Expiry or submission uncertainty never authorizes replacement. */
export async function runSolanaTransactionJournal<Expected extends { testOnly: true; cluster: "solana-devnet" }, Envelope, State>(expected: Expected, ports: SolanaTransactionPorts<Expected, Envelope, State>, contract: SolanaTransactionContract<Expected, Envelope, State>): Promise<SolanaTransactionResult<Envelope>> {
  if (expected.testOnly !== true || expected.cluster !== "solana-devnet") { throw new Error("Test-only Devnet transaction required"); }
  return ports.exclusive(async () => {
    let record = await ports.read();
    if (record !== null) {
      validateStored(record, contract.schema, contract.label);
      contract.canonical(record.intent, expected);
    }
    const signed = record === null ? await ports.sign(expected) : record.signed;
    if (!validSigned(signed)) { throw new Error("Invalid signed Solana transaction"); }
    const decoded = await ports.inspectSigned(signed.bytesBase64);
    const intent = contract.verify(decoded.intent, expected);
    if (decoded.signature !== signed.signature || decoded.blockhash !== signed.blockhash || !base64(decoded.messageBase64)) { throw new Error("Signed Solana identity mismatch"); }
    if (record === null) {
      record = { schema: contract.schema, intent, signed, messageBase64: decoded.messageBase64, phase: "signed" };
      await ports.write(record);
    } else if (record.messageBase64 !== decoded.messageBase64 || contract.canonical(record.intent, expected) !== contract.canonical(intent, expected)) {
      throw new Error("Stored Solana message mismatch");
    }
    let current: SolanaTransactionRecord<Envelope> = record;
    const unresolved = (reason: string): SolanaTransactionResult<Envelope> => ({ status: "unresolved", record: current, reason });
    let observation: SolanaObservation<State>;
    try { observation = await ports.observe(signed, intent); }
    catch { return unresolved("observation-unavailable"); }
    if (observation.kind === "finalized") {
      const phase = finalizedOutcome(observation, current, contract.stateMatches);
      if (!phase) { return unresolved("finalized-evidence-mismatch"); }
      if (terminalConflict(current, phase)) { return unresolved("terminal-evidence-conflict"); }
      if (current.phase !== phase) { current = { ...current, phase }; await ports.write(current); }
      return { status: phase, record: current, reason: contract.successReason };
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
