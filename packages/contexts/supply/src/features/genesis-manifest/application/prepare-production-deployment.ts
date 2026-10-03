import { validateProductionDeployment, type ValidatedProductionDeployment } from "../domain/production-deployment.js";
import { normalizeAllocationSet, type Diagnostic, parseCanonicalUint, UINT64_MAX, UINT256_MAX, type NormalizedAllocation } from "../domain/model.js";
import type { DeploymentConfig, Hex } from "../domain/deployment.js";
import { constructReserveAssembly, type AssemblyConstructor, type LocalPurposePorts } from "./assembly-construction.js";
import { canonicalJson, type JsonValue } from "./canonical.js";
import { projectAssemblyFacts } from "./reserve-facts.js";

export interface ProductionArtifactPin {
  readonly contract: "AGTMAICCIPToken" | "FounderGrantReserve" | "ReserveController" | "PurposeReserveVault" | "GrantVault";
  readonly compilerVersion: "0.8.36";
  readonly creationBytecode: Hex;
  readonly runtimeBytecode: Hex;
  readonly artifactSha256: Hex;
  readonly buildInfoSha256: Hex;
  readonly compilerInputSha256: Hex;
  readonly immutableReferences: readonly { readonly name: string; readonly start: number; readonly length: 32 }[];
}
export interface ProductionExpectation {
  readonly schema: "agtmai-production-expectations-v1" | "agtmai-production-expectations-v2";
  readonly assemblyConfigurationSha256?: Hex;
  readonly coverage?: "full-ethereum-reserve-assembly";
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
  readonly operations: readonly { readonly id: "token-create" | "founder-reserve-create" | "controller-create" | "founder-fund" | `purpose-${string}-create`; readonly kind: "create" | "call"; readonly intentHash: Hex; readonly expectedAddress?: Hex; readonly nestedAddress?: Hex; readonly nonce?: string; readonly initcode?: Hex; readonly initcodeHash?: Hex; readonly runtime?: Hex; readonly runtimeHash?: Hex; readonly runtimeTemplate?: Hex; readonly runtimeTemplateHash?: Hex; readonly gasEstimate?: string; readonly gasLimit?: string; readonly baseFeePerGas?: string; readonly maxPriorityFeePerGas?: string; readonly maxFeePerGas?: string; readonly blockGasLimit?: string; readonly value?: string; readonly calldata?: Hex }[];
}
export interface ProductionApproval {
  readonly schema: "agtmai-production-approval-v1" | "agtmai-production-approval-v2";
  readonly assemblyConfigurationSha256?: Hex;
  readonly configurationSha256: Hex;
  readonly reserveConfigurationSha256: Hex;
  readonly reference: string;
}
export interface PreparedProductionDeployment {
  readonly schema: "agtmai-prepared-production-deployment-v1" | "agtmai-prepared-production-deployment-v2";
  readonly assemblyConfigurationSha256?: Hex;
  readonly constructors?: readonly AssemblyConstructor[];
  readonly genesisAllocationHash?: Hex;
  readonly facts?: ReturnType<typeof projectAssemblyFacts>;
  readonly broadcastAllowed: false;
  readonly configuration: ValidatedProductionDeployment;
  readonly configurationSha256: Hex;
  readonly reserveConfigurationSha256: Hex;
  readonly approval: ProductionApproval;
  readonly expectations: ProductionExpectation;
  readonly artifacts: readonly ProductionArtifactPin[];
  readonly runtimeVerification: {
    readonly status: "exact-static-runtime" | "unresolved-immutables" | "templates-and-materialized-expectations";
    readonly reason: null | "PRODUCTION_RUNTIME_IMMUTABLES_REQUIRE_DETERMINISTIC_LOCAL_EXECUTION";
    readonly contracts: readonly {
      readonly contract: ProductionArtifactPin["contract"];
      readonly compilerVersion: "0.8.36";
      readonly compilerInputSha256: Hex;
      readonly immutableReferences: readonly { readonly name: string; readonly start: number; readonly length: 32 }[];
    }[];
  };
  readonly coverage: "token-and-reserves-only" | "full-ethereum-reserve-assembly";
  readonly operations: readonly { readonly id: string; readonly kind: "create" | "call"; readonly intentHash: Hex; readonly nonce: string; readonly expectedAddress?: Hex; readonly nestedAddress?: Hex; readonly to?: Hex; readonly initcode?: Hex; readonly calldata?: Hex; readonly value: "0" }[];
}

const invalid = (code: string, pointer: string): Diagnostic => ({ code: `PRODUCTION_${code}`, pointer, severity: "error", message: "production preparation refused" });
const digest = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const evidenceDigest = (value: unknown): value is Hex => digest(value) && !/^0x0{64}$/.test(value);
const address = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const bytes = (value: unknown): value is Hex => typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const sameStrings = (left: readonly string[], right: readonly string[]): boolean => JSON.stringify([...left].toSorted()) === JSON.stringify([...right].toSorted());
const operationCommon = ["baseFeePerGas", "blockGasLimit", "expectedAddress", "gasEstimate", "gasLimit", "id", "intentHash", "kind", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "value"] as const;
const exactFields = (value: object, fields: readonly string[]): boolean => Object.keys(value).toSorted().join() === [...fields].toSorted().join();

