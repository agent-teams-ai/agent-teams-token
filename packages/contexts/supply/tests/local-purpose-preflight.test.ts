import assert from "node:assert/strict";
import test from "node:test";
import { verifyLocalPurposePreflight, type LocalPurposePreflight, type PreparedLocalPurposeGenesis } from "../src/features/genesis-manifest/application/prepare-local-purpose-genesis.js";
import type { Hex } from "../src/features/genesis-manifest/domain/deployment.js";

test("preflight requires exactly one own dense account observation for every top-level and nested target", () => {
  const targets = Array.from({ length: 10 }, (_, index) => `0x${String(index + 1).padStart(40, "0")}` as Hex);
  const sender = `0x${"f".repeat(40)}` as Hex;
  // Narrow boundary fixture; no compiler, hash, address-derivation or chain-execution claim.
  const prepared = { configuration: { chainId: "31337", execution: { sender, startingNonce: "8", fundingDeadline: "100" } },
    operations: [...targets.slice(0, 9).map((expectedAddress, index) => ({ kind: "create", expectedAddress,
      ...(index === 1 ? { nestedAddress: targets[9]! } : {}) })), { kind: "call" }] } as unknown as PreparedLocalPurposeGenesis;
  const observed: LocalPurposePreflight = { chainId: "31337", blockHash: `0x${"a".repeat(64)}`,
    blockNumber: "1", timestamp: "90", sender, nextNonce: "8", accounts: targets.map(address => ({ address, code: "0x", nonce: "0" })) };
  const verify = (accounts: LocalPurposePreflight["accounts"]) => verifyLocalPurposePreflight(prepared, { ...observed, accounts });
  assert.doesNotThrow(() => verify(observed.accounts));
  assert.doesNotThrow(() => verify(observed.accounts.toReversed()));
  for (let index = 0; index < 10; index++) {
    const sparse = [...observed.accounts]; delete sparse[index];
    assert.throws(() => verify(sparse), /LOCAL_PURPOSE_PLAN_INVALID/, `hole at target ${index}`);
    const inherited = [...sparse]; delete inherited[index];
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { [index]: observed.accounts[index] }));
    assert.throws(() => verify(inherited), /LOCAL_PURPOSE_PLAN_INVALID/, `inherited target ${index}`);
    assert.throws(() => verify(observed.accounts.filter((_, i) => i !== index)), /LOCAL_PURPOSE_PLAN_INVALID/);
  }
  const duplicate = [...observed.accounts]; duplicate[9] = observed.accounts[0]!;
  assert.throws(() => verify(duplicate), /LOCAL_PURPOSE_PLAN_INVALID/);
  const missing = [...observed.accounts]; missing[9] = undefined as never;
  assert.throws(() => verify(missing), /LOCAL_PURPOSE_PLAN_INVALID/);
});
