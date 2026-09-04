import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { finishWithCleanup } from "./cleanup.ts";
import { canonicalJson, sha256, sha256HexBytes, strip0x } from "./crypto.ts";
import { reconstructCreationInput } from "./constructor.ts";
import { constructorInputsFromManifest, readApprovedManifest } from "./manifest.ts";
import { APPROVED_ABI_SHA256, APPROVED_CONTRACT_ARTIFACT_SHA256, APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256, LocalEvmError, type DeploymentReport, type VerificationInput } from "./model.ts";
import { checkedCommand, command, CommandExitError, CommandSpawnError, startOwnedAnvil, type OwnedAnvil } from "./process.ts";
import { createProvisionalRunDirectory, createRunLease, reclaimStaleRuns, registerRunAnvil, removeOwnedRunDirectory } from "./run-lease.ts";
import { bootstrapRpcRequest } from "./rpc.ts";
import {
  ensurePrivateDirectory,
  ensurePrivateDirectoryPath,
  publishInitialFile,
  readRegularFile,
} from "./safe-fs.ts";
import { assertPinnedSolcVersionOutput, pinnedSolc, type PinnedSolc } from "./toolchain.ts";

export interface RunnerOptions {
  readonly repositoryRoot: string;
  readonly reportsRoot?: string;
  readonly solcLifecycleHook?: (point: "after-authentication" | "before-forge", solc: PinnedSolc) => void | Promise<void>;
}

