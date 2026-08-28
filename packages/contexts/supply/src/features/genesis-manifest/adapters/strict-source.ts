import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  visit,
  type Document,
  type Node,
} from "yaml";
import { canonicalJson, type JsonValue } from "../application/canonical.js";
import {
  EXPECTED_TOKEN,
  UINT64_MAX,
  compareDiagnostics,
  normalizeLocalSource,
  parseCanonicalUint,
  type Diagnostic,
  type LocalGenesisSource,
  type SourcePosition,
  type ValidatedLocalGenesisSource,
} from "../domain/model.js";
import { PROPOSAL_LEAF_TYPES, type ProposalScalarType } from "./proposal-contract.js";

export interface ParsedSource<T> {
  readonly diagnostics: Diagnostic[];
  readonly value?: T;
  readonly canonicalBytes?: Uint8Array;
}

interface StrictParse {
  readonly diagnostics: Diagnostic[];
  readonly positions: ReadonlyMap<string, SourcePosition>;
  readonly value?: unknown;
}

const LOCAL_KEYS = {
  "": ["schemaVersion", "purpose", "status", "network", "token", "allocations"],
  "/network": ["kind", "chainId"],
  "/token": ["name", "symbol", "decimals", "initialSupplyBaseUnits"],
  "/allocations/*": ["id", "recipient", "amountBaseUnits", "bps"],
} as const;

const proposalChildren = buildProposalChildren();

export function parseLocalSource(text: string): ParsedSource<ValidatedLocalGenesisSource> {
  const parsed = parseStrict(text);
  if (parsed.value === undefined) {
    return { diagnostics: parsed.diagnostics };
  }
  const shapeDiagnostics = validateLocalShape(parsed.value);
  if (shapeDiagnostics.some((diagnostic) => diagnostic.code !== "GENESIS_SCHEMA_UNKNOWN_FIELD")) {
    return { diagnostics: positioned([...parsed.diagnostics, ...shapeDiagnostics], parsed.positions) };
  }
  const value = parsed.value as LocalGenesisSource;
  const semantic = normalizeLocalSource(value).diagnostics;
  const diagnostics = positioned([...parsed.diagnostics, ...shapeDiagnostics, ...semantic], parsed.positions);
  if (diagnostics.length > 0) {
    return { diagnostics };
  }
  return {
    diagnostics,
    value: value as ValidatedLocalGenesisSource,
    canonicalBytes: Buffer.from(canonicalJson(value as unknown as JsonValue), "utf8"),
  };
}

export function parseProposal(text: string): ParsedSource<Record<string, unknown>> {
  const parsed = parseStrict(text);
  if (parsed.value === undefined) {
    return { diagnostics: parsed.diagnostics };
  }
  const object = asRecord(parsed.value);
  const diagnostics = object === undefined
    ? [problem("GENESIS_SCHEMA_TYPE", "", "must be an object")]
    : [...validateProposalShape(object), ...validateProposalSemantics(object)];
  const all = positioned([...parsed.diagnostics, ...diagnostics], parsed.positions);
  return all.length > 0 || object === undefined ? { diagnostics: all } : { diagnostics: all, value: object };
}

