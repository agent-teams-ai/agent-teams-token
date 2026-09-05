import { SlitherGateError } from "../domain/model.ts";
import { parseJsonWithoutDuplicateKeys } from "./json-schema.ts";

type JsonObject = Record<string, unknown>;

export function assertRawCompilerIdentity(build: JsonObject, artifact: JsonObject, contracts: JsonObject, target: JsonObject): void {
  // Independently reconstruct the pinned Forge format. Neither short version
  // field nor the serialized evidence.tools.solc can supply the compiler commit.
  if (build.solcVersion !== "0.8.36" || build.solcLongVersion !== "0.8.36") {throw invalid("raw Foundry compiler version fields differ from the captured format");}
  for (const source of Object.values(contracts)) {
    const outputs = object(source, "compiler source output");
    if (Object.keys(outputs).length === 0) {throw invalid("compiler contract metadata is absent");}
    for (const contract of Object.values(outputs)) {
      readEmbeddedMetadata(object(contract, "compiler contract").metadata);
    }
  }
  const artifactMetadata = object(artifact.metadata, "artifact compiler metadata");
  assertEmbeddedCompiler(artifactMetadata);
  // Foundry's object form loses NatSpec fields and normalizes remappings;
  // compare complete raw metadata, and independently check the object's commit.
  if (!deepEqual(readEmbeddedMetadata(artifact.rawMetadata), readEmbeddedMetadata(target.metadata))) {throw invalid("artifact and build-info compiler metadata differ");}
}
function readEmbeddedMetadata(value: unknown): JsonObject {
  if (typeof value !== "string") {throw invalid("raw compiler metadata is absent or malformed");}
  let parsed: unknown;
  try {parsed = parseJsonWithoutDuplicateKeys(value);} catch {throw invalid("embedded compiler metadata is not unambiguous JSON");}
  const metadata = object(parsed, "embedded compiler metadata");
  assertEmbeddedCompiler(metadata);
  return metadata;
}
function assertEmbeddedCompiler(metadata: JsonObject): void {
  const compiler = object(metadata.compiler, "embedded compiler identity");
  assertExactKeys(compiler, ["version"], "embedded compiler identity");
  if (compiler.version !== "0.8.36+commit.8a079791") {throw invalid("embedded compiler identity differs from the exact pinned commit");}
}

function assertExactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify([...expected].toSorted())) {
    throw invalid(`${label} has missing or unexpected fields`);
  }
}
const deepEqual = (left: unknown, right: unknown): boolean => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonical);}
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function object(value: unknown, name: string): JsonObject {if (value === null || typeof value !== "object" || Array.isArray(value)) {throw invalid(`${name} is not an object`);} return value as JsonObject;}
function invalid(message: string): SlitherGateError {return new SlitherGateError("EVIDENCE_BUNDLE_INVALID", message);}