export async function runLocalEvm(options: RunnerOptions): Promise<Record<string, unknown>> {
  const suppliedRoot = resolvePath(options.repositoryRoot);
  const root = realpathSync(suppliedRoot);
  if (root !== suppliedRoot) {throw new LocalEvmError("LOCAL_EVM_REPOSITORY_PATH", "repository root must be supplied as its canonical real path");}
  const privateRoot = privateRunRoot(root);
  const reportsRoot = resolvePath(options.reportsRoot ?? join(root, ".local", "local-evm", "reports"));
  const canonicalTemporaryRoot = realpathSync(tmpdir());
  await ensurePrivateDirectoryPath(canonicalTemporaryRoot, privateRoot);
  await reclaimStaleRuns(privateRoot);
  await ensurePrivateDirectoryPath(root, reportsRoot);
  const runId = `${Date.now().toString(36)}-${randomBytes(12).toString("hex")}`;
  const runDirectory = await createProvisionalRunDirectory(privateRoot, runId);
  await ensurePrivateDirectory(runDirectory);
  await faultPause("after-run-directory-before-lease");
  await createRunLease(runDirectory);
  await publishProcessId(runDirectory, "runner.pid", process.pid);
  let anvil: OwnedAnvil | undefined;
  let solc: PinnedSolc | undefined;
  let interruptedSignal: NodeJS.Signals | undefined;
  const commandAbort = new AbortController();
  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedSignal = signal;
    commandAbort.abort();
    void anvil?.stop();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let primary: unknown;
  try {
    const solcCustody = join(runDirectory, "solc-custody");
    await ensurePrivateDirectory(solcCustody);
    solc = pinnedSolc(root, realpathSync(solcCustody));
    await options.solcLifecycleHook?.("after-authentication", solc);
    // macOS cannot execute through /dev/fd. Held-FD checks guard the canonical private path;
    // malicious same-UID mutation between the final check and exec remains outside the
    // native-no-replace process boundary and is not represented as race-free.
    const tools = await toolVersions(solc, commandAbort.signal);
    const walletResult = await checkedCommand("cast", ["wallet", "new", "--json"], { code: "LOCAL_EVM_WALLET_GENERATION_FAILED", signal: commandAbort.signal });
    const wallet = parseWallet(walletResult.stdout);
    const keyPath = join(runDirectory, "ephemeral-signing-key");
    await publishInitialFile(
      keyPath,
      Buffer.from(`${wallet.privateKey}\n`, "ascii"),
      0o600,
    );
    anvil = await startOwnedAnvil(
      "anvil",
      wallet.address,
      async (identity) => {
        if (process.env.AGTMAI_LOCAL_EVM_FAULT === "after-anvil-spawn-before-registration") {
          await faultPause("after-anvil-spawn-before-registration", {childIdentity: identity});
        }
        await registerRunAnvil(runDirectory, identity);
      },
    );
    await publishProcessId(runDirectory, "anvil.pid", anvil.pid);
    if (interruptedSignal) {throw new LocalEvmError("LOCAL_EVM_INTERRUPTED", `interrupted by ${interruptedSignal}`);}
    const chain = await bootstrapRpcRequest(anvil.rpcUrl, "eth_chainId", []);
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
    await options.solcLifecycleHook?.("before-forge", solc);
    solc.assertReady();
    try {
      await checkedForgeBuild("forge", [
        "build", "--out", forgeOutput,
        "--build-info", "--build-info-path", forgeBuildInfo, "--cache-path", forgeCache,
        "--use", solc.path,
      ], solc.path, { cwd: contractsRoot, code: "LOCAL_EVM_FORGE_BUILD_FAILED", signal: commandAbort.signal, timeoutMs: 60_000 });
    } finally {solc.assertReady();}
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
    const build = parseObject(buildInfoBytes.toString("utf8"), "LOCAL_EVM_BUILD_INFO_INVALID");
    const constructorInputs = constructorInputsFromManifest(approved.manifest);
    const constructorPath = join(runDirectory, "constructor-inputs.v1.json");
    const constructorBytes = Buffer.from(canonicalJson(constructorInputs), "utf8");
    await publishInitialFile(constructorPath, constructorBytes);
    const creationInput = reconstructCreationInput(build, artifact, constructorInputs);
    const key = (await readRegularFile(keyPath, "EPHEMERAL_KEY")).toString("ascii").trim();
    const send = await checkedCommand("cast", ["send", "--private-key", key, "--rpc-url", anvil.rpcUrl, "--json", "--create", creationInput], { code: "LOCAL_EVM_DEPLOY_FAILED", signal: commandAbort.signal });
    const receipt = parseObject(send.stdout, "LOCAL_EVM_DEPLOY_RECEIPT_INVALID");
    const targetAddress = canonicalAddress(receipt.contractAddress, "contract address");
    const transactionHash = canonicalHash(receipt.transactionHash, "transaction hash");
    const constructorInputsSha256 = sha256(constructorBytes);
    const deployment: DeploymentReport = {
      schemaVersion: 1, chainId: "31337", targetAddress, transactionHash, deployerAddress: wallet.address,
      factoryAddress: null, creationInputBytesSha256: sha256HexBytes(creationInput), localFixtureArtifactSha256: approvedDigest,
      buildInfoSha256, contractArtifactSha256, constructorInputsSha256,
    };
    const deploymentPath = join(runDirectory, "deployment-report.v1.json");
    const deploymentBytes = Buffer.from(canonicalJson(deployment), "utf8");
    await publishInitialFile(deploymentPath, deploymentBytes);
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
    await publishInitialFile(verificationInputPath, Buffer.from(canonicalJson(verificationInput), "utf8"));
    const verify = await command(process.execPath, [join(root, "tooling", "local-evm", "verify-cli.ts"), verificationInputPath], { cwd: root, signal: commandAbort.signal });
    const verifierOutput = parseLastJsonObject(verify.stdout);
    if (verify.exitCode !== 0 || verifierOutput.status !== "passed") {throw new LocalEvmError(String(verifierOutput.diagnostic ?? "LOCAL_EVM_VERIFICATION_FAILED"), "independent verifier rejected the deployment");}
    return {
      status: "passed", runId, baseArtifactSha256: approvedDigest, targetAddress, transactionHash,
      reportDirectory: verifierOutput.directory, reportSha256: verifierOutput.reportSha256,
      normalizedEvidenceSha256: verifierOutput.normalizedEvidenceSha256,
    };
  } catch (cause) {
    primary = cause;
    throw cause;
  } finally {
    await finalizeLocalRun({primary, interrupt, solc, anvil, runDirectory, interruptedSignal});
  }
}

async function finalizeLocalRun(state: {
  readonly primary: unknown;
  readonly interrupt: (signal: NodeJS.Signals) => void;
  readonly solc?: PinnedSolc;
  readonly anvil?: OwnedAnvil;
  readonly runDirectory: string;
  readonly interruptedSignal?: NodeJS.Signals;
}): Promise<void> {
  await finishWithCleanup(state.primary, [
    () => {process.removeListener("SIGINT", state.interrupt);},
    () => {process.removeListener("SIGTERM", state.interrupt);},
    () => state.solc?.close(),
    async () => await state.anvil?.stop(),
    async () => await removeOwnedRunDirectory(state.runDirectory),
    () => {
      if (state.interruptedSignal) {
        process.exitCode = state.interruptedSignal === "SIGINT" ? 130 : 143;
      }
    },
  ]);
}

async function publishProcessId(directory: string, name: "runner.pid" | "anvil.pid", pid: number): Promise<void> {
  await publishInitialFile(join(directory, name), Buffer.from(`${pid}\n`, "ascii"));
}

async function faultPause(point: string, details: Record<string, unknown> = {}): Promise<void> {
  if (process.env.AGTMAI_LOCAL_EVM_FAULT !== point) {return;}
  process.stdout.write(`${JSON.stringify({faultPoint: point, pid: process.pid, ...details})}\n`);
  await new Promise<void>((resolve) => {setTimeout(resolve, 2_147_483_647);});
}

