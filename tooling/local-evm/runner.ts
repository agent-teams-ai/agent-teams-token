import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, sha256, strip0x } from "./crypto.ts";
import { constructorInputsFromManifest, readApprovedManifest } from "./manifest.ts";
import { APPROVED_ABI_SHA256, APPROVED_CONTRACT_ARTIFACT_SHA256, APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256, LocalEvmError, type DeploymentReport, type VerificationInput } from "./model.ts";
import { checkedCommand, command, startOwnedAnvil, type OwnedAnvil } from "./process.ts";
import { atomicWrite, ensurePrivateDirectory, readRegularFile } from "./safe-fs.ts";

interface RunnerOptions { readonly repositoryRoot: string; readonly reportsRoot?: string }

export async function runLocalEvm(options: RunnerOptions): Promise<Record<string, unknown>> {
  const root = resolve(options.repositoryRoot);
  const privateRoot = privateRunRoot(root);
  const reportsRoot = resolve(options.reportsRoot ?? join(root, ".local", "local-evm", "reports"));
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await chmod(privateRoot, 0o700);
  await ensurePrivateDirectory(privateRoot);
  await mkdir(reportsRoot, { recursive: true, mode: 0o700 });
  await chmod(reportsRoot, 0o700);
  await ensurePrivateDirectory(reportsRoot);
  const runId = `${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
  const runDirectory = await mkdtemp(join(privateRoot, `run-${runId}-`));
  await chmod(runDirectory, 0o700);
  await atomicWrite(join(runDirectory, "runner.pid"), Buffer.from(`${process.pid}\n`, "ascii"));
  let anvil: OwnedAnvil | undefined;
  let interruptedSignal: NodeJS.Signals | undefined;
  const commandAbort = new AbortController();
  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal;
    commandAbort.abort();
    void anvil?.stop();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const tools = await toolVersions(commandAbort.signal);
    const walletResult = await checkedCommand("cast", ["wallet", "new", "--json"], { code: "LOCAL_EVM_WALLET_GENERATION_FAILED", signal: commandAbort.signal });
    const wallet = parseWallet(walletResult.stdout);
    const keyPath = join(runDirectory, "ephemeral-signing-key");
    await atomicWrite(keyPath, Buffer.from(`${wallet.privateKey}\n`, "ascii"), 0o600);
    anvil = await startOwnedAnvil("anvil", wallet.address);
    await atomicWrite(join(runDirectory, "anvil.pid"), Buffer.from(`${anvil.pid}\n`, "ascii"));
    if (interruptedSignal) {throw new LocalEvmError("LOCAL_EVM_INTERRUPTED", `interrupted by ${interruptedSignal}`);}
    const chain = await rpc(anvil.rpcUrl, "eth_chainId", []);
    if (BigInt(chain).toString() !== "31337") {throw new LocalEvmError("LOCAL_EVM_CHAIN_ID_MISMATCH", "Anvil chain ID is not exactly 31337");}

    const compilerCli = join(root, "packages", "contexts", "supply", "dist", "features", "genesis-manifest", "composition", "cli.js");
    const fixtureSource = join(root, "config", "genesis", "local.fixture.yaml");
    const compiledRoot = join(runDirectory, "compiled-genesis");
    const compile = await checkedCommand(process.execPath, [compilerCli, "compile-local", fixtureSource, compiledRoot], {
      cwd: root,
      code: "LOCAL_EVM_MANIFEST_COMPILE_FAILED",
      signal: commandAbort.signal,
    });
    const compiled = parseLastJsonObject(compile.stdout);
    if (typeof compiled.directory !== "string" || typeof compiled.localFixtureArtifactSha256 !== "string") {throw new LocalEvmError("LOCAL_EVM_COMPILER_OUTPUT_INVALID", "compiler did not return an explicit artifact directory and digest");}
    const manifestPath = join(compiled.directory, "manifest.json");
    const readyPath = join(compiled.directory, "READY");
    const approvedDigest = compiled.localFixtureArtifactSha256 as `0x${string}`;
    if (approvedDigest !== APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256) {
      throw new LocalEvmError("LOCAL_EVM_COMPILED_FIXTURE_NOT_APPROVED", "compiled artifact differs from the separately pinned committed local fixture");
    }
    const approved = await readApprovedManifest(manifestPath, readyPath, approvedDigest);

    const contractsRoot = join(root, "contracts", "evm");
    const forgeOutput = join(runDirectory, "forge-out");
    const forgeBuildInfo = join(runDirectory, "forge-build-info");
    const forgeCache = join(runDirectory, "forge-cache");
    await checkedCommand("forge", [
      "build", "--out", forgeOutput,
      "--build-info", "--build-info-path", forgeBuildInfo, "--cache-path", forgeCache,
    ], { cwd: contractsRoot, code: "LOCAL_EVM_FORGE_BUILD_FAILED", signal: commandAbort.signal, timeoutMs: 60_000 });
    const artifactPath = join(forgeOutput, "AGTMAIToken.sol", "AGTMAIToken.json");
    const artifactBytes = await readRegularFile(artifactPath, "CONTRACT_ARTIFACT");
    const artifact = parseObject(artifactBytes.toString("utf8"), "LOCAL_EVM_CONTRACT_ARTIFACT_INVALID");
    const buildInfoNames = (await readdir(forgeBuildInfo)).filter((name) => /^[0-9a-f]+\.json$/u.test(name));
    if (buildInfoNames.length !== 1) {throw new LocalEvmError("LOCAL_EVM_BUILD_INFO_SELECTION_AMBIGUOUS", "forced token build must produce exactly one build-info file");}
    const buildInfoPath = join(forgeBuildInfo, buildInfoNames[0]!);
    const buildInfoBytes = await readRegularFile(buildInfoPath, "BUILD_INFO");
    const abiPath = join(root, "contracts", "evm", "abi", "AGTMAIToken.abi.json");
    const abiBytes = await readRegularFile(abiPath, "ABI");
    const approvedBuildProfilePath = join(root, "tooling", "local-evm", "approved-build-profile.v1.json");
    const approvedBuildProfileBytes = await readRegularFile(approvedBuildProfilePath, "APPROVED_BUILD_PROFILE");
    const buildInfoSha256 = sha256(buildInfoBytes);
    const contractArtifactSha256 = sha256(artifactBytes);
    const abiSha256 = sha256(abiBytes);
    assertApprovedBuild(contractArtifactSha256, abiSha256, sha256(approvedBuildProfileBytes));
    const artifactBytecode = artifact.bytecode;
    if (!isRecord(artifactBytecode) || typeof artifactBytecode.object !== "string" || !/^0x[0-9a-f]+$/u.test(artifactBytecode.object)) {throw new LocalEvmError("LOCAL_EVM_CREATION_BYTECODE_INVALID", "contract artifact has no canonical creation bytecode");}
    const constructorInputs = constructorInputsFromManifest(approved.manifest);
    const constructorPath = join(runDirectory, "constructor-inputs.v1.json");
    const constructorBytes = Buffer.from(canonicalJson(constructorInputs), "utf8");
    await atomicWrite(constructorPath, constructorBytes);
    const creationInput = `${artifactBytecode.object}${encodeConstructorArguments(constructorInputs).slice(2)}`;
    const key = (await readRegularFile(keyPath, "EPHEMERAL_KEY")).toString("ascii").trim();
    const send = await checkedCommand("cast", ["send", "--private-key", key, "--rpc-url", anvil.rpcUrl, "--json", "--create", creationInput], { code: "LOCAL_EVM_DEPLOY_FAILED", signal: commandAbort.signal });
    const receipt = parseObject(send.stdout, "LOCAL_EVM_DEPLOY_RECEIPT_INVALID");
    const targetAddress = canonicalAddress(receipt.contractAddress, "contract address");
    const transactionHash = canonicalHash(receipt.transactionHash, "transaction hash");
    const constructorInputsSha256 = sha256(constructorBytes);
    const deployment: DeploymentReport = {
      schemaVersion: 1, chainId: "31337", targetAddress, transactionHash, deployerAddress: wallet.address,
      factoryAddress: null, creationInputSha256: sha256(creationInput), localFixtureArtifactSha256: approvedDigest,
      buildInfoSha256, contractArtifactSha256, constructorInputsSha256,
    };
    const deploymentPath = join(runDirectory, "deployment-report.v1.json");
    const deploymentBytes = Buffer.from(canonicalJson(deployment), "utf8");
    await atomicWrite(deploymentPath, deploymentBytes);
    const verificationInput: VerificationInput = {
      rpcUrl: anvil.rpcUrl, manifestPath, readyPath, approvedArtifactSha256: approvedDigest,
      buildInfoPath, expectedBuildInfoSha256: buildInfoSha256,
      contractArtifactPath: artifactPath, expectedContractArtifactSha256: contractArtifactSha256,
      abiPath, expectedAbiSha256: abiSha256, constructorInputsPath: constructorPath,
      approvedBuildProfilePath, expectedApprovedBuildProfileSha256: sha256(approvedBuildProfileBytes),
      expectedConstructorInputsSha256: constructorInputsSha256, deploymentReportPath: deploymentPath,
      expectedDeploymentReportSha256: sha256(deploymentBytes), targetAddress, deployerAddress: wallet.address,
      toolVersions: tools, reportOutputRoot: reportsRoot, runId,
    };
    const verificationInputPath = join(runDirectory, "verification-input.v1.json");
    await atomicWrite(verificationInputPath, Buffer.from(canonicalJson(verificationInput), "utf8"));
    const verify = await command(process.execPath, [join(root, "tooling", "local-evm", "verify-cli.ts"), verificationInputPath], { cwd: root, signal: commandAbort.signal });
    const verifierOutput = parseLastJsonObject(verify.stdout);
    if (verify.exitCode !== 0 || verifierOutput.status !== "passed") {throw new LocalEvmError(String(verifierOutput.diagnostic ?? "LOCAL_EVM_VERIFICATION_FAILED"), "independent verifier rejected the deployment");}
    return {
      status: "passed", runId, baseArtifactSha256: approvedDigest, targetAddress, transactionHash,
      reportDirectory: verifierOutput.directory, reportSha256: verifierOutput.reportSha256,
      normalizedEvidenceSha256: verifierOutput.normalizedEvidenceSha256,
    };
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await anvil?.stop();
    await rm(runDirectory, { recursive: true, force: true });
    if (interruptedSignal) {process.exitCode = interruptedSignal === "SIGINT" ? 130 : 143;}
  }
}

export function privateRunRoot(repositoryRoot: string): string {
  const repositoryIdentity = strip0x(sha256(resolve(repositoryRoot))).slice(0, 32);
  // macOS exposes its temporary directory through /var, which is a stable
  // system symlink to /private/var. Canonicalize that trusted boundary once so
  // later path-substitution checks can remain fail-closed.
  return join(realpathSync(tmpdir()), "agtmai-local-evm", repositoryIdentity);
}

function encodeConstructorArguments(value: ReturnType<typeof constructorInputsFromManifest>): `0x${string}` {
  const words = [word(value.initialSupplyBaseUnits), word("64"), word(String(value.allocations.length))];
  for (const allocation of value.allocations) {words.push(strip0x(allocation.idBytes32), strip0x(allocation.recipient).padStart(64, "0"), word(allocation.amountBaseUnits));}
  return `0x${words.join("")}`;
}

function assertApprovedBuild(artifact: string, abi: string, profile: string): void {
  const approved = artifact === APPROVED_CONTRACT_ARTIFACT_SHA256
    && abi === APPROVED_ABI_SHA256
    && profile === "0x1efe84db9573a50e5b465e69c4d95dda74f6ca303bbf52cbb0de2a21ffb998f8";
  if (!approved) {throw new LocalEvmError("LOCAL_EVM_BUILD_NOT_APPROVED", "token artifact, ABI, or build approval differs from the committed test-only pins");}
}
function word(value: string): string { return BigInt(value).toString(16).padStart(64, "0"); }

async function toolVersions(signal: AbortSignal): Promise<Record<string, string>> {
  const commands: Record<string, readonly string[]> = { node: ["--version"], pnpm: ["--version"], forge: ["--version"], cast: ["--version"], anvil: ["--version"] };
  const versions: Record<string, string> = {};
  for (const [name, arguments_] of Object.entries(commands)) {
    const result = await checkedCommand(name === "node" ? process.execPath : name, arguments_, { code: "LOCAL_EVM_TOOL_VERSION_FAILED", signal });
    versions[name] = result.stdout.trim().split(/\r?\n/u)[0];
  }
  if (!versions.forge.includes("1.8.0") || !versions.cast.includes("1.8.0") || !versions.anvil.includes("1.8.0")) {throw new LocalEvmError("LOCAL_EVM_FOUNDRY_VERSION_MISMATCH", "forge, cast and anvil must all be pinned Foundry 1.8.0");}
  return versions;
}

function parseWallet(output: string): { address: `0x${string}`; privateKey: `0x${string}` } {
  const value = JSON.parse(output) as unknown;
  const wrapped = isRecord(value) && Array.isArray(value.data) ? value.data : value;
  const candidate = Array.isArray(wrapped) ? wrapped[0] : wrapped;
  if (!isRecord(candidate)) {throw new LocalEvmError("LOCAL_EVM_WALLET_OUTPUT_INVALID", "cast wallet output is malformed");}
  const address = canonicalAddress(candidate.address, "wallet address");
  const privateKeyValue = candidate.private_key ?? candidate.privateKey;
  const privateKey = canonicalHash(privateKeyValue, "ephemeral private key");
  return { address, privateKey };
}
function parseLastJsonObject(output: string): Record<string, unknown> {
  for (const line of output.trim().split(/\r?\n/u).toReversed()) { try { const value: unknown = JSON.parse(line); if (isRecord(value)) {return value;} } catch { /* continue */ } }
  throw new LocalEvmError("LOCAL_EVM_COMMAND_JSON_INVALID", "command did not emit a final JSON object");
}
function parseObject(text: string, code: string): Record<string, unknown> { try { const value: unknown = JSON.parse(text); if (isRecord(value)) {return value;} } catch { /* handled below */ } throw new LocalEvmError(code, "expected a JSON object"); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function canonicalAddress(value: unknown, label: string): `0x${string}` { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value)) {throw new LocalEvmError("LOCAL_EVM_ADDRESS_INVALID", `${label} is malformed`);} return value.toLowerCase() as `0x${string}`; }
function canonicalHash(value: unknown, label: string): `0x${string}` { if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {throw new LocalEvmError("LOCAL_EVM_HASH_INVALID", `${label} is malformed`);} return value.toLowerCase() as `0x${string}`; }
async function rpc(url: string, method: string, params: readonly unknown[]): Promise<string> { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(5_000) }); const value: unknown = await response.json(); if (!isRecord(value) || typeof value.result !== "string") {throw new LocalEvmError("LOCAL_EVM_RPC_INVALID", "local RPC returned an invalid response");} return value.result; }
