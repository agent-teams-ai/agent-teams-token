import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovedArtifact, TrustRoots } from "../src/adapters/artifact.ts";
import { buildFeeQuote, buildStablePlan, type QuoteObservation } from "../src/application/builder.ts";
import { computePlanId, deriveCreateAddress } from "../src/domain/identity.ts";
import { calculateCosts, ceilDiv, UINT256_MAX, type CostInput } from "../src/domain/model.ts";

const hash = `0x${"1".repeat(64)}` as const;
const roots: TrustRoots = {
  schemaVersion: 1,
  testOnly: true,
  productionApproved: false,
  mainnetAllowed: false,
  chainId: "31337",
  contractFqn: "x.sol:X",
  buildProfile: "default",
  from: "0x0000000000000000000000000000000000000001",
  maximumWorstCaseWei: "12012000000000000",
  gasBufferBps: "2000",
  quoteTtlSeconds: "60",
  maximumHeadLag: "2",
  buildInfoSolcVersion: "0.8.36",
  compilerInputSha256: hash,
  compilerSettings: {},
  artifactSha256: hash,
  abiSha256: hash,
  fixtureSha256: hash,
  fixtureReadySha256: hash,
  constructorArgumentsHash: hash,
  creationInputHash: hash,
  sourceDependencyClosure: {},
};
const artifact: ApprovedArtifact = {
  buildInfoSha256: hash,
  artifactSha256: hash,
  abiSha256: hash,
  fixtureSha256: hash,
  sourceDependencyClosure: {},
  buildInfoSolcVersion: roots.buildInfoSolcVersion,
  compilerInputSha256: roots.compilerInputSha256,
  compilerSettings: {},
  creationBytecode: "0x01",
  creationBytecodeHash: hash,
  constructorAbiBytes: "0x02",
  constructorAbiHash: hash,
  constructorArguments: "0x03",
  constructorArgumentsHash: hash,
  creationInput: "0x0103",
  creationInputHash: hash,
};
const observation: QuoteObservation = {
  chainId: "31337",
  blockNumber: "9007199254740993",
  blockHash: hash,
  blockTimestamp: "1000",
  currentHeadNumber: "9007199254740994",
  currentHeadHash: hash,
  feeHistoryNewestBlock: "9007199254740993",
  senderNonce: "0",
  gasEstimate: "1000000",
  blockGasLimit: "30000000",
  baseFeePerGas: "7000000000",
  maxPriorityFeePerGas: "1000000000",
  maxFeePerGas: "10000000000",
  observedAt: "1010",
};

test("2^53+, EIP-1559 formulas and ceil rounding are exact", () => {
  assert.equal(ceilDiv(10_001n, 10_000n), 2n);
  const result = calculateCosts({
    gasEstimate: 9_007_199_254_740_993n,
    bufferBps: 1n,
    baseFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    maxFeePerGas: 4n,
    value: 0n,
    blockGasLimit: 10_000_000_000_000_000n,
    maximumWorstCaseWei: UINT256_MAX,
  });
  assert.equal(result.gasLimit, 9_008_099_974_666_468n);
  assert.equal(result.effectiveFee, 3n);
  const cappedFee = calculateCosts({
    gasEstimate: 1n,
    bufferBps: 0n,
    baseFeePerGas: 2n,
    maxPriorityFeePerGas: 5n,
    maxFeePerGas: 5n,
    value: 0n,
    blockGasLimit: 1n,
    maximumWorstCaseWei: UINT256_MAX,
  });
  assert.equal(cappedFee.effectiveFee, 5n);
});

test("cap is inclusive and rejects cap plus one before a quote exists", () => {
  const base: CostInput = {
    gasEstimate: 100n,
    bufferBps: 0n,
    baseFeePerGas: 1n,
    maxPriorityFeePerGas: 0n,
    maxFeePerGas: 2n,
    value: 0n,
    blockGasLimit: 100n,
    maximumWorstCaseWei: 200n,
  };
  assert.equal(calculateCosts(base).worstCaseWei, 200n);
  assert.throws(
    () => calculateCosts({ ...base, maximumWorstCaseWei: 199n }),
    /cap/u,
  );
});

test("malformed fee relations and overflow fail closed", () => {
  const base: CostInput = {
    gasEstimate: 100n,
    bufferBps: 0n,
    baseFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    maxFeePerGas: 3n,
    value: 0n,
    blockGasLimit: 1000n,
    maximumWorstCaseWei: UINT256_MAX,
  };
  assert.throws(() => calculateCosts({ ...base, maxFeePerGas: 1n }), /below base/u);
  assert.throws(
    () => calculateCosts({ ...base, maxPriorityFeePerGas: 4n }),
    /exceeds max/u,
  );
  assert.throws(
    () => calculateCosts({ ...base, gasEstimate: UINT256_MAX, bufferBps: 1n }),
    /overflow/u,
  );
});

test("gas estimate changes quote but not stable plan identity", () => {
  const plan = buildStablePlan(artifact, roots, observation);
  assert.equal(plan.planId, "0xd89550765c467336db2e06951bc6bccd807d0fb436fb83d49a39f49a905f6733");
  const first = buildFeeQuote(plan, observation, roots);
  const second = buildFeeQuote(plan, { ...observation, gasEstimate: "1000001" }, roots);
  assert.equal(first.planId, second.planId);
  assert.notEqual(first.estimatedWei, second.estimatedWei);
});

test("canonical RLP plus Ethereum Keccak derives CREATE nonce and integer boundaries", () => {
  const sender = "0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0";
  const vectors = [
    [0n, "0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d"],
    [1n, "0x343c43a37d37dff08ae8c4a11544c718abb4fcf8"],
    [127n, "0x06d9a77f5e4b311bae8d559db9cdb4df94104aa0"],
    [128n, "0x08e190dcb7b73f5fcdabb43e102215c83659a76d"],
    [255n, "0x3ef7c1a519e4b4431e317d7839340e3139b03c65"],
    [256n, "0x3837c1ae70354f670550c746580199ac6a73cb0a"],
    [(1n << 64n) - 1n, "0x9bc924993b60399df164c3763a964301d3db95ca"],
    [1n << 64n, "0xb3cf11188ea4dcc4111df6310b98a5d432f09be4"],
    [UINT256_MAX, "0x5f3df856986b2268fe2b263878a45e3bfdb09505"],
  ] as const;
  for (const [nonce, expected] of vectors) {
    assert.equal(deriveCreateAddress(sender, nonce), expected, nonce.toString());
  }
  assert.throws(() => deriveCreateAddress(sender, UINT256_MAX + 1n), /nonce/u);
});

test("nonce zero and one bind different CREATE addresses and plan IDs", () => {
  const zero = buildStablePlan(artifact, roots, observation);
  const one = buildStablePlan(artifact, roots, { ...observation, senderNonce: "1" });
  assert.notEqual(zero.identity.expectedCreateAddress, one.identity.expectedCreateAddress);
  assert.notEqual(zero.planId, one.planId);
});

test("every stable identity field participates in planId", () => {
  const identity = buildStablePlan(artifact, roots, observation).identity;
  const baseline = computePlanId(identity);
  for (const key of Object.keys(identity)) {
    const value = identity[key];
    let mutation: unknown;
    if (typeof value === "string") {
      mutation = `${value}x`;
    } else if (typeof value === "boolean") {
      mutation = !value;
    } else if (Array.isArray(value)) {
      mutation = [...value, "x"];
    } else {
      mutation = { ...(value as Record<string, unknown>), mutation: "x" };
    }
    assert.notEqual(computePlanId({ ...identity, [key]: mutation }), baseline, key);
  }
});
