import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { IMPACTS, SlitherGateError } from "../domain/model.ts";
import { classifyGateFailure, isGateErrorCode } from "../application/failure.ts";
import { assertSerializedAgainstSchema, parseJsonWithoutDuplicateKeys } from "./json-schema.ts";

const ANALYSIS_FILES = [
  "READY", "detector-inventory.json", "evidence.json", "slither-inventory.json",
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
  if (!request.output.startsWith("/") || !/^[0-9a-f]{40}$/u.test(request.candidateSha)) {
    throw invalid("an absolute bundle path and exact candidate SHA are required");
  }
  await assertRegularDirectory(request.output);
  const entries = (await readdir(request.output)).toSorted();
  const variants = (Object.keys(VARIANTS) as Variant[]).filter((name) => entries.includes(name));
  if (variants.length !== 1) {throw invalid(`expected exactly one evidence variant, found ${variants.length}`);}
  const variant = variants[0]!;
  if (JSON.stringify(entries) !== JSON.stringify([...VARIANTS[variant]].toSorted())) {
    throw invalid("bundle has missing or extra entries");
  }
  for (const name of entries) {await assertRegularFile(join(request.output, name));}
  if ((await readFile(join(request.output, "READY"))).length !== 0) {throw invalid("READY must be empty");}

  const serialized = await readFile(join(request.output, variant), "utf8");
  await assertSerializedAgainstSchema(serialized, join(request.schemaDirectory, schemaName(variant)));
  const value = object(parseJsonWithoutDuplicateKeys(serialized), "evidence");
  if (value.candidateSha !== request.candidateSha) {throw invalid("evidence candidate SHA differs from the upload candidate");}
  assertExecution(value, request.finalizationMode ?? (process.env.GITHUB_ACTIONS === "true" ? "ci" : "local"));
  if (variant !== "evidence.json") {await assertFailureEvidence(value, request.schemaDirectory); return;}

  const derived = await deriveRawBundle(request.output, request.canonicalDirectory ?? request.schemaDirectory, request.schemaDirectory);
  assertAnalysisEvidenceSemantics(value, derived);
  const summary = await readFile(join(request.output, "summary.md"), "utf8");
  if (summary !== renderAnalysisSummary(value)) {throw invalid("summary differs from independently derived evidence");}
}

async function assertFailureEvidence(value: JsonObject, schemaDirectory: string): Promise<void> {
  const errorCode = stringValue(value.errorCode);
  if (!isGateErrorCode(errorCode)) {throw invalid("failure code is outside the exhaustive registry");}
  const classification = classifyGateFailure(errorCode);
  if (value.category !== classification.category || value.exitCode !== classification.exitCode || value.stage !== classification.stage) {
    throw invalid("failure envelope differs from the exhaustive registry");
  }
  const lock = object(parseJsonWithoutDuplicateKeys(await readFile(join(schemaDirectory, "../../toolchain.lock.json"), "utf8")), "toolchain lock");
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
}

