import { verifyPreparedLocalPurposeGenesis, type PreparedLocalPurposeGenesis, type LocalPurposePorts } from "./prepare-local-purpose-genesis.js";
import { projectLocalAssemblyFacts } from "./reserve-facts.js";
import { compileDeployment, deploymentBytes, prepareGrant, type DeploymentCompilerPorts, type PreparedDeployment, type DeploymentArtifact } from "./compile-deployment.js";
import { isDigest, isEvmAddress, type DeploymentConfig, type DeploymentGrant, type Hex } from "../domain/deployment.js";
import { parseCanonicalUint, UINT64_MAX } from "../domain/model.js";
import { prepareProductionDeployment, type PreparedProductionDeployment, type ProductionPreparationPorts } from "./prepare-production-deployment.js";

export interface DeploymentBlock { readonly number: string; readonly hash: Hex; readonly timestamp: string }
export interface ContractDeploymentEvidence {
  readonly address: Hex;
  readonly transaction: { readonly hash: Hex; readonly from: Hex; readonly nonce: string; readonly chainId: string; readonly to: null; readonly value: "0"; readonly input: Hex };
  readonly receipt: { readonly transactionHash: Hex; readonly blockHash: Hex; readonly blockNumber: string; readonly contractAddress: Hex; readonly status: 1; readonly gasUsed: string; readonly effectiveGasPrice: string; readonly logs: readonly { readonly address: Hex; readonly topics: readonly Hex[]; readonly data: Hex; readonly logIndex: string; readonly removed: false }[] };
  readonly blockBefore: DeploymentBlock; readonly blockAfter: DeploymentBlock; readonly finalizedBlock: DeploymentBlock;
  readonly runtime: { readonly blockHash: Hex; readonly blockNumber: string; readonly code: Hex };
  readonly calls: readonly { readonly to: Hex; readonly data: Hex; readonly result: Hex; readonly blockHash: Hex; readonly blockNumber: string }[];
}
export interface DeploymentEvidence {
  readonly schema: "agtmai-deployment-evidence-v1";
  readonly configurationSha256: Hex;
  readonly collector: { readonly kind: "local-anvil" | "owned-testnet-rpc" | "mainnet-read-only-rpc"; readonly sourceRevision: string };
  readonly token: ContractDeploymentEvidence | null;
  readonly grants: readonly { readonly grantId: string; readonly deployment: ContractDeploymentEvidence }[];
}
export interface ExpectedCreationState { readonly calls: Readonly<Record<Hex, Hex>>; readonly logs: readonly { readonly topics: readonly Hex[]; readonly data: Hex }[] }
export interface DeploymentManifestPorts extends DeploymentCompilerPorts {
  readonly expectedTokenCalls: (config: DeploymentConfig, allocationHash: Hex) => ExpectedCreationState;
  readonly expectedGrantCalls: (config: DeploymentConfig, grant: DeploymentGrant, token: Hex) => ExpectedCreationState;
  readonly createAddress: (sender: Hex, nonce: string) => Hex;
}
export interface DeploymentManifest {
  readonly schema: "agtmai-deployment-manifest-v1";
  readonly sourceRevision: string; readonly broadcastAllowed: false;
  readonly configurationSha256: Hex; readonly preparedSha256: Hex; readonly evidenceSha256: Hex;
  readonly configuration: DeploymentConfig;
  readonly status: "not-deployed" | "partial" | "deployed";
  readonly token: { readonly address: Hex; readonly transactionHash: Hex; readonly block: DeploymentBlock; readonly constructorArgs: Hex; readonly artifactSha256: Hex; readonly compilerInputSha256: Hex; readonly genesisAllocationHash: Hex } | null;
  readonly grants: readonly { readonly grantId: string; readonly address: Hex; readonly transactionHash: Hex; readonly block: DeploymentBlock; readonly constructorArgs: Hex; readonly artifactSha256: Hex; readonly compilerInputSha256: Hex }[];
  readonly observationTrust: "selected RPC captures; hashes establish reproducibility, not independent consensus truth";
}
const refuse = (reason: string): never => { throw new Error(`DEPLOYMENT_EVIDENCE_${reason}`); };
const publicBlock = (b: DeploymentBlock): DeploymentBlock => ({ number: b.number, hash: b.hash, timestamp: b.timestamp });
const same = (a: unknown, b: unknown): boolean => new TextDecoder().decode(deploymentBytes(a)) === new TextDecoder().decode(deploymentBytes(b));

