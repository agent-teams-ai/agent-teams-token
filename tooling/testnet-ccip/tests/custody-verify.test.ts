import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileDeployment, deploymentBytes, materializeDeploymentManifest, prepareGrant, type ContractDeploymentEvidence, type DeploymentArtifact, type DeploymentManifest, type Hex } from "@agent-teams/supply/deployment";
import { deploymentCompilerPorts as ports, publishDeploymentFiles } from "@agent-teams/supply/deployment-files";
import { verifyCustodyProof } from "../src/composition/custody-verify.ts";
import { verifyCustodyTransition, type CustodyTransition } from "../src/domain/custody.ts";
import { hash, blockHash, manifestFixture, snapshotFixture, stateFixture } from "./fixtures/custody.ts";

// Compiler-shaped files and selected synthetic native observations. This tests offline
// provenance validation; these captures are not real deployment or CCIP E2E evidence.
async function deploymentBundle(directory: string) {
  const files: Record<string, Uint8Array> = {}, artifacts: DeploymentArtifact[] = [];
  for (const contract of ["AGTMAICCIPToken", "GrantVault"] as const) {
    const source = `${contract}.sol`, immutableReferences = [{ start: 1, length: 32 }];
    const metadata = { compiler: { version: "0.8.36+commit.8a079791" }, settings: { compilationTarget: { [source]: contract } } };
    const rawMetadata = JSON.stringify(metadata), bytecode = { object: "6000", linkReferences: {} };
    const runtime = { object: `60${"00".repeat(32)}`, immutableReferences: { "1": immutableReferences }, linkReferences: {} };
    const input = { language: "Solidity", settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 } } };
    const artifact = deploymentBytes({ metadata, rawMetadata, bytecode: { ...bytecode, object: `0x${bytecode.object}` }, deployedBytecode: { ...runtime, object: `0x${runtime.object}` } });
    const build = deploymentBytes({ solcVersion: "0.8.36", input, output: { contracts: { [source]: { [contract]: { metadata: rawMetadata, evm: { bytecode, deployedBytecode: runtime } } } } } });
    files[`${contract.toLowerCase()}.artifact.json`] = artifact; files[`${contract.toLowerCase()}.build-info.json`] = build;
    artifacts.push({ contract, compilerVersion: "0.8.36", artifactSha256: ports.sha256(artifact), buildInfoSha256: ports.sha256(build),
      compilerInputSha256: ports.sha256(deploymentBytes(input)), creationBytecode: `0x${bytecode.object}`, runtimeBytecode: `0x${runtime.object}`, immutableReferences });
  }
  const config = manifestFixture().configuration, sourceRevision = "1".repeat(40);
  const prepared = compileDeployment(config, { sourceRevision, artifacts }, ports).prepared!;
  const tokenAddress = ports.createAddress(config.token.initialCCIPAdmin, "0");
  const creation = (grantId: string | null, nonce: string): ContractDeploymentEvidence => {
    const address = ports.createAddress(config.token.initialCCIPAdmin, nonce), block = { number: "1", hash: blockHash, timestamp: "1700000000" };
    const state = grantId === null ? ports.expectedTokenCalls(config, prepared.token.genesisAllocationHash) : ports.expectedGrantCalls(config, config.grants.find(g => g.id === grantId)!, tokenAddress);
    const input = grantId === null ? prepared.token : prepareGrant(prepared, grantId, tokenAddress, ports);
    const transactionHash = ports.sha256(deploymentBytes({ nonce }));
    return { address, transaction: { hash: transactionHash, from: config.token.initialCCIPAdmin, nonce, chainId: "31337", to: null, value: "0", input: input.initcode },
      receipt: { transactionHash, blockHash, blockNumber: "1", contractAddress: address, status: 1, gasUsed: "1000000", effectiveGasPrice: "1",
        logs: state.logs.map((log, i) => ({ ...log, address, removed: false, logIndex: String(i) })) },
      blockBefore: block, blockAfter: block, finalizedBlock: block,
      runtime: { blockHash, blockNumber: "1", code: artifacts[grantId === null ? 0 : 1]!.runtimeBytecode },
      calls: Object.entries(state.calls).map(([data, result]) => ({ to: address, data: data as Hex, result, blockHash, blockNumber: "1" })) };
  };
  const evidence = { schema: "agtmai-deployment-evidence-v1" as const, configurationSha256: prepared.configurationSha256,
    collector: { kind: "local-anvil" as const, sourceRevision }, token: creation(null, "0"), grants: config.grants.map((g, i) => ({ grantId: g.id, deployment: creation(g.id, String(i + 1)) })) };
  const manifest = materializeDeploymentManifest(prepared, evidence, ports);
  Object.assign(files, { "prepared-deployment.json": deploymentBytes(prepared), "deployment-evidence.json": deploymentBytes(evidence), "deployment-manifest.json": deploymentBytes(manifest) });
  await publishDeploymentFiles(directory, files);
  return { files, manifest };
}

