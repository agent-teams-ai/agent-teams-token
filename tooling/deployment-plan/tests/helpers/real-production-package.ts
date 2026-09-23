import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { deploymentBytes, prepareProductionDeployment, validateProductionDeployment, type Hex } from "@agent-teams/supply/deployment";
import { canonicalJson, encodeAllocationId, sha256 } from "@agent-teams/supply/genesis-manifest";
import { productionCompilerPorts, publishDeploymentFiles, readProductionArtifactPins } from "@agent-teams/supply/deployment-files";

const SOURCE_REVISION = "dfe89da4c77a186aefbaead50981a327317f3bc4";
const contracts = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"] as const;
const encode = new TextEncoder();
const hex = (value: Hex): Uint8Array => Uint8Array.from(value.slice(2).match(/../g) ?? [], byte => Number.parseInt(byte, 16));
const hashValue = (value: unknown): Hex => sha256(deploymentBytes(value));

const makeSafe = (id: string, address: string, owners: string[]) => ({ id, address, owners, threshold: 2, beneficialControl: "solo-founder", disclosure: "Synthetic test-only Safe identity." });
function syntheticProductionEnvelope(): Record<string, unknown> {
  const shares = [3000, 3000, 300, 1700, 900, 500, 500, 100];
  const ids = ["long-term", "users", "founder", "contributors", "operations", "ecosystem", "financing", "liquidity"];
  const allocations = shares.map((bps, index) => ({ id: ids[index], recipient: `0x${String(index + 1).padStart(40, "0")}`, amountBaseUnits: String(BigInt(bps) * 10_000_000_000_000n), bps }));
  const paused = { enabled: true, capacity: "0", rate: "0" }, evm = "0x1111111111111111111111111111111111111111", solana = "11111111111111111111111111111111";
  const deployment = { schemaVersion: 1, deploymentId: "synthetic-production-envelope", status: "accepted", environment: { mode: "mainnet-dry-run", evmChainId: "1", solanaGenesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", evmSelector: "5009297550715157269", solanaSelector: "124615329519749607" }, token: { name: "Agent Teams AI", symbol: "AGTMAI", decimals: 9, initialSupplyBaseUnits: "100000000000000000", initialCCIPAdmin: `0x${"b".repeat(40)}` }, allocations, grants: [], custodySafes: [makeSafe("project-controller", `0x${"b".repeat(40)}`, [`0x${"c".repeat(40)}`, `0x${"d".repeat(40)}`, `0x${"e".repeat(40)}`]), makeSafe("founder-beneficiary", `0x${"a".repeat(40)}`, [`0x${"f".repeat(40)}`, `0x${"1".repeat(39)}2`, `0x${"1".repeat(39)}3`])], roleAliases: [{ address: `0x${"b".repeat(40)}`, roles: ["safe.project-controller.address", "token.initialCCIPAdmin"] }], bridge: { protocol: { reference: "synthetic-test-only", snapshotSha256: `0x${"1".repeat(64)}`, networkDataSha256: `0x${"2".repeat(64)}` }, ethereum: { token: null, pool: null, router: evm, rmn: evm, registry: evm, registryModule: evm, registryAdministrator: evm, poolOwner: evm, rateLimitAdministrator: evm, rebalancer: null, inbound: paused, outbound: paused }, solana: { mint: null, pool: null, poolSigner: null, poolTokenAccount: null, lookupTable: null, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", router: solana, offRamp: solana, rmn: solana, feeQuoter: solana, burnMintProgram: solana, poolAdministrator: solana, registryAdministrator: solana, upgradeAuthority: null, inbound: paused, outbound: paused } }, testScenario: null, policy: { tokenExpenditureCeilingBaseUnits: "3000000000000000", evmMaxFeePerGasWei: "10000000000", evmMaxPriorityFeePerGasWei: "1000000000", evmMaxGasPerTransaction: "6000000", evmMaxTotalFeeWei: "300000000000000000", solanaMaxFeeLamports: "100000", solanaMaxTotalFeeLamports: "1000000", observationMaxAgeSeconds: "300", executionDeadline: "2000000000", fundingDeadline: "1799999940", fundingLeadSeconds: "60", estimateValiditySeconds: "300", gasBufferBps: 1500 } };
  return { schema: "agtmai-production-deployment-v1", deployment, reserveGenesis: { schema: "agtmai-reserve-genesis-v1", status: "accepted", initialSupplyBaseUnits: "100000000000000000", allocations, founder: { beneficiary: `0x${"a".repeat(40)}`, controller: `0x${"b".repeat(40)}`, purpose: `0x${"3".repeat(64)}`, schedule: { profile: "calendar-12-48", start: "1800000000", cliff: "1831536000", end: "1926230400" } }, contributors: { controller: `0x${"b".repeat(40)}`, purpose: `0x${"4".repeat(64)}`, rollingCapBaseUnits: "16000000000000000", perGrantCapBaseUnits: "5000000000000000" } }, projectControllerSafeId: "project-controller", founderBeneficiarySafeId: "founder-beneficiary" };
}

