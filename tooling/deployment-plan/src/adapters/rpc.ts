import type { QuoteObservation } from "../application/builder.ts";
import type { DeploymentRpc, RpcMethod } from "../application/ports.ts";
import { fail } from "../domain/model.ts";

const ALLOWED = new Set<RpcMethod>([
  "eth_chainId",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_feeHistory",
  "eth_estimateGas",
]);

interface RpcBlock {
  readonly number: bigint;
  readonly numberHex: string;
  readonly hash: `0x${string}`;
  readonly timestamp: bigint;
  readonly gasLimit: bigint;
  readonly baseFeePerGas: bigint;
}

export interface FeeObservationRequest {
  readonly from: string;
  readonly creationInput: string;
  readonly nowSeconds: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
}

export function assertLoopbackUrl(value: string): string {
  const url = parseUrl(value);
  if (!isExactLoopbackRoot(url)) {
    fail("PUBLIC_RPC_FORBIDDEN", "only http://127.0.0.1:<port>/ is allowed");
  }
  return url.href;
}

export function createLocalRpc(rpcUrl: string): DeploymentRpc {
  const expectedUrl = assertLoopbackUrl(rpcUrl);
  let id = 0;
  return {
    async request(method, params) {
      if (!ALLOWED.has(method)) {
        fail("RPC_METHOD_FORBIDDEN", "RPC method is outside the fixed read-only allowlist");
      }
      id += 1;
      const response = await requestRpc(expectedUrl, { id, method, params });
      validateResponse(response, expectedUrl);
      const body: unknown = await response.json();
      return readResult(body, id, method);
    },
  };
}

export async function observeFees(
  rpc: DeploymentRpc,
  request: FeeObservationRequest,
): Promise<QuoteObservation> {
  const chain = quantity(await rpc.request("eth_chainId", []), "chainId");
  const head = readBlock(
    await rpc.request("eth_getBlockByNumber", ["latest", false]),
    "head",
  );
  const bound = readBlock(
    await rpc.request("eth_getBlockByNumber", [head.numberHex, false]),
    "bound block",
  );
  if (bound.hash !== head.hash) {
    fail("REORGED_BLOCK", "bound block changed during observation");
  }
  const history = readFeeHistory(
    await rpc.request("eth_feeHistory", ["0x1", head.numberHex, []]),
  );
  if (history.baseFee !== bound.baseFeePerGas) {
    fail("BASE_FEE_MISMATCH", "block base fee differs from fee history");
  }
  const senderNonce = quantity(
    await rpc.request("eth_getTransactionCount", [request.from, head.numberHex]),
    "senderNonce",
  );
  const gas = quantity(
    await rpc.request("eth_estimateGas", [
      { from: request.from, data: request.creationInput, value: "0x0" },
      head.numberHex,
    ]),
    "gasEstimate",
  );
  return {
    chainId: chain.toString(),
    blockNumber: head.number.toString(),
    blockHash: head.hash,
    blockTimestamp: head.timestamp.toString(),
    currentHeadNumber: head.number.toString(),
    currentHeadHash: head.hash,
    feeHistoryNewestBlock: history.newest.toString(),
    senderNonce: senderNonce.toString(),
    gasEstimate: gas.toString(),
    blockGasLimit: head.gasLimit.toString(),
    baseFeePerGas: history.baseFee.toString(),
    maxPriorityFeePerGas: request.maxPriorityFeePerGas.toString(),
    maxFeePerGas: request.maxFeePerGas.toString(),
    observedAt: request.nowSeconds.toString(),
  };
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    fail("RPC_URL_INVALID", "RPC URL is invalid");
  }
}

function isExactLoopbackRoot(url: URL): boolean {
  return url.protocol === "http:"
    && url.hostname === "127.0.0.1"
    && url.port.length > 0
    && url.username.length === 0
    && url.password.length === 0
    && url.pathname === "/"
    && url.search.length === 0
    && url.hash.length === 0;
}

function requestRpc(
  expectedUrl: string,
  request: { readonly id: number; readonly method: RpcMethod; readonly params: readonly unknown[] },
): Promise<Response> {
  return fetch(expectedUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", ...request }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
}

function validateResponse(response: Response, expectedUrl: string): void {
  if ((response.status >= 300 && response.status < 400) || response.redirected) {
    fail("RPC_REDIRECT_FORBIDDEN", "RPC redirect is forbidden");
  }
  if (response.url !== expectedUrl) {
    fail("RPC_FINAL_URL_MISMATCH", "RPC final URL changed");
  }
  if (!response.ok) {
    fail("RPC_HTTP_FAILURE", `local RPC returned HTTP ${response.status}`);
  }
}

function readResult(body: unknown, id: number, method: RpcMethod): unknown {
  if (
    !isObject(body)
    || body.jsonrpc !== "2.0"
    || body.id !== id
    || !("result" in body)
    || body.error !== undefined
  ) {
    fail("RPC_RESPONSE_INVALID", `invalid response to ${method}`);
  }
  return body.result;
}

function readFeeHistory(value: unknown): {
  readonly newest: bigint;
  readonly baseFee: bigint;
  readonly nextBaseFee: bigint;
} {
  if (!isObject(value) || !Array.isArray(value.baseFeePerGas) || value.baseFeePerGas.length !== 2) {
    fail("FEE_HISTORY_INVALID", "fee history is malformed");
  }
  return {
    newest: quantity(value.oldestBlock, "oldestBlock"),
    baseFee: quantity(value.baseFeePerGas[0], "baseFeePerGas"),
    nextBaseFee: quantity(value.baseFeePerGas[1], "nextBaseFeePerGas"),
  };
}

function readBlock(value: unknown, name: string): RpcBlock {
  if (
    !isObject(value)
    || typeof value.number !== "string"
    || typeof value.hash !== "string"
    || !/^0x[0-9a-f]{64}$/u.test(value.hash)
  ) {
    fail("BLOCK_INVALID", `${name} is malformed`);
  }
  return {
    number: quantity(value.number, "block number"),
    numberHex: value.number,
    hash: value.hash as `0x${string}`,
    timestamp: quantity(value.timestamp, "timestamp"),
    gasLimit: quantity(value.gasLimit, "gasLimit"),
    baseFeePerGas: quantity(value.baseFeePerGas, "baseFeePerGas"),
  };
}

function quantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) {
    fail("RPC_QUANTITY_INVALID", `${field} is not a canonical RPC quantity`);
  }
  return BigInt(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
