import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { encodeAllocationCommitment, encodeAllocationId } from "@agent-teams/supply/genesis-manifest";
import { loadPreparedProductionPackage, publishDeploymentFiles } from "@agent-teams/supply/deployment-files";
import { runLocalExecutionProof } from "../../../scripts/deployment/local-execution-proof.ts";
import { parseProductionAttempt, parseProductionExpectations, parseProductionObservation } from "../src/adapters/production-inputs.ts";
import { assessProductionPreflight } from "../src/application/production-preflight.ts";
import { keccak256 } from "../src/domain/identity.ts";
import { createRealProductionPackage, type RealProductionPackage } from "./helpers/real-production-package.ts";

test("authenticated Anvil executes the four prepared operations and existing preflight accepts the evidence", { timeout: 120_000 }, async context => {
  const repositoryRoot = resolve(".");
  const root = await mkdtemp("/tmp/agtmai-production-execution-");
  context.after(() => rm(root, { recursive: true, force: true }));
  let fixture: RealProductionPackage | undefined;
  const output = join(root, "observations");
  const result = await runLocalExecutionProof({
    repositoryRoot,
    outputDirectory: output,
    preparePackage: async ({ signerAddress, packageDirectory }) => {
      fixture = await createRealProductionPackage(repositoryRoot, packageDirectory, signerAddress as `0x${string}`);
    },
  });
  assert.ok(fixture);
  assert.deepEqual(result.operationCount, 4);
  const observationBytes = await readFile(join(output, "production-observation-v2.json"));
  assert.equal(await readFile(join(output, "READY"), "utf8"), `${keccak256(observationBytes)}\n`);
  const raw = observationBytes.toString("utf8");
  assert.doesNotMatch(raw, /private.?key|mnemonic|seed phrase/i);
  const replayDirectory = join(root, "preflight-package");
  const expectationsPath = join(root, "expectations.json"), attemptPath = join(root, "attempt.json");
  await Promise.all([
    publishDeploymentFiles(replayDirectory, fixture.files),
    writeFile(expectationsPath, fixture.expectations, {mode: 0o600}),
    writeFile(attemptPath, fixture.attempt, {mode: 0o600}),
  ]);
  const prepared = await loadPreparedProductionPackage(replayDirectory);
  const expectationsSource = new TextDecoder().decode(fixture.expectations);
  const attemptSource = new TextDecoder().decode(fixture.attempt);
  const deployment = prepared.configuration.deployment;
  const allocationHash = encodeAllocationCommitment({ network: { chainId: deployment.environment.evmChainId }, token: deployment.token }, deployment.allocations.map(allocation => ({ id: allocation.id, idBytes32: encodeAllocationId(allocation.id)!, recipient: allocation.recipient as `0x${string}`, amountBaseUnits: allocation.amountBaseUnits, ...(allocation.bps === undefined ? {} : { bps: allocation.bps }) }))).hash;
  const expectations = parseProductionExpectations(JSON.parse(expectationsSource));
  assert.equal(result.signerAddress, expectations.sender);
  assert.deepEqual(expectations.operations.map(operation => operation.nonce), ["7", "8", "9", "10"]);
  const observation = parseProductionObservation(JSON.parse(raw));
  const report = assessProductionPreflight({ prepared, expectations, observations: observation, attempt: parseProductionAttempt(JSON.parse(attemptSource)), nowSeconds: BigInt(observation.observedAt), preparedConfigurationSha256: prepared.configurationSha256, preparedReserveConfigurationSha256: prepared.reserveConfigurationSha256, preparedArtifactPinsSha256: expectations.artifactPinsSha256, expectedGenesisAllocationHash: allocationHash });
  assert.equal(report.status, "checks-passed-offline");
  assert.equal(report.broadcastAllowed, false);
  assert.deepEqual(report.reasons, []);
  assert.equal(observation.operations.map(operation => operation.id).join(","), "token-create,founder-reserve-create,controller-create,founder-fund");
  assert.equal(observation.state?.funding.caller, expectations.sender);
  assert.equal(observation.state?.controller.grossCommitted, "0");
  assert.equal(observation.state?.controller.rollingCommitted, "0");
  assert.equal(observation.state?.conservation.observedBalancesBaseUnits, "100000000000000000");
  assert.equal(observation.observedTotalCostWei, observation.operations.reduce((sum, operation) => sum + BigInt(operation.observedCostWei!), 0n).toString());
  assert.ok(observation.operations.every((operation, index) => operation.sender === expectations.sender && operation.nonce === (7n + BigInt(index)).toString() && BigInt(operation.gasUsed!) > 0n));
  assert.equal(observation.cleanup?.temporaryRootRemoved, true);
  const command = spawnSync(process.execPath, [resolve("tooling/deployment-plan/src/composition/production-preflight.ts"), "--prepared", replayDirectory, "--expectations", expectationsPath, "--observations", join(output, "production-observation-v2.json"), "--attempt-state", attemptPath], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(command.status, 0, command.stdout + command.stderr);
  const commandReport = JSON.parse(command.stdout) as Record<string, unknown>;
  assert.equal(commandReport.status, "checks-passed-offline");
  assert.equal(commandReport.broadcastAllowed, false);
  assert.deepEqual(commandReport.unresolvedPrerequisites, [
    "Safe deployment and live authority observation",
    "CCIP deployment/configuration",
    "contributor commitment execution",
    "authenticated live-chain evidence",
  ]);

});

test("public proof entrypoint rejects every external signer and prepared-package path", async () => {
  await assert.rejects(runLocalExecutionProof({ repositoryRoot: resolve("."), preparedDirectory: "/tmp/external-package", signerKeystorePath: "/tmp/external-key", signerPasswordPath: "/tmp/external-password", outputDirectory: "/tmp/unreachable", preparePackage: async () => {} } as never), /PROOF_EXTERNAL_SIGNER_OR_PACKAGE_INJECTION_UNSUPPORTED/);
  const command = spawnSync(process.execPath, [resolve("scripts/deployment/local-execution-proof.ts"), "--prepared", "/tmp/external-package", "--signer-keystore", "/tmp/external-key"], { encoding: "utf8" });
  assert.equal(command.status, 2);
  assert.match(command.stderr, /PROOF_IN_PROCESS_ORCHESTRATOR_REQUIRED/);
});

test("proof ignores a valid package published outside its invocation-owned target", {timeout: 120_000}, async context => {
  const repositoryRoot = resolve(".");
  const root = await mkdtemp("/tmp/agtmai-production-external-package-");
  context.after(() => rm(root, {recursive: true, force: true}));
  const external = join(root, "external", "prepared");
  await mkdir(join(root, "external"), {mode: 0o700});
  await assert.rejects(runLocalExecutionProof({
    repositoryRoot,
    outputDirectory: join(root, "observations"),
    preparePackage: async ({signerAddress}) => {
      await createRealProductionPackage(repositoryRoot, external, signerAddress as `0x${string}`);
      return external as unknown as void;
    },
  }), (error: unknown) => (error as {code?: unknown}).code === "LOCAL_EVM_DIRECTORY_ENOENT");
  assert.ok(await loadPreparedProductionPackage(external));
});
