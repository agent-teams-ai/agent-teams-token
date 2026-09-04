import assert from "node:assert/strict";
import test from "node:test";
import { artifactInputs, approvedArtifact, roots as fixtureRoots } from "./raw-artifact-fixture.ts";
import {
  buildFeeQuote,
  buildStablePlan,
  type FeeQuote,
  type QuoteObservation,
} from "../src/application/builder.ts";
import type { DeploymentRpc, RawArtifactInputs, RpcMethod } from "../src/application/ports.ts";
import {
  independentlyVerify,
  independentlyVerifyRpc,
} from "../src/application/verifier.ts";
import { sha256Hex } from "../src/domain/identity.ts";
import { UINT256_MAX } from "../src/domain/model.ts";

const hash = `0x${"a".repeat(64)}` as const;
const otherHash = `0x${"b".repeat(64)}` as const;
const roots = { ...fixtureRoots, maximumHeadLag: "2" } as const;
const artifact = approvedArtifact;
const creationInput = artifact.creationInput;
const creationInputHash = artifact.creationInputHash;
const observation: QuoteObservation = {
  chainId: "31337",
  blockNumber: "10",
  blockHash: hash,
  blockTimestamp: "100",
  currentHeadNumber: "10",
  currentHeadHash: hash,
  feeHistoryNewestBlock: "10",
  senderNonce: "0",
  expectedCreateAddress: "0x522b3294e6d06aa25ad0f1b8891242e335d3b459",
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
      artifactInputs,
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

test("forged component hashes are rejected even when bytes are unchanged", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  for (const field of ["creationBytecodeHash", "constructorAbiHash", "constructorArgumentsHash", "creationInputHash"] as const) {
    const forged = { ...artifact, [field]: hash };
    assert.throws(() => independentlyVerify({ plan, quote, roots, expected: forged, artifactInputs, ready: readyFor(plan.planId), nowSeconds: 110n }), /forged|untrusted|binding|mismatch|approved build input/u);
  }
});

test("independent raw verification rejects a coherent corrupted builder result", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const creationBytecode = "0x61" as const;
  const corruptedInput = `${creationBytecode}${artifact.constructorArguments.slice(2)}` as const;
  const corrupted = {
    ...artifact,
    creationBytecode,
    creationBytecodeHash: sha256Hex(Buffer.from(creationBytecode.slice(2), "hex")),
    creationInput: corruptedInput,
    creationInputHash: sha256Hex(Buffer.from(corruptedInput.slice(2), "hex")),
  };
  assert.throws(
    () => independentlyVerify({
      plan,
      quote,
      roots,
      expected: corrupted,
      artifactInputs,
      ready: readyFor(plan.planId),
      nowSeconds: 110n,
    }),
    /builder verification mismatch/u,
  );
});

test("independent verification parses every raw input and ignores builder constructor values", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const verify = (candidate: RawArtifactInputs = artifactInputs): void => independentlyVerify({
    plan,
    quote,
    roots,
    expected: artifact,
    artifactInputs: candidate,
    ready: readyFor(plan.planId),
    nowSeconds: 110n,
  });

  const maliciousBuilderInputs = {
    ...artifactInputs,
    constructorValues: { initialSupply: "malicious builder-only value" },
  };
  assert.doesNotThrow(() => verify(maliciousBuilderInputs));
  for (const field of ["buildInfoBytes", "artifactBytes", "abiBytes", "fixtureBytes"] as const) {
    assert.throws(
      () => verify({ ...artifactInputs, [field]: Buffer.from("{") }),
      /JSON|BUILD_INFO|ARTIFACT|ABI|FIXTURE/u,
    );
  }
  assert.throws(
    () => verify({
      ...artifactInputs,
      fixtureBytes: Buffer.from('{"initialSupply":"1","initialSupply":"1","allocations":[]}'),
    }),
    /duplicate JSON member/u,
  );
});

