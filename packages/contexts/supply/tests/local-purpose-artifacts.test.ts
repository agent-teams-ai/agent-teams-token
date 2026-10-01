import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { readLocalPurposeArtifactPins, readProductionArtifactPins } from "../src/features/genesis-manifest/adapters/deployment-artifacts.js";
import { compileLocalPurposeBuild } from "../src/features/genesis-manifest/adapters/local-purpose-build.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { buildFixture, forgePresentation } from "./local-purpose-build-fixture.js";

import { deploymentBytes } from "../src/features/genesis-manifest/application/compile-deployment.js";
import { constructProductionAssembly, prepareProductionDeployment, type ProductionExpectation, type PreparedProductionDeployment, type ProductionArtifactPin } from "../src/features/genesis-manifest/application/prepare-production-deployment.js";
import { prepareLocalPurposeGenesis, verifyLocalPurposePreflight, verifyAssemblyRuntime, materializeAssemblyRuntime } from "../src/features/genesis-manifest/application/prepare-local-purpose-genesis.js";
import { prepareAssemblyManifest } from "../src/features/genesis-manifest/application/deployment-manifest.js";
import { generateTokenPassport } from "../src/features/genesis-manifest/application/passport.js";
import { productionCompilerPorts, localPurposeCompilerPorts, loadPreparedProductionPackage, parseProductionApproval, parseProductionExpectations } from "../src/features/genesis-manifest/composition/deployment-files.js";
import { publishDeploymentFiles } from "../src/features/genesis-manifest/adapters/deployment-store.js";
import { syntheticProductionEnvelope } from "./production-fixture.js";
import { execFileSync } from "node:child_process";
import type { Hex } from "../src/features/genesis-manifest/domain/deployment.js";

const safeState = (safe: Record<string, any>) => ({ address: safe.address, owners: safe.owners, threshold: 2, nonce: "0", proxyCodeHash: sha256(Buffer.from("selected-proxy")),
    singletonCodeHash: sha256(Buffer.from("selected-singleton")), singletonAddress: `0x${"6".repeat(40)}`, singletonSlot: `0x${"6".repeat(40).padStart(64, "0")}`,
    modules: [], guard: null, fallbackHandler: null, setupProvenance: sha256(Buffer.from("selected-setup")) });

const padded = (value: string): Hex => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const words = (args: Hex) => args.slice(2).match(/.{64}/g)!;

const layouts = {
  AGTMAICCIPToken: ["GENESIS_ALLOCATION_HASH", "INITIAL_CCIP_ADMIN", "INITIAL_SUPPLY"],
  FounderGrantReserve: ["TOKEN", "VAULT"],
  ReserveController: ["CONTROLLER", "PER_GRANT_CAP", "PURPOSE", "ROLLING_CAP", "TOKEN"],
  PurposeReserveVault: ["CONTROLLER", "OPENS_AT", "PURPOSE", "ROLLING_CAP", "TOKEN", "WINDOW_SECONDS"],
  GrantVault: ["BENEFICIARY", "CONTROLLER", "ORIGINAL_RESERVE", "TOKEN"],
};
const sourceName = (contract: string) => `src/features/${contract === "AGTMAICCIPToken" ? "token-genesis" : contract === "PurposeReserveVault" ? "purpose-reserves" : "contributor-grants"}/${contract}.sol`;

