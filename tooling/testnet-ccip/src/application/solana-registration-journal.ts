import { runSolanaTransactionJournal } from "./solana-transaction-journal.ts";
import type { SolanaTransactionPorts, SolanaTransactionRecord } from "./solana-transaction-journal.ts";
import { verifySolanaRegistrationIntent } from "../domain/solana-registration.ts";
import type { SolanaRegistrationEnvelope, SolanaRegistrationExpectation } from "../domain/solana-registration.ts";
export interface RegistrationStateEvidence {
  readonly operation: SolanaRegistrationExpectation["operation"]; readonly mint: string; readonly verified: true;
}
export type SolanaRegistrationRecord = SolanaTransactionRecord<SolanaRegistrationEnvelope>;
export type SolanaRegistrationPorts = SolanaTransactionPorts<SolanaRegistrationExpectation, SolanaRegistrationEnvelope, RegistrationStateEvidence>;
export function runSolanaRegistrationJournal(expected: SolanaRegistrationExpectation, ports: SolanaRegistrationPorts) {
  return runSolanaTransactionJournal(expected, ports, {
    schema: "agtmai-solana-registration-journal-v1", label: "Solana registration", successReason: "exact-finalized-registration-transaction",
    verify: verifySolanaRegistrationIntent,
    canonical(intent, expectation) {
      const actual = verifySolanaRegistrationIntent({ feePayer: intent.payer, instructions: intent.instructions }, expectation);
      if (JSON.stringify(intent) !== JSON.stringify(actual)) { throw new Error("Conflicting registration journal"); }
      return JSON.stringify(actual);
    },
    stateMatches: (state, intent) => state !== null && state.verified === true && state.mint === intent.mint && state.operation === intent.operation,
  });
}
