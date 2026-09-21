import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProductionGuards } from "../src/domain/production-guards.ts";
import { assessProductionPreflight } from "../src/application/production-preflight.ts";
import { deriveCreateAddress, keccak256 } from "../src/domain/identity.ts";

const hash = `0x${"1".repeat(64)}`;
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const bytes = "0x00";
const byteHash = keccak256(Buffer.from("00", "hex"));
const safe = (digit: string) => ({ address: address(digit), owners: [address("1"), address("2"), address("3")], threshold: 2 as const, nonce: "0", proxyCodeHash: hash, singletonCodeHash: hash, singletonAddress: address("4"), singletonSlot: hash, modules: [], guard: null, fallbackHandler: null, setupProvenance: hash });

function completeFixture() {
  const sender = address("9"), token = deriveCreateAddress(sender, 0n), founder = deriveCreateAddress(sender, 1n), controller = deriveCreateAddress(sender, 2n), vault = deriveCreateAddress(founder, 1n);
  const operation = (id: string, kind: "create" | "call", nonce: string, expectedAddress: string, intentHash: string, create = false) => ({ id, kind, intentHash, nonce, expectedAddress, ...(create ? { initcode: bytes, initcodeHash: byteHash, runtime: bytes, runtimeHash: byteHash } : {}), gasEstimate: "1", gasLimit: "1", baseFeePerGas: "0", maxPriorityFeePerGas: "0", maxFeePerGas: "1", blockGasLimit: "100", value: "0" });
  const operations = [
    operation("token-create", "create", "0", token, `0x${"2".repeat(64)}`, true),
    { ...operation("founder-reserve-create", "create", "1", founder, `0x${"3".repeat(64)}`, true), nestedAddress: vault },
    operation("controller-create", "create", "2", controller, `0x${"4".repeat(64)}`, true),
    operation("founder-fund", "call", "3", founder, `0x${"5".repeat(64)}`),
  ];
  const authority = [safe("a"), { ...safe("b"), owners: [address("5"), address("6"), address("7")] }];
  return {
    expectations: { schema: "agtmai-production-expectations-v1" as const, chainId: "1" as const, sender, deployer: sender, configurationSha256: hash, reserveConfigurationSha256: hash, sourceRevision: "b".repeat(40), artifactPinsSha256: hash, startingNonce: "0", maxObservationAgeSeconds: "100", operations, maxTotalCostWei: "4", attemptIdentity: `0x${"c".repeat(64)}`, authority },
    observations: { chainId: "1", sender, pendingNonce: "4", blockNumber: "10", blockHash: hash, observedAt: "100", expiresAt: "200", occupiedAddresses: [], authority, operations: operations.map(operation => ({ id: operation.id, address: operation.expectedAddress, creation: operation.initcode, runtime: operation.runtime, nonce: operation.nonce })) },
    attempt: { schema: "agtmai-production-attempt-state-v1" as const, identity: `0x${"c".repeat(64)}`, states: operations.map(operation => ({ operationId: operation.id, state: "unattempted" as const, intent: operation.intentHash })) },
  };
}
test("production guards fail closed when attempt history is absent", () => {
  const result = evaluateProductionGuards({ schema: "agtmai-production-expectations-v1", chainId: "1", sender: `0x${"1".repeat(40)}`, deployer: `0x${"1".repeat(40)}`, configurationSha256: hash, reserveConfigurationSha256: hash, sourceRevision: "1".repeat(40), artifactPinsSha256: hash, startingNonce: "0", maxObservationAgeSeconds: "1", operations: [], maxTotalCostWei: "1", attemptIdentity: hash, authority: [] }, { chainId: "1", sender: `0x${"1".repeat(40)}`, pendingNonce: "0", blockNumber: "1", blockHash: hash, observedAt: "1", expiresAt: "2", operations: [], occupiedAddresses: [], authority: [] }, undefined as never, 1n);
  assert.equal(result.broadcastAllowed, false);
  assert.equal(result.status, "invalid");
});

