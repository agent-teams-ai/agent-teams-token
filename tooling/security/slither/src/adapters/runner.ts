import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProcessPort } from "../application/ports.ts";
import type { AnalysisInput, ClosureEntry, GateManifest, PolicyDecision, Suppression } from "../domain/model.ts";
import { SlitherGateError } from "../domain/model.ts";
import { sha256 } from "./fingerprint.ts";
import { parseDetectorInventory, parseSlitherJson } from "./slither-json.ts";
import { dockerRunArguments, IMAGE, IMAGE_REVISION } from "./container-contract.ts";
import { evaluatePolicy } from "../application/policy.ts";

interface ToolchainLock {
  readonly tools: {
    readonly foundry: { readonly platforms: Record<string, { readonly sha256: string }> };
    readonly solc: { readonly platforms: Record<string, { readonly sha256: string }> };
  };
}
interface ImageInspection {
  readonly RepoDigests?: readonly unknown[];
  readonly Os?: unknown;
  readonly Architecture?: unknown;
  readonly Config?: { readonly Labels?: Record<string, unknown>; readonly Env?: readonly unknown[] };
}
interface OfficialImageEnvironment { readonly imagePath: string; readonly pythonPath: string }
interface ForgeArtifact { readonly bytecode?: { readonly object?: unknown } }
interface BuildInfo {
  readonly solcVersion?: unknown;
  readonly input?: { readonly sources?: Record<string, unknown>; readonly settings?: { readonly evmVersion?: unknown; readonly optimizer?: { readonly enabled?: unknown; readonly runs?: unknown }; readonly metadata?: { readonly bytecodeHash?: unknown; readonly appendCBOR?: unknown; readonly useLiteralContent?: unknown }; readonly viaIR?: unknown; readonly experimental?: unknown; readonly remappings?: unknown; readonly libraries?: unknown } };
  readonly output?: { readonly contracts?: Record<string, Record<string, { readonly evm?: { readonly bytecode?: { readonly object?: unknown } } }>> };
}
export interface RunResult { readonly input: AnalysisInput; readonly decision: PolicyDecision; readonly manifest: GateManifest; readonly configHash: string; readonly policyHash: string }

