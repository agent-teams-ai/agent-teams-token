import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { IMPACTS, SlitherGateError } from "../domain/model.ts";
import { classifyGateFailure, isGateErrorCode } from "../application/failure.ts";
import { assertSerializedAgainstSchema, parseJsonWithoutDuplicateKeys } from "./json-schema.ts";

const ANALYSIS_FILES = [
  "READY", "artifact.json", "build-info.json", "detector-inventory.json", "evidence.json", "fixture-artifact.json", "fixture-build-info.json", "slither-inventory.json",
  "slither-status.json", "slither.json", "summary.md",
] as const;
const VARIANTS = {
  "evidence.json": ANALYSIS_FILES,
  "environment-failure.json": ["READY", "environment-failure.json"],
  "tool-failure.json": ["READY", "tool-failure.json"],
  "output-failure.json": ["READY", "output-failure.json"],
} as const;
type Variant = keyof typeof VARIANTS;
type JsonObject = Record<string, unknown>;

interface ValidationRequest {
  readonly output: string;
  readonly candidateSha: string;
  readonly schemaDirectory: string;
  readonly canonicalDirectory?: string;
  readonly finalizationMode?: "local" | "ci";
}

/** Independently derives the uploaded result from raw, normalized analyzer inputs. */
export async function validateFinalizedEvidenceBundle(request: ValidationRequest): Promise<void> {
  const canonicalSchemaDirectory = await realpath(request.schemaDirectory).catch(() => { throw invalid("schema root is not realpath-resolvable"); });
  const repositoryRoot = await realpath(join(canonicalSchemaDirectory, "../../.."));
  if (!request.output.startsWith("/") || !/^[0-9a-f]{40}$/u.test(request.candidateSha)) {
    throw invalid("an absolute bundle path and exact candidate SHA are required");
  }
  const canonicalOutput = await realpath(request.output).catch(() => { throw invalid("bundle output is not realpath-resolvable"); });
  if (canonicalOutput === repositoryRoot || canonicalOutput.startsWith(`${repositoryRoot}/`)) {throw invalid("bundle output must remain outside the repository boundary");}
  await assertRegularDirectory(request.output);
  const entries = (await readdir(request.output)).toSorted();
  const variants = (Object.keys(VARIANTS) as Variant[]).filter((name) => entries.includes(name));
  if (variants.length !== 1) {throw invalid(`expected exactly one evidence variant, found ${variants.length}`);}
  const variant = variants[0]!;
  if (JSON.stringify(entries) !== JSON.stringify([...VARIANTS[variant]].toSorted())) {
    throw invalid("bundle has missing or extra entries");
  }
  for (const name of entries) {await assertRegularFile(join(request.output, name));}
  if ((await readStableOutputFile(join(request.output, "READY"))).length !== 0) {throw invalid("READY must be empty");}

  const serialized = (await readStableOutputFile(join(request.output, variant))).toString("utf8");
  await assertSerializedAgainstSchema(serialized, join(canonicalSchemaDirectory, schemaName(variant)));
  const value = object(parseJsonWithoutDuplicateKeys(serialized), "evidence");
  if (value.candidateSha !== request.candidateSha) {throw invalid("evidence candidate SHA differs from the upload candidate");}
  assertExecution(value, request.finalizationMode ?? (process.env.GITHUB_ACTIONS === "true" ? "ci" : "local"));
  if (variant !== "evidence.json") {await assertFailureEvidence(value, canonicalSchemaDirectory); return;}

  const derived = await deriveRawBundle(request.output, request.canonicalDirectory ?? canonicalSchemaDirectory, canonicalSchemaDirectory);
  assertAnalysisEvidenceSemantics(value, derived);
  const summary = (await readStableOutputFile(join(request.output, "summary.md"))).toString("utf8");
  if (summary !== renderAnalysisSummary(value)) {throw invalid("summary differs from independently derived evidence");}
}

async function assertFailureEvidence(value: JsonObject, schemaDirectory: string): Promise<void> {
  const errorCode = stringValue(value.errorCode);
  if (!isGateErrorCode(errorCode)) {throw invalid("failure code is outside the exhaustive registry");}
  const classification = classifyGateFailure(errorCode);
  if (value.category !== classification.category || value.exitCode !== classification.exitCode || value.stage !== classification.stage) {
    throw invalid("failure envelope differs from the exhaustive registry");
  }
  const lock = object(parseJsonWithoutDuplicateKeys((await readStableCanonicalFile(join(schemaDirectory, "../../toolchain.lock.json"), "toolchain.lock.json")).toString("utf8")), "toolchain lock");
  const image = object(object(lock.securityImages, "securityImages").slither, "slither image");
  if (value.image !== `${image.repository}:${image.tag}@${image.manifestDigest}`) {
    throw invalid("failure image differs from the canonical toolchain lock");
  }
}

