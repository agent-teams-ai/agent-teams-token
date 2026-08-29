import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import test from "node:test";
import { JsonRpcAdapter } from "../src/adapters/rpc.ts";
import { parseFinalizedTransaction } from "../src/adapters/rpc-parsers.ts";
import { ASSOCIATED_TOKEN_PROGRAM, CLASSIC_TOKEN_PROGRAM } from "../src/domain/model.ts";

const payer = "1".repeat(32); const mint = "2".repeat(32); const ata = "3".repeat(32);
async function listen(handler: RequestListener): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer(handler); await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (typeof address === "string" || address === null) { throw new Error("test server missing port"); }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}
async function close(server: Server): Promise<void> { await new Promise<void>((resolve, reject) => { server.close((cause) => { if (cause) { reject(cause); } else { resolve(); } }); }); }

test("RPC adapter derives finalized Token semantics without a caller label", async () => {
  const signature = "4".repeat(64);
  const fixture = await listen((request, response) => {
    let body = ""; request.setEncoding("utf8"); request.on("data", (chunk) => { body += chunk; }); request.on("end", () => {
      const call = JSON.parse(body); let result: unknown;
      if (call.method === "getSignatureStatuses") { result = { value: [{ confirmationStatus: "finalized", err: null }] }; }
      else if (call.method === "getGenesisHash") { result = payer; }
      else if (call.method === "getTransaction") { result = { slot: 42, blockTime: 1, meta: { err: null, innerInstructions: [] }, transaction: { message: { accountKeys: [{ pubkey: payer, signer: true, writable: true }, { pubkey: mint, signer: true, writable: false }, { pubkey: ata, signer: false, writable: true }], instructions: [{ programId: CLASSIC_TOKEN_PROGRAM, parsed: { type: "mintTo", info: { mint, account: ata, mintAuthority: mint, amount: "1000000000000" } } }] } } }; }
      else { result = null; }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
  });
  try {
    const fact = await new JsonRpcAdapter().finalizedTransaction(fixture.url, signature);
    assert.equal(fact.operation, "mint"); assert.equal(fact.slot, "42"); assert.equal(fact.instructions[0]?.amountBaseUnits, "1000000000000"); assert.deepEqual(fact.signers, [payer, mint]);
  } finally { await close(fixture.server); }
});

test("RPC parser rejects unrelated Token instructions and malformed failure indices", async () => {
  const signature = "4".repeat(64);
  for (const transaction of [
    { slot: 1, meta: { err: null, innerInstructions: [] }, transaction: { message: { accountKeys: [], instructions: [{ programId: CLASSIC_TOKEN_PROGRAM, parsed: { type: "transfer", info: { amount: "1" } } }] } } },
    { slot: 1, meta: { err: { InstructionError: [] }, innerInstructions: [] }, transaction: { message: { accountKeys: [], instructions: [{ programId: CLASSIC_TOKEN_PROGRAM, parsed: { type: "freezeAccount", info: { account: ata, mint, authority: mint } } }] } } },
  ]) {
    const fixture = await listen((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { const call = JSON.parse(body); const result = call.method === "getSignatureStatuses" ? { value: [{ confirmationStatus: "finalized" }] } : call.method === "getGenesisHash" ? payer : transaction; response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result })); }); });
    try { await assert.rejects(new JsonRpcAdapter().finalizedTransaction(fixture.url, signature), /SOLANA_TRANSACTION_/u); } finally { await close(fixture.server); }
  }
});

test("RPC transport rejects redirects and non-loopback targets", async () => {
  const fixture = await listen((_request, response) => { response.writeHead(302, { location: "http://example.com/" }); response.end(); });
  try { await assert.rejects(new JsonRpcAdapter().genesisHash(fixture.url)); await assert.rejects(new JsonRpcAdapter().genesisHash("http://localhost:8899/"), /SOLANA_RPC_NON_LOOPBACK/u); }
  finally { await close(fixture.server); }
});