export interface RealProductionPackage {
  readonly preparedDirectory: string;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly expectations: Uint8Array;
  readonly attempt: Uint8Array;
}

/** Test-only producer for the authenticated package consumed by the proof. */
export async function createRealProductionPackage(repositoryRoot: string, preparedDirectory: string, sender: Hex): Promise<RealProductionPackage> {
  const directory = dirname(preparedDirectory);
  const buildRoot = join(directory, "forge");
  const forge = resolve(repositoryRoot, ".tools/foundry-v1.8.0-linux-x64/forge");
  const solc = resolve(repositoryRoot, ".tools/solc-v0.8.36-linux-x64/solc");
  const result = spawnSync(forge, ["build", ...contracts.map(contract => contract === "AGTMAICCIPToken" ? "src/features/token-genesis/AGTMAICCIPToken.sol" : `src/features/contributor-grants/${contract}.sol`), "--offline", "--no-auto-detect", "--out", join(buildRoot, "out"), "--build-info", "--build-info-path", join(buildRoot, "build-info"), "--cache-path", join(buildRoot, "cache"), "--use", solc], { cwd: resolve(repositoryRoot, "contracts/evm"), encoding: "utf8", env: {...process.env, HOME: directory} });
  assert.equal(result.status, 0, result.stderr);
  const buildInfoName = (await import("node:fs/promises")).readdir(join(buildRoot, "build-info")).then(names => names[0]);
  const buildInfo = await readFile(join(buildRoot, "build-info", (await buildInfoName)!));
  const inputs = join(directory, "inputs");
  await mkdir(inputs, { mode: 0o700 });
  const pins = [];
  for (const contract of contracts) {
    const artifact = await readFile(join(buildRoot, "out", `${contract}.sol`, `${contract}.json`));
    const artifactName = `${contract.toLowerCase()}.artifact.json`;
    const buildName = `${contract.toLowerCase()}.build-info.json`;
    await Promise.all([writeFile(join(inputs, artifactName), artifact, { mode: 0o600 }), writeFile(join(inputs, buildName), buildInfo, { mode: 0o600 })]);
    pins.push({ contract, artifactPath: artifactName, artifactSha256: sha256(artifact), buildInfoPath: buildName, buildInfoSha256: sha256(buildInfo) });
  }
  const pinPath = join(inputs, "pins.json");
  await writeFile(pinPath, deploymentBytes({ schema: "agtmai-production-artifact-pins-v1", sourceRevision: SOURCE_REVISION, artifacts: pins }), { mode: 0o600 });
  const loaded = await readProductionArtifactPins(pinPath);
  const envelope = syntheticProductionEnvelope();
  const startingNonce = "7";
  const addresses = [0n, 1n, 2n].map(offset => productionCompilerPorts.createAddress(sender, (BigInt(startingNonce) + offset).toString()));
  for (const allocationSet of [(envelope.deployment as { allocations: Record<string, unknown>[] }).allocations, (envelope.reserveGenesis as { allocations: Record<string, unknown>[] }).allocations]) {
    allocationSet.find(allocation => allocation.id === "founder")!.recipient = addresses[1];
    allocationSet.find(allocation => allocation.id === "contributors")!.recipient = addresses[2];
  }
  const validated = validateProductionDeployment(envelope);
  assert.ok(validated.value, validated.diagnostics.map(diagnostic => diagnostic.code).join(","));
  const deployment = validated.value.deployment, reserve = validated.value.reserveGenesis;
  const normalized = deployment.allocations.map(allocation => ({ id: allocation.id, idBytes32: encodeAllocationId(allocation.id)!, recipient: allocation.recipient as Hex, amountBaseUnits: allocation.amountBaseUnits, ...(allocation.bps === undefined ? {} : { bps: allocation.bps }) }));
  const artifact = (contract: typeof contracts[number]) => loaded.artifacts.find(item => item.contract === contract)!;
  const initcodes = [
    `${artifact("AGTMAICCIPToken").creationBytecode}${productionCompilerPorts.encodeToken(deployment, normalized).constructorArgs.slice(2)}` as Hex,
    `${artifact("FounderGrantReserve").creationBytecode}${productionCompilerPorts.encodeFounderReserve({ token: addresses[0]!, beneficiary: reserve.founder.beneficiary as Hex, controller: reserve.founder.controller as Hex, allocation: "3000000000000000", start: reserve.founder.schedule.start, cliff: reserve.founder.schedule.cliff, end: reserve.founder.schedule.end, purpose: reserve.founder.purpose as Hex }).slice(2)}` as Hex,
    `${artifact("ReserveController").creationBytecode}${productionCompilerPorts.encodeReserveController({ token: addresses[0]!, controller: reserve.contributors.controller as Hex, purpose: reserve.contributors.purpose as Hex, rollingCap: reserve.contributors.rollingCapBaseUnits, perGrantCap: reserve.contributors.perGrantCapBaseUnits }).slice(2)}` as Hex,
  ];
  const gas = { gasEstimate: "5000000", gasLimit: "5750000", baseFeePerGas: "1000000000", maxPriorityFeePerGas: "1000000000", maxFeePerGas: "2000000000", blockGasLimit: "30000000", value: "0" } as const;
  const fund = `0x${productionCompilerPorts.keccak256(encode.encode("fund()")).slice(2, 10)}` as Hex;
  const operationIds = ["token-create", "founder-reserve-create", "controller-create"] as const;
  const operations = contracts.map((contract, index) => ({ id: operationIds[index]!, kind: "create" as const, nonce: (BigInt(startingNonce) + BigInt(index)).toString(), expectedAddress: addresses[index]!, ...(index === 1 ? { nestedAddress: productionCompilerPorts.createAddress(addresses[1]!, "1") } : {}), initcode: initcodes[index]!, initcodeHash: productionCompilerPorts.keccak256(hex(initcodes[index]!)), runtime: artifact(contract).runtimeBytecode, runtimeHash: productionCompilerPorts.keccak256(hex(artifact(contract).runtimeBytecode)), ...gas }));
  const allOperations = [...operations, { id: "founder-fund" as const, kind: "call" as const, nonce: (BigInt(startingNonce) + 3n).toString(), expectedAddress: addresses[1]!, calldata: fund, ...gas }];
  const intents = allOperations.map(operation => productionCompilerPorts.keccak256(encode.encode(canonicalJson({ domain: "AGTMAI_PRODUCTION_OPERATION_INTENT_V1", chainId: "1", sender, nonce: operation.nonce, kind: operation.kind, target: operation.expectedAddress, createBytes: operation.kind === "create" ? operation.initcode : "0x", value: operation.value, calldata: operation.kind === "call" ? operation.calldata : "0x" } as never))));
  const configurationSha256 = hashValue(deployment), reserveConfigurationSha256 = hashValue(reserve);
  const canonicalArtifacts = loaded.artifacts.toSorted((left, right) => left.contract.localeCompare(right.contract));
  const artifactPinsSha256 = hashValue({ schema: "agtmai-production-artifact-pins-v1", sourceRevision: SOURCE_REVISION, artifacts: canonicalArtifacts });
  const authority = deployment.custodySafes.map((safe, index) => ({ address: safe.address, owners: safe.owners, threshold: 2 as const, nonce: "0", proxyCodeHash: hashValue(`proxy-${index}`), singletonCodeHash: hashValue(`singleton-${index}`), singletonAddress: `0x${String(index + 4).repeat(40)}` as Hex, singletonSlot: hashValue(`slot-${index}`), modules: [], guard: null, fallbackHandler: null, setupProvenance: hashValue(`setup-${index}`) }));
  const expectations = { schema: "agtmai-production-expectations-v1" as const, chainId: "1" as const, sourceRevision: SOURCE_REVISION, configurationSha256, reserveConfigurationSha256, artifactPinsSha256, attemptIdentity: productionCompilerPorts.keccak256(encode.encode(canonicalJson({ domain: "AGTMAI_PRODUCTION_ATTEMPT_V1", chainId: "1", sender, startingNonce, intents } as never))), sender, deployer: sender, startingNonce, maxObservationAgeSeconds: "300", maxTotalCostWei: "100000000000000000", authority, operations: allOperations.map((operation, index) => ({ ...operation, intentHash: intents[index]! })) };
  const approval = { schema: "agtmai-production-approval-v1" as const, configurationSha256, reserveConfigurationSha256, reference: "synthetic-local-proof" };
  const preparedResult = prepareProductionDeployment(envelope, { artifactSourceRevision: SOURCE_REVISION, artifacts: loaded.artifacts, approval, expectations }, productionCompilerPorts, sha256);
  assert.ok(preparedResult.prepared, preparedResult.diagnostics.map(diagnostic => diagnostic.code).join(","));
  const packagePins = { schema: "agtmai-production-artifact-pins-v1", sourceRevision: SOURCE_REVISION, artifacts: canonicalArtifacts.map(item => ({ contract: item.contract, artifactPath: `${item.contract.toLowerCase()}.artifact.json`, artifactSha256: item.artifactSha256, buildInfoPath: `${item.contract.toLowerCase()}.build-info.json`, buildInfoSha256: item.buildInfoSha256 })) };
  const files = { ...loaded.files, "canonical-production-configuration.json": deploymentBytes(envelope), "production-approval.json": deploymentBytes(approval), "production-artifact-pins.json": deploymentBytes(packagePins), "production-expectations.json": deploymentBytes(expectations), "prepared-production-deployment.json": deploymentBytes(preparedResult.prepared) };
  const expectationBytes = deploymentBytes(expectations);
  const attempt = deploymentBytes({ schema: "agtmai-production-attempt-state-v1", identity: expectations.attemptIdentity, states: expectations.operations.map(operation => ({ operationId: operation.id, state: "finalized-success", intent: operation.intentHash })) });
  await publishDeploymentFiles(preparedDirectory, files);
  return { preparedDirectory, files, expectations: expectationBytes, attempt };
}
