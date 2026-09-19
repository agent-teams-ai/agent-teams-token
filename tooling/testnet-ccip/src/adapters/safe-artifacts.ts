import { createHash } from "node:crypto";
import { deploymentBytes, isDigest, isEvmAddress, type Hex } from "@agent-teams/supply/deployment";
import { custodyKeccak, type SafeProfile } from "./safe-custody.ts";

const qualified = Symbol("reviewed-safe-artifacts");
export type QualifiedSafeProfile = SafeProfile & { readonly [qualified]: true };
export interface SafeArtifactPins {
  readonly schema: "agtmai-safe-artifact-pins-v1";
  readonly source: "safe-global/safe-smart-account";
  readonly sourceRevision: string;
  readonly version: "1.4.1";
  readonly compilerVersion: string;
  readonly buildInfoSha256: Hex;
  readonly proxy: SafeArtifactPin;
  readonly singleton: SafeArtifactPin;
}
interface SafeArtifactPin {
  readonly sourceName: string;
  readonly contractName: "SafeProxy" | "Safe";
  readonly artifactSha256: Hex;
  readonly abiSha256: Hex;
  readonly runtimeKeccak256: Hex;
}
export interface SafeArtifactBytes {
  readonly proxy: Uint8Array;
  readonly singleton: Uint8Array;
  readonly buildInfo: Uint8Array;
}
const fail = (): never => { throw new Error("CUSTODY_SAFE_PROFILE_UNQUALIFIED"); };
const sha256 = (bytes: Uint8Array): Hex => `0x${createHash("sha256").update(bytes).digest("hex")}`;
const parse = (bytes: Uint8Array): Record<string, any> => {
  if (bytes.byteLength === 0 || bytes.byteLength > 32 * 1024 * 1024) { return fail(); }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) { return fail(); }
    return value;
  } catch { return fail(); }
};
const bytecode = (value: unknown): value is Hex => typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value);

/** The selected digest comes from review, never from the artifact bundle or a captured RPC profile.
 * Hardhat artifact/build-info bytes stay separate from Supply's token/vault artifact schema.
 * The digest authenticates the reviewed source provenance assertion; hashes alone do not establish official origin.
 */
export function qualifySafeArtifacts(pins: SafeArtifactPins, selectedPinsSha256: Hex, bytes: SafeArtifactBytes, singleton: Hex): QualifiedSafeProfile {
  if (!pins || !isDigest(selectedPinsSha256) || sha256(deploymentBytes(pins)) !== selectedPinsSha256
    || pins.schema !== "agtmai-safe-artifact-pins-v1" || pins.source !== "safe-global/safe-smart-account"
    || pins.version !== "1.4.1" || !/^[0-9a-f]{40}$/.test(pins.sourceRevision)
    || !/^0\.7\.6\+commit\.7338295f$/.test(pins.compilerVersion) || !isEvmAddress(singleton)
    || pins.proxy?.contractName !== "SafeProxy" || pins.singleton?.contractName !== "Safe"
    || !isDigest(pins.buildInfoSha256) || sha256(bytes.buildInfo) !== pins.buildInfoSha256) { return fail(); }
  const build = parse(bytes.buildInfo);
  verifyBuild(build, pins);
  verifyArtifact(pins.proxy, bytes.proxy, build, pins.compilerVersion);
  verifyArtifact(pins.singleton, bytes.singleton, build, pins.compilerVersion);
  const profile: QualifiedSafeProfile = { [qualified]: true, schema: "agtmai-official-safe-profile-v1", version: pins.version,
    source: pins.source, sourceRevision: pins.sourceRevision, singleton,
    proxyArtifactSha256: pins.proxy.artifactSha256, singletonArtifactSha256: pins.singleton.artifactSha256,
    proxyRuntimeKeccak256: pins.proxy.runtimeKeccak256, singletonRuntimeKeccak256: pins.singleton.runtimeKeccak256 };
  Object.defineProperty(profile, qualified, { enumerable: false });
  return Object.freeze(profile);
}

function verifyBuild(build: Record<string, any>, pins: SafeArtifactPins): void {
  if (build["_format"] !== "hh-sol-build-info-1" || build.solcLongVersion !== pins.compilerVersion
    || build.solcVersion !== "0.7.6" || build.input?.language !== "Solidity" || !build.input?.sources) { fail(); }
}
function verifyArtifact(pin: SafeArtifactPin, bytes: Uint8Array, build: Record<string, any>, compiler: string): void {
  const artifact = parse(bytes);
  if (![pin.artifactSha256, pin.abiSha256, pin.runtimeKeccak256].every(isDigest)
    || sha256(bytes) !== pin.artifactSha256 || artifact["_format"] !== "hh-sol-artifact-1"
    || artifact.sourceName !== pin.sourceName || artifact.contractName !== pin.contractName
    || !Array.isArray(artifact.abi) || sha256(deploymentBytes(artifact.abi)) !== pin.abiSha256
    || !bytecode(artifact.bytecode) || !bytecode(artifact.deployedBytecode)) { fail(); }
  verifyRuntime(pin, artifact);
  verifyCompilerOutput(pin, artifact, build, compiler);
}
function verifyRuntime(pin: SafeArtifactPin, artifact: Record<string, any>): void {
  if (custodyKeccak(Buffer.from(artifact.deployedBytecode.slice(2), "hex")) !== pin.runtimeKeccak256
    || Object.keys(artifact.linkReferences ?? {}).length || Object.keys(artifact.deployedLinkReferences ?? {}).length) { fail(); }
}
function verifyCompilerOutput(pin: SafeArtifactPin, artifact: Record<string, any>, build: Record<string, any>, compiler: string): void {
  const compiled = build.output?.contracts?.[pin.sourceName]?.[pin.contractName];
  if (!build.input.sources[pin.sourceName]?.content || !compiled
    || sha256(deploymentBytes(compiled.abi)) !== pin.abiSha256
    || `0x${compiled.evm?.bytecode?.object}` !== artifact.bytecode
    || `0x${compiled.evm?.deployedBytecode?.object}` !== artifact.deployedBytecode) { fail(); }
  verifySourceMetadata(compiled, build, compiler);
}
function verifySourceMetadata(compiled: Record<string, any>, build: Record<string, any>, compiler: string): void {
  const metadata = typeof compiled.metadata === "string" ? parse(new TextEncoder().encode(compiled.metadata)) : fail();
  if (metadata.compiler?.version !== compiler || !metadata.sources || !Object.keys(metadata.sources).length) { fail(); }
  for (const [source, entry] of Object.entries(metadata.sources) as [string, { keccak256: Hex }][]) {
    const content = build.input.sources[source]?.content;
    if (typeof content !== "string" || entry.keccak256 !== custodyKeccak(new TextEncoder().encode(content))) { fail(); }
  }
}

export function requireQualifiedSafeProfile(profile: QualifiedSafeProfile): void {
  if (!profile || profile[qualified] !== true || !Object.isFrozen(profile)) { fail(); }
}
