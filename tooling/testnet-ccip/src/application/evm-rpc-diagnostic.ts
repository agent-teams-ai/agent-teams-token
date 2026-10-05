/** Execution-local public metadata; never persisted as transaction evidence. */
export interface EvmRpcDiagnostic {
  readonly method: "eth_chainId" | "eth_getTransactionByHash" | "eth_getTransactionReceipt" |
    "eth_getBlockByNumber" | "eth_sendRawTransaction";
  readonly kind: "transport" | "http" | "json" | "jsonrpc" | "envelope" | "evidence";
  readonly httpStatus?: number;
  readonly rpcCode?: number;
  readonly message: "RPC transport failed" | "RPC HTTP response unavailable" |
    "RPC response decoding failed" | "RPC error response received" |
    "RPC response envelope invalid" | "RPC evidence invalid";
}
export interface EvmRpcDiagnostics {
  diagnostic(): EvmRpcDiagnostic | undefined;
}
