import { LocalEvmError } from "./model.ts";

export interface RpcClient { request(method: string, params?: readonly unknown[]): Promise<unknown> }

export function assertPrivateRpcUrl(rpcUrl: string): void {
  let parsed: URL;
  try { parsed = new URL(rpcUrl); } catch { throw new LocalEvmError("VERIFY_RPC_URL_INVALID", "RPC URL is invalid"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password || !parsed.port || parsed.pathname !== "/") {
    throw new LocalEvmError("VERIFY_PUBLIC_RPC_FORBIDDEN", "only an unauthenticated http://127.0.0.1:<port>/ RPC is allowed");
  }
}

export function createRpcClient(rpcUrl: string): RpcClient {
  assertPrivateRpcUrl(rpcUrl);
  const expectedUrl = new URL(rpcUrl).href;
  let identifier = 0;
  return {
    async request(method, params = []): Promise<unknown> {
      identifier += 1;
      const response = await fetch(expectedUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: identifier, method, params }),
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      assertRpcResponseUrl(response, expectedUrl, "VERIFY");
      if (!response.ok) {throw new LocalEvmError("VERIFY_RPC_HTTP_FAILURE", `local RPC returned HTTP ${response.status}`);}
      const value: unknown = await response.json();
      if (!isRecord(value) || value.id !== identifier || value.jsonrpc !== "2.0" || !("result" in value) || value.error !== undefined) {
        throw new LocalEvmError("VERIFY_RPC_RESPONSE_INVALID", `local RPC returned an invalid response for ${method}`);
      }
      return value.result;
    },
  };
}

export async function bootstrapRpcRequest(rpcUrl: string, method: string, params: readonly unknown[]): Promise<string> {
  assertPrivateRpcUrl(rpcUrl);
  const expectedUrl = new URL(rpcUrl).href;
  const response = await fetch(expectedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
    redirect: "manual",
  });
  assertRpcResponseUrl(response, expectedUrl, "LOCAL_EVM");
  if (!response.ok) {throw new LocalEvmError("LOCAL_EVM_RPC_HTTP_FAILURE", `local RPC returned HTTP ${response.status}`);}
  const value: unknown = await response.json();
  if (!isRecord(value) || value.id !== 1 || value.jsonrpc !== "2.0" || typeof value.result !== "string" || value.error !== undefined) {
    throw new LocalEvmError("LOCAL_EVM_RPC_INVALID", `local RPC returned an invalid response for ${method}`);
  }
  return value.result;
}

function assertRpcResponseUrl(response: Response, expectedUrl: string, prefix: "VERIFY" | "LOCAL_EVM"): void {
  if (response.status >= 300 && response.status < 400) {
    throw new LocalEvmError(`${prefix}_RPC_REDIRECT_FORBIDDEN`, "local RPC redirects are forbidden");
  }
  if (response.redirected || response.url !== expectedUrl) {
    throw new LocalEvmError(`${prefix}_RPC_FINAL_URL_MISMATCH`, "local RPC response URL differs from the requested endpoint");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
