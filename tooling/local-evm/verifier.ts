import { basename, dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { atomicWrite, readRegularFile } from "./safe-fs.ts";
import { canonicalJson, keccak256, sha256, strip0x } from "./crypto.ts";
import { reconstructCreationInput } from "./constructor.ts";
import { assertConstructorInputs, constructorInputsFromManifest, readApprovedManifest } from "./manifest.ts";
import { APPROVED_ABI_SHA256, APPROVED_CONTRACT_ARTIFACT_SHA256, APPROVED_SOURCE_SHA256, asError, LocalEvmError, type ApprovedBuildProfile, type DeploymentReport, type EvidenceCheck, type VerificationEvidence, type VerificationInput } from "./model.ts";
import { assertPrivateRpcUrl, createRpcClient, type RpcClient } from "./rpc.ts";
import { assertPinnedSolcVersionOutput } from "./toolchain.ts";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const TRANSACTION = /^0x[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as const;
const ZERO_HASH = `0x${"0".repeat(64)}` as const;
const TOOL_KEYS = ["anvil", "cast", "forge", "node", "pnpm", "solc"] as const;
const CONTRACT_SOURCE = "src/features/token-genesis/AGTMAIToken.sol";
const CONTRACT_NAME = "AGTMAIToken";

export async function verifyLocalDeployment(input: VerificationInput, suppliedRpc?: RpcClient): Promise<VerificationEvidence> {
  const checks: EvidenceCheck[] = [];
  let transactionHash = `0x${"0".repeat(64)}` as `0x${string}`;
  try {
    assertVerificationInput(input);
    const rpc = suppliedRpc ?? createRpcClient(input.rpcUrl);
    const approved = await readApprovedManifest(input.manifestPath, input.readyPath, input.approvedArtifactSha256);
    checks.push(pass("approved-manifest"));
    const [buildBytes, artifactBytes, abiBytes, approvalBytes, constructorBytes, deploymentBytes] = await Promise.all([
      readAndMatch(input.buildInfoPath, input.expectedBuildInfoSha256, "BUILD_INFO"),
      readAndMatch(input.contractArtifactPath, input.expectedContractArtifactSha256, "CONTRACT_ARTIFACT"),
      readAndMatch(input.abiPath, input.expectedAbiSha256, "ABI"),
      readAndMatch(input.approvedBuildProfilePath, input.expectedApprovedBuildProfileSha256, "APPROVED_BUILD_PROFILE"),
      readAndMatch(input.constructorInputsPath, input.expectedConstructorInputsSha256, "CONSTRUCTOR_INPUTS"),
      readAndMatch(input.deploymentReportPath, input.expectedDeploymentReportSha256, "DEPLOYMENT_REPORT"),
    ]);
    checks.push(pass("explicit-input-digests"));
    const build = parseObject(buildBytes, "VERIFY_BUILD_INFO_JSON_INVALID");
    const artifact = parseObject(artifactBytes, "VERIFY_CONTRACT_ARTIFACT_JSON_INVALID");
    const abi = parseJson(abiBytes, "VERIFY_ABI_JSON_INVALID");
    const approval = parseObject(approvalBytes, "VERIFY_APPROVED_BUILD_PROFILE_JSON_INVALID") as unknown as ApprovedBuildProfile;
    const constructorInputs = parseJson(constructorBytes, "VERIFY_CONSTRUCTOR_INPUTS_JSON_INVALID");
    const deployment = parseObject(deploymentBytes, "VERIFY_DEPLOYMENT_REPORT_JSON_INVALID") as unknown as DeploymentReport;
    if (input.expectedContractArtifactSha256 !== approval.contractArtifactSha256
      || input.expectedAbiSha256 !== approval.abiSha256) {
      throw new LocalEvmError("VERIFY_BUILD_APPROVAL_MISMATCH", "explicit build inputs differ from the committed approval");
    }
    assertConstructorInputs(constructorInputs, approved.manifest);
    const manifestConstructorInputs = constructorInputsFromManifest(approved.manifest);
    assertDeploymentReport(deployment, input);
    transactionHash = deployment.transactionHash;
    checks.push(pass("constructor-inputs"), pass("deployment-report-integrity"));
    assertBuildProfile(build, artifact, abi, approval, abiBytes);
    const expectedCreationInput = reconstructCreationInput(build, artifact, manifestConstructorInputs);
    checks.push(pass("compiler-build-and-abi"));

    const chainId = BigInt(rpcString(await rpc.request("eth_chainId"), "VERIFY_RPC_CHAIN_ID_INVALID")).toString();
    if (chainId !== "31337") {throw new LocalEvmError("VERIFY_CHAIN_ID_MISMATCH", `expected chain 31337, received ${chainId}`);}
    checks.push(pass("chain-id", "31337", chainId));
    const code = rpcString(await rpc.request("eth_getCode", [input.targetAddress, "latest"]), "VERIFY_RPC_CODE_INVALID");
    if (!/^0x[0-9a-f]+$/.test(code) || code === "0x") {throw new LocalEvmError("VERIFY_TARGET_CODE_ABSENT", "target has no deployed code");}
    const reconstructed = reconstructRuntime(build, artifact, approved.manifest.token.initialSupplyBaseUnits, approved.manifest.genesisAllocationHash);
    if (code !== reconstructed) {throw new LocalEvmError("VERIFY_RUNTIME_IDENTITY_MISMATCH", "deployed runtime is not the compiler-aware reconstructed runtime");}
    checks.push(pass("code-presence"), pass("compiler-aware-runtime", keccak256(reconstructed), keccak256(code)));

    const name = decodeString(await call(rpc, input.targetAddress, "name()"));
    const symbol = decodeString(await call(rpc, input.targetAddress, "symbol()"));
    const decimals = decodeUint(await call(rpc, input.targetAddress, "decimals()"));
    const supply = decodeUint(await call(rpc, input.targetAddress, "totalSupply()"));
    const immutableSupply = decodeUint(await call(rpc, input.targetAddress, "INITIAL_SUPPLY()"));
    const commitment = normalizeWord(await call(rpc, input.targetAddress, "GENESIS_ALLOCATION_HASH()"));
    if (name !== approved.manifest.token.name) {throw new LocalEvmError("VERIFY_NAME_MISMATCH", "token name differs from approved manifest");}
    if (symbol !== approved.manifest.token.symbol) {throw new LocalEvmError("VERIFY_SYMBOL_MISMATCH", "token symbol differs from approved manifest");}
    if (decimals !== String(approved.manifest.token.decimals)) {throw new LocalEvmError("VERIFY_DECIMALS_MISMATCH", "token decimals differ from approved manifest");}
    if (supply !== approved.manifest.token.initialSupplyBaseUnits || immutableSupply !== supply) {throw new LocalEvmError("VERIFY_SUPPLY_MISMATCH", "token supply differs from manifest or immutable supply");}
    if (commitment !== approved.manifest.genesisAllocationHash) {throw new LocalEvmError("VERIFY_COMMITMENT_MISMATCH", "onchain allocation commitment differs from approved manifest");}
    checks.push(pass("token-identity"), pass("total-and-immutable-supply"), pass("genesis-commitment"));

    let aggregate = 0n;
    for (const allocation of approved.manifest.allocations) {
      const balance = decodeUint(rpcString(await rpc.request("eth_call", [{ to: input.targetAddress, data: `${selector("balanceOf(address)")}${strip0x(allocation.recipient).padStart(64, "0")}` }, "latest"]), "VERIFY_RPC_CALL_INVALID"));
      if (balance !== allocation.amountBaseUnits) {throw new LocalEvmError("VERIFY_ALLOCATION_BALANCE_MISMATCH", `balance for ${allocation.id} differs from approved manifest`);}
      aggregate += BigInt(balance);
    }
    if (aggregate.toString() !== supply) {throw new LocalEvmError("VERIFY_BALANCE_AGGREGATE_MISMATCH", "fixture balance aggregate differs from total supply");}
    checks.push(pass("every-fixture-balance"), pass("fixture-balance-aggregate"));
    const deployerBalance = decodeUint(rpcString(await rpc.request("eth_call", [{ to: input.targetAddress, data: `${selector("balanceOf(address)")}${strip0x(input.deployerAddress).padStart(64, "0")}` }, "latest"]), "VERIFY_RPC_CALL_INVALID"));
    if (deployerBalance !== "0") {throw new LocalEvmError("VERIFY_UNEXPLAINED_DEPLOYER_BALANCE", "deployer has an unexplained token balance");}
    await verifyDirectCreation(rpc, deployment, input, expectedCreationInput);
    checks.push(pass("zero-deployer-balance"), pass("rpc-proven-direct-creation"));
    return evidence(input, checks, { status: "passed", code: "OK", sourceDigest: approved.manifest.sourceSha256, transactionHash });
  } catch (cause) {
    const error = asError(cause);
    const diagnostic = safeDiagnosticCode(error.code);
    return evidence(undefined, [{ id: "verification-exit", status: "failed", diagnostic }], {
      status: "failed", code: diagnostic, sourceDigest: ZERO_HASH, transactionHash: ZERO_HASH,
    });
  }
}

export async function writeEvidence(input: VerificationInput, report: VerificationEvidence): Promise<{ directory: string; jsonPath: string; markdownPath: string; reportSha256: `0x${string}` }> {
  const reportBytes = Buffer.from(canonicalJson(report), "utf8");
  const digest = sha256(reportBytes);
  const directory = join(resolve(input.reportOutputRoot), strip0x(digest));
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const jsonPath = join(directory, "verification-report.v1.json");
  const markdownPath = join(directory, "verification-summary.md");
  await atomicWrite(jsonPath, reportBytes);
  const summary = `# AGTMAI local EVM verification\n\nStatus: ${report.exit.status}\n\nDiagnostic: ${report.exit.code}\n\nChain: local Anvil 31337\n\nClaims: ${report.claims.proven.length} proven; public networks, mainnet readiness, audit, production tokenomics and CCIP are not proven.\n`;
  await atomicWrite(markdownPath, Buffer.from(summary, "utf8"));
  return { directory, jsonPath, markdownPath, reportSha256: digest };
}

interface EvidenceOutcome {
  readonly status: "passed" | "failed";
  readonly code: string;
  readonly sourceDigest: string;
  readonly transactionHash: `0x${string}`;
}

function evidence(input: VerificationInput | undefined, checks: EvidenceCheck[], outcome: EvidenceOutcome): VerificationEvidence {
  const { status, code, sourceDigest, transactionHash } = outcome;
  const successfulInput = successfulEvidenceInput(input, status);
  const stable = {
    schemaVersion: 1,
    kind: "agtmai-local-evm-verification",
    claims: {
      proven: status === "passed" ? ["local-chain-identity", "compiler-aware-runtime-identity", "token-state", "fixture-balances", "zero-unexplained-deployer-balance"] : [],
      simulated: ["ephemeral-test-only-deployment"],
      deferred: ["production-genesis-approval", "public-network-deployment", "ccip-delivery"],
      notProven: ["audit", "mainnet-readiness", "approved-tokenomics", "investment-or-return-claims"],
    },
    inputs: evidenceInputs(successfulInput, sourceDigest),
    chain: { kind: "local-evm", chainId: "31337" },
    tools: successfulInput === undefined ? {} : successfulInput.toolVersions,
    checks,
    exit: { status, code },
  } as const;
  const normalized = {
    ...stable,
    inputs: Object.fromEntries(Object.entries(stable.inputs).filter(([key]) => key !== "deploymentReportSha256" && key !== "buildInfoSha256")),
    tools: successfulInput === undefined ? {} : normalizedToolVersions(successfulInput.toolVersions),
  };
  return {
    ...stable,
    normalizedEvidenceSha256: sha256(canonicalJson(normalized)),
    volatile: volatileEvidence(successfulInput, transactionHash),
  };
}

function successfulEvidenceInput(input: VerificationInput | undefined, status: EvidenceOutcome["status"]): VerificationInput | undefined {
  if (status === "failed") {return undefined;}
  if (input === undefined) {throw new LocalEvmError("LOCAL_EVM_INTERNAL_FAILURE", "passed evidence requires validated input");}
  return input;
}

function evidenceInputs(input: VerificationInput | undefined, sourceDigest: string): Record<string, string> {
  if (input === undefined) {
    return {
      sourceSha256: ZERO_HASH, localFixtureArtifactSha256: ZERO_HASH, buildInfoSha256: ZERO_HASH,
      contractArtifactSha256: ZERO_HASH, abiSha256: ZERO_HASH, approvedBuildProfileSha256: ZERO_HASH,
      constructorInputsSha256: ZERO_HASH, deploymentReportSha256: ZERO_HASH,
    };
  }
  return {
    sourceSha256: sourceDigest, localFixtureArtifactSha256: input.approvedArtifactSha256,
    buildInfoSha256: input.expectedBuildInfoSha256, contractArtifactSha256: input.expectedContractArtifactSha256,
    abiSha256: input.expectedAbiSha256, approvedBuildProfileSha256: input.expectedApprovedBuildProfileSha256,
    constructorInputsSha256: input.expectedConstructorInputsSha256, deploymentReportSha256: input.expectedDeploymentReportSha256,
  };
}

function volatileEvidence(input: VerificationInput | undefined, transactionHash: `0x${string}`): VerificationEvidence["volatile"] {
  if (input === undefined) {return { runId: "failed-input-redacted", targetAddress: ZERO_ADDRESS, deployerAddress: ZERO_ADDRESS, transactionHash: ZERO_HASH };}
  return { runId: input.runId, targetAddress: input.targetAddress, deployerAddress: input.deployerAddress, transactionHash };
}

async function readAndMatch(path: string, expected: string, label: string): Promise<Buffer> {
  const bytes = await readRegularFile(path, label);
  if (sha256(bytes) !== expected) {throw new LocalEvmError(`VERIFY_${label}_DIGEST_MISMATCH`, `${label} digest differs from its explicit expected digest`);}
  return bytes;
}

function assertVerificationInput(input: VerificationInput): void {
  if (!isRecord(input)) {throw new LocalEvmError("VERIFY_INPUT_SHAPE_INVALID", "verification input must be an object");}
  const pathKeys = ["manifestPath", "readyPath", "buildInfoPath", "contractArtifactPath", "abiPath", "approvedBuildProfilePath", "constructorInputsPath", "deploymentReportPath", "reportOutputRoot"] as const;
  for (const key of pathKeys) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0")) {
      throw new LocalEvmError("VERIFY_INPUT_PATH_INVALID", "verification input paths must be bounded strings");
    }
  }
  const digestKeys = ["approvedArtifactSha256", "expectedBuildInfoSha256", "expectedContractArtifactSha256", "expectedAbiSha256", "expectedApprovedBuildProfileSha256", "expectedConstructorInputsSha256", "expectedDeploymentReportSha256"] as const;
  if (digestKeys.some((key) => !HASH.test(input[key]))) {throw new LocalEvmError("VERIFY_INPUT_DIGEST_INVALID", "verification input digests must be canonical SHA-256 values");}
  if (typeof input.runId !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/u.test(input.runId)) {throw new LocalEvmError("VERIFY_RUN_ID_INVALID", "run ID must use a bounded canonical form");}
  normalizedToolVersions(input.toolVersions);
  assertPrivateRpcUrl(input.rpcUrl);
  if (!ADDRESS.test(input.targetAddress) || !ADDRESS.test(input.deployerAddress)) {throw new LocalEvmError("VERIFY_ADDRESS_INVALID", "target and deployer must be canonical lowercase addresses");}
  if (basename(input.buildInfoPath) === "latest" || basename(dirname(input.manifestPath)) === "latest" || basename(input.approvedBuildProfilePath) !== "approved-build-profile.v1.json") {throw new LocalEvmError("VERIFY_MUTABLE_LATEST_FORBIDDEN", "mutable or unapproved inputs are forbidden");}
}

