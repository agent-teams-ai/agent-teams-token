import type { AnalysisInput, GateManifest } from "../domain/model.ts";
import { SlitherGateError } from "../domain/model.ts";
import type { BuildInfo, FixtureCompilerProfile, ForgeArtifact } from "./compiler-identity.ts";
import { validateBuildCompiler, validateCompilerIdentity } from "./compiler-identity.ts";
import { sha256 } from "./fingerprint.ts";
import { parseTypedJson } from "./policy-shape.ts";

export interface VulnerableCompilerRequest {
  readonly scope: "vulnerable-fixture";
  readonly fixture: GateManifest["vulnerableFixture"];
}
export interface CompiledOutput<Profile = GateManifest["compiler"] | FixtureCompilerProfile> {
  readonly compiler: Profile;
  readonly artifactBytecode: string;
  readonly buildInfoBytecode: string;
  readonly evidence: AnalysisInput["compilerEvidence"];
}
type Json = Record<string, unknown>;

/** Scope is fixed by the caller, never inferred from embedded source names. */
export function compilerArtifactName(request?: VulnerableCompilerRequest): "AGTMAIToken.json" | "Vulnerable.json" {
  if (request === undefined) {return "AGTMAIToken.json";}
  const value = object(request); exactKeys(value, ["scope", "fixture"]);
  const fixture = object(value.fixture); exactKeys(fixture, ["source", "creationBytecodeSha256"]);
  const source = object(fixture.source); exactKeys(source, ["path", "sha256"]);
  if (value.scope !== "vulnerable-fixture" || source.path !== "tooling/security/slither/tests/fixtures/Vulnerable.sol"
    || !hash(source.sha256) || !hash(fixture.creationBytecodeSha256)) {throw invalid("unsupported compiler caller scope or fixture pins");}
  return "Vulnerable.json";
}

export function parseCompilerOutput(buildRaw: Buffer, artifactRaw: Buffer): CompiledOutput<GateManifest["compiler"]>;
export function parseCompilerOutput(buildRaw: Buffer, artifactRaw: Buffer, request: VulnerableCompilerRequest): CompiledOutput<FixtureCompilerProfile>;
export function parseCompilerOutput(buildRaw: Buffer, artifactRaw: Buffer, request?: VulnerableCompilerRequest): CompiledOutput {
  compilerArtifactName(request);
  const sourceName = request ? "src/Vulnerable.sol" : "src/features/token-genesis/AGTMAIToken.sol";
  const contractName = request ? "Vulnerable" : "AGTMAIToken";
  const artifact = parseTypedJson(artifactRaw.toString("utf8"), "BUILD_INFO_INVALID", "compiler artifact") as ForgeArtifact;
  const build = parseTypedJson(buildRaw.toString("utf8"), "BUILD_INFO_INVALID", "compiler build-info") as BuildInfo;
  const version = validateCompilerIdentity(build, artifact, sourceName, contractName);
  const compiler = request ? validateBuildCompiler(build, version, request.scope) : validateBuildCompiler(build, version);
  const artifactHex = artifact.bytecode?.object;
  const artifactBytes = decodeCreationBytecode(artifactHex);
  const buildInfoBytes = decodeCreationBytecode(build.output?.contracts?.[sourceName]?.[contractName]?.evm?.bytecode?.object);
  if (!Array.isArray(artifact.abi)) {throw invalid("compiler ABI is absent");}
  const sourceHashes = Object.entries(build.input?.sources ?? {}).map(([path, value]) => {
    if (!/^[A-Za-z0-9._/-]+$/u.test(path) || path.startsWith("/") || path.startsWith("-")
      || path.split("/").some((part) => !part || part === "." || part === "..")) {throw invalid("compiler source path is unsafe");}
    if (typeof value?.content !== "string") {throw invalid("compiler source content is absent");}
    return { path, sha256: sha256(value.content) };
  }).toSorted((a, b) => a.path.localeCompare(b.path));
  if (request) {
    validateFixtureOutput(object(build), object(artifact));
    assertFixturePins(sourceHashes, artifactBytes, buildInfoBytes, request.fixture);
  }
  const normalized = typeof artifactHex === "string" && artifactHex.startsWith("0x") ? artifactHex : `0x${String(artifactHex)}`;
  return { compiler, artifactBytecode: sha256(artifactBytes), buildInfoBytecode: sha256(buildInfoBytes), evidence: {
    buildInfoSha256: sha256(buildRaw), compilerInputSha256: sha256(JSON.stringify(build.input)),
    compilerSettingsSha256: sha256(JSON.stringify(build.input?.settings)),
    compilerInput: build.input as Readonly<Json>, compilerSettings: build.input?.settings as Readonly<Json>, sourceHashes,
    artifactSha256: sha256(artifactRaw), abiSha256: sha256(JSON.stringify(artifact.abi)), creationBytecode: normalized,
    creationBytecodeSha256: sha256(artifactBytes), rawBuildInfo: buildRaw.toString("utf8"), rawArtifact: artifactRaw.toString("utf8"),
  } };
}

