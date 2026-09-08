import { runSolanaTransactionJournal } from "./solana-transaction-journal.ts";
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
function canonical(intent: SolanaPoolInitEnvelope, expected: SolanaPoolInitExpectation): string {
  if (intent.schema !== "agtmai-solana-pool-init-v1" || intent.cluster !== expected.cluster ||
    intent.payer !== expected.payer || intent.mint !== expected.mint || intent.pool !== expected.pool || intent.testOnly !== true) { throw new Error("Conflicting pool init journal intent"); }
  return JSON.stringify(verifySolanaPoolInitIntent({ feePayer: intent.payer, instructions: intent.instructions }, expected));
}
function poolMatches(state: PoolStateEvidence | null, intent: SolanaPoolInitEnvelope): boolean {
  return state !== null && state.address === intent.pool && state.mint === intent.mint &&
    state.owner === intent.payer && state.verified === true;
}
export async function runSolanaPoolInitJournal(expected: SolanaPoolInitExpectation, ports: SolanaPoolInitJournalPorts): Promise<SolanaPoolInitJournalResult> {
  const result = await runSolanaTransactionJournal(expected, {
    ...ports,
    write: record => ports.write({ ...record, schema: "agtmai-solana-pool-init-journal-v1" }),
    observe: async (signed, intent) => {
      const observation = await ports.observe(signed, intent);
      return observation.kind === "finalized" ? { ...observation, state: observation.poolState } : observation;
    },
  }, { schema: "agtmai-solana-pool-init-journal-v1", label: "pool init",
    successReason: "exact-finalized-pool-init-transaction", verify: verifySolanaPoolInitIntent,
    canonical, stateMatches: poolMatches });
  return { ...result, record: { ...result.record, schema: "agtmai-solana-pool-init-journal-v1" } };
}