function normalizedToolVersions(value: Readonly<Record<string, string>>): Record<string, string> {
  if (!isRecord(value) || !exactKeys(value, TOOL_KEYS)) {throw new LocalEvmError("VERIFY_TOOL_VERSIONS_INVALID", "tool versions must contain the exact approved tool set");}
  const raw = Object.fromEntries(TOOL_KEYS.map((key) => [key, value[key]])) as Record<(typeof TOOL_KEYS)[number], unknown>;
  if (Object.values(raw).some((item) => typeof item !== "string" || item.length === 0 || item.length > 160 || !/^[\x20-\x7e]+$/u.test(item))) {
    throw new LocalEvmError("VERIFY_TOOL_VERSIONS_INVALID", "tool versions must be bounded printable strings");
  }
  const node = /^v(24\.20\.0)$/u.exec(raw.node as string)?.[1];
  const pnpm = /^(11\.24\.0)$/u.exec(raw.pnpm as string)?.[1];
  const foundry = Object.fromEntries(["forge", "cast", "anvil"].map((name) => {
    const match = new RegExp(`^(?:${name} Version: )?(1\\.8\\.0)$`, "u").exec(raw[name as keyof typeof raw] as string);
    return [name, match?.[1]];
  })) as Record<string, string | undefined>;
  const solcLine = assertPinnedSolcVersionOutput(raw.solc as string);
  const solc = /^(Version: )?(0\.8\.36\+commit\.8a079791)\./u.exec(solcLine)?.[2];
  if (!node || !pnpm || !foundry.forge || !foundry.cast || !foundry.anvil || !solc) {
    throw new LocalEvmError("VERIFY_TOOL_VERSIONS_INVALID", "tool versions differ from the pinned toolchain");
  }
  return { node, pnpm, forge: foundry.forge, cast: foundry.cast, anvil: foundry.anvil, solc };
}

function safeDiagnosticCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,95}$/u.test(value) ? value : "LOCAL_EVM_INTERNAL_FAILURE";
}

function assertDeploymentReport(value: DeploymentReport, input: VerificationInput): void {
  const keys = ["buildInfoSha256", "chainId", "constructorInputsSha256", "contractArtifactSha256", "creationInputSha256", "deployerAddress", "factoryAddress", "localFixtureArtifactSha256", "schemaVersion", "targetAddress", "transactionHash"];
  if (!isRecord(value) || !exactKeys(value, keys) || value.schemaVersion !== 1 || value.chainId !== "31337"
    || value.targetAddress !== input.targetAddress || value.deployerAddress !== input.deployerAddress || value.factoryAddress !== null
    || !TRANSACTION.test(value.transactionHash) || value.localFixtureArtifactSha256 !== input.approvedArtifactSha256
    || value.buildInfoSha256 !== input.expectedBuildInfoSha256 || value.contractArtifactSha256 !== input.expectedContractArtifactSha256
    || value.constructorInputsSha256 !== input.expectedConstructorInputsSha256 || !/^0x[0-9a-f]{64}$/.test(value.creationInputSha256)) {
    throw new LocalEvmError("VERIFY_DEPLOYMENT_REPORT_MISMATCH", "deployment report does not match independently supplied facts");
  }
}