export interface ProductionPreparationPorts {
  readonly encodePurposeVault?: LocalPurposePorts["encodePurposeVault"];
  readonly encodeFounderVault?: LocalPurposePorts["encodeFounderVault"];
  readonly encodeToken: (config: DeploymentConfig, allocations: readonly NormalizedAllocation[]) => { readonly constructorArgs: Hex; readonly genesisAllocationHash?: Hex };
  readonly encodeFounderReserve: (input: { token: Hex; beneficiary: Hex; controller: Hex; allocation: string; start: string; cliff: string; end: string; purpose: Hex }) => Hex;
  readonly encodeReserveController: (input: { token: Hex; controller: Hex; purpose: Hex; rollingCap: string; perGrantCap: string }) => Hex;
  readonly keccak256: (bytes: Uint8Array) => Hex;
  readonly createAddress: (sender: Hex, nonce: string) => Hex;
}

/** Deterministic construction inventory for the bounded production reserve path. */
export function prepareProductionDeployment(input: unknown, pins: { readonly artifactSourceRevision: string; readonly artifacts: readonly ProductionArtifactPin[]; readonly approval: ProductionApproval; readonly expectations: ProductionExpectation }, ports: ProductionPreparationPorts, sha256: (bytes: Uint8Array) => Hex): { readonly diagnostics: readonly Diagnostic[]; readonly prepared?: PreparedProductionDeployment } {
  const validated = validateProductionDeployment(input);
  if (!validated.value) {return { diagnostics: validated.diagnostics };}
  const context = validatePreparationInputs(validated.value, pins, sha256);
  if (context.diagnostics.length || !context.normalized.allocations) {return { diagnostics: context.diagnostics };}
  return context.value.schema === "agtmai-production-deployment-v2"
    ? buildPreparedAssembly(context, pins, ports, sha256) : buildPreparedDeployment(context, pins, ports);
}

interface PreparationContext {
  readonly diagnostics: Diagnostic[];
  readonly value: ValidatedProductionDeployment;
  readonly configurationSha256: Hex;
  readonly reserveConfigurationSha256: Hex;
  readonly canonicalArtifacts: readonly ProductionArtifactPin[];
  readonly normalized: ReturnType<typeof normalizeAllocationSet>;
  readonly founderAllocation: NonNullable<ReturnType<typeof normalizeAllocationSet>["allocations"]>[number];
}

function validatePreparationInputs(value: ValidatedProductionDeployment, pins: { readonly artifactSourceRevision: string; readonly artifacts: readonly ProductionArtifactPin[]; readonly approval: ProductionApproval; readonly expectations: ProductionExpectation }, sha256: (bytes: Uint8Array) => Hex): PreparationContext {
  const diagnostics: Diagnostic[] = [];
  const configurationSha256 = sha256(new TextEncoder().encode(canonicalJson(value.deployment as unknown as JsonValue)));
  const reserveConfigurationSha256 = sha256(new TextEncoder().encode(canonicalJson(value.reserveGenesis as unknown as JsonValue)));
  validateApproval(pins.approval, configurationSha256, reserveConfigurationSha256, diagnostics, value.schema === "agtmai-production-deployment-v2");
  validateExpectations(value, pins.expectations, configurationSha256, reserveConfigurationSha256, diagnostics);
  const canonicalArtifacts = pins.artifacts.toSorted((left, right) => left.contract.localeCompare(right.contract));
  validateArtifacts(pins, canonicalArtifacts, sha256, diagnostics);
  const founderAllocation = value.reserveGenesis.allocations.find(allocation => allocation.id === "founder")!;
  validatePolicy(value, pins.expectations, founderAllocation.amountBaseUnits, diagnostics);
  const normalized = normalizeAllocationSet(value.deployment.token.initialSupplyBaseUnits, value.deployment.allocations, "deployment");
  if (normalized.diagnostics.length || !normalized.allocations) {diagnostics.push(invalid("ALLOCATIONS", "/deployment/allocations"));}
  return { diagnostics, value, configurationSha256, reserveConfigurationSha256, canonicalArtifacts, normalized, founderAllocation: normalized.allocations?.find(allocation => allocation.id === "founder") ?? founderAllocation as never };
}

function validateApproval(approval: ProductionApproval, configurationSha256: Hex, reserveConfigurationSha256: Hex, diagnostics: Diagnostic[], v2: boolean): void {
  if (!approval || !digest(approval.configurationSha256) || approval.configurationSha256 !== configurationSha256) {diagnostics.push(invalid("APPROVAL_CONFIGURATION", "/approval/configurationSha256"));}
  if (!approval || !digest(approval.reserveConfigurationSha256) || approval.reserveConfigurationSha256 !== reserveConfigurationSha256) {diagnostics.push(invalid("APPROVAL_RESERVE", "/approval/reserveConfigurationSha256"));}
  if (!approval || approval.schema !== (v2 ? "agtmai-production-approval-v2" : "agtmai-production-approval-v1") || !exactFields(approval, ["schema", "configurationSha256", "reserveConfigurationSha256", "reference", ...(v2 ? ["assemblyConfigurationSha256"] : [])]) || !/^[A-Za-z0-9][A-Za-z0-9./_-]{0,159}$/.test(approval.reference)) {diagnostics.push(invalid("APPROVAL", "/approval"));}
}

