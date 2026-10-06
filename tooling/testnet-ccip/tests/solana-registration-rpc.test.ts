import assert from "node:assert/strict";
import test from "node:test";
import { readRegistrationSnapshot } from "../src/adapters/solana-registration-rpc.ts";
import type { RegistrationVerifier } from "../src/adapters/solana-registration-rpc.ts";
import type { SolanaRegistrationExpectation } from "../src/domain/solana-registration.ts";
import type { RpcAccount } from "../src/adapters/solana-transaction-sdk.mjs";
const key = (last: string) => "1".repeat(31) + last;
const expected: SolanaRegistrationExpectation = { testOnly: true, cluster: "solana-devnet", operation: "transfer-mint-authority",
  payer: key("2"), mint: key("3"), pool: key("4"), signer: key("5"), ata: key("6"), registry: key("7"), routerConfig: key("8") };
const addresses = [expected.mint, expected.pool, expected.ata, expected.registry, key("9"), expected.routerConfig];
const values: readonly (RpcAccount | null)[] = addresses.map((owner, index): RpcAccount | null => index === 3 ? null :
  { owner, executable: false, lamports: 1, data: [Buffer.from([index]).toString("base64"), "base64"] });
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
  const actual = verifier(); let verified = 0;
  const guarded: RegistrationVerifier = { ...actual, verifySnapshot: (...args) => { verified++; return actual.verifySnapshot(...args); } };
  for (const result of [null, {}, { context: { slot: 99 }, value: values }, { context: { slot: "100" }, value: values },
    { context: { slot: 100.5 }, value: values }, { context: { slot: 100 }, value: values.slice(1) },
    { context: { slot: 100 }, value: [1, 2, 3, 4, 5, 6] }]) {
    await assert.rejects(readRegistrationSnapshot(async () => result, guarded, expected, "after", 100));
  }
  await assert.rejects(readRegistrationSnapshot(async () => { throw new Error("unavailable"); }, guarded, expected, "after", 100));
  assert.equal(verified, 0, "Malformed or incoherent transport cannot reach account verification");
});
