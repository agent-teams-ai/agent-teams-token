import { compareDiagnostics, type Diagnostic } from "./model.js";
import { isEvmAddress, type Hex } from "./deployment.js";
import type { ValidatedProductionDeployment } from "./production-deployment.js";

/** Narrow domain view satisfied by PreparedProductionDeployment. */
export interface PreparedCcipDeployment {
  readonly configuration: ValidatedProductionDeployment;
  readonly operations: readonly { readonly id: string; readonly kind: "create" | "call"; readonly expectedAddress?: Hex }[];
}

export interface VerifiedPr21TokenIdentity { readonly ethereumToken: Hex }
export interface AuthenticatedLockReleasePoolIdentity { readonly pool: Hex; readonly localToken: Hex }

export interface CcipPreparationInput {
  readonly deployment: ValidatedProductionDeployment;
  readonly prepared: PreparedCcipDeployment;
  readonly pr21Token: VerifiedPr21TokenIdentity;
  readonly lockReleasePool: AuthenticatedLockReleasePoolIdentity;
}

export interface CcipPreparationContext {
  readonly schema: "agtmai-ccip-preparation-v1";
  /** The sole Ethereum token identity and source for later Solana ABI32 encoding. */
  readonly ethereumToken: Hex; readonly ethereumPool: Hex;
  readonly solanaMint: string; readonly solanaPool: string;
  readonly evmSelector: string; readonly solanaSelector: string;
}

export interface CcipPreparationValidation {
  readonly diagnostics: readonly Diagnostic[]; readonly context?: CcipPreparationContext;
}

const error = (code: string, pointer: string): Diagnostic => ({
  code: `CCIP_PREPARATION_${code}`,
  pointer,
  severity: "error",
  message: "CCIP preparation refused",
});

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) { return true; }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") { return false; }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>, rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord).toSorted();
  return keys.length === Object.keys(rightRecord).length && keys.every(key => key in rightRecord && sameValue(leftRecord[key], rightRecord[key]));
}

/**
 * Refines validated Supply authorities into a detached identity-only CCIP context.
 * It deliberately performs no evidence parsing, IO, payload encoding or validation
 * already owned by production deployment preparation.
 */
export function validateCcipPreparation(input: CcipPreparationInput): CcipPreparationValidation {
  const diagnostics: Diagnostic[] = [];
  const { deployment, prepared, pr21Token, lockReleasePool } = input;
  const config = deployment.deployment;

  if (config.environment.mode !== "mainnet-dry-run") { diagnostics.push(error("MAINNET_DRY_RUN_REQUIRED", "/deployment/deployment/environment/mode")); }
  if (config.status !== "accepted") { diagnostics.push(error("ACCEPTED_DEPLOYMENT_REQUIRED", "/deployment/deployment/status")); }
  if (!sameValue(deployment, prepared.configuration)) { diagnostics.push(error("PREPARED_DEPLOYMENT_MISMATCH", "/prepared/configuration")); }

  const bridge = config.bridge;
  if (bridge === null) {
    diagnostics.push(error("BRIDGE_REQUIRED", "/deployment/deployment/bridge"));
  } else {
    const missing = [[bridge.ethereum.token, "ethereum/token"], [bridge.ethereum.pool, "ethereum/pool"],
      [bridge.solana.mint, "solana/mint"], [bridge.solana.pool, "solana/pool"],
      [bridge.solana.poolSigner, "solana/poolSigner"], [bridge.solana.poolTokenAccount, "solana/poolTokenAccount"],
      [bridge.solana.lookupTable, "solana/lookupTable"]] as const;
    for (const [identity, pointer] of missing) {
      if (identity === null) { diagnostics.push(error("BRIDGE_IDENTITY_REQUIRED", `/deployment/deployment/bridge/${pointer}`)); }
    }
  }

  const tokenOperations = prepared.operations.filter(operation => operation.id === "token-create");
  if (tokenOperations.length !== 1) { diagnostics.push(error("TOKEN_CREATE_OPERATION_COUNT", "/prepared/operations")); }
  const tokenOperation = tokenOperations.length === 1 ? tokenOperations[0] : undefined;
  if (tokenOperation && tokenOperation.kind !== "create") { diagnostics.push(error("TOKEN_CREATE_OPERATION_KIND", "/prepared/operations/token-create/kind")); }
  const expectedToken = tokenOperation?.expectedAddress;
  if (tokenOperation && !isEvmAddress(expectedToken)) { diagnostics.push(error("TOKEN_CREATE_EXPECTED_ADDRESS", "/prepared/operations/token-create/expectedAddress")); }
  if (!isEvmAddress(pr21Token.ethereumToken)) { diagnostics.push(error("PR21_TOKEN_IDENTITY", "/pr21Token/ethereumToken")); }
  if (!isEvmAddress(lockReleasePool.pool)) { diagnostics.push(error("LOCK_RELEASE_POOL_IDENTITY", "/lockReleasePool/pool")); }
  if (!isEvmAddress(lockReleasePool.localToken)) { diagnostics.push(error("LOCK_RELEASE_LOCAL_TOKEN_IDENTITY", "/lockReleasePool/localToken")); }

  const deploymentToken = bridge?.ethereum.token;
  if (deploymentToken && expectedToken && deploymentToken !== expectedToken) { diagnostics.push(error("DEPLOYMENT_PREPARED_TOKEN_MISMATCH", "/prepared/operations/token-create/expectedAddress")); }
  if (expectedToken && expectedToken !== pr21Token.ethereumToken) { diagnostics.push(error("PREPARED_PR21_TOKEN_MISMATCH", "/pr21Token/ethereumToken")); }
  if (pr21Token.ethereumToken !== lockReleasePool.localToken) { diagnostics.push(error("PR21_POOL_TOKEN_MISMATCH", "/lockReleasePool/localToken")); }
  if (bridge?.ethereum.pool && bridge.ethereum.pool !== lockReleasePool.pool) { diagnostics.push(error("LOCK_RELEASE_POOL_MISMATCH", "/lockReleasePool/pool")); }

  const ordered = diagnostics.toSorted(compareDiagnostics);
  if (ordered.length || !bridge?.ethereum.token || !bridge.ethereum.pool || !bridge.solana.mint || !bridge.solana.pool) {
    return { diagnostics: ordered };
  }
  return { diagnostics: ordered, context: structuredClone({
    schema: "agtmai-ccip-preparation-v1",
    ethereumToken: bridge.ethereum.token,
    ethereumPool: bridge.ethereum.pool,
    solanaMint: bridge.solana.mint,
    solanaPool: bridge.solana.pool,
    evmSelector: config.environment.evmSelector,
    solanaSelector: config.environment.solanaSelector,
  }) };
}
