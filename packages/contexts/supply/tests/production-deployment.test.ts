import assert from "node:assert/strict";
import test from "node:test";
import { prepareProductionDeployment, type ProductionArtifactPin, type ProductionExpectation } from "../src/features/genesis-manifest/application/prepare-production-deployment.js";
import { canonicalJson, type JsonValue } from "../src/features/genesis-manifest/application/canonical.js";
import type { Hex } from "../src/features/genesis-manifest/domain/deployment.js";
import { validateProductionDeployment } from "../src/features/genesis-manifest/domain/production-deployment.js";
import { sha256 as digestBytes } from "../src/features/genesis-manifest/adapters/digest.js";
import { syntheticProductionEnvelope } from "./production-fixture.js";

const syntheticEnvelope = syntheticProductionEnvelope;

test("synthetic accepted production envelope binds supply, allocations, Safe roles and reserve controllers", () => {
  const result = validateProductionDeployment(syntheticEnvelope());
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.value);
});

test("production envelope is versioned and never supplies unresolved values", () => {
  const result = validateProductionDeployment({ schema: "agtmai-production-deployment-v1", deployment: {}, reserveGenesis: {}, projectControllerSafeId: "", founderBeneficiarySafeId: "" });
  assert.equal(result.value, undefined);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.pointer === "/projectControllerSafeId"));
});

test("legacy deployment-shaped input cannot bypass the production envelope", () => {
  const result = validateProductionDeployment({ schemaVersion: 1, status: "accepted", environment: { mode: "mainnet-dry-run", evmChainId: "1" } });
  assert.equal(result.value, undefined);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "PRODUCTION_SCHEMA"));
});

test("production binding rejects policy and duplicated-fact mutations without defaults", () => {
  type MutableEnvelope = { deployment: { status: string; environment: { mode: string }; token: { initialSupplyBaseUnits: string }; custodySafes: { owners: string[] }[] }; reserveGenesis: { allocations: { amountBaseUnits: string }[]; founder: { beneficiary: string; controller: string }; contributors: { controller: string } }; projectControllerSafeId: string; founderBeneficiarySafeId: string };
  const mutations: readonly [(value: MutableEnvelope) => void, string][] = [
    [(value) => { value.deployment.status = "test-only"; }, "status"],
    [(value) => { value.deployment.environment.mode = "owned-testnet"; }, "mode"],
    [(value) => { value.deployment.token.initialSupplyBaseUnits = "1"; }, "supply"],
    [(value) => { value.reserveGenesis.allocations[0]!.amountBaseUnits = "1"; }, "reserve allocation"],
    [(value) => { value.founderBeneficiarySafeId = value.projectControllerSafeId; }, "Safe alias"],
    [(value) => { value.reserveGenesis.founder.controller = value.reserveGenesis.founder.beneficiary; }, "founder controller"],
    [(value) => { value.reserveGenesis.contributors.controller = value.reserveGenesis.founder.beneficiary; }, "contributor controller"],
  ];
  for (const [mutate, label] of mutations) {
    const value = syntheticEnvelope() as unknown as MutableEnvelope;
    mutate(value);
    const result = validateProductionDeployment(value);
    assert.equal(result.value, undefined, label);
    assert.ok(result.diagnostics.length > 0, label);
  }
});

test("separate solo-founder Safes may use the same three approved owner keys", () => {
  const value = syntheticEnvelope() as unknown as { deployment: { custodySafes: { owners: string[] }[]; roleAliases: { address: string; roles: string[] }[] } };
  value.deployment.custodySafes[1]!.owners = [...value.deployment.custodySafes[0]!.owners];
  value.deployment.roleAliases.push(...value.deployment.custodySafes[0]!.owners.map((address) => ({ address, roles: ["safe.project-controller.owner", "safe.founder-beneficiary.owner"] })));
  const result = validateProductionDeployment(value);
  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.value);
});

const sha256 = (bytes: Uint8Array): Hex => digestBytes(bytes);
const hash = (value: string): Hex => sha256(new TextEncoder().encode(value));

