import assert from "node:assert/strict";
import test from "node:test";
import { prepareLocalPurposeGenesis, verifyPreparedLocalPurposeGenesis, verifyLocalPurposePreflight, type LocalPurposeArtifact, type LocalPurposePreflight } from "../src/features/genesis-manifest/application/prepare-local-purpose-genesis.js";
import { encodeLocalPurposeToken, encodeLocalPurposeVault, encodeProductionFounderReserve, encodeProductionFounderVault, encodeProductionReserveController, encodeDeploymentToken } from "../src/features/genesis-manifest/adapters/deployment-abi.js";
import { materializeObservedAssemblyManifest, type LocalAssemblyObservation } from "../src/features/genesis-manifest/application/deployment-manifest.js";
import { checkPassport, generatePassport } from "../src/features/genesis-manifest/application/passport.js";
import { deploymentCreateAddress, keccakBytes } from "../src/features/genesis-manifest/adapters/deployment-observations.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { validateProductionDeployment } from "../src/features/genesis-manifest/domain/production-deployment.js";
import { PURPOSE_ALLOCATION_IDS } from "../src/features/genesis-manifest/domain/local-purpose-genesis.js";
import { syntheticProductionEnvelope } from "./production-fixture.js";
import { encodeAllocationId, normalizeAllocationSet } from "../src/features/genesis-manifest/domain/model.js";
import type { DeploymentConfig, Hex } from "../src/features/genesis-manifest/domain/deployment.js";
import { constructProductionAssembly } from "../src/features/genesis-manifest/application/prepare-production-deployment.js";
import { productionCompilerPorts } from "../src/features/genesis-manifest/composition/deployment-files.js";

const word = (value: bigint) => value.toString(16).padStart(64, "0");

const revision = "75645430c20e9cbbf02531972600484c8aea10ee";
const localPurposeCompilerPorts = { sha256, keccak256: keccakBytes, createAddress: deploymentCreateAddress,
  encodeToken: encodeLocalPurposeToken, encodeFounderReserve: encodeProductionFounderReserve,
  encodeReserveController: encodeProductionReserveController, encodePurposeVault: encodeLocalPurposeVault };
const sender = `0x${"9".repeat(40)}` as const;
const names = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController", "PurposeReserveVault", "GrantVault"] as const;
const immutables = [
  ["GENESIS_ALLOCATION_HASH", "INITIAL_CCIP_ADMIN", "INITIAL_SUPPLY"],
  ["TOKEN", "VAULT"],
  ["CONTROLLER", "PER_GRANT_CAP", "PURPOSE", "ROLLING_CAP", "TOKEN"],
  ["CONTROLLER", "OPENS_AT", "PURPOSE", "ROLLING_CAP", "TOKEN", "WINDOW_SECONDS"],
  ["BENEFICIARY", "CONTROLLER", "ORIGINAL_RESERVE", "TOKEN"],
];
const artifacts: LocalPurposeArtifact[] = names.map((contract, i) => ({ contract, compilerVersion: "0.8.36",
  creationBytecode: `0x60${i.toString(16).padStart(2, "0")}` as Hex, runtimeBytecode: `0x${"00".repeat(32 * 7)}` as Hex,
  artifactSha256: `0x${"1".repeat(64)}` as Hex, buildInfoSha256: `0x${"2".repeat(64)}` as Hex,
  compilerInputSha256: `0x${"3".repeat(64)}` as Hex,
  immutableReferences: immutables[i]!.map((name, j) => ({ name, start: j * 32, length: 32 as const })) }));

function fixture(): Record<string, any> {
  const source = syntheticProductionEnvelope() as Record<string, any>;
  const reserve = structuredClone(source.reserveGenesis);
  delete reserve.schema; delete reserve.status;
  const safes = source.deployment.custodySafes;
  reserve.allocations.forEach((allocation: Record<string, any>) => {
    const index = allocation.id === "founder" ? 1 : allocation.id === "contributors" ? 2 : PURPOSE_ALLOCATION_IDS.indexOf(allocation.id as never) + 3;
    allocation.recipient = localPurposeCompilerPorts.createAddress(sender, String(8 + index));
  });
  return { schema: "agtmai-local-purpose-genesis-v1", status: "test-only", chainId: "31337", tokenContract: "AGTMAICCIPToken",
    reserve, custodySafes: safes, projectControllerSafeId: "project-controller", founderBeneficiarySafeId: "founder-beneficiary",
    roleAliases: [
      { address: safes[0].address, roles: ["safe.project-controller.address", "token.initialCCIPAdmin", "founder.controller", "contributors.controller"] },
      { address: safes[1].address, roles: ["safe.founder-beneficiary.address", "founder.beneficiary"] },
    ],
    purposeVaults: PURPOSE_ALLOCATION_IDS.map((allocationId, i) => ({ allocationId, opensAt: String(1900000000 + i * 1000),
      windowSeconds: String(86400 + i), rollingCapBaseUnits: "1000000000000000" })),
    execution: { sender, startingNonce: "8", fundingDeadline: "1799999940", fundingLeadSeconds: "60",
      executionDeadline: "1800000100", maxFeePerGasWei: "10000000000", maxPriorityFeePerGasWei: "1000000000",
      maxGasPerTransaction: "6000000", maxTotalFeeWei: "300000000000000000" } };
}
const plan = (value: unknown, pins = artifacts) => prepareLocalPurposeGenesis(value, revision, { sourceRevision: revision, artifacts: pins }, localPurposeCompilerPorts);

