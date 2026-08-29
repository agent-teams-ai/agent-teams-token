import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLocalRpc } from "../src/adapters/rpc.ts";

test("only exact IPv4 loopback HTTP root URLs are accepted", () => {
  for (const value of ["https://127.0.0.1:8545/", "http://localhost:8545/", "http://127.0.0.1:8545/path", "http://user@127.0.0.1:8545/"]) assert.throws(() => createLocalRpc(value), /only/u);
});
test("fixed method allowlist rejects before transport", async () => {
  let calls = 0; const server = createServer((_request, response) => { calls += 1; response.end("{}"); }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address === "object");
  try { const rpc = createLocalRpc(`http://127.0.0.1:${address.port}/`); await assert.rejects(rpc.request("eth_accounts" as never, []), /allowlist/u); assert.equal(calls, 0); } finally { server.close(); }
});
test("redirect is rejected and never followed", async () => {
  let targetCalls = 0; const target = createServer((_request, response) => { targetCalls += 1; response.end("{}"); }); await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve)); const targetAddress = target.address(); assert(targetAddress && typeof targetAddress === "object");
  const redirect = createServer((_request, response) => { response.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/` }); response.end(); }); await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve)); const address = redirect.address(); assert(address && typeof address === "object");
  try { await assert.rejects(createLocalRpc(`http://127.0.0.1:${address.port}/`).request("eth_chainId", []), /redirect/u); assert.equal(targetCalls, 0); } finally { redirect.close(); target.close(); }
});
test("a changed final response URL is rejected", async () => {
  const original = globalThis.fetch; globalThis.fetch = async () => { const response = new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x7a69" }), { status: 200 }); Object.defineProperty(response, "url", { value: "http://127.0.0.1:9999/" }); return response; };
  try { await assert.rejects(createLocalRpc("http://127.0.0.1:8545/").request("eth_chainId", []), /final URL/u); } finally { globalThis.fetch = original; }
});
