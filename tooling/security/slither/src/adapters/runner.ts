import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { GateAnalysis, ProcessPort } from "../application/ports.ts";
import type { AnalysisInput, ClosureEntry, DetectorInventoryDocument, FindingTriage, GateManifest, Suppression } from "../domain/model.ts";
import { parseCompilerProfile, SlitherGateError } from "../domain/model.ts";
import { sha256 } from "./fingerprint.ts";
import { assertSerializedAgainstSchema } from "./json-schema.ts";
import { parseDetectorInventory, parseSlitherInventory, parseSlitherJson } from "./slither-json.ts";
import {
  dockerRunArguments,
  dockerVulnerableFixtureArguments,
  IMAGE,
  IMAGE_REVISION,
  PINNED_PYTHONPATH,
} from "./container-contract.ts";
import { evaluateVulnerableFixture } from "../application/policy.ts";

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
interface RunGateRequest {
  readonly repositoryRoot: string;
  readonly processPort: ProcessPort;
  readonly forgePath: string;
  readonly solcPath: string;
  readonly dockerPath: string;
}
interface PreparedGate {
  readonly base: string;
  readonly manifest: GateManifest;
  readonly suppressions: readonly Suppression[];
  readonly expectedDetectors: readonly string[];
  readonly triage: readonly FindingTriage[];
  readonly forgeBinarySha256: string;
  readonly solcBinarySha256: string;
  readonly imageEnvironment: OfficialImageEnvironment;
}

