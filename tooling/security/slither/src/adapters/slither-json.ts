import { readFile } from "node:fs/promises";
import type { Finding, Impact } from "../domain/model.ts";
import { IMPACTS, SlitherGateError } from "../domain/model.ts";
import { findingFingerprint, normalizedIdentityHash, normalizeIdentity, normalizeRepositoryPath, sourceLocation } from "./fingerprint.ts";
import { parseJsonWithoutDuplicateKeys } from "./json-schema.ts";

type JsonObject = Record<string, unknown>;
const object = (value: unknown, label: string): JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new SlitherGateError("MALFORMED_JSON", `${label} must be an object`);}
  return value as JsonObject;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {throw new SlitherGateError("MALFORMED_JSON", `${label} must be a non-empty string`);}
  return value;
};
const integer = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {throw new SlitherGateError("MALFORMED_JSON", `${label} must be a non-negative integer`);}
  return value as number;
};

export interface ParsedSlither { readonly success: boolean; readonly findings: readonly Finding[]; readonly errors: readonly string[] }
export interface SlitherInventory { readonly success: boolean; readonly contracts: readonly string[]; readonly sources: readonly string[]; readonly errors: readonly string[] }

export async function parseSlitherJson(raw: string, repositoryRoot: string): Promise<ParsedSlither> {
  let decoded: unknown;
  try { decoded = parseJsonWithoutDuplicateKeys(raw); } catch { throw new SlitherGateError("MALFORMED_JSON", "Slither output is not unambiguous JSON"); }
  const root = object(decoded, "output");
  if (Object.keys(root).some((key) => !["success", "results", "error"].includes(key))) throw new SlitherGateError("MALFORMED_JSON", "output contains unexpected fields");
  if (typeof root.success !== "boolean") {throw new SlitherGateError("MALFORMED_JSON", "success must be boolean");}
  const results = root.results === undefined && root.success === false ? {} : object(root.results, "results");
  if (root.success === true && !Array.isArray(results.detectors)) {throw new SlitherGateError("MALFORMED_JSON", "results.detectors must be an array");}
  if (results.detectors !== undefined && !Array.isArray(results.detectors)) {throw new SlitherGateError("MALFORMED_JSON", "results.detectors must be an array");}
  const findings = await Promise.all(
    (results.detectors ?? []).map(async (rawDetector, index) =>
      await parseFinding(rawDetector, index, repositoryRoot)),
  );
  const errors = optionalErrorArray(results.errors, "results.errors");
  if (root.error !== undefined && root.error !== null) {errors.push(string(root.error, "error"));}
  return {
    success: root.success,
    findings: findings.toSorted((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
    errors: errors.toSorted(),
  };
}

function optionalErrorArray(value: unknown, label: string): string[] {
  // Slither 0.11.6 emits JSON null for an absent error collection. Treat only
  // that pinned canonical sentinel (and an omitted optional field) as empty;
  // every other non-array shape still fails closed.
  if (value === undefined || value === null) {return [];}
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new SlitherGateError("MALFORMED_JSON", `${label} must be an array of non-empty strings`);
  }
  return [...value];
}

export function parseSlitherInventory(raw: string): SlitherInventory {
  let decoded: unknown;
  try { decoded = parseJsonWithoutDuplicateKeys(raw); } catch { throw new SlitherGateError("MALFORMED_JSON", "Slither inventory is not unambiguous JSON"); }
  const root = object(decoded, "inventory");
  if (typeof root.success !== "boolean") {throw new SlitherGateError("MALFORMED_JSON", "inventory success must be boolean");}
  const contracts = exactStringArray(root.contracts, "inventory contracts");
  const sources = exactStringArray(root.sources, "inventory sources");
  const errors = exactStringArray(root.errors, "inventory errors");
  if (Object.keys(root).toSorted().join(",") !== "contracts,errors,sources,success") {
    throw new SlitherGateError("MALFORMED_JSON", "inventory contains missing or unexpected fields");
  }
  if (root.success && (contracts.length === 0 || sources.length === 0)) {
    throw new SlitherGateError("SLITHER_INVENTORY_EMPTY", "Slither printer omitted analyzed contracts or sources");
  }
  return { success: root.success, contracts, sources, errors };
}

function exactStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new SlitherGateError("MALFORMED_JSON", `${label} must be a string array`);
  }
  const sorted = [...value].toSorted();
  if (new Set(value).size !== value.length || value.some((item, index) => item !== sorted[index])) {
    throw new SlitherGateError("MALFORMED_JSON", `${label} must be unique and sorted`);
  }
  return value;
}

