import { validateProductionDeployment, type ProductionValidation } from "@agent-teams/supply/deployment";
import type { ProductionAttempt, ProductionExpectations, ProductionObservation, SafeState } from "../domain/production-guards.ts";

const reject = (code: string): never => { throw new Error(`PREFLIGHT_${code}`); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : reject("OBJECT");
const keys = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []): void => {
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) reject("SCHEMA");
};
const mapArray = (value: unknown, mapper: (value: unknown) => unknown): unknown[] => {
  const values = Array.isArray(value) ? value : reject("ARRAY");
  return values.map(mapper);
};
const optional = (value: unknown, check: (value: unknown) => boolean): void => { if (value !== undefined && !check(value)) reject("VALUE"); };
const stringValue = (value: unknown): value is string => typeof value === "string";
const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const bytes = (value: unknown): value is string => typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value);
const safe = (value: unknown): SafeState => {
  const item = record(value);
  keys(item, ["address", "owners", "threshold", "nonce", "proxyCodeHash", "singletonCodeHash", "singletonAddress", "singletonSlot", "modules", "guard", "fallbackHandler", "setupProvenance"], ["address", "owners", "threshold", "nonce", "proxyCodeHash", "singletonCodeHash", "singletonAddress", "singletonSlot", "modules", "guard", "fallbackHandler", "setupProvenance"]);
  return item as unknown as SafeState;
};

export function parseProductionExpectations(input: unknown): ProductionExpectations {
  const value = record(input);
  keys(value, ["schema", "chainId", "sender", "deployer", "configurationSha256", "reserveConfigurationSha256", "sourceRevision", "artifactPinsSha256", "startingNonce", "maxObservationAgeSeconds", "operations", "maxTotalCostWei", "attemptIdentity", "authority"], ["schema", "chainId", "sender", "deployer", "configurationSha256", "reserveConfigurationSha256", "sourceRevision", "artifactPinsSha256", "startingNonce", "maxObservationAgeSeconds", "operations", "maxTotalCostWei", "attemptIdentity", "authority"]);
  mapArray(value.authority, safe);
  mapArray(value.operations, operation => {
    const item = record(operation);
    keys(item, ["id", "kind", "intentHash", "nonce", "expectedAddress", "nestedAddress", "initcode", "initcodeHash", "runtime", "runtimeHash", "gasEstimate", "gasLimit", "baseFeePerGas", "maxPriorityFeePerGas", "maxFeePerGas", "blockGasLimit", "value"]);
    if (!stringValue(item.id) || !stringValue(item.kind) || !digest(item.intentHash)) reject("VALUE");
    optional(item.nonce, decimal); optional(item.expectedAddress, address); optional(item.nestedAddress, address); optional(item.initcode, bytes); optional(item.initcodeHash, digest); optional(item.runtime, bytes); optional(item.runtimeHash, digest);
    for (const field of ["gasEstimate", "gasLimit", "baseFeePerGas", "maxPriorityFeePerGas", "maxFeePerGas", "blockGasLimit", "value"]) optional(item[field], decimal);
    return item;
  });
  return value as unknown as ProductionExpectations;
}

export function parseProductionObservation(input: unknown): ProductionObservation {
  const value = record(input);
  keys(value, ["chainId", "sender", "pendingNonce", "blockNumber", "blockHash", "observedAt", "expiresAt", "operations", "occupiedAddresses", "authority"], ["chainId", "sender", "pendingNonce", "blockNumber", "blockHash", "observedAt", "expiresAt", "operations", "occupiedAddresses", "authority"]);
  if (!stringValue(value.chainId) || !address(value.sender) || !decimal(value.pendingNonce) || !decimal(value.blockNumber) || !digest(value.blockHash) || !decimal(value.observedAt) || !decimal(value.expiresAt)) reject("VALUE");
  mapArray(value.authority, safe);
  const occupiedAddresses = mapArray(value.occupiedAddresses, address);
  if (occupiedAddresses.some(entry => entry !== true)) reject("VALUE");
  mapArray(value.operations, operation => {
    const item = record(operation); keys(item, ["id", "address", "creation", "runtime", "nonce"]);
    if (!stringValue(item.id)) reject("VALUE"); optional(item.address, address); optional(item.creation, bytes); optional(item.runtime, bytes); optional(item.nonce, decimal); return item;
  });
  return value as unknown as ProductionObservation;
}

export function parseProductionAttempt(input: unknown): ProductionAttempt {
  const value = record(input);
  keys(value, ["schema", "identity", "states"], ["schema", "identity", "states"]);
  mapArray(value.states, state => { const item = record(state); keys(item, ["operationId", "state", "intent"], ["operationId", "state", "intent"]); if (!stringValue(item.operationId) || !["unattempted", "pending", "uncertain", "finalized-success", "finalized-revert"].includes(item.state as string) || !digest(item.intent)) reject("VALUE"); return item; });
  return value as unknown as ProductionAttempt;
}

/** Anti-corruption mapping at the planner edge; Supply remains the configuration authority. */
export function validateProductionConfig(input: unknown): ProductionValidation {
  return validateProductionDeployment(input);
}
