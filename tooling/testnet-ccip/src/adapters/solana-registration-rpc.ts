import { createSolanaTransactionRpc, parseSolanaRpcSnapshot } from "./solana-transaction-rpc.ts";
import type { SolanaRpcRead } from "./solana-transaction-rpc.ts";
import type { SolanaRegistrationEnvelope, SolanaRegistrationExpectation } from "../domain/solana-registration.ts";
import type { RegistrationStateEvidence } from "../application/solana-registration-journal.ts";
import type { RpcAccount } from "./solana-transaction-sdk.mjs";
export interface RegistrationVerifier {
  snapshotAddresses(expected: SolanaRegistrationExpectation): string[];
  verifySnapshot(values: readonly (RpcAccount | null | undefined)[], expected: SolanaRegistrationExpectation, phase: "before" | "after"): RegistrationStateEvidence;
}
export async function readRegistrationSnapshot(read: SolanaRpcRead, sdk: RegistrationVerifier,
  expected: SolanaRegistrationExpectation, phase: "before" | "after", minContextSlot = 0): Promise<RegistrationStateEvidence> {
  const result = await read("getMultipleAccounts", [sdk.snapshotAddresses(expected),
    { encoding: "base64", commitment: "finalized", minContextSlot }]);
  return sdk.verifySnapshot(parseSolanaRpcSnapshot(result, 6, minContextSlot).accounts, expected, phase);
}
export function createSolanaRegistrationRpc(
  messageFromSigned: (bytes: string, intent: SolanaRegistrationEnvelope) => string,
  sdk: RegistrationVerifier, fetcher: typeof fetch = globalThis.fetch,
) {
  return createSolanaTransactionRpc(messageFromSigned,
    (read, intent, slot) => readRegistrationSnapshot(read, sdk, intent, "after", slot), fetcher);
}
