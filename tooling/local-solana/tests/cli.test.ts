import assert from "node:assert/strict";
import test from "node:test";
import { extractAddress, extractAssociatedAddress, extractLamports, extractSignature } from "../src/adapters/cli.ts";

test("CLI adapter parses structured output without trusting prose", () => {
  const signature = "2".repeat(64); const address = "1".repeat(32);
  assert.equal(extractSignature(JSON.stringify({ commandOutput: { transactionData: { signature } } }), "mint"), signature);
  assert.equal(extractAddress(JSON.stringify({ commandOutput: { address } })), address);
  assert.equal(extractAssociatedAddress(JSON.stringify({ commandOutput: { associatedTokenAddress: address } })), address);
  for (const value of ["Signature: secret", "{}", JSON.stringify({ signature: "/tmp/payer.json" })]) { assert.throws(() => extractSignature(value, "mint"), /SOLANA_/u); }
  assert.equal(extractLamports('{"lamports":500000000000000000}'), 500_000_000_000_000_000n);
  assert.throws(() => extractLamports('{"lamports":5e17}'), /SOLANA_PAYER_BALANCE_INTEGER/u);
});