async function parseFinding(
  rawDetector: unknown,
  index: number,
  repositoryRoot: string,
): Promise<Finding> {
  const detector = object(rawDetector, `detector[${index}]`);
  if (Object.keys(detector).some((key) => !["check", "impact", "confidence", "description", "markdown", "elements"].includes(key))) throw new SlitherGateError("MALFORMED_JSON", "detector contains unexpected fields");
  const detectorId = string(detector.check, "check");
  const impact = parseImpact(detector.impact);
  const confidence = string(detector.confidence, "confidence");
  const rawIdentity = string(detector.description ?? detector.markdown, "description");
  const identity = normalizeFindingIdentity(rawIdentity, repositoryRoot);
  const mapping = sourceMapping(detector.elements);
  const relative = findingPath(mapping);
  const source = await readFile(`${repositoryRoot}/${relative}`, "utf8");
  const location = sourceLocation(
    relative,
    integer(mapping.start, "start"),
    integer(mapping.length, "length"),
    source,
  );
  const base = {
    detectorId,
    impact,
    confidence,
    identity,
    findingIdentityHash: normalizedIdentityHash(identity),
    location,
  };
  return { ...base, fingerprint: findingFingerprint(base) };
}

function parseImpact(value: unknown): Impact {
  const impact = string(value, "impact");
  if (!IMPACTS.includes(impact as Impact)) {
    throw new SlitherGateError("MALFORMED_JSON", `unsupported impact ${impact}`);
  }
  return impact as Impact;
}

function normalizeFindingIdentity(value: string, repositoryRoot: string): string {
  return normalizeIdentity(
    value
      .replaceAll(repositoryRoot.replaceAll("\\", "/"), "")
      .replaceAll("/work/contracts/evm", "contracts/evm"),
  );
}

function sourceMapping(elements: unknown): JsonObject {
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new SlitherGateError("MALFORMED_JSON", "finding has no source elements");
  }
  return object(object(elements[0], "element").source_mapping, "source_mapping");
}

function findingPath(mapping: JsonObject): string {
  const reported = string(mapping.filename_relative ?? mapping.filename_absolute, "filename");
  const normalized = normalizeRepositoryPath(reported);
  const relative = normalized.startsWith("src/") || normalized.startsWith("lib/")
    ? `contracts/evm/${normalized}`
    : normalized;
  if (!relative.startsWith("contracts/evm/")) {
    throw new SlitherGateError("MALFORMED_JSON", "finding path is outside production closure");
  }
  return relative;
}

export function parseDetectorInventory(raw: string): readonly string[] {
  const lines = raw.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  const row = /^\|\s*(\d+)\s*\|\s*`?([a-z0-9-]+)`?\s*\|/u;
  if (lines.length === 0) throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", "detector inventory is empty");
  const rows = lines.map((line) => row.exec(line)).filter((m): m is RegExpExecArray => m !== null);
  if (rows.length !== lines.length) {
    const header = /^\|?\s*Detector\s*\|/u.test(lines[0] ?? "");
    const separator = /^\|?[\s:-]+\|/u.test(lines[1] ?? "");
    if (!(header && separator && rows.length === lines.length - 2)) throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", "detector inventory grammar is invalid");
  }
  const numbers = rows.map((m) => Number(m[1]));
  if (numbers.some((n, i) => n !== i + 1)) throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", "detector inventory numbering is not contiguous");
  const ids = rows.map((m) => m[2]!); if (new Set(ids).size !== ids.length) throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", "detector inventory is duplicated");
  return ids.toSorted();
}