test("RPC readiness proves pinned local programs at a finalized post-genesis slot", async () => {
  const fixture = await listen((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { const call = JSON.parse(body); const result = call.method === "getSlot" ? 2 : { value: { executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111", data: ["", "base64"] } }; response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result })); }); });
  try { await new JsonRpcAdapter().waitProgramsReady(fixture.url, [CLASSIC_TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM], 1_000, new AbortController().signal); }
  finally { await close(fixture.server); }
});

test("RPC delivers negative transactions with a fresh hash and bounded retries", async () => {
  const signature = "4".repeat(64); const calls: Array<{ readonly method: string; readonly params: readonly unknown[] }> = [];
  const fixture = await listen((request, response) => {
    let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => {
      const call = JSON.parse(body) as { readonly id: number; readonly method: string; readonly params: readonly unknown[] }; calls.push(call);
      const result = call.method === "getLatestBlockhash" ? { value: { blockhash: payer, lastValidBlockHeight: 100 } }
        : call.method === "sendTransaction" ? signature : { value: [{ confirmationStatus: "finalized", err: { InstructionError: [0, { Custom: 4 }] } }] };
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
  });
  try {
    const rpc = new JsonRpcAdapter();
    assert.equal(await rpc.latestBlockhash(fixture.url), payer);
    assert.equal(await rpc.sendSignedTransaction(fixture.url, Uint8Array.from([1, 2, 3])), signature);
    assert.deepEqual(calls.find((call) => call.method === "getLatestBlockhash")?.params, [{ commitment: "processed" }]);
    const send = calls.find((call) => call.method === "sendTransaction");
    assert.deepEqual(send?.params[1], { encoding: "base64", skipPreflight: true, preflightCommitment: "processed", maxRetries: 5 });
    assert.equal(calls.some((call) => call.method === "getSignatureStatuses"), true);
  } finally { await close(fixture.server); }
});

test("RPC structured account reads reject forged Token-2022 ownership", async () => {
  const fixture = await listen((request, response) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => { const call = JSON.parse(body); response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { value: { owner: "Token2022", data: { parsed: { type: "mint", info: { decimals: 9, supply: "0", mintAuthority: "x", freezeAuthority: null } } } } } })); }); });
  try { await assert.rejects(new JsonRpcAdapter().mintAccount(fixture.url, "mint"), /SOLANA_MINT_PROGRAM/u); }
  finally { await close(fixture.server); }
});

test("RPC parser normalizes exact authority and associated-account semantics", () => {
  const transaction = (programId: string, type: string, info: Record<string, unknown>, err: unknown = null) => ({
    slot: 42,
    meta: { err, innerInstructions: [] },
    transaction: {
      message: {
        accountKeys: [{ pubkey: payer, signer: true, writable: true }, { pubkey: mint, signer: true, writable: true }],
        instructions: [{ programId, parsed: { type, info } }],
      },
    },
  });
  const revoke = parseFinalizedTransaction(transaction(CLASSIC_TOKEN_PROGRAM, "setAuthority", {
    authority: mint, authorityType: "freezeAccount", mint, newAuthority: null,
  }), "4".repeat(64), payer);
  assert.equal(revoke.operation, "revokeFreeze");
  assert.deepEqual(revoke.instructions[0], {
    programId: CLASSIC_TOKEN_PROGRAM, instructionIndex: 0, innerInstructionIndex: null, kind: "setAuthority",
    accounts: [mint], mint, tokenAccount: mint, owner: null, authority: mint, newAuthority: null,
    authorityType: "freezeAccount", amountBaseUnits: null, decimals: null,
  });

  const created = parseFinalizedTransaction(transaction(ASSOCIATED_TOKEN_PROGRAM, "create", {
    source: payer, account: ata, wallet: ownerAddress(), mint, tokenProgram: CLASSIC_TOKEN_PROGRAM,
  }), "5".repeat(64), payer);
  const associated = created.instructions[0]!;
  assert.equal(created.operation, "createAta");
  assert.equal(associated.authority, payer); assert.equal(associated.tokenAccount, ata);
  assert.equal(associated.owner, ownerAddress()); assert.equal(associated.mint, mint);
  assert.equal(associated.accounts.includes(CLASSIC_TOKEN_PROGRAM), true);

  const frozen = parseFinalizedTransaction(transaction(CLASSIC_TOKEN_PROGRAM, "freezeAccount", {
    account: ata, mint, freezeAuthority: mint,
  }, { InstructionError: [0, { Custom: 16 }] }), "6".repeat(64), payer);
  assert.equal(frozen.operation, "freezeAttempt");
  assert.equal(frozen.error?.code, "Custom(16)");
  assert.equal(frozen.instructions[0]?.authority, mint); assert.equal(frozen.instructions[0]?.newAuthority, null);
});

function ownerAddress(): string { return "7".repeat(32); }
