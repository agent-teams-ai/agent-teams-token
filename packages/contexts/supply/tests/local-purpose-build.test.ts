import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readLocalPurposeGitSources, verifiedLocalPurposeCompilerInput, assertLocalPurposeCompilerOutput, compileLocalPurposeBuild } from "../src/features/genesis-manifest/adapters/local-purpose-build.js";
import { buildFixture, forgePresentation } from "./local-purpose-build-fixture.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { readProductionArtifactPins } from "../src/features/genesis-manifest/adapters/deployment-artifacts.js";
import type { LocalPurposeCandidate } from "../src/features/genesis-manifest/adapters/local-purpose-build.js";
import { deploymentBytes } from "../src/features/genesis-manifest/application/compile-deployment.js";

const invalid = /DEPLOYMENT_ARTIFACT_PINS_INVALID/;
async function rejectProductionSource(candidate: LocalPurposeCandidate): Promise<void> {
  const dir = join(candidate.repositoryRoot, ".local/source-admission");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "pins.json");
  await writeFile(path, JSON.stringify({ schema: "agtmai-production-artifact-pins-v2", sourceRevision: candidate.revision,
    artifacts: ["AGTMAICCIPToken", "FounderGrantReserve", "ReserveController", "PurposeReserveVault", "GrantVault"].map(contract => ({ contract })) }));
  // Invalid Git must be rejected before accessing these intentionally absent artifact files.
  await assert.rejects(readProductionArtifactPins(path, candidate), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, "DEPLOYMENT_ARTIFACT_PINS_INVALID");
    assert.match(error.stack!, /at (?:readLocalPurposeGitSources|authenticatedGitObject|assertLocalPurposeVendorPins)\b/);
    return true;
  });
}
for (const treePath of ["contracts", "contracts/evm", "contracts/evm/src", "contracts/evm/src/features/purpose-reserves"]) {
  test(`Git authority rejects substituted ${treePath} tree bytes before compilation`, async context => {
    const { candidate, input } = await buildFixture();
    context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
    const git = (args: string[]) => execFileSync("/usr/bin/git", ["-C", candidate.repositoryRoot, ...args]);
    const relative = "contracts/evm/src/features/purpose-reserves/PurposeReserveVault.sol";
    const commit = git(["cat-file", "commit", candidate.revision]);
    const treeAt = (revision: string) => git(["rev-parse", `${revision}:${treePath}`]).toString().trim();
    const original = treeAt(candidate.revision);
    const forged = "contract PurposeReserveVault {}\n";
    await writeFile(join(candidate.repositoryRoot, relative), forged);
    git(["add", relative]);
    const replacementRoot = git(["write-tree"]).toString().trim();
    const replacement = treeAt(replacementRoot);
    git(["update-index", "--assume-unchanged", relative]);
    const objectPath = (id: string) => join(candidate.repositoryRoot, ".git/objects", id.slice(0, 2), id.slice(2));
    await chmod(objectPath(original), 0o600);
    await copyFile(objectPath(replacement), objectPath(original));
    assert.deepEqual(git(["cat-file", "commit", candidate.revision]), commit);
    assert.equal(git(["rev-parse", "HEAD"]).toString().trim(), candidate.revision);
    assert.equal(git(["status", "--porcelain"]).toString(), "");
    // The counterfeit tree points to a genuine, hash-matching malicious blob.
    assert.equal(git(["show", `${candidate.revision}:${relative}`]).toString(), forged);
    input.sources[relative.slice("contracts/evm/".length)].content = forged;
    // No compiler is installed: reaching compiler admission would throw ENOENT,
    // so this pins rejection to source authentication, before compilation.
    await assert.rejects(compileLocalPurposeBuild(candidate, input), invalid);
    await assert.rejects(readLocalPurposeGitSources(candidate), invalid);
  await rejectProductionSource(candidate);
  });
}