function approval(manifest: DeploymentManifest): CustodyTransition {
  const states = manifest.configuration.grants.map(g => stateFixture(manifest, g.id, { token: manifest.token!.address }));
  const grant = states[0]!, config = manifest.configuration;
  const addresses = [...new Set([...config.allocations.map(a => a.recipient), ...config.grants.map(g => g.beneficiary), ...manifest.grants.map(g => g.address)])].toSorted();
  const balances = addresses.map(address => config.allocations.filter(a => a.recipient === address).reduce((sum, a) => sum + BigInt(a.amountBaseUnits), 0n).toString());
  const before = { ...snapshotFixture(manifest, "1700000000", "7", states, balances), token: manifest.token!.address };
  const after = { ...snapshotFixture(manifest, "1700000001", "8", states.map(g => g === grant ? { ...g, allowance: g.allocation } : g), balances), token: manifest.token!.address };
  const intent = { schema: "agtmai-custody-intent-v2" as const, configurationSha256: manifest.configurationSha256, prerequisiteSha256: hash,
    operationId: `${grant.grantId}-approve`, operation: "approve" as const, environment: "local-test" as const, chainId: "31337" as const, kind: "call" as const,
    from: grant.reserve, to: grant.token, nonce: "3", value: "0" as const, data: `0x095ea7b3${grant.address.slice(2).padStart(64, "0")}${BigInt(grant.allocation).toString(16).padStart(64, "0")}` as Hex,
    callerRole: "reserve" as const, gasLimit: "100000", maxFeePerGasWei: "2", maxPriorityFeePerGasWei: "0", deployment: null, safe: null };
  return { operationId: intent.operationId, grantId: grant.grantId, operation: "approve", intent, transactionHash: hash, block: after.block,
    before, after, movements: [], receiptStatus: 1, safeResult: null, gasUsed: "50000", effectiveGasPrice: "1" };
}