function validateExpectations(value: ValidatedProductionDeployment, expectations: ProductionExpectation, configurationSha256: Hex, reserveConfigurationSha256: Hex, diagnostics: Diagnostic[]): void {
  const projectSafe = value.deployment.custodySafes.find(safe => safe.id === value.projectControllerSafeId);
  const founderSafe = value.deployment.custodySafes.find(safe => safe.id === value.founderBeneficiarySafeId);
  const authority = Array.isArray(expectations.authority) ? expectations.authority : [];
  const authorityValid = authority.length === 2 && authority.every(validAuthority);
  const safeBound = (configured: typeof projectSafe): boolean => configured !== undefined && authority.some(safe => safe.address === configured.address && safe.threshold === configured.threshold && sameStrings(safe.owners, configured.owners));
  const valid = expectationIdentityValid(expectations, configurationSha256, reserveConfigurationSha256, value.schema === "agtmai-production-deployment-v2") && authorityValid && projectSafe !== undefined && founderSafe !== undefined && new Set(authority.map(safe => safe.address)).size === 2 && safeBound(projectSafe) && safeBound(founderSafe) && decimal(expectations.startingNonce) && decimal(expectations.maxObservationAgeSeconds) && decimal(expectations.maxTotalCostWei);
  if (!valid) {diagnostics.push(invalid("EXPECTATIONS", "/expectations"));}
  if (value.schema === "agtmai-production-deployment-v2" && (!parseCanonicalUint(expectations.maxObservationAgeSeconds, UINT64_MAX)
    || !parseCanonicalUint(expectations.maxTotalCostWei, UINT256_MAX))) { diagnostics.push(invalid("EXPECTATIONS_BOUNDS", "/expectations")); }
}

function expectationIdentityValid(expectations: ProductionExpectation, configurationSha256: Hex, reserveConfigurationSha256: Hex, v2: boolean): boolean {
  return expectations.schema === (v2 ? "agtmai-production-expectations-v2" : "agtmai-production-expectations-v1")
    && exactFields(expectations, ["schema", "chainId", "sourceRevision", "configurationSha256", "reserveConfigurationSha256", "artifactPinsSha256", "attemptIdentity", "sender", "deployer", "startingNonce", "maxObservationAgeSeconds", "maxTotalCostWei", "authority", "operations", ...(v2 ? ["assemblyConfigurationSha256", "coverage"] : [])]) && expectations.chainId === "1" && /^[0-9a-f]{40}$/.test(expectations.sourceRevision) && expectations.configurationSha256 === configurationSha256 && expectations.reserveConfigurationSha256 === reserveConfigurationSha256 && digest(expectations.attemptIdentity) && address(expectations.sender) && address(expectations.deployer) && expectations.sender === expectations.deployer;
}

function validAuthority(safe: ProductionExpectation["authority"][number]): boolean {
  return safe !== null && typeof safe === "object" && Array.isArray(safe.owners) && Array.isArray(safe.modules) && address(safe.address) && safe.threshold === 2 && safe.owners.length === 3 && safe.owners.every(address) && new Set(safe.owners).size === 3 && /^(0|[1-9][0-9]*)$/.test(safe.nonce) && evidenceDigest(safe.proxyCodeHash) && evidenceDigest(safe.singletonCodeHash) && address(safe.singletonAddress) && /^0x[0-9a-f]{64}$/.test(safe.singletonSlot) && safe.modules.every(address) && (safe.guard === null || address(safe.guard)) && (safe.fallbackHandler === null || address(safe.fallbackHandler)) && evidenceDigest(safe.setupProvenance);
}