function assertFixturePins(sources: AnalysisInput["compilerEvidence"]["sourceHashes"], artifact: Buffer, build: Buffer, fixture: GateManifest["vulnerableFixture"]): void {
  if (sources.length !== 1 || sources[0]?.path !== "src/Vulnerable.sol" || sources[0].sha256 !== fixture.source.sha256
    || sha256(artifact) !== fixture.creationBytecodeSha256 || sha256(build) !== fixture.creationBytecodeSha256) {
    throw invalid("vulnerable compiler source or bytecode differs from manifest pins");
  }
}

function validateFixtureOutput(build: Json, artifact: Json): void {
  const input = object(build.input); const sources = object(input.sources);
  exactKeys(input, ["version", "language", "sources", "settings", "allowPaths", "basePath", "includePaths"]);
  if (input.version !== "0.8.36" || input.language !== "Solidity" || input.basePath !== "/work/contracts/evm"
    || !same(input.allowPaths, ["/work/contracts/evm", "/work/contracts/evm/lib"])
    || !same(input.includePaths, ["/work/contracts/evm"])) {throw invalid("fixture compiler input scope or version differs");}
  exactKeys(sources, ["src/Vulnerable.sol"]); exactKeys(object(sources["src/Vulnerable.sol"]), ["content"]);
  const output = object(build.output); const contracts = object(output.contracts);
  exactKeys(contracts, ["src/Vulnerable.sol"]);
  const source = object(contracts["src/Vulnerable.sol"]); exactKeys(source, ["Vulnerable"]);
  if (Object.hasOwn(output, "sources")) {exactKeys(object(output.sources), ["src/Vulnerable.sol"]);}
  if (Object.hasOwn(build, "source_id_to_path") && !same(build.source_id_to_path, { "0": "src/Vulnerable.sol" })) {throw invalid("fixture compiler source map differs");}
  const settings = object(input.settings);
  const acceptedKeys = ["optimizer", "metadata", "outputSelection", "evmVersion", "viaIR", "viaSSACFG", "experimental", "libraries", "remappings"];
  if (Object.keys(settings).some((key) => !acceptedKeys.includes(key)) || (Object.hasOwn(settings, "viaSSACFG") && settings.viaSSACFG !== false)) {throw invalid("fixture compiler settings contain unsupported fields");}
  exactKeys(object(settings.optimizer), ["enabled", "runs"]);
  exactKeys(object(settings.metadata), ["bytecodeHash", "appendCBOR", "useLiteralContent"]);
  const target = object(source.Vulnerable);
  const metadata = object(parseTypedJson(String(target.metadata), "BUILD_INFO_INVALID", "fixture metadata"));
  const expectedSettings = {
    compilationTarget: { "src/Vulnerable.sol": "Vulnerable" }, evmVersion: "paris", libraries: {},
    metadata: { bytecodeHash: "ipfs" }, optimizer: { enabled: true, runs: 200 }, remappings: [],
  };
  for (const document of [metadata, object(artifact.metadata)]) {
    if (!same(document.settings, expectedSettings)) {throw invalid("fixture compiler metadata profile or target differs");}
    exactKeys(object(document.sources), ["src/Vulnerable.sol"]);
  }
  if (!same(artifact.abi, target.abi) || !same(artifact.abi, object(metadata.output).abi)) {throw invalid("fixture compiler ABI differs between artifact, build and metadata");}
}

export function decodeCreationBytecode(value: unknown): Buffer {
  if (typeof value !== "string") {throw new SlitherGateError("BYTECODE_MISSING", "fresh creation bytecode is absent or malformed");}
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^(?:[0-9a-fA-F]{2})+$/u.test(normalized)) {throw new SlitherGateError("BYTECODE_MISSING", "fresh creation bytecode is absent or malformed");}
  return Buffer.from(normalized, "hex");
}
function same(left: unknown, right: unknown): boolean {
  if (left === right) {return true;}
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) {return false;}
  const a = left as Json; const b = right as Json;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}
function exactKeys(value: Json, keys: readonly string[]): void {
  if (!same(Object.keys(value).toSorted(), [...keys].toSorted())) {throw invalid("fixture compiler scope has missing or unexpected fields");}
}
function object(value: unknown): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw invalid("compiler scope or output is not an object");}
  return value as Json;
}
const hash = (value: unknown): boolean => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const invalid = (message: string): SlitherGateError => new SlitherGateError("BUILD_INFO_INVALID", message);