function parseStrict(text: string): StrictParse {
  if (text.trim().length === 0) {
    return { diagnostics: [problem("GENESIS_SOURCE_EMPTY", "", "source must not be empty")], positions: new Map() };
  }
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, {
    lineCounter,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  const diagnostics: Diagnostic[] = [];
  if (documents.length !== 1) {
    diagnostics.push(problem("GENESIS_SOURCE_DOCUMENT_COUNT", "", "source must contain exactly one YAML/JSON document"));
  }
  for (const document of documents) {
    collectParserDiagnostics(document, lineCounter, diagnostics);
  }
  const document = documents[0];
  if (!document?.contents) {
    if (diagnostics.length === 0) {diagnostics.push(problem("GENESIS_SOURCE_EMPTY", "", "source must not be empty"));}
    return { diagnostics: diagnostics.toSorted(compareDiagnostics), positions: new Map() };
  }
  visit(document, (_key, node) => inspectNode(node, lineCounter, diagnostics));
  if (diagnostics.length > 0) {
    return { diagnostics: dedupe(diagnostics), positions: new Map() };
  }
  const positions = new Map<string, SourcePosition>();
  collectPositions(document.contents, "", lineCounter, positions);
  try {
    return {
      diagnostics: [],
      positions,
      value: document.toJS({ maxAliasCount: 0, mapAsMap: false }),
    };
  } catch {
    return {
      diagnostics: [problem("GENESIS_SOURCE_CONVERSION_FAILED", "", "source could not be converted without aliases")],
      positions,
    };
  }
}

function inspectNode(node: unknown, lines: LineCounter, diagnostics: Diagnostic[]): void {
  const candidate = node as Node & { anchor?: string; tag?: string; range?: [number, number, number] };
  if (isAlias(node)) {
    diagnostics.push(at("GENESIS_SOURCE_ALIAS_FORBIDDEN", "aliases are forbidden", candidate.range?.[0], lines));
  }
  if (candidate.anchor) {
    diagnostics.push(at("GENESIS_SOURCE_ANCHOR_FORBIDDEN", "anchors are forbidden", candidate.range?.[0], lines));
  }
  if (candidate.tag) {
    diagnostics.push(at("GENESIS_SOURCE_TAG_FORBIDDEN", "explicit tags are forbidden", candidate.range?.[0], lines));
  }
  if (isScalar(node) && typeof node.value === "number" && !/^(0|[1-9][0-9]*)$/.test(String(node.source))) {
    diagnostics.push(at("GENESIS_SOURCE_UNSUPPORTED_SCALAR", "numeric scalars must be canonical non-negative decimal integers", node.range?.[0], lines));
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        diagnostics.push(at("GENESIS_SOURCE_NON_STRING_KEY", "mapping keys must be strings", rangeStart(pair.key), lines));
      } else if (pair.key.value === "<<") {
        diagnostics.push(at("GENESIS_SOURCE_MERGE_FORBIDDEN", "merge keys are forbidden", pair.key.range?.[0], lines));
      }
    }
  }
}

function validateLocalShape(value: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const root = requireObject(value, "", diagnostics);
  if (!root) {
    return diagnostics;
  }
  exactKeys(root, "", LOCAL_KEYS[""], diagnostics);
  expectConst(root.schemaVersion, 1, "/schemaVersion", diagnostics);
  expectType(root.purpose, "string", "/purpose", diagnostics);
  expectType(root.status, "string", "/status", diagnostics);
  validateLocalNetwork(root.network, diagnostics);
  validateLocalToken(root.token, diagnostics);
  validateLocalAllocations(root.allocations, diagnostics);
  return diagnostics;
}

function validateLocalNetwork(value: unknown, diagnostics: Diagnostic[]): void {
  const network = requireObject(value, "/network", diagnostics);
  if (!network) {return;}
  exactKeys(network, "/network", LOCAL_KEYS["/network"], diagnostics);
  expectType(network.kind, "string", "/network/kind", diagnostics);
  expectType(network.chainId, "string", "/network/chainId", diagnostics);
}

function validateLocalToken(value: unknown, diagnostics: Diagnostic[]): void {
  const token = requireObject(value, "/token", diagnostics);
  if (!token) {return;}
  exactKeys(token, "/token", LOCAL_KEYS["/token"], diagnostics);
  expectType(token.name, "string", "/token/name", diagnostics);
  expectType(token.symbol, "string", "/token/symbol", diagnostics);
  expectType(token.decimals, "integer", "/token/decimals", diagnostics);
  expectType(token.initialSupplyBaseUnits, "string", "/token/initialSupplyBaseUnits", diagnostics);
}