export async function runGate(request: RunGateRequest): Promise<GateAnalysis> {
  const { repositoryRoot, processPort, forgePath, solcPath, dockerPath } = request;
  const prepared = await prepareGate(request);
  const { base, manifest, imageEnvironment, forgeBinarySha256, solcBinarySha256 } = prepared;
  const scratch = await mkdtemp(join(tmpdir(), "agtmai-slither-"));
  const containerName = basename(scratch);
  const fixtureContainerName = `${containerName}-fixture`;
  const inputDirectory = join(scratch, "input");
  const rawOutput = join(scratch, "raw");
  await chmod(scratch, 0o755);
  await mkdir(inputDirectory, { mode: 0o755 });
  await mkdir(rawOutput, { mode: 0o733 });
  await chmod(rawOutput, 0o733);
  try {
    const productionClosure = [...manifest.sources, ...manifest.config, manifest.detectorInventory];
    for (const entry of productionClosure) {
      await copyPinned(repositoryRoot, inputDirectory, entry);
    }
    const targetsPath = join(inputDirectory, "tooling/security/slither/targets.txt");
    await writeFile(
      targetsPath,
      `${manifest.targets.map(({ path }) => path.replace(/^contracts\/evm\//u, "")).join("\n")}\n`,
      { mode: 0o444, flag: "wx" },
    );
    const before = await closure(repositoryRoot, productionClosure);
    const result = await processPort.run(dockerPath, dockerRunArguments({ input: inputDirectory, output: rawOutput, forge: forgePath, solc: solcPath, containerName, ...imageEnvironment }), 600_000);
    assertContainerResult(result);
    await verifyVersions(rawOutput);
    const after = await closure(repositoryRoot, productionClosure);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new SlitherGateError("INPUT_CLOSURE_MUTATED", "production closure changed during analysis");
    }
    const parsed = await parseSlitherJson(await readFile(join(rawOutput, "slither.json"), "utf8"), repositoryRoot);
    const slitherExit = parseSlitherExit(await readFile(join(rawOutput, "slither.exit"), "utf8"));
    assertSlitherStatus(parsed.success, parsed.errors, parsed.findings.length, slitherExit);
    const inventory = parseSlitherInventory(await readFile(join(rawOutput, "slither-inventory.json"), "utf8"));
    const inventoryExit = parseSlitherExit(await readFile(join(rawOutput, "slither-inventory.exit"), "utf8"));
    assertSlitherStatus(inventory.success, inventory.errors, 0, inventoryExit);
    const detectorInventory = parseDetectorInventory(await readFile(join(rawOutput, "detectors.txt"), "utf8"));
    const compiled = await parseCompiledOutput(rawOutput);
    const input: AnalysisInput = {
      success: parsed.success && inventory.success, findings: parsed.findings, analyzedContracts: inventory.contracts, analyzedSources: inventory.sources, closure: after,
      detectorInventory, compiler: compiled.compiler, creationBytecodeSha256: compiled.artifactBytecode,
      freshFoundryCreationBytecodeSha256: compiled.buildInfoBytecode,
      analysisErrors: [...parsed.errors, ...inventory.errors].toSorted(),
      forgeBinarySha256, solcBinarySha256,
    };
    await assertRealVulnerableFixture({
      repositoryRoot,
      scratch,
      processPort,
      dockerPath,
      forgePath,
      solcPath,
      containerName: fixtureContainerName,
      imageEnvironment,
      expectedDetectors: prepared.expectedDetectors,
    });
    return {
      input,
      manifest,
      expectedDetectors: prepared.expectedDetectors,
      suppressions: prepared.suppressions,
      triage: prepared.triage,
      configHash: sha256(await readFile(join(base, "slither.config.json"))),
      policyHash: sha256(await readFile(join(base, "suppressions.v1.json"))),
      triageHash: sha256(await readFile(join(base, "triage.v1.json"))),
    };
  } finally {
    await processPort.run(dockerPath, ["rm", "--force", containerName], 30_000).catch(() => {});
    await processPort.run(dockerPath, ["rm", "--force", fixtureContainerName], 30_000).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

interface VulnerableFixtureRequest {
  readonly repositoryRoot: string;
  readonly scratch: string;
  readonly processPort: ProcessPort;
  readonly dockerPath: string;
  readonly forgePath: string;
  readonly solcPath: string;
  readonly containerName: string;
  readonly imageEnvironment: OfficialImageEnvironment;
  readonly expectedDetectors: readonly string[];
}

async function assertRealVulnerableFixture(request: VulnerableFixtureRequest): Promise<void> {
  const input = join(request.scratch, "fixture-input");
  const output = join(request.scratch, "fixture-output");
  await mkdir(join(input, "contracts/evm/src"), { recursive: true, mode: 0o755 });
  await mkdir(join(input, "tooling/security/slither"), { recursive: true, mode: 0o755 });
  await mkdir(output, { mode: 0o733 });
  await chmod(output, 0o733);
  await copyFile(join(request.repositoryRoot, "tooling/security/slither/tests/fixtures/Vulnerable.sol"), join(input, "contracts/evm/src/Vulnerable.sol"));
  await copyFile(join(request.repositoryRoot, "contracts/evm/foundry.toml"), join(input, "contracts/evm/foundry.toml"));
  await copyFile(join(request.repositoryRoot, "tooling/security/slither/slither.config.json"), join(input, "tooling/security/slither/slither.config.json"));
  const result = await request.processPort.run(
    request.dockerPath,
    dockerVulnerableFixtureArguments({
      input,
      output,
      forge: request.forgePath,
      solc: request.solcPath,
      containerName: request.containerName,
      ...request.imageEnvironment,
    }),
    600_000,
  );
  assertContainerResult(result);
  await verifyVersions(output);
  const parsed = await parseSlitherJson(await readFile(join(output, "slither.json"), "utf8"), input);
  const status = parseSlitherExit(await readFile(join(output, "slither.exit"), "utf8"));
  assertSlitherStatus(parsed.success, parsed.errors, parsed.findings.length, status);
  const observedDetectors = parseDetectorInventory(await readFile(join(output, "detectors.txt"), "utf8"));
  if (JSON.stringify(observedDetectors) !== JSON.stringify(request.expectedDetectors)) {
    throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", "vulnerable fixture used a different detector inventory");
  }
  const decision = evaluateVulnerableFixture(parsed.findings);
  if (decision.exitCode !== 20) {
    throw new SlitherGateError("VULNERABLE_FIXTURE_NOT_BLOCKED", "real pinned Slither fixture must produce policy exit 20");
  }
}

async function prepareGate(request: RunGateRequest): Promise<PreparedGate> {
  const { repositoryRoot, processPort, forgePath, solcPath, dockerPath } = request;
  const base = join(repositoryRoot, "tooling/security/slither");
  const manifest = JSON.parse(await readFile(join(base, "production-closure.v1.json"), "utf8")) as GateManifest;
  const suppressionRaw = await readFile(join(base, "suppressions.v1.json"), "utf8");
  const triageRaw = await readFile(join(base, "triage.v1.json"), "utf8");
  await assertSerializedAgainstSchema(suppressionRaw, join(base, "suppression-ledger.schema.v1.json"));
  await assertSerializedAgainstSchema(triageRaw, join(base, "triage-ledger.schema.v1.json"));
  const suppressionDocument = JSON.parse(suppressionRaw) as { schemaVersion: number; suppressions: Suppression[] };
  const triageDocument = JSON.parse(triageRaw) as { schemaVersion: number; findings: FindingTriage[] };
  if (manifest.schemaVersion !== 1 || suppressionDocument.schemaVersion !== 1 || !Array.isArray(suppressionDocument.suppressions) || triageDocument.schemaVersion !== 1 || !Array.isArray(triageDocument.findings)) {throw new SlitherGateError("POLICY_SHAPE_INVALID", "policy inputs are malformed");}
  parseCompilerProfile(manifest.compiler);
  assertSuppressionShape(suppressionDocument.suppressions);
  const inventoryDocument = await readDetectorInventory(repositoryRoot, manifest.detectorInventory);
  const lock = JSON.parse(await readFile(join(repositoryRoot, "tooling/toolchain.lock.json"), "utf8")) as ToolchainLock;
  const foundryPin = lock.tools.foundry.platforms["linux-x64"]?.sha256; const solcPin = lock.tools.solc.platforms["linux-x64"]?.sha256;
  if (foundryPin !== manifest.tools.forgeArchiveSha256 || solcPin !== manifest.tools.solcBinarySha256) {throw new SlitherGateError("TOOLCHAIN_LOCK_INVALID", "Linux project tool pins differ from the accepted prerequisite");}
  const expectedForgePath = join(repositoryRoot, ".tools/foundry-v1.8.0-linux-x64/forge");
  const expectedSolcPath = join(repositoryRoot, ".tools/solc-v0.8.36-linux-x64/solc");
  if (forgePath !== expectedForgePath || await realpath(forgePath) !== forgePath) {throw new SlitherGateError("FORGE_PIN_MISMATCH", "Forge must be the offline-installed project override");}
  if (solcPath !== expectedSolcPath || await realpath(solcPath) !== solcPath) {throw new SlitherGateError("SOLC_PIN_MISMATCH", "solc must be the offline-installed project override");}
  await assertTool(forgePath, manifest.tools.forgeBinarySha256, "FORGE_PIN_MISMATCH");
  await assertTool(solcPath, manifest.tools.solcBinarySha256, "SOLC_PIN_MISMATCH");
  const forgeBinarySha256 = sha256(await readFile(forgePath)); const solcBinarySha256 = sha256(await readFile(solcPath));
  const imageEnvironment = await assertImage(processPort, dockerPath);
  return {
    base,
    manifest,
    suppressions: suppressionDocument.suppressions,
    triage: triageDocument.findings,
    expectedDetectors: inventoryDocument.detectors,
    forgeBinarySha256,
    solcBinarySha256,
    imageEnvironment,
  };
}

function assertContainerResult(result: { readonly timedOut: boolean; readonly exitCode: number | null }): void {
  if (result.timedOut) {
    throw new SlitherGateError("CONTAINER_TIMEOUT", "container exceeded the bounded analysis timeout");
  }
  if (result.exitCode !== 0) {
    throw new SlitherGateError("CONTAINER_FAILED", "container analysis command failed");
  }
}

function parseSlitherExit(raw: string | Buffer): number {
  const status = Number.parseInt(raw.toString().trim(), 10);
  if (!Number.isSafeInteger(status) || status < 0 || status > 255) {
    throw new SlitherGateError("SLITHER_EXIT_INVALID", "Slither exit status is missing or malformed");
  }
  return status;
}

export function assertSlitherStatus(
  success: boolean,
  errors: readonly string[],
  findingCount: number,
  status: number,
): void {
  const exactFindingCount = Number.isSafeInteger(findingCount) && findingCount >= 0;
  const cleanOutput = exactFindingCount && success && errors.length === 0 && findingCount === 0 && status === 0;
  const findingsOutput = exactFindingCount && success && errors.length === 0 && findingCount > 0 && status === 255;
  const reportedFailure = exactFindingCount && !success && errors.length > 0 && status === 255;
  if (!cleanOutput && !findingsOutput && !reportedFailure) {
    throw new SlitherGateError(
      "SLITHER_EXIT_INVALID",
      "Slither JSON success, errors, finding count and exit status violate the documented matrix",
    );
  }
}

async function assertTool(path: string, expected: string, code: string): Promise<void> {
  await assertRegularTool(path, code);
  const actual = sha256(await readFile(path)); if (actual !== expected) {throw new SlitherGateError(code, "tool override checksum mismatch");}
}

async function assertRegularTool(path: string, code: string): Promise<void> {
  const info = await stat(path);
  if (!path.startsWith("/") || !info.isFile() || (await lstat(path)).isSymbolicLink() || (info.mode & 0o111) === 0) {throw new SlitherGateError(code, "tool override must be an absolute executable regular file");}
}

async function assertImage(port: ProcessPort, dockerPath: string): Promise<OfficialImageEnvironment> {
  const result = await port.run(dockerPath, ["image", "inspect", IMAGE, "--format", "{{json .}}"], 30_000);
  if (result.exitCode !== 0 || result.timedOut) {throw new SlitherGateError("IMAGE_UNAVAILABLE", "exact pinned image is unavailable locally");}
  return parseOfficialImageEnvironment(result.stdout);
}

export function parseOfficialImageEnvironment(raw: string): OfficialImageEnvironment {
  let image: ImageInspection; try { image = JSON.parse(raw) as ImageInspection; } catch { throw new SlitherGateError("IMAGE_METADATA_INVALID", "image inspection output is malformed"); }
  const digests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
  const revision = image.Config?.Labels?.["org.opencontainers.image.revision"];
  if (image.Os !== "linux" || image.Architecture !== "amd64" || !digests.some((value: unknown) => typeof value === "string" && value.endsWith("@sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0")) || revision !== IMAGE_REVISION) {
    throw new SlitherGateError("IMAGE_PIN_MISMATCH", "image digest, platform or revision mismatch");
  }
  const environment = Array.isArray(image.Config?.Env) ? image.Config.Env.filter((value): value is string => typeof value === "string") : [];
  const pathEntries = environment.filter((value) => value.startsWith("PATH="));
  const imagePath = pathEntries.length === 1 ? pathEntries[0]?.slice(5) : undefined;
  if (!imagePath || !safePathList(imagePath)) {
    throw new SlitherGateError(
      "IMAGE_ENVIRONMENT_INVALID",
      "official image PATH is absent, ambiguous or unsafe",
    );
  }
  // The digest-pinned image intentionally has no Config.Env PYTHONPATH. The
  // immutable user-site directory is bound explicitly after the environment is
  // scrubbed with `env -i`; the container contract verifies the package before
  // analysis starts.
  return { imagePath, pythonPath: PINNED_PYTHONPATH };
}

async function readDetectorInventory(
  repositoryRoot: string,
  entry: ClosureEntry,
): Promise<DetectorInventoryDocument> {
  const path = join(repositoryRoot, entry.path);
  const raw = await readFile(path);
  if (sha256(raw) !== entry.sha256) {
    throw new SlitherGateError("INPUT_HASH_MISMATCH", "pinned detector inventory differs");
  }
  let document: Partial<DetectorInventoryDocument>;
  try {
    document = JSON.parse(raw.toString("utf8")) as Partial<DetectorInventoryDocument>;
  } catch {
    throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", "expected detector inventory is not JSON");
  }
  const detectors = document.detectors;
  const sortedDetectors = Array.isArray(detectors) ? detectors.toSorted() : [];
  if (
    document.schemaVersion !== 1
    || document.slitherVersion !== "0.11.6"
    || !Array.isArray(detectors)
    || detectors.length === 0
    || !detectors.every((detector) => typeof detector === "string")
    || new Set(detectors).size !== detectors.length
    || detectors.some((detector, index) => detector !== sortedDetectors[index])
  ) {
    throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", "expected detector inventory is malformed");
  }
  return document as DetectorInventoryDocument;
}

const safePathList = (value: string): boolean => value.split(":").every((entry) => entry.startsWith("/") && !entry.includes("..") && !entry.includes("\n"));

async function copyPinned(root: string, destination: string, entry: ClosureEntry): Promise<void> {
  const source = join(root, entry.path); const content = await readFile(source);
  if (sha256(content) !== entry.sha256) {throw new SlitherGateError("INPUT_HASH_MISMATCH", `pinned input differs: ${entry.path}`);}
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
  for (const [file, pattern] of checks) {
    if (!pattern.test(await readFile(join(output, file), "utf8"))) {
      throw new SlitherGateError("TOOL_VERSION_MISMATCH", `${file} did not report the exact pinned version`);
    }
  }
}

async function parseCompiledOutput(output: string): Promise<{ compiler: GateManifest["compiler"]; artifactBytecode: string; buildInfoBytecode: string }> {
  const artifact = JSON.parse(await readFile(join(output, "AGTMAIToken.json"), "utf8")) as ForgeArtifact;
  const build = JSON.parse(await readFile(join(output, "build-info.json"), "utf8")) as BuildInfo;
  const compiler = validateBuildCompiler(build);
  const sourceName = "src/features/token-genesis/AGTMAIToken.sol";
  const artifactHex = artifact.bytecode?.object;
  const buildHex = build.output?.contracts?.[sourceName]?.AGTMAIToken?.evm?.bytecode?.object;
  const artifactBytes = decodeCreationBytecode(artifactHex);
  const buildInfoBytes = decodeCreationBytecode(buildHex);
  return { compiler, artifactBytecode: sha256(artifactBytes), buildInfoBytecode: sha256(buildInfoBytes) };
}

function validateBuildCompiler(build: BuildInfo): GateManifest["compiler"] {
  const settings = build.input?.settings;
  if (!settings || typeof build.solcVersion !== "string" || !build.solcVersion.startsWith("0.8.36")) {
    throw new SlitherGateError("BUILD_INFO_INVALID", "fresh build-info lacks compiler identity");
  }
  const remappings = stringArray(settings.remappings).toSorted();
  const profile: GateManifest["compiler"] = {
    version: "0.8.36+commit.8a079791",
    evmVersion: "paris",
    optimizerEnabled: true,
    optimizerRuns: 200,
    bytecodeHash: "ipfs",
    cborMetadata: true,
    useLiteralContent: false,
    viaIR: false,
    experimental: false,
    remappings: [
      "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
      "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/",
    ],
  };
  const observed = {
    version: "0.8.36+commit.8a079791",
    evmVersion: settings.evmVersion,
    optimizerEnabled: settings.optimizer?.enabled,
    optimizerRuns: settings.optimizer?.runs,
    bytecodeHash: settings.metadata?.bytecodeHash,
    cborMetadata: settings.metadata?.appendCBOR,
    useLiteralContent: settings.metadata?.useLiteralContent,
    viaIR: settings.viaIR,
    experimental: settings.experimental,
    remappings,
  };
  if (JSON.stringify(observed) !== JSON.stringify(profile) || !isEmptyRecord(settings.libraries)) {
    throw new SlitherGateError("COMPILER_SETTINGS_MISMATCH", "fresh build uses unexpected compiler settings");
  }
  return profile;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

const isEmptyRecord = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;

export function decodeCreationBytecode(value: unknown): Buffer {
  if (typeof value !== "string") {throw new SlitherGateError("BYTECODE_MISSING", "fresh creation bytecode is absent or malformed");}
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^(?:[0-9a-fA-F]{2})+$/u.test(normalized)) {throw new SlitherGateError("BYTECODE_MISSING", "fresh creation bytecode is absent or malformed");}
  return Buffer.from(normalized, "hex");
}

function assertSuppressionShape(suppressions: readonly Suppression[]): void {
  const expected = ["detectorId", "expiresAt", "findingIdentityHash", "fingerprint", "length", "owner", "path", "reason", "regressionEvidence", "reviewAt", "schemaVersion", "snippetHash", "sourceHash", "start"];
  for (const item of suppressions) {
    if (JSON.stringify(Object.keys(item).toSorted()) !== JSON.stringify(expected) || item.schemaVersion !== 1) {throw new SlitherGateError("SUPPRESSION_SHAPE_INVALID", "suppression entry has missing or unexpected fields");}
  }
}
