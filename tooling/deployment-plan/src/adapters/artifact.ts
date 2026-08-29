import type {
  ApprovedArtifact,
  ArtifactInputs,
  TrustRoots,
} from "../application/ports.ts";
import { canonicalJson, sha256Hex } from "../domain/identity.ts";
import { fail } from "../domain/model.ts";

const SOURCE = "src/features/token-genesis/AGTMAIToken.sol";
const CONTRACT = "AGTMAIToken";

export type { ApprovedArtifact, TrustRoots } from "../application/ports.ts";

interface ParsedArtifactInputs {
  readonly build: Record<string, unknown>;
  readonly artifact: Record<string, unknown>;
  readonly abi: unknown[];
  readonly fixture: Record<string, unknown>;
  readonly artifactSha256: `0x${string}`;
  readonly abiSha256: `0x${string}`;
  readonly fixtureSha256: `0x${string}`;
}

interface BuildContract {
  readonly outputContract: Record<string, unknown>;
  readonly normalizedSettings: Record<string, unknown>;
  readonly sourceDependencyClosure: Record<string, `0x${string}`>;
}

interface ConstructorValues {
  readonly initialSupply: string;
  readonly allocations: readonly Allocation[];
}

interface Allocation {
  readonly id: string;
  readonly recipient: string;
  readonly amount: string;
}

export function approveForgeArtifact(
  inputs: ArtifactInputs,
  roots: TrustRoots,
): ApprovedArtifact {
  const parsed = parseArtifactInputs(inputs);
  validateInputDigests(parsed, roots);
  validateBuildInfoCompiler(parsed.build, roots);
  const buildContract = readBuildContract(parsed.build, roots);
  validateAbis(buildContract.outputContract, parsed.artifact, parsed.abi);
  const constructor = findConstructor(parsed.abi);
  const creationBytecode = readCreationBytecode(buildContract.outputContract, parsed.artifact);
  const constructorArguments = encodeConstructor(
    parseConstructor(inputs.constructorValues ?? parsed.fixture),
  );
  const creationInput = `${creationBytecode}${constructorArguments.slice(2)}` as `0x${string}`;
  const constructorAbiBytes = utf8Hex(canonicalJson(constructor));

  return {
    buildInfoSha256: sha256Hex(inputs.buildInfoBytes),
    artifactSha256: parsed.artifactSha256,
    abiSha256: parsed.abiSha256,
    fixtureSha256: parsed.fixtureSha256,
    sourceDependencyClosure: buildContract.sourceDependencyClosure,
    buildInfoSolcVersion: roots.buildInfoSolcVersion,
    compilerSettings: buildContract.normalizedSettings,
    creationBytecode,
    creationBytecodeHash: hashHex(creationBytecode),
    constructorAbiBytes,
    constructorAbiHash: hashHex(constructorAbiBytes),
    constructorArguments,
    constructorArgumentsHash: hashHex(constructorArguments),
    creationInput,
    creationInputHash: hashHex(creationInput),
  };
}

function parseArtifactInputs(inputs: ArtifactInputs): ParsedArtifactInputs {
  return {
    build: parseObject(inputs.buildInfoBytes, "BUILD_INFO"),
    artifact: parseObject(inputs.artifactBytes, "ARTIFACT"),
    abi: parseArray(inputs.abiBytes, "ABI"),
    fixture: parseObject(inputs.fixtureBytes, "FIXTURE"),
    artifactSha256: sha256Hex(inputs.artifactBytes),
    abiSha256: sha256Hex(inputs.abiBytes),
    fixtureSha256: sha256Hex(inputs.fixtureBytes),
  };
}

