import { evaluateProductionGuards, type ApprovedProductionPolicy, type ProductionAttempt, type ProductionExpectations, type ProductionObservation, type ProductionGuardReport } from "../domain/production-guards.ts";
import { canonicalJson } from "../domain/identity.ts";

export interface ProductionPreflightRequest {
  readonly prepared: unknown;
  readonly expectations: ProductionExpectations;
  readonly observations: ProductionObservation;
  readonly attempt: ProductionAttempt;
  readonly nowSeconds: bigint;
  readonly preparedConfigurationSha256: string;
  readonly preparedReserveConfigurationSha256: string;
  readonly preparedArtifactPinsSha256: string;
}

/** Offline coordinator. It has no provider, signer, transaction or broadcast port. */
export function assessProductionPreflight(request: ProductionPreflightRequest): ProductionGuardReport {
  const prepared = request.prepared as Record<string, unknown> | null;
  const preparedOperations = prepared?.operations;
  const reasons: string[] = [];
  const preparedExpectations = prepared?.expectations as Record<string, unknown> | null;
  const approval = prepared?.approval as Record<string, unknown> | null;
  const artifacts = Array.isArray(prepared?.artifacts) ? prepared.artifacts as Record<string, unknown>[] : [];
  const artifactsValid = validArtifacts(artifacts);
  const approvalValid = validApproval(approval, prepared);
  if (!validEnvelope({ request, prepared, expectations: preparedExpectations, operations: preparedOperations, approval: approvalValid, artifacts: artifactsValid })) {
    return { status: "invalid", broadcastAllowed: false, reasons: ["prepared-deployment-invalid"] };
  }
  const preparedRecord = prepared!;
  const embeddedExpectations = preparedExpectations!;
  const actualOperations = preparedOperations as unknown[];
  if (canonicalJson(embeddedExpectations) !== canonicalJson(request.expectations)) {return { status: "invalid", broadcastAllowed: false, reasons: ["embedded-expectations-mismatch"] };}
  const expectedOperations = request.expectations.operations;
  const operationMatch = preparedOperationInventoryMatches(actualOperations, embeddedExpectations, expectedOperations);
  if (!operationMatch.inventory) {reasons.push("prepared-operation-inventory-mismatch");}
  else if (!operationMatch.binding) {reasons.push("prepared-operation-binding-mismatch");}
  if (reasons.length) {return { status: "blocked", broadcastAllowed: false, reasons };}
  const runtimeVerification = preparedRecord.runtimeVerification as Record<string, unknown> | undefined;
  const runtimeContracts = runtimeVerification?.contracts;
  const runtimeState = runtimeStatus(runtimeVerification, runtimeContracts, artifacts);
  const hasImmutables = runtimeState.hasImmutables;
  const runtimeValid = runtimeState.valid;
  if (!runtimeValid) {return { status: "invalid", broadcastAllowed: false, reasons: ["prepared-runtime-verification-invalid"] };}
  if (hasImmutables) {return { status: "blocked", broadcastAllowed: false, reasons: ["runtime-immutables-require-deterministic-local-execution"] };}
  const approved = approvedPolicy(preparedRecord);
  if (!approved) {return { status: "invalid", broadcastAllowed: false, reasons: ["prepared-policy-missing"] };}
  return evaluateProductionGuards(request.expectations, request.observations, request.attempt, request.nowSeconds, approved);
}

function validEnvelope(input: { request: ProductionPreflightRequest; prepared: Record<string, unknown> | null; expectations: Record<string, unknown> | null; operations: unknown; approval: boolean; artifacts: boolean }): boolean {
  const { request, prepared, expectations, operations, approval, artifacts } = input;
  return prepared !== null && prepared.schema === "agtmai-prepared-production-deployment-v1" && prepared.broadcastAllowed === false && prepared.coverage === "token-and-reserves-only" && prepared.configurationSha256 === request.preparedConfigurationSha256 && prepared.reserveConfigurationSha256 === request.preparedReserveConfigurationSha256 && request.preparedArtifactPinsSha256 === request.expectations.artifactPinsSha256 && prepared.configurationSha256 === request.expectations.configurationSha256 && prepared.reserveConfigurationSha256 === request.expectations.reserveConfigurationSha256 && expectations !== null && Array.isArray(operations) && approval && artifacts;
}

function validApproval(approval: Record<string, unknown> | null, prepared: Record<string, unknown> | null): boolean {
  return approval !== null && approval !== undefined && prepared !== null && prepared !== undefined && Object.keys(approval).toSorted().join() === "configurationSha256,reference,reserveConfigurationSha256,schema" && approval.schema === "agtmai-production-approval-v1" && typeof approval.reference === "string" && approval.configurationSha256 === prepared.configurationSha256 && approval.reserveConfigurationSha256 === prepared.reserveConfigurationSha256;
}

function runtimeStatus(runtime: Record<string, unknown> | undefined, contracts: unknown, artifacts: Record<string, unknown>[]): { valid: boolean; hasImmutables: boolean } {
  const identities = artifacts.map(value => ({ contract: value.contract, compilerVersion: value.compilerVersion, compilerInputSha256: value.compilerInputSha256, immutableReferences: value.immutableReferences }));
  const hasImmutables = identities.some(identity => Array.isArray(identity.immutableReferences) && identity.immutableReferences.length > 0);
  return { valid: validRuntime(runtime, contracts, identities, hasImmutables), hasImmutables };
}