function syntheticPreparation(): {
  value: Record<string, unknown>;
  pins: { artifactSourceRevision: string; artifacts: ProductionArtifactPin[]; approval: { schema: "agtmai-production-approval-v1"; configurationSha256: Hex; reserveConfigurationSha256: Hex; reference: string }; expectations: ProductionExpectation };
  ports: Parameters<typeof prepareProductionDeployment>[2];
} {
  const value = syntheticEnvelope();
  const deployment = value.deployment as { allocations: { id: string; recipient: string }[]; custodySafes: { address: Hex; owners: Hex[] }[] };
  const reserveGenesis = value.reserveGenesis as { allocations: { id: string; recipient: string }[] };
  const founderReserve = `0x${"7".repeat(40)}` as Hex;
  const contributorReserve = `0x${"8".repeat(40)}` as Hex;
  const nestedFounderVault = `0x${"9".repeat(40)}` as Hex;
  for (const allocations of [deployment.allocations, reserveGenesis.allocations]) {
    allocations.find(allocation => allocation.id === "founder")!.recipient = founderReserve;
    allocations.find(allocation => allocation.id === "contributors")!.recipient = contributorReserve;
  }
  const artifacts: ProductionArtifactPin[] = [
    { contract: "ReserveController", compilerVersion: "0.8.36", creationBytecode: "0x03", runtimeBytecode: "0x33", artifactSha256: hash("controller-artifact"), buildInfoSha256: hash("controller-build"), compilerInputSha256: hash("controller-input"), immutableReferences: [] },
    { contract: "AGTMAICCIPToken", compilerVersion: "0.8.36", creationBytecode: "0x01", runtimeBytecode: "0x11", artifactSha256: hash("token-artifact"), buildInfoSha256: hash("token-build"), compilerInputSha256: hash("token-input"), immutableReferences: [] },
    { contract: "FounderGrantReserve", compilerVersion: "0.8.36", creationBytecode: "0x02", runtimeBytecode: "0x22", artifactSha256: hash("founder-artifact"), buildInfoSha256: hash("founder-build"), compilerInputSha256: hash("founder-input"), immutableReferences: [] },
  ];
  const sourceRevision = "b".repeat(40);
  const validated = validateProductionDeployment(value).value!;
  const configurationSha256 = sha256(new TextEncoder().encode(canonicalJson(validated.deployment as unknown as JsonValue)));
  const reserveConfigurationSha256 = sha256(new TextEncoder().encode(canonicalJson(validated.reserveGenesis as unknown as JsonValue)));
  const artifactPinsSha256 = sha256(new TextEncoder().encode(canonicalJson({ schema: "agtmai-production-artifact-pins-v1", sourceRevision, artifacts: artifacts.toSorted((left, right) => left.contract.localeCompare(right.contract)) } as unknown as JsonValue)));
  const safeState = (safe: { address: Hex; owners: Hex[] }, index: number) => ({
    address: safe.address, owners: safe.owners, threshold: 2 as const, nonce: "0", proxyCodeHash: hash(`proxy-${index}`), singletonCodeHash: hash(`singleton-${index}`), singletonAddress: `0x${String(index + 4).repeat(40)}` as Hex, singletonSlot: hash(`slot-${index}`), modules: [] as Hex[], guard: null, fallbackHandler: null, setupProvenance: hash(`setup-${index}`),
  });
  const tokenInitcode = "0x01aa" as Hex;
  const founderInitcode = "0x02bb" as Hex;
  const controllerInitcode = "0x03cc" as Hex;
  const gas = { gasEstimate: "100", gasLimit: "115", baseFeePerGas: "1", maxPriorityFeePerGas: "1", maxFeePerGas: "2", blockGasLimit: "10000000", value: "0" } as const;
  const fundCalldata = `0x${hash("fund()").slice(2, 10)}` as Hex;
  const operations: ProductionExpectation["operations"] = [
    { id: "token-create", kind: "create", intentHash: hash("placeholder"), nonce: "10", expectedAddress: `0x${"6".repeat(40)}`, initcode: tokenInitcode, initcodeHash: sha256(Uint8Array.from([0x01, 0xaa])), runtime: "0x11", runtimeHash: sha256(Uint8Array.from([0x11])), ...gas },
    { id: "founder-reserve-create", kind: "create", intentHash: hash("placeholder"), nonce: "11", expectedAddress: founderReserve, nestedAddress: nestedFounderVault, initcode: founderInitcode, initcodeHash: sha256(Uint8Array.from([0x02, 0xbb])), runtime: "0x22", runtimeHash: sha256(Uint8Array.from([0x22])), ...gas },
    { id: "controller-create", kind: "create", intentHash: hash("placeholder"), nonce: "12", expectedAddress: contributorReserve, initcode: controllerInitcode, initcodeHash: sha256(Uint8Array.from([0x03, 0xcc])), runtime: "0x33", runtimeHash: sha256(Uint8Array.from([0x33])), ...gas },
    { id: "founder-fund", kind: "call", intentHash: hash("placeholder"), nonce: "13", expectedAddress: founderReserve, calldata: fundCalldata, ...gas },
  ];
  const sender = `0x${"5".repeat(40)}` as Hex;
  const intent = (operation: ProductionExpectation["operations"][number], createBytes: Hex, calldata: Hex) => hash(canonicalJson({ domain: "AGTMAI_PRODUCTION_OPERATION_INTENT_V1", chainId: "1", sender, nonce: operation.nonce, kind: operation.kind, target: operation.expectedAddress, createBytes, value: operation.value, calldata } as unknown as JsonValue));
  const intents = [intent(operations[0]!, tokenInitcode, "0x"), intent(operations[1]!, founderInitcode, "0x"), intent(operations[2]!, controllerInitcode, "0x"), intent(operations[3]!, "0x", fundCalldata)];
  for (const [index, intentHash] of intents.entries()) {(operations[index] as { intentHash: Hex }).intentHash = intentHash;}
  const attemptIdentity = hash(canonicalJson({ domain: "AGTMAI_PRODUCTION_ATTEMPT_V1", chainId: "1", sender, startingNonce: "10", intents } as unknown as JsonValue));
  const expectations: ProductionExpectation = { schema: "agtmai-production-expectations-v1", chainId: "1", sourceRevision, configurationSha256, reserveConfigurationSha256, artifactPinsSha256, attemptIdentity, sender, deployer: sender, startingNonce: "10", maxObservationAgeSeconds: "300", maxTotalCostWei: "100000000000000000", authority: deployment.custodySafes.map(safeState), operations };
  return {
    value,
    pins: { artifactSourceRevision: sourceRevision, artifacts, approval: { schema: "agtmai-production-approval-v1", configurationSha256, reserveConfigurationSha256, reference: "synthetic-review" }, expectations },
    ports: { encodeToken: () => ({ constructorArgs: "0xaa" }), encodeFounderReserve: () => "0xbb", encodeReserveController: () => "0xcc", keccak256: sha256, createAddress: (_sender, nonce) => (({ "10": `0x${"6".repeat(40)}`, "11": founderReserve, "12": contributorReserve } as Record<string, Hex>)[nonce] ?? nestedFounderVault) as Hex },
  };
}

