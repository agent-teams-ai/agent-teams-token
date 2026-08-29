import { canonicalJson, computePlanId, sha256Hex } from "../domain/identity.ts";
import { calculateCosts, fail, parseUint } from "../domain/model.ts";
import type { FeeQuote, StablePlan } from "./builder.ts";
import type { TrustRoots } from "../adapters/artifact.ts";
import type { ApprovedArtifact } from "../adapters/artifact.ts";
import type { DeploymentRpc } from "./ports.ts";

export interface ReadyMarker { readonly schemaVersion: 1; readonly planSha256: string; readonly quoteSha256: string; readonly planId: string; readonly creationInputHash: string }
export function independentlyVerify(plan: StablePlan, quote: FeeQuote, roots: TrustRoots, expected: ApprovedArtifact, ready: ReadyMarker, nowSeconds: bigint): void {
  if (plan.schemaVersion !== 1 || plan.kind !== "deployment-plan" || plan.broadcastAllowed !== false || !plan.testOnly || plan.productionApproved || plan.mainnetAllowed) fail("PLAN_UNSAFE", "stable plan safety flags are invalid");
  if (computePlanId(plan.identity) !== plan.planId) fail("PLAN_ID_MISMATCH", "plan ID is forged");
  if (plan.identity.chainId !== roots.chainId || plan.identity.from !== roots.from || plan.identity.value !== "0" || plan.identity.contractFqn !== roots.contractFqn || plan.identity.buildProfile !== roots.buildProfile || plan.identity.broadcastAllowed !== false) fail("PLAN_TRUST_MISMATCH", "plan differs from trust roots");
  const capPolicy = plan.identity.capPolicy; if (capPolicy === null || typeof capPolicy !== "object" || Array.isArray(capPolicy) || (capPolicy as Record<string, unknown>).maximumWorstCaseWei !== roots.maximumWorstCaseWei || (capPolicy as Record<string, unknown>).testOnly !== true) fail("PLAN_CAP_POLICY_MISMATCH", "plan cap policy differs from trust roots");
  if (plan.identity.artifactSha256 !== roots.artifactSha256 || plan.identity.abiSha256 !== roots.abiSha256 || plan.identity.fixtureSha256 !== roots.fixtureSha256 || plan.identity.fixtureReadySha256 !== roots.fixtureReadySha256) fail("PLAN_ARTIFACT_MISMATCH", "plan artifact pins differ from trust roots");
  const bindings: Readonly<Record<string, unknown>> = { buildInfoSha256: expected.buildInfoSha256, artifactSha256: expected.artifactSha256, abiSha256: expected.abiSha256, fixtureSha256: expected.fixtureSha256, sourceDependencyClosure: expected.sourceDependencyClosure, solcVersion: expected.solcVersion, compilerSettings: expected.compilerSettings, creationBytecodeHash: expected.creationBytecodeHash, constructorAbiBytes: expected.constructorAbiBytes, constructorAbiHash: expected.constructorAbiHash, constructorArguments: expected.constructorArguments, constructorArgumentsHash: expected.constructorArgumentsHash, creationInputHash: expected.creationInputHash };
  for (const [key, value] of Object.entries(bindings)) if (canonicalJson(plan.identity[key]) !== canonicalJson(value)) fail("PLAN_BUILD_BINDING_MISMATCH", `${key} differs from independently approved build input`);
  if (quote.planId !== plan.planId || quote.creationInputHash !== plan.identity.creationInputHash) fail("QUOTE_PLAN_MISMATCH", "quote is not bound to plan creation input");
  const o = quote.observation; if (o.chainId !== roots.chainId) fail("WRONG_CHAIN", "quote chain is wrong");
  const block = parseUint(o.blockNumber, "blockNumber"); const head = parseUint(o.currentHeadNumber, "head"); const newest = parseUint(o.feeHistoryNewestBlock, "newest"); const blockTime = parseUint(o.blockTimestamp, "blockTimestamp");
  if (block > head || newest !== block || head - block > parseUint(roots.maximumHeadLag, "head lag")) fail("QUOTE_HEAD_INVALID", "quote block binding is invalid");
  if (block === head && o.blockHash !== o.currentHeadHash) fail("REORGED_BLOCK", "quote head hash differs from bound block");
  const expires = parseUint(quote.expiresAt, "expiresAt"); if (nowSeconds >= expires || blockTime > nowSeconds || nowSeconds - blockTime > parseUint(roots.quoteTtlSeconds, "ttl")) fail("STALE_QUOTE", "quote is stale at the exact expiry boundary");
  const totals = calculateCosts({ gasEstimate: parseUint(o.gasEstimate, "gasEstimate", false), bufferBps: parseUint(quote.bufferBps, "bufferBps"), baseFeePerGas: parseUint(o.baseFeePerGas, "baseFee"), maxPriorityFeePerGas: parseUint(o.maxPriorityFeePerGas, "priority"), maxFeePerGas: parseUint(o.maxFeePerGas, "maxFee"), value: 0n, blockGasLimit: parseUint(o.blockGasLimit, "blockGasLimit", false), maximumWorstCaseWei: parseUint(roots.maximumWorstCaseWei, "cap") });
  if (String(totals.gasLimit) !== quote.gasLimit || String(totals.effectiveFee) !== quote.effectiveFeePerGas || String(totals.estimatedWei) !== quote.estimatedWei || String(totals.worstCaseWei) !== quote.worstCaseWei) fail("QUOTE_TOTALS_FORGED", "quote totals are forged");
  if (ready.planId !== plan.planId || ready.creationInputHash !== quote.creationInputHash) fail("READY_BINDING_INVALID", "READY marker binding is invalid");
}
export function verifyReadyDigests(planBytes: Uint8Array, quoteBytes: Uint8Array, ready: ReadyMarker): void { if (sha256Hex(planBytes) !== ready.planSha256 || sha256Hex(quoteBytes) !== ready.quoteSha256) fail("READY_DIGEST_MISMATCH", "READY marker is stale or files were substituted"); }

