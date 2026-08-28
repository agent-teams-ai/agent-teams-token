import { canonicalJson, type JsonValue } from "./canonical.js";
import { EXPECTED_TOKEN, normalizeLocalSource, type Diagnostic, type LocalGenesisManifest, type ValidatedLocalGenesisSource } from "../domain/model.js";

const ARTIFACT_DOMAIN = new TextEncoder().encode("AGTMAI_LOCAL_FIXTURE_ARTIFACT_V1\0");
export interface CompilerPorts {
  readonly sha256: (bytes: Uint8Array) => `0x${string}`;
  readonly encodeAllocationCommitment: (source: ValidatedLocalGenesisSource, allocations: NonNullable<ReturnType<typeof normalizeLocalSource>["allocations"]>) => { rawAbi: `0x${string}`; hash: `0x${string}` };
}

export function compileLocalSource(source: ValidatedLocalGenesisSource, ports: CompilerPorts): { diagnostics: Diagnostic[]; manifest?: LocalGenesisManifest; canonicalBytes?: Uint8Array } {
  const normalized = normalizeLocalSource(source);
  if (!normalized.allocations) {return { diagnostics: normalized.diagnostics };}
  const canonicalSourceBytes = new TextEncoder().encode(canonicalJson(source as unknown as JsonValue));
  const encoded = ports.encodeAllocationCommitment(source, normalized.allocations);
  const withoutDigest = {
    schemaVersion: 1, purpose: "local-fixture-artifact", status: "test-only",
    network: source.network,
    token: { ...EXPECTED_TOKEN, initialSupplyBaseUnits: source.token.initialSupplyBaseUnits },
    allocations: normalized.allocations,
    sourceSha256: ports.sha256(canonicalSourceBytes), rawAllocationAbi: encoded.rawAbi, genesisAllocationHash: encoded.hash,
    tool: { name: "@agent-teams/supply", feature: "genesis-manifest", version: "1" },
  } as const;
  const preimageBytes = new TextEncoder().encode(canonicalJson(withoutDigest as unknown as JsonValue));
  const combined = new Uint8Array(ARTIFACT_DOMAIN.length + preimageBytes.length); combined.set(ARTIFACT_DOMAIN); combined.set(preimageBytes, ARTIFACT_DOMAIN.length);
  const digest = ports.sha256(combined);
  const manifest: LocalGenesisManifest = { ...withoutDigest, localFixtureArtifactSha256: digest };
  return { diagnostics: [], manifest, canonicalBytes: new TextEncoder().encode(canonicalJson(manifest as unknown as JsonValue)) };
}
