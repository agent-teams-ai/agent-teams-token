import assert from "node:assert/strict";
import test from "node:test";
import { readRemoteConfigSnapshot } from "../src/adapters/evm-remote-config-rpc.ts";
import { nextRemoteConfigStep, SOLANA_REMOTE } from "../src/domain/evm-remote-config.ts";
const target = { testOnly: true as const, token: "0x" + "1".repeat(40), pool: "0x" + "2".repeat(40), administrator: "0x" + "3".repeat(40) };
const block = { number: "0x100", hash: "0x" + "a".repeat(64) };
const word = (n: bigint): string => n.toString(16).padStart(64, "0");
function fixture(mode = "configured") {
  const reads: { method: string; params: unknown[] }[] = [];
  let supports = 0;
  function contractResult(sig: string): unknown {
    const absent = mode === "absent";
    let result: unknown;
      switch (sig) {
        case "0xcb67e3b1": result = "0x" + target.administrator.slice(2).padStart(64, "0") + word(0n) + target.pool.slice(2).padStart(64, "0"); break;
        case "0x21df0da7": result = "0x" + target.token.slice(2).padStart(64, "0"); break;
        case "0x8fd6a6ac": case "0x8da5cb5b": result = "0x" + target.administrator.slice(2).padStart(64, "0"); break;
        case "0x8926f54f": supports++; result = "0x" + word(absent ? 0n : 1n); break;
        case "0xa42a7b8b": result = "0x" + (absent ? [32n,0n] : [32n,1n,32n,32n]).map(word).join("") + (absent ? "" : SOLANA_REMOTE.pool.slice(2)); break;
        case "0xb7946580": result = "0x" + [32n, absent ? 0n : 32n].map(word).join("") + (absent ? "" : SOLANA_REMOTE.token.slice(2)); break;
        default: result = "0x" + (absent ? [0n,0n,0n,0n,0n] : [0n,1n,1n,10000000000n,1000000000n]).map(word).join("");
      }

    return result;
  }
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); reads.push(body);
    let result: unknown;
    if (body.method === "eth_chainId") { result = "0xaa36a7"; }
    else if (body.method === "eth_getBlockByNumber") { result = block; }
    else if (body.method === "eth_getCode") { result = "0x1234"; }
    else {
      const data: string = body.params[0].data, sig = data.slice(0, 10);
      result = contractResult(sig);
      if (mode === "bad-rate" && sig === "0xc75eea9c") { result = "0x" + [0n,1n,2n,10000000000n,1000000000n].map(word).join(""); }
      if (mode === "bad-pools" && sig === "0xa42a7b8b") { result = String(result) + word(0n); }
      if (mode === "reorg" && supports === 2) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "not canonical" } })); }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  }) as typeof fetch;
  return { fetcher, reads };
}
test("registry and remote reads bind to one canonical finalized hash", async () => {
  for (const mode of ["configured", "absent"]) {
    const f = fixture(mode), snapshot = await readRemoteConfigSnapshot(target, f.fetcher);
    assert.equal(nextRemoteConfigStep(snapshot, target), mode === "absent" ? "configure" : "complete");
    for (const read of f.reads.filter(r => ["eth_call", "eth_getCode"].includes(r.method))) {
      assert.deepEqual(read.params[1], { blockHash: block.hash, requireCanonical: true });
    }
  }
});
test("noncanonical ABI and canonical hash loss fail closed", async () => {
  for (const mode of ["bad-rate", "bad-pools", "reorg"]) {
    await assert.rejects(readRemoteConfigSnapshot(target, fixture(mode).fetcher));
  }
});