test("existing v1 token ABI and allocation commitment remain byte-for-byte stable", () => {
  const deployment = syntheticProductionEnvelope().deployment as DeploymentConfig;
  const normalized = normalizeAllocationSet(deployment.token.initialSupplyBaseUnits, deployment.allocations, "deployment");
  assert.ok(normalized.allocations);
  const actual = encodeDeploymentToken(deployment, normalized.allocations);
  const expectedArgs = `0x${word(BigInt(deployment.token.initialSupplyBaseUnits))}${word(96n)}${deployment.token.initialCCIPAdmin!.slice(2).padStart(64, "0")}`
    + `${word(BigInt(normalized.allocations.length))}${normalized.allocations.map(a =>
      `${a.idBytes32.slice(2)}${a.recipient.slice(2).padStart(64, "0")}${word(BigInt(a.amountBaseUnits))}`).join("")}`;
  assert.equal(actual.constructorArgs, expectedArgs);
  // Independent Foundry 1.8.0 cast abi-encode + keccak vector for the v1 tuple:
  // domain, chain 1, name/symbol hashes, decimals 9, supply 10^17, sorted allocations.
  assert.equal(actual.genesisAllocationHash, "0x434dbfaa6fdefb3a843e981e8ef04009e88d14b48a040396aa2e5075add44d53");
  assert.deepEqual(actual, encodeLocalPurposeToken(deployment.environment.evmChainId, deployment.token.initialSupplyBaseUnits,
    deployment.token.initialCCIPAdmin!, normalized.allocations));
});

test("closed order binds nine CREATE addresses and founder funding at nonce n+9", () => {
  const prepared = plan(fixture());
  assert.deepEqual(prepared.operations.map(o => o.id), ["token-create", "founder-reserve-create", "controller-create",
    ...PURPOSE_ALLOCATION_IDS.map(id => `purpose-${id}-create`), "founder-fund"]);
  assert.deepEqual(prepared.operations.map(o => o.nonce), Array.from({ length: 10 }, (_, i) => String(8 + i)));
  assert.equal(prepared.operations[1]?.nestedAddress, localPurposeCompilerPorts.createAddress(prepared.operations[1]!.expectedAddress!, "1"));
  assert.equal(prepared.operations[9]?.to, prepared.operations[1]?.expectedAddress);
  assert.equal(prepared.operations[9]?.calldata, "0xb60d4288");
  assert.equal(prepared.broadcastAllowed, false);
  assert.equal(validateProductionDeployment(prepared).value, undefined);
});

test("EIP-2681 permits ten operations at max-10 and rejects max-9", () => {
  const max = 18446744073709551615n;
  const source = fixture(); source.execution.startingNonce = String(max - 10n);
  for (const allocation of source.reserve.allocations) {
    const offset = allocation.id === "founder" ? 1 : allocation.id === "contributors" ? 2 : PURPOSE_ALLOCATION_IDS.indexOf(allocation.id) + 3;
    allocation.recipient = deploymentCreateAddress(sender, String(max - 10n + BigInt(offset)));
  }
  const production = syntheticProductionEnvelope() as Record<string, any>;
  production.schema = "agtmai-production-deployment-v2"; production.deployment.bridge = null;
  production.deployment.policy.executionDeadline = source.execution.executionDeadline;
  production.purposeVaults = source.purposeVaults;
  const construct = (startingNonce: string) => {
    const selected = structuredClone(production);
    for (const allocations of [selected.deployment.allocations, selected.reserveGenesis.allocations]) {
      for (const allocation of allocations) {
        const offset = allocation.id === "founder" ? 1 : allocation.id === "contributors" ? 2 : PURPOSE_ALLOCATION_IDS.indexOf(allocation.id) + 3;
        allocation.recipient = deploymentCreateAddress(sender, String(BigInt(startingNonce) + BigInt(offset)));
      }
    }
    return constructProductionAssembly(selected, { sourceRevision: revision, artifacts, sender, startingNonce }, productionCompilerPorts, sha256);
  };
  const assembly = construct(String(max - 10n));
  assert.equal(assembly.operations.length, 10);
  assert.equal(assembly.operations[0]!.nonce, String(max - 10n));
  assert.equal(assembly.operations[9]!.nonce, String(max - 1n));
  assert.ok(assembly.operations.every(op => BigInt(op.nonce) < max));
  assert.doesNotThrow(() => plan(source));
  source.execution.startingNonce = String(max - 9n);
  assert.throws(() => plan(source), /LOCAL_PURPOSE_GENESIS_INVALID/);
  assert.throws(() => construct(String(max - 9n)), /LOCAL_PURPOSE_PLAN_INVALID/);
});

