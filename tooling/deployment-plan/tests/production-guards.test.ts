import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProductionGuards } from "../src/domain/production-guards.ts";
import { assessProductionPreflight } from "../src/application/production-preflight.ts";
import { deriveCreateAddress, keccak256 } from "../src/domain/identity.ts";
import { parseProductionExpectations } from "../src/adapters/production-inputs.ts";

const hash = `0x${"1".repeat(64)}`;
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const bytes = "0x00";
const byteHash = keccak256(Buffer.from("00", "hex"));
const safe = (digit: string) => ({ address: address(digit), owners: [address("1"), address("2"), address("3")], threshold: 2 as const, nonce: "0", proxyCodeHash: hash, singletonCodeHash: hash, singletonAddress: address("4"), singletonSlot: hash, modules: [], guard: null, fallbackHandler: null, setupProvenance: hash });
const policy = { evmMaxFeePerGasWei: "1", evmMaxPriorityFeePerGasWei: "0", evmMaxGasPerTransaction: "1", evmMaxTotalFeeWei: "4", observationMaxAgeSeconds: "100", estimateValiditySeconds: "100", executionDeadline: "1000", fundingDeadline: "900", fundingLeadSeconds: "100", gasBufferBps: 0, tokenExpenditureCeilingBaseUnits: "3", founderStart: "1000", tokenExpenditureBaseUnits: "3" };
type FixtureOperation = { id: string; kind: "create" | "call"; nonce: string; expectedAddress: string; intentHash: string; create?: boolean; nestedAddress?: string; calldata?: string; initcode?: string; initcodeHash?: string; runtime?: string; runtimeHash?: string; gasEstimate: string; gasLimit: string; baseFeePerGas: string; maxPriorityFeePerGas: string; maxFeePerGas: string; blockGasLimit: string; value: string };

function completeFixture() {
  const sender = address("9"), token = deriveCreateAddress(sender, 0n), founder = deriveCreateAddress(sender, 1n), controller = deriveCreateAddress(sender, 2n), vault = deriveCreateAddress(founder, 1n);
  const makeOperation = (input: Omit<FixtureOperation, "gasEstimate" | "gasLimit" | "baseFeePerGas" | "maxPriorityFeePerGas" | "maxFeePerGas" | "blockGasLimit" | "value">): FixtureOperation => ({ ...input, ...(input.create ? { initcode: bytes, initcodeHash: byteHash, runtime: bytes, runtimeHash: byteHash } : {}), gasEstimate: "1", gasLimit: "1", baseFeePerGas: "0", maxPriorityFeePerGas: "0", maxFeePerGas: "1", blockGasLimit: "100", value: "0" });
  const operations = [
    makeOperation({ id: "token-create", kind: "create", nonce: "0", expectedAddress: token, intentHash: `0x${"2".repeat(64)}`, create: true }),
    { ...makeOperation({ id: "founder-reserve-create", kind: "create", nonce: "1", expectedAddress: founder, intentHash: `0x${"3".repeat(64)}`, create: true }), nestedAddress: vault },
    makeOperation({ id: "controller-create", kind: "create", nonce: "2", expectedAddress: controller, intentHash: `0x${"4".repeat(64)}`, create: true }),
    { ...makeOperation({ id: "founder-fund", kind: "call", nonce: "3", expectedAddress: founder, intentHash: `0x${"5".repeat(64)}` }), calldata: "0x12345678" },
  ];
  const authority = [safe("a"), { ...safe("b"), owners: [address("5"), address("6"), address("7")] }];
  return {
    expectations: { schema: "agtmai-production-expectations-v1" as const, chainId: "1" as const, sender, deployer: sender, configurationSha256: hash, reserveConfigurationSha256: hash, sourceRevision: "b".repeat(40), artifactPinsSha256: hash, startingNonce: "0", maxObservationAgeSeconds: "100", operations, maxTotalCostWei: "4", attemptIdentity: `0x${"c".repeat(64)}`, authority },
    observations: { chainId: "1", sender, pendingNonce: "0", blockNumber: "10", blockHash: hash, observedAt: "100", expiresAt: "200", checkedAddresses: [token, founder, vault, controller].toSorted(), occupiedAddresses: [], authority, operations: operations.map(operation => ({ id: operation.id, address: operation.expectedAddress, ...(operation.nestedAddress === undefined ? {} : { nestedAddress: operation.nestedAddress }), creation: operation.initcode, runtime: operation.runtime, ...(operation.calldata === undefined ? {} : { calldata: operation.calldata, value: operation.value }), nonce: operation.nonce })) },
    attempt: { schema: "agtmai-production-attempt-state-v1" as const, identity: `0x${"c".repeat(64)}`, states: operations.map(operation => ({ operationId: operation.id, state: "unattempted" as const, intent: operation.intentHash })) },
  };
}
const preparedOperations = (operations: ReturnType<typeof completeFixture>["expectations"]["operations"]) => operations.map(operation => operation.kind === "create"
  ? { id: operation.id, kind: operation.kind, intentHash: operation.intentHash, nonce: operation.nonce, expectedAddress: operation.expectedAddress, ...(operation.nestedAddress === undefined ? {} : { nestedAddress: operation.nestedAddress }), initcode: operation.initcode, value: operation.value }
  : { id: operation.id, kind: operation.kind, intentHash: operation.intentHash, nonce: operation.nonce, to: operation.expectedAddress, calldata: operation.calldata, value: operation.value });
