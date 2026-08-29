import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovedArtifact, TrustRoots } from "../src/adapters/artifact.ts";
import {
  buildFeeQuote,
  buildStablePlan,
  type FeeQuote,
  type QuoteObservation,
} from "../src/application/builder.ts";
import type { DeploymentRpc, RpcMethod } from "../src/application/ports.ts";
import {
  independentlyVerify,
  independentlyVerifyRpc,
} from "../src/application/verifier.ts";
import { sha256Hex } from "../src/domain/identity.ts";
import { UINT256_MAX } from "../src/domain/model.ts";

const hash = `0x${"a".repeat(64)}` as const;
const otherHash = `0x${"b".repeat(64)}` as const;
const creationInput = "0x0103" as const;
const creationInputHash = sha256Hex(Buffer.from(creationInput.slice(2), "hex"));
const roots: TrustRoots = {
  schemaVersion: 1,
  testOnly: true,
  productionApproved: false,
  mainnetAllowed: false,
  chainId: "31337",
  contractFqn: "src/X.sol:X",
  buildProfile: "default",
  from: "0x0000000000000000000000000000000000000001",
  maximumWorstCaseWei: "1000000",
  gasBufferBps: "0",
  quoteTtlSeconds: "60",
  maximumHeadLag: "2",
  buildInfoSolcVersion: "0.8.36",
  compilerSettings: {},
  artifactSha256: hash,
  abiSha256: hash,
  fixtureSha256: hash,
  fixtureReadySha256: hash,
  constructorArgumentsHash: hash,
  creationInputHash,
  sourceDependencyClosure: {},
};
const artifact: ApprovedArtifact = {
  buildInfoSha256: hash,
  artifactSha256: hash,
  abiSha256: hash,
  fixtureSha256: hash,
  sourceDependencyClosure: {},
  buildInfoSolcVersion: roots.buildInfoSolcVersion,
  compilerSettings: {},
  creationBytecode: "0x01",
  creationBytecodeHash: hash,
  constructorAbiBytes: "0x02",
  constructorAbiHash: hash,
  constructorArguments: "0x03",
  constructorArgumentsHash: hash,
  creationInput,
  creationInputHash,
};
const observation: QuoteObservation = {
  chainId: "31337",
  blockNumber: "10",
  blockHash: hash,
  blockTimestamp: "100",
  currentHeadNumber: "10",
  currentHeadHash: hash,
  feeHistoryNewestBlock: "10",
  gasEstimate: "100",
  blockGasLimit: "1000",
  baseFeePerGas: "1",
  maxPriorityFeePerGas: "1",
  maxFeePerGas: "2",
  observedAt: "110",
};

test("trust roots bind buffer, exact expiry and the complete time ordering", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const verify = (candidate: FeeQuote, nowSeconds = 110n): void => {
    independentlyVerify({
      plan,
      quote: candidate,
      roots,
      expected: artifact,
      ready: readyFor(plan.planId),
      nowSeconds,
    });
  };

  verify(quote);
  verify(buildFeeQuote(plan, {
    ...observation,
    blockTimestamp: observation.observedAt,
  }, roots));
  assert.throws(() => verify({ ...quote, bufferBps: "1" }), /buffer/u);
  assert.throws(() => verify({ ...quote, expiresAt: "171" }), /expiry/u);
  assert.throws(
    () => verify({
      ...quote,
      expiresAt: "171",
      observation: { ...quote.observation, observedAt: "111" },
    }),
    /blockTimestamp|observedAt|expiresAt/u,
  );
  assert.throws(
    () => verify({
      ...quote,
      observation: { ...quote.observation, blockTimestamp: "111" },
    }),
    /blockTimestamp|observedAt/u,
  );
  assert.throws(() => verify(quote, 170n), /blockTimestamp|expiresAt/u);
});

test("quote expiry addition is uint256 overflow checked", () => {
  const plan = buildStablePlan(artifact, roots);
  assert.throws(
    () => buildFeeQuote(plan, {
      ...observation,
      blockTimestamp: UINT256_MAX.toString(),
      observedAt: UINT256_MAX.toString(),
    }, { ...roots, quoteTtlSeconds: "1" }),
    /overflow/u,
  );
});

test("independent RPC verification binds every quoted chain fact", async () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const rpc = fixtureRpc();
  await independentlyVerifyRpc({ rpc, plan, quote, creationInput });

  const forged: readonly FeeQuote[] = [
    withObservation(quote, { blockNumber: "11" }),
    withObservation(quote, { blockHash: otherHash }),
    withObservation(quote, { blockTimestamp: "101" }),
    withObservation(quote, { blockGasLimit: "999" }),
    withObservation(quote, { currentHeadNumber: "11" }),
    withObservation(quote, { currentHeadHash: otherHash }),
    withObservation(quote, { feeHistoryNewestBlock: "9" }),
    withObservation(quote, { baseFeePerGas: "2" }),
    withObservation(quote, { gasEstimate: "101" }),
  ];
  for (const candidate of forged) {
    await assert.rejects(
      independentlyVerifyRpc({ rpc, plan, quote: candidate, creationInput }),
      /changed|forged/u,
    );
  }
});

function fixtureRpc(): DeploymentRpc {
  const block = {
    number: "0xa",
    hash,
    timestamp: "0x64",
    gasLimit: "0x3e8",
    baseFeePerGas: "0x1",
  };
  return {
    async request(method: RpcMethod): Promise<unknown> {
      switch (method) {
        case "eth_chainId": return "0x7a69";
        case "eth_getBlockByNumber": return block;
        case "eth_feeHistory": return {
          oldestBlock: "0xa",
          baseFeePerGas: ["0x1", "0x2"],
        };
        case "eth_estimateGas": return "0x64";
      }
    },
  };
}

function withObservation(
  quote: FeeQuote,
  mutation: Partial<QuoteObservation>,
): FeeQuote {
  return { ...quote, observation: { ...quote.observation, ...mutation } };
}

function readyFor(planId: `0x${string}`) {
  return {
    schemaVersion: 1 as const,
    planSha256: hash,
    quoteSha256: hash,
    planId,
    creationInputHash,
  };
}