test("each purpose constructor binds its own encoded purpose and distinct opening/window", () => {
  const prepared = plan(fixture());
  for (const [i, id] of PURPOSE_ALLOCATION_IDS.entries()) {
    const words = prepared.operations[i + 3]!.initcode!.slice(6).match(/.{64}/g)!;
    assert.equal(`0x${words[2]}`, encodeAllocationId(id));
    assert.equal(BigInt(`0x${words[3]}`), 1900000000n + BigInt(i) * 1000n);
    assert.equal(BigInt(`0x${words[4]}`), 86400n + BigInt(i));
  }
});

test("recipient drift rejects prefunded wrong CREATE target, including equal-share swap", () => {
  const changed = fixture();
  [changed.reserve.allocations[0].recipient, changed.reserve.allocations[1].recipient] =
    [changed.reserve.allocations[1].recipient, changed.reserve.allocations[0].recipient];
  assert.throws(() => plan(changed), /LOCAL_PURPOSE_PLAN_INVALID/);
});

test("policy, candidate and artifact changes alter the domain-separated plan", () => {
  const original = plan(fixture());
  const changed = fixture(); changed.purposeVaults[0].rollingCapBaseUnits = "900000000000000";
  assert.notEqual(plan(changed).planSha256, original.planSha256);
  const swapped = fixture();
  [swapped.purposeVaults[0].allocationId, swapped.purposeVaults[1].allocationId] =
    [swapped.purposeVaults[1].allocationId, swapped.purposeVaults[0].allocationId];
  assert.notEqual(plan(swapped).planSha256, original.planSha256);
  assert.throws(() => verifyPreparedLocalPurposeGenesis(swapped, revision, { sourceRevision: revision, artifacts }, original, localPurposeCompilerPorts),
    /LOCAL_PURPOSE_PLAN_INVALID/);
  assert.notEqual(prepareLocalPurposeGenesis(fixture(), "a".repeat(40), { sourceRevision: "a".repeat(40), artifacts }, localPurposeCompilerPorts).planSha256, original.planSha256);
  assert.throws(() => prepareLocalPurposeGenesis(fixture(), revision, { sourceRevision: "a".repeat(40), artifacts }, localPurposeCompilerPorts), /LOCAL_PURPOSE_PLAN_INVALID/);
  assert.notEqual(plan(fixture(), artifacts.map((a, i) => i === 0 ? { ...a, artifactSha256: `0x${"4".repeat(64)}` as Hex } : a)).planSha256, original.planSha256);
  assert.throws(() => plan(fixture(), artifacts.map((a, i) => i === 3 ? { ...a, immutableReferences: [] } : a)), /LOCAL_PURPOSE_PLAN_INVALID/);
  assert.throws(() => plan(fixture(), artifacts.map((a, i) => i === 3 ? { ...a, unexpected: "ignored?" } : a)), /LOCAL_PURPOSE_PLAN_INVALID/);
});

test("preflight rejects any prefunded predicted or nested address before token mint", () => {
  const prepared = plan(fixture());
  const targets = [...prepared.operations.slice(0, 9).map(o => o.expectedAddress!), prepared.operations[1]!.nestedAddress!];
  const observed: LocalPurposePreflight = { chainId: "31337", blockHash: `0x${"a".repeat(64)}` as Hex,
    blockNumber: "1", timestamp: "1799999900", sender, nextNonce: "8",
    accounts: targets.map(address => ({ address, code: "0x", nonce: "0" })) };
  assert.doesNotThrow(() => verifyLocalPurposePreflight(prepared, observed));
  assert.throws(() => verifyLocalPurposePreflight(prepared, { ...observed, accounts: observed.accounts.map((a, i) =>
    i === 9 ? { ...a, code: "0x6000" } : a) }), /LOCAL_PURPOSE_PLAN_INVALID/);
  assert.throws(() => verifyLocalPurposePreflight(prepared, { ...observed, accounts: observed.accounts.map((a, i) =>
    i === 0 ? { ...a, nonce: "1" } : a) }), /LOCAL_PURPOSE_PLAN_INVALID/);
  assert.throws(() => verifyLocalPurposePreflight(prepared, { ...observed, nextNonce: "9" }), /LOCAL_PURPOSE_PLAN_INVALID/);
  assert.throws(() => verifyLocalPurposePreflight(prepared, { ...observed, timestamp: "1799999941" }), /LOCAL_PURPOSE_PLAN_INVALID/);
});