test("independent raw parsing accepts AST negatives and rejects noncanonical numbers", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const verifyBuild = (source: string): void => independentlyVerify({
    plan, quote, roots, expected: artifact,
    artifactInputs: { ...artifactInputs, buildInfoBytes: Buffer.from(source) },
    ready: readyFor(plan.planId), nowSeconds: 110n,
  });
  const build = Buffer.from(artifactInputs.buildInfoBytes).toString("utf8");
  const buildWithNegativeAstReference = build.replace(
    '"output":{',
    '"output":{"sources":{"src/features/token-genesis/AGTMAIToken.sol":{"ast":{"referencedDeclaration":-27}}},',
  );

  assert.doesNotThrow(() => verifyBuild(build));
  assert.throws(
    () => verifyBuild(buildWithNegativeAstReference),
    /canonical build-info digest differs/u,
  );
  for (const whitespace of ["\u00a0", "\u000b", "\u000c", "\u0085", "\u2028", "\ufeff"]) {
    assert.throws(
      () => verifyBuild(build.replace('"runs":200', `"runs"${whitespace}:200`)),
      /malformed JSON/u,
    );
  }
  for (const token of [
    "-0", "2e2", "200.0", "0200", "+200",
    "9007199254740992", "-9007199254740992",
  ]) {
    assert.throws(
      () => verifyBuild(buildWithNegativeAstReference.replace("-27", token)),
      /malformed JSON/u,
    );
  }
});

test("independent raw parsing exposes duplicate and prototype-named members", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const verifyBuild = (source: string): void => independentlyVerify({
    plan, quote, roots, expected: artifact,
    artifactInputs: { ...artifactInputs, buildInfoBytes: Buffer.from(source) },
    ready: readyFor(plan.planId), nowSeconds: 110n,
  });
  const build = Buffer.from(artifactInputs.buildInfoBytes).toString("utf8");

  for (const source of [
    build.replace("{", '{"solcVersion":"0.8.36",'),
    build.replace('"optimizer":{', '"optimizer":{"runs":200,'),
  ]) {
    assert.throws(() => verifyBuild(source), /duplicate JSON member/u);
  }
  for (const source of [
    build.replace("{", '{"__proto__":{},'),
    build.replace('"optimizer":{', '"optimizer":{"constructor":{},"prototype":{},"__proto__":{},'),
  ]) {
    assert.throws(() => verifyBuild(source), /digest differs from trust root/u);
  }
});

test("build provenance fields are bound to trust roots", () => {
  const boundRoots = {
    ...roots,
    canonicalBuildInfoSha256: hash,
    sourceDependencyClosure: { "src/X.sol": hash },
    compilerSettings: { optimizer: { enabled: true } },
  } as const;
  const boundArtifact = {
    ...artifact,
    canonicalBuildInfoSha256: hash,
    sourceDependencyClosure: boundRoots.sourceDependencyClosure,
    compilerSettings: boundRoots.compilerSettings,
  };
  const plan = buildStablePlan(boundArtifact, boundRoots);
  const quote = buildFeeQuote(plan, observation, boundRoots);
  const ready = readyFor(plan.planId);
  for (const field of ["sourceDependencyClosure", "compilerSettings", "rawBuildInfoSha256", "canonicalBuildInfoSha256", "buildInfoSolcVersion"] as const) {
    const mutated = { ...boundArtifact, [field]: field === "rawBuildInfoSha256" || field === "canonicalBuildInfoSha256" ? otherHash : field === "buildInfoSolcVersion" ? "0.8.37" : {} };
    assert.throws(() => independentlyVerify({ plan, quote, roots: boundRoots, expected: mutated, artifactInputs, ready, nowSeconds: 110n }), /trust|binding|mismatch|untrusted|approved build input/u);
  }
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
    withObservation(quote, { senderNonce: "1" }),
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
        case "eth_getTransactionCount": return "0x0";
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
    schemaVersion: 2 as const,
    planSha256: hash,
    quoteSha256: hash,
    planId,
    creationInputHash,
  };
}
