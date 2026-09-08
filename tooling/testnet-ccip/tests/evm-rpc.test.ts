import assert from "node:assert/strict";
import test from "node:test";
import { createSepoliaRpc } from "../src/adapters/evm-rpc.ts";

const hash = "0x" + "11".repeat(32);
const blockHash = "0x" + "22".repeat(32);
const otherHash = "0x" + "33".repeat(32);
const tx = { hash, chainId: "0xaa36a7", from: "0x" + "ab".repeat(20), to: "0x" + "cd".repeat(20),
  input: "0x12345678", value: "0x10000000000000001", nonce: "0x4", blockHash, blockNumber: "0x63" };
const receipt = { transactionHash: hash, blockHash, blockNumber: "0x63", status: "0x1" };
type Call = { method: string; params: unknown[]; id: number };
function setup(override?: (call: Call, count: number) => unknown) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetcher: typeof fetch = async (_input, init) => {
    const call = JSON.parse(init!.body as string) as Call; calls.push(call);
    const count = (counts.get(call.method) ?? 0) + 1; counts.set(call.method, count);
    let result = override?.(call, count);
    if (result === undefined) {
      switch (call.method) {
        case "eth_chainId": result = "0xaa36a7"; break;
        case "eth_getTransactionByHash": result = tx; break;
        case "eth_getTransactionReceipt": result = receipt; break;
        case "eth_getBlockByNumber": result = call.params[0] === "finalized"
          ? { number: "0x64", hash: otherHash } : { number: "0x63", hash: blockHash }; break;
        case "eth_sendRawTransaction": result = hash; break;
        default: throw new Error("Unexpected method");
      }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }), { status: 200 });
  };
  return { rpc: createSepoliaRpc("https://test.invalid/rpc", fetcher), calls, fetcher };
}
test("finalized evidence normalizes quantities and rechecks canonical receipt block", async () => {
  const { rpc, calls } = setup(); const result = await rpc.observe(hash);
  assert.equal(result.kind, "observed");
  if (result.kind !== "observed") { assert.fail(); }
  assert.equal(result.transaction.value, "18446744073709551617");
  assert.equal(result.transaction.nonce, "4");
  assert.deepEqual(result.finalizedBlock, { hash: blockHash, number: "99" });
  assert.equal(calls.filter(c => c.method === "eth_getTransactionReceipt").length, 2);
  assert.equal(calls.filter(c => c.method === "eth_chainId").length, 2);
});
test("reverted receipt has strict status0, never successful substitution", async () => {
  const { rpc } = setup(c => c.method === "eth_getTransactionReceipt" ? { ...receipt, status: "0x0" } : undefined);
  const result = await rpc.observe(hash);
  assert.equal(result.kind === "observed" && result.receipt?.status, 0);
});
test("pending tx or receipt newer than finality lacks finalized evidence", async () => {
  for (const mode of ["pending", "newer"]) {
    const { rpc } = setup(c => {
      if (mode === "pending" && c.method === "eth_getTransactionReceipt") { return null; }
      if (mode === "newer" && c.method === "eth_getBlockByNumber") { return { number: "0x62", hash: otherHash }; }
      return;
    });
    const result = await rpc.observe(hash);
    assert.equal(result.kind, "observed");
    assert.equal(result.kind === "observed" && result.finalizedBlock, undefined);
  }
});
test("only double valid null tx+receipt reads yield endpoint-local notfound", async () => {
  const { rpc, calls } = setup(c => c.method.startsWith("eth_getTransaction") ? null : undefined);
  assert.deepEqual(await rpc.observe(hash), { kind: "not-found" });
  assert.equal(calls.length, 6);
  const orphan = setup(c => c.method === "eth_getTransactionByHash" ? null : undefined);
  assert.deepEqual(await orphan.rpc.observe(hash), { kind: "unknown" });
  const appeared = setup((c, count) => c.method.startsWith("eth_getTransaction") && count === 1 ? null : undefined);
  assert.deepEqual(await appeared.rpc.observe(hash), { kind: "unknown" });
});
test("wrong chain, invalid status/quantity, tx hash and receipt hash mismatch fail closed", async () => {
  const overrides = [
    (c: Call) => c.method === "eth_chainId" ? "0x1" : undefined,
    (c: Call) => c.method === "eth_getTransactionReceipt" ? { ...receipt, status: "0x2" } : undefined,
    (c: Call) => c.method === "eth_getTransactionReceipt" ? { ...receipt, transactionHash: otherHash } : undefined,
    (c: Call) => c.method === "eth_getTransactionByHash" ? { ...tx, nonce: "0x04" } : undefined,
    (c: Call) => c.method === "eth_getTransactionByHash" ? { ...tx, hash: otherHash } : undefined,
    (c: Call) => c.method === "eth_getTransactionByHash" ? { ...tx, data: "0xabcd" } : undefined,
  ];
  for (const override of overrides) { assert.deepEqual(await setup(override).rpc.observe(hash), { kind: "unknown" }); }
});
test("receipt/block reorg and disappearing finality cannot settle", async () => {
  for (const mode of ["receipt", "canonical", "finalized", "chain-switch"]) {
    const { rpc } = setup((c, count) => {
      if (mode === "receipt" && c.method === "eth_getTransactionReceipt" && count === 2) { return { ...receipt, blockHash: otherHash }; }
      if (mode === "canonical" && c.method === "eth_getBlockByNumber" && count === 3) { return { number: "0x63", hash: otherHash }; }
      if (mode === "finalized" && c.method === "eth_getBlockByNumber" && count === 4) { return { number: "0x62", hash: otherHash }; }
      if (mode === "chain-switch" && c.method === "eth_chainId" && count === 2) { return "0x1"; }
      return;
    });
    assert.deepEqual(await rpc.observe(hash), { kind: "unknown" });
  }
});
test("HTTP, JSON-RPC error, bad ids and thrown fetch never mean notfound", async () => {
  for (const fetcher of [
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } })),
    async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: null })),
    async () => { throw new Error("timeout"); },
  ]) { assert.deepEqual(await createSepoliaRpc("https://test.invalid", fetcher).observe(hash), { kind: "unknown" }); }
});
test("broadcast checks chain and sends once without retries", async () => {
  const { rpc, calls } = setup(); assert.equal(await rpc.broadcast("0xaabb"), hash);
  assert.deepEqual(calls.map(c => c.method), ["eth_chainId", "eth_sendRawTransaction"]);
  const wrong = setup(c => c.method === "eth_chainId" ? "0x1" : undefined);
  await assert.rejects(wrong.rpc.broadcast("0xaabb")); assert.equal(wrong.calls.length, 1);
  const malformed = setup(c => c.method === "eth_sendRawTransaction" ? null : undefined);
  await assert.rejects(malformed.rpc.broadcast("0xaabb")); assert.equal(malformed.calls.length, 2);
});
