import { createSolanaTransactionRpc } from "./solana-transaction-rpc.ts";
import type { SolanaRpcRead } from "./solana-transaction-rpc.ts";
import type { SolanaRegistrationEnvelope, SolanaRegistrationExpectation } from "../domain/solana-registration.ts";
import type { RegistrationStateEvidence } from "../application/solana-registration-journal.ts";
export interface RegistrationVerifier {
  snapshotAddresses(expected: SolanaRegistrationExpectation): string[];
  verifySnapshot(values: unknown[], expected: SolanaRegistrationExpectation, phase: "before" | "after"): RegistrationStateEvidence;
}
export async function readRegistrationSnapshot(read: SolanaRpcRead, sdk: RegistrationVerifier,
  expected: SolanaRegistrationExpectation, phase: "before" | "after", minContextSlot = 0): Promise<RegistrationStateEvidence> {
  const result = await read("getMultipleAccounts", [sdk.snapshotAddresses(expected),
    { encoding: "base64", commitment: "finalized", minContextSlot }]) as { context: { slot: number }; value: unknown[] };
  if (!Number.isSafeInteger(result.context?.slot) || result.context.slot < minContextSlot ||
    !Array.isArray(result.value) || result.value.length !== 6) { throw new Error("Invalid coherent finalized registration snapshot"); }
  return sdk.verifySnapshot(result.value, expected, phase);
}
export function createSolanaRegistrationRpc(
  messageFromSigned: (bytes: string, intent: SolanaRegistrationEnvelope) => string,
  sdk: RegistrationVerifier, fetcher: typeof fetch = globalThis.fetch,
) {
  return createSolanaTransactionRpc(messageFromSigned,
    (read, intent, slot) => readRegistrationSnapshot(read, sdk, intent, "after", slot), fetcher);
}