export async function independentlyVerifyRpc(rpc: DeploymentRpc, plan: StablePlan, quote: FeeQuote, creationInput: `0x${string}`): Promise<void> {
  if (sha256Hex(Buffer.from(creationInput.slice(2), "hex")) !== plan.identity.creationInputHash) fail("CREATION_INPUT_MISMATCH", "reconstructed creation input differs from plan");
  const chain = quantity(await rpc.request("eth_chainId", [])); if (chain.toString() !== quote.observation.chainId) fail("RPC_CHAIN_CHANGED", "RPC chain changed");
  const tag = `0x${BigInt(quote.observation.blockNumber).toString(16)}`; const bound = record(await rpc.request("eth_getBlockByNumber", [tag, false])); const head = record(await rpc.request("eth_getBlockByNumber", ["latest", false]));
  if (bound.hash !== quote.observation.blockHash || head.hash !== quote.observation.currentHeadHash || quantity(head.number).toString() !== quote.observation.currentHeadNumber) fail("RPC_BLOCK_CHANGED", "RPC block binding changed or reorged");
  const history = record(await rpc.request("eth_feeHistory", ["0x1", tag, []])); if (quantity(history.oldestBlock).toString() !== quote.observation.feeHistoryNewestBlock) fail("RPC_FEE_HISTORY_CHANGED", "fee-history head changed");
  const gas = quantity(await rpc.request("eth_estimateGas", [{ from: plan.identity.from, data: creationInput, value: "0x0" }, tag])); if (gas.toString() !== quote.observation.gasEstimate) fail("RPC_ESTIMATE_CHANGED", "gas estimate changed");
}
function record(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail("RPC_VERIFY_INVALID", "RPC verification response is malformed"); return value as Record<string, unknown>; }
function quantity(value: unknown): bigint { if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/u.test(value)) fail("RPC_VERIFY_INVALID", "RPC verification quantity is malformed"); return BigInt(value); }
