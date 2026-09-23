import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { calendarSchedule, deploymentBytes, validateProductionDeployment, type PreparedProductionDeployment } from "@agent-teams/supply/deployment";
import { createContributorCommitmentIntent, type ContributorCapacityObservation, type ContributorCommitmentInput } from "../src/composition/contributor-commitment-intent.ts";
import { sha256Hex } from "../src/domain/identity.ts";
import { syntheticProductionEnvelope } from "./helpers/real-production-package.ts";

const a = (digit: string) => `0x${digit.repeat(40)}`;
const h = (digit: string) => `0x${digit.repeat(64)}`;
const start = "1800000000", now = 1799999900n;
const make = () => {
  const validated = validateProductionDeployment(syntheticProductionEnvelope());
  assert.ok(validated.value, validated.diagnostics.map(d => d.code).join(","));
  const config = validated.value;
  const configurationSha256 = sha256Hex(deploymentBytes(config.deployment));
  const reserveConfigurationSha256 = sha256Hex(deploymentBytes(config.reserveGenesis));
  const sourceRevision = "a".repeat(40);
  const artifacts = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"].map((contract, index) => ({contract, compilerVersion: "0.8.36", creationBytecode: "0x6000", runtimeBytecode: "0x6000", artifactSha256: h(String(index + 1)), buildInfoSha256: h("4"), compilerInputSha256: h("5"), immutableReferences: []}));
  const artifactPinsSha256 = sha256Hex(deploymentBytes({schema: "agtmai-production-artifact-pins-v1", sourceRevision, artifacts}));
  const prepared = {schema: "agtmai-prepared-production-deployment-v1", broadcastAllowed: false, coverage: "token-and-reserves-only", configuration: config, configurationSha256, reserveConfigurationSha256, approval: {configurationSha256, reserveConfigurationSha256}, expectations: {configurationSha256, reserveConfigurationSha256, artifactPinsSha256, sourceRevision, authority: [{address: a("b"), proxyCodeHash: h("6"), singletonCodeHash: h("7"), singletonAddress: a("8")}]}, artifacts, operations: [{id: "token-create", kind: "create", expectedAddress: a("1")}, {id: "founder-reserve-create", kind: "create", expectedAddress: a("3")}, {id: "controller-create", kind: "create", expectedAddress: a("2")}, {id: "founder-fund", kind: "call", to: a("3")}] } as unknown as PreparedProductionDeployment;
  const input: ContributorCommitmentInput = {schema: "agtmai-contributor-commitment-input-v1", chainId: "1", token: a("1"), reserve: a("2"), projectControllerSafe: a("b"), safeNonce: "3", beneficiary: a("9"), amountBaseUnits: "1000", purpose: h("4"), schedule: calendarSchedule(start), configurationSha256, reserveConfigurationSha256, artifactPinsSha256, sourceRevision};
  const observation: ContributorCapacityObservation = {schema: "agtmai-contributor-capacity-observation-v1", provenance: "supplied-unverified", chainId: "1", blockNumber: "42", blockHash: h("a"), blockTimestamp: "1799999700", observedAt: "1799999800", token: input.token, reserve: input.reserve, projectControllerSafe: input.projectControllerSafe, safeNonce: input.safeNonce, safeThreshold: 2, safeOwners: [a("c"), a("d"), a("e")], safeProxyCodeHash: h("6"), safeSingletonCodeHash: h("7"), safeSingletonAddress: a("8"), controllerToken: input.token, controllerSafe: input.projectControllerSafe, controllerPurpose: input.purpose, rollingCapBaseUnits: "16000000000000000", perGrantCapBaseUnits: "5000000000000000", controllerWindowSeconds: "31536000", rollingCommittedBaseUnits: "10", grossCommittedBaseUnits: "100", reserveBalanceBaseUnits: "1000"};
  return {prepared, input, observation};
};
const build = (fixture = make()) => createContributorCommitmentIntent(fixture.prepared, fixture.input, fixture.observation, now);
const changed = (fixture: ReturnType<typeof make>, group: "input" | "observation", field: string, value: unknown) => ({...fixture, [group]: {...fixture[group], [field]: value}});

