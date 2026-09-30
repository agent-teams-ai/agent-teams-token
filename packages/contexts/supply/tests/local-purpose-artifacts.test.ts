import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { readLocalPurposeArtifactPins } from "../src/features/genesis-manifest/adapters/deployment-artifacts.js";
import { compileLocalPurposeBuild } from "../src/features/genesis-manifest/adapters/local-purpose-build.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { buildFixture } from "./local-purpose-build-fixture.js";

const layouts = {
  AGTMAICCIPToken: ["GENESIS_ALLOCATION_HASH", "INITIAL_CCIP_ADMIN", "INITIAL_SUPPLY"],
  FounderGrantReserve: ["TOKEN", "VAULT"],
  ReserveController: ["CONTROLLER", "PER_GRANT_CAP", "PURPOSE", "ROLLING_CAP", "TOKEN"],
  PurposeReserveVault: ["CONTROLLER", "OPENS_AT", "PURPOSE", "ROLLING_CAP", "TOKEN", "WINDOW_SECONDS"],
  GrantVault: ["BENEFICIARY", "CONTROLLER", "ORIGINAL_RESERVE", "TOKEN"],
};
const sourceName = (contract: string) => `src/features/${contract === "AGTMAICCIPToken" ? "token-genesis" : contract === "PurposeReserveVault" ? "purpose-reserves" : "contributor-grants"}/${contract}.sol`;

type Pins = { schema: string; sourceRevision: string; artifacts: {
  contract: string; artifactPath: string; artifactSha256: string; buildInfoPath: string; buildInfoSha256: string;
}[] };
async function publish(root: string, revision: string, input: unknown, output: Record<string, any>): Promise<{ path: string; pins: Pins }> {
  const pins: Pins = { schema: "agtmai-local-purpose-artifact-pins-v1", sourceRevision: revision, artifacts: [] };
  for (const contract of Object.keys(layouts)) {
    const target = output.contracts[sourceName(contract)][contract];
    const artifact = Buffer.from(JSON.stringify({ metadata: JSON.parse(target.metadata), rawMetadata: target.metadata,
      bytecode: { ...target.evm.bytecode, object: `0x${target.evm.bytecode.object}` },
      deployedBytecode: { ...target.evm.deployedBytecode, object: `0x${target.evm.deployedBytecode.object}` } }));
    const build = Buffer.from(JSON.stringify({ solcVersion: "0.8.36", input, output }));
    const artifactPath = `${contract.toLowerCase()}.artifact.json`, buildInfoPath = `${contract.toLowerCase()}.build-info.json`;
    await writeFile(join(root, artifactPath), artifact); await writeFile(join(root, buildInfoPath), build);
    pins.artifacts.push({ contract, artifactPath, artifactSha256: sha256(artifact), buildInfoPath, buildInfoSha256: sha256(build) });
  }
  const path = join(root, "pins.json"); await writeFile(path, JSON.stringify(pins));
  return { path, pins };
}
function fictitiousOutput(): Record<string, any> {
  const output: Record<string, any> = { contracts: {}, sources: {} };
  let firstId = 1;
  for (const [contract, names] of Object.entries(layouts)) {
    const path = sourceName(contract);
    const refs = Object.fromEntries(names.map((_, index) => [String(firstId + index), [{ start: 1 + 32 * index, length: 32 }]]));
    const metadata = JSON.stringify({ compiler: { version: "0.8.36+commit.8a079791" }, settings: { compilationTarget: { [path]: contract } } });
    output.contracts[path] = { [contract]: { metadata, evm: { bytecode: { object: "60006000f3", linkReferences: {} },
      deployedBytecode: { object: `60${"00".repeat(32 * names.length)}`, immutableReferences: refs, linkReferences: {} } } } };
    output.sources[path] = { ast: { nodes: names.map((name, index) => ({ nodeType: "VariableDeclaration", mutability: "immutable", id: firstId + index, name })) } };
    firstId += names.length;
  }
  return output;
}

test("reader rejects a coherent forged Git source map even with agreeing candidate and pin revision labels", async context => {
  const { candidate, input, inputs, sources } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  const forged = { ...sources };
  for (const contract of Object.keys(layouts)) {
    const path = sourceName(contract); forged[path] = `contract ${contract} {}`;
    input.sources[path].content = forged[path];
  }
  const { path } = await publish(inputs, candidate.revision, input, fictitiousOutput());
  // Old reader accepted this supplied map as its authority. Extra map has no authority in the new IO API.
  const labelled = { ...candidate, sources: forged };
  await assert.rejects(readLocalPurposeArtifactPins(path, labelled), /DEPLOYMENT_ARTIFACT_PINS_INVALID/);
});

test("reader compares every artifact with an actual authenticated pinned compiler invocation", async context => {
  const installed = resolve("../../../.tools/solc-v0.8.36-linux-x64/solc");
  // This qualification is required, and missing pinned prerequisites must fail visibly.
  const binary = await readFile(installed);
  const { candidate, input, inputs } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  const install = join(candidate.repositoryRoot, ".tools/solc-v0.8.36-linux-x64");
  await mkdir(install, { recursive: true }); await writeFile(join(install, "solc"), binary, { mode: 0o500 });
  const fresh = await compileLocalPurposeBuild(candidate, input);
  const { path } = await publish(inputs, candidate.revision, input, fresh);
  const selected = { ...candidate, sources: Object.fromEntries(Object.entries(input.sources as Record<string, { content: string }>).map(([name, entry]) => [name, entry.content])) };
  const loaded = await readLocalPurposeArtifactPins(path, selected);
  assert.equal(loaded.artifacts.length, 5);
  for (const mutate of [
    (target: Record<string, any>) => { target.evm.bytecode.object = "60006000f3"; },
    (target: Record<string, any>) => { target.evm.deployedBytecode.object = `61${target.evm.deployedBytecode.object.slice(2)}`; },
    (target: Record<string, any>) => {
      const refs = target.evm.deployedBytecode.immutableReferences;
      const [a, b] = Object.keys(refs);
      [refs[a!], refs[b!]] = [refs[b!], refs[a!]];
    },
    (target: Record<string, any>) => { const m = JSON.parse(target.metadata); m.compiler.version = "0.8.36+commit.8a079791"; m.sources = {}; target.metadata = JSON.stringify(m); },
  ]) {
    const forged = structuredClone(fresh) as Record<string, any>;
    mutate(forged.contracts[sourceName("PurposeReserveVault")].PurposeReserveVault);
    // Both records and every file hash are regenerated coherently from the forgery.
    await publish(inputs, candidate.revision, input, forged);
    await assert.rejects(readLocalPurposeArtifactPins(path, selected), /DEPLOYMENT_ARTIFACT_PINS_INVALID/);
  }
});
