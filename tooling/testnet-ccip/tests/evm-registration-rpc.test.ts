import assert from "node:assert/strict";
import { test } from "node:test";
import { readRegistrationSnapshot } from "../src/adapters/evm-registration-rpc.ts";
const target = { testOnly: true as const, token: "0x" + "1".repeat(40), pool: "0x" + "2".repeat(40), administrator: "0x" + "3".repeat(40) };
const block = { number: "0x100", hash: "0x" + "a".repeat(64) };
const word = (address: string): string => address.slice(2).padStart(64, "0");
function fixture(mode = "valid") {
  const reads: { method: string; params: unknown[] }[] = [];
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); reads.push(body);
    let result: unknown;
    if (body.method === "eth_chainId") { result = mode === "chain" ? "0x1" : "0xaa36a7"; }
    else if (body.method === "eth_getBlockByNumber") { result = mode === "reorg" && body.params[0] !== "finalized" ? { ...block, hash: "0x" + "b".repeat(64) } : block; }
    else if (body.method === "eth_getCode") { result = mode === "absent" ? "0x" : "0x1234"; }
    else {
      const data = body.params[0].data;
      result = mode === "abi" ? "0x01" : data.startsWith("0xcb67e3b1") ? "0x" + "0".repeat(192)
        : "0x" + word(data === "0x21df0da7" ? target.token : target.administrator);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }) as typeof fetch;
  return { fetcher, reads };
}
test("all contract reads use EIP1898 canonical finalized block identity", async () => {
  const f = fixture(), result = await readRegistrationSnapshot(target, f.fetcher);
  assert.equal(result.poolToken, target.token); assert.equal(result.tokenAdmin, target.administrator);
  for (const read of f.reads.filter(x => ["eth_call", "eth_getCode"].includes(x.method))) {
    assert.deepEqual(read.params[1], { blockHash: block.hash, requireCanonical: true });
  }
});
test("missing contracts, wrong chain, malformed ABI and reorg fail closed", async () => {
  for (const mode of ["chain", "reorg", "absent", "abi"]) { await assert.rejects(readRegistrationSnapshot(target, fixture(mode).fetcher)); }
});
