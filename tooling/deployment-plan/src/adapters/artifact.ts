import { canonicalJson, sha256Hex } from "../domain/identity.ts";
import { fail } from "../domain/model.ts";
import type { ArtifactInputs } from "../application/ports.ts";

export interface TrustRoots {
  readonly schemaVersion: 1; readonly testOnly: true; readonly productionApproved: false; readonly mainnetAllowed: false;
  readonly chainId: "31337"; readonly contractFqn: string; readonly buildProfile: string; readonly from: `0x${string}`;
  readonly maximumWorstCaseWei: string; readonly gasBufferBps: string; readonly quoteTtlSeconds: string; readonly maximumHeadLag: string;
  readonly solcVersion: string; readonly compilerSettings: Record<string, unknown>; readonly artifactSha256: `0x${string}`;
  readonly abiSha256: `0x${string}`; readonly fixtureSha256: `0x${string}`; readonly fixtureReadySha256: `0x${string}`;
  readonly sourceDependencyClosure: Readonly<Record<string, `0x${string}`>>;
}
export interface ApprovedArtifact {
  readonly buildInfoSha256: `0x${string}`; readonly artifactSha256: `0x${string}`; readonly abiSha256: `0x${string}`; readonly fixtureSha256: `0x${string}`;
  readonly sourceDependencyClosure: Readonly<Record<string, `0x${string}`>>; readonly solcVersion: string; readonly compilerSettings: Record<string, unknown>;
  readonly creationBytecode: `0x${string}`; readonly creationBytecodeHash: `0x${string}`; readonly constructorAbiBytes: `0x${string}`;
  readonly constructorAbiHash: `0x${string}`; readonly constructorArguments: `0x${string}`; readonly constructorArgumentsHash: `0x${string}`;
  readonly creationInput: `0x${string}`; readonly creationInputHash: `0x${string}`;
}
const SOURCE = "src/features/token-genesis/AGTMAIToken.sol"; const CONTRACT = "AGTMAIToken";
export function approveForgeArtifact(inputs: ArtifactInputs, roots: TrustRoots): ApprovedArtifact {
  const build = parseObject(inputs.buildInfoBytes, "BUILD_INFO"); const artifact = parseObject(inputs.artifactBytes, "ARTIFACT");
  const abi = parseArray(inputs.abiBytes, "ABI"); const fixture = parseObject(inputs.fixtureBytes, "FIXTURE");
  const artifactSha256 = sha256Hex(inputs.artifactBytes); const abiSha256 = sha256Hex(inputs.abiBytes); const fixtureSha256 = sha256Hex(inputs.fixtureBytes);
  if (artifactSha256 !== roots.artifactSha256) fail("ARTIFACT_DIGEST_MISMATCH", "artifact digest differs from trust root");
  if (abiSha256 !== roots.abiSha256) fail("ABI_DIGEST_MISMATCH", "ABI digest differs from trust root");
  if (fixtureSha256 !== roots.fixtureSha256) fail("FIXTURE_DIGEST_MISMATCH", "fixture digest differs from trust root");
  if (build.solcLongVersion !== roots.solcVersion && build.solcVersion !== roots.solcVersion) fail("SOLC_MISMATCH", "build-info exact solc version differs");
  const input = object(build.input, "BUILD_INPUT_INVALID"); const settings = object(input.settings, "BUILD_SETTINGS_INVALID");
  const normalizedSettings = normalizeSettings(settings); if (canonicalJson(normalizedSettings) !== canonicalJson(roots.compilerSettings)) fail("SETTINGS_MISMATCH", "compiler settings differ from trust root");
  const sources = object(input.sources, "BUILD_SOURCES_INVALID"); const closure: Record<string, `0x${string}`> = {};
  for (const [path, source] of Object.entries(sources)) { const content = object(source, "BUILD_SOURCE_INVALID").content; if (typeof content !== "string") fail("BUILD_SOURCE_INVALID", "source content is absent"); closure[path] = sha256Hex(content); }
  if (canonicalJson(closure) !== canonicalJson(roots.sourceDependencyClosure)) fail("SOURCE_CLOSURE_MISMATCH", "source dependency closure differs from trust root");
  const output = object(build.output, "BUILD_OUTPUT_INVALID");
  const contracts = object(output.contracts, "BUILD_CONTRACTS_INVALID");
  const sourceContracts = object(contracts[SOURCE], "BUILD_SOURCE_CONTRACT_INVALID");
  const outputContract = object(sourceContracts[CONTRACT], "BUILD_CONTRACT_INVALID");
  const buildAbi = outputContract.abi; const artifactAbi = artifact.abi;
  if (canonicalJson(buildAbi) !== canonicalJson(abi) || canonicalJson(artifactAbi) !== canonicalJson(abi)) fail("ABI_BUILD_MISMATCH", "ABI/build/artifact mismatch");
  const constructor = abi.find((entry) => object(entry, "ABI_ENTRY_INVALID").type === "constructor"); if (!constructor) fail("CONSTRUCTOR_ABI_MISSING", "constructor ABI is absent");
  const constructorAbiJson = canonicalJson(constructor); const constructorAbiBytes = utf8Hex(constructorAbiJson);
  const bytecode = object(object(object(outputContract.evm, "BUILD_EVM_INVALID").bytecode, "BUILD_BYTECODE_INVALID"), "BUILD_BYTECODE_INVALID");
  if (hasLinks(bytecode.linkReferences)) fail("LINK_REFERENCES_UNSUPPORTED", "linked bytecode is unsupported");
  const raw = bytecode.object; if (typeof raw !== "string" || !/^[0-9a-f]+$/u.test(raw) || raw.length % 2) fail("BYTECODE_INVALID", "creation bytecode is malformed");
  const artifactRaw = object(artifact.bytecode, "ARTIFACT_BYTECODE_INVALID").object;
  if (artifactRaw !== raw && artifactRaw !== `0x${raw}`) fail("ARTIFACT_BUILD_MISMATCH", "artifact bytecode differs from build-info");
  const values = parseConstructor(inputs.constructorValues ?? fixture); const constructorArguments = encodeConstructor(values);
  const creationBytecode = `0x${raw}` as const; const creationInput = `${creationBytecode}${constructorArguments.slice(2)}` as `0x${string}`;
  return { buildInfoSha256: sha256Hex(inputs.buildInfoBytes), artifactSha256, abiSha256, fixtureSha256, sourceDependencyClosure: closure,
    solcVersion: roots.solcVersion, compilerSettings: normalizedSettings, creationBytecode, creationBytecodeHash: sha256Hex(hexBytes(creationBytecode)),
    constructorAbiBytes, constructorAbiHash: sha256Hex(hexBytes(constructorAbiBytes)), constructorArguments, constructorArgumentsHash: sha256Hex(hexBytes(constructorArguments)),
    creationInput, creationInputHash: sha256Hex(hexBytes(creationInput)) };
}
interface ConstructorValues { readonly initialSupply: string; readonly allocations: readonly { id: string; recipient: string; amount: string }[] }
function parseConstructor(value: unknown): ConstructorValues {
  const record = object(value, "CONSTRUCTOR_INVALID"); const initialSupply = record.initialSupply ?? record.initialSupplyBaseUnits; const allocations = record.allocations;
  if (typeof initialSupply !== "string" || !Array.isArray(allocations)) fail("CONSTRUCTOR_INVALID", "constructor values are malformed");
  return { initialSupply, allocations: allocations.map((item) => { const a = object(item, "CONSTRUCTOR_INVALID"); const id = a.id ?? a.idBytes32; const amount = a.amount ?? a.amountBaseUnits; if (typeof id !== "string" || typeof a.recipient !== "string" || typeof amount !== "string") fail("CONSTRUCTOR_INVALID", "allocation is malformed"); return { id, recipient: a.recipient, amount }; }) };
}
export function encodeConstructor(value: ConstructorValues): `0x${string}` {
  const words = [word(value.initialSupply), word("64"), word(String(value.allocations.length))];
  for (const item of value.allocations) { if (!/^0x[0-9a-f]{64}$/u.test(item.id) || !/^0x[0-9a-f]{40}$/u.test(item.recipient)) fail("CONSTRUCTOR_INVALID", "constructor hex value is malformed"); words.push(item.id.slice(2), item.recipient.slice(2).padStart(64, "0"), word(item.amount)); }
  return `0x${words.join("")}`;
}
function word(value: string): string { if (!/^(0|[1-9][0-9]*)$/u.test(value)) fail("CONSTRUCTOR_INVALID", "constructor integer is malformed"); return BigInt(value).toString(16).padStart(64, "0"); }
function parseObject(bytes: Uint8Array, code: string): Record<string, unknown> { const value = parse(bytes, code); return object(value, `${code}_INVALID`); }
function parseArray(bytes: Uint8Array, code: string): unknown[] { const value = parse(bytes, code); if (!Array.isArray(value)) fail(`${code}_INVALID`, `${code} must be an array`); return value; }
function parse(bytes: Uint8Array, code: string): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail(`${code}_INVALID`, `${code} is not strict UTF-8 JSON`); } }
function object(value: unknown, code: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, "expected object"); return value as Record<string, unknown>; }
function hasLinks(value: unknown): boolean { return value !== null && typeof value === "object" && Object.values(value as Record<string, unknown>).some((v) => v !== null && typeof v === "object" && Object.values(v as Record<string, unknown>).some((x) => Array.isArray(x) && x.length)); }
function normalizeSettings(settings: Record<string, unknown>): Record<string, unknown> { const optimizer = object(settings.optimizer, "BUILD_OPTIMIZER_INVALID"); const metadata = object(settings.metadata, "BUILD_METADATA_INVALID"); return { optimizer: { enabled: optimizer.enabled, runs: optimizer.runs }, evmVersion: settings.evmVersion, metadata: { bytecodeHash: metadata.bytecodeHash, appendCBOR: metadata.appendCBOR } }; }
function utf8Hex(value: string): `0x${string}` { return `0x${Buffer.from(value, "utf8").toString("hex")}`; }
function hexBytes(value: `0x${string}`): Uint8Array { return Buffer.from(value.slice(2), "hex"); }
