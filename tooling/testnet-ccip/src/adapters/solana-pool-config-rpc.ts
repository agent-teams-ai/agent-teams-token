import { createSolanaTransactionRpc, parseSolanaRpcSnapshot } from "./solana-transaction-rpc.ts";
import type { SolanaRpcRead } from "./solana-transaction-rpc.ts";
import type { SolanaPoolConfigEnvelope, SolanaPoolConfigExpectation } from "../domain/solana-pool-config.ts";
import type { PoolConfigStateEvidence } from "../application/solana-pool-config-journal.ts";
import type { RpcAccount } from "./solana-transaction-sdk.mjs";
export interface PoolConfigVerifier {
  snapshotAddresses(e: SolanaPoolConfigExpectation): string[];
  verifySnapshot(values: readonly (RpcAccount | null)[], e: SolanaPoolConfigExpectation, phase: "before" | "after", slot: number, transactionSlot?: number): PoolConfigStateEvidence;
}
export async function readPoolConfigSnapshot(read: SolanaRpcRead, sdk: PoolConfigVerifier,
  expected: SolanaPoolConfigExpectation, phase: "before" | "after", minContextSlot = 0): Promise<PoolConfigStateEvidence> {
  const addresses = sdk.snapshotAddresses(expected);
  const result = await read("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "finalized", minContextSlot }]);
  const snapshot = parseSolanaRpcSnapshot(result, addresses.length, minContextSlot);
  return sdk.verifySnapshot(snapshot.accounts, expected, phase, snapshot.slot, minContextSlot);
}
export function createSolanaPoolConfigRpc(message: (bytes: string, intent: SolanaPoolConfigEnvelope) => string,
  sdk: PoolConfigVerifier, fetcher: typeof fetch = globalThis.fetch) {
  return createSolanaTransactionRpc(message, (read, intent, slot) => readPoolConfigSnapshot(read, sdk, intent, "after", slot), fetcher);
}
