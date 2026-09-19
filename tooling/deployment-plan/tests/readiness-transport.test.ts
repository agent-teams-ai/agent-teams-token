import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createReadinessEvmRpc } from "../src/adapters/readiness-evm.ts";
import { createReadinessSolanaRpc } from "../src/adapters/readiness-solana.ts";

const genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
function provider(result: (method: string) => unknown): { fetcher: typeof fetch; methods: string[] } {
  const methods: string[] = [];
  const fetcher = (async (_url, options) => {
    const request = JSON.parse(String(options?.body)); methods.push(request.method);
    assert.equal(options?.redirect, "error");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: result(request.method) }));
  }) as typeof fetch;
  return { fetcher, methods };
}
test("offline readiness makes zero requests, and arbitrary submission/signing methods fail before chain reads", async () => {
  const p = provider(() => { throw new Error("network must not be touched"); });
  const evm = createReadinessEvmRpc("https://example.invalid", "offline", p.fetcher);
  const sol = createReadinessSolanaRpc("https://example.invalid", genesis, "offline", p.fetcher);
  await assert.rejects(evm.request("eth_call", []), /OFFLINE_NETWORK_FORBIDDEN/);
  await assert.rejects(sol.request("getAccountInfo", []), /OFFLINE_NETWORK_FORBIDDEN/);
  for (const method of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "personal_unlockAccount", "wallet_sendCalls", "anvil_setBalance", "sendTransaction", "sendRawTransaction", "requestAirdrop", "constructor", "toString"]) {
    await assert.rejects(evm.request(method, []), /METHOD_FORBIDDEN/);
    await assert.rejects(sol.request(method, []), /METHOD_FORBIDDEN/);
  }
  assert.deepEqual(p.methods, []);
  assert.deepEqual(Object.keys(evm).toSorted(), ["broadcastAllowed", "request"]);
  assert.equal(evm.broadcastAllowed, false);
});
test("observation rechecks mainnet chain identity and cannot submit on successful or failing RPC paths", async () => {
  const p = provider(method => method === "eth_chainId" ? "0x1" : "0x12");
  const evm = createReadinessEvmRpc("https://example.invalid", "observe", p.fetcher);
  assert.equal(await evm.request("eth_estimateGas", [{ data: "0x00" }]), "0x12");
  await assert.rejects(evm.request("eth_sendRawTransaction", ["private-bytes"]), /METHOD_FORBIDDEN/);
  assert.deepEqual(p.methods, ["eth_chainId", "eth_estimateGas"]);
  const wrong = provider(() => "0xaa36a7");
  await assert.rejects(createReadinessEvmRpc("https://example.invalid", "observe", wrong.fetcher).request("eth_getCode", []), /CHAIN_MISMATCH/);
  assert.deepEqual(wrong.methods, ["eth_chainId"]);
  const sol = provider(() => "wrong-genesis");
  await assert.rejects(createReadinessSolanaRpc("https://example.invalid", genesis, "observe", sol.fetcher).request("getTokenSupply", []), /GENESIS_MISMATCH/);
});
test("Solana simulations require zeroed signature slots and explicit finalized unsigned options", async () => {
  const p = provider(method => method === "getGenesisHash" ? genesis : { value: { err: null, unitsConsumed: 1 } });
  const sol = createReadinessSolanaRpc("https://example.invalid", genesis, "observe", p.fetcher);
  const tx = Buffer.alloc(70); tx[0] = 1;
  const options = { sigVerify: false, encoding: "base64", commitment: "finalized", replaceRecentBlockhash: true };
  await sol.request("simulateTransaction", [tx.toString("base64"), options]);
  tx[1] = 1;
  await assert.rejects(sol.request("simulateTransaction", [tx.toString("base64"), options]), /UNSIGNED_SIMULATION_REQUIRED/);
  tx[1] = 0;
  await assert.rejects(sol.request("simulateTransaction", [tx.toString("base64"), { ...options, sigVerify: true }]), /UNSIGNED_SIMULATION_REQUIRED/);
  assert.deepEqual(p.methods, ["getGenesisHash", "simulateTransaction"]);
});
test("a malicious redirect cannot move even a read request to another endpoint", async context => {
  let targetRequests = 0, redirectRequests = 0;
  const target = createServer((_req, res) => { targetRequests++; res.end("{}"); });
  await new Promise<void>(resolve => { target.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise<void>((resolve, reject) => { target.close(e => e ? reject(e) : resolve()); }));
  const targetPort = (target.address() as { port: number }).port;
  const redirect = createServer((_req, res) => { redirectRequests++; res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/private` }); res.end(); });
  await new Promise<void>(resolve => { redirect.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise<void>((resolve, reject) => { redirect.close(e => e ? reject(e) : resolve()); }));
  const rpc = createReadinessEvmRpc(`http://127.0.0.1:${(redirect.address() as { port: number }).port}`, "observe");
  await assert.rejects(rpc.request("eth_getBalance", []), /RPC_UNAVAILABLE/);
  assert.equal(redirectRequests, 1, "the origin must actually serve a redirect; a sandbox network rejection does not qualify this test");
  assert.equal(targetRequests, 0);
});
