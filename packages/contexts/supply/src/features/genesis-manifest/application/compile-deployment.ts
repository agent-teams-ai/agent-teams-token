import { canonicalJson, type JsonValue } from "./canonical.js";
import { validateDeployment, isDigest, isEvmAddress, type DeploymentConfig, type DeploymentGrant, type Hex } from "../domain/deployment.js";
import type { Diagnostic, NormalizedAllocation } from "../domain/model.js";

export interface DeploymentArtifact {
  readonly contract: "AGTMAICCIPToken" | "GrantVault";
  readonly compilerVersion: "0.8.36";
  readonly artifactSha256: Hex; readonly buildInfoSha256: Hex; readonly compilerInputSha256: Hex;
  readonly creationBytecode: Hex; readonly runtimeBytecode: Hex;
  readonly immutableReferences: readonly { readonly start: number; readonly length: number }[];
}
export interface DeploymentApproval {
  readonly schema: "agtmai-deployment-approval-v1";
  readonly configurationSha256: Hex; readonly reference: string;
}
export interface PreparedDeployment {
  readonly schema: "agtmai-prepared-deployment-v1";
  readonly broadcastAllowed: false;
  readonly sourceRevision: string;
  readonly configuration: DeploymentConfig; readonly configurationSha256: Hex;
  readonly approval: DeploymentApproval | null;
  readonly artifacts: readonly DeploymentArtifact[];
  readonly token: { readonly constructorArgs: Hex; readonly initcode: Hex; readonly rawAllocationAbi: Hex; readonly genesisAllocationHash: Hex };
}
export interface DeploymentCompilerPorts {
  readonly sha256: (bytes: Uint8Array) => Hex;
  readonly encodeToken: (config: DeploymentConfig, allocations: readonly NormalizedAllocation[]) => Omit<PreparedDeployment["token"], "initcode">;
  readonly encodeGrant: (config: DeploymentConfig, grant: DeploymentGrant, token: Hex) => Hex;
}
export const deploymentBytes = (value: unknown): Uint8Array => new TextEncoder().encode(canonicalJson(value as JsonValue));
const failure = (code: string, pointer: string): Diagnostic => ({ code, pointer, severity: "error", message: "deployment preparation refused" });

/** Pure preparation of unsigned inputs. Independently selected approval is required for production. */
export function compileDeployment(input: unknown, pins: { readonly sourceRevision: string; readonly artifacts: readonly DeploymentArtifact[]; readonly approval?: DeploymentApproval }, ports: DeploymentCompilerPorts): { readonly diagnostics: readonly Diagnostic[]; readonly prepared?: PreparedDeployment } {
  const validated = validateDeployment(input);
  if (!validated.value || !validated.allocations) { return { diagnostics: validated.diagnostics }; }
  const config = validated.value, diagnostics: Diagnostic[] = [];
  // Mainnet-shaped v1 input is intentionally no longer a compilation authority.
  // Production preparation must first bind the accepted reserve envelope.
  if (config.environment.mode === "mainnet-dry-run") {
    diagnostics.push(failure("DEPLOYMENT_PRODUCTION_ENVELOPE_REQUIRED", "/"));
    return { diagnostics };
  }
  const configurationSha256 = ports.sha256(deploymentBytes(config));
  if (config.status === "draft") { diagnostics.push(failure("DEPLOYMENT_DRAFT_NOT_COMPILABLE", "/status")); }
  if (!/^[0-9a-f]{40}$/.test(pins.sourceRevision)) { diagnostics.push(failure("DEPLOYMENT_SOURCE_REVISION", "/sourceRevision")); }
  diagnostics.push(...validateArtifacts(pins.artifacts));
  if (diagnostics.length) { return { diagnostics }; }
  const encoded = ports.encodeToken(config, validated.allocations);
  const artifact = pins.artifacts.find(a => a.contract === "AGTMAICCIPToken")!;
  const initcode: Hex = `${artifact.creationBytecode}${encoded.constructorArgs.slice(2)}`;
  return { diagnostics: [], prepared: { schema: "agtmai-prepared-deployment-v1", broadcastAllowed: false,
    sourceRevision: pins.sourceRevision, configuration: config, configurationSha256,
    approval: null,
    artifacts: [...pins.artifacts].toSorted((a, b) => a.contract < b.contract ? -1 : 1), token: { ...encoded, initcode } } };
}

/** Prepare a vault only after the caller supplies the authenticated canonical token address. */
export function prepareGrant(prepared: PreparedDeployment, grantId: string, token: Hex, ports: DeploymentCompilerPorts): { readonly constructorArgs: Hex; readonly initcode: Hex } {
  if (!isEvmAddress(token)) { throw new Error("DEPLOYMENT_TOKEN_ADDRESS"); }
  const grant = prepared.configuration.grants.find(g => g.id === grantId);
  const artifact = prepared.artifacts.find(a => a.contract === "GrantVault");
  if (!grant || !artifact) { throw new Error("DEPLOYMENT_GRANT_REFERENCE"); }
  const constructorArgs = ports.encodeGrant(prepared.configuration, grant, token);
  return { constructorArgs, initcode: `${artifact.creationBytecode}${constructorArgs.slice(2)}` };
}

function validateArtifacts(artifacts: readonly DeploymentArtifact[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (artifacts.length !== 2 || new Set(artifacts.map(a => a.contract)).size !== 2) {
    diagnostics.push(failure("DEPLOYMENT_ARTIFACT_SET", "/artifacts"));
  }
  for (const artifact of artifacts) {
    if (Object.keys(artifact).toSorted().join() !== "artifactSha256,buildInfoSha256,compilerInputSha256,compilerVersion,contract,creationBytecode,immutableReferences,runtimeBytecode" || !["AGTMAICCIPToken", "GrantVault"].includes(artifact.contract) || artifact.compilerVersion !== "0.8.36" || !isDigest(artifact.artifactSha256) || !isDigest(artifact.buildInfoSha256) || !isDigest(artifact.compilerInputSha256)
      || !/^0x(?:[0-9a-f]{2})+$/.test(artifact.creationBytecode) || !/^0x(?:[0-9a-f]{2})+$/.test(artifact.runtimeBytecode)
      || artifact.immutableReferences.length === 0 || artifact.immutableReferences.some(r => Object.keys(r).toSorted().join() !== "length,start" || !Number.isSafeInteger(r.start) || r.start < 0 || r.length !== 32 || (r.start + r.length) * 2 > artifact.runtimeBytecode.length - 2)) {
      diagnostics.push(failure("DEPLOYMENT_ARTIFACT_INVALID", "/artifacts"));
    }
  }
  return diagnostics;
}
