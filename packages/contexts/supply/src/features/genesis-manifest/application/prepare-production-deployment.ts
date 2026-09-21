import { validateProductionDeployment, type ValidatedProductionDeployment } from "../domain/production-deployment.js";
import { normalizeAllocationSet, type Diagnostic, type NormalizedAllocation } from "../domain/model.js";
import type { DeploymentConfig, Hex } from "../domain/deployment.js";
import { canonicalJson, type JsonValue } from "./canonical.js";

export interface ProductionArtifactPin {
  readonly contract: "AGTMAICCIPToken" | "FounderGrantReserve" | "ReserveController";
  readonly creationBytecode: Hex;
  readonly runtimeBytecode: Hex;
  readonly artifactSha256: Hex;
  readonly buildInfoSha256: Hex;
  readonly compilerInputSha256: Hex;
  readonly immutableReferences: readonly { readonly start: number; readonly length: 32 }[];
}
export interface ProductionExpectation {
  readonly schema: "agtmai-production-expectations-v1";
  readonly chainId: "1";
  readonly sourceRevision: string;
  readonly configurationSha256: Hex;
  readonly reserveConfigurationSha256: Hex;
  readonly artifactPinsSha256: Hex;
  readonly attemptIdentity: Hex;
  readonly sender: Hex;
  readonly deployer: Hex;
  readonly startingNonce: string;
  readonly maxObservationAgeSeconds: string;
  readonly maxTotalCostWei: string;
  readonly authority: readonly { readonly address: Hex; readonly owners: readonly Hex[]; readonly threshold: 2; readonly nonce: string; readonly proxyCodeHash: Hex; readonly singletonCodeHash: Hex; readonly singletonAddress: Hex; readonly singletonSlot: Hex; readonly modules: readonly Hex[]; readonly guard: Hex | null; readonly fallbackHandler: Hex | null; readonly setupProvenance: string }[];
  readonly operations: readonly { readonly id: "token-create" | "founder-reserve-create" | "controller-create" | "founder-fund"; readonly kind: "create" | "call"; readonly intentHash: Hex; readonly expectedAddress?: Hex; readonly nestedAddress?: Hex; readonly nonce?: string; readonly initcode?: Hex; readonly initcodeHash?: Hex; readonly runtime?: Hex; readonly runtimeHash?: Hex; readonly gasEstimate?: string; readonly gasLimit?: string; readonly baseFeePerGas?: string; readonly maxPriorityFeePerGas?: string; readonly maxFeePerGas?: string; readonly blockGasLimit?: string; readonly value?: string }[];
}
export interface ProductionApproval {
  readonly schema: "agtmai-production-approval-v1";
  readonly configurationSha256: Hex;
  readonly reserveConfigurationSha256: Hex;
  readonly reference: string;
}
export interface PreparedProductionDeployment {
  readonly schema: "agtmai-prepared-production-deployment-v1";
  readonly broadcastAllowed: false;
  readonly configuration: ValidatedProductionDeployment;
  readonly configurationSha256: Hex;
  readonly reserveConfigurationSha256: Hex;
  readonly approval: ProductionApproval;
  readonly expectations: ProductionExpectation;
  readonly artifacts: readonly ProductionArtifactPin[];
  readonly coverage: "token-and-reserves-only";
  readonly operations: readonly { readonly id: string; readonly kind: "create" | "call"; readonly nonce?: string; readonly expectedAddress?: Hex; readonly nestedAddress?: Hex; readonly to?: Hex; readonly initcode?: Hex; readonly value: "0" }[];
}

const invalid = (code: string, pointer: string): Diagnostic => ({ code: `PRODUCTION_${code}`, pointer, severity: "error", message: "production preparation refused" });
const digest = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const address = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const bytes = (value: unknown): value is Hex => typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);

export interface ProductionPreparationPorts {
  readonly encodeToken: (config: DeploymentConfig, allocations: readonly NormalizedAllocation[]) => { readonly constructorArgs: Hex };
  readonly encodeFounderReserve: (token: Hex, beneficiary: Hex, controller: Hex, allocation: string, start: string, cliff: string, end: string, purpose: Hex) => Hex;
  readonly encodeReserveController: (token: Hex, controller: Hex, purpose: Hex, rollingCap: string, perGrantCap: string) => Hex;
  readonly keccak256: (bytes: Uint8Array) => Hex;
  readonly createAddress: (sender: Hex, nonce: string) => Hex;
}