function validateArtifacts(pins: { readonly artifactSourceRevision: string; readonly artifacts: readonly ProductionArtifactPin[]; readonly expectations: ProductionExpectation }, canonicalArtifacts: readonly ProductionArtifactPin[], sha256: (bytes: Uint8Array) => Hex, diagnostics: Diagnostic[]): void {
  const selected = sha256(new TextEncoder().encode(canonicalJson({ schema: pins.expectations.schema === "agtmai-production-expectations-v2" ? "agtmai-production-artifact-pins-v2" : "agtmai-production-artifact-pins-v1", sourceRevision: pins.artifactSourceRevision, artifacts: canonicalArtifacts } as unknown as JsonValue)));
  if (pins.expectations.artifactPinsSha256 !== selected) {diagnostics.push(invalid("ARTIFACT_PIN_BINDING", "/expectations/artifactPinsSha256"));}
  if (pins.artifactSourceRevision !== pins.expectations.sourceRevision) {diagnostics.push(invalid("SOURCE_REVISION_BINDING", "/expectations/sourceRevision"));}
  const contracts = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController", ...(pins.expectations.schema === "agtmai-production-expectations-v2" ? ["PurposeReserveVault", "GrantVault"] : [])];
  const valid = pins.artifacts.length === contracts.length && new Set(pins.artifacts.map(a => a.contract)).size === contracts.length && pins.artifacts.every(artifact => contracts.includes(artifact.contract) && artifact.compilerVersion === "0.8.36" && digest(artifact.artifactSha256) && digest(artifact.buildInfoSha256) && digest(artifact.compilerInputSha256) && bytes(artifact.creationBytecode) && bytes(artifact.runtimeBytecode) && Array.isArray(artifact.immutableReferences) && artifact.immutableReferences.every(reference => /^[A-Z][A-Z0-9_]{0,63}$/.test(reference.name) && Number.isSafeInteger(reference.start) && reference.start >= 0 && reference.length === 32 && (reference.start + 32) * 2 <= artifact.runtimeBytecode.length - 2));
  if (!valid) {diagnostics.push(invalid("ARTIFACTS", "/artifacts"));}
}

function validatePolicy(value: ValidatedProductionDeployment, expectations: ProductionExpectation, founderAmount: string, diagnostics: Diagnostic[]): void {
  const policy = value.deployment.policy;
  if (decimal(expectations.maxObservationAgeSeconds) && (BigInt(expectations.maxObservationAgeSeconds) > BigInt(policy.observationMaxAgeSeconds) || BigInt(expectations.maxObservationAgeSeconds) > BigInt(policy.estimateValiditySeconds))) {diagnostics.push(invalid("OBSERVATION_POLICY", "/expectations/maxObservationAgeSeconds"));}
  if (decimal(expectations.maxTotalCostWei) && BigInt(expectations.maxTotalCostWei) > BigInt(policy.evmMaxTotalFeeWei)) {diagnostics.push(invalid("TOTAL_FEE_POLICY", "/expectations/maxTotalCostWei"));}
  if (BigInt(founderAmount) > BigInt(policy.tokenExpenditureCeilingBaseUnits)) {diagnostics.push(invalid("TOKEN_EXPENDITURE_POLICY", "/deployment/policy/tokenExpenditureCeilingBaseUnits"));}
  if (BigInt(policy.fundingDeadline) > BigInt(policy.executionDeadline) || BigInt(policy.fundingDeadline) > BigInt(value.reserveGenesis.founder.schedule.start) - BigInt(policy.fundingLeadSeconds)) {diagnostics.push(invalid("FOUNDER_FUNDING_LEAD", "/deployment/policy/fundingDeadline"));}
}

