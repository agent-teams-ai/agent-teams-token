import { runSolanaTransactionJournal } from "./solana-transaction-journal.ts";
import type { SolanaTransactionPorts, SolanaTransactionRecord } from "./solana-transaction-journal.ts";
import { verifySolanaPoolConfigIntent } from "../domain/solana-pool-config.ts";
import type { SolanaPoolConfigEnvelope, SolanaPoolConfigExpectation } from "../domain/solana-pool-config.ts";
export interface PoolConfigStateEvidence {
  readonly operation: SolanaPoolConfigExpectation["operation"]; readonly mint: string; readonly verified: true;
}
export type SolanaPoolConfigRecord = SolanaTransactionRecord<SolanaPoolConfigEnvelope>;
export type SolanaPoolConfigPorts = SolanaTransactionPorts<SolanaPoolConfigExpectation, SolanaPoolConfigEnvelope, PoolConfigStateEvidence>;
export function runSolanaPoolConfigJournal(expected: SolanaPoolConfigExpectation, ports: SolanaPoolConfigPorts) {
  return runSolanaTransactionJournal(expected, ports, { schema: "agtmai-solana-pool-config-journal-v1", label: "Solana pool config",
    successReason: "exact-finalized-pool-config-transaction", verify: verifySolanaPoolConfigIntent,
    canonical(intent, e) {
      const canonical = verifySolanaPoolConfigIntent({ feePayer: intent.payer, instructions: intent.instructions }, e);
      if (JSON.stringify(intent) !== JSON.stringify(canonical)) { throw new Error("Conflicting pool config journal"); }
      return JSON.stringify(canonical);
    },
    stateMatches: (state, e) => state !== null && state.verified === true && state.operation === e.operation && state.mint === e.mint,
  });
}