/** The v2 variant describes complete unsigned construction, with every observed field unavailable. */
export function prepareAssemblyManifest(prepared: PreparedProductionDeployment, ports: ProductionPreparationPorts & { readonly sha256: (bytes: Uint8Array) => Hex }) {
  const rebuilt = prepareProductionDeployment(prepared.configuration, { artifactSourceRevision: prepared.expectations.sourceRevision,
    artifacts: prepared.artifacts, approval: prepared.approval, expectations: prepared.expectations }, ports, ports.sha256).prepared;
  if (!rebuilt || !same(rebuilt, prepared) || rebuilt.schema !== "agtmai-prepared-production-deployment-v2") { return refuse("PREPARATION_MISMATCH"); }
  return { schema: "agtmai-deployment-manifest-v2" as const, coverage: rebuilt.coverage, broadcastAllowed: false as const,
    status: "unsigned-preparation" as const, configurationSha256: rebuilt.configurationSha256,
    reserveConfigurationSha256: rebuilt.reserveConfigurationSha256, assemblyConfigurationSha256: rebuilt.assemblyConfigurationSha256!,
    artifactPinsSha256: rebuilt.expectations.artifactPinsSha256, sourceRevision: rebuilt.expectations.sourceRevision,
    preparedSha256: ports.sha256(deploymentBytes(rebuilt)), evidenceSha256: null, attemptIdentity: rebuilt.expectations.attemptIdentity,
    configuration: rebuilt.configuration, facts: rebuilt.facts!, contracts: rebuilt.constructors!,
    funding: { operation: rebuilt.operations[9]!, observed: null },
    gas: rebuilt.expectations.operations.map(o => ({ id: o.id, gasEstimate: o.gasEstimate!, gasLimit: o.gasLimit!, baseFeePerGas: o.baseFeePerGas!,
      maxPriorityFeePerGas: o.maxPriorityFeePerGas!, maxFeePerGas: o.maxFeePerGas!, value: o.value!,
      gasUsed: null, effectiveGasPrice: null, observedCostWei: null })),
    worstCaseWei: rebuilt.expectations.operations.reduce((sum, op) => sum + BigInt(op.gasLimit!) * BigInt(op.maxFeePerGas!) + BigInt(op.value!), 0n).toString(),
    observedWei: null, actualProductionDeployment: "unavailable" as const };
}
export type PreparedAssemblyManifest = ReturnType<typeof prepareAssemblyManifest>;

