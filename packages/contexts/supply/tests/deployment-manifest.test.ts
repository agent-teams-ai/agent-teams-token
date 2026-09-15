import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileDeployment, type DeploymentArtifact } from "../src/features/genesis-manifest/application/compile-deployment.js";
import { materializeDeploymentManifest, type ContractDeploymentEvidence, type DeploymentEvidence } from "../src/features/genesis-manifest/application/deployment-manifest.js";
import { encodeDeploymentToken, encodeDeploymentGrant } from "../src/features/genesis-manifest/adapters/deployment-abi.js";
import { expectedTokenCalls, expectedGrantCalls, deploymentCreateAddress } from "../src/features/genesis-manifest/adapters/deployment-observations.js";
import { parseDeploymentEvidence } from "../src/features/genesis-manifest/adapters/deployment-evidence.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";

const ports = { sha256, encodeToken: encodeDeploymentToken, encodeGrant: encodeDeploymentGrant, expectedTokenCalls, expectedGrantCalls, createAddress: deploymentCreateAddress };
const revision = "17136dc08fc928f3cebc6af89215e31f6f2bb537";
function synthetic() {
  const config = JSON.parse(readFileSync("tests/fixtures/deployment/local-test.json", "utf8"));
  const artifacts: DeploymentArtifact[] = ["AGTMAICCIPToken", "GrantVault"].map(contract => ({ contract: contract as DeploymentArtifact["contract"], compilerVersion: "0.8.36",
    artifactSha256: `0x${"ab".repeat(32)}`, buildInfoSha256: `0x${"ef".repeat(32)}`, compilerInputSha256: `0x${"cd".repeat(32)}`, creationBytecode: "0x6000", runtimeBytecode: `0x60${"00".repeat(32)}`, immutableReferences: [{ start: 1, length: 32 }] }));
  const prepared = compileDeployment(config, { sourceRevision: revision, artifacts }, ports).prepared!;
  const from = "0x0000000000000000000000000000000000000001", address = deploymentCreateAddress(from, "0");
  const block = { number: "1", hash: `0x${"11".repeat(32)}` as const, timestamp: "1700000000" };
  const state = expectedTokenCalls(prepared.configuration, prepared.token.genesisAllocationHash);
  const token: ContractDeploymentEvidence = { address,
    transaction: { hash: `0x${"22".repeat(32)}`, from, nonce: "0", chainId: "31337", to: null, value: "0", input: prepared.token.initcode },
    receipt: { transactionHash: `0x${"22".repeat(32)}`, blockHash: block.hash, blockNumber: block.number, contractAddress: address, status: 1, gasUsed: "1000000", effectiveGasPrice: "1000000000",
      logs: state.logs.map((l, i) => ({ ...l, address, removed: false, logIndex: String(i) })) },
    blockBefore: block, blockAfter: { ...block }, finalizedBlock: { ...block }, runtime: { blockHash: block.hash, blockNumber: block.number, code: artifacts[0]!.runtimeBytecode },
    calls: Object.entries(state.calls).map(([data, result]) => ({ to: address, data: data as `0x${string}`, result, blockHash: block.hash, blockNumber: block.number })) };
  const evidence: DeploymentEvidence = { schema: "agtmai-deployment-evidence-v1", configurationSha256: prepared.configurationSha256,
    collector: { kind: "local-anvil", sourceRevision: revision }, token, grants: [] };
  return { prepared, evidence };
}

test("selected synthetic observations produce traceable partial facts; absent deployments remain absent", () => {
  const { prepared, evidence } = synthetic();
  const manifest = materializeDeploymentManifest(prepared, evidence, ports);
  assert.equal(manifest.status, "partial");
  assert.equal(manifest.token!.transactionHash, evidence.token!.transaction.hash);
  assert.equal(manifest.token!.constructorArgs, prepared.token.constructorArgs);
  assert.deepEqual(manifest.grants, []);
  const absent = materializeDeploymentManifest(prepared, { ...evidence, token: null }, ports);
  assert.equal(absent.status, "not-deployed"); assert.equal(absent.token, null);
  assert.match(absent.observationTrust, /not independent consensus truth/);
});

test("wrong native identities, chain, creation input, finality, runtime, getters and events cannot materialize", () => {
  const mutations: readonly [readonly string[], unknown][] = [
    [["transaction", "chainId"], "1"],
    [["transaction", "input"], "0x00"],
    [["transaction", "nonce"], "1"],
    [["receipt", "status"], 0],
    [["receipt", "blockHash"], `0x${"33".repeat(32)}`],
    [["blockAfter", "timestamp"], "1700000001"],
    [["finalizedBlock", "number"], "0"],
    [["runtime", "code"], `0x61${"00".repeat(32)}`],
    [["calls", "0", "result"], "0x00"],
    [["calls", "0", "blockNumber"], "2"],
    [["receipt", "logs", "0", "address"], "0x0000000000000000000000000000000000000002"],
    [["receipt", "logs", "0", "data"], "0x" + "0".repeat(64)],
    [["receipt", "logs"], []],
  ];
  for (const [path, replacement] of mutations) {
    const { prepared, evidence } = synthetic();
    let target = evidence.token as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) { target = target[key] as Record<string, unknown>; }
    target[path.at(-1)!] = replacement;
    assert.throws(() => materializeDeploymentManifest(prepared, evidence, ports), /DEPLOYMENT_EVIDENCE_/);
  }
});

test("public evidence parser rejects unknown private fields and duplicate keys", () => {
  const { evidence } = synthetic();
  assert.deepEqual(parseDeploymentEvidence(JSON.stringify(evidence)), evidence);
  assert.throws(() => parseDeploymentEvidence(JSON.stringify({ ...evidence, rpcPassword: "do-not-publish" })), /SHAPE/);
  assert.throws(() => parseDeploymentEvidence(JSON.stringify(evidence).replace('"schema":', '"schema":"duplicate","schema":')), /SHAPE/);
});