type Pins = { schema: string; sourceRevision: string; artifacts: {
  contract: string; artifactPath: string; artifactSha256: string; buildInfoPath: string; buildInfoSha256: string;
}[] };
async function publish(root: string, revision: string, input: unknown, output: Record<string, any>, schema = "agtmai-local-purpose-artifact-pins-v1"): Promise<{ path: string; pins: Pins }> {
  const pins: Pins = { schema, sourceRevision: revision, artifacts: [] };
  for (const contract of Object.keys(layouts)) {
    const target = output.contracts[sourceName(contract)][contract];
    const artifact = Buffer.from(JSON.stringify({ metadata: JSON.parse(target.metadata), rawMetadata: target.metadata,
      bytecode: { ...target.evm.bytecode, object: `0x${target.evm.bytecode.object}` },
      deployedBytecode: { ...target.evm.deployedBytecode, object: `0x${target.evm.deployedBytecode.object}` } }));
    const build = Buffer.from(JSON.stringify({ solcVersion: "0.8.36", input, output }));
    const artifactPath = `${contract.toLowerCase()}.artifact.json`, buildInfoPath = `${contract.toLowerCase()}.build-info.json`;
    await writeFile(join(root, artifactPath), artifact); await writeFile(join(root, buildInfoPath), build);
    pins.artifacts.push({ contract, artifactPath, artifactSha256: sha256(artifact), buildInfoPath, buildInfoSha256: sha256(build) });
  }
  const path = join(root, "pins.json"); await writeFile(path, JSON.stringify(pins));
  return { path, pins };
}
function fictitiousOutput(): Record<string, any> {
  const output: Record<string, any> = { contracts: {}, sources: {} };
  let firstId = 1;
  for (const [contract, names] of Object.entries(layouts)) {
    const path = sourceName(contract);
    const refs = Object.fromEntries(names.map((_, index) => [String(firstId + index), [{ start: 1 + 32 * index, length: 32 }]]));
    const metadata = JSON.stringify({ compiler: { version: "0.8.36+commit.8a079791" }, settings: { compilationTarget: { [path]: contract } } });
    output.contracts[path] = { [contract]: { metadata, evm: { bytecode: { object: "60006000f3", linkReferences: {} },
      deployedBytecode: { object: `60${"00".repeat(32 * names.length)}00`, immutableReferences: refs, linkReferences: {} } } } };
    output.sources[path] = { ast: { nodes: names.map((name, index) => ({ nodeType: "VariableDeclaration", mutability: "immutable", id: firstId + index, name })) } };
    firstId += names.length;
  }
  return output;
}

const compilerPlatformSkip = (process.platform !== "linux" || process.arch !== "x64") && "requires pinned Linux x64 solc";

for (const schema of ["agtmai-local-purpose-artifact-pins-v1", "agtmai-production-artifact-pins-v2"]) {
  const reader = schema === "agtmai-production-artifact-pins-v2" ? readProductionArtifactPins : readLocalPurposeArtifactPins;
test(`${schema}: reader rejects a coherent forged Git source map even with agreeing candidate and pin revision labels`, { skip: compilerPlatformSkip }, async context => {
  const { candidate, input, inputs, sources } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  const forged = { ...sources };
  for (const contract of Object.keys(layouts)) {
    const path = sourceName(contract); forged[path] = `contract ${contract} {}`;
    input.sources[path].content = forged[path];
  }
  const { path } = await publish(inputs, candidate.revision, input, fictitiousOutput(), schema);
  // Old reader accepted this supplied map as its authority. Extra map has no authority in the new IO API.
  const labelled = { ...candidate, sources: forged };
  await assert.rejects(reader(path, labelled), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "DEPLOYMENT_ARTIFACT_PINS_INVALID");
    // Bounds/metadata rejection must not mask the Git-vs-build-input check.
    assert.match(error.stack!, /at verifiedLocalPurposeCompilerInput\b/);
    return true;
  });
});

