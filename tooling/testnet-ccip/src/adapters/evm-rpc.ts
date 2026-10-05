import type { Observation, ObservedTransaction, ReceiptEvidence } from "../application/evm-journal.ts";
import type { EvmRpcDiagnostic, EvmRpcDiagnostics } from "../application/evm-rpc-diagnostic.ts";
import { readTestRpcJson } from "./test-rpc.ts";

const phrases = {
  transport: "RPC transport failed", http: "RPC HTTP response unavailable",
  json: "RPC response decoding failed", jsonrpc: "RPC error response received",
  envelope: "RPC response envelope invalid", evidence: "RPC evidence invalid",
} as const;
type RpcObject = Record<string, unknown>;
const invalid = (): never => { throw new Error("Invalid Sepolia RPC evidence"); };
function object(value: unknown): RpcObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) { return invalid(); }
  return value as RpcObject;
}
function hex(value: unknown, bytes?: number): string {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
    (bytes !== undefined && value.length !== 2 + bytes * 2)) { return invalid(); }
  return value.toLowerCase();
}
function quantity(value: unknown): string {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) { return invalid(); }
  const result = BigInt(value);
  if (result >= 1n << 256n) { return invalid(); }
  return result.toString();
}
function transaction(raw: unknown, expectedHash: string, expectedChain: string): ObservedTransaction {
  const tx = object(raw);
  const hash = hex(tx.hash, 32);
  const chainId = quantity(tx.chainId);
  if (hash !== expectedHash || chainId !== expectedChain) { return invalid(); }
  const data = hex(tx.input ?? tx.data);
  if (tx.input !== undefined && tx.data !== undefined && hex(tx.data) !== data) { return invalid(); }
  return { hash, chainId, from: hex(tx.from, 20), to: tx.to === null ? null : hex(tx.to, 20),
    data, value: quantity(tx.value), nonce: quantity(tx.nonce) };
}
function receipt(raw: unknown, expectedHash: string): ReceiptEvidence {
  const value = object(raw);
  const transactionHash = hex(value.transactionHash, 32);
  const status = quantity(value.status);
  if (transactionHash !== expectedHash || (status !== "0" && status !== "1")) { return invalid(); }
  return { transactionHash, blockHash: hex(value.blockHash, 32),
    blockNumber: quantity(value.blockNumber), status: status === "1" ? 1 : 0 };
}
function block(raw: unknown): { hash: string; number: string } {
  const value = object(raw);
  return { hash: hex(value.hash, 32), number: quantity(value.number) };
}
function sameReceipt(left: ReceiptEvidence, right: ReceiptEvidence): boolean {
  return left.transactionHash === right.transactionHash && left.blockHash === right.blockHash &&
    left.blockNumber === right.blockNumber && left.status === right.status;
}

/** One configured endpoint; absence is endpoint-local and does not authorize replacing a transaction. */
export function createSepoliaRpc(endpoint: string, fetcher: typeof fetch = globalThis.fetch): EvmRpcDiagnostics & {
  observe(hash: string): Promise<Observation>; broadcast(bytes: string): Promise<string>;
} {
  return createEvmRpc(endpoint, "11155111", fetcher);
}

/** Isolated local profile. Anvil observations are always labelled chain 31337. */
export function createLocalCustodyRpc(endpoint: string, fetcher: typeof fetch = globalThis.fetch): {
  observe(hash: string): Promise<Observation>; broadcast(bytes: string): Promise<string>;
} {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) { throw new Error("Local custody RPC requires loopback"); }
  return createEvmRpc(endpoint, "31337", fetcher);
}

