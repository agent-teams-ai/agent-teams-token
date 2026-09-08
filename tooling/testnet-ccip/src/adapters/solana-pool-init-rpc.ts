import { BURNMINT_PROGRAM } from "../domain/solana-pool-init.ts";
import type { SolanaPoolInitEnvelope } from "../domain/solana-pool-init.ts";
import type { PoolStateEvidence } from "../application/solana-pool-init-journal.ts";
import { createSolanaTransactionRpc } from "./solana-transaction-rpc.ts";
export function createSolanaPoolInitRpc(
  messageFromSigned: (bytes: string, intent: SolanaPoolInitEnvelope) => string,
  verifyState: (bytes: string, intent: SolanaPoolInitEnvelope) => PoolStateEvidence,
  fetcher: typeof fetch = globalThis.fetch,
) {
  const rpc = createSolanaTransactionRpc(messageFromSigned, async (read, intent, slot) => {
    const response = await read("getAccountInfo", [intent.pool,
      { encoding: "base64", commitment: "finalized", minContextSlot: slot }]) as {
        context: { slot: number }; value: { owner: string; executable: boolean; data: unknown[] };
      };
    const account = response.value;
    if (!Number.isSafeInteger(response.context.slot) || response.context.slot < slot || account.owner !== BURNMINT_PROGRAM ||
      account.executable !== false || !Array.isArray(account.data) || account.data[1] !== "base64" ||
      typeof account.data[0] !== "string" || !account.data[0] || Buffer.from(account.data[0], "base64").toString("base64") !== account.data[0]) {
      throw new Error("Invalid finalized pool account");
    }
    return verifyState(account.data[0], intent);
  }, fetcher);
  return { broadcast: rpc.broadcast, observe: async (...args: Parameters<typeof rpc.observe>) => {
    const observation = await rpc.observe(...args);
    return observation.kind === "finalized" ? { ...observation, poolState: observation.state } : observation;
  } };
}
