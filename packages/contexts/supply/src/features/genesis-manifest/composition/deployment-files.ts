/** Filesystem entrypoint for operator compositions. Policy consumers use the separate pure deployment export. */
import { dirname, join, resolve } from "node:path";
import { deploymentBytes, type PreparedDeployment } from "../application/compile-deployment.js";
import { materializeDeploymentManifest, type DeploymentManifest } from "../application/deployment-manifest.js";
import { prepareProductionDeployment, type PreparedProductionDeployment, type ProductionApproval, type ProductionExpectation } from "../application/prepare-production-deployment.js";
import { prepareLocalPurposeGenesis } from "../application/prepare-local-purpose-genesis.js";
import { parsePreparedDeployment, parseDeploymentEvidence } from "../adapters/deployment-evidence.js";
import { readDeploymentFile, verifyDeploymentFiles } from "../adapters/deployment-store.js";
import { readProductionArtifactPins, verifyPreparedArtifacts } from "../adapters/deployment-artifacts.js";
import { encodeDeploymentToken, encodeDeploymentGrant, encodeProductionFounderReserve, encodeProductionReserveController, encodeLocalPurposeToken, encodeLocalPurposeVault, encodeProductionFounderVault } from "../adapters/deployment-abi.js";
import { expectedTokenCalls, expectedGrantCalls, deploymentCreateAddress, keccakBytes } from "../adapters/deployment-observations.js";
import { sha256 } from "../adapters/digest.js";
import { parseStrict } from "../adapters/strict-source.js";
import type { LocalPurposeCandidate } from "../adapters/local-purpose-build.js";
import type { Hex } from "../domain/deployment.js";

export const deploymentCompilerPorts = { sha256, encodeToken: encodeDeploymentToken, encodeGrant: encodeDeploymentGrant,
  expectedTokenCalls, expectedGrantCalls, createAddress: deploymentCreateAddress };
export const productionCompilerPorts = { encodePurposeVault: encodeLocalPurposeVault, encodeFounderVault: encodeProductionFounderVault, encodeToken: encodeDeploymentToken, encodeFounderReserve: encodeProductionFounderReserve,
  encodeReserveController: (input: { token: Hex; controller: Hex; purpose: Hex; rollingCap: string; perGrantCap: string }) => encodeProductionReserveController(input.token, input.controller, input.purpose, input.rollingCap, input.perGrantCap), createAddress: deploymentCreateAddress, keccak256: keccakBytes };
export const localPurposeCompilerPorts = { sha256, keccak256: keccakBytes, createAddress: deploymentCreateAddress,
  encodeToken: encodeLocalPurposeToken, encodeFounderReserve: encodeProductionFounderReserve,
  encodeReserveController: encodeProductionReserveController, encodePurposeVault: encodeLocalPurposeVault, encodeFounderVault: encodeProductionFounderVault };
export { prepareLocalPurposeGenesis };
const text = async (path: string): Promise<string> => new TextDecoder().decode(await readDeploymentFile(path));
export async function loadPreparedDeployment(path: string): Promise<PreparedDeployment> {
  const selected = resolve(path), directory = dirname(selected);
  if (selected !== join(directory, "prepared-deployment.json")) { throw new Error("DEPLOYMENT_PREPARED_FILENAME"); }
  await verifyDeploymentFiles(directory);
  const prepared = parsePreparedDeployment(await text(selected), deploymentCompilerPorts);
  await verifyPreparedArtifacts(prepared, directory);
  return prepared;
}
export async function loadDeploymentManifest(path: string): Promise<{ readonly manifest: DeploymentManifest; readonly prepared: PreparedDeployment }> {
  const selected = resolve(path), directory = dirname(selected);
  if (selected !== join(directory, "deployment-manifest.json")) { throw new Error("DEPLOYMENT_MANIFEST_FILENAME"); }
  const prepared = await loadPreparedDeployment(join(directory, "prepared-deployment.json"));
  const evidence = parseDeploymentEvidence(await text(join(directory, "deployment-evidence.json")));
  const manifest = materializeDeploymentManifest(prepared, evidence, deploymentCompilerPorts);
  if (sha256(await readDeploymentFile(selected)) !== sha256(deploymentBytes(manifest))) { throw new Error("DEPLOYMENT_MANIFEST_MISMATCH"); }
  return { manifest, prepared };
}

