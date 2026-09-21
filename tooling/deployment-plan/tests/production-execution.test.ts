import assert from "node:assert/strict";
import test from "node:test";
import { assessProductionPreflight, type ProductionPreflightRequest } from "../src/application/production-preflight.ts";
import { parseProductionObservation } from "../src/adapters/production-inputs.ts";
import { parseProductionJsonWithoutDuplicates } from "../src/adapters/strict-json.ts";
import { deriveCreateAddress, keccak256 } from "../src/domain/identity.ts";
import type { ProductionObservation } from "../src/domain/production-guards.ts";

const digest = (digit: string): string => `0x${digit.repeat(64)}`;
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const addressWord = (value: string): string => `0x${value.slice(2).padStart(64, "0")}`;
const staticRuntime = `0x${"00".repeat(64)}`;
const amounts = ["30000000000000000", "30000000000000000", "3000000000000000", "17000000000000000", "9000000000000000", "5000000000000000", "5000000000000000", "1000000000000000"];
const ids = ["long-term", "users", "founder", "contributors", "operations", "ecosystem", "financing", "liquidity"];
const bps = [3000, 3000, 300, 1700, 900, 500, 500, 100];
type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[] : T extends object ? {-readonly [Key in keyof T]: Mutable<T[Key]>} : T;
type MutableRequest = Mutable<ProductionPreflightRequest>;
interface TestOperation { id: string; kind: "create" | "call"; intentHash: string; nonce: string; expectedAddress: string; nestedAddress?: string; initcode?: string; initcodeHash?: string; runtime?: string; runtimeHash?: string; calldata?: string; gasEstimate: string; gasLimit: string; baseFeePerGas: string; maxPriorityFeePerGas: string; maxFeePerGas: string; blockGasLimit: string; value: string }

