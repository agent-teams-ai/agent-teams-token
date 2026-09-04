import {
  canonicalJson,
  computePlanId,
  deriveCreateAddress,
  sha256Hex,
} from "../domain/identity.ts";
import { calculateCosts, checkedAdd, fail, parseUint } from "../domain/model.ts";
import { validateTrustRootSafety, type FeeQuote, type StablePlan } from "./builder.ts";
import type { ApprovedArtifact, DeploymentRpc, NativeNoReplaceEvidence, NativeNoReplaceEvidenceFields, NativeNoReplacePolicy, RawArtifactInputs, TrustRoots } from "./ports.ts";
import { parseNativeNoReplaceEvidence } from "../adapters/strict-json.ts";
import { independentlyApproveRawArtifact } from "./raw-artifact-verifier.ts";

export interface ReadyMarker {
  readonly schemaVersion: 3;
  readonly planSha256: string;
  readonly quoteSha256: string;
  readonly nativeNoReplaceEvidenceSha256: string;
  readonly planId: string;
  readonly creationInputHash: string;
}

export interface VerificationRequest {
  readonly plan: StablePlan;
  readonly quote: FeeQuote;
  readonly roots: TrustRoots;
  readonly expected: ApprovedArtifact;
  readonly artifactInputs: RawArtifactInputs;
  readonly ready: ReadyMarker;
  readonly nowSeconds: bigint;
  readonly nativeNoReplaceEvidenceBytes: Uint8Array;
  readonly nativeNoReplacePolicy: NativeNoReplacePolicy;
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
  const independentlyApproved = independentlyApproveRawArtifact(request.artifactInputs, request.roots);
  validateBuildBindings(request.plan, independentlyApproved);
  validateBuilderAgreement(request.expected, independentlyApproved);
  validateQuote(request);
  verifyNativeNoReplaceEvidence(request.nativeNoReplaceEvidenceBytes, request.nativeNoReplacePolicy);
  validateReadyBinding(request.plan, request.quote, request.ready);
}

export function verifyReadyDigests(
  planBytes: Uint8Array,
  quoteBytes: Uint8Array,
  nativeNoReplaceEvidenceBytes: Uint8Array,
  ready: ReadyMarker,
): void {
  if (
    sha256Hex(planBytes) !== ready.planSha256
    || sha256Hex(quoteBytes) !== ready.quoteSha256
    || sha256Hex(nativeNoReplaceEvidenceBytes) !== ready.nativeNoReplaceEvidenceSha256
  ) {
    fail("READY_DIGEST_MISMATCH", "READY marker is stale or files were substituted");
  }
}

export function verifyNativeNoReplaceEvidence(
  bytes: Uint8Array,
  candidatePolicy: NativeNoReplacePolicy,
): NativeNoReplaceEvidence {
  const policy = validateNativePolicy(candidatePolicy);
  const evidence = parseNativeNoReplaceEvidence(bytes);
  const platformPolicy = policy.platforms[evidence.platform];
  if (
    evidence.sourcePath !== policy.sourcePath
    || evidence.sourceSha256 !== policy.sourceSha256
    || evidence.compileProfile !== policy.compileProfile
    || evidence.compilerExecution !== platformPolicy.strategy
  ) {
    fail("NATIVE_EVIDENCE_POLICY_MISMATCH", "native evidence differs from build policy");
  }
  if (!platformPolicy.tuples.some((tuple) =>
    tuple.compilerPath === evidence.compilerPath
    && tuple.compilerSha256 === evidence.compilerSha256
    && tuple.executableSha256 === evidence.executableSha256)) {
    fail("NATIVE_EVIDENCE_TUPLE_UNAPPROVED", "native evidence tuple is not atomically approved");
  }
  const fields: NativeNoReplaceEvidenceFields = {
    platform: evidence.platform,
    sourcePath: evidence.sourcePath,
    sourceSha256: evidence.sourceSha256,
    compileProfile: evidence.compileProfile,
    compilerExecution: evidence.compilerExecution,
    compilerPath: evidence.compilerPath,
    compilerSha256: evidence.compilerSha256,
    executableSha256: evidence.executableSha256,
  };
  const approval = sha256Hex(Buffer.concat([
    Buffer.from("AGTMAI_NATIVE_NO_REPLACE_APPROVAL_V1\0"),
    Buffer.from(canonicalJson(fields)),
  ]));
  if (approval !== evidence.approvalSha256) {
    fail("NATIVE_EVIDENCE_APPROVAL_FORGED", "native evidence approval digest is forged");
  }
  return evidence;
}

function validateNativePolicy(value: unknown): NativeNoReplacePolicy {
  const policy = exactNativePolicyObject(value, [
    "schemaVersion", "kind", "sourcePath", "sourceSha256", "compileProfile", "platforms",
  ]);
  if (
    policy.schemaVersion !== 1
    || policy.kind !== "native-no-replace-build-policy"
    || policy.sourcePath !== "tooling/deployment-plan/native/no-replace.c"
    || policy.sourceSha256 !== "0xf3bd0279809e011933eb6ed92d55c2c7ee3bb28dedb2294ea47fe49a25483f09"
    || policy.compileProfile !== "c11-o2-werror-stdin-v1"
  ) {
    fail("NATIVE_EVIDENCE_POLICY_INVALID", "native evidence policy is invalid");
  }
  const platforms = exactNativePolicyObject(policy.platforms, ["darwin-arm64", "linux-x64"]);
  validateNativePolicyPlatform(platforms["darwin-arm64"], "verified-path");
  validateNativePolicyPlatform(platforms["linux-x64"], "snapshot-fd");
  return policy as unknown as NativeNoReplacePolicy;
}

