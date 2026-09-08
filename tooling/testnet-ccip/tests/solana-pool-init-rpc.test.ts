import assert from "node:assert/strict";
import { test } from "node:test";
import { createSolanaPoolInitRpc } from "../src/adapters/solana-pool-init-rpc.ts";
import type { SolanaPoolInitEnvelope } from "../src/domain/solana-pool-init.ts";
const signed = { signature: "2".repeat(88), bytesBase64: "YWJj", blockhash: "3".repeat(32), lastValidBlockHeight: "200" };
const intent = { pool: "pool", mint: "mint", payer: "payer" } as SolanaPoolInitEnvelope;
const tx = { slot: 100, transaction: [signed.bytesBase64, "base64"], meta: { err: null } };
const pool = { context: { slot: 101 }, value: { owner: "41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB", executable: false,
  data: ["cG9vbA==", "base64"] } };
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const defaults: Record<string, unknown> = { getGenesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    getTransaction: tx, getSignatureStatuses: { value: [{ slot: 100, confirmationStatus: "finalized", err: null }] },
    getAccountInfo: pool, getBlockHeight: 100, isBlockhashValid: { value: true }, sendTransaction: signed.signature };
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); calls.push(body);
    const selected = Object.hasOwn(overrides, body.method) ? overrides[body.method] : defaults[body.method];
    const result = typeof selected === "function" ? selected(calls) : selected;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }) as typeof fetch;
  return { calls, rpc: createSolanaPoolInitRpc(() => "bWVzc2FnZQ==", bytes => {
    assert.equal(bytes, "cG9vbA=="); return { address: "pool", mint: "mint", owner: "payer", verified: true };
  }, fetcher) };
}
test("finalized exact bytes and initialized pool are required; receipt rechecked", async () => {
  const { rpc, calls } = fixture(); const result = await rpc.observe(signed, intent);
  assert.equal(result.kind, "finalized");
  assert.equal(calls.filter(x => x.method === "getTransaction").length, 2);
  assert.deepEqual(calls.find(x => x.method === "getAccountInfo")?.params,
    ["pool", { encoding: "base64", commitment: "finalized", minContextSlot: 100 }]);
});
test("wrong cluster, signatures, stale context, owner and state bytes never succeed", async () => {
  for (const change of [
    { getGenesisHash: "mainnet" }, { getTransaction: { ...tx, transaction: ["ZGlmZg==", "base64"] } },
    { getSignatureStatuses: { value: [{ slot: 100, confirmationStatus: "confirmed", err: null }] } },
    { getAccountInfo: { ...pool, context: { slot: 99 } } },
    { getAccountInfo: { ...pool, value: { ...pool.value, owner: "wrong" } } },
    { getAccountInfo: { ...pool, value: { ...pool.value, executable: true } } },
    { getAccountInfo: { ...pool, value: { ...pool.value, data: ["YmFk", "base64"] } } },
  ]) { assert.equal((await fixture(change).rpc.observe(signed, intent)).kind, "unknown"); }
});
test("absence is checked twice; expired or pending signature never becomes fresh notfound", async () => {
  const absent = { getTransaction: null, getSignatureStatuses: { value: [null] } };
  assert.equal((await fixture(absent).rpc.observe(signed, intent)).kind, "not-found");
  assert.equal((await fixture({ ...absent, getBlockHeight: 201 }).rpc.observe(signed, intent)).kind, "expired");
  assert.equal((await fixture({ getTransaction: null }).rpc.observe(signed, intent)).kind, "unknown");
});
test("finalized execution error is preserved without requiring a created pool", async () => {
  const error = "InsufficientFundsForRent";
  const result = await fixture({ getTransaction: { ...tx, meta: { err: error } },
    getSignatureStatuses: { value: [{ slot: 100, confirmationStatus: "finalized", err: error }] } }).rpc.observe(signed, intent);
  assert.equal(result.kind, "finalized");
  if (result.kind === "finalized") { assert.deepEqual(result.err, { transactionError: error }); assert.equal(result.poolState, null); }
});
test("send uses preflight and zero retries; errors are never retried", async () => {
  const { rpc, calls } = fixture(); assert.equal(await rpc.broadcast(signed.bytesBase64), signed.signature);
  assert.deepEqual(calls.find(x => x.method === "sendTransaction")?.params,
    [signed.bytesBase64, { encoding: "base64", skipPreflight: false, preflightCommitment: "finalized", maxRetries: 0 }]);
  const bad = fixture({ sendTransaction: null }); await assert.rejects(bad.rpc.broadcast(signed.bytesBase64));
  assert.equal(bad.calls.filter(x => x.method === "sendTransaction").length, 1);
});


test("disappearing finalized transaction and transport failures remain unknown", async () => {
  const disappearing = fixture({ getTransaction: (calls: { method: string }[]) =>
    calls.filter(x => x.method === "getTransaction").length === 1 ? tx : null });
  assert.equal((await disappearing.rpc.observe(signed, intent)).kind, "unknown");
  const broken = fixture({ getSignatureStatuses: () => { throw new Error("connection reset"); } });
  assert.equal((await broken.rpc.observe(signed, intent)).kind, "unknown");
});