function executionFixture(): ProductionPreflightRequest {
  const sender = address("9"), token = deriveCreateAddress(sender, 0n), reserve = deriveCreateAddress(sender, 1n), controller = deriveCreateAddress(sender, 2n), vault = deriveCreateAddress(reserve, 1n), allocationHash = digest("a");
  const configuredAllocations = ids.map((id, index) => ({ id, bps: bps[index], amountBaseUnits: amounts[index]!, recipient: index === 2 ? reserve : address(String(index + 1)) }));
  const immutableBindings = [
    [{name: "INITIAL_SUPPLY", value: `0x${BigInt("100000000000000000").toString(16).padStart(64, "0")}`}, {name: "GENESIS_ALLOCATION_HASH", value: allocationHash}],
    [{name: "TOKEN", value: addressWord(token)}, {name: "VAULT", value: addressWord(vault)}],
    [{name: "TOKEN", value: addressWord(token)}, {name: "PURPOSE", value: digest("4")}],
  ] as const;
  const operationDefinitions: {id: string; kind: "create" | "call"; expectedAddress: string; nestedAddress?: string}[] = [
    {id: "token-create", kind: "create", expectedAddress: token},
    {id: "founder-reserve-create", kind: "create", expectedAddress: reserve, nestedAddress: vault},
    {id: "controller-create", kind: "create", expectedAddress: controller},
    {id: "founder-fund", kind: "call", expectedAddress: reserve},
  ] as const;
  const operations: TestOperation[] = operationDefinitions.map((item, index) => ({ id: item.id, kind: item.kind, intentHash: digest(String(index + 2)), nonce: String(index), expectedAddress: item.expectedAddress, ...(item.kind === "create" ? { ...(item.id === "founder-reserve-create" ? {nestedAddress: vault} : {}), initcode: "0x6001", initcodeHash: keccak256(Buffer.from("6001", "hex")), runtime: staticRuntime, runtimeHash: keccak256(Buffer.from(staticRuntime.slice(2), "hex")) } : {calldata: "0xb60d4288"}), gasEstimate: "1", gasLimit: "1", baseFeePerGas: "0", maxPriorityFeePerGas: "0", maxFeePerGas: "1", blockGasLimit: "100", value: "0" }));
  const authority = ["a", "b"].map((digit, index) => ({ address: address(digit), owners: [address(String(index * 3 + 1)), address(String(index * 3 + 2)), address(String(index * 3 + 3))], threshold: 2, nonce: "0", proxyCodeHash: digest("1"), singletonCodeHash: digest("2"), singletonAddress: address("8"), singletonSlot: digest("3"), modules: [], guard: null, fallbackHandler: null, setupProvenance: digest("4") }));
  const expectations = { schema: "agtmai-production-expectations-v1", chainId: "1", sender, deployer: sender, configurationSha256: digest("5"), reserveConfigurationSha256: digest("6"), sourceRevision: "b".repeat(40), artifactPinsSha256: digest("7"), startingNonce: "0", maxObservationAgeSeconds: "100", operations, maxTotalCostWei: "4", attemptIdentity: digest("8"), authority } as const;
  const observedOperations = operations.map((item, index) => { const blockNumber = String(index + 11), blockHash = digest(String(index + 1)), transactionHash = digest(String(index + 5)), bindings = immutableBindings[index]; const runtime = bindings ? `0x${bindings.map(binding => binding.value.slice(2)).join("")}` : undefined; return { id: item.id, address: item.expectedAddress, ...(item.id === "founder-reserve-create" ? {nestedAddress: vault} : {}), ...(item.kind === "create" && bindings && runtime ? { creation: item.initcode!, runtime, runtimeHash: keccak256(Buffer.from(runtime.slice(2), "hex")), artifact: staticRuntime, artifactSha256: digest("1"), immutableReferences: bindings.map((binding, referenceIndex) => ({name: binding.name, start: String(referenceIndex * 32), length: "32", value: binding.value})) } : {calldata: item.calldata!}), value: "0", nonce: item.nonce, transactionHash, receiptTransactionHash: transactionHash, transactionIndex: "0", sender, input: item.kind === "create" ? item.initcode! : item.calldata!, status: "1", blockNumber, blockHash, timestamp: String(100 + index), expectedAddress: item.expectedAddress, actualAddress: item.expectedAddress, gasLimit: "1", maxFeePerGas: "1", maxPriorityFeePerGas: "0", gasUsed: "1", effectiveGasPrice: "1", observedCostWei: "1" }; });
  const allocations = configuredAllocations.map((allocation, index) => ({ identifier: allocation.id, bps: String(allocation.bps), amountBaseUnits: allocation.amountBaseUnits, recipient: allocation.recipient, balance: index === 2 ? "0" : allocation.amountBaseUnits, syntheticPreparedAddress: true as const }));
  const state = { blockNumber: "14", blockHash: digest("4"), token: { address: token, name: "Agent Teams AI", symbol: "AGTMAI", decimals: "9", initialSupply: "100000000000000000", totalSupply: "100000000000000000", genesisAllocationHash: allocationHash, ccipAdmin: address("b") }, founderReserve: { address: reserve, token, vault }, founderVault: { address: vault, token, beneficiary: address("a"), originalReserve: reserve, controller: address("b"), funded: true, terms: {allocation: amounts[2]!, start: "1800000000", cliff: "1800000001", end: "1800000002", kind: "0", originalPurpose: digest("3")} }, controller: { address: controller, token, controller: address("b"), purpose: digest("4"), rollingCap: "16000000000000000", perGrantCap: "5000000000000000", window: "31536000", grossCommitted: "0", rollingCommitted: "0" }, allocations, funding: { caller: sender, amountBaseUnits: amounts[2]!, beforeBlockNumber: "13", beforeBlockHash: digest("3"), afterBlockNumber: "14", afterBlockHash: digest("4"), reserveBefore: amounts[2]!, reserveAfter: "0", vaultBefore: "0", vaultAfter: amounts[2]!, allowanceBefore: "0", allowanceAfter: "0", fundedBefore: false, fundedAfter: true, secondCallRejected: true }, conservation: { totalSupplyBaseUnits: "100000000000000000", observedBalancesBaseUnits: "100000000000000000" } };
  const observations = { schema: "agtmai-production-observation-v2", chainId: "1", sender, pendingNonce: "4", blockNumber: "14", blockHash: digest("4"), observedAt: "100", expiresAt: "200", observedTotalCostWei: "4", rpcEndpoint: "http://127.0.0.1:8545/", netVersion: "1", binding: { sourceRevision: expectations.sourceRevision, configurationSha256: expectations.configurationSha256, reserveConfigurationSha256: expectations.reserveConfigurationSha256, artifactPinsSha256: expectations.artifactPinsSha256 }, operations: observedOperations, checkedAddresses: [...new Set([...configuredAllocations.map(item => item.recipient), token, reserve, controller, vault])].toSorted(), occupiedAddresses: [], authority, state, cleanup: { processExited: true, exitCode: "0", descriptorsClosed: true, temporaryRootRemoved: true, diagnostic: null } } as unknown as ProductionObservation;
  const artifacts = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"].map((contract, index) => ({contract, compilerVersion: "0.8.36", artifactSha256: digest("1"), buildInfoSha256: digest("2"), compilerInputSha256: digest("3"), creationBytecode: "0x6001", runtimeBytecode: staticRuntime, immutableReferences: immutableBindings[index]!.map((binding, referenceIndex) => ({name: binding.name, start: referenceIndex * 32, length: 32}))}));
  const policy = { evmMaxFeePerGasWei: "1", evmMaxPriorityFeePerGasWei: "0", evmMaxGasPerTransaction: "1", evmMaxTotalFeeWei: "4", observationMaxAgeSeconds: "100", estimateValiditySeconds: "100", executionDeadline: "1000", fundingDeadline: "900", fundingLeadSeconds: "100", gasBufferBps: 0, tokenExpenditureCeilingBaseUnits: amounts[2] };
  const configuration = { deployment: { status: "accepted", token: {initialCCIPAdmin: address("b")}, allocations: configuredAllocations, policy }, reserveGenesis: { allocations: configuredAllocations, founder: { beneficiary: address("a"), controller: address("b"), purpose: digest("3"), schedule: {start: "1800000000", cliff: "1800000001", end: "1800000002"} }, contributors: {controller: address("b"), purpose: digest("4"), rollingCapBaseUnits: "16000000000000000", perGrantCapBaseUnits: "5000000000000000"} } };
  const preparedOperations = operations.map(item => item.kind === "create" ? {id: item.id, kind: item.kind, intentHash: item.intentHash, nonce: item.nonce, expectedAddress: item.expectedAddress, ...(item.id === "founder-reserve-create" ? {nestedAddress: vault} : {}), initcode: item.initcode!, value: "0"} : {id: item.id, kind: item.kind, intentHash: item.intentHash, nonce: item.nonce, to: item.expectedAddress, calldata: item.calldata!, value: "0"});
  const prepared = { schema: "agtmai-prepared-production-deployment-v1", broadcastAllowed: false, coverage: "token-and-reserves-only", configurationSha256: expectations.configurationSha256, reserveConfigurationSha256: expectations.reserveConfigurationSha256, approval: {schema: "agtmai-production-approval-v1", configurationSha256: expectations.configurationSha256, reserveConfigurationSha256: expectations.reserveConfigurationSha256, reference: "review"}, artifacts, runtimeVerification: {status: "unresolved-immutables", reason: "PRODUCTION_RUNTIME_IMMUTABLES_REQUIRE_DETERMINISTIC_LOCAL_EXECUTION", contracts: artifacts.map(({contract, compilerVersion, compilerInputSha256, immutableReferences}) => ({contract, compilerVersion, compilerInputSha256, immutableReferences}))}, configuration, expectations, operations: preparedOperations };
  return { prepared, expectations: expectations as never, observations, attempt: {schema: "agtmai-production-attempt-state-v1", identity: expectations.attemptIdentity, states: operations.map(item => ({operationId: item.id, state: "finalized-success", intent: item.intentHash}))} as never, nowSeconds: 150n, preparedConfigurationSha256: expectations.configurationSha256, preparedReserveConfigurationSha256: expectations.reserveConfigurationSha256, preparedArtifactPinsSha256: expectations.artifactPinsSha256, expectedGenesisAllocationHash: allocationHash };
}