const preparedEnvelope = (fixture: ReturnType<typeof completeFixture>) => {
  const artifacts: { contract: string; compilerVersion: string; artifactSha256: string; buildInfoSha256: string; compilerInputSha256: string; creationBytecode: string; runtimeBytecode: string; immutableReferences: { start: number; length: number }[] }[] = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"].map(contract => ({ contract, compilerVersion: "0.8.36", artifactSha256: hash, buildInfoSha256: hash, compilerInputSha256: hash, creationBytecode: bytes, runtimeBytecode: bytes, immutableReferences: [] }));
  return {
    schema: "agtmai-prepared-production-deployment-v1", broadcastAllowed: false, coverage: "token-and-reserves-only",
    configurationSha256: hash, reserveConfigurationSha256: hash,
    approval: { schema: "agtmai-production-approval-v1", configurationSha256: hash, reserveConfigurationSha256: hash, reference: "review" },
    artifacts,
    runtimeVerification: { status: "exact-static-runtime", reason: null, contracts: artifacts.map(({ contract, compilerVersion, compilerInputSha256, immutableReferences }) => ({ contract, compilerVersion, compilerInputSha256, immutableReferences })) },
    configuration: { deployment: { policy }, reserveGenesis: { allocations: [{ id: "founder", amountBaseUnits: "3" }], founder: { schedule: { start: "1000" } } } },
    expectations: fixture.expectations,
    operations: preparedOperations(fixture.expectations.operations),
  };
};
test("production guards fail closed when attempt history is absent", () => {
  const result = evaluateProductionGuards({ schema: "agtmai-production-expectations-v1", chainId: "1", sender: `0x${"1".repeat(40)}`, deployer: `0x${"1".repeat(40)}`, configurationSha256: hash, reserveConfigurationSha256: hash, sourceRevision: "1".repeat(40), artifactPinsSha256: hash, startingNonce: "0", maxObservationAgeSeconds: "1", operations: [], maxTotalCostWei: "1", attemptIdentity: hash, authority: [] }, { chainId: "1", sender: `0x${"1".repeat(40)}`, pendingNonce: "0", blockNumber: "1", blockHash: hash, observedAt: "1", expiresAt: "2", operations: [], checkedAddresses: [], occupiedAddresses: [], authority: [] }, undefined as never, 1n, policy);
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
  const result = evaluateProductionGuards(fixture.expectations, fixture.observations, fixture.attempt, 150n, policy);
  assert.equal(result.status, "checks-passed-offline");
  assert.equal(result.totalWorstCaseWei, "4");
  assert.equal(result.broadcastAllowed, false);
});

test("offline preflight binds the prepared operation inventory before evaluating evidence", () => {
  const fixture = completeFixture();
  const prepared = preparedEnvelope(fixture);
  const result = assessProductionPreflight({ prepared, expectations: fixture.expectations, observations: fixture.observations, attempt: fixture.attempt, nowSeconds: 150n, preparedConfigurationSha256: hash, preparedReserveConfigurationSha256: hash, preparedArtifactPinsSha256: hash });
  assert.equal(result.status, "checks-passed-offline");
  assert.equal(result.broadcastAllowed, false);
});

test("offline preflight rejects a prepared artifact set that does not match the selected digest", () => {
  const fixture = completeFixture();
  const prepared = preparedEnvelope(fixture);
  const result = assessProductionPreflight({ prepared, expectations: fixture.expectations, observations: fixture.observations, attempt: fixture.attempt, nowSeconds: 150n, preparedConfigurationSha256: hash, preparedReserveConfigurationSha256: hash, preparedArtifactPinsSha256: `0x${"f".repeat(64)}` });
  assert.equal(result.status, "invalid");
  assert.equal(result.broadcastAllowed, false);
});