function validateLocalAllocations(value: unknown, diagnostics: Diagnostic[]): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    diagnostics.push(problem("GENESIS_SCHEMA_TYPE", "/allocations", "must be an array with 1 through 32 items"));
    return;
  }
  value.forEach((item, index) => {
    const pointer = `/allocations/${index}`;
    const allocation = requireObject(item, pointer, diagnostics);
    if (!allocation) {return;}
    exactKeys(allocation, pointer, LOCAL_KEYS["/allocations/*"], diagnostics, ["id", "recipient", "amountBaseUnits"]);
    expectType(allocation.id, "string", `${pointer}/id`, diagnostics);
    expectType(allocation.recipient, "string", `${pointer}/recipient`, diagnostics);
    expectType(allocation.amountBaseUnits, "string", `${pointer}/amountBaseUnits`, diagnostics);
    if (allocation.bps !== undefined) {expectType(allocation.bps, "integer", `${pointer}/bps`, diagnostics);}
  });
}

function validateProposalShape(value: Record<string, unknown>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  validateProposalObject(value, "", diagnostics);
  expectConst(value.schemaVersion, 1, "/schemaVersion", diagnostics);
  expectConst(value.purpose, "proposal", "/purpose", diagnostics);
  expectConst(value.status, "proposal", "/status", diagnostics);
  return diagnostics;
}

function validateProposalObject(value: Record<string, unknown>, pointer: string, diagnostics: Diagnostic[]): void {
  const children = proposalChildren.get(pointer) ?? new Set<string>();
  exactKeys(value, pointer, [...children], diagnostics);
  for (const key of children) {
    if (!(key in value)) {continue;}
    const childPointer = `${pointer}/${escapePointer(key)}`;
    const expectedType = PROPOSAL_LEAF_TYPES.get(childPointer);
    if (expectedType) {
      expectType(value[key], expectedType, childPointer, diagnostics);
      continue;
    }
    const child = requireObject(value[key], childPointer, diagnostics);
    if (child) {validateProposalObject(child, childPointer, diagnostics);}
  }
}

function validateProposalSemantics(value: Record<string, unknown>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const token = asRecord(value.token);
  if (!token || token.workingName !== EXPECTED_TOKEN.name || token.workingSymbol !== EXPECTED_TOKEN.symbol || token.decimals !== EXPECTED_TOKEN.decimals) {
    diagnostics.push(problem("GENESIS_PROPOSAL_TOKEN_PROFILE_MISMATCH", "/token", "proposal token identity must match AGTMAI"));
  }
  const supply = token && parseCanonicalUint(token.fixedSupplyBaseUnits, UINT64_MAX);
  if (supply === undefined || supply === 0n) {
    diagnostics.push(problem("GENESIS_PROPOSAL_SUPPLY_INVALID", "/token/fixedSupplyBaseUnits", "must be a positive canonical decimal string fitting uint64"));
  }
  const allocations = asRecord(value.allocations);
  const sections = ["communityGovernanceReserve", "communityDistributions", "teamAndContributors", "protocolOperations", "ecosystemAndPublicGrants", "liquidity"];
  let sum = 0;
  for (const section of sections) {
    const bps = asRecord(allocations?.[section])?.allocationBps;
    if (!Number.isSafeInteger(bps) || (bps as number) < 0 || (bps as number) > 10_000) {
      diagnostics.push(problem("GENESIS_PROPOSAL_BPS_INVALID", `/allocations/${section}/allocationBps`, "must be an integer from 0 through 10000"));
    } else {
      sum += bps as number;
    }
  }
  if (sum !== 10_000) {
    diagnostics.push(problem("GENESIS_PROPOSAL_BPS_SUM_MISMATCH", "/allocations", "top-level proposal allocations must sum exactly to 10000 bps"));
  }
  return diagnostics;
}

function collectPositions(node: unknown, pointer: string, lines: LineCounter, output: Map<string, SourcePosition>): void {
  const offset = rangeStart(node);
  if (offset !== undefined) {output.set(pointer, sourcePosition(offset, lines));}
  if (isMap(node)) {
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {continue;}
      const childPointer = `${pointer}/${escapePointer(pair.key.value)}`;
      const childOffset = rangeStart(pair.value) ?? rangeStart(pair.key);
      if (childOffset !== undefined) {output.set(childPointer, sourcePosition(childOffset, lines));}
      if (pair.value) {collectPositions(pair.value, childPointer, lines, output);}
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => {
      if (item) {collectPositions(item, `${pointer}/${index}`, lines, output);}
    });
  }
}

