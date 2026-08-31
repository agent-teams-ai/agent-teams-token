import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { LocalEvmError } from "./model.ts";

export interface RpcClient { request(method: string, params?: readonly unknown[]): Promise<unknown> }

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const VERIFY_METHODS = new Set([
  "eth_call",
  "eth_chainId",
  "eth_getCode",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
]);

interface PrivateRpcEndpoint {
  readonly port: number;
}

interface DirectRpcRequest {
  readonly identifier: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

export function assertPrivateRpcUrl(rpcUrl: string): void {
  parsePrivateRpcUrl(rpcUrl);
}

export function createRpcClient(rpcUrl: string): RpcClient {
  const endpoint = parsePrivateRpcUrl(rpcUrl);
  let identifier = 0;
  return {
    async request(method, params = []): Promise<unknown> {
      if (!VERIFY_METHODS.has(method)) {
        throw new LocalEvmError("VERIFY_RPC_METHOD_INVALID", "RPC method is not allowlisted for local verification");
      }
      const requestId = identifier += 1;
      const value = await directJsonRpc(endpoint, {identifier: requestId, method, params}, 10_000, "VERIFY");
      if (!isRecord(value) || value.id !== requestId || value.jsonrpc !== "2.0" || !("result" in value) || value.error !== undefined) {
        throw new LocalEvmError("VERIFY_RPC_RESPONSE_INVALID", `local RPC returned an invalid response for ${method}`);
      }
      return value.result;
    },
  };
}

export async function bootstrapRpcRequest(rpcUrl: string, method: string, params: readonly unknown[]): Promise<string> {
  if (method !== "eth_chainId") {
    throw new LocalEvmError("LOCAL_EVM_RPC_METHOD_INVALID", "only eth_chainId is allowed during local RPC bootstrap");
  }
  const value = await directJsonRpc(parsePrivateRpcUrl(rpcUrl), {identifier: 1, method, params}, 5_000, "LOCAL_EVM");
  if (!isRecord(value) || value.id !== 1 || value.jsonrpc !== "2.0" || typeof value.result !== "string" || value.error !== undefined) {
    throw new LocalEvmError("LOCAL_EVM_RPC_INVALID", `local RPC returned an invalid response for ${method}`);
  }
  return value.result;
}

function parsePrivateRpcUrl(rpcUrl: string): PrivateRpcEndpoint {
  const match = /^http:\/\/127[.]0[.]0[.]1:([1-9][0-9]{0,4})\/$/u.exec(rpcUrl);
  if (match === null) {
    throw new LocalEvmError("VERIFY_PUBLIC_RPC_FORBIDDEN", "only an unauthenticated http://127.0.0.1:<port>/ RPC is allowed");
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535
    || rpcUrl !== `http://127.0.0.1:${String(port)}/`) {
    throw new LocalEvmError("VERIFY_RPC_URL_INVALID", "RPC URL port is invalid");
  }
  return {port};
}

async function directJsonRpc(
  endpoint: PrivateRpcEndpoint,
  rpcRequest: DirectRpcRequest,
  timeoutMs: number,
  prefix: "VERIFY" | "LOCAL_EVM",
): Promise<unknown> {
  const {identifier, method, params} = rpcRequest;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(method) || !Array.isArray(params)) {
    throw new LocalEvmError(`${prefix}_RPC_METHOD_INVALID`, "RPC method or parameters are invalid");
  }
  let body: Buffer;
  try { body = Buffer.from(JSON.stringify({jsonrpc: "2.0", id: identifier, method, params}), "utf8"); }
  catch { throw new LocalEvmError(`${prefix}_RPC_REQUEST_INVALID`, "RPC request is not JSON serializable"); }
  if (body.byteLength > MAX_REQUEST_BYTES) {
    throw new LocalEvmError(`${prefix}_RPC_REQUEST_TOO_LARGE`, "RPC request exceeds the local transport limit");
  }

  return await new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const fail = (cause: unknown): void => {
      if (settled) {return;}
      settled = true;
      if (timer !== undefined) {clearTimeout(timer);}
      reject(cause instanceof LocalEvmError ? cause : new LocalEvmError(`${prefix}_RPC_TRANSPORT_FAILURE`, "local RPC transport failed"));
    };
    const request = httpRequest({
      protocol: "http:", hostname: "127.0.0.1", port: endpoint.port, path: "/", method: "POST",
      agent: false,
      headers: {
        accept: "application/json", "content-type": "application/json", "content-length": String(body.byteLength),
        connection: "close",
      },
    });
    timer = setTimeout(() => {
      request.destroy();
      fail(new LocalEvmError(`${prefix}_RPC_TIMEOUT`, "local RPC request timed out"));
    }, timeoutMs);
    timer.unref();
    request.once("socket", (socket: Socket) => {
      socket.once("connect", () => {
        if (socket.remoteAddress !== "127.0.0.1" || socket.remotePort !== endpoint.port) {
          request.destroy();
          fail(new LocalEvmError(`${prefix}_RPC_PEER_MISMATCH`, "local RPC socket peer differs from the requested endpoint"));
        }
      });
    });
    request.once("response", (response) => {
      void readResponse(response, prefix).then((value) => {
        if (settled) {return;}
        settled = true;
        clearTimeout(timer);
        resolve(value);
        return;
      }, fail);
    });
    request.once("error", fail);
    request.end(body);
  });
}

async function readResponse(response: IncomingMessage, prefix: "VERIFY" | "LOCAL_EVM"): Promise<unknown> {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    response.destroy();
    throw new LocalEvmError(`${prefix}_RPC_REDIRECT_FORBIDDEN`, "local RPC redirects are forbidden");
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    throw new LocalEvmError(`${prefix}_RPC_HTTP_FAILURE`, `local RPC returned HTTP ${status}`);
  }
  const declaredLength = response.headers["content-length"];
  if (declaredLength !== undefined && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
    response.destroy();
    throw new LocalEvmError(`${prefix}_RPC_RESPONSE_TOO_LARGE`, "local RPC response exceeds the transport limit");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      response.destroy();
      throw new LocalEvmError(`${prefix}_RPC_RESPONSE_TOO_LARGE`, "local RPC response exceeds the transport limit");
    }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown; }
  catch { throw new LocalEvmError(`${prefix}_RPC_RESPONSE_INVALID`, "local RPC returned invalid JSON"); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