export async function runGate(repositoryRoot: string, candidateSha: string, processPort: ProcessPort, forgePath: string, solcPath: string): Promise<RunResult> {
  const head = await processPort.run("/usr/bin/git", ["-C", repositoryRoot, "rev-parse", "HEAD"], 10_000);
  if (head.timedOut || head.exitCode !== 0 || head.stdout.trim() !== candidateSha) throw new SlitherGateError("CANDIDATE_SHA_MISMATCH", "candidate SHA does not equal the checked-out HEAD");
  const base = join(repositoryRoot, "tooling/security/slither");
  const manifest = JSON.parse(await readFile(join(base, "production-closure.v1.json"), "utf8")) as GateManifest;
  const suppressionDocument = JSON.parse(await readFile(join(base, "suppressions.v1.json"), "utf8")) as { schemaVersion: number; suppressions: Suppression[] };
  if (manifest.schemaVersion !== 1 || suppressionDocument.schemaVersion !== 1 || !Array.isArray(suppressionDocument.suppressions)) throw new SlitherGateError("POLICY_SHAPE_INVALID", "policy inputs are malformed");
  assertSuppressionShape(suppressionDocument.suppressions);
  const lock = JSON.parse(await readFile(join(repositoryRoot, "tooling/toolchain.lock.json"), "utf8")) as ToolchainLock;
  const foundryPin = lock.tools.foundry.platforms["linux-x64"]?.sha256; const solcPin = lock.tools.solc.platforms["linux-x64"]?.sha256;
  if (foundryPin !== manifest.tools.forgeArchiveSha256 || solcPin !== manifest.tools.solcBinarySha256) throw new SlitherGateError("TOOLCHAIN_LOCK_INVALID", "Linux project tool pins differ from the accepted prerequisite");
  const expectedForgePath = join(repositoryRoot, ".tools/foundry-v1.8.0-linux-x64/forge");
  const expectedSolcPath = join(repositoryRoot, ".tools/solc-v0.8.36-linux-x64/solc");
  if (forgePath !== expectedForgePath || await realpath(forgePath) !== forgePath) throw new SlitherGateError("FORGE_PIN_MISMATCH", "Forge must be the offline-installed project override");
  if (solcPath !== expectedSolcPath || await realpath(solcPath) !== solcPath) throw new SlitherGateError("SOLC_PIN_MISMATCH", "solc must be the offline-installed project override");
  await assertTool(forgePath, manifest.tools.forgeBinarySha256, "FORGE_PIN_MISMATCH");
  await assertTool(solcPath, manifest.tools.solcBinarySha256, "SOLC_PIN_MISMATCH");
  const forgeBinarySha256 = sha256(await readFile(forgePath)); const solcBinarySha256 = sha256(await readFile(solcPath));
  const imageEnvironment = await assertImage(processPort);

  const scratch = await mkdtemp(join(tmpdir(), "agtmai-slither-"));
  const containerName = basename(scratch);
  const inputDirectory = join(scratch, "input"); const rawOutput = join(scratch, "raw");
  await chmod(scratch, 0o755);
  await mkdir(inputDirectory, { mode: 0o755 }); await mkdir(rawOutput, { mode: 0o733 }); await chmod(rawOutput, 0o733);
  try {
    const productionClosure = [...manifest.sources, ...manifest.config];
    for (const entry of productionClosure) await copyPinned(repositoryRoot, inputDirectory, entry);
    const before = await closure(repositoryRoot, productionClosure);
    const result = await processPort.run("/usr/bin/docker", dockerRunArguments({ input: inputDirectory, output: rawOutput, forge: forgePath, solc: solcPath, containerName, ...imageEnvironment }), 600_000);
    if (result.timedOut) throw new SlitherGateError("CONTAINER_TIMEOUT", "container exceeded the bounded analysis timeout");
    if (result.exitCode !== 0) throw new SlitherGateError("CONTAINER_FAILED", "container analysis command failed");
    await verifyVersions(rawOutput);
    const after = await closure(repositoryRoot, productionClosure);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new SlitherGateError("INPUT_CLOSURE_MUTATED", "production closure changed during analysis");
    const parsed = await parseSlitherJson(await readFile(join(rawOutput, "slither.json"), "utf8"), repositoryRoot);
    const slitherExit = Number.parseInt((await readFile(join(rawOutput, "slither.exit"), "utf8")).trim(), 10);
    if (!Number.isSafeInteger(slitherExit) || slitherExit < 0 || slitherExit > 255) throw new SlitherGateError("SLITHER_EXIT_INVALID", "Slither exit status is missing or malformed");
    const detectorInventory = parseDetectorInventory(await readFile(join(rawOutput, "detectors.txt"), "utf8"));
    const compiled = await parseCompiledOutput(rawOutput);
    const input: AnalysisInput = {
      success: parsed.success, findings: parsed.findings, contracts: compiled.contracts, compiledSources: compiled.sources, closure: after,
      detectorInventory, compiler: compiled.compiler, creationBytecodeSha256: compiled.artifactBytecode,
      freshFoundryCreationBytecodeSha256: compiled.buildInfoBytecode,
      analysisErrors: slitherExit === 0 ? parsed.errors : [...parsed.errors, `slither-exit-${slitherExit}`],
      forgeBinarySha256, solcBinarySha256,
    };
    const decision = evaluatePolicy(input, manifest, suppressionDocument.suppressions);
    return { input, decision, manifest, configHash: sha256(await readFile(join(base, "slither.config.json"))), policyHash: sha256(await readFile(join(base, "suppressions.v1.json"))) };
  } finally {
    await processPort.run("/usr/bin/docker", ["rm", "--force", containerName], 30_000).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}

async function assertTool(path: string, expected: string, code: string): Promise<void> {
  await assertRegularTool(path, code);
  const actual = sha256(await readFile(path)); if (actual !== expected) throw new SlitherGateError(code, "tool override checksum mismatch");
}

async function assertRegularTool(path: string, code: string): Promise<void> {
  const info = await stat(path);
  if (!path.startsWith("/") || !info.isFile() || (await lstat(path)).isSymbolicLink() || (info.mode & 0o111) === 0) throw new SlitherGateError(code, "tool override must be an absolute executable regular file");
}

async function assertImage(port: ProcessPort): Promise<OfficialImageEnvironment> {
  const result = await port.run("/usr/bin/docker", ["image", "inspect", IMAGE, "--format", "{{json .}}"], 30_000);
  if (result.exitCode !== 0 || result.timedOut) throw new SlitherGateError("IMAGE_UNAVAILABLE", "exact pinned image is unavailable locally");
  let image: ImageInspection; try { image = JSON.parse(result.stdout) as ImageInspection; } catch { throw new SlitherGateError("IMAGE_METADATA_INVALID", "image inspection output is malformed"); }
  const digests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
  const revision = image.Config?.Labels?.["org.opencontainers.image.revision"];
  if (image.Os !== "linux" || image.Architecture !== "amd64" || !digests.some((value: unknown) => typeof value === "string" && value.endsWith("@sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0")) || revision !== IMAGE_REVISION) {
    throw new SlitherGateError("IMAGE_PIN_MISMATCH", "image digest, platform or revision mismatch");
  }
  const environment = Array.isArray(image.Config?.Env) ? image.Config.Env.filter((value): value is string => typeof value === "string") : [];
  const imagePath = environment.find((value) => value.startsWith("PATH="))?.slice(5);
  const pythonPath = environment.find((value) => value.startsWith("PYTHONPATH="))?.slice(11);
  if (!imagePath || !pythonPath || !safePathList(imagePath) || !safePathList(pythonPath)) throw new SlitherGateError("IMAGE_ENVIRONMENT_INVALID", "official image PATH/PYTHONPATH is absent or unsafe");
  return { imagePath, pythonPath };
}

const safePathList = (value: string): boolean => value.split(":").every((entry) => entry.startsWith("/") && !entry.includes("..") && !entry.includes("\n"));

async function copyPinned(root: string, destination: string, entry: ClosureEntry): Promise<void> {
  const source = join(root, entry.path); const content = await readFile(source);
  if (sha256(content) !== entry.sha256) throw new SlitherGateError("INPUT_HASH_MISMATCH", `pinned input differs: ${entry.path}`);
  const target = join(destination, entry.path); await mkdir(dirname(target), { recursive: true, mode: 0o755 }); await copyFile(source, target);
}

async function closure(root: string, entries: readonly ClosureEntry[]): Promise<ClosureEntry[]> {
  return await Promise.all(entries.map(async ({ path }) => ({ path, sha256: sha256(await readFile(join(root, path))) })));
}

async function verifyVersions(output: string): Promise<void> {
  const checks: [string, RegExp][] = [
    ["forge.version", /Version: 1\.8\.0/u], ["solc.version", /Version: 0\.8\.36\+commit\.8a079791/u],
    ["slither.version", /^0\.11\.6\s*$/u], ["crytic-compile.version", /0\.4\.2/u],
  ];
  for (const [file, pattern] of checks) if (!pattern.test(await readFile(join(output, file), "utf8"))) throw new SlitherGateError("TOOL_VERSION_MISMATCH", `${file} did not report the exact pinned version`);
}

async function parseCompiledOutput(output: string): Promise<{ contracts: string[]; sources: string[]; compiler: GateManifest["compiler"]; artifactBytecode: string; buildInfoBytecode: string }> {
  const artifact = JSON.parse(await readFile(join(output, "AGTMAIToken.json"), "utf8")) as ForgeArtifact;
  const build = JSON.parse(await readFile(join(output, "build-info.json"), "utf8")) as BuildInfo;
  const contracts = Object.values(build.output?.contracts ?? {}).flatMap((value) => Object.keys(value)).sort();
  const sources = Object.keys(build.input?.sources ?? {}).sort();
  const settings = build.input?.settings;
  if (!settings || typeof build.solcVersion !== "string" || !build.solcVersion.startsWith("0.8.36")) throw new SlitherGateError("BUILD_INFO_INVALID", "fresh build-info lacks compiler identity");
  const remappings = Array.isArray(settings.remappings) && settings.remappings.every((value): value is string => typeof value === "string") ? [...settings.remappings].sort() : [];
  const expectedRemappings = ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"] as const;
  if (settings.evmVersion !== "paris" || settings.optimizer?.enabled !== true || settings.optimizer.runs !== 200 || settings.metadata?.bytecodeHash !== "ipfs" || settings.metadata.appendCBOR !== true || settings.metadata.useLiteralContent !== false || settings.viaIR !== false || settings.experimental !== false || JSON.stringify(remappings) !== JSON.stringify(expectedRemappings) || !isEmptyRecord(settings.libraries)) throw new SlitherGateError("COMPILER_SETTINGS_MISMATCH", "fresh build uses unexpected compiler settings");
  const compiler: GateManifest["compiler"] = { version: "0.8.36+commit.8a079791", evmVersion: "paris", optimizerEnabled: true, optimizerRuns: 200, bytecodeHash: "ipfs", cborMetadata: true, useLiteralContent: false, viaIR: false, experimental: false, remappings: expectedRemappings };
  const sourceName = "src/features/token-genesis/AGTMAIToken.sol";
  const artifactHex = artifact.bytecode?.object; const buildHex = build.output?.contracts?.[sourceName]?.AGTMAIToken?.evm?.bytecode?.object;
  const artifactBytes = decodeCreationBytecode(artifactHex); const buildInfoBytes = decodeCreationBytecode(buildHex);
  return { contracts, sources, compiler, artifactBytecode: sha256(artifactBytes), buildInfoBytecode: sha256(buildInfoBytes) };
}

const isEmptyRecord = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;

export function decodeCreationBytecode(value: unknown): Buffer {
  if (typeof value !== "string") throw new SlitherGateError("BYTECODE_MISSING", "fresh creation bytecode is absent or malformed");
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^(?:[0-9a-fA-F]{2})+$/u.test(normalized)) throw new SlitherGateError("BYTECODE_MISSING", "fresh creation bytecode is absent or malformed");
  return Buffer.from(normalized, "hex");
}

function assertSuppressionShape(suppressions: readonly Suppression[]): void {
  const expected = ["detectorId", "expiresAt", "findingIdentityHash", "fingerprint", "length", "owner", "path", "reason", "regressionEvidence", "reviewAt", "schemaVersion", "snippetHash", "sourceHash", "start"];
  for (const item of suppressions) {
    if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(expected) || item.schemaVersion !== 1) throw new SlitherGateError("SUPPRESSION_SHAPE_INVALID", "suppression entry has missing or unexpected fields");
  }
}
