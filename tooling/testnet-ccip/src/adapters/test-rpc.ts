/** IO-only selection. An explicit invalid value never falls back to a default. */
export interface TestRpcSettings { readonly sepoliaRpc?: string; readonly solanaRpc?: string }
export const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const PUBLIC_SEPOLIA_RPC = "https://sepolia.gateway.tenderly.co";
export const DEFAULT_SOLANA_RPC = "https://api.devnet.solana.com";
export function selectSepoliaRpc(settings: TestRpcSettings): string {
  const endpoint = settings.sepoliaRpc === undefined ? DEFAULT_SEPOLIA_RPC : settings.sepoliaRpc;
  if (![DEFAULT_SEPOLIA_RPC, PUBLIC_SEPOLIA_RPC].includes(endpoint)) {
    throw new Error("Explicit public HTTPS Sepolia TEST RPC required");
  }
  return endpoint;
}
export function selectSolanaRpc(settings: TestRpcSettings): string {
  const endpoint = settings.solanaRpc === undefined ? DEFAULT_SOLANA_RPC : settings.solanaRpc;
  if (endpoint !== DEFAULT_SOLANA_RPC) { throw new Error("Official HTTPS Solana Devnet TEST RPC required"); }
  return endpoint;
}
export const TEST_RPC_RESPONSE_LIMIT = 4 * 1024 * 1024;
/** Bound streamed bytes before parsing; includes errors and never follows redirect evidence. */
export async function readTestRpcJson(response: Response): Promise<unknown> {
  if (response.redirected || !response.body) { throw new Error("Invalid TEST RPC response"); }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || BigInt(length) > BigInt(TEST_RPC_RESPONSE_LIMIT))) {
    await response.body.cancel(); throw new Error("TEST RPC response exceeds bound");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      total += value.byteLength;
      if (total > TEST_RPC_RESPONSE_LIMIT) { await reader.cancel(); throw new Error("TEST RPC response exceeds bound"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
/** One endpoint and one attempt, with an end-to-end fetch/body deadline. No fallback or send retry. */
export function createTestRpcRequest(endpoint: string, fetcher: typeof fetch = globalThis.fetch, initialId = 0) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("Invalid HTTPS TEST RPC endpoint");
  }
  let sequence = initialId;
  return async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const id = ++sequence;
    const response = await fetcher(url.href, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok || response.redirected) { throw new Error("TEST RPC unavailable"); }
    const body = await readTestRpcJson(response);
    if (body === null || typeof body !== "object" || Array.isArray(body)) { throw new Error("Invalid TEST RPC envelope"); }
    const payload = body as Record<string, unknown>;
    if (payload.id !== id || payload.jsonrpc !== "2.0" || "error" in payload || !("result" in payload)) {
      throw new Error("Invalid TEST RPC envelope");
    }
    return payload.result;
  };
}

/** SDK HTTP hook: the same public selection and bounds, including SDK batch responses. */
export function createSdkTestFetch(endpoint: string, fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  if (![DEFAULT_SEPOLIA_RPC, PUBLIC_SEPOLIA_RPC, DEFAULT_SOLANA_RPC].includes(endpoint)) {
    throw new Error("Explicit public HTTPS TEST RPC required");
  }
  const url = new URL(endpoint).href;
  return async (input, init) => {
    if (String(input) !== endpoint && String(input) !== url || init?.method?.toUpperCase() !== "POST"
      || typeof init.body !== "string") { throw new Error("Unexpected SDK TEST RPC request"); }
    const request = JSON.parse(init.body) as unknown;
    const requests = (Array.isArray(request) ? request : [request]) as Record<string, unknown>[];
    if (!requests.length || requests.some(r => !r || r.jsonrpc !== "2.0" || typeof r.method !== "string"
      || !("id" in r))) { throw new Error("Invalid SDK TEST RPC request"); }
    const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" },
      body: init.body, redirect: "error", credentials: "omit",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if (!response.ok || response.redirected) { throw new Error("SDK TEST RPC unavailable"); }
    const body = await readTestRpcJson(response), replies = Array.isArray(body) ? body : [body];
    if (Array.isArray(body) !== Array.isArray(request) || replies.length !== requests.length
      || new Set(requests.map(r => r.id)).size !== requests.length
      || new Set(replies.map(r => r?.id)).size !== replies.length
      || replies.some(r => !r || typeof r !== "object" || Array.isArray(r) || r.jsonrpc !== "2.0"
        || "error" in r || !("result" in r) || !requests.some(q => q.id === r.id))) {
      throw new Error("Invalid SDK TEST RPC envelope");
    }
    return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
  };
}
