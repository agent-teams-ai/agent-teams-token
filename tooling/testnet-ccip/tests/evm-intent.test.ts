import assert from "node:assert/strict";
import test from "node:test";
import { canonicalIntentJson, validateSepoliaIntent } from "../src/domain/evm-intent.ts";
import type { SepoliaIntentInput } from "../src/domain/evm-intent.ts";

const admin = "0x" + "ab".repeat(20);
const target = "0x" + "cd".repeat(20);
const constructorBytes = "0x" + "0".repeat(128) + "0".repeat(24) + admin.slice(2);
const deploy: SepoliaIntentInput = {
  chainId: 11155111n, kind: "deploy", from: admin, nonce: 3n, value: 0n,
  data: "0x6000" + constructorBytes.slice(2),
  deployment: {
    artifactId: "AGTMAICCIPToken", artifactSha256: "a".repeat(64),
    creationBytecode: "0x6000", constructorBytes, administrator: admin,
    administratorBinding: "constructor-word-2",
  },
};
const call: SepoliaIntentInput = {
  chainId: "11155111", kind: "call", from: admin, nonce: "4", value: "0",
  data: "0x12345678", to: target,
};
test("normalization produces stable hashable JSON without losing integer precision", () => {
  const first = validateSepoliaIntent(deploy, deploy);
  const reordered = { ...Object.fromEntries(Object.entries(deploy).toReversed()), chainId: "11155111", nonce: "3", value: "0" } as SepoliaIntentInput;
  assert.equal(canonicalIntentJson(first), canonicalIntentJson(validateSepoliaIntent(reordered, deploy)));
  const amount = (1n << 200n) + 1n;
  const large = { ...call, value: amount };
  assert.equal(validateSepoliaIntent(large, large).value, amount.toString());
  assert.equal(first.from, admin);
});
test("only Sepolia and canonical unsigned bounded integers are accepted", () => {
  for (const chainId of [1n, "1", "011155111", "11155111.0", 11155111]) {
    assert.throws(() => validateSepoliaIntent({ ...call, chainId } as SepoliaIntentInput, call));
  }
  for (const value of [-1n, "-1", "01", "1e18", " 1", 1, 1n << 256n]) {
    const bad = { ...call, value } as SepoliaIntentInput;
    assert.throws(() => validateSepoliaIntent(bad, bad));
  }
  assert.throws(() => validateSepoliaIntent({ ...call, nonce: (1n << 64n) - 1n }, call));
});
test("every transaction identity field is bound to expected intent", () => {
  for (const change of [
    { nonce: 5n }, { value: 1n }, { from: target }, { to: admin }, { data: "0x87654321" },
  ]) {assert.throws(() => validateSepoliaIntent({ ...call, ...change }, call));}
  assert.equal(validateSepoliaIntent({ ...call, to: "0x" + "CD".repeat(20) }, call).to, target);
});
test("concrete artifact, exact constructor bytes and explicit admin are bound", () => {
  for (const change of [
    { artifactId: "AnotherToken" }, { artifactSha256: "b".repeat(64) },
    { administrator: target }, { constructorBytes: "0x" }, { creationBytecode: "0x6001" },
  ]) {assert.throws(() => validateSepoliaIntent({ ...deploy, deployment: { ...deploy.deployment!, ...change } }, deploy));}
  const forged = { ...deploy, deployment: { ...deploy.deployment!, administrator: target } };
  assert.throws(() => validateSepoliaIntent(forged, forged), /constructor administrator/);
  const dirtyPadding = "0x" + "0".repeat(128) + "1".repeat(24) + admin.slice(2);
  const dirty = { ...deploy, data: "0x6000" + dirtyPadding.slice(2), deployment: { ...deploy.deployment!, constructorBytes: dirtyPadding } };
  assert.throws(() => validateSepoliaIntent(dirty, dirty));
});
test("pool deployer ownership can bind to sender without a token admin constructor", () => {
  const pool: SepoliaIntentInput = {
    ...deploy, data: "0x6000", deployment: {
      ...deploy.deployment!, artifactId: "LockReleaseTokenPool@1.6.1",
      constructorBytes: "0x", administratorBinding: "sender",
    },
  };
  assert.equal(validateSepoliaIntent(pool, pool).deployment?.administrator, admin);
  assert.throws(() => validateSepoliaIntent({ ...pool, from: target }, pool));
});
test("deploy/call ambiguity, malformed hex and zero addresses are rejected", () => {
  for (const bad of [
    { ...deploy, to: target }, { ...call, deployment: deploy.deployment },
    { ...call, data: "0x123" }, { ...call, data: "0x" },
    { ...call, to: "0x" + "00".repeat(20) }, { ...deploy, deployment: undefined },
  ]) {assert.throws(() => validateSepoliaIntent(bad, bad));}
});
test("canonicalization rejects foreign schema and copies nested bindings", () => {
  const result = validateSepoliaIntent(deploy, deploy);
  assert.notEqual(result.deployment, deploy.deployment);
  assert.throws(() => canonicalIntentJson({ ...result, schema: "other" } as never));
});
