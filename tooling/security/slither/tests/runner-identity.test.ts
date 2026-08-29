import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCreationBytecode } from "../src/adapters/runner.ts";

test("creation bytecode identity normalizes Forge's 0x artifact prefix", () => {
  assert.deepEqual(decodeCreationBytecode("0x6001"), decodeCreationBytecode("6001"));
});

test("creation bytecode identity rejects empty, odd, linked or non-hex values", () => {
  for (const value of ["", "0x", "0x1", "0xzz", "__$library$__", null]) assert.throws(() => decodeCreationBytecode(value));
});
