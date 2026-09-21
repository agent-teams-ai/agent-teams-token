import { deriveCreateAddress, keccak256 } from "./identity.ts";
import { checkedAdd, checkedMul, parseUint } from "./model.ts";

export interface ProductionOperation {
  readonly id: string; readonly kind: "create" | "call"; readonly intentHash: string; readonly expectedAddress?: string; readonly nestedAddress?: string; readonly nonce?: string;
  readonly initcode?: string; readonly initcodeHash?: string; readonly runtime?: string; readonly runtimeHash?: string;
  readonly gasEstimate?: string; readonly gasLimit?: string; readonly baseFeePerGas?: string; readonly maxPriorityFeePerGas?: string; readonly maxFeePerGas?: string; readonly blockGasLimit?: string; readonly value?: string;
}
export interface SafeState {
  readonly address: string; readonly owners: readonly string[]; readonly threshold: number; readonly nonce: string;
  readonly proxyCodeHash: string; readonly singletonCodeHash: string; readonly singletonAddress: string; readonly singletonSlot: string;
  readonly modules: readonly string[]; readonly guard: string | null; readonly fallbackHandler: string | null; readonly setupProvenance: string;
}
export interface ProductionExpectations {
  readonly schema: "agtmai-production-expectations-v1"; readonly chainId: "1"; readonly sender: string; readonly deployer: string;
  readonly configurationSha256: string; readonly reserveConfigurationSha256: string; readonly sourceRevision: string; readonly artifactPinsSha256: string; readonly startingNonce: string; readonly maxObservationAgeSeconds: string;
  readonly operations: readonly ProductionOperation[]; readonly maxTotalCostWei: string; readonly attemptIdentity: string;
  readonly authority: readonly SafeState[];
}
export interface ProductionObservation {
  readonly chainId: string; readonly sender: string; readonly pendingNonce: string; readonly blockNumber: string;
  readonly blockHash: string; readonly observedAt: string; readonly expiresAt: string;
  readonly operations: readonly { readonly id: string; readonly address?: string; readonly creation?: string; readonly runtime?: string; readonly nonce?: string }[];
  readonly occupiedAddresses: readonly string[];
  readonly authority: readonly SafeState[];
}
export interface ProductionAttempt {
  readonly schema: "agtmai-production-attempt-state-v1"; readonly identity: string;
  readonly states: readonly { readonly operationId: string; readonly state: "unattempted" | "pending" | "uncertain" | "finalized-success" | "finalized-revert"; readonly intent: string }[];
}
export interface ProductionGuardReport { readonly status: "checks-passed-offline" | "blocked" | "invalid"; readonly broadcastAllowed: false; readonly reasons: readonly string[]; readonly totalWorstCaseWei?: string }

const hex = (value: unknown, bytes?: number): value is string => typeof value === "string" && new RegExp(`^0x[0-9a-f]{${bytes === undefined ? "2," : `${bytes * 2}`}}$`).test(value);
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
const fail = (reasons: string[], reason: string): void => { if (!reasons.includes(reason)) reasons.push(reason); };
const safeShape = (safe: SafeState): boolean => {
  if (!safe || typeof safe !== "object") return false;
  return address(safe.address) && safe.threshold === 2 && Array.isArray(safe.owners) && safe.owners.length === 3 && safe.owners.every(address) && new Set(safe.owners).size === 3 && /^(0|[1-9][0-9]*)$/.test(safe.nonce) && digest(safe.proxyCodeHash) && digest(safe.singletonCodeHash) && address(safe.singletonAddress) && hex(safe.singletonSlot, 32) && Array.isArray(safe.modules) && safe.modules.every(address) && (safe.guard === null || address(safe.guard)) && (safe.fallbackHandler === null || address(safe.fallbackHandler)) && digest(safe.setupProvenance);
};

/** Pure, fail-closed checks. Malformed decimal or overflow input is invalid, never an exception path. */
export function evaluateProductionGuards(expectations: ProductionExpectations, observations: ProductionObservation, attempt: ProductionAttempt, nowSeconds: bigint): ProductionGuardReport {
  try { return evaluateProductionGuardsUnchecked(expectations, observations, attempt, nowSeconds); }
  catch { return { status: "invalid", broadcastAllowed: false, reasons: ["production-input-invalid"] }; }
}

