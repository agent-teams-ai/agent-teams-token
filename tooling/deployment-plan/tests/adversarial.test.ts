import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApprovedArtifact, TrustRoots } from "../src/adapters/artifact.ts";
import type { DeploymentRpc, RpcMethod } from "../src/application/ports.ts";
import { buildFeeQuote, buildStablePlan, type QuoteObservation } from "../src/application/builder.ts";
import { independentlyVerify, independentlyVerifyRpc } from "../src/application/verifier.ts";
import { publishReadyLast, verifyBundle } from "../src/composition/index.ts";
import { computePlanId, sha256Hex } from "../src/domain/identity.ts";
import { main as estimateLocalMain } from "../../../scripts/deployment/estimate-local.ts";
import { testOnlyNoReplaceDirectoryRename } from "./helpers/no-replace-directory-rename.ts";

const hash = `0x${"a".repeat(64)}` as const;
const inputHash = sha256Hex(Buffer.from("0103", "hex"));
const creationBytecode = "0x01" as const;
const creationBytecodeHash = sha256Hex(Buffer.from(creationBytecode.slice(2), "hex"));
const constructorAbiBytes = "0x02" as const;
const constructorAbiHash = sha256Hex(Buffer.from(constructorAbiBytes.slice(2), "hex"));
const constructorArguments = "0x03" as const;
const constructorArgumentsHash = sha256Hex(Buffer.from(constructorArguments.slice(2), "hex"));
const roots: TrustRoots = {
  schemaVersion: 2,
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
  compilerInputSha256: hash,
  compilerSettings: {},
  artifactSha256: hash,
  abiSha256: hash,
  fixtureSha256: hash,
  fixtureReadySha256: hash,
  constructorArgumentsHash,
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
  compilerInputSha256: roots.compilerInputSha256,
  compilerSettings: {},
  creationBytecode,
  creationBytecodeHash,
  constructorAbiBytes,
  constructorAbiHash,
  constructorArguments,
  constructorArgumentsHash,
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
  senderNonce: "0",
  gasEstimate: "100",
  blockGasLimit: "1000",
  baseFeePerGas: "1",
  maxPriorityFeePerGas: "1",
  maxFeePerGas: "2",
  observedAt: "110",
};

test("production CLI rejects caller-supplied simulated time", async () => {
  await assert.rejects(estimateLocalMain(["--now", "1"]), /invalid.*--now/u);
});