function validateInputDigests(parsed: ParsedArtifactInputs, roots: TrustRoots): void {
  if (parsed.artifactSha256 !== roots.artifactSha256) {
    fail("ARTIFACT_DIGEST_MISMATCH", "artifact digest differs from trust root");
  }
  if (parsed.abiSha256 !== roots.abiSha256) {
    fail("ABI_DIGEST_MISMATCH", "ABI digest differs from trust root");
  }
  if (parsed.fixtureSha256 !== roots.fixtureSha256) {
    fail("FIXTURE_DIGEST_MISMATCH", "fixture digest differs from trust root");
  }
}

function validateBuildInfoCompiler(
  build: Record<string, unknown>,
  roots: TrustRoots,
): void {
  if (build.solcVersion !== roots.buildInfoSolcVersion) {
    fail("SOLC_MISMATCH", "build-info solcVersion differs from trust root");
  }
}

function readBuildContract(build: Record<string, unknown>, roots: TrustRoots): BuildContract {
  const input = object(build.input, "BUILD_INPUT_INVALID");
  const settings = object(input.settings, "BUILD_SETTINGS_INVALID");
  const normalizedSettings = normalizeSettings(settings);
  if (canonicalJson(normalizedSettings) !== canonicalJson(roots.compilerSettings)) {
    fail("SETTINGS_MISMATCH", "compiler settings differ from trust root");
  }
  const sourceDependencyClosure = readSourceClosure(input.sources);
  if (canonicalJson(sourceDependencyClosure) !== canonicalJson(roots.sourceDependencyClosure)) {
    fail("SOURCE_CLOSURE_MISMATCH", "source dependency closure differs from trust root");
  }
  const output = object(build.output, "BUILD_OUTPUT_INVALID");
  const contracts = object(output.contracts, "BUILD_CONTRACTS_INVALID");
  const sourceContracts = object(contracts[SOURCE], "BUILD_SOURCE_CONTRACT_INVALID");
  const outputContract = object(sourceContracts[CONTRACT], "BUILD_CONTRACT_INVALID");
  return { outputContract, normalizedSettings, sourceDependencyClosure };
}

function readSourceClosure(value: unknown): Record<string, `0x${string}`> {
  const sources = object(value, "BUILD_SOURCES_INVALID");
  const closure: Record<string, `0x${string}`> = {};
  for (const [path, source] of Object.entries(sources)) {
    const content = object(source, "BUILD_SOURCE_INVALID").content;
    if (typeof content !== "string") {
      fail("BUILD_SOURCE_INVALID", "source content is absent");
    }
    closure[path] = sha256Hex(content);
  }
  return closure;
}

function validateAbis(
  outputContract: Record<string, unknown>,
  artifact: Record<string, unknown>,
  abi: unknown[],
): void {
  const approvedAbi = canonicalAbi(abi);
  if (
    canonicalAbi(outputContract.abi) !== approvedAbi
    || canonicalAbi(artifact.abi) !== approvedAbi
  ) {
    fail("ABI_BUILD_MISMATCH", "ABI/build/artifact mismatch");
  }
}