test("selected plan reconstruction rejects reordered or altered published operations", () => {
  const source = fixture();
  const pins = { sourceRevision: revision, artifacts };
  const prepared = prepareLocalPurposeGenesis(source, revision, pins, localPurposeCompilerPorts);
  assert.doesNotThrow(() => verifyPreparedLocalPurposeGenesis(source, revision, pins, prepared, localPurposeCompilerPorts));
  const reordered = { ...prepared, operations: [prepared.operations[1]!, prepared.operations[0]!, ...prepared.operations.slice(2)] };
  assert.throws(() => verifyPreparedLocalPurposeGenesis(source, revision, pins, reordered, localPurposeCompilerPorts), /LOCAL_PURPOSE_PLAN_INVALID/);
  const wrongFunding = { ...prepared, operations: prepared.operations.map((operation, i) =>
    i === 9 ? { ...operation, to: prepared.operations[2]!.expectedAddress! } : operation) };
  assert.throws(() => verifyPreparedLocalPurposeGenesis(source, revision, pins, wrongFunding, localPurposeCompilerPorts), /LOCAL_PURPOSE_PLAN_INVALID/);
});

/** Simulated report records only: fake artifact/code/provenance bytes cannot qualify an EVM or a Safe. */
function syntheticAssemblyReport() {
  const input = fixture(); input.schema = "agtmai-local-purpose-genesis-v2"; input.chainId = "1";
  const ports = { ...localPurposeCompilerPorts, encodeFounderVault: encodeProductionFounderVault };
  const prepared = prepareLocalPurposeGenesis(input, revision, { sourceRevision: revision, artifacts }, ports);
  const block = (i: number) => ({ number: String(20 + i), hash: `0x${word(BigInt(100 + i))}` as Hex, timestamp: String(1799999900 + i) });
  const abi = (v: string): Hex => `0x${word(BigInt(v))}`;
  const founder = prepared.configuration.reserve.founder, founderAmount = "3000000000000000";
  const terms = [founderAmount, founder.schedule.start, founder.schedule.cliff, founder.schedule.end, "0"].map(v => word(BigInt(v))).join("") + founder.purpose.slice(2);
  const operations: LocalAssemblyObservation["operations"] = prepared.operations.map((op, i) => ({ id: op.id, nonce: op.nonce, sender, chainId: "1", input: (op.initcode ?? op.calldata)!, value: "0",
    gasEstimate: "101", gasLimit: "122", baseFeePerGas: "8", blockGasLimit: "6000000", maxPriorityFeePerGas: "1", maxFeePerGas: "10", gasUsed: "100", effectiveGasPrice: "9", observedCostWei: "900",
    predecessor: block(i), block: block(i + 1), parentHash: block(i).hash, transactionHash: `0x${word(BigInt(i + 200))}` as Hex, status: "1", actualAddress: (op.expectedAddress ?? op.to)!,
    logs: i === 1 ? [{ address: prepared.constructors![9]!.predictedAddress,
      topics: [keccakBytes(new TextEncoder().encode("GrantConfigured(address,address,address,address,(uint256,uint64,uint64,uint64,uint8,bytes32))")), abi(prepared.constructors![0]!.predictedAddress), abi(founder.beneficiary), abi(prepared.constructors![1]!.predictedAddress)],
      data: `0x${word(BigInt(founder.controller))}${terms}`, removed: false, logIndex: "0" }] : [] }));
  const contracts: LocalAssemblyObservation["contracts"] = prepared.constructors!.map(c => {
    const getters: Record<string, Hex> = Object.fromEntries(Object.entries(c.immutableValues).map(([name, value]) => [name === "INITIAL_CCIP_ADMIN" ? "getCCIPAdmin" : name, value]));
    if (c.contract === "AGTMAICCIPToken") { Object.assign(getters, { totalSupply: abi("100000000000000000"), decimals: abi("9") }); }
    if (c.contract === "ReserveController") { Object.assign(getters, { WINDOW: abi("31536000"), grossCommitted: abi("0"), rollingCommitted: abi("0") }); }
    if (c.contract === "PurposeReserveVault") { Object.assign(getters, { grossOutflow: abi("0"), rollingOutflow: abi("0") }); }
    if (c.contract === "GrantVault") { Object.assign(getters, { funded: abi("1"), grant: `0x${terms}${[0n, 0n, 0n, 1n, 0n].map(word).join("")}` }); }
    return { id: c.id, address: c.predictedAddress, runtime: c.materializedRuntime, nonce: c.contract === "FounderGrantReserve" ? "2" : "1", getters,
      balance: c.id === "founder-vault" ? founderAmount : c.id === "founder-reserve-create" ? "0" : prepared.configuration.reserve.allocations.find(a => a.recipient === c.predictedAddress)?.amountBaseUnits ?? "0" };
  });
  const authority = prepared.configuration.custodySafes.map(s => ({ address: s.address, owners: s.owners, threshold: 2 as const, nonce: "0", proxyCodeHash: block(0).hash, singletonCodeHash: block(1).hash,
    singletonAddress: `0x${"a".repeat(40)}` as Hex, singletonSlot: abi(`0x${"a".repeat(40)}`), modules: [], guard: null, fallbackHandler: null, setupProvenance: block(2).hash }));
  const observation: LocalAssemblyObservation = { operations, contracts, authority, gasBufferBps: 2000, observedWei: "9000", genesis: block(10),
    fundingBefore: { block: block(9), reserveBalance: founderAmount, vaultBalance: "0", allowance: "0", funded: abi("0") },
    fundingAfter: { allowance: "0", repeatCallRevert: keccakBytes(new TextEncoder().encode("AlreadyFunded()")).slice(0, 10) as Hex } };
  return { prepared, observation, ports };
}