test(`${schema}: reader compares every artifact with an actual authenticated pinned compiler invocation`, { skip: compilerPlatformSkip }, async context => {
  // Locate the workspace from the module, including compiled .local/tests output.
  let repository = import.meta.dirname;
  while (!existsSync(join(repository, "pnpm-workspace.yaml"))) {
    assert.notEqual(repository, dirname(repository), "repository workspace not found");
    repository = dirname(repository);
  }
  const installed = join(repository, ".tools/solc-v0.8.36-linux-x64/solc");
  // This qualification is required, and missing pinned prerequisites must fail visibly.
  const binary = await readFile(installed);
  const { candidate, input, inputs } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  const install = join(candidate.repositoryRoot, ".tools/solc-v0.8.36-linux-x64");
  await mkdir(install, { recursive: true }); await writeFile(join(install, "solc"), binary, { mode: 0o500 });
  const fresh = await compileLocalPurposeBuild(candidate, input);
  const { path } = await publish(inputs, candidate.revision, input, fresh, schema);
  const selected = { ...candidate, sources: Object.fromEntries(Object.entries(input.sources as Record<string, { content: string }>).map(([name, entry]) => [name, entry.content])) };
  const loaded = await reader(path, selected);
  assert.equal(loaded.artifacts.length, 5);
  const presented = forgePresentation(fresh);
  assert.notEqual(sha256(Buffer.from(JSON.stringify(presented))), sha256(Buffer.from(JSON.stringify(fresh))));
  await publish(inputs, candidate.revision, input, presented, schema);
  const admitted = await reader(path, selected);
  for (const artifact of admitted.artifacts) {
    const original = loaded.artifacts.find(entry => entry.contract === artifact.contract)!;
    assert.equal(artifact.creationBytecode, original.creationBytecode);
    assert.equal(artifact.runtimeBytecode, original.runtimeBytecode);
    assert.deepEqual(artifact.immutableReferences, original.immutableReferences);
  }
  for (const mutate of [
    (target: Record<string, any>) => { target.evm.bytecode.object = "60006000f3"; },
    (target: Record<string, any>) => { target.evm.deployedBytecode.object = `61${target.evm.deployedBytecode.object.slice(2)}`; },
    (target: Record<string, any>) => {
      const refs = target.evm.deployedBytecode.immutableReferences;
      const [a, b] = Object.keys(refs);
      [refs[a!], refs[b!]] = [refs[b!], refs[a!]];
    },
    (target: Record<string, any>) => { const m = JSON.parse(target.metadata); m.compiler.version = "0.8.36+commit.8a079791"; m.sources = {}; target.metadata = JSON.stringify(m); },
  ]) {
    const forged = structuredClone(fresh) as Record<string, any>;
    mutate(forged.contracts[sourceName("PurposeReserveVault")].PurposeReserveVault);
    // Both records and every file hash are regenerated coherently from the forgery.
    await publish(inputs, candidate.revision, input, forged, schema);
    await assert.rejects(reader(path, selected), /DEPLOYMENT_ARTIFACT_PINS_INVALID/);
  }
  await publish(inputs, candidate.revision, input, fresh, schema);
  await rm(join(install, "solc"));
  await writeFile(join(install, "solc"), "counterfeit compiler executable", { mode: 0o500 });
  await assert.rejects(reader(path, selected), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, "DEPLOYMENT_ARTIFACT_PINS_INVALID");
    assert.match(error.stack!, /at compileLocalPurposeBuild\b/);
    return true;
  });
});

}


