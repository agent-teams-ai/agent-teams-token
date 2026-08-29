import type { ApprovedArtifact, TrustRoots } from "./ports.ts";
import { computePlanId, deriveCreateAddress } from "../domain/identity.ts";
import {
  calculateCosts,
  checkedAdd,
  fail,
  LOCAL_CHAIN_ID,
  parseUint,
} from "../domain/model.ts";

export interface StablePlan {
  readonly schemaVersion: 1;
  readonly kind: "deployment-plan";
  readonly planId: `0x${string}`;
  readonly identity: Record<string, unknown>;
  readonly broadcastAllowed: false;
  readonly testOnly: true;
  readonly productionApproved: false;
  readonly mainnetAllowed: false;
}

export interface QuoteObservation {
  readonly chainId: string;
  readonly blockNumber: string;
  readonly blockHash: `0x${string}`;
  readonly blockTimestamp: string;
  readonly currentHeadNumber: string;
  readonly currentHeadHash: `0x${string}`;
  readonly feeHistoryNewestBlock: string;
  readonly senderNonce: string;
  readonly gasEstimate: string;
  readonly blockGasLimit: string;
  readonly baseFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  readonly maxFeePerGas: string;
  readonly observedAt: string;
}

export interface FeeQuote {
  readonly schemaVersion: 1;
  readonly kind: "fee-quote";
  readonly planId: `0x${string}`;
  readonly creationInputHash: string;
  readonly observation: QuoteObservation;
  readonly bufferBps: string;
  readonly gasLimit: string;
  readonly effectiveFeePerGas: string;
  readonly estimatedWei: string;
  readonly worstCaseWei: string;
  readonly expiresAt: string;
  readonly informationalUsd?: string;
}

interface QuoteTimes {
  readonly block: bigint;
  readonly head: bigint;
  readonly newest: bigint;
  readonly timestamp: bigint;
  readonly observedAt: bigint;
  readonly ttl: bigint;
}

export function buildStablePlan(
  approved: ApprovedArtifact,
  roots: TrustRoots,
  observation: QuoteObservation,
): StablePlan {
  validateTrustRootSafety(roots);
  if (
    approved.constructorArgumentsHash !== roots.constructorArgumentsHash
    || approved.creationInputHash !== roots.creationInputHash
  ) {
    fail("GOLDEN_INPUT_MISMATCH", "creation input differs from independently pinned golden hashes");
  }
  if (observation.chainId !== roots.chainId) {
    fail("WRONG_CHAIN", "observed chain does not match approved chain");
  }
  const senderNonce = parseUint(observation.senderNonce, "senderNonce");
  const identity: Record<string, unknown> = {
    contractFqn: roots.contractFqn,
    buildProfile: roots.buildProfile,
    sourceDependencyClosure: approved.sourceDependencyClosure,
    buildInfoSha256: approved.buildInfoSha256,
    artifactSha256: approved.artifactSha256,
    abiSha256: approved.abiSha256,
    fixtureSha256: approved.fixtureSha256,
    fixtureReadySha256: roots.fixtureReadySha256,
    buildInfoSolcVersion: approved.buildInfoSolcVersion,
    compilerInputSha256: approved.compilerInputSha256,
    compilerSettings: approved.compilerSettings,
    creationBytecodeHash: approved.creationBytecodeHash,
    constructorAbiBytes: approved.constructorAbiBytes,
    constructorAbiHash: approved.constructorAbiHash,
    constructorArguments: approved.constructorArguments,
    constructorArgumentsHash: approved.constructorArgumentsHash,
    creationInput: approved.creationInput,
    creationInputHash: approved.creationInputHash,
    chainId: roots.chainId,
    from: roots.from,
    senderNonce: senderNonce.toString(),
    expectedCreateAddress: deriveCreateAddress(roots.from, senderNonce),
    observedBlockNumber: parseUint(observation.blockNumber, "blockNumber").toString(),
    observedBlockHash: observation.blockHash,
    value: "0",
    capPolicy: { maximumWorstCaseWei: roots.maximumWorstCaseWei, testOnly: true },
    broadcastAllowed: false,
  };
  return {
    schemaVersion: 1,
    kind: "deployment-plan",
    planId: computePlanId(identity),
    identity,
    broadcastAllowed: false,
    testOnly: true,
    productionApproved: false,
    mainnetAllowed: false,
  };
}