function canonicalAbi(value: unknown): string {
  if (!Array.isArray(value)) {
    fail("ABI_BUILD_MISMATCH", "ABI/build/artifact mismatch");
  }
  return canonicalJson(
    value.toSorted((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
  );
}

function findConstructor(abi: unknown[]): Record<string, unknown> {
  const constructor = abi.find(
    (entry) => object(entry, "ABI_ENTRY_INVALID").type === "constructor",
  );
  if (constructor === undefined) {
    fail("CONSTRUCTOR_ABI_MISSING", "constructor ABI is absent");
  }
  return object(constructor, "ABI_ENTRY_INVALID");
}

function readCreationBytecode(
  outputContract: Record<string, unknown>,
  artifact: Record<string, unknown>,
): `0x${string}` {
  const evm = object(outputContract.evm, "BUILD_EVM_INVALID");
  const bytecode = object(evm.bytecode, "BUILD_BYTECODE_INVALID");
  if (hasLinks(bytecode.linkReferences)) {
    fail("LINK_REFERENCES_UNSUPPORTED", "linked bytecode is unsupported");
  }
  const raw = bytecode.object;
  if (typeof raw !== "string" || !/^[0-9a-f]+$/u.test(raw) || raw.length % 2 !== 0) {
    fail("BYTECODE_INVALID", "creation bytecode is malformed");
  }
  const artifactRaw = object(artifact.bytecode, "ARTIFACT_BYTECODE_INVALID").object;
  if (artifactRaw !== raw && artifactRaw !== `0x${raw}`) {
    fail("ARTIFACT_BUILD_MISMATCH", "artifact bytecode differs from build-info");
  }
  return `0x${raw}`;
}

function parseConstructor(value: unknown): ConstructorValues {
  const parsed = object(value, "CONSTRUCTOR_INVALID");
  const initialSupply = parsed.initialSupply ?? parsed.initialSupplyBaseUnits;
  if (typeof initialSupply !== "string" || !Array.isArray(parsed.allocations)) {
    fail("CONSTRUCTOR_INVALID", "constructor values are malformed");
  }
  return { initialSupply, allocations: parsed.allocations.map(parseAllocation) };
}

function parseAllocation(value: unknown): Allocation {
  const parsed = object(value, "CONSTRUCTOR_INVALID");
  const id = parsed.id ?? parsed.idBytes32;
  const amount = parsed.amount ?? parsed.amountBaseUnits;
  if (
    typeof id !== "string"
    || typeof parsed.recipient !== "string"
    || typeof amount !== "string"
  ) {
    fail("CONSTRUCTOR_INVALID", "allocation is malformed");
  }
  return { id, recipient: parsed.recipient, amount };
}

export function encodeConstructor(value: ConstructorValues): `0x${string}` {
  const words = [word(value.initialSupply), word("64"), word(String(value.allocations.length))];
  for (const item of value.allocations) {
    if (!/^0x[0-9a-f]{64}$/u.test(item.id) || !/^0x[0-9a-f]{40}$/u.test(item.recipient)) {
      fail("CONSTRUCTOR_INVALID", "constructor hex value is malformed");
    }
    words.push(
      item.id.slice(2),
      item.recipient.slice(2).padStart(64, "0"),
      word(item.amount),
    );
  }
  return `0x${words.join("")}`;
}

function word(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail("CONSTRUCTOR_INVALID", "constructor integer is malformed");
  }
  return BigInt(value).toString(16).padStart(64, "0");
}

function parseObject(bytes: Uint8Array, code: string): Record<string, unknown> {
  return object(parseJson(bytes, code), `${code}_INVALID`);
}

function parseArray(bytes: Uint8Array, code: string): unknown[] {
  const value = parseJson(bytes, code);
  if (!Array.isArray(value)) {
    fail(`${code}_INVALID`, `${code} must be an array`);
  }
  return value;
}

function parseJson(bytes: Uint8Array, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${code}_INVALID`, `${code} is not strict UTF-8 JSON`);
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "expected object");
  }
  return value as Record<string, unknown>;
}

function hasLinks(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.values(value as Record<string, unknown>).some(hasFileLinks);
}

function hasFileLinks(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.values(value as Record<string, unknown>).some(
    (links) => Array.isArray(links) && links.length > 0,
  );
}

function normalizeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const optimizer = object(settings.optimizer, "BUILD_OPTIMIZER_INVALID");
  const metadata = object(settings.metadata, "BUILD_METADATA_INVALID");
  return {
    optimizer: { enabled: optimizer.enabled, runs: optimizer.runs },
    evmVersion: settings.evmVersion,
    metadata: { bytecodeHash: metadata.bytecodeHash, appendCBOR: metadata.appendCBOR },
  };
}

function utf8Hex(value: string): `0x${string}` {
  return `0x${Buffer.from(value, "utf8").toString("hex")}`;
}

function hashHex(value: `0x${string}`): `0x${string}` {
  return sha256Hex(Buffer.from(value.slice(2), "hex"));
}