test("full v2 package binds independent CREATE topology, constructor words, approvals and authenticated reconstruction", { skip: compilerPlatformSkip }, async context => {
  const { candidate, input, inputs } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  let repository = import.meta.dirname;
  while (!existsSync(join(repository, "pnpm-workspace.yaml"))) {
    assert.notEqual(repository, dirname(repository), "repository workspace not found");
    repository = dirname(repository);
  }
  const install = join(candidate.repositoryRoot, ".tools/solc-v0.8.36-linux-x64");
  await mkdir(install, { recursive: true });
  await writeFile(join(install, "solc"), await readFile(join(repository, ".tools/solc-v0.8.36-linux-x64/solc")), { mode: 0o500 });
  const fresh = await compileLocalPurposeBuild(candidate, input);
  const { path, pins: artifactPins } = await publish(inputs, candidate.revision, input, fresh, "agtmai-production-artifact-pins-v2");
  for (const changed of [{ ...artifactPins, schema: "agtmai-production-artifact-pins-v3" },
    { ...artifactPins, schema: "agtmai-production-artifact-pins-v1" }, { ...artifactPins, artifacts: artifactPins.artifacts.slice(0, 3) }]) {
    const mixed = join(inputs, "mixed.json"); await writeFile(mixed, JSON.stringify(changed));
    await assert.rejects(readProductionArtifactPins(mixed, candidate), /DEPLOYMENT_ARTIFACT_PINS_INVALID/);
  }
  const loaded = await readProductionArtifactPins(path, candidate);
  await assert.rejects(readProductionArtifactPins(path), /DEPLOYMENT_ARTIFACT_PINS_INVALID/);
  const sender = `0x${"9".repeat(40)}` as Hex;
  // Foundry's independent CREATE oracle survives deployment-plan removal.
  const create = (from: Hex, nonce: number) => execFileSync(join(repository, ".tools/foundry-v1.8.0-linux-x64/cast"),
    ["compute-address", from, "--nonce", String(nonce)], { encoding: "utf8" }).trim().toLowerCase() as Hex;
  const addresses = Array.from({ length: 9 }, (_, i) => create(sender, i + 8));
  const nested = create(addresses[1]!, 1);
  const ids = ["long-term", "users", "operations", "ecosystem", "financing", "liquidity"];
  const config = syntheticProductionEnvelope() as Record<string, any>;
  config.schema = "agtmai-production-deployment-v2"; config.deployment.bridge = null;
  config.deployment.policy.executionDeadline = "1800000100";
  const recipients = new Map<string, Hex>([["founder", addresses[1]!], ["contributors", addresses[2]!], ...ids.map((id, i): [string, Hex] => [id, addresses[i + 3]!])]);
  for (const a of config.deployment.allocations) { a.recipient = recipients.get(a.id); }
  config.purposeVaults = ids.map((allocationId, i) => ({ allocationId, opensAt: String(1900000000 + i), windowSeconds: String(86400 + i), rollingCapBaseUnits: "1000000000000000" }));
  const assembly = constructProductionAssembly(config, { sourceRevision: candidate.revision, artifacts: loaded.artifacts, sender, startingNonce: "8" }, productionCompilerPorts, sha256);
  const gas = { gasEstimate: "1000000", gasLimit: "1150000", baseFeePerGas: "1", maxPriorityFeePerGas: "1", maxFeePerGas: "2", blockGasLimit: "30000000", value: "0" };
  const approval = { schema: "agtmai-production-approval-v2" as const, configurationSha256: assembly.configurationSha256,
    reserveConfigurationSha256: assembly.reserveConfigurationSha256, assemblyConfigurationSha256: assembly.assemblyConfigurationSha256, reference: "synthetic-test-input-identity" };
  const expectations = { schema: "agtmai-production-expectations-v2", chainId: "1", sourceRevision: candidate.revision,
    configurationSha256: assembly.configurationSha256, reserveConfigurationSha256: assembly.reserveConfigurationSha256,
    assemblyConfigurationSha256: assembly.assemblyConfigurationSha256, artifactPinsSha256: assembly.artifactPinsSha256, attemptIdentity: assembly.attemptIdentity,
    coverage: "full-ethereum-reserve-assembly", sender, deployer: sender, startingNonce: "8", maxObservationAgeSeconds: "300", maxTotalCostWei: "300000000000000000",
    authority: config.deployment.custodySafes.map(safeState), operations: assembly.operations.map((op, i) => ({ id: op.id, kind: op.kind, nonce: op.nonce,
      intentHash: op.intentHash, expectedAddress: op.expectedAddress ?? op.to, ...gas, ...(op.kind === "call" ? { calldata: op.calldata } : {
        initcode: op.initcode, initcodeHash: assembly.constructors[i]!.initcodeHash, runtimeTemplate: assembly.constructors[i]!.runtimeTemplate,
        runtimeTemplateHash: assembly.constructors[i]!.runtimeTemplateHash, ...(i === 1 ? { nestedAddress: op.nestedAddress } : {}) }) })) } as ProductionExpectation;
  const selected = { artifactSourceRevision: candidate.revision, artifacts: loaded.artifacts, approval, expectations };
  const prepare = (value: unknown, bindings?: typeof selected) => prepareProductionDeployment(value, bindings ?? selected, productionCompilerPorts, sha256);
  for (const mutation of [
    (c: Record<string, any>) => { delete c.purposeVaults; },
    (c: Record<string, any>) => { c.purposeVaults.pop(); },
    (c: Record<string, any>) => { c.purposeVaults[0].opensAt = "0"; },
    (c: Record<string, any>) => { c.purposeVaults[0].opensAt = c.deployment.policy.executionDeadline; },
    (c: Record<string, any>) => { c.purposeVaults[0].windowSeconds = "18446744073709551616"; },
    (c: Record<string, any>) => { c.purposeVaults[0].rollingCapBaseUnits = "03000000000000000"; },
    (c: Record<string, any>) => { c.purposeVaults[0].rollingCapBaseUnits = "30000000000000001"; },
    (c: Record<string, any>) => { c.schema = "agtmai-production-deployment-v3"; },
  ]) { const changed = structuredClone(config); mutation(changed); assert.equal(prepare(changed).prepared, undefined); }
  const prepared = prepare(config).prepared!;
  assert.ok(prepared); assert.equal(prepared.broadcastAllowed, false);
  assertConstructorTopology(prepared, config, { addresses, nested, recipients, ids });
  const founder = config.reserveGenesis.founder;
  assertRuntimeBindings(prepared, config, addresses, loaded.artifacts);
  // Every policy field and Safe reference is covered by the full approval, beyond the two retained v1 digests.
  for (let i = 0; i < 6; i++) {
    for (const field of ["opensAt", "windowSeconds", "rollingCapBaseUnits"]) {
      const changed = structuredClone(config); changed.purposeVaults[i][field] = String(BigInt(changed.purposeVaults[i][field]) + (field === "rollingCapBaseUnits" ? -1n : 1n));
      const result = prepare(changed); assert.equal(result.prepared, undefined, `${i}.${field}`);
      assert.ok(result.diagnostics.some(d => d.code === "PRODUCTION_ASSEMBLY_APPROVAL_BINDING"));
    }
    const changed = structuredClone(config), j = (i + 1) % 6;
    [changed.purposeVaults[i].allocationId, changed.purposeVaults[j].allocationId] = [changed.purposeVaults[j].allocationId, changed.purposeVaults[i].allocationId];
    const result = prepare(changed); assert.equal(result.prepared, undefined, `${i}.allocationId`);
    assert.ok(result.diagnostics.some(d => d.code === "PRODUCTION_ASSEMBLY_APPROVAL_BINDING"));
  }
  for (const field of ["projectControllerSafeId", "founderBeneficiarySafeId"]) {
    const changed = structuredClone(config), old = changed[field]; changed[field] += "-renamed";
    changed.deployment.custodySafes.find((s: Record<string, any>) => s.id === old).id = changed[field];
    for (const alias of changed.deployment.roleAliases) { alias.roles = alias.roles.map((r: string) => r.replace(`safe.${old}.`, `safe.${changed[field]}.`)); }
    const renamed = constructProductionAssembly(changed, { sourceRevision: candidate.revision, artifacts: loaded.artifacts, sender, startingNonce: "8" }, productionCompilerPorts, sha256);
    const result = prepare(changed, { ...selected, approval: { ...approval, configurationSha256: renamed.configurationSha256 },
      expectations: { ...expectations, configurationSha256: renamed.configurationSha256 } });
    assert.equal(result.prepared, undefined, field);
    assert.ok(result.diagnostics.some(d => d.code === "PRODUCTION_ASSEMBLY_APPROVAL_BINDING"));
  }
  const collision = structuredClone(config); collision.deployment.custodySafes[0].owners[0] = nested;
  assert.throws(() => constructProductionAssembly(collision, { sourceRevision: candidate.revision, artifacts: loaded.artifacts, sender, startingNonce: "8" }, productionCompilerPorts, sha256), /LOCAL_PURPOSE_PLAN_INVALID/);
  const swapped = structuredClone(config);
  [swapped.deployment.allocations[0].recipient, swapped.deployment.allocations[1].recipient] = [swapped.deployment.allocations[1].recipient, swapped.deployment.allocations[0].recipient];
  assert.throws(() => constructProductionAssembly(swapped, { sourceRevision: candidate.revision, artifacts: loaded.artifacts, sender, startingNonce: "8" }, productionCompilerPorts, sha256), /LOCAL_PURPOSE_PLAN_INVALID/);
  for (const changed of [ { ...expectations, schema: "agtmai-production-expectations-v1" }, { ...expectations, operations: expectations.operations.slice(0, 4) },
    { ...expectations, operations: expectations.operations.toReversed() } ]) {
    assert.equal(prepare(config, { ...selected, expectations: changed as ProductionExpectation }).prepared, undefined);
  }
  assert.equal(prepare({ ...config, schema: "agtmai-production-deployment-v1" }).prepared, undefined);
  assert.throws(() => parseProductionApproval(JSON.stringify({ ...approval, schema: "unknown" })), /DEPLOYMENT_PRODUCTION_SOURCE/);
  assert.throws(() => parseProductionExpectations(JSON.stringify({ ...expectations, schema: "agtmai-production-expectations-v1" })), /DEPLOYMENT_PRODUCTION_SOURCE/);
  assert.throws(() => constructProductionAssembly(config, { sourceRevision: candidate.revision, artifacts: loaded.artifacts, sender, startingNonce: "18446744073709551606" }, productionCompilerPorts, sha256), /LOCAL_PURPOSE_PLAN_INVALID/);
  for (const mutate of [
    (e: any) => { e.operations[3].gasLimit = "1150001"; },
    (e: any) => { e.operations[9].maxFeePerGas = "10000000001"; },
    (e: any) => { e.operations[4].maxPriorityFeePerGas = "3"; },
    (e: any) => { e.maxTotalCostWei = "1"; },
    (e: any) => { e.operations[8].runtimeTemplate = e.operations[7].initcode; },
    (e: any) => { e.operations[1].nestedAddress = addresses[1]; },
  ]) { const changed = structuredClone(expectations); mutate(changed); assert.equal(prepare(config, { ...selected, expectations: changed }).prepared, undefined); }
  const manifest = prepareAssemblyManifest(prepared, { ...productionCompilerPorts, sha256 });
  assert.equal(manifest.worstCaseWei, "23000000"); assert.equal(manifest.evidenceSha256, null); assert.equal(manifest.observedWei, null);
  assertPassportDisclosure(manifest);
  const reserve = structuredClone(config.reserveGenesis); delete reserve.schema; delete reserve.status;
  const local = { schema: "agtmai-local-purpose-genesis-v2", status: "test-only", chainId: "1", tokenContract: "AGTMAICCIPToken", reserve,
    custodySafes: config.deployment.custodySafes, projectControllerSafeId: config.projectControllerSafeId, founderBeneficiarySafeId: config.founderBeneficiarySafeId,
    purposeVaults: config.purposeVaults, roleAliases: [{ address: founder.controller, roles: ["safe.project-controller.address", "token.initialCCIPAdmin", "founder.controller", "contributors.controller"] },
      { address: founder.beneficiary, roles: ["safe.founder-beneficiary.address", "founder.beneficiary"] }], execution: { sender, startingNonce: "8", fundingDeadline: "1799999940", fundingLeadSeconds: "60",
        executionDeadline: "1800000100", maxFeePerGasWei: "10000000000", maxPriorityFeePerGasWei: "1000000000", maxGasPerTransaction: "6000000", maxTotalFeeWei: "300000000000000000" } };
  const synthetic = prepareLocalPurposeGenesis(local, candidate.revision, loaded, localPurposeCompilerPorts);
  assert.deepEqual(synthetic.constructors, prepared.constructors); assert.equal(synthetic.approval, null); assert.equal(synthetic.authorityClass, "test-only");
  assert.equal(prepare(local).prepared, undefined); assert.equal(prepare(synthetic).prepared, undefined);
  assert.throws(() => prepareLocalPurposeGenesis({ ...local, schema: "agtmai-local-purpose-genesis-v1" }, candidate.revision, loaded, localPurposeCompilerPorts), /LOCAL_PURPOSE_GENESIS_INVALID/);
  const preflight = { chainId: "1" as const, blockHash: sha256(Buffer.from("block")), blockNumber: "1", timestamp: "1799999900", sender, nextNonce: "8", accounts: [...addresses, nested].map(address => ({ address, code: "0x" as Hex, nonce: "0" })) };
  assert.doesNotThrow(() => verifyLocalPurposePreflight(synthetic, preflight));
  for (let i = 0; i < 10; i++) { for (const patch of [{ code: "0x6000" as Hex }, { nonce: "1" }]) {
    assert.throws(() => verifyLocalPurposePreflight(synthetic, { ...preflight, accounts: preflight.accounts.map((a, j) => j === i ? { ...a, ...patch } : a) }), /LOCAL_PURPOSE_PLAN_INVALID/);
  } }
  const files = { ...loaded.files, "canonical-production-configuration.json": deploymentBytes(prepared.configuration), "production-approval.json": deploymentBytes(approval),
    "production-expectations.json": deploymentBytes(expectations), "production-artifact-pins.json": deploymentBytes(artifactPins), "prepared-production-deployment.json": deploymentBytes(prepared) };
  const pkg = join(inputs, "package"); await publishDeploymentFiles(pkg, files);
  assert.deepEqual(await loadPreparedProductionPackage(pkg, candidate), prepared);
  const cliPackage = join(inputs, "cli-package");
  const cli = JSON.parse(execFileSync(process.execPath, [join(repository, "packages/contexts/supply/dist/features/genesis-manifest/composition/cli.js"),
    "deployment", "compile-production", "--config", join(pkg, "canonical-production-configuration.json"), "--artifacts", join(pkg, "production-artifact-pins.json"),
    "--approval", join(pkg, "production-approval.json"), "--expectations", join(pkg, "production-expectations.json"), "--output", cliPackage,
    "--repository-root", candidate.repositoryRoot, "--candidate-revision", candidate.revision], { encoding: "utf8" }));
  assert.deepEqual(cli, { status: "prepared", coverage: "full-ethereum-reserve-assembly", broadcastAllowed: false });
  assert.deepEqual(await loadPreparedProductionPackage(cliPackage, candidate), prepared);
  await assert.rejects(loadPreparedProductionPackage(pkg), /DEPLOYMENT_ARTIFACT_PINS_INVALID/);
  const forged = { ...prepared, constructors: prepared.constructors!.map((r, i) => i === 9 ? { ...r, predictedAddress: addresses[0] } : r) };
  const bad = join(inputs, "forged"); await publishDeploymentFiles(bad, { ...files, "prepared-production-deployment.json": deploymentBytes(forged) });
  await assert.rejects(loadPreparedProductionPackage(bad, candidate), /DEPLOYMENT_PRODUCTION_PREPARED_MISMATCH/);
  // Reopening repeats admission; an index-hidden source edit invalidates an otherwise intact package.
  const source = join(candidate.repositoryRoot, "contracts/evm/src/features/purpose-reserves/PurposeReserveVault.sol");
  await writeFile(source, `${await readFile(source, "utf8")}\n`);
  execFileSync("/usr/bin/git", ["-C", candidate.repositoryRoot, "update-index", "--assume-unchanged", "contracts/evm/src/features/purpose-reserves/PurposeReserveVault.sol"]);
  await assert.rejects(loadPreparedProductionPackage(pkg, candidate), /DEPLOYMENT_ARTIFACT_PINS_INVALID/);
});

