/** Filesystem entrypoint for operator compositions. Policy consumers use the separate pure deployment export. */
import { dirname, join, resolve } from "node:path";
import { deploymentBytes, type PreparedDeployment } from "../application/compile-deployment.js";
import { materializeDeploymentManifest, type DeploymentManifest } from "../application/deployment-manifest.js";
import { parsePreparedDeployment, parseDeploymentEvidence } from "../adapters/deployment-evidence.js";
import { readDeploymentFile, verifyDeploymentFiles } from "../adapters/deployment-store.js";
import { verifyPreparedArtifacts } from "../adapters/deployment-artifacts.js";
import { encodeDeploymentToken, encodeDeploymentGrant } from "../adapters/deployment-abi.js";
import { expectedTokenCalls, expectedGrantCalls, deploymentCreateAddress } from "../adapters/deployment-observations.js";
import { sha256 } from "../adapters/digest.js";

export const deploymentCompilerPorts = { sha256, encodeToken: encodeDeploymentToken, encodeGrant: encodeDeploymentGrant,
  expectedTokenCalls, expectedGrantCalls, createAddress: deploymentCreateAddress };
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
export { readDeploymentFile, verifyDeploymentFiles, publishDeploymentFiles } from "../adapters/deployment-store.js";
export { parseDeploymentSource } from "../adapters/deployment-source.js";
export { parseStrict } from "../adapters/strict-source.js";