test("preflight rejects a prepared bundle that can authorize execution", () => {
  const result = assessProductionPreflight({ prepared: { schema: "agtmai-prepared-production-deployment-v1", broadcastAllowed: true }, expectations: {} as never, observations: {} as never, attempt: {} as never, nowSeconds: 1n, preparedConfigurationSha256: hash, preparedReserveConfigurationSha256: hash, preparedArtifactPinsSha256: hash });
  assert.equal(result.status, "invalid");
  assert.equal(result.broadcastAllowed, false);
});

test("complete synthetic production evidence passes offline without becoming executable", () => {
  const fixture = completeFixture();
  const result = evaluateProductionGuards(fixture.expectations, fixture.observations, fixture.attempt, 150n);
  assert.equal(result.status, "checks-passed-offline");
  assert.equal(result.totalWorstCaseWei, "4");
  assert.equal(result.broadcastAllowed, false);
});

test("offline preflight binds the prepared operation inventory before evaluating evidence", () => {
  const fixture = completeFixture();
  const prepared = {
    schema: "agtmai-prepared-production-deployment-v1",
    broadcastAllowed: false,
    configurationSha256: hash,
    reserveConfigurationSha256: hash,
    expectations: fixture.expectations,
    operations: fixture.expectations.operations.map(operation => ({ ...operation, ...(operation.kind === "call" ? { to: operation.expectedAddress } : {}) })),
  };
  const result = assessProductionPreflight({ prepared, expectations: fixture.expectations, observations: fixture.observations, attempt: fixture.attempt, nowSeconds: 150n, preparedConfigurationSha256: hash, preparedReserveConfigurationSha256: hash, preparedArtifactPinsSha256: hash });
  assert.equal(result.status, "checks-passed-offline");
  assert.equal(result.broadcastAllowed, false);
});

test("offline preflight rejects a prepared artifact set that does not match the selected digest", () => {
  const fixture = completeFixture();
  const prepared = { schema: "agtmai-prepared-production-deployment-v1", broadcastAllowed: false, configurationSha256: hash, reserveConfigurationSha256: hash, expectations: fixture.expectations, operations: fixture.expectations.operations };
  const result = assessProductionPreflight({ prepared, expectations: fixture.expectations, observations: fixture.observations, attempt: fixture.attempt, nowSeconds: 150n, preparedConfigurationSha256: hash, preparedReserveConfigurationSha256: hash, preparedArtifactPinsSha256: `0x${"f".repeat(64)}` });
  assert.equal(result.status, "invalid");
  assert.equal(result.broadcastAllowed, false);
});

test("production guard rejects a shortened operation-order prefix", () => {
  const fixture = completeFixture();
  const expectations = { ...fixture.expectations, operations: fixture.expectations.operations.slice(0, 3) };
  const attempt = { ...fixture.attempt, states: fixture.attempt.states.slice(0, 3) };
  const result = evaluateProductionGuards(expectations, { ...fixture.observations, pendingNonce: "3", operations: fixture.observations.operations.slice(0, 3) }, attempt, 150n);
  assert.equal(result.status, "blocked");
  assert.ok(result.reasons.includes("operation-inventory-invalid"));
});

test("attempt intent mutation remains blocked despite matching operation IDs", () => {
  const fixture = completeFixture();
  const mutated = structuredClone(fixture.attempt);
  mutated.states[0]!.intent = `0x${"d".repeat(64)}`;
  const result = evaluateProductionGuards(fixture.expectations, fixture.observations, mutated, 150n);
  assert.equal(result.status, "blocked");
  assert.ok(result.reasons.includes("attempt-intent-mismatch"));
  assert.equal(result.broadcastAllowed, false);
});

test("aggregate cost rejects one unit below the exact ceiling", () => {
  const fixture = completeFixture();
  const result = evaluateProductionGuards({ ...fixture.expectations, maxTotalCostWei: "3" }, fixture.observations, fixture.attempt, 150n);
  assert.equal(result.status, "blocked");
  assert.ok(result.reasons.includes("aggregate-cost-exceeded"));
});