test("Git authority rejects source bytes stored under a different blob's claimed identity", async context => {
  const { candidate } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  const git = (args: string[], input?: Buffer) => execFileSync("/usr/bin/git", ["-C", candidate.repositoryRoot, ...args], { input });
  const relative = "contracts/evm/src/features/purpose-reserves/PurposeReserveVault.sol";
  const original = git(["rev-parse", `${candidate.revision}:${relative}`]).toString().trim();
  const forged = Buffer.from("contract PurposeReserveVault {}\n");
  const replacement = git(["hash-object", "-w", "--stdin"], forged).toString().trim();
  const objectPath = (id: string) => join(candidate.repositoryRoot, ".git/objects", id.slice(0, 2), id.slice(2));
  await chmod(objectPath(original), 0o600);
  await copyFile(objectPath(replacement), objectPath(original));
  await writeFile(join(candidate.repositoryRoot, relative), forged);
  git(["update-index", "--assume-unchanged", relative]);
  assert.equal(git(["status", "--porcelain"]).toString(), "");
  await assert.rejects(readLocalPurposeGitSources(candidate), invalid);
  await rejectProductionSource(candidate);
});

test("Git authority rejects a forged object store with a clean checkout and the original revision label", async context => {
  const { candidate } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  const git = (args: string[], input?: Buffer) => execFileSync("/usr/bin/git", ["-C", candidate.repositoryRoot, ...args], { input });
  const relative = "contracts/evm/src/features/purpose-reserves/PurposeReserveVault.sol";
  await writeFile(join(candidate.repositoryRoot, relative), "contract PurposeReserveVault {}\n");
  git(["add", relative]);
  const tree = git(["write-tree"]).toString().trim();
  const forged = Buffer.from(git(["cat-file", "commit", candidate.revision]).toString().replace(/^tree [0-9a-f]{40}/, `tree ${tree}`));
  const replacement = git(["hash-object", "-t", "commit", "-w", "--stdin"], forged).toString().trim();
  const objectPath = (id: string) => join(candidate.repositoryRoot, ".git/objects", id.slice(0, 2), id.slice(2));
  await chmod(objectPath(candidate.revision), 0o600);
  await copyFile(objectPath(replacement), objectPath(candidate.revision));
  assert.equal(git(["rev-parse", "HEAD"]).toString().trim(), candidate.revision);
  assert.equal(git(["status", "--porcelain"]).toString(), "");
  await assert.rejects(readLocalPurposeGitSources(candidate), invalid);
  await rejectProductionSource(candidate);
});

test("Git authority rejects matching source labels with forged bytes and dirty/hidden checkout changes", async context => {
  const { candidate, sources, input } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  assert.equal(Object.keys(sources).length, 13);
  assert.doesNotThrow(() => verifiedLocalPurposeCompilerInput(input, sources));
  const path = "src/features/purpose-reserves/PurposeReserveVault.sol";
  const forged = structuredClone(input); forged.sources[path].content = "contract PurposeReserveVault {}";
  assert.throws(() => verifiedLocalPurposeCompilerInput(forged, sources), invalid);
  await assert.rejects(readLocalPurposeGitSources({ ...candidate, revision: "a".repeat(40) }), invalid);
  const file = join(candidate.repositoryRoot, "contracts/evm", path);
  const before = await readFile(file);
  await writeFile(file, `${before}\n`);
  await assert.rejects(readLocalPurposeGitSources(candidate), invalid);
  await rejectProductionSource(candidate);
  execFileSync("/usr/bin/git", ["-C", candidate.repositoryRoot, "update-index", "--assume-unchanged", `contracts/evm/${path}`]);
  assert.equal(execFileSync("/usr/bin/git", ["-C", candidate.repositoryRoot, "status", "--porcelain"], { encoding: "utf8" }), "");
  await assert.rejects(readLocalPurposeGitSources(candidate), invalid);
  await rejectProductionSource(candidate);
});