function collectParserDiagnostics(document: Document, lines: LineCounter, output: Diagnostic[]): void {
  for (const item of [...document.errors, ...document.warnings]) {
    output.push(at("GENESIS_SOURCE_SYNTAX", item.message, item.pos[0], lines));
  }
}

function buildProposalChildren(): Map<string, Set<string>> {
  const output = new Map<string, Set<string>>();
  for (const pointer of PROPOSAL_LEAF_TYPES.keys()) {
    const segments = pointer.slice(1).split("/");
    let parent = "";
    for (const segment of segments) {
      const children = output.get(parent) ?? new Set<string>();
      children.add(segment);
      output.set(parent, children);
      parent = `${parent}/${segment}`;
    }
  }
  return output;
}

function exactKeys(value: Record<string, unknown>, pointer: string, allowed: readonly string[], output: Diagnostic[], required = allowed): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {output.push(problem("GENESIS_SCHEMA_UNKNOWN_FIELD", `${pointer}/${escapePointer(key)}`, "unknown field"));}
  }
  for (const key of required) {
    if (!(key in value)) {output.push(problem("GENESIS_SCHEMA_REQUIRED", `${pointer}/${escapePointer(key)}`, "required field is missing"));}
  }
}

function requireObject(value: unknown, pointer: string, output: Diagnostic[]): Record<string, unknown> | undefined {
  const object = asRecord(value);
  if (!object) {output.push(problem("GENESIS_SCHEMA_TYPE", pointer, "must be an object"));}
  return object;
}

function expectType(value: unknown, expected: ProposalScalarType, pointer: string, output: Diagnostic[]): void {
  const matches = expected === "integer" ? typeof value === "number" && Number.isSafeInteger(value) : typeof value === expected;
  if (!matches) {output.push(problem("GENESIS_SCHEMA_TYPE", pointer, `must be ${expected === "integer" ? "an integer" : `a ${expected}`}`));}
}

function expectConst(value: unknown, expected: unknown, pointer: string, output: Diagnostic[]): void {
  if (value !== expected) {output.push(problem("GENESIS_SCHEMA_CONST", pointer, `must equal ${JSON.stringify(expected)}`));}
}

function positioned(diagnostics: readonly Diagnostic[], positions: ReadonlyMap<string, SourcePosition>): Diagnostic[] {
  return diagnostics.map((diagnostic) => diagnostic.position ? diagnostic : { ...diagnostic, position: findPosition(diagnostic.pointer, positions) }).toSorted(compareDiagnostics);
}

function findPosition(pointer: string, positions: ReadonlyMap<string, SourcePosition>): SourcePosition {
  let candidate = pointer;
  while (candidate !== "") {
    const position = positions.get(candidate);
    if (position) {return position;}
    candidate = candidate.slice(0, candidate.lastIndexOf("/"));
  }
  return positions.get("") ?? { offset: 0, line: 1, column: 1 };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function problem(code: string, pointer: string, message: string): Diagnostic {
  return { code, severity: "error", pointer, message };
}

function at(code: string, message: string, offset = 0, lines?: LineCounter): Diagnostic {
  return { ...problem(code, "", message), position: lines ? sourcePosition(offset, lines) : { offset, line: 1, column: 1 } };
}

function sourcePosition(offset: number, lines: LineCounter): SourcePosition {
  const point = lines.linePos(offset);
  return { offset, line: point.line, column: point.col };
}

function rangeStart(value: unknown): number | undefined {
  return typeof value === "object" && value !== null && "range" in value && Array.isArray(value.range) ? value.range[0] as number | undefined : undefined;
}

function dedupe(items: Diagnostic[]): Diagnostic[] {
  return [...new Map(items.map((item) => [`${item.code}:${item.pointer}:${item.position?.offset ?? -1}:${item.message}`, item])).values()].toSorted(compareDiagnostics);
}
