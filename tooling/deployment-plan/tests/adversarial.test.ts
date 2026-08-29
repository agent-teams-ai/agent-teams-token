import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFeeQuote, buildStablePlan, type QuoteObservation } from "../src/application/builder.ts";
import { independentlyVerify } from "../src/application/verifier.ts";
import { publishReadyLast, verifyBundle } from "../src/composition/index.ts";
import type { ApprovedArtifact, TrustRoots } from "../src/adapters/artifact.ts";

const h = `0x${"a".repeat(64)}` as const;
const roots: TrustRoots = { schemaVersion: 1, testOnly: true, productionApproved: false, mainnetAllowed: false, chainId: "31337", contractFqn: "src/X.sol:X", buildProfile: "default", from: "0x0000000000000000000000000000000000000001", maximumWorstCaseWei: "1000000", gasBufferBps: "0", quoteTtlSeconds: "60", maximumHeadLag: "2", solcVersion: "x", compilerSettings: {}, artifactSha256: h, abiSha256: h, fixtureSha256: h, fixtureReadySha256: h, sourceDependencyClosure: {} };
const artifact: ApprovedArtifact = { buildInfoSha256: h, artifactSha256: h, abiSha256: h, fixtureSha256: h, sourceDependencyClosure: {}, solcVersion: "x", compilerSettings: {}, creationBytecode: "0x01", creationBytecodeHash: h, constructorAbiBytes: "0x02", constructorAbiHash: h, constructorArguments: "0x03", constructorArgumentsHash: h, creationInput: "0x0103", creationInputHash: h };
const obs: QuoteObservation = { chainId: "31337", blockNumber: "10", blockHash: h, blockTimestamp: "100", currentHeadNumber: "10", currentHeadHash: h, feeHistoryNewestBlock: "10", gasEstimate: "100", blockGasLimit: "1000", baseFeePerGas: "1", maxPriorityFeePerGas: "1", maxFeePerGas: "2", observedAt: "110" };

test("wrong chain, head lag, future, stale and exact expiry fail", () => {
  const plan = buildStablePlan(artifact, roots); assert.throws(() => buildFeeQuote(plan, { ...obs, chainId: "1" }, roots), /chain/u); assert.throws(() => buildFeeQuote(plan, { ...obs, blockNumber: "7" }, roots), /behind/u); assert.throws(() => buildFeeQuote(plan, { ...obs, blockNumber: "11" }, roots), /future/u); assert.throws(() => buildFeeQuote(plan, { ...obs, blockTimestamp: "1" }, roots), /stale/u);
  assert.throws(() => buildFeeQuote(plan, { ...obs, currentHeadHash: `0x${"b".repeat(64)}` }, roots), /hash differs/u);
  const quote = buildFeeQuote(plan, obs, roots); const ready = { schemaVersion: 1 as const, planSha256: h, quoteSha256: h, planId: plan.planId, creationInputHash: h }; assert.throws(() => independentlyVerify(plan, quote, roots, artifact, ready, 170n), /expiry/u);
});
test("identity mutation and quote swapping are rejected", () => {
  const plan = buildStablePlan(artifact, roots); const quote = buildFeeQuote(plan, obs, roots); const changed = buildStablePlan({ ...artifact, buildInfoSha256: `0x${"b".repeat(64)}` }, roots); assert.notEqual(changed.planId, plan.planId);
  assert.throws(() => independentlyVerify(changed, quote, roots, { ...artifact, buildInfoSha256: changed.identity.buildInfoSha256 as `0x${string}` }, { schemaVersion: 1, planSha256: h, quoteSha256: h, planId: changed.planId, creationInputHash: h }, 120n), /not bound/u);
  assert.throws(() => independentlyVerify({ ...plan, broadcastAllowed: true } as never, quote, roots, artifact, { schemaVersion: 1, planSha256: h, quoteSha256: h, planId: plan.planId, creationInputHash: h }, 120n), /safety/u);
});
test("READY-last detects stale marker, content replacement and symlink substitution", async () => {
  const parent = await mkdtemp(join(tmpdir(), "deployment-plan-test-")); const plan = buildStablePlan(artifact, roots); const quote = buildFeeQuote(plan, obs, roots); const directory = await publishReadyLast(parent, "bundle", plan, quote, roots, artifact, 120n); await verifyBundle(directory, roots, artifact, 120n);
  const planPath = join(directory, "deployment-plan.v1.json"); await writeFile(planPath, Buffer.concat([await readFile(planPath), Buffer.from(" ")])); await assert.rejects(verifyBundle(directory, roots, artifact, 120n), /stale|substituted/u);
  const other = join(parent, "other"); await writeFile(other, "{}"); const quotePath = join(directory, "fee-quote.v1.json"); await writeFile(quotePath, "{}"); await assert.rejects(verifyBundle(directory, roots, artifact, 120n));
  const fresh = await publishReadyLast(parent, "bundle2", plan, quote, roots, artifact, 120n); const readyPath = join(fresh, "READY"); await writeFile(readyPath, "{}"); await symlink(other, join(fresh, "decoy")); await assert.rejects(verifyBundle(fresh, roots, artifact, 120n));
});
