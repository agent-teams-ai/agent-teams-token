import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SlitherGateError } from "../domain/model.ts";
import { assertSerializedAgainstSchema } from "./json-schema.ts";

const VARIANTS = {
  "evidence.json": ["READY", "evidence.json", "summary.md"],
  "environment-failure.json": ["READY", "environment-failure.json"],
  "output-failure.json": ["READY", "output-failure.json"],
} as const;

type Variant = keyof typeof VARIANTS;
type JsonObject = Record<string, unknown>;

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
  if (variant === "evidence.json") {assertAnalysisEvidenceSemantics(value);}
}

export function assertAnalysisEvidenceSemantics(value: JsonObject): void {
  const result = object(value.result, "result");
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
  const analysis = object(value.analysis, "analysis");
  const policy = object(value.policy, "policy");
  const findings = array(analysis.findings, "analysis.findings");
  if (analysis.findingCount !== findings.length) {throw invalid("finding count differs from findings");}
  if (!sameStringSet(analysis.expectedTargets, analysis.observedTargets)
    || !sameStringSet(analysis.expectedSources, analysis.observedSources)) {
    throw invalid("expected and observed analysis closure differ");
  }
  const suppressed = findings.filter((finding) => object(finding, "finding").suppressed === true).length;
  const blocking = findings.filter((finding) => object(finding, "finding").blocking === true).length;
  if (findings.some((finding) => {
    const item = object(finding, "finding"); return item.blocking === true && item.suppressed === true;
  })) {throw invalid("a finding cannot be both blocking and suppressed");}
  if (analysis.suppressions !== suppressed || policy.suppressed !== suppressed || policy.blocking !== blocking) {
    throw invalid("finding classifications differ from policy counts");
  }
  if (typeof policy.visible !== "number" || policy.visible < blocking || policy.visible > findings.length) {
    throw invalid("visible finding count is inconsistent");
  }
  const errors = array(policy.errors, "policy.errors");
  const validOutcome = (category === "clean" && blocking === 0 && errors.length === 0)
    || (category === "policy-failure" && blocking > 0 && errors.length === 0)
    || ((category === "tool-failure" || category === "output-failure") && blocking === 0 && errors.length > 0);
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
