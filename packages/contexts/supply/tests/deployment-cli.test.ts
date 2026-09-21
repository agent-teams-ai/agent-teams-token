import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { deploymentBytes } from "../src/features/genesis-manifest/application/compile-deployment.js";
import { canonicalJson, type JsonValue } from "../src/features/genesis-manifest/application/canonical.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { encodeDeploymentToken, encodeProductionFounderReserve, encodeProductionReserveController } from "../src/features/genesis-manifest/adapters/deployment-abi.js";
import { deploymentCreateAddress, keccakBytes } from "../src/features/genesis-manifest/adapters/deployment-observations.js";
import { loadPreparedProductionPackage } from "../src/features/genesis-manifest/composition/deployment-files.js";
import type { Hex } from "../src/features/genesis-manifest/domain/deployment.js";
import { encodeAllocationId } from "../src/features/genesis-manifest/domain/model.js";
import { validateProductionDeployment } from "../src/features/genesis-manifest/domain/production-deployment.js";
import { syntheticProductionEnvelope } from "./production-fixture.js";

const run = (args: string[]) => spawnSync(process.execPath, [resolve("dist/features/genesis-manifest/composition/cli.js"), "deployment", ...args], { encoding: "utf8" });

test("deployment CLI validates explicit configuration, rejects execution flags and redacts I/O paths", () => {
  const valid = run(["validate", "--config", "tests/fixtures/deployment/local-test.json"]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).broadcastAllowed, false);
  assert.equal(JSON.parse(valid.stdout).configurationStatus, "test-only");
  for (const flag of ["--execute", "--broadcast", "--private-key", "--rpc-url"]) {
    const refused = run(["validate", "--config", "tests/fixtures/deployment/local-test.json", flag, "private-value"]);
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout.includes("private-value"), false);
  }
  const missing = run(["compile", "--config", "missing-secret-credential-path"]);
  assert.equal(missing.status, 3, missing.stderr);
  assert.equal((missing.stdout + missing.stderr).includes("missing-secret-credential-path"), false);
  assert.equal(JSON.parse(missing.stdout).reason, "DEPLOYMENT_IO_UNAVAILABLE");
});

test("serialized production CLI input preserves strict exact-field validation", async context => {
  const parent = resolve("../../../.local/production-cli-tests"); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "case-")); context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "production.json");
  await writeFile(path, JSON.stringify(syntheticProductionEnvelope()));
  const valid = run(["validate-production", "--config", path]);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const mutated = syntheticProductionEnvelope(); (mutated.reserveGenesis as Record<string, unknown>).unexpected = true;
  await writeFile(path, JSON.stringify(mutated));
  const rejected = run(["validate-production", "--config", path]);
  assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
});

const bytes = (value: unknown): Uint8Array => deploymentBytes(value);
const hash = (value: Uint8Array): Hex => sha256(value);
const encode = new TextEncoder();

const immutableNamesByContract = {
  AGTMAICCIPToken: ["GENESIS_ALLOCATION_HASH", "INITIAL_CCIP_ADMIN", "INITIAL_SUPPLY"],
  FounderGrantReserve: ["TOKEN", "VAULT"],
  ReserveController: ["CONTROLLER", "PER_GRANT_CAP", "PURPOSE", "ROLLING_CAP", "TOKEN"],
} as const;

function sourceArtifact(contract: "AGTMAICCIPToken" | "FounderGrantReserve" | "ReserveController", omitLastImmutable = false): { readonly artifact: Record<string, unknown>; readonly build: Record<string, unknown>; readonly references: readonly { readonly name: string; readonly start: number; readonly length: 32 }[] } {
  const source = `contracts/${contract}.sol`;
  const rawMetadata = `synthetic-${contract}-metadata`;
  const names = omitLastImmutable ? immutableNamesByContract[contract].slice(0, -1) : immutableNamesByContract[contract];
  const runtime = "00".repeat(names.length * 32);
  const references = names.map((name, index) => ({ name, start: index * 32, length: 32 as const }));
  const immutableReferences = Object.fromEntries(references.map((reference, index) => [String(index + 1), [{ start: reference.start, length: reference.length }]]));
  const output = { contracts: { [source]: { [contract]: { metadata: rawMetadata, evm: { bytecode: { object: "6001" }, deployedBytecode: { object: runtime, immutableReferences } } } } }, sources: { [source]: { ast: { nodeType: "SourceUnit", nodes: references.map((reference, index) => ({ nodeType: "VariableDeclaration", id: index + 1, name: reference.name, mutability: "immutable" })) } } } };
  return {
    artifact: { metadata: { compiler: { version: "0.8.36+commit.8a079791" }, settings: { compilationTarget: { [source]: contract } } }, rawMetadata, bytecode: { object: "0x6001", linkReferences: {} }, deployedBytecode: { object: `0x${runtime}`, linkReferences: {}, immutableReferences } },
    build: { solcVersion: "0.8.36", input: { language: "Solidity", settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 } } }, output },
    references,
  };
}

