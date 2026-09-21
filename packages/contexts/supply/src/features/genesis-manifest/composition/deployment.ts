import { loadDeploymentManifest } from "./deployment-files.js";
import { dirname, resolve } from "node:path";
import { compileDeployment, deploymentBytes, type DeploymentApproval } from "../application/compile-deployment.js";
import { materializeDeploymentManifest } from "../application/deployment-manifest.js";
import { parseDeploymentSource } from "../adapters/deployment-source.js";
import { parsePreparedDeployment, parseDeploymentEvidence } from "../adapters/deployment-evidence.js";
import { readDeploymentFile, publishDeploymentFiles, verifyDeploymentFiles } from "../adapters/deployment-store.js";
import { readArtifactPins, readProductionArtifactPins, verifyPreparedArtifacts } from "../adapters/deployment-artifacts.js";
import { encodeDeploymentToken, encodeDeploymentGrant, encodeProductionFounderReserve, encodeProductionReserveController } from "../adapters/deployment-abi.js";
import { expectedTokenCalls, expectedGrantCalls, deploymentCreateAddress, keccakBytes } from "../adapters/deployment-observations.js";
import { sha256 } from "../adapters/digest.js";
import { parseStrict } from "../adapters/strict-source.js";
import { prepareProductionDeployment, type ProductionApproval, type ProductionExpectation } from "../application/prepare-production-deployment.js";
import { validateProductionDeployment } from "../domain/production-deployment.js";

const ports = { sha256, encodeToken: encodeDeploymentToken, encodeGrant: encodeDeploymentGrant,
  encodeFounderReserve: encodeProductionFounderReserve, encodeReserveController: encodeProductionReserveController,
  expectedTokenCalls, expectedGrantCalls, createAddress: deploymentCreateAddress, keccak256: keccakBytes };
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
    if (command === "validate-production") {
      const value = parseProductionSource(await text(required("--config")));
      const result = validateProductionDeployment(value);
      return result.value ? report({ status: "valid", schema: "agtmai-production-deployment-v1", broadcastAllowed: false }) : report({ status: "invalid", diagnostics: result.diagnostics, broadcastAllowed: false }, 2);
    }
    if (command === "compile-production") {
      const value = parseProductionSource(await text(required("--config")));
      const artifacts = await readProductionArtifactPins(required("--artifacts"));
      const approval = parseProductionApproval(await text(required("--approval")));
      const expectations = parseProductionExpectations(await text(required("--expectations")));
      const result = prepareProductionDeployment(value, { artifactSourceRevision: artifacts.sourceRevision, artifacts: artifacts.artifacts, approval: approval as ProductionApproval, expectations: expectations as ProductionExpectation }, ports, sha256);
      if (!result.prepared) return report({ status: "invalid", diagnostics: result.diagnostics, broadcastAllowed: false }, 2);
      const output = required("--output");
      await publishDeploymentFiles(output, { ...artifacts.files, "prepared-production-deployment.json": deploymentBytes(result.prepared) });
      return report({ status: "prepared", coverage: result.prepared.coverage, broadcastAllowed: false });
    }
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
  const allowed: Record<string, readonly string[]> = { "validate-production": ["--config"], "compile-production": ["--config", "--artifacts", "--approval", "--expectations", "--output"], validate: ["--config"], compile: ["--config", "--output", "--artifacts", "--approval"], materialize: ["--prepared", "--evidence", "--output"], verify: ["--manifest"] };
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

function parseProductionSource(source: string): unknown {
  const parsed = parseStrict(source);
  if (parsed.diagnostics.length || parsed.value === undefined) { throw new Error("DEPLOYMENT_PRODUCTION_SOURCE"); }
  return parsed.value;
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("DEPLOYMENT_PRODUCTION_SOURCE");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).toSorted().join() !== [...keys].toSorted().join()) throw new Error("DEPLOYMENT_PRODUCTION_SOURCE");
  return record;
}

function allowedObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("DEPLOYMENT_PRODUCTION_SOURCE");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) throw new Error("DEPLOYMENT_PRODUCTION_SOURCE");
  return record;
}

function parseProductionApproval(source: string): ProductionApproval {
  return exactObject(parseProductionSource(source), ["configurationSha256", "reference", "reserveConfigurationSha256", "schema"]) as unknown as ProductionApproval;
}

function parseProductionExpectations(source: string): ProductionExpectation {
  const root = exactObject(parseProductionSource(source), ["artifactPinsSha256", "attemptIdentity", "authority", "chainId", "configurationSha256", "deployer", "maxObservationAgeSeconds", "maxTotalCostWei", "operations", "reserveConfigurationSha256", "schema", "sender", "sourceRevision", "startingNonce"]);
  if (!Array.isArray(root.authority) || !Array.isArray(root.operations)) throw new Error("DEPLOYMENT_PRODUCTION_SOURCE");
  for (const safe of root.authority) exactObject(safe, ["address", "fallbackHandler", "guard", "modules", "nonce", "owners", "proxyCodeHash", "singletonCodeHash", "setupProvenance", "singletonAddress", "singletonSlot", "threshold"]);
  for (const operation of root.operations) allowedObject(operation, ["baseFeePerGas", "blockGasLimit", "expectedAddress", "nestedAddress", "gasEstimate", "gasLimit", "initcode", "initcodeHash", "intentHash", "kind", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "runtime", "runtimeHash", "value", "id"]);
  return root as unknown as ProductionExpectation;
}
