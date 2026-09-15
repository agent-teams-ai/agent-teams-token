import { readOnlyJsonRpc, isReadinessMethod } from "./readiness-rpc.ts";


export function createReadinessSolanaRpc(endpoint: string, expectedGenesisHash: string, mode: "offline" | "observe", fetcher: typeof fetch = globalThis.fetch): { readonly request: (method: string, params: readonly unknown[]) => Promise<unknown>; readonly broadcastAllowed: false } {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(expectedGenesisHash)) { throw new Error("READINESS_SOLANA_GENESIS_REQUIRED"); }
  const rpc = readOnlyJsonRpc(endpoint, "solana", mode, fetcher);
  return { broadcastAllowed: false, async request(method, params) {
    if (!isReadinessMethod("solana", method)) { throw new Error("READINESS_RPC_METHOD_FORBIDDEN"); }
    if (method === "simulateTransaction") {
      const [encoded, options] = params;
      const c = options as Record<string, unknown> | undefined;
      if (params.length !== 2 || typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !c || c.sigVerify !== false || c.encoding !== "base64" || c.commitment !== "finalized" || c.replaceRecentBlockhash !== true
        || Object.keys(c).toSorted().join() !== "commitment,encoding,replaceRecentBlockhash,sigVerify") { throw new Error("READINESS_UNSIGNED_SIMULATION_REQUIRED"); }
      const transaction = Buffer.from(encoded, "base64"), signatures = transaction[0];
      // Serialized transactions use a shortvec signature count. At the packet-size
      // bound it fits one byte. Every signature slot must remain all-zero.
      if (transaction.length > 1232 || signatures === undefined || signatures === 0 || signatures >= 128 || transaction.length <= 1 + signatures * 64 || transaction.subarray(1, 1 + signatures * 64).some(byte => byte !== 0)) { throw new Error("READINESS_UNSIGNED_SIMULATION_REQUIRED"); }
    }
    const genesis = await rpc("getGenesisHash", []);
    if (genesis !== expectedGenesisHash) { throw new Error("READINESS_SOLANA_GENESIS_MISMATCH"); }
    return method === "getGenesisHash" ? genesis : rpc(method, params);
  } };
}
