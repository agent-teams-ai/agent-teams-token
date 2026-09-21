import { parseJsonWithoutDuplicates } from "./strict-json.ts";
import { createHash } from "node:crypto";
import { evaluateReadiness, SOLANA_MAINNET_GENESIS, type ReadinessEvidence, type ReadinessProtocolContext } from "../domain/readiness.ts";

/** Parse and validate the public, read-only evidence envelope before evaluation. */
export function parseReadinessEvidence(bytes: Uint8Array): ReadinessEvidence {
  const value = parseJsonWithoutDuplicates(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error("READINESS_EVIDENCE_SCHEMA"); }
  const evidence = value as ReadinessEvidence;
  if (evidence.schema !== "agtmai-readiness-evidence-v1" || evidence.broadcastAllowed !== false) { throw new Error("READINESS_EVIDENCE_SCHEMA"); }
  const root = value as Record<string, unknown>;
  exact(root, ["broadcastAllowed", "coverageComplete", "ethereum", "estimates", "manifestSha256", "observedAt", "protocolQualified", "schema", "solana", "validUntil"]);
  const ethereum = object(root.ethereum), block = object(ethereum.block), solana = object(root.solana);
  exact(ethereum, ["authorityComplete", "backing", "block", "chainId", "deployed", "fixedSupply", "pendingEthereumToSolana", "pendingSolanaToEthereum"]);
  exact(block, ["hash", "number", "timestamp"]);
  exact(solana, ["authorityComplete", "blockTime", "deployed", "genesisHash", "slot", "supply"]);
  if (root.estimates !== undefined) { const estimates = object(root.estimates); exact(estimates, estimates.operations === undefined ? ["complete"] : ["complete", "operations"]); if (estimates.operations !== undefined && !Array.isArray(estimates.operations)) { throw new Error("READINESS_EVIDENCE_SCHEMA"); } for (const operation of (estimates.operations as unknown[] ?? [])) { exact(object(operation), ["estimatedNative", "expiresAt", "id", "worstCaseNative"]); } }
  evaluateReadiness(evidence);
  return evidence;
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : (() => { throw new Error("READINESS_EVIDENCE_SCHEMA"); })();
const exact = (value: Record<string, unknown>, keys: readonly string[]): void => { if (Object.keys(value).toSorted().join(",") !== keys.toSorted().join(",")) { throw new Error("READINESS_EVIDENCE_SCHEMA"); } };
export function verifyReadinessEvidence(evidence: ReadinessEvidence): ReturnType<typeof evaluateReadiness> { return evaluateReadiness(evidence); }
/**
 * Extract only the manifest facts needed by readiness.  The deployment
 * manifest stays independently content-addressed; this adapter does not turn
 * its pins into protocol qualification.
 */
export function parseReadinessManifestProtocol(value: unknown): ReadinessProtocolContext {
  try {
    const manifest = object(value);
    if (manifest.schema !== "agtmai-deployment-manifest-v1" || manifest.broadcastAllowed !== false) { throw new Error("READINESS_MANIFEST_INVALID"); }
    const configuration = object(manifest.configuration), environment = object(configuration.environment), bridge = object(configuration.bridge);
    if (configuration.status !== "accepted" || environment.mode !== "mainnet-dry-run" || environment.evmChainId !== "1"
      || environment.solanaGenesisHash !== SOLANA_MAINNET_GENESIS) { throw new Error("READINESS_MANIFEST_INVALID"); }
    const protocol = object(bridge.protocol);
    exact(protocol, ["networkDataSha256", "reference", "snapshotSha256"]);
    if (typeof protocol.reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9./_-]{0,159}$/u.test(protocol.reference) || protocol.reference.includes("..")
      || !digest(protocol.snapshotSha256) || !digest(protocol.networkDataSha256)) { throw new Error("READINESS_MANIFEST_INVALID"); }
    return { reference: protocol.reference, snapshotSha256: protocol.snapshotSha256, networkDataSha256: protocol.networkDataSha256, solanaGenesisHash: environment.solanaGenesisHash };
  } catch { throw new Error("READINESS_MANIFEST_INVALID"); }
}
const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") { return JSON.stringify(value); }
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) { throw new Error("READINESS_MANIFEST_INVALID"); } return JSON.stringify(value); }
  if (Array.isArray(value)) { return `[${value.map(canonical).join(",")}]`; }
  if (typeof value !== "object") { throw new Error("READINESS_MANIFEST_INVALID"); }
  return `{${Object.keys(value as object).toSorted().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
};
export function digestReadinessManifest(value: unknown): string { return `0x${createHash("sha256").update(new TextEncoder().encode(canonical(value))).digest("hex")}`; }
const digest = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/u.test(value);