export function buildFeeQuote(
  plan: StablePlan,
  observation: QuoteObservation,
  roots: TrustRoots,
): FeeQuote {
  if (observation.chainId !== roots.chainId) {
    fail("WRONG_CHAIN", "observed chain does not match approved chain");
  }
  const times = parseQuoteTimes(observation, roots);
  validateQuoteBinding(observation, roots, times);
  const costs = calculateCosts({
    gasEstimate: parseUint(observation.gasEstimate, "gasEstimate", false),
    bufferBps: parseUint(roots.gasBufferBps, "gasBufferBps"),
    baseFeePerGas: parseUint(observation.baseFeePerGas, "baseFeePerGas"),
    maxPriorityFeePerGas: parseUint(
      observation.maxPriorityFeePerGas,
      "maxPriorityFeePerGas",
    ),
    maxFeePerGas: parseUint(observation.maxFeePerGas, "maxFeePerGas"),
    value: 0n,
    blockGasLimit: parseUint(observation.blockGasLimit, "blockGasLimit", false),
    maximumWorstCaseWei: parseUint(roots.maximumWorstCaseWei, "maximumWorstCaseWei"),
  });
  return {
    schemaVersion: 1,
    kind: "fee-quote",
    planId: plan.planId,
    creationInputHash: String(plan.identity.creationInputHash),
    observation,
    bufferBps: roots.gasBufferBps,
    gasLimit: String(costs.gasLimit),
    effectiveFeePerGas: String(costs.effectiveFee),
    estimatedWei: String(costs.estimatedWei),
    worstCaseWei: String(costs.worstCaseWei),
    expiresAt: String(checkedAdd(times.observedAt, times.ttl, "quote expiry")),
  };
}

export function validateTrustRootSafety(roots: TrustRoots): void {
  if (
    roots.schemaVersion !== 1
    ||
    roots.chainId !== LOCAL_CHAIN_ID
    || !roots.testOnly
    || roots.productionApproved
    || roots.mainnetAllowed
  ) {
    fail("TRUST_ROOTS_UNSAFE", "trust roots are not local test-only roots");
  }
  for (const [field, value] of [
    ["artifactSha256", roots.artifactSha256],
    ["abiSha256", roots.abiSha256],
    ["fixtureSha256", roots.fixtureSha256],
    ["fixtureReadySha256", roots.fixtureReadySha256],
    ["compilerInputSha256", roots.compilerInputSha256],
    ["constructorArgumentsHash", roots.constructorArgumentsHash],
    ["creationInputHash", roots.creationInputHash],
  ] as const) {
    if (!/^0x[0-9a-f]{64}$/u.test(value)) {
      fail("TRUST_ROOTS_INVALID", `${field} is not a SHA-256 hash`);
    }
  }
  if (!/^0x[0-9a-f]{40}$/u.test(roots.from)) {
    fail("TRUST_ROOTS_INVALID", "trusted deployer is malformed");
  }
  parseUint(roots.maximumWorstCaseWei, "maximumWorstCaseWei");
  parseUint(roots.gasBufferBps, "gasBufferBps");
  parseUint(roots.quoteTtlSeconds, "quoteTtlSeconds", false);
  parseUint(roots.maximumHeadLag, "maximumHeadLag");
}

function parseQuoteTimes(observation: QuoteObservation, roots: TrustRoots): QuoteTimes {
  return {
    block: parseUint(observation.blockNumber, "blockNumber"),
    head: parseUint(observation.currentHeadNumber, "currentHeadNumber"),
    newest: parseUint(observation.feeHistoryNewestBlock, "feeHistoryNewestBlock"),
    timestamp: parseUint(observation.blockTimestamp, "blockTimestamp"),
    observedAt: parseUint(observation.observedAt, "observedAt"),
    ttl: parseUint(roots.quoteTtlSeconds, "quoteTtlSeconds", false),
  };
}

function validateQuoteBinding(
  observation: QuoteObservation,
  roots: TrustRoots,
  times: QuoteTimes,
): void {
  if (times.block > times.head || times.newest > times.head) {
    fail("FUTURE_BLOCK", "quote references a future block");
  }
  if (times.head - times.block > parseUint(roots.maximumHeadLag, "maximumHeadLag")) {
    fail("HEAD_LAG", "quote block is too far behind head");
  }
  if (times.newest !== times.block) {
    fail("FEE_HISTORY_BLOCK_MISMATCH", "fee history is not bound to estimate block");
  }
  if (times.timestamp > times.observedAt) {
    fail("FUTURE_TIMESTAMP", "block timestamp is in the future");
  }
  if (times.observedAt - times.timestamp > times.ttl) {
    fail("STALE_QUOTE", "block timestamp is stale");
  }
  validateBlockHashes(observation, times);
}

function validateBlockHashes(observation: QuoteObservation, times: QuoteTimes): void {
  const validBoundHash = /^0x[0-9a-f]{64}$/u.test(observation.blockHash);
  const validHeadHash = /^0x[0-9a-f]{64}$/u.test(observation.currentHeadHash);
  if (!validBoundHash || !validHeadHash) {
    fail("BLOCK_HASH_INVALID", "block hash is malformed");
  }
  if (times.block === times.head && observation.blockHash !== observation.currentHeadHash) {
    fail("REORGED_BLOCK", "head hash differs from the bound estimate block");
  }
}