function buildPreparedDeployment(context: PreparationContext, pins: { readonly artifactSourceRevision: string; readonly artifacts: readonly ProductionArtifactPin[]; readonly approval: ProductionApproval; readonly expectations: ProductionExpectation }, ports: ProductionPreparationPorts): { readonly diagnostics: readonly Diagnostic[]; readonly prepared?: PreparedProductionDeployment } {
  const { value, normalized, founderAllocation, canonicalArtifacts, configurationSha256, reserveConfigurationSha256 } = context;
  const diagnostics = [...context.diagnostics];
  const policy = value.deployment.policy;
  const tokenArtifact = pins.artifacts.find(a => a.contract === "AGTMAICCIPToken")!;
  const token = ports.encodeToken(value.deployment, normalized.allocations!);
  const tokenInitcode = `${tokenArtifact.creationBytecode}${token.constructorArgs.slice(2)}` as Hex;
  const founder = value.reserveGenesis.founder;
  const expected = new Map(pins.expectations.operations.map(operation => [operation.id, operation]));
  const operationIds = ["token-create", "founder-reserve-create", "controller-create", "founder-fund"] as const;
  const inventoryInvalid = invalidOperationInventory(pins.expectations.operations, expected, operationIds);
  if (inventoryInvalid) {diagnostics.push(invalid("OPERATION_INVENTORY", "/expectations/operations"));}
  const tokenAddress = expected.get("token-create")?.expectedAddress;
  if (!address(tokenAddress)) {diagnostics.push(invalid("TOKEN_ADDRESS", "/expectations/operations/token-create/expectedAddress"));}
  if (diagnostics.length || !address(tokenAddress)) {return { diagnostics };}
  const founderArtifact = pins.artifacts.find(a => a.contract === "FounderGrantReserve")!;
  const founderArgs = ports.encodeFounderReserve({ token: tokenAddress, beneficiary: founder.beneficiary as Hex, controller: founder.controller as Hex, allocation: founderAllocation.amountBaseUnits, start: founder.schedule.start, cliff: founder.schedule.cliff, end: founder.schedule.end, purpose: founder.purpose as Hex });
  const controller = value.reserveGenesis.contributors;
  const controllerArtifact = pins.artifacts.find(a => a.contract === "ReserveController")!;
  const controllerArgs = ports.encodeReserveController({ token: tokenAddress, controller: controller.controller as Hex, purpose: controller.purpose as Hex, rollingCap: controller.rollingCapBaseUnits, perGrantCap: controller.perGrantCapBaseUnits });
  const expectedToken = expected.get("token-create")!;
  const expectedFounder = expected.get("founder-reserve-create")!;
  const expectedController = expected.get("controller-create")!;
  const expectedFund = expected.get("founder-fund")!;
  const contributorAllocation = value.reserveGenesis.allocations.find(allocation => allocation.id === "contributors")!;
  const startingNonce = BigInt(pins.expectations.startingNonce);
  const expectedNonces = operationIds.map((_, index) => (startingNonce + BigInt(index)).toString());
  if (!nonceSequenceValid(expected, operationIds, expectedNonces)) {diagnostics.push(invalid("NONCE_SEQUENCE", "/expectations/operations"));}
  const createAddresses = expectedNonces.slice(0, 3).map(nonce => ports.createAddress(pins.expectations.deployer, nonce));
  if (!createAddressesValid([expectedToken, expectedFounder, expectedController], createAddresses)) {diagnostics.push(invalid("DEPLOYER_SEQUENCE", "/expectations/operations"));}
  if (founderAllocation.recipient !== expectedFounder.expectedAddress || contributorAllocation.recipient !== expectedController.expectedAddress) {diagnostics.push(invalid("RESERVE_RECIPIENT_BINDING", "/deployment/allocations"));}
  const tokenInitcodeMatches = expectedToken.initcode === tokenInitcode && expectedToken.initcodeHash === ports.keccak256(hexBytes(tokenInitcode));
  const founderInitcode = `${founderArtifact.creationBytecode}${founderArgs.slice(2)}` as Hex;
  const controllerInitcode = `${controllerArtifact.creationBytecode}${controllerArgs.slice(2)}` as Hex;
  if (!runtimeBindingsValid([expectedToken, expectedFounder, expectedController], [tokenArtifact, founderArtifact, controllerArtifact], ports)) {diagnostics.push(invalid("RUNTIME_BINDING", "/expectations/operations"));}
  const reserveInitcodeMatches = expectedFounder.initcode === founderInitcode && expectedFounder.initcodeHash === ports.keccak256(hexBytes(founderInitcode)) && expectedController.initcode === controllerInitcode && expectedController.initcodeHash === ports.keccak256(hexBytes(controllerInitcode));
  if (!tokenInitcodeMatches || !reserveInitcodeMatches) {diagnostics.push(invalid("CONSTRUCTOR_BINDING", "/expectations/operations"));}
  const fundSelector = `0x${ports.keccak256(new TextEncoder().encode("fund()")).slice(2, 10)}` as Hex;
  validateFundBindings(expectedFund, expectedFounder, fundSelector, ports, diagnostics);
  validateGasPolicy(pins.expectations.operations, policy, diagnostics);
  const derivedIntents = [
    operationIntent(ports, pins.expectations, expectedToken, tokenInitcode, "0x"),
    operationIntent(ports, pins.expectations, expectedFounder, founderInitcode, "0x"),
    operationIntent(ports, pins.expectations, expectedController, controllerInitcode, "0x"),
    operationIntent(ports, pins.expectations, expectedFund, "0x", fundSelector),
  ];
  const attemptIdentity = ports.keccak256(new TextEncoder().encode(canonicalJson({ domain: "AGTMAI_PRODUCTION_ATTEMPT_V1", chainId: pins.expectations.chainId, sender: pins.expectations.sender, startingNonce: pins.expectations.startingNonce, intents: derivedIntents } as unknown as JsonValue)));
  validateIntentBindings(pins.expectations, derivedIntents, attemptIdentity, diagnostics);
  if (diagnostics.length) {return { diagnostics };}
  const operations = [
    { id: "token-create", kind: "create" as const, intentHash: expectedToken.intentHash, nonce: expectedToken.nonce!, expectedAddress: expectedToken.expectedAddress!, initcode: tokenInitcode, value: "0" as const },
    { id: "founder-reserve-create", kind: "create" as const, intentHash: expectedFounder.intentHash, nonce: expectedFounder.nonce!, expectedAddress: expectedFounder.expectedAddress!, nestedAddress: expectedFounder.nestedAddress!, initcode: founderInitcode, value: "0" as const },
    { id: "controller-create", kind: "create" as const, intentHash: expectedController.intentHash, nonce: expectedController.nonce!, expectedAddress: expectedController.expectedAddress!, initcode: controllerInitcode, value: "0" as const },
    { id: "founder-fund", kind: "call" as const, intentHash: expectedFund.intentHash, nonce: expectedFund.nonce!, to: expectedFund.expectedAddress!, calldata: fundSelector, value: "0" as const },
  ];
  const runtimeContracts = canonicalArtifacts.map(artifact => ({ contract: artifact.contract, compilerVersion: artifact.compilerVersion, compilerInputSha256: artifact.compilerInputSha256, immutableReferences: artifact.immutableReferences }));
  const runtimeUnresolved = runtimeContracts.some(contract => contract.immutableReferences.length > 0);
  const runtimeVerification: PreparedProductionDeployment["runtimeVerification"] = {
    status: runtimeUnresolved ? "unresolved-immutables" : "exact-static-runtime",
    reason: runtimeUnresolved ? "PRODUCTION_RUNTIME_IMMUTABLES_REQUIRE_DETERMINISTIC_LOCAL_EXECUTION" : null,
    contracts: runtimeContracts,
  };
  return { diagnostics: [], prepared: { schema: "agtmai-prepared-production-deployment-v1", broadcastAllowed: false, configuration: value, configurationSha256, reserveConfigurationSha256, approval: pins.approval, expectations: pins.expectations, artifacts: canonicalArtifacts, runtimeVerification, coverage: "token-and-reserves-only", operations } };
}