export function privateRunRoot(repositoryRoot: string): string {
  const repositoryIdentity = strip0x(sha256(resolvePath(repositoryRoot))).slice(0, 32);
  // macOS exposes its temporary directory through /var, which is a stable
  // system symlink to /private/var. Canonicalize that trusted boundary once so
  // later path-substitution checks can remain fail-closed.
  return join(realpathSync(tmpdir()), "agtmai-local-evm", repositoryIdentity);
}

function assertApprovedBuild(artifact: string, abi: string, profile: string): void {
  const approved = artifact === APPROVED_CONTRACT_ARTIFACT_SHA256
    && abi === APPROVED_ABI_SHA256
    && profile === "0x1efe84db9573a50e5b465e69c4d95dda74f6ca303bbf52cbb0de2a21ffb998f8";
  if (!approved) {throw new LocalEvmError("LOCAL_EVM_BUILD_NOT_APPROVED", "token artifact, ABI, or build approval differs from the committed test-only pins");}
}
async function toolVersions(solc: PinnedSolc, signal: AbortSignal): Promise<Record<string, string>> {
  const commands: Record<string, readonly string[]> = { node: ["--version"], pnpm: ["--version"], forge: ["--version"], cast: ["--version"], anvil: ["--version"] };
  const versions: Record<string, string> = {};
  for (const [name, arguments_] of Object.entries(commands)) {
    const result = await checkedCommand(name === "node" ? process.execPath : name, arguments_, { code: "LOCAL_EVM_TOOL_VERSION_FAILED", signal });
    versions[name] = result.stdout.trim().split(/\r?\n/u)[0];
  }
  solc.assertReady();
  let solcVersion;
  try {
    solcVersion = await checkedSolcExecution(solc.path, ["--version"], { code: "LOCAL_EVM_SOLC_VERSION_FAILED", signal });
  } finally {solc.assertReady();}
  versions.solc = assertPinnedSolcVersionOutput(solcVersion.stdout);
  if (!versions.forge.includes("1.8.0") || !versions.cast.includes("1.8.0") || !versions.anvil.includes("1.8.0")) {throw new LocalEvmError("LOCAL_EVM_FOUNDRY_VERSION_MISMATCH", "forge, cast and anvil must all be pinned Foundry 1.8.0");}
  return versions;
}

export async function checkedSolcExecution(
  executable: string,
  arguments_: readonly string[],
  options: {readonly cwd?: string; readonly code: string; readonly signal: AbortSignal; readonly timeoutMs?: number},
): ReturnType<typeof checkedCommand> {
  try {
    return await checkedCommand(executable, arguments_, options);
  } catch (cause) {
    if (isSolcSpawnPermissionFailure(cause)) {
      throw new LocalEvmError("LOCAL_EVM_SOLC_EXECUTION_UNAVAILABLE", "authenticated solc custody does not permit executable mappings", {cause});
    }
    throw cause;
  }
}

export function isSolcSpawnPermissionFailure(cause: unknown): boolean {
  return cause instanceof CommandSpawnError && (cause.errnoCode === "EACCES" || cause.errnoCode === "EPERM");
}

export async function checkedForgeBuild(
  executable: string,
  arguments_: readonly string[],
  solcPath: string,
  options: {readonly cwd?: string; readonly code: string; readonly signal: AbortSignal; readonly timeoutMs?: number},
): ReturnType<typeof checkedCommand> {
  try {
    return await checkedCommand(executable, arguments_, options);
  } catch (cause) {
    if (isExactForgeSolcLaunchFailure(cause, executable, solcPath)) {
      throw new LocalEvmError("LOCAL_EVM_SOLC_EXECUTION_UNAVAILABLE", "authenticated solc custody does not permit executable mappings", {cause});
    }
    if (cause instanceof CommandExitError) {throw cause;}
    if (cause instanceof CommandSpawnError) {
      throw new LocalEvmError(options.code, "Forge build process could not be executed", {cause});
    }
    throw cause;
  }
}

function isExactForgeSolcLaunchFailure(cause: unknown, forgeExecutable: string, solcPath: string): boolean {
  if (!(cause instanceof CommandExitError) || cause.executable !== forgeExecutable) {return false;}
  const quotedPath = JSON.stringify(solcPath);
  const expected = new Set([
    `Error: ${quotedPath}: Permission denied (os error 13)`,
    `Error: ${quotedPath}: Operation not permitted (os error 1)`,
  ]);
  return cause.stderr.split(/\r?\n/u).some((line) => expected.has(line));
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