function createEvmRpc(endpoint: string, chainId: "11155111" | "31337", fetcher: typeof fetch): EvmRpcDiagnostics & {
  observe(hash: string): Promise<Observation>; broadcast(bytes: string): Promise<string>;
} {
  const url = new URL(endpoint);
  if ((url.protocol !== "https:" && !(chainId === "31337" && url.protocol === "http:")) || url.username || url.password || url.hash || url.search) {
    throw new Error("Invalid Sepolia RPC endpoint");
  }
  let requestId = 0;
  let diagnostic: EvmRpcDiagnostic | undefined;
  let sourceMethod: EvmRpcDiagnostic["method"] = "eth_chainId";
  function retain(kind: EvmRpcDiagnostic["kind"], status?: number, code?: number): EvmRpcDiagnostic {
    // First fault only; construct from allowlisted scalars, never copy provider/exception objects.
    return diagnostic ??= Object.freeze({ method: sourceMethod, kind, message: phrases[kind],
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
      ...(typeof code === "number" && Number.isSafeInteger(code) ? { rpcCode: code } : {}) });
  }
  function fault(kind: EvmRpcDiagnostic["kind"], status?: number, code?: number): never {
    throw new Error(retain(kind, status, code).message);
  }
  async function rpc(method: EvmRpcDiagnostic["method"], params: readonly unknown[]): Promise<unknown> {
    sourceMethod = method;
    const id = ++requestId;
    let response: Response;
    try { response = await fetcher(url.href, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(20_000), redirect: "error",
    }); } catch { return fault("transport"); }
    if (!response.ok || response.redirected) { return fault("http", response.status); }
    let body: unknown;
    try { body = await readTestRpcJson(response); } catch { return fault("json", response.status); }
    if (body === null || typeof body !== "object" || Array.isArray(body)) { return fault("envelope", response.status); }
    const payload = body as RpcObject;
    if (payload.jsonrpc !== "2.0" || payload.id !== id) { return fault("envelope", response.status); }
    if ("error" in payload) {
      const error = payload.error;
      if (!("result" in payload) && error !== null && typeof error === "object" && !Array.isArray(error)) {
        const { code, message } = error as RpcObject;
        if (typeof code === "number" && Number.isSafeInteger(code) && typeof message === "string") {
          return fault("jsonrpc", response.status, code);
        }
      }
      return fault("envelope", response.status);
    }
    if (!("result" in payload)) { return fault("envelope", response.status); }
    return payload.result;
  }
  async function checkChain(): Promise<void> {
    if (quantity(await rpc("eth_chainId", [])) !== chainId) { return invalid(); }
  }
  async function canonical(number: string): Promise<{ hash: string; number: string }> {
    const result = block(await rpc("eth_getBlockByNumber", ["0x" + BigInt(number).toString(16), false]));
    if (result.number !== number) { return invalid(); }
    return result;
  }
  async function absent(hash: string): Promise<Observation> {
    const again = await rpc("eth_getTransactionByHash", [hash]);
    const receiptAgain = await rpc("eth_getTransactionReceipt", [hash]);
    await checkChain();
    return { kind: again === null && receiptAgain === null ? "not-found" : "unknown" };
  }
  async function observe(hashInput: string): Promise<Observation> {
    try {
      const hash = hex(hashInput, 32);
      await checkChain();
      const rawTx = await rpc("eth_getTransactionByHash", [hash]);
      const rawReceipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (rawTx === null) {
        return rawReceipt === null ? await absent(hash) : { kind: "unknown" };
      }
      // Deferred evidence validation belongs to its source RPC, regardless of later reads.
      sourceMethod = "eth_getTransactionByHash";
      const tx = transaction(rawTx, hash, chainId);
      if (rawReceipt === null) { await checkChain(); return { kind: "observed", transaction: tx }; }
      sourceMethod = "eth_getTransactionReceipt";
      const evidence = receipt(rawReceipt, hash);
      sourceMethod = "eth_getTransactionByHash";
      const minedTx = object(rawTx);
      if (hex(minedTx.blockHash, 32) !== evidence.blockHash || quantity(minedTx.blockNumber) !== evidence.blockNumber) {
        return { kind: "unknown" };
      }
      const head = block(await rpc("eth_getBlockByNumber", ["finalized", false]));
      if (BigInt(evidence.blockNumber) > BigInt(head.number)) {
        await checkChain(); return { kind: "observed", transaction: tx, receipt: evidence };
      }
      const receiptBlock = await canonical(evidence.blockNumber);
      if (receiptBlock.hash !== evidence.blockHash) { return { kind: "unknown" }; }
      // Re-read the same receipt and its canonical block after the first finality observation.
      const again = receipt(await rpc("eth_getTransactionReceipt", [hash]), hash);
      const blockAgain = await canonical(evidence.blockNumber);
      const headAgain = block(await rpc("eth_getBlockByNumber", ["finalized", false]));
      await checkChain();
      if (!sameReceipt(evidence, again) || blockAgain.hash !== evidence.blockHash ||
        BigInt(headAgain.number) < BigInt(head.number) ||
        (headAgain.number === head.number && headAgain.hash !== head.hash)) { return { kind: "unknown" }; }
      return { kind: "observed", transaction: tx, receipt: evidence, finalizedBlock: receiptBlock };
    } catch { retain("evidence"); return { kind: "unknown" }; }
  }
  async function broadcast(bytes: string): Promise<string> {
    try {
      const raw = hex(bytes);
      if (raw === "0x") { return invalid(); }
      await checkChain();
      // No retry. Transport failure or malformed response remains uncertain to the journal.
      return hex(await rpc("eth_sendRawTransaction", [raw]), 32);
    } catch { return fault("evidence"); }
  }
  return { observe, broadcast, diagnostic: () => diagnostic };
}
