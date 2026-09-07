import assert from "node:assert/strict";
import { test } from "node:test";
import { createSolanaMintRpc } from "../src/adapters/solana-rpc.ts";
import type { SolanaMintEnvelope } from "../src/domain/solana-mint.ts";
const signed = { signature: "2".repeat(88), bytesBase64: "YWJj", blockhash: "3".repeat(32), lastValidBlockHeight: "200" };
const intent = { mint: "mint", payer: "payer" } as SolanaMintEnvelope;
const tx = { slot: 100, transaction: [signed.bytesBase64, "base64"], meta: { err: null } };
const mint = { context: { slot: 101 }, value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", executable: false,
  data: { program: "spl-token", space: 82, parsed: { type: "mint", info: {
    isInitialized: true, decimals: 9, supply: "0", mintAuthority: "payer", freezeAuthority: null,
  } } } } };
function fixture(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const defaults: Record<string, unknown> = { getGenesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    getTransaction: tx, getSignatureStatuses: { value: [{ slot: 100, confirmationStatus: "finalized", err: null }] },
    getAccountInfo: mint, getBlockHeight: 100, isBlockhashValid: { value: true }, sendTransaction: signed.signature };
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); calls.push(body);
    const selected = Object.hasOwn(overrides, body.method) ? overrides[body.method] : defaults[body.method];
    const result = typeof selected === "function" ? selected(calls) : selected;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }) as typeof fetch;
  return { calls, rpc: createSolanaMintRpc(() => "bWVzc2FnZQ==", fetcher) };
}
test("finalized exact bytes and initialized mint are required; receipt rechecked", async () => {
  const { rpc, calls } = fixture(); const result = await rpc.observe(signed, intent);
  assert.equal(result.kind, "finalized");
  assert.equal(calls.filter(x => x.method === "getTransaction").length, 2);
  assert.deepEqual(calls.find(x => x.method === "getAccountInfo")?.params,
    ["mint", { encoding: "jsonParsed", commitment: "finalized", minContextSlot: 100 }]);
});
test("wrong cluster, signatures, stale context, supply and freeze never succeed", async () => {
  for (const change of [
    { getGenesisHash: "mainnet" }, { getTransaction: { ...tx, transaction: ["ZGlmZg==", "base64"] } },
    { getSignatureStatuses: { value: [{ slot: 100, confirmationStatus: "confirmed", err: null }] } },
    { getAccountInfo: { ...mint, context: { slot: 99 } } },
    ...[{ supply: "1" }, { freezeAuthority: "payer" }, { isInitialized: false }].map(info => ({ getAccountInfo: {
      ...mint, value: { ...mint.value, data: { ...mint.value.data, parsed: { ...mint.value.data.parsed,
        info: { ...mint.value.data.parsed.info, ...info } } } } } })),
  ]) { assert.equal((await fixture(change).rpc.observe(signed, intent)).kind, "unknown"); }
});
test("absence is checked twice; expired or pending signature never becomes fresh notfound", async () => {
  const absent = { getTransaction: null, getSignatureStatuses: { value: [null] } };
  assert.equal((await fixture(absent).rpc.observe(signed, intent)).kind, "not-found");
  assert.equal((await fixture({ ...absent, getBlockHeight: 201 }).rpc.observe(signed, intent)).kind, "expired");
  assert.equal((await fixture({ getTransaction: null }).rpc.observe(signed, intent)).kind, "unknown");
});
test("finalized execution error is preserved without requiring a created mint", async () => {
  const error = "InsufficientFundsForRent";
  const result = await fixture({ getTransaction: { ...tx, meta: { err: error } },
    getSignatureStatuses: { value: [{ slot: 100, confirmationStatus: "finalized", err: error }] } }).rpc.observe(signed, intent);
  assert.equal(result.kind, "finalized");
  if (result.kind === "finalized") { assert.deepEqual(result.err, { transactionError: error }); assert.equal(result.mintState, null); }
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
