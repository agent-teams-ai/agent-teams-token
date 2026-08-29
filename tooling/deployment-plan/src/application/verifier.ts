import { canonicalJson, computePlanId, sha256Hex } from "../domain/identity.ts";
import { calculateCosts, checkedAdd, fail, parseUint } from "../domain/model.ts";
import { validateTrustRootSafety, type FeeQuote, type StablePlan } from "./builder.ts";
import type { ApprovedArtifact, DeploymentRpc, TrustRoots } from "./ports.ts";

export interface ReadyMarker {
  readonly schemaVersion: 1;
  readonly planSha256: string;
  readonly quoteSha256: string;
  readonly planId: string;
  readonly creationInputHash: string;
}

export interface VerificationRequest {
  readonly plan: StablePlan;
  readonly quote: FeeQuote;
  readonly roots: TrustRoots;
  readonly expected: ApprovedArtifact;
  readonly ready: ReadyMarker;
  readonly nowSeconds: bigint;
}

export interface RpcVerificationRequest {
  readonly rpc: DeploymentRpc;
  readonly plan: StablePlan;
  readonly quote: FeeQuote;
  readonly creationInput: `0x${string}`;
}

export function independentlyVerify(request: VerificationRequest): void {
  validateTrustRootSafety(request.roots);
  validatePlanSafety(request.plan);
  validatePlanTrust(request.plan, request.roots);
  validateBuildBindings(request.plan, request.expected);
  validateQuote(request);
  validateReadyBinding(request.plan, request.quote, request.ready);
}

export function verifyReadyDigests(
  planBytes: Uint8Array,
  quoteBytes: Uint8Array,
  ready: ReadyMarker,
): void {
  if (
    sha256Hex(planBytes) !== ready.planSha256
    || sha256Hex(quoteBytes) !== ready.quoteSha256
  ) {
    fail("READY_DIGEST_MISMATCH", "READY marker is stale or files were substituted");
  }
}

export async function independentlyVerifyRpc(request: RpcVerificationRequest): Promise<void> {
  const { rpc, plan, quote, creationInput } = request;
  const inputHash = sha256Hex(Buffer.from(creationInput.slice(2), "hex"));
  if (inputHash !== plan.identity.creationInputHash) {
    fail("CREATION_INPUT_MISMATCH", "reconstructed creation input differs from plan");
  }
  const chain = quantity(await rpc.request("eth_chainId", []));
  if (chain.toString() !== quote.observation.chainId) {
    fail("RPC_CHAIN_CHANGED", "RPC chain changed");
  }
  const tag = `0x${BigInt(quote.observation.blockNumber).toString(16)}`;
  const bound = record(await rpc.request("eth_getBlockByNumber", [tag, false]));
  const head = record(await rpc.request("eth_getBlockByNumber", ["latest", false]));
  validateRpcBlocks(bound, head, quote);
  const history = record(await rpc.request("eth_feeHistory", ["0x1", tag, []]));
  validateRpcFeeHistory(history, quote);
  const gas = quantity(await rpc.request("eth_estimateGas", [
    { from: plan.identity.from, data: creationInput, value: "0x0" },
    tag,
  ]));
  if (gas.toString() !== quote.observation.gasEstimate) {
    fail("RPC_ESTIMATE_CHANGED", "gas estimate changed");
  }
}

function validatePlanSafety(plan: StablePlan): void {
  if (
    plan.schemaVersion !== 1
    || plan.kind !== "deployment-plan"
    || plan.broadcastAllowed !== false
    || !plan.testOnly
    || plan.productionApproved
    || plan.mainnetAllowed
  ) {
    fail("PLAN_UNSAFE", "stable plan safety flags are invalid");
  }
  if (computePlanId(plan.identity) !== plan.planId) {
    fail("PLAN_ID_MISMATCH", "plan ID is forged");
  }
}