function invalidOperationInventory(operations: readonly ProductionExpectation["operations"][number][], expected: ReadonlyMap<string, ProductionExpectation["operations"][number]>, operationIds: readonly string[]): boolean {
  if (operations.length !== operationIds.length || operations.some((operation, index) => operation.id !== operationIds[index])) {return true;}
  return operationIds.some(id => invalidOperationShape(id, expected.get(id)));
}

function invalidOperationShape(id: string, operation: ProductionExpectation["operations"][number] | undefined): boolean {
  if (!operation || !digest(operation.intentHash) || !decimal(operation.nonce) || !address(operation.expectedAddress) || ![operation.gasEstimate, operation.gasLimit, operation.baseFeePerGas, operation.maxPriorityFeePerGas, operation.maxFeePerGas, operation.blockGasLimit, operation.value].every(decimal) || operation.value !== "0") {return true;}
  if (id === "founder-fund") {return operation.kind !== "call" || !bytes(operation.calldata) || !exactFields(operation, [...operationCommon, "calldata"]);}
  const fields = id === "founder-reserve-create" ? [...operationCommon, "initcode", "initcodeHash", "nestedAddress", "runtime", "runtimeHash"] : [...operationCommon, "initcode", "initcodeHash", "runtime", "runtimeHash"];
  return operation.kind !== "create" || (id === "founder-reserve-create" && !address(operation.nestedAddress)) || !bytes(operation.initcode) || !digest(operation.initcodeHash) || !bytes(operation.runtime) || !digest(operation.runtimeHash) || !exactFields(operation, fields);
}

function nonceSequenceValid(expected: ReadonlyMap<string, ProductionExpectation["operations"][number]>, operationIds: readonly string[], nonces: readonly string[]): boolean {
  return operationIds.every((id, index) => expected.get(id)?.nonce === nonces[index]);
}

function createAddressesValid(operations: readonly ProductionExpectation["operations"][number][], addresses: readonly Hex[]): boolean {
  return operations.every((operation, index) => operation.expectedAddress === addresses[index]);
}

function runtimeBindingsValid(operations: readonly ProductionExpectation["operations"][number][], artifacts: readonly ProductionArtifactPin[], ports: ProductionPreparationPorts): boolean {
  return operations.every((operation, index) => runtimeMatchesArtifact(operation.runtime, artifacts[index]!) && operation.runtimeHash === ports.keccak256(hexBytes(operation.runtime!)));
}

function validateGasPolicy(operations: readonly ProductionExpectation["operations"][number][], policy: ValidatedProductionDeployment["deployment"]["policy"], diagnostics: Diagnostic[]): void {
  for (const operation of operations) {
    const estimate = BigInt(operation.gasEstimate!);
    const limit = BigInt(operation.gasLimit!);
    const maxFee = BigInt(operation.maxFeePerGas!);
    const priority = BigInt(operation.maxPriorityFeePerGas!);
    const base = BigInt(operation.baseFeePerGas!);
    const block = BigInt(operation.blockGasLimit!);
    const buffered = (estimate * BigInt(10_000 + policy.gasBufferBps) + 9_999n) / 10_000n;
    if (limit !== buffered || limit > BigInt(policy.evmMaxGasPerTransaction) || limit > block || maxFee > BigInt(policy.evmMaxFeePerGasWei) || priority > BigInt(policy.evmMaxPriorityFeePerGasWei) || maxFee < base || priority > maxFee) {diagnostics.push(invalid("GAS_FEE_POLICY", `/expectations/operations/${operation.id}`));}
  }
}

function validateFundBindings(fund: ProductionExpectation["operations"][number], founder: ProductionExpectation["operations"][number], selector: Hex, ports: ProductionPreparationPorts, diagnostics: Diagnostic[]): void {
  if (fund.expectedAddress !== founder.expectedAddress) {diagnostics.push(invalid("FUND_TARGET", "/expectations/operations/founder-fund/expectedAddress"));}
  if (fund.calldata !== selector) {diagnostics.push(invalid("FUND_CALLDATA", "/expectations/operations/founder-fund/calldata"));}
  if (!address(founder.nestedAddress) || founder.nestedAddress !== ports.createAddress(founder.expectedAddress!, "1")) {diagnostics.push(invalid("NESTED_CREATE_IDENTITY", "/expectations/operations/founder-reserve-create/nestedAddress"));}
}