test("production preparation binds reserve recipients and canonicalizes artifact order", () => {
  const fixture = syntheticPreparation();
  const result = prepareProductionDeployment(fixture.value, fixture.pins, fixture.ports, sha256);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.prepared?.artifacts.map(artifact => artifact.contract), ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"]);
  assert.deepEqual(result.prepared?.operations.map(operation => operation.id), ["token-create", "founder-reserve-create", "controller-create", "founder-fund"]);
});

test("production preparation rejects a genesis allocation routed outside its predicted reserve", () => {
  const fixture = syntheticPreparation();
  const value = fixture.value as unknown as { deployment: { allocations: { id: string; recipient: string }[] }; reserveGenesis: { allocations: { id: string; recipient: string }[] } };
  for (const allocations of [value.deployment.allocations, value.reserveGenesis.allocations]) {allocations.find(allocation => allocation.id === "founder")!.recipient = `0x${"4".repeat(40)}`;}
  const validated = validateProductionDeployment(fixture.value).value!;
  const configurationSha256 = sha256(new TextEncoder().encode(canonicalJson(validated.deployment as unknown as JsonValue)));
  const reserveConfigurationSha256 = sha256(new TextEncoder().encode(canonicalJson(validated.reserveGenesis as unknown as JsonValue)));
  fixture.pins.approval.configurationSha256 = configurationSha256;
  fixture.pins.approval.reserveConfigurationSha256 = reserveConfigurationSha256;
  (fixture.pins.expectations as { configurationSha256: Hex; reserveConfigurationSha256: Hex }).configurationSha256 = configurationSha256;
  (fixture.pins.expectations as { configurationSha256: Hex; reserveConfigurationSha256: Hex }).reserveConfigurationSha256 = reserveConfigurationSha256;
  const result = prepareProductionDeployment(fixture.value, fixture.pins, fixture.ports, sha256);
  assert.equal(result.prepared, undefined);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "PRODUCTION_RESERVE_RECIPIENT_BINDING"));
});

