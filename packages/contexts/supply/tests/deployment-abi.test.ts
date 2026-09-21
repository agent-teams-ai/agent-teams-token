import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { validateDeployment } from "../src/features/genesis-manifest/domain/deployment.js";
import { encodeDeploymentGrant, encodeDeploymentToken } from "../src/features/genesis-manifest/adapters/deployment-abi.js";
import { compileDeployment, deploymentBytes, type DeploymentArtifact } from "../src/features/genesis-manifest/application/compile-deployment.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";

const ports = { sha256, encodeToken: encodeDeploymentToken, encodeGrant: encodeDeploymentGrant };
const revision = "17136dc08fc928f3cebc6af89215e31f6f2bb537";
const artifacts: DeploymentArtifact[] = ["AGTMAICCIPToken", "GrantVault"].map(contract => ({
  contract: contract as DeploymentArtifact["contract"], compilerVersion: "0.8.36", artifactSha256: `0x${"ab".repeat(32)}`, buildInfoSha256: `0x${"ef".repeat(32)}`, compilerInputSha256: `0x${"cd".repeat(32)}`,
  creationBytecode: "0x6000", runtimeBytecode: `0x${"00".repeat(32)}`, immutableReferences: [{ start: 0, length: 32 }],
}));

test("token and actual vault constructor encoding agree with pinned cast for two unrelated configurations", () => {
  const cast = resolve("../../../.tools/foundry-v1.8.0-linux-x64/cast");
  for (const mode of ["local-test", "owned-testnet"]) {
    const { value: config, allocations } = validateDeployment(JSON.parse(readFileSync(`tests/fixtures/deployment/${mode}.json`, "utf8")));
    assert.ok(config && allocations);
    const expectedToken = execFileSync(cast, ["abi-encode", "f(uint256,(bytes32,address,uint256)[],address)", config.token.initialSupplyBaseUnits,
      `[${allocations.map(a => `(${a.idBytes32},${a.recipient},${a.amountBaseUnits})`).join(",")}]`, config.token.initialCCIPAdmin], { encoding: "utf8" }).trim();
    assert.equal(encodeDeploymentToken(config, allocations).constructorArgs, expectedToken);
    const token = "0x000000000000000000000000000000000000f00d";
    for (const grant of config.grants) {
      const reserve: string = config.allocations.find(a => a.id === grant.fundingAllocation)!.recipient;
      const controller: string = config.custodySafes.find(s => s.id === grant.controllerSafe)!.address;
      const terms = `(${grant.amountBaseUnits},${grant.schedule.start},${grant.schedule.cliff},${grant.schedule.end},${grant.kind === "founder" ? "0" : "1"},${grant.originalPurpose})`;
      const expected: string = execFileSync(cast, ["abi-encode", "f(address,address,address,address,(uint256,uint64,uint64,uint64,uint8,bytes32))", token, grant.beneficiary, reserve, controller, terms], { encoding: "utf8" }).trim();
      assert.equal(encodeDeploymentGrant(config, grant, token), expected);
    }
  }
});

test("unsigned preparation refuses draft input and binds canonical configuration independently of array order", () => {
  const config = JSON.parse(readFileSync("tests/fixtures/deployment/local-test.json", "utf8"));
  const result = compileDeployment(config, { sourceRevision: revision, artifacts }, ports);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.prepared!.broadcastAllowed, false);
  assert.equal(result.prepared!.configurationSha256, sha256(deploymentBytes(validateDeployment(config).value)));
  assert.equal(result.prepared!.approval, null);
  assert.equal(compileDeployment({ ...config, status: "draft" }, { sourceRevision: revision, artifacts }, ports).prepared, undefined);
  assert.ok(compileDeployment(config, { sourceRevision: revision, artifacts: [] }, ports).diagnostics.some(d => d.code === "DEPLOYMENT_ARTIFACT_SET"));
  const other = { ...config, allocations: [...config.allocations].toReversed() };
  assert.deepEqual(deploymentBytes(compileDeployment(other, { sourceRevision: revision, artifacts }, ports).prepared), deploymentBytes(result.prepared));
});

test("legacy mainnet-shaped compilation is rejected even with a caller approval", () => {
  const local = JSON.parse(readFileSync("tests/fixtures/deployment/local-test.json", "utf8"));
  const evm = "0x1111111111111111111111111111111111111111", sol = "11111111111111111111111111111111";
  const limit = { enabled: false, capacity: "0", rate: "0" };
  const config = { ...local, status: "accepted", testScenario: null,
    environment: { ...local.environment, mode: "mainnet-dry-run", evmChainId: "1" },
    bridge: { protocol: { reference: "synthetic-test-only", snapshotSha256: `0x${"ab".repeat(32)}`, networkDataSha256: `0x${"cd".repeat(32)}` },
      ethereum: { token: null, pool: null, router: evm, rmn: evm, registry: evm, registryModule: evm, registryAdministrator: evm, poolOwner: evm, rateLimitAdministrator: evm, rebalancer: null, inbound: limit, outbound: limit },
      solana: { mint: null, pool: null, poolSigner: null, poolTokenAccount: null, lookupTable: null, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", router: sol, offRamp: sol, rmn: sol, feeQuoter: sol, burnMintProgram: sol, poolAdministrator: sol, registryAdministrator: sol, upgradeAuthority: null, inbound: limit, outbound: limit } } };
  const result = compileDeployment(config, { sourceRevision: revision, artifacts }, ports);
  assert.ok(result.diagnostics.some(d => d.code === "DEPLOYMENT_PRODUCTION_ENVELOPE_REQUIRED"));
  assert.equal(result.prepared, undefined);
});

test("canonical deployment bytes reject implicit numeric or object coercion", () => {
  for (const value of [1n, undefined, new Date(0), { selector: 1n }, [undefined], Array(2)]) {
    assert.throws(() => deploymentBytes(value), /canonical JSON/);
  }
});


test("grant constructor kind rejects unknown runtime values and binds the exact ABI enum", () => {
  const { value: config } = validateDeployment(JSON.parse(readFileSync("tests/fixtures/deployment/local-test.json", "utf8")));
  assert.ok(config);
  const grant = config.grants[0]!, token = "0x000000000000000000000000000000000000f00d";
  for (const [kind, expected] of [["founder", 0n], ["team", 1n]] as const) {
    const encoded = encodeDeploymentGrant(config, { ...grant, kind }, token);
    assert.equal(BigInt(`0x${encoded.slice(2 + 8 * 64, 2 + 9 * 64)}`), expected);
  }
  for (const kind of ["founder-like", "Team", "", null, undefined, 0, 1]) {
    assert.throws(() => encodeDeploymentGrant(config, { ...grant, kind } as unknown as typeof grant, token), /DEPLOYMENT_ABI_GRANT_KIND/);
  }
});