async function writeProductionInputs(directory: string, incompleteImmutableContract?: keyof typeof immutableNamesByContract): Promise<{ readonly config: string; readonly artifacts: string; readonly approval: string; readonly expectations: string }> {
  const sourceRevision = "b".repeat(40);
  const envelope = syntheticProductionEnvelope();
  const inputDeployment = envelope.deployment as { allocations: { id: string; recipient: Hex; amountBaseUnits: string }[] };
  const inputReserve = envelope.reserveGenesis as { allocations: { id: string; recipient: Hex; amountBaseUnits: string }[] };
  const sender = `0x${"5".repeat(40)}` as Hex;
  const addresses = ["10", "11", "12"].map(nonce => deploymentCreateAddress(sender, nonce));
  for (const allocations of [inputDeployment.allocations, inputReserve.allocations]) {
    allocations.find(allocation => allocation.id === "founder")!.recipient = addresses[1]!;
    allocations.find(allocation => allocation.id === "contributors")!.recipient = addresses[2]!;
  }
  const validated = validateProductionDeployment(envelope);
  assert.ok(validated.value, validated.diagnostics.map(diagnostic => diagnostic.code).join(","));
  const deployment = validated.value.deployment;
  const reserve = validated.value.reserveGenesis;
  const artifacts = (["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"] as const).map(contract => ({ contract, ...sourceArtifact(contract, contract === incompleteImmutableContract) }));
  const pins = artifacts.map(({ contract, artifact, build }) => ({ contract, artifactPath: `${contract.toLowerCase()}.artifact.json`, artifactSha256: hash(bytes(artifact)), buildInfoPath: `${contract.toLowerCase()}.build-info.json`, buildInfoSha256: hash(bytes(build)) }));
  const normalizedAllocations = deployment.allocations.map(allocation => ({
    id: allocation.id,
    idBytes32: encodeAllocationId(allocation.id)!,
    recipient: allocation.recipient as Hex,
    amountBaseUnits: allocation.amountBaseUnits,
    ...(allocation.bps === undefined ? {} : { bps: allocation.bps }),
  }));
  const tokenInitcode = `0x6001${encodeDeploymentToken(deployment as never, normalizedAllocations).constructorArgs.slice(2)}` as Hex;
  const founderInitcode = `0x6001${encodeProductionFounderReserve({ token: addresses[0]!, beneficiary: reserve.founder.beneficiary as Hex, controller: reserve.founder.controller as Hex, allocation: reserve.allocations.find(allocation => allocation.id === "founder")!.amountBaseUnits, start: reserve.founder.schedule.start, cliff: reserve.founder.schedule.cliff, end: reserve.founder.schedule.end, purpose: reserve.founder.purpose as Hex }).slice(2)}` as Hex;
  const controllerInitcode = `0x6001${encodeProductionReserveController(addresses[0]!, reserve.contributors.controller as Hex, reserve.contributors.purpose as Hex, reserve.contributors.rollingCapBaseUnits, reserve.contributors.perGrantCapBaseUnits).slice(2)}` as Hex;
  const configurationSha256 = hash(encode.encode(canonicalJson(deployment as unknown as JsonValue)));
  const reserveConfigurationSha256 = hash(encode.encode(canonicalJson(reserve as unknown as JsonValue)));
  const artifactPinsSha256 = hash(encode.encode(canonicalJson({ schema: "agtmai-production-artifact-pins-v1", sourceRevision, artifacts: artifacts.map(({ contract, artifact, build, references }) => ({ contract, compilerVersion: "0.8.36", creationBytecode: "0x6001", runtimeBytecode: (artifact.deployedBytecode as { object: Hex }).object, artifactSha256: hash(bytes(artifact)), buildInfoSha256: hash(bytes(build)), compilerInputSha256: hash(bytes(build.input)), immutableReferences: references })).toSorted((left, right) => left.contract.localeCompare(right.contract)) } as unknown as JsonValue)));
  const gas = { gasEstimate: "100", gasLimit: "115", baseFeePerGas: "1", maxPriorityFeePerGas: "1", maxFeePerGas: "2", blockGasLimit: "10000000", value: "0" } as const;
  const calldata = `0x${keccakBytes(encode.encode("fund()")).slice(2, 10)}` as Hex;
  const runtime = (contract: keyof typeof immutableNamesByContract): Hex => (artifacts.find(artifact => artifact.contract === contract)!.artifact.deployedBytecode as { object: Hex }).object;
  const operations = [
    { id: "token-create", kind: "create" as const, nonce: "10", expectedAddress: addresses[0]!, initcode: tokenInitcode, initcodeHash: keccakBytes(hex(tokenInitcode)), runtime: runtime("AGTMAICCIPToken"), runtimeHash: keccakBytes(hex(runtime("AGTMAICCIPToken"))), ...gas },
    { id: "founder-reserve-create", kind: "create" as const, nonce: "11", expectedAddress: addresses[1]!, nestedAddress: deploymentCreateAddress(addresses[1]!, "1"), initcode: founderInitcode, initcodeHash: keccakBytes(hex(founderInitcode)), runtime: runtime("FounderGrantReserve"), runtimeHash: keccakBytes(hex(runtime("FounderGrantReserve"))), ...gas },
    { id: "controller-create", kind: "create" as const, nonce: "12", expectedAddress: addresses[2]!, initcode: controllerInitcode, initcodeHash: keccakBytes(hex(controllerInitcode)), runtime: runtime("ReserveController"), runtimeHash: keccakBytes(hex(runtime("ReserveController"))), ...gas },
    { id: "founder-fund", kind: "call" as const, nonce: "13", expectedAddress: addresses[1]!, calldata, ...gas },
  ];
  const intents = operations.map(operation => keccakBytes(encode.encode(canonicalJson({ domain: "AGTMAI_PRODUCTION_OPERATION_INTENT_V1", chainId: "1", sender, nonce: operation.nonce, kind: operation.kind, target: operation.expectedAddress, createBytes: operation.kind === "create" ? operation.initcode : "0x", value: operation.value, calldata: operation.kind === "call" ? operation.calldata : "0x" } as unknown as JsonValue))));
  const expectations = { schema: "agtmai-production-expectations-v1", chainId: "1", sourceRevision, configurationSha256, reserveConfigurationSha256, artifactPinsSha256, attemptIdentity: keccakBytes(encode.encode(canonicalJson({ domain: "AGTMAI_PRODUCTION_ATTEMPT_V1", chainId: "1", sender, startingNonce: "10", intents } as unknown as JsonValue))), sender, deployer: sender, startingNonce: "10", maxObservationAgeSeconds: "300", maxTotalCostWei: "100000000000000000", authority: deployment.custodySafes.map((safe, index) => ({ address: safe.address, owners: safe.owners, threshold: 2, nonce: "0", proxyCodeHash: hash(encode.encode(`proxy-${index}`)), singletonCodeHash: hash(encode.encode(`singleton-${index}`)), singletonAddress: `0x${String(index + 4).repeat(40)}`, singletonSlot: hash(encode.encode(`slot-${index}`)), modules: [], guard: null, fallbackHandler: null, setupProvenance: hash(encode.encode(`setup-${index}`)) })), operations: operations.map((operation, index) => ({ ...operation, intentHash: intents[index]! })) };
  const config = join(directory, "production.json"), artifactPins = join(directory, "artifact-pins.json"), approval = join(directory, "approval.json"), expectationPath = join(directory, "expectations.json");
  await Promise.all(artifacts.flatMap(({ contract, artifact, build }) => [writeFile(join(directory, `${contract.toLowerCase()}.artifact.json`), bytes(artifact)), writeFile(join(directory, `${contract.toLowerCase()}.build-info.json`), bytes(build))]));
  await Promise.all([writeFile(config, bytes(envelope)), writeFile(artifactPins, bytes({ schema: "agtmai-production-artifact-pins-v1", sourceRevision, artifacts: pins })), writeFile(approval, bytes({ schema: "agtmai-production-approval-v1", configurationSha256, reserveConfigurationSha256, reference: "synthetic-review" })), writeFile(expectationPath, bytes(expectations))]);
  return { config, artifacts: artifactPins, approval, expectations: expectationPath };
}

