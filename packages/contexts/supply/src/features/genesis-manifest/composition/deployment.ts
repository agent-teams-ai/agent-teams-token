import { loadDeploymentManifest } from "./deployment-files.js";
import { dirname, resolve } from "node:path";
import { compileDeployment, deploymentBytes, type DeploymentApproval } from "../application/compile-deployment.js";
import { materializeDeploymentManifest } from "../application/deployment-manifest.js";
import { parseDeploymentSource } from "../adapters/deployment-source.js";
import { parsePreparedDeployment, parseDeploymentEvidence } from "../adapters/deployment-evidence.js";
import { readDeploymentFile, publishDeploymentFiles, verifyDeploymentFiles } from "../adapters/deployment-store.js";
import { readArtifactPins, verifyPreparedArtifacts } from "../adapters/deployment-artifacts.js";
import { encodeDeploymentToken, encodeDeploymentGrant } from "../adapters/deployment-abi.js";
import { expectedTokenCalls, expectedGrantCalls, deploymentCreateAddress } from "../adapters/deployment-observations.js";
import { sha256 } from "../adapters/digest.js";
import { parseStrict } from "../adapters/strict-source.js";

const ports = { sha256, encodeToken: encodeDeploymentToken, encodeGrant: encodeDeploymentGrant,
  expectedTokenCalls, expectedGrantCalls, createAddress: deploymentCreateAddress };
const text = async (path: string, limit?: number): Promise<string> => new TextDecoder().decode(await readDeploymentFile(path, limit));
const report = (value: unknown, status = 0): number => { process.stdout.write(`${JSON.stringify(value)}\n`); return status; };

export async function deploymentCli(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  const options = parseOptions(command, rest);
  if (!options) { return report({ status: "invalid", reason: "DEPLOYMENT_CLI_ARGUMENTS", broadcastAllowed: false }, 2); }
  const required = (key: string): string => {
    const value = options.get(key); if (!value) { throw new Error("DEPLOYMENT_CLI_ARGUMENTS"); } return value;
  };
  try {
    if (command === "validate" || command === "compile") {
      return await compileOrValidate(command, required, options);
    }
    if (command === "materialize") {
      const preparedPath = required("--prepared");
      await verifyDeploymentFiles(dirname(resolve(preparedPath)));
      const prepared = parsePreparedDeployment(await text(preparedPath), ports);
      const artifactFiles = await verifyPreparedArtifacts(prepared, dirname(resolve(preparedPath)));
      const evidence = parseDeploymentEvidence(await text(required("--evidence")));
      const manifest = materializeDeploymentManifest(prepared, evidence, ports);
      await publishDeploymentFiles(required("--output"), { ...artifactFiles, "prepared-deployment.json": deploymentBytes(prepared), "deployment-evidence.json": deploymentBytes(evidence), "deployment-manifest.json": deploymentBytes(manifest) });
      return report({ status: manifest.status, manifestSha256: sha256(deploymentBytes(manifest)), broadcastAllowed: false });
    }
    if (command === "verify") {
      const { manifest } = await loadDeploymentManifest(required("--manifest"));
      const expected = deploymentBytes(manifest);
      return report({ status: "verified", manifestSha256: sha256(expected), broadcastAllowed: false });
    }
    throw new Error("DEPLOYMENT_CLI_ARGUMENTS");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : "";
    const io = typeof code === "string" || message.startsWith("DEPLOYMENT_IO_");
    const validation = message.startsWith("DEPLOYMENT_") && !io;
    return report({ status: io ? "unavailable" : validation ? "invalid" : "internal-error",
      reason: io ? "DEPLOYMENT_IO_UNAVAILABLE" : validation ? message : "DEPLOYMENT_INTERNAL_FAILURE", broadcastAllowed: false }, io ? 3 : validation ? 2 : 4);
  }
}

async function compileOrValidate(command: string, required: (key: string) => string, options: ReadonlyMap<string, string>): Promise<number> {
      const parsed = parseDeploymentSource(await text(required("--config"), 1_048_576));
      if (!parsed.value || !parsed.canonicalBytes) { return report({ status: "invalid", diagnostics: parsed.diagnostics, broadcastAllowed: false }, 2); }
      const configurationSha256 = sha256(parsed.canonicalBytes);
      if (command === "validate") { return report({ status: "valid", configurationSha256, configurationStatus: parsed.value.status, broadcastAllowed: false }); }
      const pins = await readArtifactPins(required("--artifacts"));
      const approvalPath = options.get("--approval");
      const approval = approvalPath ? parseStrict(await text(approvalPath, 65_536)) : undefined;
      if (approval?.diagnostics.length) { return report({ status: "invalid", reason: "DEPLOYMENT_APPROVAL_INVALID", broadcastAllowed: false }, 2); }
      const result = compileDeployment(parsed.value, { ...pins, ...(approval?.value === undefined ? {} : { approval: approval.value as DeploymentApproval }) }, ports);
      if (!result.prepared) { return report({ status: "invalid", diagnostics: result.diagnostics, broadcastAllowed: false }, 2); }
      await publishDeploymentFiles(required("--output"), { ...pins.files, "canonical-configuration.json": parsed.canonicalBytes, "prepared-deployment.json": deploymentBytes(result.prepared) });
      return report({ status: "prepared", configurationSha256, preparedSha256: sha256(deploymentBytes(result.prepared)), broadcastAllowed: false });
}

function parseOptions(command: string | undefined, rest: readonly string[]): Map<string, string> | undefined {
  const allowed: Record<string, readonly string[]> = { validate: ["--config"], compile: ["--config", "--output", "--artifacts", "--approval"], materialize: ["--prepared", "--evidence", "--output"], verify: ["--manifest"] };
  if (!command || !Object.hasOwn(allowed, command)) { return undefined; }
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!key || !allowed[command]!.includes(key) || !value || value.startsWith("--") || options.has(key)) {
      return undefined;
    }
    options.set(key, value);
  }
  return options;
}
