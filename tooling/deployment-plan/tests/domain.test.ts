import assert from "node:assert/strict";
import test from "node:test";
import { calculateCosts, ceilDiv, UINT256_MAX } from "../src/domain/model.ts";
import { buildFeeQuote, buildStablePlan, type QuoteObservation } from "../src/application/builder.ts";
import { computePlanId } from "../src/domain/identity.ts";
import type { ApprovedArtifact, TrustRoots } from "../src/adapters/artifact.ts";

const hash = `0x${"1".repeat(64)}` as const;
const roots: TrustRoots = { schemaVersion: 1, testOnly: true, productionApproved: false, mainnetAllowed: false, chainId: "31337", contractFqn: "x.sol:X", buildProfile: "default", from: "0x0000000000000000000000000000000000000001", maximumWorstCaseWei: "12012000000000000", gasBufferBps: "2000", quoteTtlSeconds: "60", maximumHeadLag: "2", solcVersion: "0.8.36+commit.8a079791", compilerSettings: {}, artifactSha256: hash, abiSha256: hash, fixtureSha256: hash, fixtureReadySha256: hash, sourceDependencyClosure: {} };
const artifact: ApprovedArtifact = { buildInfoSha256: hash, artifactSha256: hash, abiSha256: hash, fixtureSha256: hash, sourceDependencyClosure: {}, solcVersion: roots.solcVersion, compilerSettings: {}, creationBytecode: "0x01", creationBytecodeHash: hash, constructorAbiBytes: "0x02", constructorAbiHash: hash, constructorArguments: "0x03", constructorArgumentsHash: hash, creationInput: "0x0103", creationInputHash: hash };
const observation: QuoteObservation = { chainId: "31337", blockNumber: "9007199254740993", blockHash: hash, blockTimestamp: "1000", currentHeadNumber: "9007199254740994", currentHeadHash: hash, feeHistoryNewestBlock: "9007199254740993", gasEstimate: "1000000", blockGasLimit: "30000000", baseFeePerGas: "7000000000", maxPriorityFeePerGas: "1000000000", maxFeePerGas: "10000000000", observedAt: "1010" };

test("2^53+, EIP-1559 formulas and ceil rounding are exact", () => {
  assert.equal(ceilDiv(10_001n, 10_000n), 2n);
  const result = calculateCosts({ gasEstimate: 9_007_199_254_740_993n, bufferBps: 1n, baseFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxFeePerGas: 4n, value: 0n, blockGasLimit: 10_000_000_000_000_000n, maximumWorstCaseWei: UINT256_MAX });
  assert.equal(result.gasLimit, 9_008_099_974_666_468n); assert.equal(result.effectiveFee, 3n);
});
test("cap is inclusive and rejects cap plus one before a quote exists", () => {
  const exact = calculateCosts({ gasEstimate: 100n, bufferBps: 0n, baseFeePerGas: 1n, maxPriorityFeePerGas: 0n, maxFeePerGas: 2n, value: 0n, blockGasLimit: 100n, maximumWorstCaseWei: 200n }); assert.equal(exact.worstCaseWei, 200n);
  assert.throws(() => calculateCosts({ gasEstimate: 100n, bufferBps: 0n, baseFeePerGas: 1n, maxPriorityFeePerGas: 0n, maxFeePerGas: 2n, value: 0n, blockGasLimit: 100n, maximumWorstCaseWei: 199n }), /cap/u);
});
test("malformed fee relations and overflow fail closed", () => {
  const base = { gasEstimate: 100n, bufferBps: 0n, baseFeePerGas: 2n, maxPriorityFeePerGas: 1n, maxFeePerGas: 3n, value: 0n, blockGasLimit: 1000n, maximumWorstCaseWei: UINT256_MAX };
  assert.throws(() => calculateCosts({ ...base, maxFeePerGas: 1n }), /below base/u); assert.throws(() => calculateCosts({ ...base, maxPriorityFeePerGas: 4n }), /exceeds max/u); assert.throws(() => calculateCosts({ ...base, gasEstimate: UINT256_MAX, bufferBps: 1n }), /overflow/u);
});
test("gas estimate changes quote but not stable plan identity", () => {
  const plan = buildStablePlan(artifact, roots); assert.equal(plan.planId, "0xf5f7daa9db3525a8789f522a553187f349d2d1025db7865d80d1b0c7cfcbf8c5"); const first = buildFeeQuote(plan, observation, roots); const second = buildFeeQuote(plan, { ...observation, gasEstimate: "1000001" }, roots);
  assert.equal(first.planId, second.planId); assert.notEqual(first.estimatedWei, second.estimatedWei);
});
test("every stable identity field participates in planId", () => {
  const identity = buildStablePlan(artifact, roots).identity; const baseline = computePlanId(identity);
  for (const key of Object.keys(identity)) {
    const value = identity[key]; const changed = { ...identity, [key]: typeof value === "string" ? `${value}x` : typeof value === "boolean" ? !value : Array.isArray(value) ? [...value, "x"] : { ...(value as Record<string, unknown>), mutation: "x" } };
    assert.notEqual(computePlanId(changed), baseline, key);
  }
});
