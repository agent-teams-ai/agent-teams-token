import { chmod, constants, lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { validateExternalTempRoot } from "./validated-environment.ts";
import { dirname, join } from "node:path";
import { evaluateVulnerableFixture } from "../application/policy.ts";
import type { GateAnalysis, ProcessPort } from "../application/ports.ts";
import type { AnalysisInput, ClosureEntry, DetectorInventoryDocument, FindingTriage, GateErrorCode, GateManifest, Suppression } from "../domain/model.ts";
import { parseCompilerProfile, SlitherGateError } from "../domain/model.ts";
import { sha256 } from "./fingerprint.ts";
import { assertContainerResult } from "./container-result.ts";
import { assertSuppressionShape, parseTypedJson } from "./policy-shape.ts";
import { assertSerializedAgainstSchema, parseJsonWithoutDuplicateKeys } from "./json-schema.ts";
import { parseDetectorInventory, parseSlitherInventory, parseSlitherJson } from "./slither-json.ts";
import { runContainerById } from "./container-runtime.ts";
import { ensureContainerReadableDirectory, readStableRegularFile, writeContainerReadableFile } from "./container-input.ts";
import {
  dockerCreateArguments, dockerVulnerableFixtureCreateArguments, FIXTURE_OUTPUT_FILES, PRODUCTION_OUTPUT_FILES,
  IMAGE,
  IMAGE_REVISION,
  PINNED_PYTHONPATH,
} from "./container-contract.ts";
export interface ToolchainLock {
  readonly tools: {
    readonly foundry: { readonly platforms: Record<string, { readonly sha256: string; readonly installDirectory: string }> };
    readonly solc: { readonly platforms: Record<string, { readonly sha256: string; readonly installDirectory: string }> };
  };
  readonly securityImages: { readonly slither: {
    readonly repository: string; readonly tag: string; readonly indexDigest: string; readonly manifestDigest: string;
    readonly sourceRevision: string; readonly platform: string;
    readonly versions: { readonly slither: string; readonly cryticCompile: string; readonly forge: string; readonly solc: string };
    readonly runtime: { readonly containerUser: string; readonly pythonPath: string; readonly forgeMountPath: string; readonly solcMountPath: string };
  } };
}
interface ImageInspection {
  readonly RepoDigests?: readonly unknown[];
  readonly Os?: unknown;
  readonly Architecture?: unknown;
  readonly Config?: { readonly Labels?: Record<string, unknown>; readonly Env?: readonly unknown[] };
}
interface OfficialImageEnvironment { readonly imagePath: string; readonly pythonPath: string }
interface ForgeArtifact { readonly abi?: unknown; readonly bytecode?: { readonly object?: unknown } }
interface BuildInfo {
  readonly solcVersion?: unknown;
  readonly input?: { readonly sources?: Record<string, {readonly content?: unknown}>; readonly settings?: { readonly evmVersion?: unknown; readonly optimizer?: { readonly enabled?: unknown; readonly runs?: unknown }; readonly metadata?: { readonly bytecodeHash?: unknown; readonly appendCBOR?: unknown; readonly useLiteralContent?: unknown }; readonly viaIR?: unknown; readonly experimental?: unknown; readonly remappings?: unknown; readonly libraries?: unknown } };
  readonly output?: { readonly contracts?: Record<string, Record<string, { readonly evm?: { readonly bytecode?: { readonly object?: unknown } } }>> };
}
interface RunGateRequest {
  readonly repositoryRoot: string;
  readonly processPort: ProcessPort;
  readonly forgePath: string; readonly solcPath: string;
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
  const temporaryRoot = await validateExternalTempRoot(repositoryRoot, tmpdir());
  const scratch = await mkdtemp(join(temporaryRoot, "agtmai-slither-"));
  if ((await realpath(scratch)) !== scratch) {throw new SlitherGateError("TEMP_ROOT_INVALID", "temporary staging identity changed");}
  const inputDirectory = join(scratch, "input");
  const rawOutput = join(scratch, "raw");
  await chmod(scratch, 0o700);
  await mkdir(inputDirectory, { mode: 0o700 });
  await chmod(inputDirectory, 0o755);
  await mkdir(rawOutput, { mode: 0o700 });
  try {
    const productionClosure = [...manifest.sources, ...manifest.config, manifest.detectorInventory];
    for (const entry of productionClosure) {
      await copyPinned(repositoryRoot, inputDirectory, entry);
    }
    const targetsPath = join(inputDirectory, "tooling/security/slither/targets.txt");
    await writeContainerReadableFile(
      targetsPath,
      `${manifest.targets.map(({ path }) => path.replace(/^contracts\/evm\//u, "")).join("\n")}\n`,
    );
    const before = await closure(repositoryRoot, productionClosure);
    const result = await runContainerById(processPort, dockerPath, dockerCreateArguments({ input: inputDirectory, forge: forgePath, solc: solcPath, ...imageEnvironment }), rawOutput, PRODUCTION_OUTPUT_FILES);
    await assertContainerResult(result, rawOutput);
    const rawSeal = await sealRawOutput(rawOutput);
    await verifyVersions(rawOutput, rawSeal);
    const after = await closure(repositoryRoot, productionClosure);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new SlitherGateError("INPUT_CLOSURE_MUTATED", "production closure changed during analysis");
    }
    const parsed = await parseSlitherJson((await requiredRaw(rawOutput, rawSeal, "slither.json")).toString("utf8"), repositoryRoot);
    const slitherExit = parseSlitherExit(await requiredRaw(rawOutput, rawSeal, "slither.exit"));
    assertSlitherStatus(parsed.success, parsed.errors, parsed.findings.length, slitherExit);
    const inventory = parseSlitherInventory((await requiredRaw(rawOutput, rawSeal, "slither-inventory.json")).toString("utf8"));
    const inventoryExit = parseSlitherExit(await requiredRaw(rawOutput, rawSeal, "slither-inventory.exit"));
    assertSlitherStatus(inventory.success, inventory.errors, 0, inventoryExit);
    const detectorInventory = parseDetectorInventory((await requiredRaw(rawOutput, rawSeal, "detectors.txt")).toString("utf8"));
    const compiled = await parseCompiledOutput(rawOutput, rawSeal);
    const fixtureProof = await assertRealVulnerableFixture({
      repositoryRoot,
      scratch,
      processPort,
      dockerPath,
      forgePath,
      solcPath,
      imageEnvironment,
      expectedDetectors: prepared.expectedDetectors,
      fixture: manifest.vulnerableFixture,
    });
    const input: AnalysisInput = {
      success: parsed.success && inventory.success, findings: parsed.findings, analyzedContracts: inventory.contracts, analyzedSources: inventory.sources, closure: after,
      detectorInventory, compiler: compiled.compiler, creationBytecodeSha256: compiled.artifactBytecode, freshFoundryCreationBytecodeSha256: compiled.buildInfoBytecode,
      analysisErrors: [...parsed.errors, ...inventory.errors].toSorted(), forgeBinarySha256, solcBinarySha256, compilerEvidence: compiled.evidence, fixtureProof,
    };
    return {
      input,
      manifest,
      expectedDetectors: prepared.expectedDetectors,
      suppressions: prepared.suppressions,
      triage: prepared.triage,
      configHash: sha256(await readStableRegularFile(join(base, "slither.config.json"), "slither.config.json")),
      policyHash: sha256(await readStableRegularFile(join(base, "suppressions.v1.json"), "suppressions.v1.json")),
      triageHash: sha256(await readStableRegularFile(join(base, "triage.v1.json"), "triage.v1.json")),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
interface VulnerableFixtureRequest {
  readonly repositoryRoot: string; readonly scratch: string;
  readonly processPort: ProcessPort; readonly dockerPath: string;
  readonly forgePath: string; readonly solcPath: string; readonly imageEnvironment: OfficialImageEnvironment;
  readonly expectedDetectors: readonly string[]; readonly fixture: GateManifest["vulnerableFixture"]; }
async function assertRealVulnerableFixture(request: VulnerableFixtureRequest): Promise<AnalysisInput["fixtureProof"]> {
  const input = join(request.scratch, "fixture-input");
  const output = join(request.scratch, "fixture-output");
  await mkdir(input, { mode: 0o700 });
  await chmod(input, 0o755);
  await ensureContainerReadableDirectory(input, "contracts/evm/src");
  await ensureContainerReadableDirectory(input, "tooling/security/slither");
  await mkdir(output, { mode: 0o700 });
  const fixtureBytes = await readConfinedStableFile(request.repositoryRoot, request.fixture.source.path, "vulnerable fixture");
  if (sha256(fixtureBytes) !== request.fixture.source.sha256) {throw new SlitherGateError("VULNERABLE_FIXTURE_NOT_BLOCKED", "vulnerable fixture source pin differs");}
  await writeContainerReadableFile(join(input, "contracts/evm/src/Vulnerable.sol"), fixtureBytes);
  await safeCopyFile(join(request.repositoryRoot, "contracts/evm/foundry.toml"), join(input, "contracts/evm/foundry.toml"));
  await safeCopyFile(join(request.repositoryRoot, "tooling/security/slither/slither.config.json"), join(input, "tooling/security/slither/slither.config.json"));
  const result = await runContainerById(request.processPort, request.dockerPath, dockerVulnerableFixtureCreateArguments({ input, forge: request.forgePath, solc: request.solcPath, ...request.imageEnvironment }), output, FIXTURE_OUTPUT_FILES);
  await assertContainerResult(result, output);
  const outputSeal = await sealRawOutput(output);
  await verifyVersions(output, outputSeal);
  const parsed = await parseSlitherJson((await requiredRaw(output, outputSeal, "slither.json")).toString("utf8"), input);
  const status = parseSlitherExit(await requiredRaw(output, outputSeal, "slither.exit"));
  assertSlitherStatus(parsed.success, parsed.errors, parsed.findings.length, status);
  const observedDetectors = parseDetectorInventory((await requiredRaw(output, outputSeal, "detectors.txt")).toString("utf8"));
  if (JSON.stringify(observedDetectors) !== JSON.stringify(request.expectedDetectors)) {
    throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", "vulnerable fixture used a different detector inventory");
  }
  const decision = evaluateVulnerableFixture(parsed.findings, request.fixture.source.sha256);
  if (decision.exitCode !== 20) {throw new SlitherGateError("VULNERABLE_FIXTURE_NOT_BLOCKED", "real pinned Slither fixture must produce policy exit 20");}
  const compiled = await parseCompiledOutput(output, outputSeal, "Vulnerable.json", "src/Vulnerable.sol", "Vulnerable");
  if (compiled.artifactBytecode !== request.fixture.creationBytecodeSha256 || compiled.buildInfoBytecode !== request.fixture.creationBytecodeSha256) {throw new SlitherGateError("VULNERABLE_FIXTURE_NOT_BLOCKED", "vulnerable fixture build pin differs");}
  return {sourceSha256: sha256(fixtureBytes), buildInfoSha256: compiled.evidence.buildInfoSha256, artifactSha256: compiled.evidence.artifactSha256, abiSha256: compiled.evidence.abiSha256, creationBytecodeSha256: compiled.artifactBytecode, rawBuildInfo: compiled.evidence.rawBuildInfo, rawArtifact: compiled.evidence.rawArtifact};
}
export { authenticateTransferredOutput, runContainerById } from "./container-runtime.ts";

export function parseGateManifest(raw: string): GateManifest {
  const value = parseTypedJson(raw, "TARGET_MANIFEST_INVALID", "production manifest") as unknown;
  const root = exactObject(value, ["schemaVersion", "targets", "expectedContracts", "sources", "config", "compiler", "tools", "creationBytecodeSha256", "vulnerableFixture", "detectorInventory"]);
  if (root.schemaVersion !== 1 || !hashValue(root.creationBytecodeSha256)) {throw manifestInvalid();}
  const targets = exactArray(root.targets).map((item) => {const target=exactObject(item,["path","contract"]); const path=pathValue(target.path); const contract=identifierValue(target.contract); if(!path.startsWith("contracts/evm/src/") || !path.endsWith(".sol")) {throw manifestInvalid();} return {path,contract};});
  const expectedContracts=exactArray(root.expectedContracts).map(identifierValue);
  const sources=exactArray(root.sources).map(closureValue); const config=exactArray(root.config).map(closureValue); const detectorInventory=closureValue(root.detectorInventory);
  const fixture=exactObject(root.vulnerableFixture,["source","creationBytecodeSha256"]); const vulnerableFixture={source:closureValue(fixture.source),creationBytecodeSha256: hashString(fixture.creationBytecodeSha256)};
  const toolObject=exactObject(root.tools,["forgeArchiveSha256","forgeBinarySha256","solcBinarySha256"]);
  const tools={forgeArchiveSha256:hashString(toolObject.forgeArchiveSha256),forgeBinarySha256:hashString(toolObject.forgeBinarySha256),solcBinarySha256:hashString(toolObject.solcBinarySha256)};
  if(tools.forgeArchiveSha256!=="8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57"||tools.forgeBinarySha256!=="c0fbe3ba32d7f498507042dbb94f5954be51126a76ce84e37d71749e7c9c571f"||tools.solcBinarySha256!=="c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6") {throw manifestInvalid();}
  const allPaths=[...sources,...config,detectorInventory].map(({path})=>path); if(targets.length===0 || expectedContracts.length===0 || new Set(expectedContracts).size!==expectedContracts.length || new Set(targets.map(({path})=>path)).size!==targets.length || new Set([...allPaths,vulnerableFixture.source.path]).size!==allPaths.length+1 || targets.some(({path,contract})=>!sources.some((entry)=>entry.path===path)||!expectedContracts.includes(contract)) || vulnerableFixture.source.path!=="tooling/security/slither/tests/fixtures/Vulnerable.sol") {throw manifestInvalid();}
  parseCompilerProfile(root.compiler);
  const manifest={schemaVersion:1,targets,expectedContracts,sources,config,compiler:root.compiler,tools,creationBytecodeSha256:hashString(root.creationBytecodeSha256),vulnerableFixture,detectorInventory};
  return manifest as GateManifest;
}
function exactObject(value: unknown, keys: readonly string[]): Record<string,unknown> {if(value===null||typeof value!=="object"||Array.isArray(value)||JSON.stringify(Object.keys(value).toSorted())!==JSON.stringify([...keys].toSorted())) {throw manifestInvalid();} return value as Record<string,unknown>;}
function exactArray(value: unknown): unknown[] {if(!Array.isArray(value)) {throw manifestInvalid();} return value;}
function closureValue(value: unknown): ClosureEntry {const entry=exactObject(value,["path","sha256"]); return {path:pathValue(entry.path),sha256:hashString(entry.sha256)};}
function pathValue(value: unknown): string {if(typeof value!=="string" || !/^[A-Za-z0-9._/-]+$/u.test(value) || value.startsWith("/") || value.startsWith("-") || value.includes("\\") || value.split("/").some((part)=>!part||part==="."||part==="..")) {throw manifestInvalid();} return value;}
function identifierValue(value: unknown): string {if(typeof value!=="string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {throw manifestInvalid();} return value;}
function hashString(value: unknown): string {if(!hashValue(value)) {throw manifestInvalid();} return value;}
function hashValue(value: unknown): value is string {return typeof value==="string" && /^[0-9a-f]{64}$/u.test(value);}
function manifestInvalid(): SlitherGateError {return new SlitherGateError("TARGET_MANIFEST_INVALID","production manifest has unsafe or inexact structure");}

async function prepareGate(request: RunGateRequest): Promise<PreparedGate> {
  const { repositoryRoot, processPort, forgePath, solcPath, dockerPath } = request;
  const base = join(repositoryRoot, "tooling/security/slither");
  const manifest = parseGateManifest((await readStableRegularFile(join(base, "production-closure.v1.json"), "production-closure.v1.json")).toString("utf8"));
  const suppressionRaw = (await readStableRegularFile(join(base, "suppressions.v1.json"), "suppressions.v1.json")).toString("utf8");
  const triageRaw = (await readStableRegularFile(join(base, "triage.v1.json"), "triage.v1.json")).toString("utf8");
  try {
    await assertSerializedAgainstSchema(suppressionRaw, join(base, "suppression-ledger.schema.v1.json"));
    await assertSerializedAgainstSchema(triageRaw, join(base, "triage-ledger.schema.v1.json"));
  } catch {
    throw new SlitherGateError("POLICY_SHAPE_INVALID", "suppression or triage policy violates its exact schema");
  }
  const suppressionDocument = parseTypedJson(suppressionRaw, "POLICY_SHAPE_INVALID", "suppression policy") as { schemaVersion: number; suppressions: Suppression[] };
  const triageDocument = parseTypedJson(triageRaw, "POLICY_SHAPE_INVALID", "triage policy") as { schemaVersion: number; findings: FindingTriage[] };
  if (manifest.schemaVersion !== 1 || suppressionDocument.schemaVersion !== 1 || !Array.isArray(suppressionDocument.suppressions) || triageDocument.schemaVersion !== 1 || !Array.isArray(triageDocument.findings)) {throw new SlitherGateError("POLICY_SHAPE_INVALID", "policy inputs are malformed");}
  parseCompilerProfile(manifest.compiler);
  assertSuppressionShape(suppressionDocument.suppressions);
  const inventoryDocument = await readDetectorInventory(repositoryRoot, manifest.detectorInventory);
  await assertCanonicalConfig(join(base, "slither.config.json"));
  const lock = parseTypedJson((await readStableRegularFile(join(repositoryRoot, "tooling/toolchain.lock.json"), "toolchain.lock.json")).toString("utf8"), "TOOLCHAIN_LOCK_INVALID", "toolchain lock") as ToolchainLock;
  assertSlitherToolchainBinding(lock);
  const foundryArtifact = lock.tools.foundry.platforms["linux-x64"];
  const solcArtifact = lock.tools.solc.platforms["linux-x64"];
  const foundryPin = foundryArtifact?.sha256;
  const solcPin = solcArtifact?.sha256;
  if (foundryPin !== manifest.tools.forgeArchiveSha256 || solcPin !== manifest.tools.solcBinarySha256) {throw new SlitherGateError("TOOLCHAIN_LOCK_INVALID", "Linux project tool pins differ from the accepted prerequisite");}
  if (!foundryArtifact || !solcArtifact) {throw new SlitherGateError("TOOLCHAIN_LOCK_INVALID", "Linux tool artifacts are absent");}
  const expectedForgePath = join(repositoryRoot, ".tools", foundryArtifact.installDirectory, "forge");
  const expectedSolcPath = join(repositoryRoot, ".tools", solcArtifact.installDirectory, "solc");
  if (forgePath !== expectedForgePath || await realpath(forgePath) !== forgePath) {throw new SlitherGateError("FORGE_PIN_MISMATCH", "Forge must be the offline-installed project override");}
  if (solcPath !== expectedSolcPath || await realpath(solcPath) !== solcPath) {throw new SlitherGateError("SOLC_PIN_MISMATCH", "solc must be the offline-installed project override");}
  await assertTool(forgePath, manifest.tools.forgeBinarySha256, "FORGE_PIN_MISMATCH");
  await assertTool(solcPath, manifest.tools.solcBinarySha256, "SOLC_PIN_MISMATCH");
  const forgeBinarySha256 = sha256(await readFile(forgePath));
  const solcBinarySha256 = sha256(await readFile(solcPath));
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
export { assertContainerResult };
interface SealedFile {readonly dev:bigint;readonly ino:bigint;readonly size:bigint;readonly mtimeNs:bigint;readonly sha256:string}
type SealedOutput=ReadonlyMap<string,SealedFile>;
async function sealRawOutput(directory:string):Promise<SealedOutput>{
  const before=await lstat(directory,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink()) {throw new SlitherGateError("INPUT_HASH_MISMATCH","analyzer output directory is unsafe");}
  const sealed=new Map<string,SealedFile>();
  for(const name of await readdir(directory)){const path=join(directory,name);const listed=await lstat(path,{bigint:true});const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=await handle.stat({bigint:true});if(!opened.isFile()||opened.isSymbolicLink()||opened.nlink!==1n||opened.dev!==listed.dev||opened.ino!==listed.ino) {throw new SlitherGateError("INPUT_HASH_MISMATCH","analyzer output identity is unsafe");}await handle.chmod(0o444);const bytes=await handle.readFile();const after=await handle.stat({bigint:true});if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||after.mtimeNs!==opened.mtimeNs) {throw new SlitherGateError("INPUT_HASH_MISMATCH","analyzer output changed while sealing");}sealed.set(name,{dev:after.dev,ino:after.ino,size:after.size,mtimeNs:after.mtimeNs,sha256:sha256(bytes)});}finally{await handle.close();}}
  await chmod(directory,0o555);const after=await lstat(directory,{bigint:true});if(after.dev!==before.dev||after.ino!==before.ino) {throw new SlitherGateError("INPUT_HASH_MISMATCH","analyzer output directory changed while sealing");}return sealed;
}
async function requiredRaw(output:string,sealed:SealedOutput,name:string):Promise<Buffer>{
  const expected=sealed.get(name);if(!expected) {throw new SlitherGateError("MALFORMED_JSON","required analyzer output is absent");}
  try{const path=join(output,name);const listed=await lstat(path,{bigint:true});const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=await handle.stat({bigint:true});if(!opened.isFile()||opened.nlink!==1n||opened.dev!==listed.dev||opened.ino!==listed.ino||opened.dev!==expected.dev||opened.ino!==expected.ino) {throw new Error("identity");}const bytes=await handle.readFile();const after=await handle.stat({bigint:true});if(after.size!==expected.size||after.mtimeNs!==expected.mtimeNs||sha256(bytes)!==expected.sha256) {throw new Error("content");}return bytes;}finally{await handle.close();}}catch{throw new SlitherGateError("MALFORMED_JSON","required analyzer output identity changed");}
}
export function parseSlitherExit(raw: string | Buffer): number {
  const serialized = raw.toString();
  if (!/^(?:0|255)\n?$/u.test(serialized)) {
    throw new SlitherGateError("SLITHER_EXIT_INVALID", "Slither exit status is missing or malformed");
  }
  return serialized.startsWith("0") ? 0 : 255;
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
async function assertTool(path: string, expected: string, code: GateErrorCode): Promise<void> {
  await assertRegularTool(path, code);
  const actual = sha256(await readStableRegularFile(path, "tool override")); if (actual !== expected) {throw new SlitherGateError(code, "tool override checksum mismatch");}
}
async function assertRegularTool(path: string, code: GateErrorCode): Promise<void> {
  const info = await stat(path);
  if (!path.startsWith("/") || !info.isFile() || (await lstat(path)).isSymbolicLink() || (info.mode & 0o111) === 0) {throw new SlitherGateError(code, "tool override must be an absolute executable regular file");}
}
async function assertImage(port: ProcessPort, dockerPath: string): Promise<OfficialImageEnvironment> {
  const result = await port.run(dockerPath, ["image", "inspect", IMAGE, "--format", "{{json .}}"], 30_000);
  if (result.exitCode !== 0 || result.timedOut) {throw new SlitherGateError("IMAGE_UNAVAILABLE", "exact pinned image is unavailable locally");}
  return parseOfficialImageEnvironment(result.stdout);
}
export function parseOfficialImageEnvironment(raw: string): OfficialImageEnvironment {
  let image: ImageInspection; try { image = parseJsonWithoutDuplicateKeys(raw) as ImageInspection; } catch { throw new SlitherGateError("IMAGE_METADATA_INVALID", "image inspection output is malformed"); }
  const digests = Array.isArray(image.RepoDigests) ? image.RepoDigests : [];
  const revision = image.Config?.Labels?.["org.opencontainers.image.revision"];
  if (image.Os !== "linux" || image.Architecture !== "amd64" || !digests.some((value: unknown) => typeof value === "string" && value === "ghcr.io/trailofbits/eth-security-toolbox@sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0") || revision !== IMAGE_REVISION) {
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
  const raw = await readConfinedStableFile(repositoryRoot, entry.path, entry.path);
  if (sha256(raw) !== entry.sha256) {
    throw new SlitherGateError("INPUT_HASH_MISMATCH", "pinned detector inventory differs");
  }
  let document: Partial<DetectorInventoryDocument>;
  try {
    document = parseJsonWithoutDuplicateKeys(raw.toString("utf8")) as Partial<DetectorInventoryDocument>;
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
async function assertCanonicalConfig(path: string): Promise<void> {
  const raw = await readStableRegularFile(path, "slither.config.json");
  let value: unknown; try { value = parseJsonWithoutDuplicateKeys(raw.toString("utf8")); } catch { throw new SlitherGateError("POLICY_SHAPE_INVALID", "Slither config is not unambiguous JSON"); }
  if (JSON.stringify(value) !== JSON.stringify({ exclude_dependencies: false, legacy_ast: false })) {throw new SlitherGateError("POLICY_SHAPE_INVALID", "Slither config contains unsupported exclusions or fields");}
}
function assertManifestPath(path: string): void {
  if (!path || !/^[A-Za-z0-9._/-]+$/u.test(path) || path.startsWith("/") || path.startsWith("-") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {throw new SlitherGateError("TARGET_MANIFEST_INVALID", `manifest path is not canonical: ${path}`);}
}
async function readConfinedStableFile(root: string, relative: string, label: string): Promise<Buffer> {
  assertManifestPath(relative);
  const canonicalRoot = await realpath(root).catch(() => { throw new SlitherGateError("TARGET_MANIFEST_INVALID", "canonical root is not realpath-resolvable"); });
  const rootInfo = await lstat(canonicalRoot, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {throw new SlitherGateError("TARGET_MANIFEST_INVALID", "canonical root is not a regular directory");}
  const parts = relative.split("/");
  const rootHandle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let current = rootHandle;
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(`/proc/self/fd/${current.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (current !== rootHandle) {await current.close();}
      current = next;
    }
    const handle = await open(`/proc/self/fd/${current.fd}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {throw new SlitherGateError("INPUT_HASH_MISMATCH", `pinned input is not a sealed regular file: ${label}`);}
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.nlink !== 1n) {throw new SlitherGateError("INPUT_HASH_MISMATCH", `pinned input changed while reading: ${label}`);}
      return bytes;
    } finally { await handle.close(); }
  } finally { if (current !== rootHandle) {await current.close();} await rootHandle.close().catch(() => {}); }
}
const safePathList = (value: string): boolean => value.split(":").every((entry) => /^\/[A-Za-z0-9._/-]+$/u.test(entry) && !entry.split("/").includes(".."));
async function copyPinned(root: string, destination: string, entry: ClosureEntry): Promise<void> {
  assertManifestPath(entry.path); const content = await readConfinedStableFile(root, entry.path, entry.path);
  if (sha256(content) !== entry.sha256) {throw new SlitherGateError("INPUT_HASH_MISMATCH", `pinned input differs: ${entry.path}`);}
  await ensureContainerReadableDirectory(destination, dirname(entry.path));
  await writeContainerReadableFile(join(destination, entry.path), content);
}
async function closure(root: string, entries: readonly ClosureEntry[]): Promise<ClosureEntry[]> {
  return await Promise.all(entries.map(async ({ path }) => { assertManifestPath(path); return { path, sha256: sha256(await readConfinedStableFile(root, path, path)) }; }));
}
export async function verifyVersions(output: string, sealed?: SealedOutput): Promise<void> {
  const checks: [string, RegExp][] = [
    ["solc.version", /^solc, the solidity compiler commandline interface\s+Version: 0\.8\.36\+commit\.8a079791\.Linux\.g\+\+\s*$/u],
    ["slither.version", /^0\.11\.6\s*$/u], ["crytic-compile.version", /^crytic-compile 0\.4\.2\s*$/u],
  ];
  for (const [file, pattern] of checks) {
    let raw: Buffer;
    try { raw = sealed ? await requiredRaw(output, sealed, file) : await readStableRegularFile(join(output, file), file); }
    catch { throw new SlitherGateError("TOOL_VERSION_MISMATCH", `${file} is missing or unreadable`); }
    if (!pattern.test(raw.toString("utf8"))) {
      throw new SlitherGateError("TOOL_VERSION_MISMATCH", `${file} did not report the exact pinned version`);
    }
  }
  let forgeRaw: Buffer;
  try { forgeRaw = sealed ? await requiredRaw(output, sealed, "forge.version") : await readStableRegularFile(join(output, "forge.version"), "forge.version"); }
  catch { throw new SlitherGateError("TOOL_VERSION_MISMATCH", "forge.version is missing or unreadable"); }
  const forgeLines = forgeRaw.toString("utf8").split(/\r?\n/u);
  if (forgeLines.at(-1) === "") {forgeLines.pop();}
  if (forgeLines.length === 0 || forgeLines[0] !== "forge Version: 1.8.0" || forgeLines.slice(1).some((line) => line !== "" && !/^(?:Commit SHA|Build Timestamp|Build Profile): .+$/u.test(line))) {
    throw new SlitherGateError("TOOL_VERSION_MISMATCH", "forge.version did not report the exact pinned version");
  }
}
async function safeCopyFile(source: string, destination: string): Promise<void> {
  const content = await readStableRegularFile(source, "vulnerable fixture input");
  await writeContainerReadableFile(destination, content);
}

async function parseCompiledOutput(output: string, sealed: SealedOutput, artifactName = "AGTMAIToken.json", sourceName = "src/features/token-genesis/AGTMAIToken.sol", contractName = "AGTMAIToken"): Promise<{ compiler: GateManifest["compiler"]; artifactBytecode: string; buildInfoBytecode: string; evidence: AnalysisInput["compilerEvidence"] }> {
  let artifactRaw: Buffer; let buildRaw: Buffer;
  try {artifactRaw=await requiredRaw(output,sealed,artifactName); buildRaw=await requiredRaw(output,sealed,"build-info.json");} catch {throw new SlitherGateError("BUILD_INFO_INVALID","compiler artifact or build-info is missing or unreadable");}
  const artifact=parseTypedJson(artifactRaw.toString("utf8"),"BUILD_INFO_INVALID","compiler artifact") as ForgeArtifact;
  const build=parseTypedJson(buildRaw.toString("utf8"),"BUILD_INFO_INVALID","compiler build-info") as BuildInfo;
  const compiler=validateBuildCompiler(build); const artifactHex=artifact.bytecode?.object; const buildHex=build.output?.contracts?.[sourceName]?.[contractName]?.evm?.bytecode?.object;
  const artifactBytes=decodeCreationBytecode(artifactHex); const buildInfoBytes=decodeCreationBytecode(buildHex);
  if (!Array.isArray(artifact.abi)) {throw new SlitherGateError("BUILD_INFO_INVALID","compiler ABI is absent");}
  const sourceHashes=Object.entries(build.input?.sources ?? {}).map(([path,value])=>{assertManifestPath(path); if(typeof value.content!=="string") {throw new SlitherGateError("BUILD_INFO_INVALID","compiler source content is absent");} return {path,sha256:sha256(value.content)};}).toSorted((x,y)=>x.path.localeCompare(y.path));
  const normalized=typeof artifactHex==="string" ? (artifactHex.startsWith("0x")?artifactHex:`0x${artifactHex}`) : "";
  const evidence={buildInfoSha256:sha256(buildRaw),compilerInputSha256:sha256(JSON.stringify(build.input)),compilerSettingsSha256:sha256(JSON.stringify(build.input?.settings)),compilerInput:build.input as Readonly<Record<string,unknown>>,compilerSettings:build.input?.settings as Readonly<Record<string,unknown>>,sourceHashes,artifactSha256:sha256(artifactRaw),abiSha256:sha256(JSON.stringify(artifact.abi)),creationBytecode:normalized,creationBytecodeSha256:sha256(artifactBytes),rawBuildInfo:buildRaw.toString("utf8"),rawArtifact:artifactRaw.toString("utf8")};
  return {compiler,artifactBytecode:sha256(artifactBytes),buildInfoBytecode:sha256(buildInfoBytes),evidence};
}
function validateBuildCompiler(build: BuildInfo): GateManifest["compiler"] {
  const settings = build.input?.settings;
  if (!settings || build.solcVersion !== "0.8.36+commit.8a079791") {
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
export { assertSuppressionShape, parseTypedJson };
export interface SlitherRuntimeIdentity {
  readonly image: string; readonly revision: string; readonly platform: string;
  readonly slither: string; readonly cryticCompile: string; readonly forge: string; readonly solcPrefix: string;
  readonly containerUser: string; readonly pythonPath: string; readonly forgeMountPath: string; readonly solcMountPath: string;
}
export function assertSlitherToolchainBinding(lock: ToolchainLock, runtime: SlitherRuntimeIdentity = {
  image: IMAGE, revision: IMAGE_REVISION, platform: "linux/amd64", slither: "0.11.6", cryticCompile: "0.4.2",
  forge: "1.8.0", solcPrefix: "0.8.36+commit.8a079791", containerUser: "1000:1000", pythonPath: PINNED_PYTHONPATH,
  forgeMountPath: "/tools/forge", solcMountPath: "/tools/solc",
}): void {
  const image = lock.securityImages?.slither;
  if (!image || `${image.repository}:${image.tag}@${image.manifestDigest}` !== runtime.image
    || image.indexDigest !== "sha256:10c058d04f18a572f003e786ecf4e7f396a64137b2d6a9484fff2996621535a8"
    || image.sourceRevision !== runtime.revision || image.platform !== runtime.platform
    || image.versions.slither !== runtime.slither || image.versions.cryticCompile !== runtime.cryticCompile
    || image.versions.forge !== runtime.forge || image.versions.solc !== `${runtime.solcPrefix}.Linux.g++`
    || image.runtime.containerUser !== runtime.containerUser || image.runtime.pythonPath !== runtime.pythonPath
    || image.runtime.forgeMountPath !== runtime.forgeMountPath || image.runtime.solcMountPath !== runtime.solcMountPath) {
    throw new SlitherGateError("TOOLCHAIN_LOCK_INVALID", "Slither runtime differs from the canonical toolchain lock");
  }
}
export async function readAndAssertSlitherToolchain(repositoryRoot: string): Promise<void> {
  let lock: ToolchainLock;
  try {lock = parseJsonWithoutDuplicateKeys((await readStableRegularFile(join(repositoryRoot, "tooling/toolchain.lock.json"), "toolchain.lock.json")).toString("utf8")) as ToolchainLock;}
  catch {throw new SlitherGateError("TOOLCHAIN_LOCK_INVALID", "canonical toolchain lock is malformed");}
  assertSlitherToolchainBinding(lock);
}
