import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRegistrationStep } from "../src/domain/evm-registration.ts";
import type { RegistrationSnapshot } from "../src/domain/evm-registration.ts";
const zero = "0x" + "0".repeat(40), token = "0x" + "1".repeat(40), pool = "0x" + "2".repeat(40), admin = "0x" + "3".repeat(40);
const target = { testOnly: true as const, token, pool, administrator: admin };
const snapshot: RegistrationSnapshot = { chainId: "11155111", finalizedBlockHash: "0x" + "a".repeat(64),
  token, tokenAdmin: admin, administrator: zero, pendingAdministrator: zero, tokenPool: zero, poolToken: token, poolOwner: admin };
test("official register/accept/setPool sequence advances only on observed state", () => {
  const registration = nextRegistrationStep(snapshot, target);
  assert.equal(registration.kind, "register-admin");
  assert.equal(registration.data, "0xff12c354" + token.slice(2).padStart(64, "0"));
  const pending = { ...snapshot, pendingAdministrator: admin };
  assert.equal(nextRegistrationStep(pending, target).kind, "accept-admin");
  const accepted = { ...snapshot, administrator: admin };
  const setPool = nextRegistrationStep(accepted, target);
  assert.equal(setPool.kind, "set-pool");
  assert.equal(setPool.data, "0x4e847fc7" + token.slice(2).padStart(64, "0") + pool.slice(2).padStart(64, "0"));
  assert.equal(nextRegistrationStep({ ...accepted, tokenPool: pool }, target).kind, "complete");
});
test("foreign admin/pending/pool and wrong ownership are never overwritten", () => {
  const foreign = "0x" + "4".repeat(40);
  for (const field of ["administrator", "pendingAdministrator", "tokenPool", "tokenAdmin", "poolOwner", "poolToken", "token"]) {
    assert.throws(() => nextRegistrationStep({ ...snapshot, [field]: foreign }, target));
  }
  assert.throws(() => nextRegistrationStep({ ...snapshot, tokenPool: pool }, target));
  assert.throws(() => nextRegistrationStep({ ...snapshot, administrator: admin, pendingAdministrator: admin }, target));
});
test("rejects unfinalized/malformed context and non-test scope", () => {
  assert.throws(() => nextRegistrationStep({ ...snapshot, finalizedBlockHash: "latest" }, target));
  assert.throws(() => nextRegistrationStep({ ...snapshot, chainId: "1" as "11155111" }, target));
  assert.throws(() => nextRegistrationStep(snapshot, { ...target, testOnly: false as true }));
  assert.throws(() => nextRegistrationStep(snapshot, { ...target, pool: zero }));
});