function hex(value: Hex): Uint8Array { return Uint8Array.from(value.slice(2).match(/../g) ?? [], byte => Number.parseInt(byte, 16)); }

async function replaceInventory(directory: string): Promise<void> {
  const files = (await readdir(directory)).filter(name => name !== "inventory.json").toSorted();
  await writeFile(join(directory, "inventory.json"), bytes({ schema: "agtmai-delivery-inventory-v1", files: await Promise.all(files.map(async name => ({ name, sha256: hash(await readFile(join(directory, name))), bytes: (await stat(join(directory, name))).size }))) }));
}

test("production package reconstruction rejects authenticated tampering and inventory drift", async context => {
  const parent = resolve("../../../.local/production-package-tests"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-")); context.after(() => rm(root, { recursive: true, force: true }));
  const inputs = await writeProductionInputs(root);
  const compile = async (name: string): Promise<string> => {
    const output = join(root, name);
    const result = run(["compile-production", "--config", inputs.config, "--artifacts", inputs.artifacts, "--approval", inputs.approval, "--expectations", inputs.expectations, "--output", output]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    await loadPreparedProductionPackage(output);
    return output;
  };
  const tampering: readonly [string, (directory: string) => Promise<void>][] = [
    ["canonical-production-configuration.json", async directory => { const value = JSON.parse(await readFile(join(directory, "canonical-production-configuration.json"), "utf8")); value.deployment.policy.evmMaxFeePerGasWei = "3"; await writeFile(join(directory, "canonical-production-configuration.json"), bytes(value)); }],
    ["agtmaicciptoken.artifact.json", async directory => { const value = JSON.parse(await readFile(join(directory, "agtmaicciptoken.artifact.json"), "utf8")); value.bytecode.object = "0x6002"; await writeFile(join(directory, "agtmaicciptoken.artifact.json"), bytes(value)); }],
    ["production-approval.json", async directory => { const value = JSON.parse(await readFile(join(directory, "production-approval.json"), "utf8")); value.reference = "tampered-review"; await writeFile(join(directory, "production-approval.json"), bytes(value)); }],
    ["production-expectations.json", async directory => { const value = JSON.parse(await readFile(join(directory, "production-expectations.json"), "utf8")); value.maxTotalCostWei = "999"; await writeFile(join(directory, "production-expectations.json"), bytes(value)); }],
  ];
  for (const [name, mutate] of tampering) {
    const output = await compile(`tamper-${name}`); await mutate(output); await replaceInventory(output);
    await assert.rejects(loadPreparedProductionPackage(output), /DEPLOYMENT_(ARTIFACT_PINS_INVALID|PRODUCTION_RECONSTRUCTION|PRODUCTION_PREPARED_MISMATCH)/, name);
  }
  const extra = await compile("extra"); await writeFile(join(extra, "unexpected.json"), bytes({ synthetic: true })); await replaceInventory(extra);
  await assert.rejects(loadPreparedProductionPackage(extra), /DEPLOYMENT_PRODUCTION_PACKAGE_INVENTORY/);
  const missing = await compile("missing"); await unlink(join(missing, "production-approval.json")); await replaceInventory(missing);
  await assert.rejects(loadPreparedProductionPackage(missing), /DEPLOYMENT_PRODUCTION_PACKAGE_INVENTORY/);
});

test("production artifact authentication requires every expected immutable name", async context => {
  const parent = resolve("../../../.local/production-package-tests"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "immutable-names-")); context.after(() => rm(root, { recursive: true, force: true }));
  for (const contract of Object.keys(immutableNamesByContract) as (keyof typeof immutableNamesByContract)[]) {
    const inputRoot = join(root, contract); await mkdir(inputRoot);
    const inputs = await writeProductionInputs(inputRoot, contract);
    const result = run(["compile-production", "--config", inputs.config, "--artifacts", inputs.artifacts, "--approval", inputs.approval, "--expectations", inputs.expectations, "--output", join(root, `${contract}-output`)]);
    assert.notEqual(result.status, 0, contract);
    assert.match(result.stdout + result.stderr, /DEPLOYMENT_ARTIFACT_PINS_INVALID/, contract);
  }
});