test("offline custody verifier requires authenticated deployment files and recomputes configuration and evidence digests", async context => {
  const root = await mkdtemp(join(tmpdir(), "custody-proof-")); context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "valid"), { files, manifest } = await deploymentBundle(directory), transition = approval(manifest);
  const path = join(directory, "deployment-manifest.json");
  assert.equal(verifyCustodyTransition(manifest, transition).proof, "arithmetic-only");
  await assert.rejects(verifyCustodyProof(path, transition), /CUSTODY_TRANSITION_PROVENANCE_UNPROVEN/);
  const fabricatedHash = { ...transition, transactionHash: `0x${"de".repeat(32)}` as Hex };
  assert.equal(verifyCustodyTransition(manifest, fabricatedHash).proof, "arithmetic-only");
  await assert.rejects(verifyCustodyProof(path, fabricatedHash), /CUSTODY_TRANSITION_PROVENANCE_UNPROVEN/);
  const wrongChain = { ...transition, intent: { ...transition.intent, environment: "owned-testnet" as const, chainId: "11155111" as const } };
  assert.throws(() => verifyCustodyTransition(manifest, wrongChain), /CUSTODY_TRANSITION_BINDING/);
  await assert.rejects(verifyCustodyProof(path, wrongChain), /CUSTODY_TRANSITION_BINDING/);
  assert.deepEqual((await readdir(directory)).toSorted(), [...Object.keys(files), "inventory.json"].toSorted());
  const fabricated = manifestFixture(), fabricatedTransition = approval(fabricated);
  assert.equal(verifyCustodyTransition(fabricated, fabricatedTransition).operation, "approve");
  await writeFile(join(root, "deployment-manifest.json"), deploymentBytes(fabricated));
  await assert.rejects(verifyCustodyProof(join(root, "deployment-manifest.json"), fabricatedTransition));
  for (const field of ["configurationSha256", "preparedSha256", "evidenceSha256"] as const) {
    const changed = { ...manifest, [field]: hash }, output = join(root, field);
    await publishDeploymentFiles(output, { ...files, "deployment-manifest.json": deploymentBytes(changed) });
    await assert.rejects(verifyCustodyProof(join(output, "deployment-manifest.json"), { ...transition, intent: { ...transition.intent, configurationSha256: changed.configurationSha256 } }), /DEPLOYMENT_MANIFEST_MISMATCH/);
  }
  const changed = structuredClone(manifest.configuration);
  const forgedPrepared = JSON.parse(new TextDecoder().decode(files["prepared-deployment.json"]!));
  // A valid changed configuration plus stale self-provided hash must fail even with a rebuilt inventory.
  Object.assign(changed, { deploymentId: "altered-local-test" });
  assert.ok(compileDeployment(changed, { sourceRevision: forgedPrepared.sourceRevision, artifacts: forgedPrepared.artifacts }, ports).prepared);
  forgedPrepared.configuration = changed;
  const output = join(root, "changed-config");
  await publishDeploymentFiles(output, { ...files, "prepared-deployment.json": deploymentBytes(forgedPrepared), "deployment-manifest.json": deploymentBytes({ ...manifest, configuration: changed }) });
  await assert.rejects(verifyCustodyProof(join(output, "deployment-manifest.json"), transition), /DEPLOYMENT_EVIDENCE_SHAPE/);
  const evidence = JSON.parse(new TextDecoder().decode(files["deployment-evidence.json"]!)); evidence.token.transaction.input = "0x00";
  const wrongEvidence = join(root, "wrong-evidence");
  await publishDeploymentFiles(wrongEvidence, { ...files, "deployment-evidence.json": deploymentBytes(evidence) });
  await assert.rejects(verifyCustodyProof(join(wrongEvidence, "deployment-manifest.json"), transition), /DEPLOYMENT_EVIDENCE_/);
  const transitionPath = join(root, "transition.json"); await writeFile(transitionPath, JSON.stringify(transition));
  const run = (manifestPath: string) => spawnSync(process.execPath, [resolve("tooling/testnet-ccip/src/composition/custody-verify.ts"), "--manifest", manifestPath, "--evidence", transitionPath], { encoding: "utf8" });
  const unproven = run(path); assert.equal(unproven.status, 2, unproven.stderr); assert.equal(unproven.stdout, "");
  assert.deepEqual(JSON.parse(unproven.stderr), { status: "invalid", reason: "CUSTODY_TRANSITION_PROVENANCE_UNPROVEN", broadcastAllowed: false });
  await writeFile(transitionPath, JSON.stringify(fabricatedTransition));
  const refused = run(join(root, "deployment-manifest.json")); assert.equal(refused.status, 2); assert.equal(JSON.parse(refused.stderr).status, "invalid");
  assert.deepEqual(new Uint8Array(await readFile(path)), files["deployment-manifest.json"]);
});
