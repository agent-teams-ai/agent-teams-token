import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareProductionDeployment, type ProductionArtifactPin, type ProductionExpectation } from "../src/features/genesis-manifest/application/prepare-production-deployment.js";
import { canonicalJson, type JsonValue } from "../src/features/genesis-manifest/application/canonical.js";
import type { Hex } from "../src/features/genesis-manifest/domain/deployment.js";
import { validateProductionDeployment } from "../src/features/genesis-manifest/domain/production-deployment.js";
import { calendarSchedule } from "../src/features/genesis-manifest/domain/grant-schedule.js";

function syntheticEnvelope(): Record<string, unknown> {
  const shares = [3000, 3000, 300, 1700, 900, 500, 500, 100];
  const ids = ["long-term", "users", "founder", "contributors", "operations", "ecosystem", "financing", "liquidity"];
  const allocations = shares.map((bps, index) => ({ id: ids[index], recipient: `0x${String(index + 1).padStart(40, "0")}`, amountBaseUnits: String(BigInt(bps) * 10_000_000_000_000n), bps }));
  const disabled = { enabled: false, capacity: "0", rate: "0" };
  const evm = "0x1111111111111111111111111111111111111111";
  const solana = "11111111111111111111111111111111";
  const safe = (id: string, address: string, owners: string[]) => ({ id, address, owners, threshold: 2, beneficialControl: "solo-founder", disclosure: "Synthetic test-only Safe identity." });
  const deployment = {
    schemaVersion: 1, deploymentId: "synthetic-production-envelope", status: "accepted",
    environment: { mode: "mainnet-dry-run", evmChainId: "1", solanaGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", evmSelector: "5009297550715157269", solanaSelector: "124615329519749607" },
    token: { name: "Agent Teams AI", symbol: "AGTMAI", decimals: 9, initialSupplyBaseUnits: "100000000000000000", initialCCIPAdmin: `0x${"b".repeat(40)}` },
    allocations, grants: [],
    custodySafes: [safe("project-controller", `0x${"b".repeat(40)}`, [`0x${"c".repeat(40)}`, `0x${"d".repeat(40)}`, `0x${"e".repeat(40)}`]), safe("founder-beneficiary", `0x${"a".repeat(40)}`, [`0x${"f".repeat(40)}`, `0x${"1".repeat(39)}2`, `0x${"1".repeat(39)}3`])],
    roleAliases: [{ address: `0x${"b".repeat(40)}`, roles: ["safe.project-controller.address", "token.initialCCIPAdmin"] }],
    bridge: { protocol: { reference: "synthetic-test-only", snapshotSha256: `0x${"1".repeat(64)}`, networkDataSha256: `0x${"2".repeat(64)}` }, ethereum: { token: null, pool: null, router: evm, rmn: evm, registry: evm, registryModule: evm, registryAdministrator: evm, poolOwner: evm, rateLimitAdministrator: evm, rebalancer: null, inbound: disabled, outbound: disabled }, solana: { mint: null, pool: null, poolSigner: null, poolTokenAccount: null, lookupTable: null, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", router: solana, offRamp: solana, rmn: solana, feeQuoter: solana, burnMintProgram: solana, poolAdministrator: solana, registryAdministrator: solana, upgradeAuthority: null, inbound: disabled, outbound: disabled } },
    testScenario: null, policy: { tokenExpenditureCeilingBaseUnits: "100000000000000000", evmMaxFeePerGasWei: "10000000000", evmMaxPriorityFeePerGasWei: "1000000000", evmMaxGasPerTransaction: "6000000", evmMaxTotalFeeWei: "300000000000000000", solanaMaxFeeLamports: "100000", solanaMaxTotalFeeLamports: "1000000", observationMaxAgeSeconds: "300", executionDeadline: "2000000000", fundingDeadline: "1799999940", fundingLeadSeconds: "60", estimateValiditySeconds: "120", gasBufferBps: 1500 },
  };
  return { schema: "agtmai-production-deployment-v1", deployment, reserveGenesis: { schema: "agtmai-reserve-genesis-v1", status: "accepted", initialSupplyBaseUnits: "100000000000000000", allocations, founder: { beneficiary: `0x${"a".repeat(40)}`, controller: `0x${"b".repeat(40)}`, purpose: `0x${"3".repeat(64)}`, schedule: calendarSchedule("1800000000") }, contributors: { controller: `0x${"b".repeat(40)}`, purpose: `0x${"4".repeat(64)}`, rollingCapBaseUnits: "16000000000000000", perGrantCapBaseUnits: "5000000000000000" } }, projectControllerSafeId: "project-controller", founderBeneficiarySafeId: "founder-beneficiary" };
}

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

const sha256 = (bytes: Uint8Array): Hex => `0x${createHash("sha256").update(bytes).digest("hex")}`;
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
    { contract: "ReserveController", creationBytecode: "0x03", runtimeBytecode: "0x33", artifactSha256: hash("controller-artifact"), buildInfoSha256: hash("controller-build"), compilerInputSha256: hash("controller-input"), immutableReferences: [] },
    { contract: "AGTMAICCIPToken", creationBytecode: "0x01", runtimeBytecode: "0x11", artifactSha256: hash("token-artifact"), buildInfoSha256: hash("token-build"), compilerInputSha256: hash("token-input"), immutableReferences: [] },
    { contract: "FounderGrantReserve", creationBytecode: "0x02", runtimeBytecode: "0x22", artifactSha256: hash("founder-artifact"), buildInfoSha256: hash("founder-build"), compilerInputSha256: hash("founder-input"), immutableReferences: [] },
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
  const operations: ProductionExpectation["operations"] = [
    { id: "token-create", kind: "create", intentHash: hash("token-intent"), nonce: "10", expectedAddress: `0x${"6".repeat(40)}`, initcode: tokenInitcode, initcodeHash: sha256(Uint8Array.from([0x01, 0xaa])), runtime: "0x11", runtimeHash: sha256(Uint8Array.from([0x11])) },
    { id: "founder-reserve-create", kind: "create", intentHash: hash("founder-intent"), nonce: "11", expectedAddress: founderReserve, nestedAddress: nestedFounderVault, initcode: founderInitcode, initcodeHash: sha256(Uint8Array.from([0x02, 0xbb])), runtime: "0x22", runtimeHash: sha256(Uint8Array.from([0x22])) },
    { id: "controller-create", kind: "create", intentHash: hash("controller-intent"), nonce: "12", expectedAddress: contributorReserve, initcode: controllerInitcode, initcodeHash: sha256(Uint8Array.from([0x03, 0xcc])), runtime: "0x33", runtimeHash: sha256(Uint8Array.from([0x33])) },
    { id: "founder-fund", kind: "call", intentHash: hash("fund-intent"), nonce: "13", expectedAddress: founderReserve },
  ];
  const expectations: ProductionExpectation = { schema: "agtmai-production-expectations-v1", chainId: "1", sourceRevision, configurationSha256, reserveConfigurationSha256, artifactPinsSha256, attemptIdentity: hash("attempt"), sender: `0x${"5".repeat(40)}`, deployer: `0x${"5".repeat(40)}`, startingNonce: "10", maxObservationAgeSeconds: "300", maxTotalCostWei: "100000000000000000", authority: deployment.custodySafes.map(safeState), operations };
  return {
    value,
    pins: { artifactSourceRevision: sourceRevision, artifacts, approval: { schema: "agtmai-production-approval-v1", configurationSha256, reserveConfigurationSha256, reference: "synthetic-review" }, expectations },
    ports: { encodeToken: () => ({ constructorArgs: "0xaa" }), encodeFounderReserve: () => "0xbb", encodeReserveController: () => "0xcc", keccak256: sha256, createAddress: () => nestedFounderVault },
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
  for (const allocations of [value.deployment.allocations, value.reserveGenesis.allocations]) allocations.find(allocation => allocation.id === "founder")!.recipient = `0x${"4".repeat(40)}`;
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
