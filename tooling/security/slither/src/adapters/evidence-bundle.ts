import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SlitherGateError } from "../domain/model.ts";
import { sha256 } from "./fingerprint.ts";
import { assertSerializedAgainstSchema } from "./json-schema.ts";

const VARIANTS = {
  "evidence.json": ["READY", "evidence.json", "summary.md"],
  "environment-failure.json": ["READY", "environment-failure.json"],
  "tool-failure.json": ["READY", "tool-failure.json"],
  "output-failure.json": ["READY", "output-failure.json"],
} as const;

type Variant = keyof typeof VARIANTS;
type JsonObject = Record<string, unknown>;

const EXPECTED_OUTCOMES: Readonly<Record<string, { readonly blocking: boolean; readonly errors: boolean }>> = {
  clean: { blocking: false, errors: false },
  "policy-failure": { blocking: true, errors: false },
  "tool-failure": { blocking: false, errors: true },
  "output-failure": { blocking: false, errors: true },
};

interface ValidationRequest {
  readonly output: string;
  readonly candidateSha: string;
  readonly schemaDirectory: string;
}

/** Reopens and independently validates the exact bundle that CI will upload. */
export async function validateFinalizedEvidenceBundle(request: ValidationRequest): Promise<void> {
  if (!request.output.startsWith("/") || !/^[0-9a-f]{40}$/u.test(request.candidateSha)) {
    throw invalid("an absolute bundle path and exact candidate SHA are required");
  }
  await assertRegularDirectory(request.output);
  const entries = (await readdir(request.output)).toSorted();
  const variants = (Object.keys(VARIANTS) as Variant[]).filter((name) => entries.includes(name));
  if (variants.length !== 1) {
    throw invalid(`expected exactly one evidence variant, found ${variants.length}`);
  }
  const variant = variants[0]!;
  const expected = [...VARIANTS[variant]].toSorted();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) {
    throw invalid("bundle has missing or extra entries");
  }
  for (const name of entries) {await assertRegularFile(join(request.output, name));}
  if ((await readFile(join(request.output, "READY"))).length !== 0) {
    throw invalid("READY must be an empty regular file");
  }

  const serialized = await readFile(join(request.output, variant), "utf8");
  await assertSerializedAgainstSchema(serialized, join(request.schemaDirectory, schemaName(variant)));
  const value = JSON.parse(serialized) as JsonObject;
  if (value.candidateSha !== request.candidateSha) {
    throw invalid("evidence candidate SHA differs from the upload candidate");
  }
  if (variant === "evidence.json") {
    assertAnalysisEvidenceSemantics(value);
    await assertAcceptedPolicyInputs(value, request.schemaDirectory);
    const summary = await readFile(join(request.output, "summary.md"), "utf8");
    if (summary !== renderAnalysisSummary(value)) {
      throw invalid("summary does not exactly match recomputed finding evidence");
    }
  }
}

export function assertAnalysisEvidenceSemantics(value: JsonObject): void {
  const result = object(value.result, "result");
  const category = assertResultStatus(result);
  const analysis = object(value.analysis, "analysis");
  const policy = object(value.policy, "policy");
  const findings = array(analysis.findings, "analysis.findings");
  assertAnalysisClosure(analysis, findings);
  const { blocking } = assertFindingClassifications(analysis, policy, findings);
  assertPolicyOutcome(category, policy, blocking, findings.length);
}

function assertResultStatus(result: JsonObject): string {
  const category = result.category;
  const expectedExit: Readonly<Record<string, number>> = {
    clean: 0,
    "policy-failure": 20,
    "tool-failure": 30,
    "output-failure": 40,
  };
  if (typeof category !== "string" || expectedExit[category] !== result.exitCode) {
    throw invalid("analysis category and exit status matrix differ");
  }
  return category;
}

function assertAnalysisClosure(analysis: JsonObject, findings: unknown[]): void {
  if (analysis.findingCount !== findings.length) {throw invalid("finding count differs from findings");}
  if (!sameStringSet(analysis.expectedTargets, analysis.observedTargets)
    || !sameStringSet(analysis.expectedSources, analysis.observedSources)) {
    throw invalid("expected and observed analysis closure differ");
  }
}

function assertFindingClassifications(
  analysis: JsonObject,
  policy: JsonObject,
  findings: unknown[],
): { readonly blocking: number } {
  const suppressed = findings.filter((finding) => object(finding, "finding").suppressed === true).length;
  const blocking = findings.filter((finding) => object(finding, "finding").blocking === true).length;
  const errors = array(policy.errors, "policy.errors");
  for (const finding of findings) {
    const item = object(finding, "finding");
    const shouldBlock = errors.length === 0 && item.suppressed === false
      && (item.impact === "High" || item.impact === "Medium");
    if (item.blocking !== shouldBlock) {
      throw invalid("finding blocking status differs from recomputed severity policy");
    }
  }
  const visible = errors.length > 0 ? findings.length : findings.length - suppressed;
  if (analysis.suppressions !== suppressed || policy.suppressed !== suppressed
    || policy.blocking !== blocking || policy.visible !== visible) {
    throw invalid("finding classifications differ from policy counts");
  }
  return { blocking };
}