/** Regenerate facts only from validated preparation and native creation/runtime/getter observations. */
export function materializeDeploymentManifest(prepared: PreparedDeployment, evidence: DeploymentEvidence, ports: DeploymentManifestPorts): DeploymentManifest {
  const compiled = compileDeployment(prepared.configuration, { sourceRevision: prepared.sourceRevision, artifacts: prepared.artifacts, ...(prepared.approval === null ? {} : { approval: prepared.approval }) }, ports);
  if (!compiled.prepared || !same(prepared, compiled.prepared)) { return refuse("PREPARATION_MISMATCH"); }
  const config = prepared.configuration;
  validateEvidenceBinding(prepared, evidence);
  const artifacts = prepared.artifacts;
  const tokenArtifact = artifacts.find(a => a.contract === "AGTMAICCIPToken")!;
  let token: DeploymentManifest["token"] = null;
  const addresses = new Set<string>();
  if (evidence.token) {
    const e = evidence.token;
    verifyCreation(e, { initcode: prepared.token.initcode, artifact: tokenArtifact, state: ports.expectedTokenCalls(config, prepared.token.genesisAllocationHash), chainId: config.environment.evmChainId }, ports);
    if (config.bridge?.ethereum.token && config.bridge.ethereum.token !== e.address) { return refuse("TOKEN_REFERENCE"); }
    addresses.add(e.address);
    token = { address: e.address, transactionHash: e.transaction.hash, block: publicBlock(e.blockBefore), constructorArgs: prepared.token.constructorArgs,
      artifactSha256: tokenArtifact.artifactSha256, compilerInputSha256: tokenArtifact.compilerInputSha256, genesisAllocationHash: prepared.token.genesisAllocationHash };
  }
  const grantArtifact = artifacts.find(a => a.contract === "GrantVault")!;
  const grants = evidence.grants.map(({ grantId, deployment: e }) => {
    const grant = config.grants.find(g => g.id === grantId);
    if (!grant || !token) { return refuse("GRANT_REFERENCE"); }
    const reserve = config.allocations.find(a => a.id === grant.fundingAllocation)!, controller = config.custodySafes.find(s => s.id === grant.controllerSafe)!;
    if (addresses.has(e.address) || [grant.beneficiary, reserve.recipient, controller.address].includes(e.address)) { return refuse("VAULT_SELF_BINDING"); }
    const input = prepareGrant(prepared, grantId, token.address, ports);
    verifyCreation(e, { initcode: input.initcode, artifact: grantArtifact, state: ports.expectedGrantCalls(config, grant, token.address), chainId: config.environment.evmChainId }, ports);
    if (BigInt(e.blockBefore.timestamp) > BigInt(grant.schedule.start)) { return refuse("LATE_CONSTRUCTION"); }
    addresses.add(e.address);
    return { grantId, address: e.address, transactionHash: e.transaction.hash, block: publicBlock(e.blockBefore), constructorArgs: input.constructorArgs,
      artifactSha256: grantArtifact.artifactSha256, compilerInputSha256: grantArtifact.compilerInputSha256 };
  }).toSorted((a, b) => a.grantId < b.grantId ? -1 : 1);
  if (new Set([...(token ? [token.transactionHash] : []), ...grants.map(g => g.transactionHash)]).size !== grants.length + (token ? 1 : 0)) { return refuse("DUPLICATE_TRANSACTION"); }
  return { schema: "agtmai-deployment-manifest-v1", broadcastAllowed: false, sourceRevision: prepared.sourceRevision,
    configurationSha256: prepared.configurationSha256, preparedSha256: ports.sha256(deploymentBytes(prepared)), evidenceSha256: ports.sha256(deploymentBytes(evidence)),
    configuration: config, status: token === null ? "not-deployed" : grants.length === config.grants.length ? "deployed" : "partial", token, grants,
    observationTrust: "selected RPC captures; hashes establish reproducibility, not independent consensus truth" };
}

interface ExpectedDeployment { readonly initcode: Hex; readonly artifact: DeploymentArtifact; readonly state: ExpectedCreationState; readonly chainId: string }
function verifyCreation(e: ContractDeploymentEvidence, expected: ExpectedDeployment, ports: DeploymentManifestPorts): void {
  verifyBlocks(e);
  verifyTransaction(e, expected, ports);
  verifyReceipt(e);
  verifyRuntime(e, expected.artifact);
  verifyCreationCalls(e, expected.state);
}
function verifyBlocks(e: ContractDeploymentEvidence): void {
  const block = e.blockBefore;
  for (const b of [block, e.blockAfter, e.finalizedBlock]) {
    if (!isDigest(b.hash) || parseCanonicalUint(b.number) === undefined || parseCanonicalUint(b.timestamp, UINT64_MAX) === undefined) { refuse("BLOCK_INVALID"); }
  }
  if (!same(block, e.blockAfter) || BigInt(e.finalizedBlock.number) < BigInt(block.number) || BigInt(e.finalizedBlock.timestamp) < BigInt(block.timestamp)
    || (e.finalizedBlock.number === block.number && !same(e.finalizedBlock, block))) { refuse("FINALITY_UNRESOLVED"); }
}
function verifyTransaction(e: ContractDeploymentEvidence, expected: ExpectedDeployment, ports: DeploymentManifestPorts): void {
  const tx = e.transaction;
  if (!isEvmAddress(e.address) || !isEvmAddress(tx.from) || !isDigest(tx.hash) || parseCanonicalUint(tx.nonce, UINT64_MAX) === undefined
    || tx.chainId !== expected.chainId || tx.to !== null || tx.value !== "0" || tx.input !== expected.initcode || ports.createAddress(tx.from, tx.nonce) !== e.address) { refuse("CREATION_MISMATCH"); }
}
function verifyReceipt(e: ContractDeploymentEvidence): void {
  const receipt = e.receipt, block = e.blockBefore;
  if (receipt.status !== 1 || receipt.transactionHash !== e.transaction.hash || receipt.contractAddress !== e.address || receipt.blockNumber !== block.number || receipt.blockHash !== block.hash
    || parseCanonicalUint(receipt.gasUsed) === undefined || BigInt(receipt.gasUsed) === 0n || parseCanonicalUint(receipt.effectiveGasPrice) === undefined) { refuse("CREATION_MISMATCH"); }
}
function verifyRuntime(e: ContractDeploymentEvidence, artifact: DeploymentArtifact): void {
  const block = e.blockBefore;
  if (e.runtime.blockHash !== block.hash || e.runtime.blockNumber !== block.number || !/^0x(?:[0-9a-f]{2})+$/.test(e.runtime.code) || e.runtime.code.length !== artifact.runtimeBytecode.length) { refuse("RUNTIME_IDENTITY"); }
  verifyDeploymentRuntime(e.runtime.code, artifact);
}