async function deriveRawBundle(output: string, directory: string, schemaDirectory: string): Promise<DerivedBundle> {
  const manifestRaw = await readFile(join(directory, "production-closure.v1.json"), "utf8");
  const manifest = object(parseJsonWithoutDuplicateKeys(manifestRaw), "production manifest");
  if (manifest.schemaVersion !== 1) {throw invalid("production manifest version is invalid");}
  const targets = uniqueStrings(manifest.expectedContracts, "manifest.expectedContracts");
  const sourcePaths = uniqueStrings(array(manifest.sources, "manifest.sources").map((entry) => object(entry, "source").path), "manifest source paths");
  const sources = sourcePaths.map((path) => path.replace(/^contracts\/evm\//u, ""));
  const manifestTargets = array(manifest.targets, "manifest.targets").map((entry) => object(entry, "manifest target"));
  if (manifestTargets.length === 0 || manifestTargets.some((entry) => !targets.includes(stringValue(entry.contract))
    || !sourcePaths.includes(stringValue(entry.path)))) {throw invalid("canonical target manifest is malformed");}
  const closure = [
    ...array(manifest.sources, "manifest.sources"),
    ...array(manifest.config, "manifest.config"),
    object(manifest.detectorInventory, "manifest.detectorInventory"),
  ];
  const repositoryRoot = join(schemaDirectory, "../../..");
  if (directory === schemaDirectory) {
    for (const rawEntry of closure) {
      const entry = object(rawEntry, "closure entry");
      const bytes = await readFile(join(repositoryRoot, stringValue(entry.path)));
      if (hex(bytes) !== entry.sha256) {throw invalid(`canonical closure input differs: ${entry.path}`);}
    }
  }
  const detectorEntry = object(manifest.detectorInventory, "manifest.detectorInventory");
  const acceptedDetectorBytes = await readFile(join(directory, basename(String(detectorEntry.path))));
  if (hex(acceptedDetectorBytes) !== detectorEntry.sha256) {throw invalid("canonical detector inventory hash differs from manifest");}
  const acceptedDetectorDocument = object(parseJsonWithoutDuplicateKeys(acceptedDetectorBytes.toString("utf8")), "canonical detector inventory");
  if (acceptedDetectorDocument.schemaVersion !== 1 || acceptedDetectorDocument.slitherVersion !== "0.11.6") {
    throw invalid("canonical detector inventory identity is invalid");
  }
  const acceptedDetectors = uniqueSortedStrings(acceptedDetectorDocument.detectors, "canonical detectors");

  const rawAnalysis = object(parseJsonWithoutDuplicateKeys(await readFile(join(output, "slither.json"), "utf8")), "slither.json");
  const rawInventory = object(parseJsonWithoutDuplicateKeys(await readFile(join(output, "slither-inventory.json"), "utf8")), "slither-inventory.json");
  const rawDetectors = object(parseJsonWithoutDuplicateKeys(await readFile(join(output, "detector-inventory.json"), "utf8")), "detector-inventory.json");
  const status = object(parseJsonWithoutDuplicateKeys(await readFile(join(output, "slither-status.json"), "utf8")), "slither-status.json");
  assertExactKeys(rawAnalysis, ["schemaVersion", "success", "errors", "findings"], "slither.json");
  assertExactKeys(rawInventory, ["schemaVersion", "success", "contracts", "sources", "errors"], "slither-inventory.json");
  assertExactKeys(rawDetectors, ["schemaVersion", "detectors"], "detector-inventory.json");
  assertExactKeys(status, ["schemaVersion", "analysisExit", "inventoryExit"], "slither-status.json");
  const findings = array(rawAnalysis.findings, "raw findings").map((finding) => validateRawFinding(object(finding, "raw finding")));
  const targetsObserved = uniqueSortedStrings(rawInventory.contracts, "raw contracts");
  const sourcesObserved = uniqueSortedStrings(rawInventory.sources, "raw sources");
  const detectorsObserved = uniqueSortedStrings(rawDetectors.detectors, "raw detectors");
  if (rawAnalysis.schemaVersion !== 1 || rawInventory.schemaVersion !== 1 || rawDetectors.schemaVersion !== 1 || status.schemaVersion !== 1
    || rawAnalysis.success !== true || rawInventory.success !== true
    || array(rawAnalysis.errors, "analysis errors").length !== 0 || array(rawInventory.errors, "inventory errors").length !== 0
    || status.analysisExit !== (findings.length === 0 ? 0 : 255) || status.inventoryExit !== 0) {
    throw invalid("raw analysis status matrix is invalid");
  }
  if (!same(targets, targetsObserved) || !same(sources, sourcesObserved) || !same(acceptedDetectors, detectorsObserved)) {
    throw invalid("raw targets, sources or detectors differ from canonical production inputs");
  }
  if (findings.some((finding) => !acceptedDetectors.includes(stringValue(finding.detectorId)))) {
    throw invalid("raw finding uses a detector outside the canonical inventory");
  }
  const sourceHashes = new Map(array(manifest.sources, "manifest.sources").map((rawEntry) => {
    const entry = object(rawEntry, "source entry"); return [stringValue(entry.path), stringValue(entry.sha256)] as const;
  }));
  if (findings.some((finding) => sourceHashes.get(stringValue(finding.path)) !== String(finding.sourceHash).replace(/^sha256:/u, ""))) {
    throw invalid("raw finding source hash differs from the canonical source");
  }

  const configBytes = await readFile(join(directory, "slither.config.json"));
  const policyBytes = await readFile(join(directory, "suppressions.v1.json"));
  const triageBytes = await readFile(join(directory, "triage.v1.json"));
  await assertSerializedAgainstSchema(policyBytes.toString("utf8"), join(schemaDirectory, "suppression-ledger.schema.v1.json"));
  await assertSerializedAgainstSchema(triageBytes.toString("utf8"), join(schemaDirectory, "triage-ledger.schema.v1.json"));
  const policy = object(parseJsonWithoutDuplicateKeys(policyBytes.toString("utf8")), "suppression policy");
  const suppressions = array(policy.suppressions, "suppressions").map((item) => object(item, "suppression"));
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
  const triage = object(parseJsonWithoutDuplicateKeys(triageBytes.toString("utf8")), "triage policy");
  const triageValues = array(triage.findings, "triage findings").map((item) => stringValue(object(item, "triage").fingerprint));
  const triaged = new Set(triageValues);
  if (triaged.size !== triageValues.length) {throw invalid("canonical triage contains duplicate fingerprints");}
  const lowerVisible = findings.filter((finding) => !suppressed.has(stringValue(finding.fingerprint))
    && ["Low", "Informational", "Optimization"].includes(stringValue(finding.impact)))
    .map((finding) => stringValue(finding.fingerprint));
  if (!same([...triaged], lowerVisible)) {throw invalid("canonical triage does not exactly cover visible lower findings");}
  const lock = object(parseJsonWithoutDuplicateKeys(await readFile(join(repositoryRoot, "tooling/toolchain.lock.json"), "utf8")), "toolchain lock");
  const image = object(object(lock.securityImages, "securityImages").slither, "slither image");
  const versions = object(image.versions, "image versions");
  const manifestTools = object(manifest.tools, "manifest tools");
  const tools: JsonObject = {
    image: `${image.repository}:${image.tag}@${image.manifestDigest}`, imageRevision: image.sourceRevision,
    slither: versions.slither, cryticCompile: versions.cryticCompile, forge: versions.forge,
    forgeBinarySha256: `sha256:${manifestTools.forgeBinarySha256}`,
    solc: String(versions.solc).replace(/\.Linux\.g\+\+$/u, ""),
    solcBinarySha256: `sha256:${manifestTools.solcBinarySha256}`,
  };
  return {
    manifest, findings, targets, sources, detectors: acceptedDetectors,
    closureHash: `sha256:${hex(JSON.stringify(closure))}`,
    configHash: `sha256:${hex(configBytes)}`, policyHash: `sha256:${hex(policyBytes)}`,
    triageHash: `sha256:${hex(triageBytes)}`, suppressed, triaged, tools,
  };
}

export function assertAnalysisEvidenceSemantics(value: JsonObject, derived?: DerivedBundle): void {
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
  if (!derived) {return;}
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
  if (analysis.creationBytecodeSha256 !== `sha256:${derived.manifest.creationBytecodeSha256}`
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
  const canonical = ["agtmai-slither-finding-v1", finding.detectorId, path, String(finding.start), String(finding.length), finding.sourceHash, finding.snippetHash, identityHash].join("\n");
  const expected = ["detectorId", "impact", "confidence", "identity", "path", "start", "length", "sourceHash", "snippetHash"];
  if (JSON.stringify(Object.keys(finding).toSorted()) !== JSON.stringify(expected.toSorted())) {
    throw invalid("raw finding contains derived or incomplete fields");
  }
  return {
    detectorId: finding.detectorId, impact: finding.impact, confidence: finding.confidence,
    identity, findingIdentityHash: identityHash, fingerprint: `sha256:${hex(canonical)}`,
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
  const execution = object(value.execution, "execution");
  const bindings = { event: "GITHUB_EVENT_NAME", repository: "GITHUB_REPOSITORY", workflow: "GITHUB_WORKFLOW", job: "GITHUB_JOB", runId: "GITHUB_RUN_ID", runAttempt: "GITHUB_RUN_ATTEMPT" } as const;
  for (const [field, name] of Object.entries(bindings)) {
    const current = process.env[name];
    if ((mode === "ci" && !current) || (current && execution[field] !== current)) {throw invalid(`execution ${field} differs from current CI environment`);}
  }
  if (mode === "ci" && process.env.GITHUB_ACTIONS !== "true") {throw invalid("CI finalization mode requires GitHub Actions");}
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
async function assertRegularDirectory(path: string): Promise<void> {const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) {throw invalid("bundle is not a regular directory");}}
async function assertRegularFile(path: string): Promise<void> {const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) {throw invalid("bundle entry is not a regular file");}}
function object(value: unknown, name: string): JsonObject {if (value === null || typeof value !== "object" || Array.isArray(value)) {throw invalid(`${name} is not an object`);} return value as JsonObject;}
function array(value: unknown, name: string): unknown[] {if (!Array.isArray(value)) {throw invalid(`${name} is not an array`);} return value;}
function invalid(message: string): SlitherGateError {return new SlitherGateError("EVIDENCE_BUNDLE_INVALID", message);}
