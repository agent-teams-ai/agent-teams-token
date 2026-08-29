import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApprovedArtifact, TrustRoots } from "../src/adapters/artifact.ts";
import type { DeploymentRpc, RpcMethod } from "../src/application/ports.ts";
import { buildFeeQuote, buildStablePlan, type QuoteObservation } from "../src/application/builder.ts";
import { independentlyVerify } from "../src/application/verifier.ts";
import { publishReadyLast, verifyBundle } from "../src/composition/index.ts";
import { computePlanId, sha256Hex } from "../src/domain/identity.ts";

const hash = `0x${"a".repeat(64)}` as const;
const inputHash = sha256Hex(Buffer.from("0103", "hex"));
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
  creationInputHash: inputHash,
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
  creationInputHash: inputHash,
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
    /expiresAt/u,
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

test("independent complete-input golden rejects coherent wrong bytecode and constructor input", () => {
  const wrongArguments = "0x04" as const;
  const wrongInput = "0x0104" as const;
  const coherentlyWrong: ApprovedArtifact = {
    ...artifact,
    constructorArguments: wrongArguments,
    constructorArgumentsHash: sha256Hex(Buffer.from("04", "hex")),
    creationInput: wrongInput,
    creationInputHash: sha256Hex(Buffer.from("0104", "hex")),
  };
  assert.throws(() => buildStablePlan(coherentlyWrong, roots), /golden/u);
  const wrongBytecode = "0x02" as const;
  const wrongBytecodeInput = "0x0203" as const;
  const coherentlyWrongBytecode: ApprovedArtifact = {
    ...artifact,
    creationBytecode: wrongBytecode,
    creationBytecodeHash: sha256Hex(Buffer.from("02", "hex")),
    creationInput: wrongBytecodeInput,
    creationInputHash: sha256Hex(Buffer.from("0203", "hex")),
  };
  assert.throws(() => buildStablePlan(coherentlyWrongBytecode, roots), /golden/u);
});

test("standalone verification rejects coherent non-local trust roots", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const unsafeRoots = { ...roots, chainId: "1" as never };
  const identity = { ...plan.identity, chainId: "1" };
  const unsafePlan = {
    ...plan,
    identity,
    planId: computePlanId(identity),
  };
  assert.throws(
    () => independentlyVerify({
      plan: unsafePlan,
      quote: { ...quote, planId: unsafePlan.planId, observation: { ...observation, chainId: "1" } },
      roots: unsafeRoots,
      expected: artifact,
      ready: readyFor(unsafePlan.planId),
      nowSeconds: 120n,
    }),
    /local test-only/u,
  );
});

test("READY-last detects stale marker, content replacement and symlink substitution", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-test-")));
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
  await verifyBundle({ directory, roots, expected: artifact, nowSeconds: 120n, rpc, creationInput: artifact.creationInput });
  const changedRpc: DeploymentRpc = {
    async request(method, params) {
      return method === "eth_estimateGas" ? "0x65" : rpc.request(method, params);
    },
  };
  await assert.rejects(
    verifyBundle({ directory, roots, expected: artifact, nowSeconds: 120n, rpc: changedRpc, creationInput: artifact.creationInput }),
    /estimate changed/u,
  );

  const planPath = join(directory, "deployment-plan.v1.json");
  await writeFile(planPath, Buffer.concat([await readFile(planPath), Buffer.from(" ")]));
  await assert.rejects(
    verifyBundle({ directory, roots, expected: artifact, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }),
    /stale|substituted/u,
  );

  const fresh = await publishReadyLast({ ...publish, bundleName: "bundle2" });
  const other = join(parent, "other");
  await writeFile(other, "{}");
  const quotePath = join(fresh, "fee-quote.v1.json");
  await unlink(quotePath);
  await symlink(other, quotePath);
  await assert.rejects(
    verifyBundle({ directory: fresh, roots, expected: artifact, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }),
    /regular file/u,
  );
});

function readyFor(planId: `0x${string}`) {
  return {
    schemaVersion: 1 as const,
    planSha256: hash,
    quoteSha256: hash,
    planId,
    creationInputHash: inputHash,
  };
}

const rpc: DeploymentRpc = {
  async request(method: RpcMethod): Promise<unknown> {
    switch (method) {
      case "eth_chainId": return "0x7a69";
      case "eth_getBlockByNumber": return {
        number: "0xa", hash, timestamp: "0x64", gasLimit: "0x3e8", baseFeePerGas: "0x1",
      };
      case "eth_feeHistory": return { oldestBlock: "0xa", baseFeePerGas: ["0x1", "0x2"] };
      case "eth_estimateGas": return "0x64";
    }
  },
};
