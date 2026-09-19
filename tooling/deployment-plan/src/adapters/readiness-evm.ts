import { readOnlyJsonRpc, isReadinessMethod } from "./readiness-rpc.ts";


export function createReadinessEvmRpc(endpoint: string, mode: "offline" | "observe", fetcher: typeof fetch = globalThis.fetch): { readonly request: (method: string, params: readonly unknown[]) => Promise<unknown>; readonly broadcastAllowed: false } {
  const rpc = readOnlyJsonRpc(endpoint, "ethereum", mode, fetcher);
  return { broadcastAllowed: false, async request(method, params) {
    if (!isReadinessMethod("ethereum", method)) { throw new Error("READINESS_RPC_METHOD_FORBIDDEN"); }
    const chainId = await rpc("eth_chainId", []);
    if (chainId !== "0x1") { throw new Error("READINESS_ETHEREUM_CHAIN_MISMATCH"); }
    return method === "eth_chainId" ? chainId : rpc(method, params);
  } };
}