test("deterministic four-operation observation parses canonically and passes only offline", () => {
  const fixture = executionFixture();
  const parsed = parseProductionObservation(JSON.parse(JSON.stringify(fixture.observations)));
  const result = assessProductionPreflight({...fixture, observations: parsed});
  assert.equal(result.status, "checks-passed-offline");
  assert.equal(result.broadcastAllowed, false);
});

test("funding success rejects a founder vault that reports unfunded", () => {
  const fixture = executionFixture();
  const observation = structuredClone(fixture.observations) as Mutable<ProductionObservation>;
  observation.state!.founderVault.funded = false;
  const parsed = parseProductionObservation(JSON.parse(JSON.stringify(observation)));
  const result = assessProductionPreflight({...fixture, observations: parsed});
  assert.equal(result.status, "blocked");
  assert.equal(result.broadcastAllowed, false);
  assert.deepEqual(result.reasons, ["founder-funding-mismatch"]);
});

test("execution observation parser rejects schema drift, numbers and reordered inventory", () => {
  const fixture = executionFixture();
  for (const mutate of [
    (value: Record<string, unknown>) => {value.unknown = true;},
    (value: Record<string, unknown>) => {value.pendingNonce = 4;},
    (value: Record<string, unknown>) => {value.pendingNonce = "04";},
    (value: Record<string, unknown>) => {(value.operations as unknown[]).reverse();},
    (value: Record<string, unknown>) => {((value.operations as Record<string, unknown>[])[3]!).runtime = staticRuntime;},
  ]) { const value = structuredClone(fixture.observations) as unknown as Record<string, unknown>; mutate(value); assert.throws(() => parseProductionObservation(value), /PREFLIGHT_(SCHEMA|VALUE)/); }
  const source = JSON.stringify(fixture.observations).replace('"chainId":"1"', '"chainId":"1","chainId":"1"');
  assert.throws(() => parseProductionJsonWithoutDuplicates(new TextEncoder().encode(source)), /duplicate JSON member/);
});