test("production guard rejects a shortened operation-order prefix", () => {
  const fixture = completeFixture();
  const expectations = { ...fixture.expectations, operations: fixture.expectations.operations.slice(0, 3) };
  const attempt = { ...fixture.attempt, states: fixture.attempt.states.slice(0, 3) };
  const result = evaluateProductionGuards(expectations, { ...fixture.observations, pendingNonce: "0", operations: fixture.observations.operations.slice(0, 3) }, attempt, 150n, policy);
  assert.equal(result.status, "blocked");
  assert.ok(result.reasons.includes("operation-inventory-invalid"));
});

test("attempt intent mutation remains blocked despite matching operation IDs", () => {
  const fixture = completeFixture();
  const mutated = structuredClone(fixture.attempt);
  mutated.states[0]!.intent = `0x${"d".repeat(64)}`;
  const result = evaluateProductionGuards(fixture.expectations, fixture.observations, mutated, 150n, policy);
  assert.equal(result.status, "blocked");
  assert.ok(result.reasons.includes("attempt-intent-mismatch"));
  assert.equal(result.broadcastAllowed, false);
});

test("aggregate cost rejects one unit below the exact ceiling", () => {
  const fixture = completeFixture();
  const result = evaluateProductionGuards({ ...fixture.expectations, maxTotalCostWei: "3" }, fixture.observations, fixture.attempt, 150n, policy);
  assert.equal(result.status, "blocked");
  assert.ok(result.reasons.includes("aggregate-cost-exceeded"));
});

test("untouched starting nonce passes while consumed or pending sequence nonces fail", () => {
  const fixture = completeFixture();
  assert.equal(evaluateProductionGuards(fixture.expectations, fixture.observations, fixture.attempt, 150n, policy).status, "checks-passed-offline");
  for (const pendingNonce of ["1", "4"]) {
    const result = evaluateProductionGuards(fixture.expectations, { ...fixture.observations, pendingNonce }, fixture.attempt, 150n, policy);
    assert.ok(result.reasons.includes("unexpected-pending-nonce"));
  }
  const operations = structuredClone(fixture.expectations.operations); operations[2]!.nonce = "3";
  const result = evaluateProductionGuards({ ...fixture.expectations, operations }, fixture.observations, fixture.attempt, 150n, policy);
  assert.ok(result.reasons.includes("nonce-inventory-mismatch"));
});

test("observed operation nonce is required for every predicted operation", () => {
  const fixture = completeFixture();
  const operations = structuredClone(fixture.observations.operations);
  (operations[2] as unknown as { nonce?: string }).nonce = undefined;
  const result = evaluateProductionGuards(fixture.expectations, { ...fixture.observations, operations }, fixture.attempt, 150n, policy);
  assert.equal(result.status, "blocked");
  assert.ok(result.reasons.includes("observed-nonce-mismatch"));
});

test("nested CREATE target occupancy and incomplete target observations fail closed", () => {
  const fixture = completeFixture(); const nested = fixture.expectations.operations[1]!.nestedAddress!;
  const occupied = evaluateProductionGuards(fixture.expectations, { ...fixture.observations, occupiedAddresses: [nested] }, fixture.attempt, 150n, policy);
  assert.ok(occupied.reasons.includes("target-address-occupied"));
  const operations = structuredClone(fixture.observations.operations); delete operations[1]!.nestedAddress;
  const incomplete = evaluateProductionGuards(fixture.expectations, { ...fixture.observations, operations }, fixture.attempt, 150n, policy);
  assert.ok(incomplete.reasons.includes("observed-nested-address-mismatch"));
  const unchecked = evaluateProductionGuards(fixture.expectations, { ...fixture.observations, checkedAddresses: fixture.observations.checkedAddresses.slice(1) }, fixture.attempt, 150n, policy);
  assert.ok(unchecked.reasons.includes("address-observation-missing"));
});