test("synthetic full report preserves nested provenance, integer sums and non-production facts", () => {
  const { prepared, observation, ports } = syntheticAssemblyReport();
  const manifest = materializeObservedAssemblyManifest(prepared, observation, ports);
  assert.equal(manifest.observedWei, "9000"); assert.equal(manifest.worstCaseWei, "12200");
  assert.equal(manifest.contracts.length, 10); assert.equal(manifest.gas.length, 10);
  const child = manifest.contracts[9]!.observed;
  assert.ok("parentTransactionHash" in child);
  assert.equal(child.parentTransactionHash, observation.operations[1]!.transactionHash);
  assert.equal(Object.hasOwn(manifest.contracts[9]!.observed, "transactionHash"), false);
  assert.equal(manifest.approval, null); assert.equal(manifest.broadcastAllowed, false);
  assert.equal(manifest.facts.approval, null); assert.equal(manifest.actualProductionDeployment, "unavailable");
  const interval = { schema: "agtmai-deployment-observations-v1" as const, observedAt: observation.genesis.timestamp, validUntil: observation.genesis.timestamp };
  const passport = generatePassport(manifest, interval, { sha256 });
  assert.match(passport.markdown, /after execution of pre-frozen inventory/);
  assert.match(passport.markdown, /Live Ethereum fees and ETH\/USD unavailable/);
  assert.equal(passport.authorityRegistry.entries.filter(e => e.mechanism === "safe").length, 2);
  const tampered = { ...passport }; delete tampered.broadcastAllowed;
  assert.throws(() => checkPassport(manifest, interval, tampered, { sha256 }), /PASSPORT_MISMATCH/);
});

test("synthetic full report rejects contradictory parent, funding, cost and genesis records", () => {
  const { prepared, observation, ports } = syntheticAssemblyReport();
  const mutations: readonly ((o: any) => void)[] = [
    o => { o.operations[1].parentHash = o.operations[1].block.hash; },
    o => { o.operations[0].observedCostWei = "901"; },
    o => { o.observedWei = "8999"; },
    o => { o.operations[0].gasLimit = "121"; },
    o => { o.contracts[9].transactionHash = o.operations[1].transactionHash; },
    o => { o.operations[1].logs = []; },
    o => { o.fundingBefore.reserveBalance = "0"; },
    o => { o.fundingAfter.allowance = "1"; },
    o => { o.contracts[3].balance = "0"; },
    o => { o.contracts[9].getters.grant = "0x"; },
    o => { o.genesis = o.operations[8].block; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(observation); mutate(changed);
    assert.throws(() => materializeObservedAssemblyManifest(prepared, changed, ports), /DEPLOYMENT_EVIDENCE_ASSEMBLY_/);
  }
});
