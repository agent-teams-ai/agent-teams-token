import { basename, dirname, resolve, join } from "node:path";
import { deploymentBytes, type DeploymentArtifact, type PreparedDeployment } from "../application/compile-deployment.js";
import type { ProductionArtifactPin } from "../application/prepare-production-deployment.js";
import { isDigest } from "../domain/deployment.js";
import { readDeploymentFile } from "./deployment-store.js";
import { sha256 } from "./digest.js";
import { parseStrict } from "./strict-source.js";

const refuse = (): never => { throw new Error("DEPLOYMENT_ARTIFACT_PINS_INVALID"); };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : refuse();
const exact = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).toSorted().join() !== [...keys].toSorted().join()) { refuse(); }
};
const json = (bytes: Uint8Array): Record<string, unknown> => {
  try { return record(JSON.parse(new TextDecoder().decode(bytes))); } catch { return refuse(); }
};

export async function readArtifactPins(path: string): Promise<{ readonly sourceRevision: string; readonly artifacts: readonly DeploymentArtifact[]; readonly files: Readonly<Record<string, Uint8Array>> }> {
  const parsed = parseStrict(new TextDecoder().decode(await readDeploymentFile(path, 1_048_576)));
  if (parsed.diagnostics.length) { return refuse(); }
  const pins = record(parsed.value);
  exact(pins, ["schema", "sourceRevision", "artifacts"]);
  if (pins.schema !== "agtmai-artifact-pins-v1" || typeof pins.sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(pins.sourceRevision)
    || !Array.isArray(pins.artifacts) || pins.artifacts.length !== 2) { return refuse(); }
  const artifacts: DeploymentArtifact[] = [];
  const files: Record<string, Uint8Array> = {};
  for (const input of pins.artifacts) {
    const loaded = await readPinnedArtifact(input, path);
    artifacts.push(loaded.artifact); Object.assign(files, loaded.files);
  }
  if (new Set(artifacts.map(a => a.contract)).size !== 2) { return refuse(); }
  return { sourceRevision: pins.sourceRevision, artifacts, files };
}

/** Read and re-open the closed production artifact set, including the two reserve contracts. */
export async function readProductionArtifactPins(path: string): Promise<{ readonly sourceRevision: string; readonly artifacts: readonly ProductionArtifactPin[]; readonly files: Readonly<Record<string, Uint8Array>> }> {
  const parsed = parseStrict(new TextDecoder().decode(await readDeploymentFile(path, 1_048_576)));
  if (parsed.diagnostics.length) { return refuse(); }
  const pins = record(parsed.value);
  exact(pins, ["schema", "sourceRevision", "artifacts"]);
  if (pins.schema !== "agtmai-production-artifact-pins-v1" || typeof pins.sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(pins.sourceRevision) || !Array.isArray(pins.artifacts) || pins.artifacts.length !== 3) { return refuse(); }
  const artifacts: ProductionArtifactPin[] = [];
  const files: Record<string, Uint8Array> = {};
  for (const input of pins.artifacts) {
    const loaded = await readProductionPinnedArtifact(input, path);
    artifacts.push(loaded.artifact); Object.assign(files, loaded.files);
  }
  if (new Set(artifacts.map(a => a.contract)).size !== 3) { return refuse(); }
  return { sourceRevision: pins.sourceRevision, artifacts, files };
}