test("approved fee, gas, observation, token and deadline policies are hard ceilings", () => {
  const fixture = completeFixture();
  const cases: readonly [string, () => ReturnType<typeof evaluateProductionGuards>, string][] = [
    ["fee", () => { const operations = structuredClone(fixture.expectations.operations); operations[0]!.maxFeePerGas = "2"; return evaluateProductionGuards({ ...fixture.expectations, operations }, fixture.observations, fixture.attempt, 150n, policy); }, "gas-fee-policy-mismatch"],
    ["priority", () => { const operations = structuredClone(fixture.expectations.operations); operations[0]!.maxPriorityFeePerGas = "1"; return evaluateProductionGuards({ ...fixture.expectations, operations }, fixture.observations, fixture.attempt, 150n, policy); }, "gas-fee-policy-mismatch"],
    ["buffer", () => { const operations = structuredClone(fixture.expectations.operations); operations[0]!.gasLimit = "2"; return evaluateProductionGuards({ ...fixture.expectations, operations }, fixture.observations, fixture.attempt, 150n, { ...policy, evmMaxGasPerTransaction: "2" }); }, "gas-fee-policy-mismatch"],
    ["observation", () => evaluateProductionGuards(fixture.expectations, fixture.observations, fixture.attempt, 150n, { ...policy, observationMaxAgeSeconds: "99" }), "observation-policy-relaxed"],
    ["aggregate", () => evaluateProductionGuards(fixture.expectations, fixture.observations, fixture.attempt, 150n, { ...policy, evmMaxTotalFeeWei: "3" }), "aggregate-policy-relaxed"],
    ["token", () => evaluateProductionGuards(fixture.expectations, fixture.observations, fixture.attempt, 150n, { ...policy, tokenExpenditureCeilingBaseUnits: "2" }), "token-expenditure-exceeded"],
    ["execution", () => evaluateProductionGuards(fixture.expectations, fixture.observations, fixture.attempt, 150n, { ...policy, executionDeadline: "149" }), "production-deadline-policy-mismatch"],
    ["funding lead", () => evaluateProductionGuards(fixture.expectations, fixture.observations, fixture.attempt, 150n, { ...policy, fundingLeadSeconds: "101" }), "production-deadline-policy-mismatch"],
  ];
  for (const [label, evaluate, reason] of cases) {assert.ok(evaluate().reasons.includes(reason), label);}
});

test("preflight compares complete embedded expectations and every prepared operation field", () => {
  const fixture = completeFixture();
  const base = preparedEnvelope(fixture);
  const request = { expectations: fixture.expectations, observations: fixture.observations, attempt: fixture.attempt, nowSeconds: 150n, preparedConfigurationSha256: hash, preparedReserveConfigurationSha256: hash, preparedArtifactPinsSha256: hash };
  const external = structuredClone(fixture.expectations); external.authority[0]!.nonce = "1";
  assert.deepEqual(assessProductionPreflight({ ...request, prepared: base, expectations: external }).reasons, ["embedded-expectations-mismatch"]);
  for (const mutate of [
    (prepared: typeof base) => { prepared.operations[0]!.intentHash = `0x${"f".repeat(64)}`; },
    (prepared: typeof base) => { prepared.operations[3]!.value = "1"; },
    (prepared: typeof base) => { prepared.operations[3]!.calldata = "0x87654321"; },
  ]) {
    const prepared = structuredClone(base); mutate(prepared);
    assert.ok(assessProductionPreflight({ ...request, prepared }).reasons.includes("prepared-operation-binding-mismatch"));
  }
});

test("preflight blocks an authenticated package whose immutable runtime proof is unresolved", () => {
  const fixture = completeFixture(), prepared = preparedEnvelope(fixture);
  prepared.artifacts[0]!.immutableReferences = [{ start: 1, length: 32 }];
  (prepared as { runtimeVerification: unknown }).runtimeVerification = { status: "unresolved-immutables", reason: "PRODUCTION_RUNTIME_IMMUTABLES_REQUIRE_DETERMINISTIC_LOCAL_EXECUTION", contracts: prepared.artifacts.map(({ contract, compilerVersion, compilerInputSha256, immutableReferences }) => ({ contract, compilerVersion, compilerInputSha256, immutableReferences })) };
  const result = assessProductionPreflight({ prepared, expectations: fixture.expectations, observations: fixture.observations, attempt: fixture.attempt, nowSeconds: 150n, preparedConfigurationSha256: hash, preparedReserveConfigurationSha256: hash, preparedArtifactPinsSha256: hash });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.reasons, ["runtime-immutables-require-deterministic-local-execution"]);
});

test("expectation parser rejects fields belonging to the other operation kind", () => {
  const fixture = completeFixture();
  for (const mutate of [
    (operations: Record<string, unknown>[]) => { operations[0]!.calldata = "0x12345678"; },
    (operations: Record<string, unknown>[]) => { operations[3]!.initcode = "0x00"; },
  ]) {
    const input = structuredClone(fixture.expectations) as unknown as { operations: Record<string, unknown>[] }; mutate(input.operations);
    assert.throws(() => parseProductionExpectations(input), /PREFLIGHT_SCHEMA/);
  }
});