test("Git authority rejects changed vendored pins even when Git itself is clean", async context => {
  const { candidate } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  const relative = "contracts/evm/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
  await writeFile(join(candidate.repositoryRoot, relative), "// forged dependency\n");
  const git = (args: string[]) => execFileSync("/usr/bin/git", ["-C", candidate.repositoryRoot, ...args], { encoding: "utf8" });
  git(["add", relative]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "test: changed dependency"]);
  await assert.rejects(readLocalPurposeGitSources({ ...candidate, revision: git(["rev-parse", "HEAD"]).trim() }), invalid);
  await rejectProductionSource({ ...candidate, revision: git(["rev-parse", "HEAD"]).trim() });
});

test("exact compiler input admits absent or false viaSSACFG without changing pinned settings or sources", async context => {
  const { candidate, sources, input } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  assert.equal(Object.hasOwn(input.settings, "viaSSACFG"), false);
  assert.deepEqual(verifiedLocalPurposeCompilerInput(input, sources), input);
  // Pinned Foundry 1.8.0 build-info includes this solc 0.8.36 setting.
  input.settings.viaSSACFG = false;
  assert.deepEqual(verifiedLocalPurposeCompilerInput(input, sources), input);
});

test("exact compiler input rejects enabled or malformed viaSSACFG", async context => {
  const { candidate, sources, input } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  for (const value of [true, null, undefined, 0, 1, "", "false", "true", [], {}]) {
    const changed = structuredClone(input);
    changed.settings.viaSSACFG = value;
    assert.throws(() => verifiedLocalPurposeCompilerInput(changed, sources), invalid, `viaSSACFG=${JSON.stringify(value)}`);
  }
});

test("exact compiler input rejects unpinned settings, source URLs and traversal aliases", async context => {
  const { candidate, sources, input } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  for (const mutate of [
    (v: Record<string, any>) => { v.settings.viaIR = true; },
    (v: Record<string, any>) => { v.settings.optimizer.details = { yul: true }; },
    (v: Record<string, any>) => { v.settings.metadata.appendCBOR = false; },
    (v: Record<string, any>) => { v.settings.remappings = []; },
    (v: Record<string, any>) => { v.settings.libraries = { library: {} }; },
    (v: Record<string, any>) => { v.sources["../Forged.sol"] = { content: "contract Forged {}" }; },
    (v: Record<string, any>) => { v.sources[Object.keys(v.sources)[0]!] = { urls: ["file:///ambient.sol"] }; },
  ]) {
    const changed = structuredClone(input); mutate(changed);
    assert.throws(() => verifiedLocalPurposeCompilerInput(changed, sources), invalid);
  }
});

test("independent compiler oracle rejects coherent creation/runtime/metadata/immutable/AST substitution with fresh file hashes", () => {
  // Decoder/comparison unit fixture only: this output does not claim compiler provenance.
  const fresh = { contracts: { "Vault.sol": { PurposeReserveVault: { metadata: "metadata-from-invocation",
    evm: { bytecode: { object: "606060" }, deployedBytecode: { object: "60".repeat(100), immutableReferences: { "1": [{ start: 2, length: 32 }, { start: 40, length: 32 }] } } } } } },
    sources: { "Vault.sol": { ast: { nodes: [{ id: 1, nodeType: "VariableDeclaration", mutability: "immutable", name: "TOKEN" }] } } } };
  assert.doesNotThrow(() => assertLocalPurposeCompilerOutput(structuredClone(fresh), fresh));
  for (const mutate of [
    (v: typeof fresh) => { v.contracts["Vault.sol"].PurposeReserveVault.evm.bytecode.object = "60006000f3"; },
    (v: typeof fresh) => { v.contracts["Vault.sol"].PurposeReserveVault.evm.deployedBytecode.object = "61".repeat(100); },
    (v: typeof fresh) => { v.contracts["Vault.sol"].PurposeReserveVault.metadata = "forged metadata"; },
    (v: typeof fresh) => { v.contracts["Vault.sol"].PurposeReserveVault.evm.deployedBytecode.immutableReferences["1"][1]!.start++; },
    (v: typeof fresh) => { v.contracts["Vault.sol"].PurposeReserveVault.evm.deployedBytecode.immutableReferences["1"].pop(); },
    (v: typeof fresh) => { v.sources["Vault.sol"].ast.nodes[0]!.name = "CONTROLLER"; },
  ]) {
    const forged = structuredClone(fresh); mutate(forged);
    const target = forged.contracts["Vault.sol"].PurposeReserveVault;
    const buildBytes = Buffer.from(JSON.stringify({ output: forged }));
    const artifactBytes = Buffer.from(JSON.stringify({ rawMetadata: target.metadata, bytecode: target.evm.bytecode,
      deployedBytecode: target.evm.deployedBytecode }));
    assert.match(sha256(buildBytes), /^0x[0-9a-f]{64}$/);
    assert.match(sha256(artifactBytes), /^0x[0-9a-f]{64}$/);
    assert.throws(() => assertLocalPurposeCompilerOutput(JSON.parse(buildBytes.toString()).output, fresh), invalid);
  }
});