test("every execution identity, state and cleanup mutation fails closed", () => {
  const cases: readonly [string, (value: MutableRequest) => void][] = [
    ["source binding", value => {value.observations.binding!.sourceRevision = "c".repeat(40);}], ["configuration", value => {value.observations.binding!.configurationSha256 = digest("f");}], ["reserve", value => {value.observations.binding!.reserveConfigurationSha256 = digest("f");}], ["artifacts", value => {value.observations.binding!.artifactPinsSha256 = digest("f");}],
    ["order", value => {(value.observations.operations as unknown[]).reverse();}], ["sender", value => {value.observations.operations[0]!.sender = address("8");}], ["nonce", value => {value.observations.operations[0]!.nonce = "1";}], ["calldata", value => {value.observations.operations[3]!.input = "0x12345678";}], ["value", value => {value.observations.operations[3]!.value = "1";}], ["create address", value => {value.observations.operations[0]!.actualAddress = address("8");}], ["transaction", value => {value.observations.operations[0]!.transactionHash = digest("f");}], ["receipt", value => {value.observations.operations[0]!.status = "0";}], ["block", value => {value.observations.operations[1]!.blockNumber = "99";}],
    ["transaction gas", value => {value.observations.operations[0]!.gasLimit = "2";}], ["transaction max fee", value => {value.observations.operations[0]!.maxFeePerGas = "2";}], ["receipt gas", value => {value.observations.operations[0]!.gasUsed = "2";}], ["receipt effective fee", value => {value.observations.operations[0]!.effectiveGasPrice = "2";}], ["operation cost", value => {value.observations.operations[0]!.observedCostWei = "2";}], ["aggregate cost", value => {value.observations.observedTotalCostWei = "5";}],
    ["chain", value => {value.observations.chainId = "2";}], ["endpoint", value => {value.observations.rpcEndpoint = "https://example.com";}], ["runtime", value => {value.observations.operations[0]!.runtime = staticRuntime;}], ["immutable", value => {value.observations.operations[0]!.immutableReferences![0]!.value = digest("f");}], ["immutable permutation", value => { const operation = value.observations.operations[0]!, references = operation.immutableReferences!; const first = references[0]!.value; references[0]!.value = references[1]!.value; references[1]!.value = first; operation.runtime = `0x${references.map(reference => reference.value.slice(2)).join("")}`; operation.runtimeHash = keccak256(Buffer.from(operation.runtime.slice(2), "hex")); }], ["getter", value => {value.observations.state!.token.symbol = "BAD";}], ["terms", value => {value.observations.state!.founderVault.terms.kind = "1";}], ["vault", value => {value.observations.state!.founderReserve.vault = address("8");}],
    ["allocation bps", value => {value.observations.state!.allocations[0]!.bps = "2999";}], ["allocation amount", value => {value.observations.state!.allocations[0]!.amountBaseUnits = "1";}], ["recipient", value => {value.observations.state!.allocations[0]!.recipient = address("8");}], ["balance", value => {value.observations.state!.allocations[0]!.balance = "1";}], ["supply", value => {value.observations.state!.token.totalSupply = "1";}], ["caller", value => {value.observations.state!.funding.caller = address("8");}], ["fund amount", value => {value.observations.state!.funding.amountBaseUnits = "1";}], ["allowance", value => {value.observations.state!.funding.allowanceAfter = "1";}], ["one shot", value => {value.observations.state!.funding.secondCallRejected = false as never;}],
    ["stale", value => {value.nowSeconds = 201n;}], ["replay", value => {value.observations.pendingNonce = "0";}], ["attempt", value => {value.attempt.states[0]!.state = "unattempted";}], ["cleanup", value => {value.observations.cleanup!.temporaryRootRemoved = false;}],
  ];
  for (const [label, mutate] of cases) {const fixture = structuredClone(executionFixture()) as MutableRequest; mutate(fixture); const result = assessProductionPreflight(fixture as ProductionPreflightRequest); assert.notEqual(result.status, "checks-passed-offline", label); assert.equal(result.broadcastAllowed, false, label);}
});