interface DerivedBundle {
  readonly manifest: JsonObject;
  readonly findings: readonly JsonObject[];
  readonly targets: readonly string[];
  readonly sources: readonly string[];
  readonly detectors: readonly string[];
  readonly closureHash: string;
  readonly configHash: string;
  readonly policyHash: string;
  readonly triageHash: string;
  readonly suppressed: ReadonlySet<string>;
  readonly triaged: ReadonlySet<string>;
  readonly tools: JsonObject;
  readonly compiler: JsonObject;
  readonly fixture: JsonObject;
}

async function deriveRawBundle(output: string, directory: string, schemaDirectory: string): Promise<DerivedBundle> {
  const canonicalSchemaDirectory = await assertCanonicalRoot(schemaDirectory);
  const repositoryRoot = await realpath(join(canonicalSchemaDirectory, "../../.."));
  if (!isWithin(repositoryRoot, canonicalSchemaDirectory)) {throw invalid("schema root escapes the repository boundary");}
  const canonicalDirectory = await assertCanonicalRoot(directory);
  const canonicalInputs = await readCanonicalInputs(canonicalDirectory, canonicalSchemaDirectory);
  const findings = await readRawAnalysis(
    output,
    canonicalInputs.targets,
    canonicalInputs.sources,
    canonicalInputs.acceptedDetectors,
  );
  assertRawFindingSources(findings, canonicalInputs.manifest);
  const policies = await readCanonicalPolicies(canonicalDirectory, canonicalSchemaDirectory, findings);
  const tools = await readCanonicalTools(canonicalInputs.repositoryRoot, canonicalInputs.manifest);
  const builds = await deriveCompiler(output, canonicalInputs.manifest);
  return {
    manifest: canonicalInputs.manifest,
    findings,
    targets: canonicalInputs.targets,
    sources: canonicalInputs.sources,
    detectors: canonicalInputs.acceptedDetectors,
    closureHash: `sha256:${hex(JSON.stringify(canonicalInputs.closure))}`,
    configHash: `sha256:${hex(policies.configBytes)}`,
    policyHash: `sha256:${hex(policies.policyBytes)}`,
    triageHash: `sha256:${hex(policies.triageBytes)}`,
    suppressed: policies.suppressed,
    triaged: policies.triaged,
    tools, compiler: builds.compiler, fixture: builds.fixture,
  };
}

interface CanonicalInputs {
  readonly manifest: JsonObject;
  readonly targets: readonly string[];
  readonly sources: readonly string[];
  readonly acceptedDetectors: readonly string[];
  readonly closure: readonly unknown[];
  readonly repositoryRoot: string;
}