function assertPassportDisclosure(manifest: ReturnType<typeof prepareAssemblyManifest>): void {
  const passport = generateTokenPassport(manifest, { schema: "agtmai-deployment-observations-v1", observedAt: "1", validUntil: "2",
    unresolved: ["z expiry", "a `blocker`\nnext"] }, { sha256 });
  assert.match(passport.markdown, /unsigned-preparation/); assert.match(passport.markdown, /Actual production deployment: unavailable/);
  assert.ok(passport.markdown.includes("- Observation interval: 1–2"));
  assert.ok(passport.markdown.includes("- Unresolved: a \\`blocker\\` next\n- Unresolved: z expiry"));
  const refreshed = generateTokenPassport(manifest, { schema: "agtmai-deployment-observations-v1", observedAt: "3", validUntil: "4", unresolved: ["new blocker"] }, { sha256 });
  assert.ok(refreshed.markdown.includes("- Observation interval: 3–4"));
  assert.ok(refreshed.markdown.includes("- Unresolved: new blocker"));
  assert.ok(passport.authorityRegistry.entries.length > 0);
  for (const entry of passport.authorityRegistry.entries) {
    assert.ok(passport.markdown.includes(`- ${entry.capability.replaceAll("_", "\\_")} on ${entry.chain}: power ${entry.power}; expected ${entry.expected}; observed unresolved; ${entry.limitation}.`), entry.capability);
  }
  assert.equal(passport.authorityRegistry.entries.every(e => e.observed === null), true);
}