async function readProductionPinnedArtifact(input: unknown, path: string): Promise<{ readonly artifact: ProductionArtifactPin; readonly files: Record<string, Uint8Array> }> {
  const pin = record(input);
  exact(pin, ["contract", "artifactPath", "artifactSha256", "buildInfoPath", "buildInfoSha256"]);
  const contracts = ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController"];
  if (typeof pin.contract !== "string" || !contracts.includes(pin.contract) || typeof pin.artifactPath !== "string" || typeof pin.buildInfoPath !== "string" || !isDigest(pin.artifactSha256) || !isDigest(pin.buildInfoSha256)) { return refuse(); }
  const artifactPath = pinnedPath(path, pin.artifactPath, [`${pin.contract}.json`, `${pin.contract.toLowerCase()}.artifact.json`]);
  const buildInfoPath = pinnedPath(path, pin.buildInfoPath, [`${pin.contract.toLowerCase()}.build-info.json`], true);
  const artifactBytes = await readDeploymentFile(artifactPath), buildBytes = await readDeploymentFile(buildInfoPath);
  if (sha256(artifactBytes) !== pin.artifactSha256 || sha256(buildBytes) !== pin.buildInfoSha256) { return refuse(); }
  const artifact = json(artifactBytes), build = json(buildBytes);
  if (build.solcVersion !== "0.8.36" || record(artifact.metadata).compiler === undefined || record(record(artifact.metadata).compiler).version !== "0.8.36+commit.8a079791") { return refuse(); }
  const { compilerInput, bytecode, runtime } = decodeCompilerOutput(artifact, build, pin.contract);
  return { artifact: { contract: pin.contract as ProductionArtifactPin["contract"], creationBytecode: bytecode.object as `0x${string}`, runtimeBytecode: runtime.object as `0x${string}`, artifactSha256: pin.artifactSha256, buildInfoSha256: pin.buildInfoSha256, compilerInputSha256: sha256(deploymentBytes(compilerInput)), immutableReferences: immutableReferences(runtime) }, files: {
    [`${pin.contract.toLowerCase()}.artifact.json`]: artifactBytes,
    [`${pin.contract.toLowerCase()}.build-info.json`]: buildBytes,
  } };
}

async function readPinnedArtifact(input: unknown, path: string): Promise<{ artifact: DeploymentArtifact; files: Record<string, Uint8Array> }> {
    const pin = record(input);
    exact(pin, ["contract", "artifactPath", "artifactSha256", "buildInfoPath", "buildInfoSha256"]);
    if ((pin.contract !== "AGTMAICCIPToken" && pin.contract !== "GrantVault") || typeof pin.artifactPath !== "string" || typeof pin.buildInfoPath !== "string"
      || !isDigest(pin.artifactSha256) || !isDigest(pin.buildInfoSha256)) { return refuse(); }
    const artifactPath = pinnedPath(path, pin.artifactPath, [ `${pin.contract}.json`, `${pin.contract.toLowerCase()}.artifact.json` ]);
    const buildInfoPath = pinnedPath(path, pin.buildInfoPath, [ `${pin.contract.toLowerCase()}.build-info.json` ], true);
    const artifactBytes = await readDeploymentFile(artifactPath);
    const buildBytes = await readDeploymentFile(buildInfoPath);
    if (sha256(artifactBytes) !== pin.artifactSha256 || sha256(buildBytes) !== pin.buildInfoSha256) { return refuse(); }
    const artifact = json(artifactBytes), build = json(buildBytes);
    if (build.solcVersion !== "0.8.36" || record(artifact.metadata).compiler === undefined || record(record(artifact.metadata).compiler).version !== "0.8.36+commit.8a079791") { return refuse(); }
    const { compilerInput, bytecode, runtime, references } = decodeCompilerOutput(artifact, build, pin.contract);
    const artifactRecord: DeploymentArtifact = { contract: pin.contract, compilerVersion: "0.8.36", artifactSha256: pin.artifactSha256, buildInfoSha256: pin.buildInfoSha256,
      compilerInputSha256: sha256(deploymentBytes(compilerInput)), creationBytecode: bytecode.object as `0x${string}`, runtimeBytecode: runtime.object as `0x${string}`, immutableReferences: references };
    return { artifact: artifactRecord, files: {
      [`${pin.contract.toLowerCase()}.artifact.json`]: artifactBytes,
      [`${pin.contract.toLowerCase()}.build-info.json`]: buildBytes,
    } };
}

