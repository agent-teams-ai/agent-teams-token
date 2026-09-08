import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
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
  if (Object.keys(root).some((key) => !["success", "results", "error"].includes(key))) {throw new SlitherGateError("MALFORMED_JSON", "output contains unexpected fields");}
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
  validateDetectorMetadata(detector);
  const detectorId = string(detector.check, "check");
  const impact = parseImpact(detector.impact);
  const confidence = string(detector.confidence, "confidence");
  const rawIdentity = string(detector.description ?? detector.markdown, "description");
  const identity = normalizeFindingIdentity(rawIdentity, repositoryRoot);
  const mapping = sourceMapping(detector.elements);
  const relative = findingPath(mapping);
  const source = (await readStableSource(repositoryRoot, relative)).toString("utf8");
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

function validateDetectorMetadata(detector: JsonObject): void {
  const fields = ["check", "impact", "confidence", "description", "markdown", "elements", "id", "first_markdown_element", "reference"];
  if (Object.keys(detector).some((key) => !fields.includes(key))) {
    throw new SlitherGateError("MALFORMED_JSON", "detector contains unexpected fields");
  }
  for (const key of ["description", "markdown"]) {
    if (key in detector) {string(detector[key], key);}
  }
  // These optional Slither 0.11.6 fields are display metadata only. Never use
  // the analyzer id or Markdown link to derive our fingerprint or source path.
  if ("id" in detector && !/^[a-f0-9]{64}$/u.test(string(detector.id, "id"))) {
    throw new SlitherGateError("MALFORMED_JSON", "id must be a lowercase SHA256 hex string");
  }
  if ("reference" in detector && !/^https:\/\/github\.com\/crytic\/slither\/wiki\/Detector-Documentation#[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(string(detector.reference, "reference"))) {
    throw new SlitherGateError("MALFORMED_JSON", "reference must be an official detector documentation link");
  }
  if ("first_markdown_element" in detector) {validateMarkdownElement(detector.first_markdown_element);}
}

function validateMarkdownElement(value: unknown): void {
  const link = string(value, "first_markdown_element");
  const match = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.sol#L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(link);
  const start = Number(match?.[1]);
  const end = Number(match?.[2] ?? match?.[1]);
  if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw new SlitherGateError("MALFORMED_JSON", "first_markdown_element must be a relative Solidity link with an ordered line range");
  }
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
  const lines = raw.split(/\r?\n/u);
  if (lines.at(-1) === "") {lines.pop();}
  const pretty = lines[0]?.startsWith("+") === true;
  const rows = pretty ? prettyTableRows(lines) : markdownTableRows(lines);
  if (rows.length === 0) {invalidInventory("detector inventory is empty");}
  const ids = rows.map((cells, index) => {
    if (cells.length !== rows[0]!.length || cells[0] !== String(index + 1)) {
      invalidInventory("detector inventory numbering or row shape is invalid");
    }
    const id = pretty ? cells[1]! : cells[1]!.replace(/^`([a-z0-9-]+)`$/u, "$1");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)
      || !IMPACTS.includes(cells.at(-2) as Impact)
      || !["High", "Medium", "Low"].includes(cells.at(-1)!)) {
      invalidInventory("detector inventory row values are invalid");
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {invalidInventory("detector inventory is duplicated");}
  return ids.toSorted();
}

function prettyTableRows(lines: readonly string[]): string[][] {
  // Exact column widths and row count of the pinned 0.11.6 --list-detectors
  // PrettyTable. The caller still compares every normalized id to the manifest.
  const widths = [5, 31, 113, 15, 12];
  const border = `+${widths.map((width) => "-".repeat(width)).join("+")}+`;
  if (lines.length !== 105 || lines[0] !== border || lines[2] !== border || lines.at(-1) !== border) {
    invalidInventory("Slither 0.11.6 detector table borders or row count are invalid");
  }
  const header = prettyTableCells(lines[1]!, widths);
  if (header.join("|") !== "Num|Check|What it Detects|Impact|Confidence") {
    invalidInventory("Slither 0.11.6 detector table header is invalid");
  }
  return lines.slice(3, -1).map((line) => prettyTableCells(line, widths));
}

function prettyTableCells(line: string, widths: readonly number[]): string[] {
  const cells = inventoryCells(line);
  const expected = `|${cells.map((cell, index) => ` ${cell.padEnd((widths[index] ?? 2) - 2)} `).join("|")}|`;
  if (cells.length !== widths.length || line !== expected || line.length !== 182) {
    invalidInventory("Slither 0.11.6 detector table column layout is invalid");
  }
  return cells;
}

function markdownTableRows(lines: readonly string[]): string[][] {
  const rows = lines.map(inventoryCells);
  if (rows[0]?.[0] === "Detector") {
    const header = rows.shift()!;
    const separator = rows.shift();
    const labels = header.length === 4 ? "Detector|Check|Impact|Confidence" : "Detector|Check|What it Detects|Impact|Confidence";
    if (header.join("|") !== labels || separator?.length !== header.length
      || separator.some((cell) => !/^:?-{3,}:?$/u.test(cell)) || rows[0]?.length !== header.length) {
      invalidInventory("Markdown detector table header or separator is invalid");
    }
  }
  return rows;
}

function inventoryCells(line: string): string[] {
  const parts = line.split("|");
  if (parts.shift() !== "" || parts.pop() !== "" || ![4, 5].includes(parts.length)
    || parts.some((cell) => !/^[ -~]+$/u.test(cell) || cell.trim().length === 0)) {
    invalidInventory("detector inventory row grammar is invalid");
  }
  return parts.map((cell) => cell.trim());
}

function invalidInventory(message: string): never {
  throw new SlitherGateError("DETECTOR_INVENTORY_INVALID", message);
}

async function readStableSource(root: string, relative: string): Promise<Buffer> {
  const canonical = await realpath(root);
  const path = await realpath(`${canonical}/${relative}`);
  if (!path.startsWith(`${canonical}/`)) {throw new SlitherGateError("MALFORMED_JSON", "finding source escapes repository");}
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {throw new SlitherGateError("MALFORMED_JSON", "finding source is not a sealed file");}
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const opened = await handle.stat({ bigint: true }); if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1n) {throw new SlitherGateError("MALFORMED_JSON", "finding source changed");} const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ino !== opened.ino || after.dev !== opened.dev || after.nlink !== 1n) {throw new SlitherGateError("MALFORMED_JSON", "finding source mutated");} return bytes; } finally { await handle.close(); }
}
