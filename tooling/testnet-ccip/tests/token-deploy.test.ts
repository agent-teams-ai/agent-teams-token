import assert from "node:assert/strict";
import { test } from "node:test";
import { testTokenConstructor } from "../src/composition/deploy-token.ts";

test("test constructor matches Foundry ABI vector for a single fixed allocation", () => {
  // Independently generated with cast abi-encode constructor(uint256,(bytes32,address,uint256)[],address).
  const expected = "0x000000000000000000000000000000000000000000000000000000174876e8000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000275ee728c49100b56d4aa37c00e2dc8ffc5e5df600000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000275ee728c49100b56d4aa37c00e2dc8ffc5e5df6000000000000000000000000000000000000000000000000000000174876e800";
  assert.equal(testTokenConstructor("0x275eE728C49100b56D4AA37C00E2Dc8FfC5E5dF6"), expected);
  for (const invalid of ["0x" + "0".repeat(40), "", "0x1234", "mainnet.eth"]) {
    assert.throws(() => testTokenConstructor(invalid), /Invalid test administrator/);
  }
});
