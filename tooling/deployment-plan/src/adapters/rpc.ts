import { fail } from "../domain/model.ts";
import type { DeploymentRpc, RpcMethod } from "../application/ports.ts";
import type { QuoteObservation } from "../application/builder.ts";
const ALLOWED = new Set<RpcMethod>(["eth_chainId", "eth_getBlockByNumber", "eth_feeHistory", "eth_estimateGas"]);
export function assertLoopbackUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { fail("RPC_URL_INVALID", "RPC URL is invalid"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail("PUBLIC_RPC_FORBIDDEN", "only http://127.0.0.1:<port>/ is allowed");
  return url.href;
}
export function createLocalRpc(rpcUrl: string): DeploymentRpc {
  const expectedUrl = assertLoopbackUrl(rpcUrl); let id = 0;
  return { async request(method, params) {
    if (!ALLOWED.has(method)) fail("RPC_METHOD_FORBIDDEN", "RPC method is outside the fixed read-only allowlist"); id += 1;
    const response = await fetch(expectedUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if ((response.status >= 300 && response.status < 400) || response.redirected) fail("RPC_REDIRECT_FORBIDDEN", "RPC redirect is forbidden");
    if (response.url !== expectedUrl) fail("RPC_FINAL_URL_MISMATCH", "RPC final URL changed");
    if (!response.ok) fail("RPC_HTTP_FAILURE", `local RPC returned HTTP ${response.status}`);
    const body: unknown = await response.json(); if (!isObject(body) || body.jsonrpc !== "2.0" || body.id !== id || !("result" in body) || body.error !== undefined) fail("RPC_RESPONSE_INVALID", `invalid response to ${method}`); return body.result;
  } };
}
export async function observeFees(rpc: DeploymentRpc, from: string, creationInput: string, nowSeconds: bigint, priorityFeePerGas: bigint, maxFeePerGas: bigint): Promise<QuoteObservation> {
  const chain = quantity(await rpc.request("eth_chainId", []), "chainId"); const head = block(await rpc.request("eth_getBlockByNumber", ["latest", false]), "head");
  const bound = block(await rpc.request("eth_getBlockByNumber", [head.numberHex, false]), "bound block"); if (bound.hash !== head.hash) fail("REORGED_BLOCK", "bound block changed during observation");
  const history = await rpc.request("eth_feeHistory", ["0x1", head.numberHex, []]); if (!isObject(history) || !Array.isArray(history.baseFeePerGas) || history.baseFeePerGas.length < 1) fail("FEE_HISTORY_INVALID", "fee history is malformed");
  const newest = quantity(history.oldestBlock, "oldestBlock"); const base = quantity(history.baseFeePerGas[0], "baseFeePerGas");
  const gas = quantity(await rpc.request("eth_estimateGas", [{ from, data: creationInput, value: "0x0" }, head.numberHex]), "gasEstimate");
  return { chainId: chain.toString(), blockNumber: head.number.toString(), blockHash: head.hash, blockTimestamp: head.timestamp.toString(), currentHeadNumber: head.number.toString(), currentHeadHash: head.hash, feeHistoryNewestBlock: newest.toString(), gasEstimate: gas.toString(), blockGasLimit: head.gasLimit.toString(), baseFeePerGas: base.toString(), maxPriorityFeePerGas: priorityFeePerGas.toString(), maxFeePerGas: maxFeePerGas.toString(), observedAt: nowSeconds.toString() };
}
function block(value: unknown, name: string): { number: bigint; numberHex: string; hash: `0x${string}`; timestamp: bigint; gasLimit: bigint } { if (!isObject(value) || typeof value.number !== "string" || typeof value.hash !== "string" || !/^0x[0-9a-f]{64}$/u.test(value.hash)) fail("BLOCK_INVALID", `${name} is malformed`); return { number: quantity(value.number, "block number"), numberHex: value.number, hash: value.hash as `0x${string}`, timestamp: quantity(value.timestamp, "timestamp"), gasLimit: quantity(value.gasLimit, "gasLimit") }; }
function quantity(value: unknown, field: string): bigint { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) fail("RPC_QUANTITY_INVALID", `${field} is not a canonical RPC quantity`); return BigInt(value); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