function pinnedPath(pinsPath: string, relativePath: string, leaves: readonly string[], buildInfo = false): string {
  // Validate before resolve can erase traversal. readDeploymentFile rejects linked/non-regular leaves and parents.
  if (!relativePath.split("/").every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(part) && !part.includes(".."))
    || !(leaves.includes(basename(relativePath)) || (buildInfo && /^[0-9a-f]{16}\.json$/.test(basename(relativePath))))) {
    throw new Error("DEPLOYMENT_ARTIFACT_PATH");
  }
  return resolve(dirname(pinsPath), relativePath);
}

function decodeCompilerOutput(artifact: Record<string, unknown>, build: Record<string, unknown>, contract: string) {
    const compilerInput = record(build.input), settings = record(compilerInput.settings), optimizer = record(settings.optimizer);
    if (compilerInput.language !== "Solidity" || settings.evmVersion !== "paris" || optimizer.enabled !== true || optimizer.runs !== 200) { return refuse(); }
    const target = record(record(artifact.metadata).settings).compilationTarget;
    const targets = Object.entries(record(target));
    if (targets.length !== 1 || targets[0]![1] !== contract) { return refuse(); }
    const sourceName = targets[0]![0];
    const output = record(record(record(record(build.output).contracts)[sourceName])[contract]);
    const bytecode = record(artifact.bytecode), runtime = record(artifact.deployedBytecode);
    const builtEvm = record(output.evm), builtBytecode = record(builtEvm.bytecode), builtRuntime = record(builtEvm.deployedBytecode);
    if (bytecode.object !== `0x${builtBytecode.object}` || runtime.object !== `0x${builtRuntime.object}` || output.metadata !== artifact.rawMetadata
      || sha256(deploymentBytes(runtime.immutableReferences)) !== sha256(deploymentBytes(builtRuntime.immutableReferences))) { return refuse(); }
    // Unlinked libraries are forbidden. No addresses are patched into arbitrary initcode.
    if (Object.keys(record(bytecode.linkReferences)).length || Object.keys(record(runtime.linkReferences)).length) { return refuse(); }
    if (typeof bytecode.object !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(bytecode.object) || typeof runtime.object !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(runtime.object)) { return refuse(); }
    return { compilerInput, bytecode, runtime, references: immutableReferences(runtime) };
}
function immutableReferences(runtime: Record<string, unknown>): readonly { readonly start: number; readonly length: 32 }[] {
    const references = Object.values(record(runtime.immutableReferences)).flatMap(value => {
      if (!Array.isArray(value)) { return refuse(); }
      return value.map(item => {
        const r = record(item); exact(r, ["start", "length"]);
        if (!Number.isSafeInteger(r.start) || (r.start as number) < 0 || r.length !== 32 || ((r.start as number) + 32) * 2 > (runtime.object as string).length - 2) { return refuse(); }
        return { start: r.start as number, length: 32 as const };
      });
    }).toSorted((a, b) => a.start - b.start);
    if (!references.length || references.some((r, i) => i > 0 && r.start < references[i - 1]!.start + 32)) { return refuse(); }
    return references;
}

/** Reopen the actual pinned inputs; a claimed artifact hash alone cannot authenticate immutable slots. */
export async function verifyPreparedArtifacts(prepared: PreparedDeployment, directory: string): Promise<Readonly<Record<string, Uint8Array>>> {
  const files: Record<string, Uint8Array> = {};
  for (const expected of prepared.artifacts) {
    const loaded = await readPinnedArtifact({ contract: expected.contract, artifactPath: `${expected.contract.toLowerCase()}.artifact.json`,
      artifactSha256: expected.artifactSha256, buildInfoPath: `${expected.contract.toLowerCase()}.build-info.json`, buildInfoSha256: expected.buildInfoSha256 }, join(directory, "artifact-pins.json"));
    if (sha256(deploymentBytes(loaded.artifact)) !== sha256(deploymentBytes(expected))) { return refuse(); }
    Object.assign(files, loaded.files);
  }
  return files;
}