export function verifyDeploymentRuntime(code: Hex, artifact: DeploymentArtifact): void {
  if (!/^0x(?:[0-9a-f]{2})+$/.test(code) || code.length !== artifact.runtimeBytecode.length) { refuse("RUNTIME_IDENTITY"); }
  // Ignore only pinned compiler immutable slots. Creation input is exact and all
  // public immutable getters and constructor terms are independently required.
  const strip = (runtimeCode: string): string => {
    const bytes = runtimeCode.slice(2).split("");
    for (const ref of artifact.immutableReferences) { bytes.fill("0", ref.start * 2, (ref.start + ref.length) * 2); }
    return bytes.join("");
  };
  if (strip(code) !== strip(artifact.runtimeBytecode)) { refuse("RUNTIME_IDENTITY"); }
}
function verifyCreationCalls(e: ContractDeploymentEvidence, expected: ExpectedCreationState): void {
  const receipt = e.receipt, block = e.blockBefore, expectedCalls = expected.calls;
  if (!Array.isArray(receipt.logs) || receipt.logs.length !== expected.logs.length) { refuse("EVENT_COVERAGE"); }
  for (const [i, log] of receipt.logs.entries()) {
    const event = expected.logs[i]!;
    if (log.address !== e.address || log.removed !== false || parseCanonicalUint(log.logIndex) === undefined || !same(log.topics, event.topics) || log.data !== event.data
      || (i > 0 && BigInt(log.logIndex) !== BigInt(receipt.logs[i - 1]!.logIndex) + 1n)) { refuse("EVENT_MISMATCH"); }
  }
  if (!Array.isArray(e.calls) || e.calls.length !== Object.keys(expectedCalls).length || new Set(e.calls.map(c => c.data)).size !== e.calls.length) { refuse("GETTER_COVERAGE"); }
  for (const call of e.calls) {
    if (call.to !== e.address || call.blockHash !== block.hash || call.blockNumber !== block.number || expectedCalls[call.data] !== call.result) { refuse("GETTER_MISMATCH"); }
  }
}

function validateEvidenceBinding(prepared: PreparedDeployment, evidence: DeploymentEvidence): void {
  const config = prepared.configuration;
  const collectorKind = config.environment.mode === "local-test" ? "local-anvil" : config.environment.mode === "owned-testnet" ? "owned-testnet-rpc" : "mainnet-read-only-rpc";
  if (evidence.schema !== "agtmai-deployment-evidence-v1" || evidence.configurationSha256 !== prepared.configurationSha256 || evidence.collector.kind !== collectorKind || !/^[0-9a-f]{40}$/.test(evidence.collector.sourceRevision)
    || !Array.isArray(evidence.grants) || evidence.grants.length > config.grants.length || new Set(evidence.grants.map(g => g.grantId)).size !== evidence.grants.length) { return refuse("BINDING"); }
  if (evidence.token === null && evidence.grants.length) { return refuse("TOKEN_PREREQUISITE"); }
}

