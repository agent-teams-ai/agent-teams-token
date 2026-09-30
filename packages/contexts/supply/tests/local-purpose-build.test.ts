import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readLocalPurposeGitSources, verifiedLocalPurposeCompilerInput, assertLocalPurposeCompilerOutput, compileLocalPurposeBuild } from "../src/features/genesis-manifest/adapters/local-purpose-build.js";
import { buildFixture } from "./local-purpose-build-fixture.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";

const invalid = /DEPLOYMENT_ARTIFACT_PINS_INVALID/;
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
  execFileSync("/usr/bin/git", ["-C", candidate.repositoryRoot, "update-index", "--assume-unchanged", `contracts/evm/${path}`]);
  assert.equal(execFileSync("/usr/bin/git", ["-C", candidate.repositoryRoot, "status", "--porcelain"], { encoding: "utf8" }), "");
  await assert.rejects(readLocalPurposeGitSources(candidate), invalid);
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

test("compiler admission fails closed on missing or counterfeit pinned executable", async context => {
  const { candidate, input } = await buildFixture();
  context.after(() => rm(candidate.repositoryRoot, { recursive: true, force: true }));
  await assert.rejects(compileLocalPurposeBuild(candidate, input));
  const install = join(candidate.repositoryRoot, ".tools/solc-v0.8.36-linux-x64");
  await mkdir(install, { recursive: true });
  await writeFile(join(install, "solc"), "#!/bin/sh\necho counterfeit\n", { mode: 0o500 });
  await assert.rejects(compileLocalPurposeBuild(candidate, input), invalid);
});