function assertConstructorTopology(prepared: PreparedProductionDeployment, config: Record<string, any>,
  topology: { addresses: Hex[]; nested: Hex; recipients: ReadonlyMap<string, Hex>; ids: string[] }): void {
  const { addresses, nested, recipients, ids } = topology;
  assert.deepEqual(prepared.operations.map(o => o.id), ["token-create", "founder-reserve-create", "controller-create", ...ids.map(id => `purpose-${id}-create`), "founder-fund"]);
  assert.deepEqual(prepared.operations.slice(0, 9).map(o => o.expectedAddress), addresses);
  assert.deepEqual(prepared.operations.map(o => o.nonce), Array.from({ length: 10 }, (_, i) => String(i + 8)));
  assert.equal(prepared.operations[1]!.nestedAddress, nested);
  assert.equal(prepared.operations[9]!.to, addresses[1]); assert.equal(prepared.operations[9]!.calldata, "0xb60d4288");
  assert.equal(prepared.constructors!.length, 10);
  const tokenWords = words(prepared.constructors![0]!.constructorArgs);
  assert.equal(BigInt(`0x${tokenWords[0]}`), 100000000000000000n); assert.equal(BigInt(`0x${tokenWords[3]}`), 8n);
  for (let i = 4; i < tokenWords.length; i += 3) {
    const id = Buffer.from(tokenWords[i]!, "hex").toString().replaceAll("\0", "");
    assert.equal(`0x${tokenWords[i + 1]!.slice(-40)}`, recipients.get(id));
  }
  for (const [i, id] of ids.entries()) {
    const record = prepared.constructors![i + 3]!, policy = config.purposeVaults[i];
    assert.equal(record.fullyQualifiedName, "src/features/purpose-reserves/PurposeReserveVault.sol:PurposeReserveVault");
    const w = words(record.constructorArgs);
    assert.deepEqual(w.slice(0, 3), [addresses[0]!.slice(2).padStart(64, "0"), config.deployment.custodySafes[0].address.slice(2).padStart(64, "0"), Buffer.from(id).toString("hex").padEnd(64, "0")]);
    assert.deepEqual(w.slice(3).map(raw => BigInt(`0x${raw}`).toString()), [policy.opensAt, policy.windowSeconds, policy.rollingCapBaseUnits]);
  }
  const child = prepared.constructors![9]!;
  assert.equal(child.predictedAddress, nested); assert.deepEqual(child.creation, { kind: "nested", parentOperationId: "founder-reserve-create", nonce: "1" });
  const childWords = words(child.constructorArgs), founder = config.reserveGenesis.founder;
  assert.deepEqual(childWords.slice(0, 4), [addresses[0]!, founder.beneficiary, addresses[1]!, founder.controller].map(a => a.slice(2).padStart(64, "0")));
  assert.deepEqual(childWords.slice(4, 9).map(w => BigInt(`0x${w}`).toString()), ["3000000000000000", founder.schedule.start, founder.schedule.cliff, founder.schedule.end, "0"]);
  assert.equal(`0x${childWords[9]}`, founder.purpose); assert.equal(child.observed, null);
}