function evaluateProductionGuardsUnchecked(expectations: ProductionExpectations, observations: ProductionObservation, attempt: ProductionAttempt, nowSeconds: bigint): ProductionGuardReport {
  const reasons: string[] = [];
  if (expectations?.schema !== "agtmai-production-expectations-v1" || expectations.chainId !== "1" || !address(expectations.sender) || !address(expectations.deployer) || expectations.sender !== expectations.deployer || !digest(expectations.configurationSha256) || !digest(expectations.reserveConfigurationSha256) || !digest(expectations.artifactPinsSha256) || !/^[0-9a-f]{40}$/.test(expectations.sourceRevision)) return { status: "invalid", broadcastAllowed: false, reasons: ["expectations-invalid"] };
  if (observations?.chainId !== "1" || observations.sender !== expectations.sender) fail(reasons, "chain-or-sender-mismatch");
  if (!Array.isArray(observations.occupiedAddresses)) fail(reasons, "address-observation-missing");
  if (!Array.isArray(expectations.authority) || expectations.authority.some(safe => !safeShape(safe)) || !Array.isArray(observations.authority) || observations.authority.some(safe => !safeShape(safe))) fail(reasons, "authority-invalid");
  if (!Array.isArray(expectations.authority) || expectations.authority.length !== 2 || !Array.isArray(observations.authority) || observations.authority.length !== expectations.authority.length) fail(reasons, "authority-observation-missing");
  else for (const expected of expectations.authority) {
    const actual = observations.authority.find(candidate => candidate.address === expected.address);
    if (!actual || actual.threshold !== 2 || actual.owners.length !== 3 || new Set(actual.owners).size !== 3 || actual.nonce !== expected.nonce || JSON.stringify(actual.owners.toSorted()) !== JSON.stringify(expected.owners.toSorted()) || actual.proxyCodeHash !== expected.proxyCodeHash || actual.singletonCodeHash !== expected.singletonCodeHash || actual.singletonAddress !== expected.singletonAddress || actual.singletonSlot !== expected.singletonSlot || JSON.stringify(actual.modules.toSorted()) !== JSON.stringify(expected.modules.toSorted()) || actual.guard !== expected.guard || actual.fallbackHandler !== expected.fallbackHandler || actual.setupProvenance !== expected.setupProvenance) fail(reasons, "authority-mismatch");
  }
  const observedAt = parseUint(observations.observedAt, "observedAt"), expiresAt = parseUint(observations.expiresAt, "expiresAt"), maxObservationAge = parseUint(expectations.maxObservationAgeSeconds, "maxObservationAgeSeconds");
  parseUint(observations.blockNumber, "blockNumber");
  if (expiresAt < observedAt || nowSeconds < observedAt || nowSeconds > expiresAt || nowSeconds - observedAt > maxObservationAge) fail(reasons, "observation-stale-or-future");
  if (!digest(observations.blockHash) || observations.blockHash.length !== 66) fail(reasons, "observation-context-invalid");
  const operations = [...expectations.operations];
  const requiredOrder = ["token-create", "founder-reserve-create", "controller-create", "founder-fund"];
  if (operations.length !== requiredOrder.length || new Set(operations.map(operation => operation.id)).size !== operations.length) fail(reasons, "operation-inventory-invalid");
  if (operations.map(operation => operation.id).some((id, index) => id !== requiredOrder[index])) fail(reasons, "operation-order-mismatch");
  if (operations.some((operation, index) => operation.kind !== (index < 3 ? "create" : "call") || !digest(operation.intentHash))) fail(reasons, "operation-kind-mismatch");
  if (new Set(observations.operations.map(operation => operation.id)).size !== observations.operations.length || observations.operations.some(operation => !operations.some(expected => expected.id === operation.id))) fail(reasons, "observation-inventory-invalid");
  const observed = new Map(observations.operations.map(operation => [operation.id, operation]));
  let total = 0n;
  let expectedNonce = parseUint(expectations.startingNonce, "startingNonce");
  for (const operation of operations) {
    const nonce = operation.nonce === undefined ? undefined : parseUint(operation.nonce, `${operation.id}.nonce`);
    if (nonce !== undefined && nonce !== expectedNonce) fail(reasons, "nonce-inventory-mismatch");
    if (nonce !== undefined) expectedNonce += 1n;
    if (operation.kind === "create") {
      if (!address(expectations.sender) || nonce === undefined || !address(operation.expectedAddress)) fail(reasons, "create-expectation-invalid");
      else if (deriveCreateAddress(expectations.sender, nonce) !== operation.expectedAddress) fail(reasons, "create-address-mismatch");
      if (!hex(operation.initcode)) fail(reasons, "creation-bytes-missing");
      else if (!digest(operation.initcodeHash) || keccak256(Buffer.from(operation.initcode.slice(2), "hex")) !== operation.initcodeHash) fail(reasons, "creation-hash-mismatch");
      if (!hex(operation.runtime) || !digest(operation.runtimeHash)) fail(reasons, "runtime-expectation-missing");
      if (operation.id === "founder-reserve-create" && (!address(operation.nestedAddress) || deriveCreateAddress(operation.expectedAddress!, 1n) !== operation.nestedAddress)) fail(reasons, "nested-create-address-mismatch");
      if (operation.id !== "founder-reserve-create" && operation.nestedAddress !== undefined) fail(reasons, "unexpected-nested-create");
    }
    if (operation.expectedAddress && observations.occupiedAddresses.includes(operation.expectedAddress)) fail(reasons, "target-address-occupied");
    const seen = observed.get(operation.id);
    if (!seen) { fail(reasons, "observation-missing"); continue; }
    if (seen.nonce !== undefined && nonce !== undefined && parseUint(seen.nonce, `${operation.id}.observedNonce`) !== nonce) fail(reasons, "observed-nonce-mismatch");
    if (operation.expectedAddress && seen.address !== operation.expectedAddress) fail(reasons, "observed-address-mismatch");
    if (operation.initcode !== undefined && seen.creation !== operation.initcode) fail(reasons, "observed-creation-mismatch");
    if (operation.runtime !== undefined && (!hex(operation.runtime) || seen.runtime !== operation.runtime || !digest(operation.runtimeHash) || keccak256(Buffer.from(operation.runtime.slice(2), "hex")) !== operation.runtimeHash)) fail(reasons, "runtime-bytes-mismatch");
    if (operation.gasEstimate === undefined || operation.gasLimit === undefined || operation.baseFeePerGas === undefined || operation.maxPriorityFeePerGas === undefined || operation.maxFeePerGas === undefined || operation.blockGasLimit === undefined) { fail(reasons, "gas-estimate-missing"); continue; }
    const estimate = parseUint(operation.gasEstimate, `${operation.id}.gasEstimate`, false), limit = parseUint(operation.gasLimit, `${operation.id}.gasLimit`, false), baseFee = parseUint(operation.baseFeePerGas, `${operation.id}.baseFeePerGas`), priorityFee = parseUint(operation.maxPriorityFeePerGas, `${operation.id}.maxPriorityFeePerGas`), fee = parseUint(operation.maxFeePerGas, `${operation.id}.maxFeePerGas`, false), blockGasLimit = parseUint(operation.blockGasLimit, `${operation.id}.blockGasLimit`, false);
    if (limit < estimate || limit > blockGasLimit || fee < baseFee || fee < baseFee + priorityFee) fail(reasons, "gas-fee-policy-mismatch");
    const value = parseUint(operation.value ?? "0", `${operation.id}.value`);
    total = checkedAdd(total, checkedAdd(checkedMul(limit, fee, `${operation.id}.cost`), value, `${operation.id}.cost`), "aggregate-cost");
  }
  if (total > parseUint(expectations.maxTotalCostWei, "maxTotalCostWei")) fail(reasons, "aggregate-cost-exceeded");
  if (attempt?.schema !== "agtmai-production-attempt-state-v1" || !digest(attempt.identity) || attempt.identity !== expectations.attemptIdentity) return { status: "invalid", broadcastAllowed: false, reasons: ["attempt-state-invalid"] };
  const attemptIds = new Set(attempt.states.map(state => state.operationId));
  if (attemptIds.size !== attempt.states.length || attemptIds.size !== operations.length || operations.some(operation => !attemptIds.has(operation.id))) fail(reasons, "attempt-history-unknown");
  if (attempt.states.some(state => typeof state.intent !== "string" || state.intent.length === 0)) fail(reasons, "attempt-intent-missing");
  for (const state of attempt.states) {
    const operation = operations.find(candidate => candidate.id === state.operationId);
    if (state.state !== "unattempted") fail(reasons, `attempt-${state.state}`);
    if (!operation || state.intent !== operation.intentHash) fail(reasons, "attempt-intent-mismatch");
  }
  if (parseUint(observations.pendingNonce, "pendingNonce") !== expectedNonce) fail(reasons, "unexpected-pending-nonce");
  return { status: reasons.length ? "blocked" : "checks-passed-offline", broadcastAllowed: false, reasons, totalWorstCaseWei: total.toString() };
}
