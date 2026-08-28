import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import { bootstrapRpcRequest, createRpcClient } from "../rpc.ts";

const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  })));
  servers.clear();
});

test("runner bootstrap and verifier RPC reject redirects without requesting the second loopback endpoint", async () => {
  let redirectRequests = 0;
  let targetRequests = 0;
  const target = await listen(createServer((_request, response) => {
    targetRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"jsonrpc":"2.0","id":1,"result":"0x7a69"}');
  }));
  const redirect = await listen(createServer((_request, response) => {
    redirectRequests += 1;
    response.writeHead(307, { location: target });
    response.end();
  }));

  await assert.rejects(bootstrapRpcRequest(redirect, "eth_chainId", []), hasCode("LOCAL_EVM_RPC_REDIRECT_FORBIDDEN"));
  await assert.rejects(createRpcClient(redirect).request("eth_chainId"), hasCode("VERIFY_RPC_REDIRECT_FORBIDDEN"));
  assert.equal(redirectRequests, 2);
  assert.equal(targetRequests, 0);
});

test("runner bootstrap and verifier RPC reject a changed final response URL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const response = new Response('{"jsonrpc":"2.0","id":1,"result":"0x7a69"}', { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: `${String(input)}changed`, configurable: true });
    return response;
  };
  try {
    await assert.rejects(bootstrapRpcRequest("http://127.0.0.1:8545/", "eth_chainId", []), hasCode("LOCAL_EVM_RPC_FINAL_URL_MISMATCH"));
    await assert.rejects(createRpcClient("http://127.0.0.1:8545/").request("eth_chainId"), hasCode("VERIFY_RPC_FINAL_URL_MISMATCH"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function listen(server: Server): Promise<string> {
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/`;
}

function hasCode(code: string): (cause: unknown) => boolean {
  return (cause) => cause instanceof Error && "code" in cause && cause.code === code;
}