function validateNativePolicyPlatform(value: unknown, strategy: string): void {
  const platform = exactNativePolicyObject(value, ["strategy", "tuples"]);
  if (platform.strategy !== strategy || !Array.isArray(platform.tuples)
    || platform.tuples.length < 1 || platform.tuples.length > 2) {
    fail("NATIVE_EVIDENCE_POLICY_INVALID", "native evidence platform policy is invalid");
  }
  const tuples = platform.tuples.map((value) => exactNativePolicyObject(
    value, ["compilerPath", "compilerSha256", "executableSha256"],
  ));
  const serialized = tuples.map((tuple) => canonicalJson(tuple));
  const compilers = tuples.map((tuple) => `${String(tuple.compilerPath)}|${String(tuple.compilerSha256)}`);
  if (tuples.some((tuple) => tuple.compilerPath !== "/usr/bin/cc"
      || typeof tuple.compilerSha256 !== "string" || !/^0x[0-9a-f]{64}$/u.test(tuple.compilerSha256)
      || typeof tuple.executableSha256 !== "string" || !/^0x[0-9a-f]{64}$/u.test(tuple.executableSha256))
    || new Set(serialized).size !== serialized.length
    || new Set(compilers).size !== compilers.length
    || serialized.some((entry, index) => index > 0 && serialized[index - 1]! >= entry)) {
    fail("NATIVE_EVIDENCE_POLICY_INVALID", "native evidence tuples are malformed");
  }
}

function exactNativePolicyObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("NATIVE_EVIDENCE_POLICY_INVALID", "native evidence policy member is malformed");
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).toSorted();
  const expected = [...expectedKeys].toSorted();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail("NATIVE_EVIDENCE_POLICY_INVALID", "native evidence policy has unknown members");
  }
  return object;
}

export async function independentlyVerifyRpc(request: RpcVerificationRequest): Promise<void> {
  const { rpc, plan, quote, creationInput } = request;
  const inputHash = sha256Hex(Buffer.from(creationInput.slice(2), "hex"));
  if (creationInput !== plan.identity.creationInput || inputHash !== plan.identity.creationInputHash) {
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
  const nonce = quantity(await rpc.request("eth_getTransactionCount", [
    plan.identity.from,
    tag,
  ]));
  if (
    nonce.toString() !== quote.observation.senderNonce
  ) {
    fail("RPC_NONCE_CHANGED", "sender nonce changed or was cross-swapped");
  }
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
    plan.schemaVersion !== 2
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
    || identity.canonicalBuildInfoSha256 !== roots.canonicalBuildInfoSha256
    || canonicalJson(identity.sourceDependencyClosure) !== canonicalJson(roots.sourceDependencyClosure)
    || identity.buildInfoSolcVersion !== roots.buildInfoSolcVersion
    || canonicalJson(identity.compilerSettings) !== canonicalJson(roots.compilerSettings)
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
    || identity.compilerInputSha256 !== roots.compilerInputSha256
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

function validateBuilderAgreement(expected: ApprovedArtifact, independent: ApprovedArtifact): void {
  if (canonicalJson(expected) !== canonicalJson(independent)) {
    fail("BUILDER_VERIFICATION_MISMATCH", "builder verification mismatch against independent raw inputs");
  }
}

function validateBuildBindings(plan: StablePlan, expected: ApprovedArtifact): void {
  const bindings: Readonly<Record<string, unknown>> = {
    rawBuildInfoSha256: expected.rawBuildInfoSha256,
    canonicalBuildInfoSha256: expected.canonicalBuildInfoSha256,
    artifactSha256: expected.artifactSha256,
    abiSha256: expected.abiSha256,
    fixtureSha256: expected.fixtureSha256,
    sourceDependencyClosure: expected.sourceDependencyClosure,
    buildInfoSolcVersion: expected.buildInfoSolcVersion,
    compilerInputSha256: expected.compilerInputSha256,
    compilerSettings: expected.compilerSettings,
    creationBytecodeHash: expected.creationBytecodeHash,
    constructorAbiBytes: expected.constructorAbiBytes,
    constructorAbiHash: expected.constructorAbiHash,
    constructorArguments: expected.constructorArguments,
    constructorArgumentsHash: expected.constructorArgumentsHash,
    creationInput: expected.creationInput,
    creationInputHash: expected.creationInputHash,
  };
  for (const [key, value] of Object.entries(bindings)) {
    if (canonicalJson(plan.identity[key]) !== canonicalJson(value)) {
      fail(
        "PLAN_BUILD_BINDING_MISMATCH",
        `${key} has a mismatch with independent approved build input`,
      );
    }
  }
}

function validateQuote(request: VerificationRequest): void {
  const { plan, quote, roots, nowSeconds } = request;
  if (quote.planId !== plan.planId || quote.creationInputHash !== plan.identity.creationInputHash) {
    fail("QUOTE_PLAN_MISMATCH", "quote is not bound to plan creation input");
  }
  const nonce = parseUint(quote.observation.senderNonce, "senderNonce");
  if (quote.observation.expectedCreateAddress !== deriveCreateAddress(roots.from, nonce)) {
    fail("CREATE_ADDRESS_MISMATCH", "quote CREATE address is not derived from sender and nonce");
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
