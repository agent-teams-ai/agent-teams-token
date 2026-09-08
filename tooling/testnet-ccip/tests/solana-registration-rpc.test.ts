import assert from "node:assert/strict";
import test from "node:test";
import { readRegistrationSnapshot } from "../src/adapters/solana-registration-rpc.ts";
import type { RegistrationVerifier } from "../src/adapters/solana-registration-rpc.ts";
import type { SolanaRegistrationExpectation } from "../src/domain/solana-registration.ts";
const expected = { operation: "transfer-mint-authority", mint: "mint" } as SolanaRegistrationExpectation;
const values = [1, 2, 3, 4, 5, 6];
const addresses = ["mint", "pool", "ata", "registry", "global", "config"];
function verifier(): RegistrationVerifier {
  return { snapshotAddresses: () => addresses, verifySnapshot: (snapshot, e, phase) => {
    assert.deepEqual(snapshot, values); assert.equal(e, expected); assert.equal(phase, "after");
    return { operation: e.operation, mint: e.mint, verified: true };
  } };
}
test("registration state evidence is one finalized six-account read at or after transaction slot", async () => {
  const state = await readRegistrationSnapshot(async (method, params) => {
    assert.equal(method, "getMultipleAccounts");
    assert.deepEqual(params, [addresses, { encoding: "base64", commitment: "finalized", minContextSlot: 100 }]);
    return { context: { slot: 101 }, value: values };
  }, verifier(), expected, "after", 100);
  assert.equal(state.verified, true);
});
test("stale, noninteger, incomplete and unreadable snapshots cannot become state evidence", async () => {
  for (const result of [null, {}, { context: { slot: 99 }, value: values }, { context: { slot: "100" }, value: values },
    { context: { slot: 100.5 }, value: values }, { context: { slot: 100 }, value: values.slice(1) }]) {
    await assert.rejects(readRegistrationSnapshot(async () => result, verifier(), expected, "after", 100));
  }
  await assert.rejects(readRegistrationSnapshot(async () => { throw new Error("unavailable"); }, verifier(), expected, "after", 100));
});