function validateIntentBindings(expectations: ProductionExpectation, intents: readonly Hex[], attemptIdentity: Hex, diagnostics: Diagnostic[]): void {
  if (expectations.operations.some((operation, index) => operation.intentHash !== intents[index])) {diagnostics.push(invalid("INTENT_HASH", "/expectations/operations"));}
  if (expectations.attemptIdentity !== attemptIdentity) {diagnostics.push(invalid("ATTEMPT_IDENTITY", "/expectations/attemptIdentity"));}
}

function hexBytes(value: Hex): Uint8Array {
  return Uint8Array.from(value.slice(2).match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}

function runtimeMatchesArtifact(runtime: Hex | undefined, artifact: ProductionArtifactPin): boolean {
  return runtime === artifact.runtimeBytecode;
}

function operationIntent(ports: ProductionPreparationPorts, expectations: ProductionExpectation, operation: ProductionExpectation["operations"][number], createBytes: Hex, calldata: Hex): Hex {
  return ports.keccak256(new TextEncoder().encode(canonicalJson({ domain: "AGTMAI_PRODUCTION_OPERATION_INTENT_V1", chainId: expectations.chainId, sender: expectations.sender, nonce: operation.nonce, kind: operation.kind, target: operation.expectedAddress, createBytes, value: operation.value, calldata } as unknown as JsonValue)));
}

/** Freeze constructor/intents before gas binding. Authority admission belongs to the selected caller. */
export function constructProductionAssembly(input: unknown, selection: { readonly sourceRevision: string; readonly artifacts: readonly ProductionArtifactPin[]; readonly sender: Hex; readonly startingNonce: string }, ports: ProductionPreparationPorts, sha256: (bytes: Uint8Array) => Hex) {
  const { sourceRevision, artifacts, sender, startingNonce } = selection;
  const validated = validateProductionDeployment(input);
  const value = validated.value;
  if (!value || value.schema !== "agtmai-production-deployment-v2" || !/^[0-9a-f]{40}$/.test(sourceRevision)
    || !ports.encodePurposeVault || !ports.encodeFounderVault) { throw new Error("PRODUCTION_ASSEMBLY_INPUT"); }
  const encodePurposeVault = ports.encodePurposeVault, encodeFounderVault = ports.encodeFounderVault;
  const assembly = constructReserveAssembly({ chainId: "1", reserve: value.reserveGenesis, custodySafes: value.deployment.custodySafes,
    projectControllerSafeId: value.projectControllerSafeId, purposeVaults: value.purposeVaults!, execution: { sender, startingNonce } }, artifacts,
    { ...ports, sha256, encodePurposeVault, encodeFounderVault,
      encodeToken: (_chain, _supply, _admin, allocations) => {
        const encoded = ports.encodeToken(value.deployment, allocations);
        if (!encoded.genesisAllocationHash) { throw new Error("PRODUCTION_ASSEMBLY_TOKEN_HASH"); }
        return { constructorArgs: encoded.constructorArgs, genesisAllocationHash: encoded.genesisAllocationHash };
      }, encodeReserveController: (token, controller, purpose, rollingCap, perGrantCap) => ports.encodeReserveController({ token, controller, purpose, rollingCap, perGrantCap }) });
  const hash = (data: unknown) => sha256(new TextEncoder().encode(canonicalJson(data as JsonValue)));
  const assemblyConfigurationSha256 = hash(value);
  const configurationSha256 = hash(value.deployment), reserveConfigurationSha256 = hash(value.reserveGenesis);
  const artifactPinsSha256 = hash({ schema: "agtmai-production-artifact-pins-v2", sourceRevision, artifacts: assembly.artifacts });
  const operations = assembly.operations.map(operation => ({ ...operation, intentHash: ports.keccak256(new TextEncoder().encode(canonicalJson({
    domain: "AGTMAI_PRODUCTION_OPERATION_INTENT_V2", chainId: "1", sender, nonce: operation.nonce, kind: operation.kind,
    target: operation.expectedAddress ?? operation.to, createBytes: operation.initcode ?? "0x", value: operation.value,
    calldata: operation.calldata ?? "0x" } as JsonValue))) }));
  const attemptIdentity = ports.keccak256(new TextEncoder().encode(canonicalJson({ domain: "AGTMAI_PRODUCTION_ATTEMPT_V2", chainId: "1",
    sender, startingNonce, sourceRevision, artifactPinsSha256, assemblyConfigurationSha256, intents: operations.map(o => o.intentHash) } as JsonValue)));
  return { broadcastAllowed: false as const, configuration: value, configurationSha256, reserveConfigurationSha256,
    assemblyConfigurationSha256, artifactPinsSha256, attemptIdentity, ...assembly, operations };
}

function buildPreparedAssembly(context: PreparationContext, pins: Parameters<typeof prepareProductionDeployment>[1],
  ports: ProductionPreparationPorts, sha256: (bytes: Uint8Array) => Hex): ReturnType<typeof prepareProductionDeployment> {
  const diagnostics = [...context.diagnostics];
  let assembly: ReturnType<typeof constructProductionAssembly>;
  try { assembly = constructProductionAssembly(context.value, { sourceRevision: pins.artifactSourceRevision, artifacts: pins.artifacts, sender: pins.expectations.sender,
    startingNonce: pins.expectations.startingNonce }, ports, sha256); } catch { return { diagnostics: [invalid("ASSEMBLY_BINDING", "/configuration")] }; }
  const e = pins.expectations;
  if (pins.approval.assemblyConfigurationSha256 !== assembly.assemblyConfigurationSha256
    || e.assemblyConfigurationSha256 !== assembly.assemblyConfigurationSha256 || e.coverage !== "full-ethereum-reserve-assembly") {
    diagnostics.push(invalid("ASSEMBLY_APPROVAL_BINDING", "/assemblyConfigurationSha256"));
  }
  if (!Array.isArray(e.operations) || e.operations.length !== 10) { return { diagnostics: [invalid("OPERATION_INVENTORY", "/expectations/operations")] }; }
  for (const [i, op] of assembly.operations.entries()) {
    const selected = e.operations[i]!;
    if (!assemblyOperationMatches(op, selected, assembly.constructors[i])) {
      diagnostics.push(invalid("CONSTRUCTOR_BINDING", `/expectations/operations/${i}`));
    }
    if (!assemblyGasFieldsValid(selected)) { diagnostics.push(invalid("GAS_FIELDS", `/expectations/operations/${i}`)); }
  }
  if (e.attemptIdentity !== assembly.attemptIdentity) { diagnostics.push(invalid("ATTEMPT_IDENTITY", "/expectations/attemptIdentity")); }
  if (!diagnostics.length) {
    validateGasPolicy(e.operations, context.value.deployment.policy, diagnostics);
    const total = e.operations.reduce((sum, op) => sum + BigInt(op.gasLimit!) * BigInt(op.maxFeePerGas!), 0n);
    if (total > UINT256_MAX || total > BigInt(e.maxTotalCostWei)) { diagnostics.push(invalid("TOTAL_COST", "/expectations/maxTotalCostWei")); }
  }
  if (diagnostics.length) { return { diagnostics }; }
  return { diagnostics: [], prepared: { schema: "agtmai-prepared-production-deployment-v2", broadcastAllowed: false,
    configuration: context.value, configurationSha256: assembly.configurationSha256, reserveConfigurationSha256: assembly.reserveConfigurationSha256,
    assemblyConfigurationSha256: assembly.assemblyConfigurationSha256, approval: pins.approval, expectations: e, artifacts: assembly.artifacts,
    constructors: assembly.constructors, genesisAllocationHash: assembly.genesisAllocationHash,
    facts: projectAssemblyFacts(context.value, assembly.assemblyConfigurationSha256), coverage: "full-ethereum-reserve-assembly", operations: assembly.operations,
    runtimeVerification: { status: "templates-and-materialized-expectations", reason: null,
      contracts: assembly.artifacts.map(({ contract, compilerVersion, compilerInputSha256, immutableReferences }) => ({ contract, compilerVersion, compilerInputSha256, immutableReferences })) } } };
}

function assemblyOperationMatches(op: ReturnType<typeof constructProductionAssembly>["operations"][number], selected: ProductionExpectation["operations"][number] | undefined,
  constructor: AssemblyConstructor | undefined): boolean {
  const fields = op.kind === "call" ? [...operationCommon, "calldata"] : [...operationCommon, "initcode", "initcodeHash", "runtimeTemplate", "runtimeTemplateHash", ...(op.nestedAddress ? ["nestedAddress"] : [])];
  if (!selected || !exactFields(selected, fields) || selected.id !== op.id || selected.kind !== op.kind || selected.nonce !== op.nonce
    || selected.expectedAddress !== (op.expectedAddress ?? op.to) || selected.intentHash !== op.intentHash || selected.value !== "0") { return false; }
  return op.kind === "call" ? selected.calldata === op.calldata : constructor !== undefined && assemblyCreationMatches(selected, constructor, op.nestedAddress);
}
function assemblyCreationMatches(selected: ProductionExpectation["operations"][number], constructor: AssemblyConstructor, nested: Hex | undefined): boolean {
  return selected.initcode === constructor.initcode && selected.initcodeHash === constructor.initcodeHash
    && selected.runtimeTemplate === constructor.runtimeTemplate && selected.runtimeTemplateHash === constructor.runtimeTemplateHash
    && selected.nestedAddress === nested;
}
function assemblyGasFieldsValid(selected: ProductionExpectation["operations"][number] | undefined): boolean {
  return selected !== undefined && [selected.gasEstimate, selected.gasLimit, selected.baseFeePerGas, selected.maxPriorityFeePerGas,
    selected.maxFeePerGas, selected.blockGasLimit].every(n => parseCanonicalUint(n, UINT256_MAX) !== undefined)
    && selected.gasEstimate !== "0" && selected.gasLimit !== "0";
}
