import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import test from "node:test";
import { JsonRpcAdapter } from "../src/adapters/rpc.ts";
import { CLASSIC_TOKEN_PROGRAM } from "../src/domain/model.ts";

async function listen(handler: RequestListener): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer(handler); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (typeof address === "string" || address === null) { throw new Error("test server missing port"); }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve())); }

test("RPC adapter independently decodes finalized Token Program facts", async () => {
  const signature = "2".repeat(64);
  const fixture = await listen((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; }); request.on("end", () => {
      const call = JSON.parse(body); let result: unknown;
      if (call.method === "getSignatureStatuses") { result = { value: [{ confirmationStatus: "finalized", err: null }] }; }
      else if (call.method === "getTransaction") { result = { slot: 42, blockTime: 1, meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ programId: CLASSIC_TOKEN_PROGRAM, parsed: { type: "mintTo", info: { amount: "1000000000000" } } }] } } }; }
      else { result = null; }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
  });
  try {
    const fact = await new JsonRpcAdapter().finalizedTransaction(fixture.url, "mint", signature, "genesis");
    assert.equal(fact.slot, "42"); assert.equal(fact.amountBaseUnits, "1000000000000"); assert.deepEqual(fact.programIds, [CLASSIC_TOKEN_PROGRAM]);
  } finally { await close(fixture.server); }
});

test("RPC transport rejects redirects and non-loopback targets", async () => {
  const fixture = await listen((_request, response) => { response.writeHead(302, { location: "http://example.com/" }); response.end(); });
  try {
    await assert.rejects(new JsonRpcAdapter().genesisHash(fixture.url));
    await assert.rejects(new JsonRpcAdapter().genesisHash("http://localhost:8899/"), /SOLANA_RPC_NON_LOOPBACK/u);
  } finally { await close(fixture.server); }
});

test("RPC structured account reads reject forged Token-2022 ownership", async () => {
  const fixture = await listen((request, response) => {
    let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => {
      const call = JSON.parse(body); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { value: { owner: "Token2022", data: { parsed: { type: "mint", info: { decimals: 9, supply: "0", mintAuthority: "x", freezeAuthority: null } } } } } }));
    });
  });
  try { await assert.rejects(new JsonRpcAdapter().mintAccount(fixture.url, "mint"), /SOLANA_MINT_PROGRAM/u); }
  finally { await close(fixture.server); }
});