/** Deterministic construction inventory for the bounded production reserve path. */
export function prepareProductionDeployment(input: unknown, pins: { readonly artifactSourceRevision: string; readonly artifacts: readonly ProductionArtifactPin[]; readonly approval: ProductionApproval; readonly expectations: ProductionExpectation }, ports: ProductionPreparationPorts, sha256: (bytes: Uint8Array) => Hex): { readonly diagnostics: readonly Diagnostic[]; readonly prepared?: PreparedProductionDeployment } {
  const validated = validateProductionDeployment(input);
  if (!validated.value) return { diagnostics: validated.diagnostics };
  const diagnostics: Diagnostic[] = [];
  const value = validated.value;
  const configurationSha256 = sha256(new TextEncoder().encode(canonicalJson(value.deployment as unknown as JsonValue)));
  const reserveConfigurationSha256 = sha256(new TextEncoder().encode(canonicalJson(value.reserveGenesis as unknown as JsonValue)));
  if (!pins.approval || !digest(pins.approval.configurationSha256) || pins.approval.configurationSha256 !== configurationSha256) diagnostics.push(invalid("APPROVAL_CONFIGURATION", "/approval/configurationSha256"));
  if (!pins.approval || !digest(pins.approval.reserveConfigurationSha256) || pins.approval.reserveConfigurationSha256 !== reserveConfigurationSha256) diagnostics.push(invalid("APPROVAL_RESERVE", "/approval/reserveConfigurationSha256"));
  if (!pins.approval || !/^agtmai-production-approval-v1$/.test(pins.approval.schema) || !/^[A-Za-z0-9][A-Za-z0-9./_-]{0,159}$/.test(pins.approval.reference)) diagnostics.push(invalid("APPROVAL", "/approval"));
  const projectSafe = value.deployment.custodySafes.find(safe => safe.id === value.projectControllerSafeId);
  const founderSafe = value.deployment.custodySafes.find(safe => safe.id === value.founderBeneficiarySafeId);
  const authorityList = Array.isArray(pins.expectations.authority) ? pins.expectations.authority : [];
  const authoritiesValid = authorityList.length === 2 && authorityList.every(safe => safe !== null && typeof safe === "object" && Array.isArray(safe.owners) && Array.isArray(safe.modules) && address(safe.address) && safe.threshold === 2 && safe.owners.length === 3 && safe.owners.every(address) && new Set(safe.owners).size === 3 && /^(0|[1-9][0-9]*)$/.test(safe.nonce) && digest(safe.proxyCodeHash) && digest(safe.singletonCodeHash) && address(safe.singletonAddress) && /^0x[0-9a-f]{64}$/.test(safe.singletonSlot) && safe.modules.every(address) && (safe.guard === null || address(safe.guard)) && (safe.fallbackHandler === null || address(safe.fallbackHandler)) && digest(safe.setupProvenance));
  if (!/^agtmai-production-expectations-v1$/.test(pins.expectations.schema) || pins.expectations.chainId !== "1" || !/^[0-9a-f]{40}$/.test(pins.expectations.sourceRevision) || pins.expectations.configurationSha256 !== configurationSha256 || pins.expectations.reserveConfigurationSha256 !== reserveConfigurationSha256 || !digest(pins.expectations.attemptIdentity) || !address(pins.expectations.sender) || !address(pins.expectations.deployer) || pins.expectations.sender !== pins.expectations.deployer || !authoritiesValid || !projectSafe || !founderSafe || new Set(authorityList.map(safe => safe.address)).size !== 2 || !authorityList.some(safe => safe.address === projectSafe.address) || !authorityList.some(safe => safe.address === founderSafe.address) || !/^(0|[1-9][0-9]*)$/.test(pins.expectations.startingNonce) || !/^(0|[1-9][0-9]*)$/.test(pins.expectations.maxObservationAgeSeconds) || !/^(0|[1-9][0-9]*)$/.test(pins.expectations.maxTotalCostWei)) diagnostics.push(invalid("EXPECTATIONS", "/expectations"));
  const canonicalArtifacts = pins.artifacts.toSorted((left, right) => left.contract.localeCompare(right.contract));
  const selectedArtifactPinsSha256 = sha256(new TextEncoder().encode(canonicalJson({ schema: "agtmai-production-artifact-pins-v1", sourceRevision: pins.artifactSourceRevision, artifacts: canonicalArtifacts } as unknown as JsonValue)));
  if (pins.expectations.artifactPinsSha256 !== selectedArtifactPinsSha256) diagnostics.push(invalid("ARTIFACT_PIN_BINDING", "/expectations/artifactPinsSha256"));
  if (pins.artifactSourceRevision !== pins.expectations.sourceRevision) diagnostics.push(invalid("SOURCE_REVISION_BINDING", "/expectations/sourceRevision"));
  const expectedContracts = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"];
  if (pins.artifacts.length !== 3 || new Set(pins.artifacts.map(a => a.contract)).size !== 3 || pins.artifacts.some(a => !expectedContracts.includes(a.contract) || !digest(a.artifactSha256) || !digest(a.buildInfoSha256) || !digest(a.compilerInputSha256) || !bytes(a.creationBytecode) || !bytes(a.runtimeBytecode) || !Array.isArray(a.immutableReferences) || a.immutableReferences.some(reference => !Number.isSafeInteger(reference.start) || reference.start < 0 || reference.length !== 32 || (reference.start + 32) * 2 > a.runtimeBytecode.length - 2))) diagnostics.push(invalid("ARTIFACTS", "/artifacts"));
  const normalized = normalizeAllocationSet(value.deployment.token.initialSupplyBaseUnits, value.deployment.allocations, "deployment");
  if (normalized.diagnostics.length || !normalized.allocations) diagnostics.push(invalid("ALLOCATIONS", "/deployment/allocations"));
  if (diagnostics.length || !normalized.allocations) return { diagnostics };
  const tokenArtifact = pins.artifacts.find(a => a.contract === "AGTMAICCIPToken")!;
  const token = ports.encodeToken(value.deployment, normalized.allocations);
  const tokenInitcode = `${tokenArtifact.creationBytecode}${token.constructorArgs.slice(2)}` as Hex;
  const founder = value.reserveGenesis.founder;
  const expected = new Map(pins.expectations.operations.map(operation => [operation.id, operation]));
  const operationIds = ["token-create", "founder-reserve-create", "controller-create", "founder-fund"] as const;
  const invalidOperation = operationIds.some((id) => {
    const operation = expected.get(id);
    if (!operation || !digest(operation.intentHash) || !decimal(operation.nonce) || !address(operation.expectedAddress)) return true;
    if (id === "founder-reserve-create" && !address(operation.nestedAddress)) return true;
    if (id === "founder-fund") return operation.kind !== "call";
    return operation.kind !== "create" || !digest(operation.initcodeHash) || !bytes(operation.runtime) || !digest(operation.runtimeHash);
  });
  if (pins.expectations.operations.length !== operationIds.length || pins.expectations.operations.some((operation, index) => operation.id !== operationIds[index]) || invalidOperation) diagnostics.push(invalid("OPERATION_INVENTORY", "/expectations/operations"));
  const tokenAddress = expected.get("token-create")?.expectedAddress;
  if (!address(tokenAddress)) diagnostics.push(invalid("TOKEN_ADDRESS", "/expectations/operations/token-create/expectedAddress"));
  if (diagnostics.length || !address(tokenAddress)) return { diagnostics };
  const founderArtifact = pins.artifacts.find(a => a.contract === "FounderGrantReserve")!;
  const founderAllocation = value.reserveGenesis.allocations.find(allocation => allocation.id === "founder")!;
  const founderArgs = ports.encodeFounderReserve(tokenAddress, founder.beneficiary as Hex, founder.controller as Hex, founderAllocation.amountBaseUnits, founder.schedule.start, founder.schedule.cliff, founder.schedule.end, founder.purpose as Hex);
  const controller = value.reserveGenesis.contributors;
  const controllerArtifact = pins.artifacts.find(a => a.contract === "ReserveController")!;
  const controllerArgs = ports.encodeReserveController(tokenAddress, controller.controller as Hex, controller.purpose as Hex, controller.rollingCapBaseUnits, controller.perGrantCapBaseUnits);
  const expectedToken = expected.get("token-create")!;
  const expectedFounder = expected.get("founder-reserve-create")!;
  const expectedController = expected.get("controller-create")!;
  const expectedFund = expected.get("founder-fund")!;
  const contributorAllocation = value.reserveGenesis.allocations.find(allocation => allocation.id === "contributors")!;
  if (founderAllocation.recipient !== expectedFounder.expectedAddress || contributorAllocation.recipient !== expectedController.expectedAddress) diagnostics.push(invalid("RESERVE_RECIPIENT_BINDING", "/deployment/allocations"));
  const tokenInitcodeMatches = expectedToken.initcode === tokenInitcode && expectedToken.initcodeHash === ports.keccak256(hexBytes(tokenInitcode));
  const founderInitcode = `${founderArtifact.creationBytecode}${founderArgs.slice(2)}` as Hex;
  const controllerInitcode = `${controllerArtifact.creationBytecode}${controllerArgs.slice(2)}` as Hex;
  if (!runtimeMatchesArtifact(expectedToken.runtime, tokenArtifact) || !runtimeMatchesArtifact(expectedFounder.runtime, founderArtifact) || !runtimeMatchesArtifact(expectedController.runtime, controllerArtifact)) diagnostics.push(invalid("RUNTIME_BINDING", "/expectations/operations"));
  const reserveInitcodeMatches = expectedFounder.initcode === founderInitcode && expectedFounder.initcodeHash === ports.keccak256(hexBytes(founderInitcode)) && expectedController.initcode === controllerInitcode && expectedController.initcodeHash === ports.keccak256(hexBytes(controllerInitcode));
  if (!tokenInitcodeMatches || !reserveInitcodeMatches) diagnostics.push(invalid("CONSTRUCTOR_BINDING", "/expectations/operations"));
  if (expectedFund.expectedAddress !== expectedFounder.expectedAddress) diagnostics.push(invalid("FUND_TARGET", "/expectations/operations/founder-fund/expectedAddress"));
  if (!address(expectedFounder.nestedAddress) || expectedFounder.nestedAddress !== ports.createAddress(expectedFounder.expectedAddress!, "1")) diagnostics.push(invalid("NESTED_CREATE_IDENTITY", "/expectations/operations/founder-reserve-create/nestedAddress"));
  if (diagnostics.length) return { diagnostics };
  const operations = [
    { id: "token-create", kind: "create" as const, intentHash: expectedToken.intentHash, nonce: expectedToken.nonce!, expectedAddress: expectedToken.expectedAddress!, initcode: tokenInitcode, value: "0" as const },
    { id: "founder-reserve-create", kind: "create" as const, intentHash: expectedFounder.intentHash, nonce: expectedFounder.nonce!, expectedAddress: expectedFounder.expectedAddress!, nestedAddress: expectedFounder.nestedAddress!, initcode: founderInitcode, value: "0" as const },
    { id: "controller-create", kind: "create" as const, intentHash: expectedController.intentHash, nonce: expectedController.nonce!, expectedAddress: expectedController.expectedAddress!, initcode: controllerInitcode, value: "0" as const },
    { id: "founder-fund", kind: "call" as const, intentHash: expectedFund.intentHash, nonce: expectedFund.nonce!, to: expectedFund.expectedAddress!, value: "0" as const },
  ];
  return { diagnostics: [], prepared: { schema: "agtmai-prepared-production-deployment-v1", broadcastAllowed: false, configuration: value, configurationSha256, reserveConfigurationSha256, approval: pins.approval, expectations: pins.expectations, artifacts: canonicalArtifacts, coverage: "token-and-reserves-only", operations } };
}

function hexBytes(value: Hex): Uint8Array {
  return Uint8Array.from(value.slice(2).match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}

function runtimeMatchesArtifact(runtime: Hex | undefined, artifact: ProductionArtifactPin): boolean {
  if (!runtime || !bytes(runtime) || runtime.length !== artifact.runtimeBytecode.length) return false;
  const expected = runtime.slice(2), pinned = artifact.runtimeBytecode.slice(2);
  const immutable = new Set<number>();
  for (const reference of artifact.immutableReferences) for (let offset = reference.start; offset < reference.start + reference.length; offset += 1) immutable.add(offset);
  for (let offset = 0; offset < expected.length / 2; offset += 1) if (!immutable.has(offset) && expected.slice(offset * 2, offset * 2 + 2) !== pinned.slice(offset * 2, offset * 2 + 2)) return false;
  return true;
}