export interface AssemblyOperationObservation {
  readonly id: string; readonly nonce: string; readonly sender: Hex; readonly chainId: "1"; readonly input: Hex; readonly value: "0";
  readonly gasEstimate: string; readonly gasLimit: string; readonly baseFeePerGas: string; readonly blockGasLimit: string;
  readonly maxPriorityFeePerGas: string; readonly maxFeePerGas: string; readonly gasUsed: string; readonly effectiveGasPrice: string; readonly observedCostWei: string;
  readonly predecessor: DeploymentBlock; readonly block: DeploymentBlock; readonly parentHash: Hex; readonly transactionHash: Hex; readonly status: "1"; readonly actualAddress: Hex;
  readonly logs: ContractDeploymentEvidence["receipt"]["logs"];
}
export interface AssemblyContractObservation {
  readonly id: string; readonly address: Hex; readonly runtime: Hex; readonly nonce: string; readonly getters: Readonly<Record<string, Hex>>; readonly balance: string;
}
export interface LocalAssemblyObservation {
  readonly operations: readonly AssemblyOperationObservation[]; readonly contracts: readonly AssemblyContractObservation[];
  readonly genesis: DeploymentBlock; readonly observedWei: string; readonly gasBufferBps: number;
  readonly authority: PreparedProductionDeployment["expectations"]["authority"];
  readonly fundingAfter: { readonly allowance: string; readonly repeatCallRevert: Hex };
  readonly fundingBefore: { readonly block: DeploymentBlock; readonly reserveBalance: string; readonly vaultBalance: string; readonly allowance: string; readonly funded: Hex };
}

/** Synthetic observed variant of the existing full manifest. No production approval is inferred. */
export function materializeObservedAssemblyManifest(prepared: PreparedLocalPurposeGenesis, observation: LocalAssemblyObservation, ports: LocalPurposePorts) {
  verifyPreparedLocalPurposeGenesis(prepared.configuration, prepared.candidateRevision,
    { sourceRevision: prepared.candidateRevision, artifacts: prepared.artifacts }, prepared, ports);
  if (prepared.schema !== "agtmai-prepared-local-purpose-genesis-v2" || prepared.approval !== null || observation.operations.length !== 10
    || observation.contracts.length !== 10 || new Set(observation.contracts.map(c => c.id)).size !== 10) { refuse("ASSEMBLY_INVENTORY"); }
  verifyObservedAssemblyAuthority(prepared, observation);
  const { worst, observed } = verifyObservedAssemblyOperations(prepared, observation);
  const founderAmount = prepared.configuration.reserve.allocations.find(a => a.id === "founder")!.amountBaseUnits;
  let balanceTotal = 0n;
  const contracts = prepared.constructors!.map(constructor => {
    const actual = observation.contracts.find(c => c.id === constructor.id);
    if (!actual || Object.keys(actual).toSorted().join() !== "address,balance,getters,id,nonce,runtime" || actual.address !== constructor.predictedAddress || actual.runtime !== constructor.materializedRuntime || actual.nonce !== (constructor.contract === "FounderGrantReserve" ? "2" : "1")) { return refuse("ASSEMBLY_RUNTIME"); }
    for (const [name, value] of Object.entries(constructor.immutableValues)) {
      if (actual.getters[name === "INITIAL_CCIP_ADMIN" ? "getCCIPAdmin" : name] !== value) { refuse("ASSEMBLY_GETTER"); }
    }
    const requireGetter = (name: string, value: Hex) => requireAssemblyGetter(actual, name, value);
    if (constructor.contract === "AGTMAICCIPToken") { requireGetter("totalSupply", assemblyWord(prepared.configuration.reserve.initialSupplyBaseUnits)); requireGetter("decimals", assemblyWord("9")); }
    if (constructor.contract === "ReserveController") { requireGetter("WINDOW", assemblyWord("31536000")); requireGetter("grossCommitted", assemblyWord("0")); requireGetter("rollingCommitted", assemblyWord("0")); }
    if (constructor.contract === "PurposeReserveVault") { requireGetter("grossOutflow", assemblyWord("0")); requireGetter("rollingOutflow", assemblyWord("0")); }
    let nested: { parentTransactionHash: Hex; childCreateNonce: "1"; grantConfigured: ContractDeploymentEvidence["receipt"]["logs"][number] } | undefined;
    if (constructor.creation.kind === "nested") { nested = verifyObservedFounder(prepared, observation, actual, ports); }
    const configured = prepared.configuration.reserve.allocations.find(a => a.recipient === actual.address);
    const expectedBalance = constructor.id === "founder-vault" ? founderAmount : constructor.id === "founder-reserve-create" || !configured ? "0" : configured.amountBaseUnits;
    if (actual.balance !== expectedBalance) { refuse("ASSEMBLY_BALANCE"); }
    balanceTotal += uint(actual.balance);
    const parentOperation = nested ? observation.operations[1]! : observation.operations.find(o => o.id === constructor.id)!;
    return { ...constructor, observed: { ...actual, block: observation.genesis, ...(nested ?? { transactionHash: parentOperation.transactionHash }) } };
  });
  if (balanceTotal !== uint(prepared.configuration.reserve.initialSupplyBaseUnits)) { refuse("ASSEMBLY_CONSERVATION"); }
  return { schema: "agtmai-deployment-manifest-v2" as const, coverage: "full-ethereum-reserve-assembly" as const, broadcastAllowed: false as const,
    status: "synthetic-local-observation" as const, configuration: prepared.configuration, configurationSha256: prepared.configurationSha256,
    sourceRevision: prepared.candidateRevision, preparedSha256: ports.sha256(deploymentBytes(prepared)), evidenceSha256: ports.sha256(deploymentBytes(observation)),
    attemptIdentity: prepared.planSha256, approval: null, authorityClass: "test-only" as const, chainId: "1" as const,
    packageTiming: "complete gas-bearing rehearsal package reconstructed after execution of pre-frozen inventory" as const,
    facts: projectLocalAssemblyFacts(prepared.configuration, prepared.configurationSha256), contracts,
    funding: { operation: prepared.operations[9]!, before: observation.fundingBefore, after: observation.fundingAfter, observed: observation.operations[9]! }, gas: observation.operations, gasBufferBps: observation.gasBufferBps,
    genesis: observation.genesis, authority: observation.authority, worstCaseWei: worst.toString(), observedWei: observed.toString(), actualProductionDeployment: "unavailable" as const };
}
export type ObservedAssemblyManifest = ReturnType<typeof materializeObservedAssemblyManifest>;