test("compiler output admits only Forge presentation changes while preserving code, ABI multiplicity and AST identity", () => {
  // Semantic comparison fixture only; the artifact-reader test invokes authenticated solc.
  const fresh: Record<string, any> = {
    contracts: { "Vault.sol": {
      PurposeReserveVault: { metadata: "exact metadata", storageLayout: { storage: [], types: null },
        abi: [
          { type: "function", name: "move", inputs: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
          { type: "function", name: "move", inputs: [{ name: "request", type: "tuple", components: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }] }], outputs: [], stateMutability: "nonpayable" },
        ],
        evm: { bytecode: { object: "60006000f3", linkReferences: {} }, methodIdentifiers: {},
          deployedBytecode: { object: "60".repeat(100), linkReferences: {}, immutableReferences: { "1": [{ start: 2, length: 32 }] } } } },
      Unselected: { metadata: "other metadata", abi: [], storageLayout: { storage: [], types: null },
        evm: { bytecode: { object: "", linkReferences: {} }, methodIdentifiers: {}, deployedBytecode: { object: "", linkReferences: {}, immutableReferences: {} } } },
    } },
    sources: { "Vault.sol": { id: 0, ast: { nodeType: "SourceUnit", nodes: [
      { nodeType: "VariableDeclaration", id: 1, mutability: "immutable", name: "TOKEN", src: "0:10:0", typeDescriptions: { typeString: "address" } },
      { nodeType: "ParameterList", id: 2, parameters: [] },
    ] } } },
  };
  const presented = forgePresentation(fresh);
  // Both exact comparisons in the old admission reject this legitimate presentation.
  assert.notEqual(sha256(deploymentBytes(presented.contracts)), sha256(deploymentBytes(fresh.contracts)));
  assert.notEqual(sha256(deploymentBytes(presented.sources)), sha256(deploymentBytes(fresh.sources)));
  const before = structuredClone(presented);
  assert.doesNotThrow(() => assertLocalPurposeCompilerOutput(presented, fresh));
  assert.deepEqual(presented, before); // Comparison never rewrites the evidence or oracle.
  assert.doesNotThrow(() => assertLocalPurposeCompilerOutput(fresh, presented));
  const mutations: Record<string, (v: Record<string, any>) => void> = {
    creation: v => { v.contracts["Vault.sol"].PurposeReserveVault.evm.bytecode.object = "60016000f3"; },
    runtime: v => { v.contracts["Vault.sol"].PurposeReserveVault.evm.deployedBytecode.object = "61".repeat(100); },
    metadata: v => { v.contracts["Vault.sol"].PurposeReserveVault.metadata = "forged metadata"; },
    immutableOffset: v => { v.contracts["Vault.sol"].PurposeReserveVault.evm.deployedBytecode.immutableReferences["1"][0].start++; },
    immutableLength: v => { v.contracts["Vault.sol"].PurposeReserveVault.evm.deployedBytecode.immutableReferences["1"][0].length = 31; },
    immutableId: v => { v.contracts["Vault.sol"].PurposeReserveVault.evm.deployedBytecode.immutableReferences = { "3": [{ start: 2, length: 32 }] }; },
    missingImmutables: v => { delete v.contracts["Vault.sol"].PurposeReserveVault.evm.deployedBytecode.immutableReferences; },
    nullImmutables: v => { v.contracts["Vault.sol"].PurposeReserveVault.evm.deployedBytecode.immutableReferences = null; },
    immutableName: v => { v.sources["Vault.sol"].ast.nodes[0].name = "CONTROLLER"; },
    astId: v => { v.sources["Vault.sol"].ast.nodes[0].id = 3; },
    astMutability: v => { v.sources["Vault.sol"].ast.nodes[0].mutability = "mutable"; },
    astLocation: v => { v.sources["Vault.sol"].ast.nodes[0].src = "1:10:0"; },
    nonemptyNodes: v => { v.sources["Vault.sol"].ast.nodes[0].nodes.push({ nodeType: "VariableDeclaration", id: 3, mutability: "immutable", name: "CONTROLLER" }); },
    otherEmptyArray: v => { delete v.sources["Vault.sol"].ast.nodes[1].parameters; },
    missingAst: v => { delete v.sources["Vault.sol"].ast; },
    sourceId: v => { v.sources["Vault.sol"].id = 1; },
    extraSource: v => { v.sources["Injected.sol"] = structuredClone(v.sources["Vault.sol"]); },
    missingSource: v => { delete v.sources["Vault.sol"]; },
    // immutableNames traverses all source fields, so an out-of-AST injection must fail too.
    injectedImmutable: v => { v.sources["Vault.sol"].extra = { nodeType: "VariableDeclaration", id: 1, mutability: "immutable", name: "CONTROLLER" }; },
    missingAbi: v => { delete v.contracts["Vault.sol"].PurposeReserveVault.abi; },
    duplicateAbi: v => { v.contracts["Vault.sol"].PurposeReserveVault.abi.push(structuredClone(v.contracts["Vault.sol"].PurposeReserveVault.abi[0])); },
    removedAbi: v => { v.contracts["Vault.sol"].PurposeReserveVault.abi.pop(); },
    abiParameterOrder: v => { v.contracts["Vault.sol"].PurposeReserveVault.abi[1].inputs.reverse(); },
    abiTupleOrder: v => { v.contracts["Vault.sol"].PurposeReserveVault.abi[0].inputs[0].components.reverse(); },
    abiMutability: v => { v.contracts["Vault.sol"].PurposeReserveVault.abi[0].stateMutability = "view"; },
    unselectedCode: v => { v.contracts["Vault.sol"].Unselected.evm.bytecode.object = "60006000f3"; },
    extraContract: v => { v.contracts["Vault.sol"].Injected = structuredClone(v.contracts["Vault.sol"].Unselected); },
    missingContract: v => { delete v.contracts["Vault.sol"].Unselected; },
    linkReferences: v => { v.contracts["Vault.sol"].PurposeReserveVault.evm.bytecode.linkReferences = { "Library.sol": { Library: [{ start: 1, length: 20 }] } }; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const forged = structuredClone(presented); mutate(forged);
    assert.throws(() => assertLocalPurposeCompilerOutput(forged, fresh), invalid, name);
  }
});

test("compiler admission fails closed on missing or counterfeit pinned executable", async context => {
  const { candidate, input } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  await assert.rejects(compileLocalPurposeBuild(candidate, input));
  const install = join(candidate.repositoryRoot, ".tools/solc-v0.8.36-linux-x64");
  await mkdir(install, { recursive: true });
  await writeFile(join(install, "solc"), "#!/bin/sh\necho counterfeit\n", { mode: 0o500 });
  await assert.rejects(compileLocalPurposeBuild(candidate, input), invalid);
});
