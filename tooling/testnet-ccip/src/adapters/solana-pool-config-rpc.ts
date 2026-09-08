import { createSolanaTransactionRpc } from "./solana-transaction-rpc.ts";
import type { SolanaRpcRead } from "./solana-transaction-rpc.ts";
import type { SolanaPoolConfigEnvelope, SolanaPoolConfigExpectation } from "../domain/solana-pool-config.ts";
import type { PoolConfigStateEvidence } from "../application/solana-pool-config-journal.ts";
export interface PoolConfigVerifier {
  snapshotAddresses(e: SolanaPoolConfigExpectation): string[];
  verifySnapshot(values: unknown[], e: SolanaPoolConfigExpectation, phase: "before" | "after", slot: number, transactionSlot: number): PoolConfigStateEvidence;
}
export async function readPoolConfigSnapshot(read: SolanaRpcRead, sdk: PoolConfigVerifier,
  expected: SolanaPoolConfigExpectation, phase: "before" | "after", minContextSlot = 0): Promise<PoolConfigStateEvidence> {
  const addresses = sdk.snapshotAddresses(expected);
  const result = await read("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "finalized", minContextSlot }]) as {
    context: { slot: number }; value: unknown[];
  };
  if (!Number.isSafeInteger(result.context?.slot) || result.context.slot < minContextSlot || !Array.isArray(result.value) || result.value.length !== addresses.length) {
    throw new Error("Invalid coherent finalized pool config snapshot");
  }
  return sdk.verifySnapshot(result.value, expected, phase, result.context.slot, minContextSlot);
}
export function createSolanaPoolConfigRpc(message: (bytes: string, intent: SolanaPoolConfigEnvelope) => string,
  sdk: PoolConfigVerifier, fetcher: typeof fetch = globalThis.fetch) {
  return createSolanaTransactionRpc(message, (read, intent, slot) => readPoolConfigSnapshot(read, sdk, intent, "after", slot), fetcher);
}