function assertRuntimeBindings(prepared: PreparedProductionDeployment, config: Record<string, any>, addresses: readonly Hex[], artifacts: readonly ProductionArtifactPin[]): void {
  const child = prepared.constructors![9]!;
  const founder = config.reserveGenesis.founder, policy = config.purposeVaults[0];
  const oracles: Readonly<Record<string, Hex>>[] = [
    { TOKEN: padded(addresses[0]!), BENEFICIARY: padded(founder.beneficiary), ORIGINAL_RESERVE: padded(addresses[1]!), CONTROLLER: padded(founder.controller) },
    { TOKEN: padded(addresses[0]!), CONTROLLER: padded(config.deployment.custodySafes[0].address), PURPOSE: `0x${Buffer.from("long-term").toString("hex").padEnd(64, "0")}`,
      OPENS_AT: padded(policy.opensAt), WINDOW_SECONDS: padded(policy.windowSeconds), ROLLING_CAP: padded(policy.rollingCapBaseUnits) },
  ];
  for (const [i, record] of [child, prepared.constructors![3]!].entries()) {
    const values = oracles[i]!;
    const artifact = artifacts.find(a => a.contract === record.contract)!;
    assert.deepEqual(record.immutableValues, values);
    for (const ref of artifact.immutableReferences) {
      assert.equal(`0x${record.materializedRuntime.slice(2 + ref.start * 2, 2 + (ref.start + 32) * 2)}`, values[ref.name]);
    }
    assert.notEqual(record.runtimeTemplate, record.materializedRuntime);
    assert.doesNotThrow(() => verifyAssemblyRuntime(artifact, values, record.materializedRuntime));
    const altered = `0x00${record.materializedRuntime.slice(4)}` as Hex;
    assert.throws(() => verifyAssemblyRuntime(artifact, values, altered), /LOCAL_PURPOSE_PLAN_INVALID/);
    const wrong = { ...values, TOKEN: `0x${"a".repeat(64)}` as Hex };
    assert.throws(() => verifyAssemblyRuntime(artifact, wrong, record.materializedRuntime), /LOCAL_PURPOSE_PLAN_INVALID/);
    assert.throws(() => materializeAssemblyRuntime({ ...artifact, immutableReferences: [...artifact.immutableReferences, artifact.immutableReferences[0]!] }, values), /LOCAL_PURPOSE_PLAN_INVALID/);
    assert.throws(() => materializeAssemblyRuntime(artifact, { ...values, UNKNOWN: `0x${"1".repeat(64)}` }), /LOCAL_PURPOSE_PLAN_INVALID/);
  }
}
