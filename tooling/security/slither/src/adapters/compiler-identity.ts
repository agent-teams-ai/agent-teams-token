import type { GateManifest } from "../domain/model.ts";
import { SlitherGateError } from "../domain/model.ts";
import { parseTypedJson } from "./policy-shape.ts";

export interface ForgeArtifact { readonly abi?: unknown; readonly bytecode?: { readonly object?: unknown }; readonly metadata?: unknown; readonly rawMetadata?: unknown }
export interface BuildInfo {
  readonly solcVersion?: unknown;
  readonly solcLongVersion?: unknown;
  readonly input?: { readonly sources?: Record<string, {readonly content?: unknown}>; readonly settings?: { readonly evmVersion?: unknown; readonly optimizer?: { readonly enabled?: unknown; readonly runs?: unknown }; readonly metadata?: { readonly bytecodeHash?: unknown; readonly appendCBOR?: unknown; readonly useLiteralContent?: unknown }; readonly viaIR?: unknown; readonly experimental?: unknown; readonly remappings?: unknown; readonly libraries?: unknown } };
  readonly output?: { readonly contracts?: Record<string, Record<string, { readonly evm?: { readonly bytecode?: { readonly object?: unknown } } }>> };
}

function compilerMetadataObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new SlitherGateError("BUILD_INFO_INVALID", "compiler metadata is not an object");}
  return value as Record<string, unknown>;
}
function embeddedCompilerVersion(metadata: Record<string, unknown>): GateManifest["compiler"]["version"] {
  const compiler = compilerMetadataObject(metadata.compiler);
  if (Object.keys(compiler).length !== 1 || compiler.version !== "0.8.36+commit.8a079791") {throw new SlitherGateError("BUILD_INFO_INVALID", "embedded compiler identity differs from the exact pinned commit");}
  return compiler.version;
}
function parseCompilerMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") {throw new SlitherGateError("BUILD_INFO_INVALID", "raw compiler metadata is absent or malformed");}
  const metadata = compilerMetadataObject(parseTypedJson(raw, "BUILD_INFO_INVALID", "embedded compiler metadata"));
  embeddedCompilerVersion(metadata);
  return metadata;
}
function sameCompilerMetadata(left: unknown, right: unknown): boolean {
  if (left === right) {return true;}
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) {return false;}
  const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && sameCompilerMetadata(a[key], b[key]));
}
export function validateCompilerIdentity(build: BuildInfo, artifact: ForgeArtifact, sourceName: string, contractName: string): GateManifest["compiler"]["version"] {
  // Forge 1.8.0 emits the short release in BOTH build-info fields. The commit
  // comes from every solc metadata document, alongside verifyVersions() and
  // the authenticated mounted solc binary; it is never inferred from semver.
  if (build?.solcVersion !== "0.8.36" || build.solcLongVersion !== "0.8.36") {throw new SlitherGateError("BUILD_INFO_INVALID", "Foundry compiler version fields differ from the captured format");}
  const contracts = compilerMetadataObject(build.output?.contracts);
  let target: Record<string, unknown> | undefined;
  for (const [path, source] of Object.entries(contracts)) {
    const outputs = compilerMetadataObject(source);
    if (Object.keys(outputs).length === 0) {throw new SlitherGateError("BUILD_INFO_INVALID", "compiler contract metadata is absent");}
    for (const [name, output] of Object.entries(outputs)) {
      const metadata = parseCompilerMetadata(compilerMetadataObject(output).metadata);
      if (path === sourceName && name === contractName) {target = metadata;}
    }
  }
  const rawMetadata = parseCompilerMetadata(artifact?.rawMetadata);
  // Forge's object metadata is a lossy representation (NatSpec/remappings).
  // Its compiler identity must agree; the raw document binds the full metadata.
  const version = embeddedCompilerVersion(compilerMetadataObject(artifact.metadata));
  if (!target || !sameCompilerMetadata(rawMetadata, target)) {throw new SlitherGateError("BUILD_INFO_INVALID", "artifact and build-info compiler metadata differ");}
  return version;
}
export type FixtureCompilerProfile = Omit<GateManifest["compiler"], "remappings"> & { readonly remappings: readonly [] };
export function validateBuildCompiler(build: BuildInfo, version: GateManifest["compiler"]["version"]): GateManifest["compiler"];
export function validateBuildCompiler(build: BuildInfo, version: GateManifest["compiler"]["version"], scope: "vulnerable-fixture"): FixtureCompilerProfile;
export function validateBuildCompiler(build: BuildInfo, version: GateManifest["compiler"]["version"], scope?: "vulnerable-fixture"): GateManifest["compiler"] | FixtureCompilerProfile {
  const settings = build.input?.settings;
  if (!settings) {
    throw new SlitherGateError("BUILD_INFO_INVALID", "fresh build-info lacks compiler identity");
  }
  if (scope !== undefined && scope !== "vulnerable-fixture") {throw new SlitherGateError("BUILD_INFO_INVALID", "unsupported compiler scope");}
  // The isolated input has no library tree. Missing remappings and an explicit
  // empty array denote that profile; null, objects and strings never do.
  const remappings = scope === "vulnerable-fixture" && !Object.hasOwn(settings, "remappings")
    ? [] : stringArray(settings.remappings).toSorted();
  const common = {
    version,
    evmVersion: "paris",
    optimizerEnabled: true,
    optimizerRuns: 200,
    bytecodeHash: "ipfs",
    cborMetadata: true,
    useLiteralContent: false,
    viaIR: false,
    experimental: false,
  } as const;
  const profile: GateManifest["compiler"] | FixtureCompilerProfile = scope === "vulnerable-fixture"
    ? { ...common, remappings: [] }
    : { ...common, remappings: [
      "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
      "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/",
    ] };
  const observed = {
    version,
    evmVersion: settings.evmVersion,
    optimizerEnabled: settings.optimizer?.enabled,
    optimizerRuns: settings.optimizer?.runs,
    bytecodeHash: settings.metadata?.bytecodeHash,
    cborMetadata: settings.metadata?.appendCBOR,
    useLiteralContent: settings.metadata?.useLiteralContent,
    viaIR: settings.viaIR,
    experimental: settings.experimental,
    remappings,
  };
  if (JSON.stringify(observed) !== JSON.stringify(profile) || !isEmptyRecord(settings.libraries)) {
    throw new SlitherGateError("COMPILER_SETTINGS_MISMATCH", "fresh build uses unexpected compiler settings");
  }
  return profile;
}
function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {throw new SlitherGateError("COMPILER_SETTINGS_MISMATCH", "compiler remappings are not an array of strings");}
  return value;
}
const isEmptyRecord = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