function validatePlanTrust(plan: StablePlan, roots: TrustRoots): void {
  const identity = plan.identity;
  if (
    identity.chainId !== roots.chainId
    || identity.from !== roots.from
    || identity.value !== "0"
    || identity.contractFqn !== roots.contractFqn
    || identity.buildProfile !== roots.buildProfile
    || identity.broadcastAllowed !== false
  ) {
    fail("PLAN_TRUST_MISMATCH", "plan differs from trust roots");
  }
  validateCapPolicy(identity.capPolicy, roots);
  if (
    identity.artifactSha256 !== roots.artifactSha256
    || identity.abiSha256 !== roots.abiSha256
    || identity.fixtureSha256 !== roots.fixtureSha256
    || identity.fixtureReadySha256 !== roots.fixtureReadySha256
    || identity.constructorArgumentsHash !== roots.constructorArgumentsHash
    || identity.creationInputHash !== roots.creationInputHash
  ) {
    fail("PLAN_ARTIFACT_MISMATCH", "plan artifact pins differ from trust roots");
  }
}

function validateCapPolicy(value: unknown, roots: TrustRoots): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("PLAN_CAP_POLICY_MISMATCH", "plan cap policy differs from trust roots");
  }
  const capPolicy = value as Record<string, unknown>;
  if (
    capPolicy.maximumWorstCaseWei !== roots.maximumWorstCaseWei
    || capPolicy.testOnly !== true
  ) {
    fail("PLAN_CAP_POLICY_MISMATCH", "plan cap policy differs from trust roots");
  }
}

function validateBuildBindings(plan: StablePlan, expected: ApprovedArtifact): void {
  const bindings: Readonly<Record<string, unknown>> = {
    buildInfoSha256: expected.buildInfoSha256,
    artifactSha256: expected.artifactSha256,
    abiSha256: expected.abiSha256,
    fixtureSha256: expected.fixtureSha256,
    sourceDependencyClosure: expected.sourceDependencyClosure,
    buildInfoSolcVersion: expected.buildInfoSolcVersion,
    compilerSettings: expected.compilerSettings,
    creationBytecodeHash: expected.creationBytecodeHash,
    constructorAbiBytes: expected.constructorAbiBytes,
    constructorAbiHash: expected.constructorAbiHash,
    constructorArguments: expected.constructorArguments,
    constructorArgumentsHash: expected.constructorArgumentsHash,
    creationInputHash: expected.creationInputHash,
  };
  for (const [key, value] of Object.entries(bindings)) {
    if (canonicalJson(plan.identity[key]) !== canonicalJson(value)) {
      fail(
        "PLAN_BUILD_BINDING_MISMATCH",
        `${key} differs from independently approved build input`,
      );
    }
  }
}

function validateQuote(request: VerificationRequest): void {
  const { plan, quote, roots, nowSeconds } = request;
  if (quote.planId !== plan.planId || quote.creationInputHash !== plan.identity.creationInputHash) {
    fail("QUOTE_PLAN_MISMATCH", "quote is not bound to plan creation input");
  }
  if (quote.observation.chainId !== roots.chainId) {
    fail("WRONG_CHAIN", "quote chain is wrong");
  }
  if (quote.bufferBps !== roots.gasBufferBps) {
    fail("QUOTE_BUFFER_MISMATCH", "quote gas buffer differs from trust roots");
  }
  validateQuoteFreshness(quote, roots, nowSeconds);
  validateQuoteTotals(quote, roots);
}

function validateQuoteFreshness(
  quote: FeeQuote,
  roots: TrustRoots,
  nowSeconds: bigint,
): void {
  const observation = quote.observation;
  const block = parseUint(observation.blockNumber, "blockNumber");
  const head = parseUint(observation.currentHeadNumber, "head");
  const newest = parseUint(observation.feeHistoryNewestBlock, "newest");
  if (
    block > head
    || newest !== block
    || head - block > parseUint(roots.maximumHeadLag, "head lag")
  ) {
    fail("QUOTE_HEAD_INVALID", "quote block binding is invalid");
  }
  if (block === head && observation.blockHash !== observation.currentHeadHash) {
    fail("REORGED_BLOCK", "quote head hash differs from bound block");
  }
  const blockTime = parseUint(observation.blockTimestamp, "blockTimestamp");
  const observedAt = parseUint(observation.observedAt, "observedAt");
  const ttl = parseUint(roots.quoteTtlSeconds, "ttl", false);
  const expires = parseUint(quote.expiresAt, "expiresAt");
  const expectedExpires = checkedAdd(observedAt, ttl, "quote expiry");
  if (expires !== expectedExpires) {
    fail("QUOTE_EXPIRY_FORGED", "quote expiry differs from observedAt plus TTL");
  }
  if (
    nowSeconds >= expires
    || blockTime > observedAt
    || observedAt > nowSeconds
    || observedAt - blockTime > ttl
  ) {
    fail(
      "STALE_QUOTE",
      "quote must satisfy blockTimestamp <= observedAt <= now < expiresAt",
    );
  }
}