test("wrong chain, head lag, future, stale, reorg and exact expiry fail", () => {
  const plan = buildStablePlan(artifact, roots, observation);
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
  const plan = buildStablePlan(artifact, roots, observation);
  const quote = buildFeeQuote(plan, observation, roots);
  const changedArtifact = {
    ...artifact,
    buildInfoSha256: `0x${"b".repeat(64)}` as const,
  };
  const changed = buildStablePlan(changedArtifact, roots, observation);
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

test("nonce-zero and nonce-one evidence cannot be cross-swapped", async () => {
  const planZero = buildStablePlan(artifact, roots, observation);
  const quoteZero = buildFeeQuote(planZero, observation, roots);
  const observationOne = { ...observation, senderNonce: "1" };
  const planOne = buildStablePlan(artifact, roots, observationOne);
  const quoteOne = buildFeeQuote(planOne, observationOne, roots);
  assert.notEqual(planZero.planId, planOne.planId);
  assert.notEqual(planZero.identity.expectedCreateAddress, planOne.identity.expectedCreateAddress);
  const swappedAddressIdentity = {
    ...planZero.identity,
    expectedCreateAddress: planOne.identity.expectedCreateAddress,
  };
  const swappedAddressPlan = {
    ...planZero,
    identity: swappedAddressIdentity,
    planId: computePlanId(swappedAddressIdentity),
  };
  assert.throws(
    () => independentlyVerify({
      plan: swappedAddressPlan,
      quote: { ...quoteZero, planId: swappedAddressPlan.planId },
      roots,
      expected: artifact,
      ready: readyFor(swappedAddressPlan.planId),
      nowSeconds: 120n,
    }),
    /CREATE address/u,
  );
  assert.throws(
    () => independentlyVerify({
      plan: planZero,
      quote: { ...quoteZero, observation: observationOne },
      roots,
      expected: artifact,
      ready: readyFor(planZero.planId),
      nowSeconds: 120n,
    }),
    /nonce|binding/u,
  );
  assert.throws(
    () => independentlyVerify({
      plan: planZero,
      quote: quoteOne,
      roots,
      expected: artifact,
      ready: readyFor(planZero.planId),
      nowSeconds: 120n,
    }),
    /not bound/u,
  );
  const nonceOneRpc: DeploymentRpc = {
    async request(method, params) {
      return method === "eth_getTransactionCount" ? "0x1" : rpc.request(method, params);
    },
  };
  await assert.rejects(
    independentlyVerifyRpc({
      rpc: nonceOneRpc,
      plan: planZero,
      quote: quoteZero,
      creationInput: artifact.creationInput,
    }),
    /nonce changed/u,
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
  assert.throws(() => buildStablePlan(coherentlyWrong, roots, observation), /golden/u);
  const wrongBytecode = "0x02" as const;
  const wrongBytecodeInput = "0x0203" as const;
  const coherentlyWrongBytecode: ApprovedArtifact = {
    ...artifact,
    creationBytecode: wrongBytecode,
    creationBytecodeHash: sha256Hex(Buffer.from("02", "hex")),
    creationInput: wrongBytecodeInput,
    creationInputHash: sha256Hex(Buffer.from("0203", "hex")),
  };
  assert.throws(() => buildStablePlan(coherentlyWrongBytecode, roots, observation), /golden/u);
});

test("standalone verification rejects coherent non-local trust roots", () => {
  const plan = buildStablePlan(artifact, roots, observation);
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

test("expiry at the final pre-publication check leaves no target or staging bundle", async (context) => {
  context.mock.method(Date, "now", () => 170_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-expiry-")));
  const plan = buildStablePlan(artifact, roots, observation);
  const quote = buildFeeQuote(plan, observation, roots);
  await assert.rejects(
    publishReadyLast({
      parent,
      bundleName: "expired",
      plan,
      quote,
      roots,
      expected: artifact,
    }),
    /expiresAt/u,
  );
  assert.deepEqual(await readdir(parent), []);
});

test("READY-last detects final estimate N-to-N+1 drift and immutable-byte substitution", async (context) => {
  context.mock.method(Date, "now", () => 120_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-test-")));
  const plan = buildStablePlan(artifact, roots, observation);
  const quote = buildFeeQuote(plan, observation, roots);
  const publish = {
    parent,
    plan,
    quote,
    roots,
    expected: artifact,
    outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename },
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
  assert.deepEqual((await readdir(directory)).toSorted(), [
    "READY", "deployment-plan.v2.json", "fee-quote.v2.json",
  ]);

  const legacyNames = await publishReadyLast({ ...publish, bundleName: "legacy-names" });
  await rename(
    join(legacyNames, "deployment-plan.v2.json"),
    join(legacyNames, "deployment-plan.v1.json"),
  );
  await assert.rejects(
    verifyBundle({ directory: legacyNames, roots, expected: artifact, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }),
    /exactly plan, quote, and READY/u,
  );

  const planPath = join(directory, "deployment-plan.v2.json");
  await writeFile(planPath, Buffer.concat([await readFile(planPath), Buffer.from(" ")]));
  await assert.rejects(
    verifyBundle({ directory, roots, expected: artifact, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }),
    /stale|substituted/u,
  );

  const fresh = await publishReadyLast({ ...publish, bundleName: "bundle2" });
  const other = join(parent, "other");
  await writeFile(other, "{}");
  const quotePath = join(fresh, "fee-quote.v2.json");
  await unlink(quotePath);
  await symlink(other, quotePath);
  await assert.rejects(
    verifyBundle({ directory: fresh, roots, expected: artifact, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }),
    /regular file/u,
  );
});

function readyFor(planId: `0x${string}`) {
  return {
    schemaVersion: 2 as const,
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
      case "eth_getTransactionCount": return "0x0";
      case "eth_estimateGas": return "0x64";
    }
  },
};