function uint(value: string): bigint { const n = parseCanonicalUint(value); if (n === undefined) { return refuse("ASSEMBLY_INTEGER"); } return n; }
const assemblyWord = (v: string): Hex => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
function requireAssemblyGetter(actual: AssemblyContractObservation, name: string, value: Hex): void { if (actual.getters[name] !== value) { refuse("ASSEMBLY_GETTER"); } }
function verifyObservedOperationBinding(prepared: PreparedLocalPurposeGenesis, observation: LocalAssemblyObservation, i: number): void {
  const operation = prepared.operations[i]!, actual = observation.operations[i]!, before = actual.predecessor, after = actual.block;
    if (actual.id !== operation.id || actual.nonce !== operation.nonce || actual.sender !== prepared.configuration.execution.sender || actual.chainId !== "1"
      || actual.input !== (operation.initcode ?? operation.calldata) || actual.value !== "0" || actual.status !== "1"
      || actual.actualAddress !== (operation.expectedAddress ?? operation.to) || !isDigest(actual.transactionHash)
      || !isDigest(before.hash) || !isDigest(after.hash) || actual.parentHash !== before.hash || uint(after.number) !== uint(before.number) + 1n || uint(after.timestamp) <= uint(before.timestamp)
      || (i > 0 && !same(before, observation.operations[i - 1]!.block))) { refuse("ASSEMBLY_TRANSACTION"); }
}
function verifyObservedOperationCost(actual: AssemblyOperationObservation, prepared: PreparedLocalPurposeGenesis, buffer: number) {
    const estimate = uint(actual.gasEstimate), limit = uint(actual.gasLimit), fee = uint(actual.maxFeePerGas), used = uint(actual.gasUsed), price = uint(actual.effectiveGasPrice);
    if (!estimate || !limit || !used || used > limit || !price || price > fee || limit > uint(actual.blockGasLimit)
      || uint(actual.maxPriorityFeePerGas) > fee || fee < uint(actual.baseFeePerGas) || actual.observedCostWei !== (used * price).toString()) { refuse("ASSEMBLY_COST"); }
  const policy = prepared.configuration.execution;
  if (!Number.isSafeInteger(buffer) || buffer < 0 || buffer > 10000 || limit !== (estimate * BigInt(10000 + buffer) + 9999n) / 10000n
    || limit > uint(policy.maxGasPerTransaction) || fee > uint(policy.maxFeePerGasWei) || uint(actual.maxPriorityFeePerGas) > uint(policy.maxPriorityFeePerGasWei)
    || uint(actual.block.timestamp) > uint(actual.id === "founder-fund" ? policy.fundingDeadline : policy.executionDeadline)) { refuse("ASSEMBLY_POLICY"); }
  return { limit, fee, used, price };
}
function verifyObservedAssemblyOperations(prepared: PreparedLocalPurposeGenesis, observation: LocalAssemblyObservation) {
  let worst = 0n, observed = 0n;
  for (const [i] of prepared.operations.entries()) {
    const actual = observation.operations[i]!;
    verifyObservedOperationBinding(prepared, observation, i);
    const { limit, fee, used, price } = verifyObservedOperationCost(actual, prepared, observation.gasBufferBps);
    worst += limit * fee; observed += used * price;
    if (worst >= 1n << 256n || observed >= 1n << 256n) { refuse("ASSEMBLY_COST"); }
  }
  if (observation.observedWei !== observed.toString() || !same(observation.genesis, observation.operations[9]!.block)) { refuse("ASSEMBLY_GENESIS"); }
  if (worst > uint(prepared.configuration.execution.maxTotalFeeWei)) { refuse("ASSEMBLY_POLICY"); }
  return { worst, observed };
}
function verifyObservedFounder(prepared: PreparedLocalPurposeGenesis, observation: LocalAssemblyObservation, actual: AssemblyContractObservation, ports: LocalPurposePorts) {
  const founder = prepared.configuration.reserve.founder, token = prepared.constructors![0]!.predictedAddress;
  const founderAmount = prepared.configuration.reserve.allocations.find(a => a.id === "founder")!.amountBaseUnits;
  const requireGetter = (name: string, value: Hex) => requireAssemblyGetter(actual, name, value);

      requireGetter("funded", assemblyWord("1"));
      const terms = [founderAmount, founder.schedule.start, founder.schedule.cliff, founder.schedule.end, "0"].map(assemblyWord).map(w => w.slice(2)).join("") + founder.purpose.slice(2);
      requireGetter("grant", `0x${terms}${["0", "0", "0", "1", "0"].map(assemblyWord).map(w => w.slice(2)).join("")}` as Hex);
      const parent = observation.operations[1]!;
      const logs = parent.logs.filter(l => l.address === actual.address && l.topics[0] === ports.keccak256(new TextEncoder().encode("GrantConfigured(address,address,address,address,(uint256,uint64,uint64,uint64,uint8,bytes32))")));
      if (logs.length !== 1 || logs[0]!.removed !== false || !same(logs[0]!.topics.slice(1), [assemblyWord(token), assemblyWord(founder.beneficiary), assemblyWord(prepared.constructors![1]!.predictedAddress)])
        || logs[0]!.data !== `0x${assemblyWord(founder.controller).slice(2)}${terms}`) { refuse("ASSEMBLY_NESTED_EVENT"); }
  const repeat = ports.keccak256(new TextEncoder().encode("AlreadyFunded()")).slice(0, 10);
  if (observation.fundingAfter.allowance !== "0" || observation.fundingAfter.repeatCallRevert !== repeat) { refuse("ASSEMBLY_FUNDING"); }
  const before = observation.fundingBefore;
  if (!same(before.block, observation.operations[8]!.block) || before.reserveBalance !== founderAmount || before.vaultBalance !== "0"
    || before.allowance !== "0" || before.funded !== assemblyWord("0")) { refuse("ASSEMBLY_FUNDING"); }
  return { parentTransactionHash: parent.transactionHash, childCreateNonce: "1" as const, grantConfigured: logs[0]! };
}

function verifyObservedAssemblyAuthority(prepared: PreparedLocalPurposeGenesis, observation: LocalAssemblyObservation): void {
  if (observation.authority.length !== 2 || new Set(observation.authority.map(s => s.address)).size !== 2
    || prepared.configuration.custodySafes.some(configured => !observation.authority.some(s => s.address === configured.address
      && s.threshold === 2 && s.owners.toSorted().join() === configured.owners.toSorted().join() && s.nonce === "0"
      && isEvmAddress(s.singletonAddress) && /^0x[0-9a-f]{64}$/.test(s.singletonSlot) && s.modules.length === 0 && s.guard === null && s.fallbackHandler === null && isDigest(s.proxyCodeHash) && isDigest(s.singletonCodeHash) && isDigest(s.setupProvenance)))) { refuse("ASSEMBLY_AUTHORITY"); }
}