function validateQuoteTotals(quote: FeeQuote, roots: TrustRoots): void {
  const observation = quote.observation;
  const totals = calculateCosts({
    gasEstimate: parseUint(observation.gasEstimate, "gasEstimate", false),
    bufferBps: parseUint(quote.bufferBps, "bufferBps"),
    baseFeePerGas: parseUint(observation.baseFeePerGas, "baseFee"),
    maxPriorityFeePerGas: parseUint(observation.maxPriorityFeePerGas, "priority"),
    maxFeePerGas: parseUint(observation.maxFeePerGas, "maxFee"),
    value: 0n,
    blockGasLimit: parseUint(observation.blockGasLimit, "blockGasLimit", false),
    maximumWorstCaseWei: parseUint(roots.maximumWorstCaseWei, "cap"),
  });
  if (
    String(totals.gasLimit) !== quote.gasLimit
    || String(totals.effectiveFee) !== quote.effectiveFeePerGas
    || String(totals.estimatedWei) !== quote.estimatedWei
    || String(totals.worstCaseWei) !== quote.worstCaseWei
  ) {
    fail("QUOTE_TOTALS_FORGED", "quote totals are forged");
  }
}

function validateReadyBinding(
  plan: StablePlan,
  quote: FeeQuote,
  ready: ReadyMarker,
): void {
  if (ready.planId !== plan.planId || ready.creationInputHash !== quote.creationInputHash) {
    fail("READY_BINDING_INVALID", "READY marker binding is invalid");
  }
}

function validateRpcBlocks(
  bound: Record<string, unknown>,
  head: Record<string, unknown>,
  quote: FeeQuote,
): void {
  if (
    quantity(bound.number).toString() !== quote.observation.blockNumber
    || bound.hash !== quote.observation.blockHash
    || quantity(bound.timestamp).toString() !== quote.observation.blockTimestamp
    || quantity(bound.gasLimit).toString() !== quote.observation.blockGasLimit
    || quantity(bound.baseFeePerGas).toString() !== quote.observation.baseFeePerGas
    || head.hash !== quote.observation.currentHeadHash
    || quantity(head.number).toString() !== quote.observation.currentHeadNumber
  ) {
    fail("RPC_BLOCK_CHANGED", "RPC block facts changed or were forged");
  }
}

function validateRpcFeeHistory(
  history: Record<string, unknown>,
  quote: FeeQuote,
): void {
  const fees = history.baseFeePerGas;
  if (!Array.isArray(fees) || fees.length !== 2) {
    fail("RPC_VERIFY_INVALID", "RPC fee history is malformed");
  }
  if (
    quantity(history.oldestBlock).toString()
      !== quote.observation.feeHistoryNewestBlock
    || quote.observation.feeHistoryNewestBlock
      !== quote.observation.blockNumber
    || quantity(fees[0]).toString() !== quote.observation.baseFeePerGas
  ) {
    fail("RPC_FEE_HISTORY_CHANGED", "RPC fee-history facts changed or were forged");
  }
  quantity(fees[1]);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("RPC_VERIFY_INVALID", "RPC verification response is malformed");
  }
  return value as Record<string, unknown>;
}

function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) {
    fail("RPC_VERIFY_INVALID", "RPC verification quantity is malformed");
  }
  return BigInt(value);
}