function approvedPolicy(prepared: Record<string, unknown>): ApprovedProductionPolicy | undefined {
  const configuration = prepared.configuration as Record<string, unknown> | undefined;
  const deployment = configuration?.deployment as Record<string, unknown> | undefined;
  const reserveGenesis = configuration?.reserveGenesis as Record<string, unknown> | undefined;
  const policy = deployment?.policy as Record<string, unknown> | undefined;
  const schedule = (reserveGenesis?.founder as Record<string, unknown> | undefined)?.schedule as Record<string, unknown> | undefined;
  const allocations = reserveGenesis?.allocations;
  const founderAllocation = Array.isArray(allocations) ? allocations.find(entry => (entry as Record<string, unknown>)?.id === "founder") as Record<string, unknown> | undefined : undefined;
  return policy && typeof schedule?.start === "string" && typeof founderAllocation?.amountBaseUnits === "string" ? { ...policy, founderStart: schedule.start, tokenExpenditureBaseUnits: founderAllocation.amountBaseUnits } as unknown as ApprovedProductionPolicy : undefined;
}

function validArtifacts(artifacts: unknown): boolean {
  if (!Array.isArray(artifacts) || artifacts.length !== 3) {return false;}
  return artifacts.every(artifact => {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {return false;}
    const value = artifact as Record<string, unknown>;
    const hashes = [value.artifactSha256, value.buildInfoSha256, value.compilerInputSha256].every(item => typeof item === "string" && /^0x[0-9a-f]{64}$/.test(item));
    const refs = Array.isArray(value.immutableReferences) && value.immutableReferences.every(reference => reference !== null && typeof reference === "object" && !Array.isArray(reference));
    return Object.keys(value).toSorted().join() === "artifactSha256,buildInfoSha256,compilerInputSha256,compilerVersion,contract,creationBytecode,immutableReferences,runtimeBytecode" && ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"].includes(value.contract as string) && value.compilerVersion === "0.8.36" && hashes && typeof value.creationBytecode === "string" && typeof value.runtimeBytecode === "string" && refs;
  });
}

function preparedOperationInventoryMatches(actual: unknown[], embedded: Record<string, unknown> | null, expected: readonly { readonly id: string; readonly kind: string; readonly intentHash: string; readonly nonce?: string; readonly expectedAddress?: string; readonly nestedAddress?: string; readonly initcode?: string; readonly calldata?: string; readonly value?: string }[]): { inventory: boolean; binding: boolean } {
  const embeddedOperations = Array.isArray(embedded?.operations) ? embedded.operations : [];
  if (actual.length !== expected.length || embeddedOperations.length !== expected.length) {return { inventory: false, binding: false };}
  const binding = expected.every((operation, index) => {
    const selected = embeddedOperations[index];
    const wanted = operation.kind === "create" ? { id: operation.id, kind: operation.kind, intentHash: operation.intentHash, nonce: operation.nonce, expectedAddress: operation.expectedAddress, ...(operation.nestedAddress === undefined ? {} : { nestedAddress: operation.nestedAddress }), initcode: operation.initcode, value: operation.value } : { id: operation.id, kind: operation.kind, intentHash: operation.intentHash, nonce: operation.nonce, to: operation.expectedAddress, calldata: operation.calldata, value: operation.value };
    const selectedRecord = selected && typeof selected === "object" ? selected as Record<string, unknown> : undefined;
    const selectedComparable = operation.kind === "create" && selectedRecord ? { id: selectedRecord.id, kind: selectedRecord.kind, intentHash: selectedRecord.intentHash, nonce: selectedRecord.nonce, expectedAddress: selectedRecord.expectedAddress, ...((operation.nestedAddress === undefined) ? {} : { nestedAddress: selectedRecord.nestedAddress }), initcode: selectedRecord.initcode, value: selectedRecord.value } : operation.kind === "call" && selectedRecord ? { id: selectedRecord.id, kind: selectedRecord.kind, intentHash: selectedRecord.intentHash, nonce: selectedRecord.nonce, to: selectedRecord.to ?? selectedRecord.expectedAddress, calldata: selectedRecord.calldata, value: selectedRecord.value } : undefined;
    return selected !== undefined && canonicalOperation(actual[index]) === canonicalOperation(wanted) && canonicalOperation(selectedComparable) === canonicalOperation(wanted);
  });
  return { inventory: true, binding };
}

function canonicalOperation(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value)));
}

function validRuntime(runtime: Record<string, unknown> | undefined, contracts: unknown, identities: unknown, hasImmutables: boolean): boolean {
  if (!runtime || !Array.isArray(contracts) || canonicalJson(contracts) !== canonicalJson(identities)) {return false;}
  return hasImmutables ? runtime.status === "unresolved-immutables" && runtime.reason === "PRODUCTION_RUNTIME_IMMUTABLES_REQUIRE_DETERMINISTIC_LOCAL_EXECUTION" : runtime.status === "exact-static-runtime" && runtime.reason === null;
}