export function renderAnalysisSummary(value: JsonObject): string {
  const result = object(value.result, "result");
  const analysis = object(value.analysis, "analysis");
  const policy = object(value.policy, "policy");
  const findings = array(analysis.findings, "analysis.findings").map((finding) => object(finding, "finding"));
  const targets = array(analysis.observedTargets, "analysis.observedTargets");
  if (targets.some((target) => typeof target !== "string")) { throw invalid("observed targets are malformed"); }
  const findingLines = findings.map((finding) => {
    const classification = finding.suppressed === true ? "suppressed" : finding.blocking === true ? "blocking" : "visible";
    return `- ${finding.impact} ${finding.detectorId} at ${finding.path}:${finding.start} (${classification})`;
  });
  return [
    "# Slither security gate", "",
    `Result: ${result.category} (exit ${result.exitCode})`,
    `Findings: ${findings.length}; blocking: ${policy.blocking}; suppressed: ${policy.suppressed}`,
    `Targets: ${(targets as string[]).join(", ")}`,
    ...findingLines,
    "",
  ].join("\n");
}

async function assertAcceptedPolicyInputs(value: JsonObject, directory: string): Promise<void> {
  const inputs = object(value.inputs, "inputs");
  const analysis = object(value.analysis, "analysis");
  const findings = array(analysis.findings, "analysis.findings").map((finding) => object(finding, "finding"));
  const files = {
    configHash: "slither.config.json",
    policyHash: "suppressions.v1.json",
    triageHash: "triage.v1.json",
  } as const;
  const serialized = new Map<string, string>();
  for (const [field, name] of Object.entries(files)) {
    const bytes = await readFile(join(directory, name));
    serialized.set(name, bytes.toString("utf8"));
    const digest = `sha256:${sha256(bytes)}`;
    if (inputs[field] !== digest) { throw invalid(`${field} differs from the accepted policy input`); }
  }
  await assertSerializedAgainstSchema(
    serialized.get(files.policyHash)!,
    join(directory, "suppression-ledger.schema.v1.json"),
  );
  await assertSerializedAgainstSchema(
    serialized.get(files.triageHash)!,
    join(directory, "triage-ledger.schema.v1.json"),
  );
  const suppressionDocument = JSON.parse(serialized.get(files.policyHash)!) as { suppressions: readonly { fingerprint: string }[] };
  const suppressionValues = suppressionDocument.suppressions.map(({ fingerprint }) => fingerprint);
  const suppressionFingerprints = new Set(suppressionValues);
  if (suppressionFingerprints.size !== suppressionValues.length) {
    throw invalid("accepted suppression ledger contains duplicate fingerprints");
  }
  for (const finding of findings) {
    if (finding.suppressed !== suppressionFingerprints.has(String(finding.fingerprint))) {
      throw invalid("finding suppression differs from the accepted suppression ledger");
    }
  }
  if ([...suppressionFingerprints].some((fingerprint) => !findings.some((finding) => finding.fingerprint === fingerprint))) {
    throw invalid("accepted suppression ledger contains an unused fingerprint");
  }
  const triageDocument = JSON.parse(serialized.get(files.triageHash)!) as { findings: readonly { fingerprint: string }[] };
  const triageValues = triageDocument.findings.map(({ fingerprint }) => fingerprint).toSorted();
  const lowerVisible = findings.filter((finding) => finding.suppressed === false
    && ["Low", "Informational", "Optimization"].includes(String(finding.impact)))
    .map((finding) => String(finding.fingerprint)).toSorted();
  if (new Set(triageValues).size !== triageValues.length
    || JSON.stringify(triageValues) !== JSON.stringify(lowerVisible)) {
    throw invalid("accepted triage ledger must exactly cover visible lower-impact findings");
  }
  if (analysis.triaged !== lowerVisible.length) {
    throw invalid("triaged finding count differs from independently derived findings");
  }
}

function assertPolicyOutcome(category: string, policy: JsonObject, blocking: number, findingCount: number): void {
  if (typeof policy.visible !== "number" || policy.visible < blocking || policy.visible > findingCount) {
    throw invalid("visible finding count is inconsistent");
  }
  const errors = array(policy.errors, "policy.errors");
  const expected = EXPECTED_OUTCOMES[category]!;
  const validOutcome = expected.blocking === (blocking > 0) && expected.errors === (errors.length > 0);
  if (!validOutcome) {throw invalid("analysis result contradicts policy semantics");}
}

function sameStringSet(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)
    || left.some((item) => typeof item !== "string") || right.some((item) => typeof item !== "string")) {return false;}
  const leftValues = (left as string[]).toSorted();
  const rightValues = (right as string[]).toSorted();
  return new Set(leftValues).size === leftValues.length
    && new Set(rightValues).size === rightValues.length
    && JSON.stringify(leftValues) === JSON.stringify(rightValues);
}

function schemaName(variant: Variant): string {
  return variant === "evidence.json" ? "evidence-report.schema.v1.json" : `${variant.slice(0, -5)}.schema.v1.json`;
}

async function assertRegularDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {throw invalid("bundle is not a regular directory");}
}

async function assertRegularFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {throw invalid("bundle entry is not a regular file");}
}

function object(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw invalid(`${name} is not an object`);}
  return value as JsonObject;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {throw invalid(`${name} is not an array`);}
  return value;
}

function invalid(message: string): SlitherGateError {
  return new SlitherGateError("EVIDENCE_BUNDLE_INVALID", message);
}