function assertBuildProfile(build: Record<string, unknown>, artifact: Record<string, unknown>, abi: unknown, approval: ApprovedBuildProfile, abiBytes: Uint8Array): void {
  const solcVersion = build.solcVersion;
  const input = asObject(build.input, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const sources = asObject(input.sources, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const approvedSource = asObject(sources[CONTRACT_SOURCE], "VERIFY_BUILD_SOURCE_MISSING");
  const settings = asObject(input.settings, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const optimizer = asObject(settings.optimizer, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const metadata = asObject(settings.metadata, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const output = asObject(build.output, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const contracts = asObject(output.contracts, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const sourceContracts = asObject(contracts[CONTRACT_SOURCE], "VERIFY_BUILD_CONTRACT_MISSING");
  const contract = asObject(sourceContracts[CONTRACT_NAME], "VERIFY_BUILD_CONTRACT_MISSING");
  const compiler = asObject(parseJsonBytes(contract.metadata, "VERIFY_BUILD_METADATA_INVALID"), "VERIFY_BUILD_METADATA_INVALID").compiler;
  if (solcVersion !== "0.8.36" || build.solcLongVersion !== "0.8.36" || input.version !== "0.8.36"
    || !isRecord(compiler) || compiler.version !== "0.8.36+commit.8a079791"
    || settings.evmVersion !== "paris" || optimizer.enabled !== true || optimizer.runs !== 200
    || metadata.bytecodeHash !== "ipfs" || metadata.appendCBOR !== true
    || typeof approvedSource.content !== "string" || sha256(approvedSource.content) !== approval.sourceSha256) {
    throw new LocalEvmError("VERIFY_BUILD_PROFILE_MISMATCH", "build-info does not use the pinned compiler profile");
  }
  if (canonicalAbi(artifact.abi) !== canonicalAbi(abi)) {
    throw new LocalEvmError("VERIFY_ARTIFACT_ABI_MISMATCH", "contract artifact identity or ABI differs from the explicit ABI");
  }
  assertApprovalShape(approval);
  assertApprovedImmutableReferences(build, approval);
  if (sha256(abiBytes) !== approval.abiSha256
    || approval.sourceSha256 !== APPROVED_SOURCE_SHA256
    || approval.contractArtifactSha256 !== APPROVED_CONTRACT_ARTIFACT_SHA256
    || approval.abiSha256 !== APPROVED_ABI_SHA256) {
    throw new LocalEvmError("VERIFY_BUILD_APPROVAL_MISMATCH", "build, artifact, or ABI is not the separately committed approved identity");
  }
}

function assertApprovedImmutableReferences(build: Record<string, unknown>, approval: ApprovedBuildProfile): void {
  const names = immutableNames(build);
  assertImmutableNames(names);
  const deployed = deployedBytecode(build);
  const references = asObject(deployed.immutableReferences, "VERIFY_RUNTIME_IMMUTABLE_REFERENCES_MISSING");
  const semantic: Record<string, unknown> = {};
  for (const [id, name] of names) {semantic[name] = references[id];}
  if (canonicalJson(semantic) !== canonicalJson(approval.immutableReferences)) {
    throw new LocalEvmError("VERIFY_BUILD_IMMUTABLE_REFERENCES_MISMATCH", "compiler immutable positions differ from the committed approval");
  }
}

export function reconstructRuntime(build: Record<string, unknown>, artifact: Record<string, unknown>, supply: string, commitment: string): `0x${string}` {
  const deployed = deployedBytecode(build);
  if (hasReferences(deployed.linkReferences)) {throw new LocalEvmError("VERIFY_RUNTIME_LINK_REFERENCES_UNSUPPORTED", "linked runtime cannot be proven by this verifier");}
  const object = deployed.object;
  if (typeof object !== "string" || !/^[0-9a-f]+$/.test(object)) {throw new LocalEvmError("VERIFY_RUNTIME_TEMPLATE_INVALID", "build-info deployed runtime is malformed");}
  const artifactDeployed = asObject(artifact.deployedBytecode, "VERIFY_ARTIFACT_RUNTIME_MISSING");
  if (artifactDeployed.object !== `0x${object}` && artifactDeployed.object !== object) {throw new LocalEvmError("VERIFY_ARTIFACT_BUILD_RUNTIME_MISMATCH", "artifact runtime differs from build-info runtime");}
  const names = immutableNames(build);
  assertImmutableNames(names);
  const references = asObject(deployed.immutableReferences, "VERIFY_RUNTIME_IMMUTABLE_REFERENCES_MISSING");
  const values: Record<string, string> = {};
  for (const [id, name] of names) {
    if (name === "INITIAL_SUPPLY") {values[id] = BigInt(supply).toString(16).padStart(64, "0");}
    if (name === "GENESIS_ALLOCATION_HASH") {values[id] = strip0x(commitment);}
  }
  if (Object.keys(values).length !== 2) {throw new LocalEvmError("VERIFY_RUNTIME_IMMUTABLE_MAPPING_INCOMPLETE", "build-info AST cannot identify every expected immutable");}
  const runtime = Buffer.from(object, "hex");
  const ranges: Array<{ start: number; end: number }> = [];
  assertExactReferenceSet(references, values);
  for (const [id, entries] of Object.entries(references)) {
    const value = values[id];
    if (!value || !Array.isArray(entries) || entries.length === 0) {throw new LocalEvmError("VERIFY_RUNTIME_IMMUTABLE_MAPPING_INCOMPLETE", "runtime contains an unknown or empty immutable reference");}
    for (const entry of entries) {
      const start = referenceStart(entry);
      const end = start + 32;
      assertReferenceBounds(start, end, runtime.length, ranges);
      ranges.push({ start, end });
      Buffer.from(value, "hex").copy(runtime, start);
    }
  }
  return `0x${runtime.toString("hex")}`;
}

function deployedBytecode(build: Record<string, unknown>): Record<string, unknown> {
  const output = asObject(build.output, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const contracts = asObject(output.contracts, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const sourceContracts = asObject(contracts[CONTRACT_SOURCE], "VERIFY_BUILD_CONTRACT_MISSING");
  const contract = asObject(sourceContracts[CONTRACT_NAME], "VERIFY_BUILD_CONTRACT_MISSING");
  const evm = asObject(contract.evm, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  return asObject(evm.deployedBytecode, "VERIFY_BUILD_INFO_SHAPE_INVALID");
}

function assertImmutableNames(names: ReadonlyMap<string, string>): void {
  const expected = ["GENESIS_ALLOCATION_HASH", "INITIAL_SUPPLY"];
  const actual = [...names.values()].toSorted();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new LocalEvmError("VERIFY_RUNTIME_IMMUTABLE_MAPPING_INCOMPLETE", "build-info AST immutable set is not exact");
  }
}

function assertExactReferenceSet(references: Record<string, unknown>, values: Record<string, string>): void {
  const referenceIds = Object.keys(references).toSorted();
  const exact = referenceIds.length === 2 && referenceIds.every((id) => id in values)
    && Object.keys(values).every((id) => id in references);
  if (!exact) {throw new LocalEvmError("VERIFY_RUNTIME_IMMUTABLE_REFERENCE_SET_INVALID", "runtime immutable reference set is not exact");}
}

function referenceStart(value: unknown): number {
  if (!isRecord(value) || !Number.isInteger(value.start) || value.length !== 32) {
    throw new LocalEvmError("VERIFY_RUNTIME_IMMUTABLE_REFERENCE_INVALID", "immutable reference is not a full compiler word");
  }
  return Number(value.start);
}

function assertReferenceBounds(start: number, end: number, runtimeLength: number, ranges: readonly { start: number; end: number }[]): void {
  const invalid = start < 0 || end > runtimeLength || ranges.some((range) => start < range.end && end > range.start);
  if (invalid) {throw new LocalEvmError("VERIFY_RUNTIME_IMMUTABLE_REFERENCE_BOUNDS_INVALID", "immutable references overlap or exceed runtime bounds");}
}

function immutableNames(build: Record<string, unknown>): Map<string, string> {
  const output = asObject(build.output, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const sources = asObject(output.sources, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const source = asObject(sources[CONTRACT_SOURCE], "VERIFY_BUILD_SOURCE_MISSING");
  const names = new Map<string, string>();
  walk(source.ast, (node) => {
    if (node.nodeType === "VariableDeclaration" && node.stateVariable === true && node.mutability === "immutable" && typeof node.id === "number" && typeof node.name === "string") {names.set(String(node.id), node.name);}
  });
  return names;
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) { for (const item of value) {walk(item, visit);} return; }
  if (!isRecord(value)) {return;}
  visit(value);
  for (const child of Object.values(value)) {walk(child, visit);}
}

function hasReferences(value: unknown): boolean {
  if (!isRecord(value)) {return false;}
  return Object.values(value).some((contracts) => isRecord(contracts) && Object.values(contracts).some((entries) => Array.isArray(entries) && entries.length > 0));
}

function canonicalAbi(value: unknown): string {
  if (!Array.isArray(value)) {throw new LocalEvmError("VERIFY_ARTIFACT_ABI_MISMATCH", "ABI must be a JSON array");}
  return `[${value.map((entry) => canonicalJson(entry)).toSorted().join(",")}]`;
}

function assertApprovalShape(value: ApprovedBuildProfile): void {
  const keys = ["abiSha256", "contractArtifactSha256", "contractName", "immutableReferences", "purpose", "schemaVersion", "settings", "solcVersion", "sourceName", "sourceSha256", "status"];
  if (!isRecord(value) || !exactKeys(value, keys) || value.schemaVersion !== 1
    || value.purpose !== "local-evm-verifier-build-approval" || value.status !== "test-only"
    || value.sourceName !== CONTRACT_SOURCE || value.contractName !== CONTRACT_NAME
    || value.solcVersion !== "0.8.36+commit.8a079791"
    || value.sourceSha256 !== APPROVED_SOURCE_SHA256
    || !isRecord(value.immutableReferences)
    || !exactKeys(value.immutableReferences, ["GENESIS_ALLOCATION_HASH", "INITIAL_SUPPLY"])
    || !isRecord(value.settings) || !exactKeys(value.settings, ["appendCbor", "evmVersion", "metadataBytecodeHash", "optimizerEnabled", "optimizerRuns"])
    || value.settings.evmVersion !== "paris" || value.settings.optimizerEnabled !== true || value.settings.optimizerRuns !== 200
    || value.settings.metadataBytecodeHash !== "ipfs" || value.settings.appendCbor !== true) {
    throw new LocalEvmError("VERIFY_BUILD_APPROVAL_SHAPE_INVALID", "approved build profile is not the pinned test-only profile");
  }
}

async function verifyDirectCreation(rpc: RpcClient, deployment: DeploymentReport, input: VerificationInput, expectedCreationInput: `0x${string}`): Promise<void> {
  const transaction = await rpc.request("eth_getTransactionByHash", [deployment.transactionHash]);
  const receipt = await rpc.request("eth_getTransactionReceipt", [deployment.transactionHash]);
  if (!isRecord(transaction) || typeof transaction.input !== "string" || transaction.input !== expectedCreationInput
    || sha256(expectedCreationInput) !== deployment.creationInputSha256) {
    throw new LocalEvmError("VERIFY_CREATION_INPUT_MISMATCH", "transaction creation input differs from exact build-info bytecode and manifest constructor arguments");
  }
  if (!isRecord(receipt)
    || String(transaction.from).toLowerCase() !== input.deployerAddress || transaction.to !== null
    || String(receipt.contractAddress).toLowerCase() !== input.targetAddress || receipt.to !== null
    || receipt.transactionHash !== deployment.transactionHash || BigInt(rpcString(receipt.status, "VERIFY_RECEIPT_STATUS_INVALID")) !== 1n) {
    throw new LocalEvmError("VERIFY_DIRECT_CREATION_MISMATCH", "RPC transaction/receipt do not prove direct deployer creation of the target");
  }
}

async function call(rpc: RpcClient, target: string, signature: string): Promise<string> {
  return rpcString(await rpc.request("eth_call", [{ to: target, data: selector(signature) }, "latest"]), "VERIFY_RPC_CALL_INVALID");
}
function selector(signature: string): string { return keccak256(signature).slice(0, 10); }
function normalizeWord(value: string): `0x${string}` {
  if (!/^0x[0-9a-f]{64}$/.test(value)) {throw new LocalEvmError("VERIFY_RPC_WORD_INVALID", "RPC did not return one canonical ABI word");}
  return value as `0x${string}`;
}
function decodeUint(value: string): string { return BigInt(normalizeWord(value)).toString(); }
function decodeString(value: string): string {
  if (!/^0x[0-9a-f]*$/.test(value) || value.length < 130) {throw new LocalEvmError("VERIFY_RPC_STRING_INVALID", "RPC returned malformed ABI string data");}
  const bytes = Buffer.from(strip0x(value), "hex");
  const offset = Number(BigInt(`0x${bytes.subarray(0, 32).toString("hex")}`));
  const length = Number(BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`));
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset + 32 + length > bytes.length) {throw new LocalEvmError("VERIFY_RPC_STRING_INVALID", "RPC returned out-of-bounds ABI string data");}
  return bytes.subarray(offset + 32, offset + 32 + length).toString("utf8");
}

function parseJson(bytes: Uint8Array, code: string): unknown { try { return JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new LocalEvmError(code, "invalid JSON"); } }
function parseJsonBytes(value: unknown, code: string): unknown { if (typeof value !== "string") {throw new LocalEvmError(code, "expected JSON text");} try { return JSON.parse(value); } catch { throw new LocalEvmError(code, "invalid JSON text"); } }
function parseObject(bytes: Uint8Array, code: string): Record<string, unknown> { return asObject(parseJson(bytes, code), code); }
function asObject(value: unknown, code: string): Record<string, unknown> { if (!isRecord(value)) {throw new LocalEvmError(code, "expected JSON object");} return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const actual = Object.keys(value).toSorted(); return actual.length === expected.length && actual.every((key, index) => key === [...expected].toSorted()[index]); }
function pass(id: string, expected?: string, actual?: string): EvidenceCheck { return { id, status: "passed", ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) }; }
function rpcString(value: unknown, code: string): string { if (typeof value !== "string") {throw new LocalEvmError(code, "RPC result must be a string");} return value; }
