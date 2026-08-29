import assert from "node:assert/strict";
import test from "node:test";
import { extractAddress, extractSignature } from "../src/adapters/cli.ts";

test("CLI adapter parses structured output without trusting prose", () => {
  const signature = "2".repeat(64); const address = "1".repeat(32);
  assert.equal(extractSignature(JSON.stringify({ commandOutput: { transactionData: { signature } } }), "mint"), signature);
  assert.equal(extractAddress(JSON.stringify({ commandOutput: { address } })), address);
  for (const value of ["Signature: secret", "{}", JSON.stringify({ signature: "/tmp/payer.json" })]) { assert.throws(() => extractSignature(value, "mint"), /SOLANA_/u); }
});
