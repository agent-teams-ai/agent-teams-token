const fail = (code: string): never => { throw new Error(`READINESS_${code}`); };
const READ_METHODS = { ethereum: ["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getCode", "eth_call", "eth_getLogs", "eth_getBalance", "eth_getStorageAt", "eth_getTransactionCount", "eth_estimateGas", "eth_feeHistory", "eth_maxPriorityFeePerGas", "eth_gasPrice"],
  solana: ["getGenesisHash", "getSlot", "getBlockTime", "getBlock", "getAccountInfo", "getMultipleAccounts", "getTokenSupply", "getTokenAccountBalance", "getSignaturesForAddress", "getTransaction", "getBalance", "getFeeForMessage", "getMinimumBalanceForRentExemption", "getLatestBlockhash", "isBlockhashValid", "getRecentPrioritizationFees", "simulateTransaction"] } as const;
export function isReadinessMethod(family: "ethereum" | "solana", method: string): boolean {
  return (READ_METHODS[family] as readonly string[] | undefined)?.includes(method) === true;
}

/** HTTP details shared by the two explicit read-only adapters. No signer or submission capability exists. */
export function readOnlyJsonRpc(endpoint: string, family: "ethereum" | "solana", mode: "offline" | "observe", fetcher: typeof fetch = globalThis.fetch): (method: string, params: readonly unknown[]) => Promise<unknown> {
  const url = new URL(endpoint);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.hash) { return fail("ENDPOINT_INVALID"); }
  let sequence = 0;
  return async (method, params) => {
    // Check both controls before touching the network, including on error paths.
    if (mode !== "observe") { return fail("OFFLINE_NETWORK_FORBIDDEN"); }
    if (!isReadinessMethod(family, method) || !Array.isArray(params)) { return fail("RPC_METHOD_FORBIDDEN"); }
    const id = ++sequence;
    try {
      const response = await fetcher(url.href, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      if (!response.ok || !response.body) { return fail("RPC_UNAVAILABLE"); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) { break; }
          length += next.value.length;
          if (length > 8 * 1024 * 1024) { await reader.cancel(); return fail("RPC_RESPONSE_BOUND"); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) { return fail("RPC_RESPONSE_INVALID"); }
      const envelope = value as Record<string, unknown>;
      if (envelope.jsonrpc !== "2.0" || envelope.id !== id || "error" in envelope || !("result" in envelope)) { return fail("RPC_RESPONSE_INVALID"); }
      return envelope.result;
    } catch {
      // Provider errors and URLs may contain credentials. Only an allowlisted code escapes.
      return fail("RPC_UNAVAILABLE");
    }
  };
}