test("one exact unsigned Safe CALL and independently decoded ABI words", () => {
  const fixture = make(); const first = build(fixture); const second = build(fixture);
  assert.deepEqual(first, second);
  assert.equal(first.broadcastAllowed, false); assert.equal(first.evidenceStatus, "supplied-unverified");
  assert.deepEqual(first.safeTransaction, {to: fixture.input.reserve, value: "0", data: first.safeTransaction.data, operation: 0});
  assert.deepEqual(Object.keys(first.safeTransaction).toSorted(), ["data", "operation", "to", "value"]);
  const raw = Buffer.from(first.safeTransaction.data.slice(2), "hex");
  const selector = Buffer.from(keccak_256(new TextEncoder().encode("commit(address,(uint256,uint64,uint64,uint64,uint8,bytes32))"))).subarray(0, 4);
  assert.deepEqual(raw.subarray(0, 4), selector); assert.equal(raw.length, 4 + 7 * 32);
  const word = (index: number) => raw.subarray(4 + index * 32, 4 + (index + 1) * 32);
  assert.equal(`0x${word(0).subarray(12).toString("hex")}`, fixture.input.beneficiary);
  assert.equal(BigInt(`0x${word(1).toString("hex")}`), 1000n);
  assert.equal(BigInt(`0x${word(2).toString("hex")}`), BigInt(start));
  assert.equal(BigInt(`0x${word(3).toString("hex")}`), BigInt(fixture.input.schedule.cliff));
  assert.equal(BigInt(`0x${word(4).toString("hex")}`), BigInt(fixture.input.schedule.end));
  assert.equal(BigInt(`0x${word(5).toString("hex")}`), 1n);
  assert.equal(`0x${word(6).toString("hex")}`, fixture.input.purpose);
  assert.notEqual(build({...fixture, input: {...fixture.input, safeNonce: "4"}, observation: {...fixture.observation, safeNonce: "4"}}).intentDigest, first.intentDigest);
  assert.notEqual(build(changed(fixture, "observation", "blockHash", h("b"))).intentDigest, first.intentDigest);
  for (const [field, value] of [["blockNumber", "43"], ["blockTimestamp", "1799999701"], ["observedAt", "1799999801"], ["grossCommittedBaseUnits", "101"], ["rollingCommittedBaseUnits", "11"], ["reserveBalanceBaseUnits", "1001"]] as const) {
    assert.notEqual(build(changed(fixture, "observation", field, value)).intentDigest, first.intentDigest, field);
  }
  assert.notEqual(build(changed(fixture, "input", "beneficiary", a("8"))).safeTransaction.data, first.safeTransaction.data);
  assert.notEqual(build(changed(fixture, "input", "amountBaseUnits", "999")).safeTransaction.data, first.safeTransaction.data);
});

test("critical identity, policy, schedule and binding mutations fail closed", () => {
  const mutations: ["input" | "observation", string, unknown][] = [
    ["input", "chainId", "31337"], ["input", "token", a("7")], ["input", "reserve", a("7")], ["input", "projectControllerSafe", a("7")], ["input", "beneficiary", a("1")], ["input", "amountBaseUnits", "0"], ["input", "purpose", h("7")], ["input", "configurationSha256", h("7")], ["input", "reserveConfigurationSha256", h("7")], ["input", "artifactPinsSha256", h("7")], ["input", "sourceRevision", "b".repeat(40)],
    ["observation", "chainId", "31337"], ["observation", "token", a("7")], ["observation", "reserve", a("7")], ["observation", "projectControllerSafe", a("7")], ["observation", "safeNonce", "4"], ["observation", "safeThreshold", 1], ["observation", "safeOwners", [a("a"), a("d"), a("e")]], ["observation", "safeProxyCodeHash", h("8")], ["observation", "safeSingletonCodeHash", h("8")], ["observation", "safeSingletonAddress", a("7")], ["observation", "controllerToken", a("7")], ["observation", "controllerSafe", a("7")], ["observation", "controllerPurpose", h("7")], ["observation", "rollingCapBaseUnits", "1"], ["observation", "perGrantCapBaseUnits", "1"], ["observation", "controllerWindowSeconds", "1"], ["observation", "provenance", "verified-chain"],
  ];
  for (const [group, field, value] of mutations) {assert.throws(() => build(changed(make(), group, field, value)), `${group}.${field}`);}
  const fixture = make();
  for (const schedule of [{...fixture.input.schedule, cliff: fixture.input.schedule.end}, {...fixture.input.schedule, profile: "accelerated-test"}, calendarSchedule("1799999800")]) {assert.throws(() => build(changed(fixture, "input", "schedule", schedule)));}
  assert.throws(() => build({...fixture, input: {...fixture.input, operation: 1} as never}));
  assert.throws(() => build({...fixture, input: {...fixture.input, signatures: []} as never}));
  assert.throws(() => build({...fixture, prepared: {...fixture.prepared, configurationSha256: h("7")} as PreparedProductionDeployment}));
  assert.throws(() => build({...fixture, prepared: {...fixture.prepared, operations: [...fixture.prepared.operations, {id: "extra", kind: "call"}] as never} as PreparedProductionDeployment}));
});

test("cap edges, inventory, freshness and refunds never restore capacity", () => {
  const fixture = make();
  const cap = BigInt(fixture.observation.rollingCapBaseUnits);
  assert.equal(build({...fixture, observation: {...fixture.observation, rollingCommittedBaseUnits: (cap - 1000n).toString(), grossCommittedBaseUnits: cap.toString()}}).capacityAfterIfExecutedBaseUnits, "0");
  assert.throws(() => build({...fixture, observation: {...fixture.observation, rollingCommittedBaseUnits: (cap - 999n).toString(), grossCommittedBaseUnits: cap.toString()}}));
  assert.throws(() => build(changed(fixture, "input", "amountBaseUnits", "5000000000000001")));
  assert.equal(build({...fixture, input: {...fixture.input, amountBaseUnits: "5000000000000000"}, observation: {...fixture.observation, reserveBalanceBaseUnits: "5000000000000000"}}).safeTransaction.value, "0");
  assert.throws(() => build(changed(fixture, "observation", "reserveBalanceBaseUnits", "999")));
  assert.throws(() => createContributorCommitmentIntent(fixture.prepared, fixture.input, fixture.observation, now + 201n));
  assert.throws(() => build(changed(fixture, "observation", "grossCommittedBaseUnits", "9")));
  const refunded = {...fixture.observation, rollingCommittedBaseUnits: (cap - 999n).toString(), grossCommittedBaseUnits: cap.toString(), reserveBalanceBaseUnits: "100000"};
  assert.throws(() => build({...fixture, observation: refunded}));
});