test("production preparation rejects caller-asserted nonce, calldata, intent, Safe and policy mutations", () => {
  const cases: readonly [(fixture: ReturnType<typeof syntheticPreparation>) => void, string][] = [
    [fixture => { (fixture.pins.expectations.operations[1] as { nonce: string }).nonce = "12"; }, "PRODUCTION_NONCE_SEQUENCE"],
    [fixture => { (fixture.pins.expectations.operations[3] as { calldata: Hex }).calldata = "0x12345678"; }, "PRODUCTION_FUND_CALLDATA"],
    [fixture => { (fixture.pins.expectations.operations[0] as { intentHash: Hex }).intentHash = hash("invented"); }, "PRODUCTION_INTENT_HASH"],
    [fixture => { (fixture.pins.expectations.authority[0] as { owners: readonly Hex[] }).owners = [`0x${"1".repeat(40)}`, `0x${"2".repeat(40)}`, `0x${"3".repeat(40)}`]; }, "PRODUCTION_EXPECTATIONS"],
    [fixture => { (fixture.pins.expectations.operations[0] as { maxFeePerGas: string }).maxFeePerGas = "10000000001"; }, "PRODUCTION_GAS_FEE_POLICY"],
  ];
  for (const [mutate, code] of cases) {
    const fixture = syntheticPreparation(); mutate(fixture);
    const result = prepareProductionDeployment(fixture.value, fixture.pins, fixture.ports, sha256);
    assert.equal(result.prepared, undefined, code);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === code), code);
  }
});

test("production preparation rejects all-zero Safe code and provenance evidence digests", () => {
  const zeroDigest = `0x${"0".repeat(64)}` as Hex;
  for (const field of ["proxyCodeHash", "singletonCodeHash", "setupProvenance"] as const) {
    const fixture = syntheticPreparation();
    (fixture.pins.expectations.authority[0] as unknown as Record<string, Hex>)[field] = zeroDigest;
    const result = prepareProductionDeployment(fixture.value, fixture.pins, fixture.ports, sha256);
    assert.equal(result.prepared, undefined, field);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "PRODUCTION_EXPECTATIONS"), field);
  }
});

test("runtime immutable claims remain explicitly unresolved while preparation stays truthful", () => {
  const fixture = syntheticPreparation();
  const artifact = fixture.pins.artifacts[0] as unknown as { runtimeBytecode: Hex; immutableReferences: { start: number; length: 32 }[] };
  artifact.runtimeBytecode = `0x${"00".repeat(33)}`;
  artifact.immutableReferences = [{ start: 1, length: 32 }];
  const operation = fixture.pins.expectations.operations.find(item => item.id === "controller-create") as { runtime: Hex; runtimeHash: Hex };
  operation.runtime = artifact.runtimeBytecode; operation.runtimeHash = sha256(Uint8Array.from({ length: 33 }, () => 0));
  (fixture.pins.expectations as { artifactPinsSha256: Hex }).artifactPinsSha256 = sha256(new TextEncoder().encode(canonicalJson({ schema: "agtmai-production-artifact-pins-v1", sourceRevision: fixture.pins.artifactSourceRevision, artifacts: fixture.pins.artifacts.toSorted((left, right) => left.contract.localeCompare(right.contract)) } as unknown as JsonValue)));
  const result = prepareProductionDeployment(fixture.value, fixture.pins, fixture.ports, sha256);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.prepared?.runtimeVerification.status, "unresolved-immutables");
  assert.equal(result.prepared?.runtimeVerification.reason, "PRODUCTION_RUNTIME_IMMUTABLES_REQUIRE_DETERMINISTIC_LOCAL_EXECUTION");
});