/** Re-open the exact published inventory and reconstruct it through Supply's production authority. */
export async function loadPreparedProductionPackage(directory: string, candidate?: LocalPurposeCandidate): Promise<PreparedProductionDeployment> {
  const selected = resolve(directory);
  const inventory = await verifyDeploymentFiles(selected);
  const configuration = productionSource(await text(join(selected, "canonical-production-configuration.json")));
  const v2 = (configuration as { schema?: unknown }).schema === "agtmai-production-deployment-v2";
  const requiredFiles = [
    "agtmaicciptoken.artifact.json", "agtmaicciptoken.build-info.json",
    "canonical-production-configuration.json", "foundergrantreserve.artifact.json", "foundergrantreserve.build-info.json",
    "prepared-production-deployment.json", "production-approval.json", "production-artifact-pins.json", "production-expectations.json",
    "reservecontroller.artifact.json", "reservecontroller.build-info.json",
    ...(v2 ? ["purposereservevault.artifact.json", "purposereservevault.build-info.json", "grantvault.artifact.json", "grantvault.build-info.json"] : []),
  ].toSorted();
  if (JSON.stringify(inventory.files.map(file => file.name).toSorted()) !== JSON.stringify(requiredFiles)) {throw new Error("DEPLOYMENT_PRODUCTION_PACKAGE_INVENTORY");}
  const artifacts = await readProductionArtifactPins(join(selected, "production-artifact-pins.json"), candidate);
  const approval = parseProductionApproval(await text(join(selected, "production-approval.json")));
  const expectations = parseProductionExpectations(await text(join(selected, "production-expectations.json")));
  const result = prepareProductionDeployment(configuration, { artifactSourceRevision: artifacts.sourceRevision, artifacts: artifacts.artifacts, approval, expectations }, productionCompilerPorts, sha256);
  if (!result.prepared) {throw new Error(`DEPLOYMENT_PRODUCTION_RECONSTRUCTION:${result.diagnostics.map(diagnostic => diagnostic.code).join(",")}`);}
  const published = await readDeploymentFile(join(selected, "prepared-production-deployment.json"));
  if (sha256(published) !== sha256(deploymentBytes(result.prepared))) {throw new Error("DEPLOYMENT_PRODUCTION_PREPARED_MISMATCH");}
  return result.prepared;
}

function productionSource(source: string): unknown {
  const parsed = parseStrict(source);
  if (parsed.diagnostics.length || parsed.value === undefined) {throw new Error("DEPLOYMENT_PRODUCTION_SOURCE");}
  return parsed.value;
}

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new Error("DEPLOYMENT_PRODUCTION_SOURCE");}
  const record = value as Record<string, unknown>;
  if (Object.keys(record).toSorted().join() !== [...fields].toSorted().join()) {throw new Error("DEPLOYMENT_PRODUCTION_SOURCE");}
  return record;
}

export function parseProductionApproval(source: string): ProductionApproval {
  const value = productionSource(source) as { schema?: unknown };
  if (value.schema !== "agtmai-production-approval-v1" && value.schema !== "agtmai-production-approval-v2") { throw new Error("DEPLOYMENT_PRODUCTION_SOURCE"); }
  return exactObject(value, ["configurationSha256", "reference", "reserveConfigurationSha256", "schema", ...(value.schema === "agtmai-production-approval-v2" ? ["assemblyConfigurationSha256"] : [])]) as unknown as ProductionApproval;
}

export function parseProductionExpectations(source: string): ProductionExpectation {
  const value = productionSource(source) as { schema?: unknown };
  if (value.schema !== "agtmai-production-expectations-v1" && value.schema !== "agtmai-production-expectations-v2") { throw new Error("DEPLOYMENT_PRODUCTION_SOURCE"); }
  const v2 = value.schema === "agtmai-production-expectations-v2";
  const root = exactObject(value, ["artifactPinsSha256", "attemptIdentity", "authority", "chainId", "configurationSha256", "deployer", "maxObservationAgeSeconds", "maxTotalCostWei", "operations", "reserveConfigurationSha256", "schema", "sender", "sourceRevision", "startingNonce", ...(v2 ? ["assemblyConfigurationSha256", "coverage"] : [])]);
  if (!Array.isArray(root.authority) || !Array.isArray(root.operations)) {throw new Error("DEPLOYMENT_PRODUCTION_SOURCE");}
  for (const safe of root.authority) {exactObject(safe, ["address", "fallbackHandler", "guard", "modules", "nonce", "owners", "proxyCodeHash", "singletonCodeHash", "setupProvenance", "singletonAddress", "singletonSlot", "threshold"]);}
  const common = ["baseFeePerGas", "blockGasLimit", "expectedAddress", "gasEstimate", "gasLimit", "id", "intentHash", "kind", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "value"];
  for (const operation of root.operations) {
    const item = operation as Record<string, unknown>;
    const runtime = v2 ? ["runtimeTemplate", "runtimeTemplateHash"] : ["runtime", "runtimeHash"];
    const fields = item.kind === "call" ? [...common, "calldata"] : [...common, "initcode", "initcodeHash", ...runtime, ...(item.id === "founder-reserve-create" ? ["nestedAddress"] : [])];
    exactObject(operation, fields);
  }
  return root as unknown as ProductionExpectation;
}
export { readDeploymentFile, verifyDeploymentFiles, publishDeploymentFiles } from "../adapters/deployment-store.js";
export { readProductionArtifactPins, readLocalPurposeArtifactPins } from "../adapters/deployment-artifacts.js";
export type { LocalPurposeCandidate } from "../adapters/local-purpose-build.js";
export { parseDeploymentSource } from "../adapters/deployment-source.js";
export { parseStrict };
