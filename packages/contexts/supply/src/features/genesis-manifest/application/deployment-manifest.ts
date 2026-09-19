import { compileDeployment, deploymentBytes, prepareGrant, type DeploymentCompilerPorts, type PreparedDeployment, type DeploymentArtifact } from "./compile-deployment.js";
import { isDigest, isEvmAddress, type DeploymentConfig, type DeploymentGrant, type Hex } from "../domain/deployment.js";
import { parseCanonicalUint, UINT64_MAX } from "../domain/model.js";

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
