import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApprovedArtifact, TrustRoots } from "../src/adapters/artifact.ts";
import { buildFeeQuote, buildStablePlan, type QuoteObservation } from "../src/application/builder.ts";
import { independentlyVerify } from "../src/application/verifier.ts";
import { publishReadyLast, verifyBundle } from "../src/composition/index.ts";

const hash = `0x${"a".repeat(64)}` as const;
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
  creationInput: "0x0103",
  creationInputHash: hash,
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

test("wrong chain, head lag, future, stale, reorg and exact expiry fail", () => {
  const plan = buildStablePlan(artifact, roots);
  assert.throws(
    () => buildFeeQuote(plan, { ...observation, chainId: "1" }, roots),
    /chain/u,
  );
  assert.throws(
    () => buildFeeQuote(plan, { ...observation, blockNumber: "7" }, roots),
    /behind/u,
  );
  assert.throws(
    () => buildFeeQuote(plan, { ...observation, blockNumber: "11" }, roots),
    /future/u,
  );
  assert.throws(
    () => buildFeeQuote(plan, { ...observation, blockTimestamp: "1" }, roots),
    /stale/u,
  );
  assert.throws(
    () => buildFeeQuote(
      plan,
      { ...observation, currentHeadHash: `0x${"b".repeat(64)}` },
      roots,
    ),
    /hash differs/u,
  );
  const quote = buildFeeQuote(plan, observation, roots);
  const ready = readyFor(plan.planId);
  assert.throws(
    () => independentlyVerify({ plan, quote, roots, expected: artifact, ready, nowSeconds: 170n }),
    /expiry/u,
  );
});

test("identity mutation, quote swapping and unsafe plan flags are rejected", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const changedArtifact = {
    ...artifact,
    buildInfoSha256: `0x${"b".repeat(64)}` as const,
  };
  const changed = buildStablePlan(changedArtifact, roots);
  assert.notEqual(changed.planId, plan.planId);
  assert.throws(
    () => independentlyVerify({
      plan: changed,
      quote,
      roots,
      expected: changedArtifact,
      ready: readyFor(changed.planId),
      nowSeconds: 120n,
    }),
    /not bound/u,
  );
  assert.throws(
    () => independentlyVerify({
      plan: { ...plan, broadcastAllowed: true } as never,
      quote,
      roots,
      expected: artifact,
      ready: readyFor(plan.planId),
      nowSeconds: 120n,
    }),
    /safety/u,
  );
});

test("READY-last detects stale marker, content replacement and symlink substitution", async () => {
  const parent = await mkdtemp(join(tmpdir(), "deployment-plan-test-"));
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const publish = {
    parent,
    plan,
    quote,
    roots,
    expected: artifact,
    nowSeconds: 120n,
  };
  const directory = await publishReadyLast({ ...publish, bundleName: "bundle" });
  await verifyBundle({ directory, roots, expected: artifact, nowSeconds: 120n });

  const planPath = join(directory, "deployment-plan.v1.json");
  await writeFile(planPath, Buffer.concat([await readFile(planPath), Buffer.from(" ")]));
  await assert.rejects(
    verifyBundle({ directory, roots, expected: artifact, nowSeconds: 120n }),
    /stale|substituted/u,
  );

  const fresh = await publishReadyLast({ ...publish, bundleName: "bundle2" });
  const other = join(parent, "other");
  await writeFile(other, "{}");
  const quotePath = join(fresh, "fee-quote.v1.json");
  await unlink(quotePath);
  await symlink(other, quotePath);
  await assert.rejects(
    verifyBundle({ directory: fresh, roots, expected: artifact, nowSeconds: 120n }),
    /regular file/u,
  );
});

function readyFor(planId: `0x${string}`) {
  return {
    schemaVersion: 1 as const,
    planSha256: hash,
    quoteSha256: hash,
    planId,
    creationInputHash: hash,
  };
}