async function assertCanonicalRoot(directory: string): Promise<string> {
  const resolved = await realpath(directory).catch(() => { throw invalid("canonical input root is not realpath-resolvable"); });
  const info = await lstat(resolved, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {throw invalid("canonical input root is not a sealed directory");}
  return resolved;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"));
}

async function readCanonicalInputs(directory: string, schemaDirectory: string): Promise<CanonicalInputs> {
  const manifestRaw = (await readStableCanonicalFile(join(directory, "production-closure.v1.json"), "production manifest")).toString("utf8");
  const manifest = object(parseJsonWithoutDuplicateKeys(manifestRaw), "production manifest");
  assertExactKeys(manifest, ["schemaVersion","targets","expectedContracts","sources","config","compiler","tools","creationBytecodeSha256","vulnerableFixture","detectorInventory"], "production manifest");
  if (manifest.schemaVersion !== 1) {throw invalid("production manifest version is invalid");}
  const targets = uniqueStrings(manifest.expectedContracts, "manifest.expectedContracts");
  const sourcePaths = uniqueStrings(array(manifest.sources, "manifest.sources").map((entry) => object(entry, "source").path), "manifest source paths");
  const sources = sourcePaths.map((path) => path.replace(/^contracts\/evm\//u, ""));
  const manifestTargets = array(manifest.targets, "manifest.targets").map((entry) => {const target=object(entry, "manifest target"); assertExactKeys(target,["path","contract"],"manifest target"); assertStrictRelativePath(stringValue(target.path)); if(!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(stringValue(target.contract))) throw invalid("manifest contract is unsafe"); return target;});
  if (manifestTargets.length === 0 || manifestTargets.some((entry) => !targets.includes(stringValue(entry.contract))
    || !sourcePaths.includes(stringValue(entry.path)))) {throw invalid("canonical target manifest is malformed");}
  const closure = [
    ...array(manifest.sources, "manifest.sources"),
    ...array(manifest.config, "manifest.config"),
    object(manifest.detectorInventory, "manifest.detectorInventory"),
  ];
  const repositoryRoot = await realpath(join(schemaDirectory, "../../.."));
  const canonicalBase = directory === schemaDirectory ? repositoryRoot : directory;
  for (const rawEntry of closure) {
    const entry = object(rawEntry, "closure entry");
    const relativePath = stringValue(entry.path);
    assertStrictRelativePath(relativePath);
    const bytes = await readStableCanonicalFile(join(canonicalBase, relativePath), relativePath);
    if (hex(bytes) !== entry.sha256) {throw invalid(`canonical closure input differs: ${relativePath}`);}
  }
  const vulnerable = object(manifest.vulnerableFixture, "vulnerable fixture"); assertExactKeys(vulnerable,["source","creationBytecodeSha256"],"vulnerable fixture");
  const fixtureSource=object(vulnerable.source,"vulnerable fixture source"); assertExactKeys(fixtureSource,["path","sha256"],"vulnerable fixture source"); assertStrictRelativePath(stringValue(fixtureSource.path));
  const fixtureBytes=await readStableCanonicalFile(join(canonicalBase,stringValue(fixtureSource.path)),"vulnerable fixture source"); if(hex(fixtureBytes)!==fixtureSource.sha256) throw invalid("vulnerable fixture source pin differs");
  const detectorEntry = object(manifest.detectorInventory, "manifest.detectorInventory");
  const acceptedDetectorBytes = await readStableCanonicalFile(join(canonicalBase, stringValue(detectorEntry.path)), "detector inventory");
  if (hex(acceptedDetectorBytes) !== detectorEntry.sha256) {throw invalid("canonical detector inventory hash differs from manifest");}
  const acceptedDetectorDocument = object(parseJsonWithoutDuplicateKeys(acceptedDetectorBytes.toString("utf8")), "canonical detector inventory");
  if (acceptedDetectorDocument.schemaVersion !== 1 || acceptedDetectorDocument.slitherVersion !== "0.11.6") {
    throw invalid("canonical detector inventory identity is invalid");
  }
  const acceptedDetectors = uniqueSortedStrings(acceptedDetectorDocument.detectors, "canonical detectors");
  return {manifest, targets, sources, acceptedDetectors, closure, repositoryRoot};
}

async function readRawAnalysis(
  output: string,
  targets: readonly string[],
  sources: readonly string[],
  acceptedDetectors: readonly string[],
): Promise<JsonObject[]> {
  const rawAnalysis = object(parseJsonWithoutDuplicateKeys((await readStableOutputFile(join(output, "slither.json"))).toString("utf8")), "slither.json");
  const rawInventory = object(parseJsonWithoutDuplicateKeys((await readStableOutputFile(join(output, "slither-inventory.json"))).toString("utf8")), "slither-inventory.json");
  const rawDetectors = object(parseJsonWithoutDuplicateKeys((await readStableOutputFile(join(output, "detector-inventory.json"))).toString("utf8")), "detector-inventory.json");
  const status = object(parseJsonWithoutDuplicateKeys((await readStableOutputFile(join(output, "slither-status.json"))).toString("utf8")), "slither-status.json");
  assertExactKeys(rawAnalysis, ["schemaVersion", "success", "errors", "findings"], "slither.json");
  assertExactKeys(rawInventory, ["schemaVersion", "success", "contracts", "sources", "errors"], "slither-inventory.json");
  assertExactKeys(rawDetectors, ["schemaVersion", "detectors"], "detector-inventory.json");
  assertExactKeys(status, ["schemaVersion", "analysisExit", "inventoryExit"], "slither-status.json");
  const findings = array(rawAnalysis.findings, "raw findings").map((finding) => validateRawFinding(object(finding, "raw finding")));
  const targetsObserved = uniqueSortedStrings(rawInventory.contracts, "raw contracts");
  const sourcesObserved = uniqueSortedStrings(rawInventory.sources, "raw sources");
  const detectorsObserved = uniqueSortedStrings(rawDetectors.detectors, "raw detectors");
  assertRawAnalysisStatus(rawAnalysis, rawInventory, rawDetectors, status, findings.length);
  if (!same(targets, targetsObserved) || !same(sources, sourcesObserved) || !same(acceptedDetectors, detectorsObserved)) {
    throw invalid("raw targets, sources or detectors differ from canonical production inputs");
  }
  if (findings.some((finding) => !acceptedDetectors.includes(stringValue(finding.detectorId)))) {
    throw invalid("raw finding uses a detector outside the canonical inventory");
  }
  return findings;
}

function assertRawAnalysisStatus(
  analysis: JsonObject,
  inventory: JsonObject,
  detectors: JsonObject,
  status: JsonObject,
  findingCount: number,
): void {
  if (analysis.schemaVersion !== 1 || inventory.schemaVersion !== 1 || detectors.schemaVersion !== 1 || status.schemaVersion !== 1
    || analysis.success !== true || inventory.success !== true
    || array(analysis.errors, "analysis errors").length !== 0 || array(inventory.errors, "inventory errors").length !== 0
    || status.analysisExit !== (findingCount === 0 ? 0 : 255) || status.inventoryExit !== 0) {
    throw invalid("raw analysis status matrix is invalid");
  }
}

function assertRawFindingSources(findings: readonly JsonObject[], manifest: JsonObject): void {
  const sourceHashes = new Map(array(manifest.sources, "manifest.sources").map((rawEntry) => {
    const entry = object(rawEntry, "source entry"); return [stringValue(entry.path), stringValue(entry.sha256)] as const;
  }));
  if (findings.some((finding) => sourceHashes.get(stringValue(finding.path)) !== String(finding.sourceHash).replace(/^sha256:/u, ""))) {
    throw invalid("raw finding source hash differs from the canonical source");
  }
}

interface CanonicalPolicies {
  readonly configBytes: Uint8Array;
  readonly policyBytes: Uint8Array;
  readonly triageBytes: Uint8Array;
  readonly suppressed: ReadonlySet<string>;
  readonly triaged: ReadonlySet<string>;
}

async function readCanonicalPolicies(
  directory: string,
  schemaDirectory: string,
  findings: readonly JsonObject[],
): Promise<CanonicalPolicies> {
  const configBytes = await readStableCanonicalFile(join(directory, "slither.config.json"), "slither.config.json");
  let config: unknown; try { config = parseJsonWithoutDuplicateKeys(configBytes.toString("utf8")); } catch { throw invalid("Slither config is not unambiguous JSON"); }
  if (JSON.stringify(config) !== JSON.stringify({ exclude_dependencies: false, legacy_ast: false })) {throw invalid("Slither config contains unsupported exclusions or fields");}
  const policyBytes = await readStableCanonicalFile(join(directory, "suppressions.v1.json"), "suppressions.v1.json");
  const triageBytes = await readStableCanonicalFile(join(directory, "triage.v1.json"), "triage.v1.json");
  await assertSerializedAgainstSchema(policyBytes.toString("utf8"), join(schemaDirectory, "suppression-ledger.schema.v1.json"));
  await assertSerializedAgainstSchema(triageBytes.toString("utf8"), join(schemaDirectory, "triage-ledger.schema.v1.json"));
  const policy = object(parseJsonWithoutDuplicateKeys(policyBytes.toString("utf8")), "suppression policy");
  const suppressions = array(policy.suppressions, "suppressions").map((item) => object(item, "suppression"));
  const suppressed = deriveSuppressions(findings, suppressions);
  const triage = object(parseJsonWithoutDuplicateKeys(triageBytes.toString("utf8")), "triage policy");
  const triaged = deriveTriage(findings, suppressed, triage);
  return {configBytes, policyBytes, triageBytes, suppressed, triaged};
}

function deriveSuppressions(findings: readonly JsonObject[], suppressions: readonly JsonObject[]): ReadonlySet<string> {
  const now = Date.now();
  for (const suppression of suppressions) {
    const expires = Date.parse(stringValue(suppression.expiresAt));
    const review = Date.parse(stringValue(suppression.reviewAt));
    if (expires <= now || review <= now || review > expires || String(suppression.owner).trim().length === 0
      || String(suppression.reason).trim().length < 10 || String(suppression.regressionEvidence).trim().length === 0) {
      throw invalid("canonical suppression ownership or review window is invalid");
    }
  }
  const suppressed = new Set<string>();
  for (const finding of findings) {
    const matches = suppressions.filter((suppression) => exactSuppression(finding, suppression));
    if (matches.length > 1) {throw invalid("finding matches multiple suppressions");}
    if (matches.length === 1) {suppressed.add(stringValue(finding.fingerprint));}
  }
  if (suppressions.some((suppression) => !findings.some((finding) => exactSuppression(finding, suppression)))) {
    throw invalid("canonical suppression is unused");
  }
  return suppressed;
}

function deriveTriage(findings: readonly JsonObject[], suppressed: ReadonlySet<string>, triage: JsonObject): ReadonlySet<string> {
  const triageValues = array(triage.findings, "triage findings").map((item) => stringValue(object(item, "triage").fingerprint));
  const triaged = new Set(triageValues);
  if (triaged.size !== triageValues.length) {throw invalid("canonical triage contains duplicate fingerprints");}
  const lowerVisible = findings.filter((finding) => !suppressed.has(stringValue(finding.fingerprint))
    && ["Low", "Informational", "Optimization"].includes(stringValue(finding.impact)))
    .map((finding) => stringValue(finding.fingerprint));
  if (!same([...triaged], lowerVisible)) {throw invalid("canonical triage does not exactly cover visible lower findings");}
  return triaged;
}

async function deriveCompiler(output: string, manifest: JsonObject): Promise<{compiler: JsonObject; fixture: JsonObject}> {
  const target=object(array(manifest.targets,"manifest targets")[0],"manifest target");
  const compiler=await deriveOneBuild(output,"build-info.json","artifact.json",stringValue(target.path).replace(/^contracts\/evm\//u,""),stringValue(target.contract));
  const vulnerable=object(manifest.vulnerableFixture,"vulnerable fixture"); const fixtureSource=object(vulnerable.source,"vulnerable fixture source");
  const fixtureBuild=await deriveOneBuild(output,"fixture-build-info.json","fixture-artifact.json","src/Vulnerable.sol","Vulnerable");
  if (compiler.creationBytecodeSha256 !== `sha256:${manifest.creationBytecodeSha256}` || fixtureBuild.creationBytecodeSha256 !== `sha256:${vulnerable.creationBytecodeSha256}` || !array(fixtureBuild.sourceHashes,"fixture source hashes").some((item)=>{const entry=object(item,"fixture source hash");return entry.path==="src/Vulnerable.sol"&&entry.sha256===`sha256:${fixtureSource.sha256}`;})) {throw invalid("compiler creation bytecode differs from manifest pins");}
  const expectedSources=new Map(array(manifest.sources,"manifest sources").map((item)=>{const entry=object(item,"source"); return [stringValue(entry.path).replace(/^contracts\/evm\//u,""),`sha256:${entry.sha256}`] as const;}));
  const observed=array(compiler.sourceHashes,"compiler source hashes").map((item)=>object(item,"source hash"));
  if(observed.length!==expectedSources.size || observed.some((entry)=>expectedSources.get(stringValue(entry.path))!==entry.sha256)) throw invalid("compiler per-source hashes differ from the pinned closure");
  return {compiler,fixture:{sourceSha256:`sha256:${fixtureSource.sha256}`,buildInfoSha256:fixtureBuild.buildInfoSha256,artifactSha256:fixtureBuild.artifactSha256,abiSha256:fixtureBuild.abiSha256,creationBytecodeSha256:fixtureBuild.creationBytecodeSha256}};
}
async function deriveOneBuild(output:string,buildName:string,artifactName:string,sourceName:string,contractName:string):Promise<JsonObject>{
  const buildBytes=await readStableOutputFile(join(output,buildName)); const artifactBytes=await readStableOutputFile(join(output,artifactName));
  const build=object(parseJsonWithoutDuplicateKeys(buildBytes.toString("utf8")),buildName); const input=object(build.input,"compiler input"); const settings=object(input.settings,"compiler settings");
  const optimizer=object(settings.optimizer,"optimizer"); const metadata=object(settings.metadata,"metadata"); const libraries=object(settings.libraries,"libraries"); const remappings=array(settings.remappings,"remappings").map(stringValue).toSorted();
  if(build.solcVersion!=="0.8.36+commit.8a079791"||settings.evmVersion!=="paris"||optimizer.enabled!==true||optimizer.runs!==200||metadata.bytecodeHash!=="ipfs"||metadata.appendCBOR!==true||metadata.useLiteralContent!==false||settings.viaIR!==false||settings.experimental!==false||Object.keys(libraries).length!==0||JSON.stringify(remappings)!==JSON.stringify(["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/","openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"])) throw invalid("raw compiler settings differ from the pinned profile");
  const sources=object(input.sources,"compiler sources"); const sourceHashes=Object.entries(sources).map(([path,value])=>{assertStrictRelativePath(path); const source=object(value,"compiler source"); const content=stringValue(source.content); return {path,sha256:`sha256:${hex(content)}`};}).toSorted((a,b)=>a.path.localeCompare(b.path));
  const artifact=object(parseJsonWithoutDuplicateKeys(artifactBytes.toString("utf8")),artifactName); const abi=array(artifact.abi,"artifact ABI"); const bytecode=stringValue(object(artifact.bytecode,"artifact bytecode").object); const normalized=bytecode.startsWith("0x")?bytecode:`0x${bytecode}`;
  if(!/^0x(?:[0-9a-fA-F]{2})+$/u.test(normalized)) throw invalid("artifact creation bytecode is malformed");
  const contracts=object(object(build.output,"compiler output").contracts,"compiler contracts");
  const sourceOutput=object(contracts[sourceName],"source output"); const contractOutput=object(sourceOutput[contractName],"contract output");
  const evm=object(contractOutput.evm,"evm"); const fromBuild=stringValue(object(evm.bytecode,"build bytecode").object);
  if(Buffer.from(fromBuild.replace(/^0x/u,""),"hex").compare(Buffer.from(normalized.slice(2),"hex"))!==0) throw invalid("artifact and build-info bytecode differ");
  return {buildInfoSha256:`sha256:${hex(buildBytes)}`,compilerInputSha256:`sha256:${hex(JSON.stringify(input))}`,compilerSettingsSha256:`sha256:${hex(JSON.stringify(settings))}`,compilerInput:input,compilerSettings:settings,sourceHashes,artifactSha256:`sha256:${hex(artifactBytes)}`,abiSha256:`sha256:${hex(JSON.stringify(abi))}`,creationBytecode:normalized,creationBytecodeSha256:`sha256:${hex(Buffer.from(normalized.slice(2),"hex"))}`};
}

async function readCanonicalTools(repositoryRoot: string, manifest: JsonObject): Promise<JsonObject> {
  const lock = object(parseJsonWithoutDuplicateKeys((await readStableCanonicalFile(join(repositoryRoot, "tooling/toolchain.lock.json"), "toolchain.lock.json")).toString("utf8")), "toolchain lock");
  const image = object(object(lock.securityImages, "securityImages").slither, "slither image");
  const versions = object(image.versions, "image versions");
  const manifestTools = object(manifest.tools, "manifest tools");
  const tools: JsonObject = {
    image: `${image.repository}:${image.tag}@${image.manifestDigest}`, indexDigest: String(image.indexDigest), imageRevision: image.sourceRevision,
    slither: versions.slither, cryticCompile: versions.cryticCompile, forge: versions.forge,
    forgeBinarySha256: `sha256:${manifestTools.forgeBinarySha256}`,
    solc: String(versions.solc).replace(/\.Linux\.g\+\+$/u, ""),
    solcBinarySha256: `sha256:${manifestTools.solcBinarySha256}`,
  };
  return tools;
}

export function assertAnalysisEvidenceSemantics(value: JsonObject, derived?: DerivedBundle): void {
  const context = readAnalysisContext(value);
  assertFindingClassifications(context);
  if (derived) {assertDerivedAnalysis(value, context, derived);}
}

interface AnalysisContext {
  readonly category: unknown;
  readonly analysis: JsonObject;
  readonly policy: JsonObject;
  readonly findings: readonly JsonObject[];
}

function readAnalysisContext(value: JsonObject): AnalysisContext {
  const result = object(value.result, "result");
  const category = result.category;
  if (!((category === "clean" && result.exitCode === 0) || (category === "policy-failure" && result.exitCode === 20))) {
    throw invalid("analysis category and exit status matrix differ");
  }
  const analysis = object(value.analysis, "analysis");
  const policy = object(value.policy, "policy");
  const findings = array(analysis.findings, "analysis.findings").map((finding) => object(finding, "finding"));
  if (analysis.findingCount !== findings.length) {throw invalid("finding count differs from findings");}
  const perImpact = object(analysis.perImpact, "analysis.perImpact");
  for (const impact of IMPACTS) {
    if (perImpact[impact] !== findings.filter((finding) => finding.impact === impact).length) {
      throw invalid("per-impact counts differ from findings");
    }
  }
  const errors = array(policy.errors, "policy.errors");
  if (errors.length !== 0) {throw invalid("analysis evidence cannot serialize tool or output errors");}
  return {category, analysis, policy, findings};
}

function assertFindingClassifications(context: AnalysisContext): void {
  const {analysis, category, findings, policy} = context;
  const suppressed = findings.filter((finding) => finding.suppressed === true).length;
  const blocking = findings.filter((finding) => finding.blocking === true).length;
  for (const finding of findings) {
    const shouldBlock = finding.suppressed === false && (finding.impact === "High" || finding.impact === "Medium");
    if (finding.blocking !== shouldBlock) {throw invalid("finding blocking status differs from severity policy");}
  }
  if (analysis.suppressions !== suppressed || policy.suppressed !== suppressed || policy.blocking !== blocking
    || policy.visible !== findings.length - suppressed || analysis.triaged !== findings.filter((finding) => finding.suppressed === false
      && ["Low", "Informational", "Optimization"].includes(String(finding.impact))).length
    || (category === "policy-failure") !== (blocking > 0)) {
    throw invalid("finding classifications differ from independently derived counts");
  }
}

function assertDerivedAnalysis(value: JsonObject, context: AnalysisContext, derived: DerivedBundle): void {
  const {analysis, findings} = context;
  const inputs = object(value.inputs, "inputs");
  if (inputs.closureHash !== derived.closureHash || inputs.configHash !== derived.configHash
    || inputs.policyHash !== derived.policyHash || inputs.triageHash !== derived.triageHash) {
    throw invalid("input hashes differ from canonical production inputs");
  }
  if (!same(array(analysis.expectedTargets, "expectedTargets"), derived.targets)
    || !same(array(analysis.observedTargets, "observedTargets"), derived.targets)
    || !same(array(analysis.expectedSources, "expectedSources"), derived.sources)
    || !same(array(analysis.observedSources, "observedSources"), derived.sources)
    || !same(array(analysis.detectors, "detectors"), derived.detectors)
    || !deepEqual(findings, derived.findings.map((finding) => ({
      ...finding,
      blocking: !derived.suppressed.has(String(finding.fingerprint)) && (finding.impact === "High" || finding.impact === "Medium"),
      suppressed: derived.suppressed.has(String(finding.fingerprint)),
    })))) {
    throw invalid("summary targets, sources, detectors or findings differ from raw evidence");
  }
  const evidenceTools = object(value.tools, "tools");
  if (!deepEqual(analysis.compiler, derived.compiler) || !deepEqual(analysis.fixture, derived.fixture)
    || analysis.creationBytecodeSha256 !== `sha256:${derived.manifest.creationBytecodeSha256}`
    || Object.keys(derived.tools).some((field) => evidenceTools[field] !== derived.tools[field])
    || Object.keys(evidenceTools).length !== Object.keys(derived.tools).length) {
    throw invalid("bytecode or tool identity differs from canonical inputs");
  }
}

function validateRawFinding(finding: JsonObject): JsonObject {
  const identity = stringValue(finding.identity).replaceAll("\\", "/").replace(/\s+/gu, " ").trim();
  const path = stringValue(finding.path).replaceAll("\\", "/");
  if (!path.startsWith("contracts/evm/") || path.includes("/../") || !Number.isSafeInteger(finding.start)
    || !Number.isSafeInteger(finding.length) || Number(finding.start) < 0 || Number(finding.length) < 1
    || !IMPACTS.includes(finding.impact as (typeof IMPACTS)[number])) {throw invalid("raw finding tuple is malformed");}
  const identityHash = `sha256:${hex(identity)}`;
  const fingerprintInput = ["agtmai-slither-finding-v1", finding.detectorId, path, String(finding.start), String(finding.length), finding.sourceHash, finding.snippetHash, identityHash].join("\n");
  const expected = ["detectorId", "impact", "confidence", "identity", "path", "start", "length", "sourceHash", "snippetHash"];
  if (JSON.stringify(Object.keys(finding).toSorted()) !== JSON.stringify(expected.toSorted())) {
    throw invalid("raw finding contains derived or incomplete fields");
  }
  return {
    detectorId: finding.detectorId, impact: finding.impact, confidence: finding.confidence,
    identity, findingIdentityHash: identityHash, fingerprint: `sha256:${hex(fingerprintInput)}`,
    path, start: finding.start, length: finding.length,
    sourceHash: finding.sourceHash, snippetHash: finding.snippetHash,
  };
}

function exactSuppression(finding: JsonObject, suppression: JsonObject): boolean {
  return ["fingerprint", "detectorId", "findingIdentityHash", "sourceHash", "snippetHash"]
    .every((field) => suppression[field] === finding[field])
    && suppression.path === finding.path && suppression.start === finding.start && suppression.length === finding.length;
}

export function renderAnalysisSummary(value: JsonObject): string {
  const result = object(value.result, "result"); const analysis = object(value.analysis, "analysis");
  const policy = object(value.policy, "policy"); const findings = array(analysis.findings, "findings").map((item) => object(item, "finding"));
  const targets = array(analysis.observedTargets, "targets").map(stringValue);
  return ["# Slither security gate", "", `Result: ${result.category} (exit ${result.exitCode})`,
    `Findings: ${findings.length}; blocking: ${policy.blocking}; suppressed: ${policy.suppressed}`,
    `Targets: ${targets.join(", ")}`,
    ...findings.map((finding) => `- ${finding.impact} ${finding.detectorId} at ${finding.path}:${finding.start} (${finding.suppressed === true ? "suppressed" : finding.blocking === true ? "blocking" : "visible"})`), ""].join("\n");
}

function assertExecution(value: JsonObject, mode: "local" | "ci"): void {
  if (mode === "local") {return;}
  if (process.env.GITHUB_ACTIONS !== "true") {throw invalid("CI finalization mode requires GitHub Actions");}
  const execution = object(value.execution, "execution");
  const bindings = { event: "GITHUB_EVENT_NAME", repository: "GITHUB_REPOSITORY", workflow: "GITHUB_WORKFLOW", job: "GITHUB_JOB", runId: "GITHUB_RUN_ID", runAttempt: "GITHUB_RUN_ATTEMPT" } as const;
  for (const [field, name] of Object.entries(bindings)) {
    const current = process.env[name];
    if (!current || execution[field] !== current) {throw invalid(`execution ${field} differs from current CI environment`);}
  }
}

function uniqueSortedStrings(value: unknown, label: string): string[] {
  const values = array(value, label).map(stringValue);
  if (new Set(values).size !== values.length || !same(values, values.toSorted())) {throw invalid(`${label} must be unique and sorted`);}
  return values;
}
function uniqueStrings(value: unknown, label: string): string[] {
  const values = array(value, label).map(stringValue);
  if (new Set(values).size !== values.length) {throw invalid(`${label} must be unique`);}
  return values;
}
function assertExactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify([...expected].toSorted())) {
    throw invalid(`${label} has missing or unexpected fields`);
  }
}
const same = (left: readonly unknown[], right: readonly unknown[]): boolean => JSON.stringify([...left].toSorted()) === JSON.stringify([...right].toSorted());
const deepEqual = (left: unknown, right: unknown): boolean => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonical);}
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
const hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const stringValue = (value: unknown): string => {if (typeof value !== "string") {throw invalid("expected string");} return value;};
function schemaName(variant: Variant): string {return variant === "evidence.json" ? "evidence-report.schema.v1.json" : `${variant.slice(0, -5)}.schema.v1.json`;}
async function assertRegularDirectory(path: string): Promise<void> {const info = await lstat(path, { bigint: true }); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777n) !== 0o700n || info.uid !== BigInt(process.getuid?.() ?? -1)) {throw invalid("bundle is not a regular directory");}}
async function assertRegularFile(path: string): Promise<void> {const info = await lstat(path, { bigint: true }); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || (info.mode & 0o777n) !== 0o600n || info.uid !== BigInt(process.getuid?.() ?? -1)) {throw invalid("bundle entry is not a regular file");}}
async function readStableOutputFile(path: string): Promise<Buffer> { const before = await lstat(path, { bigint: true }); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {throw invalid("raw output is not a sealed regular file");} const handle = await (await import("node:fs/promises")).open(path, 0 | 131072); try { const opened = await handle.stat({ bigint: true }); if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1n) {throw invalid("raw output identity changed");} const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.nlink !== 1n) {throw invalid("raw output changed during read");} return bytes; } finally { await handle.close(); } }
function assertStrictRelativePath(value: string): void {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {throw invalid(`unsafe canonical path: ${value}`);}
}

async function readStableCanonicalFile(path: string, label: string): Promise<Buffer> {
  let parent = dirname(path);
  while (parent !== dirname(parent)) {
    const parentInfo = await lstat(parent, { bigint: true });
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {throw invalid(`canonical input parent is symlinked or invalid: ${label}`);}
    parent = dirname(parent);
  }
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) {throw invalid(`canonical input is not a sealed regular file: ${label}`);}
  const handle = await (await import("node:fs/promises")).open(path, 0 | 131072);
  try { const opened = await handle.stat({ bigint: true }); if (opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink !== 1n) {throw invalid(`canonical input identity changed: ${label}`);} const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.nlink !== 1n) {throw invalid(`canonical input changed during read: ${label}`);} return bytes; } finally { await handle.close(); }
}

function object(value: unknown, name: string): JsonObject {if (value === null || typeof value !== "object" || Array.isArray(value)) {throw invalid(`${name} is not an object`);} return value as JsonObject;}
function array(value: unknown, name: string): unknown[] {if (!Array.isArray(value)) {throw invalid(`${name} is not an array`);} return value;}
function invalid(message: string): SlitherGateError {return new SlitherGateError("EVIDENCE_BUNDLE_INVALID", message);}
