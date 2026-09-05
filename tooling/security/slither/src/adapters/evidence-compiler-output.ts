import { createHash } from "node:crypto";
import { SlitherGateError } from "../domain/model.ts";
import { assertRawCompilerIdentity } from "./evidence-compiler-identity.ts";
import { parseJsonWithoutDuplicateKeys } from "./json-schema.ts";

type JsonObject = Record<string, unknown>;
type BuildScope = { readonly kind: "production"; readonly sourceName: string; readonly contractName: string }
  | { readonly kind: "vulnerable-fixture" };

/** Independent reconstruction, after the bundle reader authenticates raw files. */
export function deriveCompiler(build: Buffer, artifact: Buffer, fixtureBuild: Buffer, fixtureArtifact: Buffer, manifest: JsonObject): { compiler: JsonObject; fixture: JsonObject } {
  const target = object(array(manifest.targets, "manifest targets")[0], "manifest target");
  const compiler = deriveOneBuild(build, artifact, {
    kind: "production", sourceName: stringValue(target.path).replace(/^contracts\/evm\//u, ""), contractName: stringValue(target.contract),
  });
  const vulnerable = object(manifest.vulnerableFixture, "vulnerable fixture");
  const fixtureSource = object(vulnerable.source, "vulnerable fixture source");
  if (fixtureSource.path !== "tooling/security/slither/tests/fixtures/Vulnerable.sol") {throw invalid("vulnerable compiler source scope differs");}
  const fixture = deriveOneBuild(fixtureBuild, fixtureArtifact, { kind: "vulnerable-fixture" });
  const fixtureSources = array(fixture.sourceHashes, "fixture source hashes").map((item) => object(item, "fixture source hash"));
  if (compiler.creationBytecodeSha256 !== `sha256:${manifest.creationBytecodeSha256}` || fixture.creationBytecodeSha256 !== `sha256:${vulnerable.creationBytecodeSha256}`) {throw invalid("compiler creation bytecode differs from manifest pins");}
  if (fixtureSources.length !== 1 || fixtureSources[0]?.path !== "src/Vulnerable.sol" || fixtureSources[0].sha256 !== `sha256:${fixtureSource.sha256}`) {throw invalid("vulnerable compiler source differs from the pinned closure");}
  const expectedSources = new Map(array(manifest.sources, "manifest sources").map((item) => {
    const entry = object(item, "source"); return [stringValue(entry.path).replace(/^contracts\/evm\//u, ""), `sha256:${entry.sha256}`] as const;
  }));
  const observed = array(compiler.sourceHashes, "compiler source hashes").map((item) => object(item, "source hash"));
  if (observed.length !== expectedSources.size || observed.some((entry) => expectedSources.get(stringValue(entry.path)) !== entry.sha256)) {throw invalid("compiler per-source hashes differ from the pinned closure");}
  return { compiler, fixture: {
    sourceSha256: `sha256:${fixtureSource.sha256}`, buildInfoSha256: fixture.buildInfoSha256, artifactSha256: fixture.artifactSha256,
    abiSha256: fixture.abiSha256, creationBytecodeSha256: fixture.creationBytecodeSha256,
  } };
}

function deriveOneBuild(buildBytes: Buffer, artifactBytes: Buffer, scope: BuildScope): JsonObject {
  const build = object(parseJsonWithoutDuplicateKeys(buildBytes.toString("utf8")), "build-info");
  const input = object(build.input, "compiler input"); const settings = object(input.settings, "compiler settings");
  const isolated = scope.kind === "vulnerable-fixture";
  assertCompilerProfile(settings, isolated);
  const sources = object(input.sources, "compiler sources");
  const sourceHashes = Object.entries(sources).map(([path, value]) => {
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {throw invalid("unsafe compiler source path");}
    return { path, sha256: `sha256:${hex(stringValue(object(value, "compiler source").content))}` };
  }).toSorted((a, b) => a.path.localeCompare(b.path));
  const artifact = object(parseJsonWithoutDuplicateKeys(artifactBytes.toString("utf8")), "artifact");
  const abi = array(artifact.abi, "artifact ABI"); const bytecode = stringValue(object(artifact.bytecode, "artifact bytecode").object);
  const normalized = bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/u.test(normalized)) {throw invalid("artifact creation bytecode is malformed");}
  const output = object(build.output, "compiler output"); const contracts = object(output.contracts, "compiler contracts");
  const sourceName = isolated ? "src/Vulnerable.sol" : scope.sourceName;
  const contractName = isolated ? "Vulnerable" : scope.contractName;
  const sourceOutput = object(contracts[sourceName], "source output"); const contractOutput = object(sourceOutput[contractName], "contract output");
  assertRawCompilerIdentity(build, artifact, contracts, contractOutput);
  if (isolated) {assertIsolatedBuild(build, artifact, contractOutput);}
  const evm = object(contractOutput.evm, "evm"); const fromBuild = stringValue(object(evm.bytecode, "build bytecode").object).replace(/^0x/u, "");
  if (!/^(?:[0-9a-fA-F]{2})+$/u.test(fromBuild) || Buffer.from(fromBuild, "hex").compare(Buffer.from(normalized.slice(2), "hex")) !== 0) {throw invalid("artifact and build-info bytecode differ");}
  return {
    buildInfoSha256: `sha256:${hex(buildBytes)}`, compilerInputSha256: `sha256:${hex(JSON.stringify(input))}`,
    compilerSettingsSha256: `sha256:${hex(JSON.stringify(settings))}`, compilerInput: input, compilerSettings: settings, sourceHashes,
    artifactSha256: `sha256:${hex(artifactBytes)}`, abiSha256: `sha256:${hex(JSON.stringify(abi))}`, creationBytecode: normalized,
    creationBytecodeSha256: `sha256:${hex(Buffer.from(normalized.slice(2), "hex"))}`,
  };
}

function assertCompilerProfile(settings: JsonObject, isolated: boolean): void {
  const optimizer = object(settings.optimizer, "optimizer"); const metadata = object(settings.metadata, "metadata");
  const libraries = object(settings.libraries, "libraries");
  // Only the caller's fixture stage permits omitted/empty remappings. The
  // production compiler profile remains the exact two OpenZeppelin mappings.
  const remappings = isolated && !Object.hasOwn(settings, "remappings") ? [] : array(settings.remappings, "remappings").map(stringValue).toSorted();
  const expectedRemappings = isolated ? [] : ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"];
  if (settings.evmVersion !== "paris" || optimizer.enabled !== true || optimizer.runs !== 200 || metadata.bytecodeHash !== "ipfs"
    || metadata.appendCBOR !== true || metadata.useLiteralContent !== false || settings.viaIR !== false || settings.experimental !== false
    || Object.keys(libraries).length !== 0 || !deepEqual(remappings, expectedRemappings)) {throw invalid("raw compiler settings differ from the pinned profile");}
}

function assertIsolatedBuild(build: JsonObject, artifact: JsonObject, target: JsonObject): void {
  const input = object(build.input, "fixture compiler input"); const sources = object(input.sources, "fixture compiler sources");
  assertFixtureInput(input);
  assertExactKeys(sources, ["src/Vulnerable.sol"]); assertExactKeys(object(sources["src/Vulnerable.sol"], "fixture compiler source"), ["content"]);
  const output = object(build.output, "fixture compiler output"); const contracts = object(output.contracts, "fixture compiler contracts");
  assertExactKeys(contracts, ["src/Vulnerable.sol"]); assertExactKeys(object(contracts["src/Vulnerable.sol"], "fixture contracts"), ["Vulnerable"]);
  if (Object.hasOwn(output, "sources")) {assertExactKeys(object(output.sources, "fixture output sources"), ["src/Vulnerable.sol"]);}
  if (Object.hasOwn(build, "source_id_to_path") && !deepEqual(build.source_id_to_path, { "0": "src/Vulnerable.sol" })) {throw invalid("fixture compiler source map differs");}
  const settings = object(input.settings, "fixture compiler settings");
  if (Object.keys(settings).some((key) => !["optimizer", "metadata", "outputSelection", "evmVersion", "viaIR", "viaSSACFG", "experimental", "libraries", "remappings"].includes(key))
    || (Object.hasOwn(settings, "viaSSACFG") && settings.viaSSACFG !== false)) {throw invalid("fixture compiler settings contain unsupported fields");}
  assertExactKeys(object(settings.optimizer, "fixture optimizer"), ["enabled", "runs"]);
  assertExactKeys(object(settings.metadata, "fixture metadata"), ["bytecodeHash", "appendCBOR", "useLiteralContent"]);
  const metadata = object(parseJsonWithoutDuplicateKeys(stringValue(target.metadata)), "fixture embedded metadata");
  for (const document of [metadata, object(artifact.metadata, "fixture artifact metadata")]) {
    const profile = object(document.settings, "fixture metadata settings");
    assertExactKeys(profile, ["compilationTarget", "evmVersion", "libraries", "metadata", "optimizer", "remappings"]);
    if (!deepEqual(profile.compilationTarget, { "src/Vulnerable.sol": "Vulnerable" }) || profile.evmVersion !== "paris"
      || !deepEqual(profile.libraries, {}) || !deepEqual(profile.metadata, { bytecodeHash: "ipfs" })
      || !deepEqual(profile.optimizer, { enabled: true, runs: 200 }) || !deepEqual(profile.remappings, [])) {throw invalid("fixture compiler metadata profile or target differs");}
    assertExactKeys(object(document.sources, "fixture metadata sources"), ["src/Vulnerable.sol"]);
  }
  if (!deepEqual(artifact.abi, target.abi) || !deepEqual(artifact.abi, object(metadata.output, "fixture metadata output").abi)) {throw invalid("fixture compiler ABI differs between artifact, build and metadata");}
}

function assertFixtureInput(input: JsonObject): void {
  assertExactKeys(input, ["version", "language", "sources", "settings", "allowPaths", "basePath", "includePaths"]);
  if (input.version !== "0.8.36" || input.language !== "Solidity" || input.basePath !== "/work/contracts/evm"
    || !deepEqual(input.allowPaths, ["/work/contracts/evm", "/work/contracts/evm/lib"])
    || !deepEqual(input.includePaths, ["/work/contracts/evm"])) {throw invalid("fixture compiler input scope or version differs");}
}

function assertExactKeys(value: JsonObject, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify([...expected].toSorted())) {throw invalid("fixture compiler scope has missing or unexpected fields");}
}
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
function object(value: unknown, name: string): JsonObject {if (value === null || typeof value !== "object" || Array.isArray(value)) {throw invalid(`${name} is not an object`);} return value as JsonObject;}
function array(value: unknown, name: string): unknown[] {if (!Array.isArray(value)) {throw invalid(`${name} is not an array`);} return value;}
function invalid(message: string): SlitherGateError {return new SlitherGateError("EVIDENCE_BUNDLE_INVALID", message);}
