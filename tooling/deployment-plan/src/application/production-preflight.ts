import { evaluateProductionGuards, type ProductionAttempt, type ProductionExpectations, type ProductionObservation, type ProductionGuardReport } from "../domain/production-guards.ts";

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
  if (!prepared || prepared.schema !== "agtmai-prepared-production-deployment-v1" || prepared.broadcastAllowed !== false || prepared.configurationSha256 !== request.preparedConfigurationSha256 || prepared.reserveConfigurationSha256 !== request.preparedReserveConfigurationSha256 || request.preparedArtifactPinsSha256 !== request.expectations.artifactPinsSha256 || prepared.configurationSha256 !== request.expectations.configurationSha256 || prepared.reserveConfigurationSha256 !== request.expectations.reserveConfigurationSha256 || !preparedExpectations || preparedExpectations.chainId !== request.expectations.chainId || preparedExpectations.sender !== request.expectations.sender || preparedExpectations.deployer !== request.expectations.deployer || preparedExpectations.sourceRevision !== request.expectations.sourceRevision || preparedExpectations.artifactPinsSha256 !== request.expectations.artifactPinsSha256 || preparedExpectations.attemptIdentity !== request.expectations.attemptIdentity || !Array.isArray(preparedOperations)) {
    return { status: "invalid", broadcastAllowed: false, reasons: ["prepared-deployment-invalid"] };
  }
  const expectedOperations = request.expectations.operations;
  if (preparedOperations.length !== expectedOperations.length) reasons.push("prepared-operation-inventory-mismatch");
  else for (const [index, expected] of expectedOperations.entries()) {
    const actual = preparedOperations[index] as Record<string, unknown> | null;
    const preparedExpected = preparedExpectations?.operations;
    const selected = Array.isArray(preparedExpected) ? preparedExpected[index] as Record<string, unknown> | null : null;
    if (!actual || !selected || actual.id !== expected.id || actual.kind !== expected.kind || actual.nonce !== expected.nonce || (actual.expectedAddress ?? actual.to) !== expected.expectedAddress || actual.nestedAddress !== expected.nestedAddress || actual.initcode !== expected.initcode || selected.intentHash !== expected.intentHash) reasons.push("prepared-operation-binding-mismatch");
  }
  if (reasons.length) return { status: "blocked", broadcastAllowed: false, reasons };
  return evaluateProductionGuards(request.expectations, request.observations, request.attempt, request.nowSeconds);
}
