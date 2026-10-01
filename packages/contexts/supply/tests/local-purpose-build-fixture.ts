import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readLocalPurposeGitSources, type LocalPurposeCandidate } from "../src/features/genesis-manifest/adapters/local-purpose-build.js";

export const settings = { evmVersion: "paris", optimizer: { enabled: true, runs: 200 },
  metadata: { bytecodeHash: "ipfs", appendCBOR: true, useLiteralContent: false }, viaIR: false, libraries: {},
  remappings: ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"],
  outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata", "storageLayout"], "": ["ast"] } } };

/** Model the reported pinned Forge presentation differences; never claim this is a Forge invocation. */
export function forgePresentation(output: Record<string, any>): Record<string, any> {
  const presented = structuredClone(output);
  for (const contracts of Object.values(presented.contracts) as Record<string, any>[]) {
    for (const contract of Object.values(contracts)) {
      if (Array.isArray(contract.abi)) { contract.abi.reverse(); }
      contract.devdoc = { kind: "dev", methods: {}, version: 1 };
      contract.userdoc = { kind: "user", methods: {}, version: 1 };
      if (contract.storageLayout?.storage.length === 0) { delete contract.storageLayout; }
      if (contract.evm.methodIdentifiers && !Object.keys(contract.evm.methodIdentifiers).length) { delete contract.evm.methodIdentifiers; }
      if (contract.evm.deployedBytecode.immutableReferences && !Object.keys(contract.evm.deployedBytecode.immutableReferences).length) {
        delete contract.evm.deployedBytecode.immutableReferences;
      }
    }
  }
  addEmptyNodes(presented.sources);
  return presented;
}

function addEmptyNodes(value: any): void {
  if (Array.isArray(value)) { value.forEach(addEmptyNodes); }
  else if (value !== null && typeof value === "object") {
    if (typeof value.nodeType === "string" && !Object.hasOwn(value, "nodes")) { value.nodes = []; }
    Object.values(value).forEach(addEmptyNodes);
  }
}

/** Disposable Git fixture, with real tracked Solidity and lock/pin bytes. No source-repository writes. */
export async function buildFixture(): Promise<{ candidate: LocalPurposeCandidate; sources: Readonly<Record<string, string>>; input: Record<string, any>; inputs: string }> {
  const repository = resolve("../../..");
  const parent = join(repository, ".local/local-purpose-build-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "case-"));
  const git = (args: readonly string[]) => execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  const files = execFileSync("/usr/bin/git", ["-C", repository, "ls-tree", "-r", "--name-only", "HEAD", "--",
    "contracts/evm/src", "contracts/evm/lib", "contracts/evm/foundry.toml", "contracts/evm/remappings.txt",
    "tooling/toolchain.lock.json", "tooling/security/vendor-dependencies.json"], { encoding: "utf8" }).trim().split("\n");
  for (const name of files) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), await readFile(join(repository, name)));
  }
  await writeFile(join(root, ".gitignore"), ".local/\n.tools/\n");
  git(["init", "--quiet"]); git(["add", "."]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "test: local compiler authority fixture"]);
  const candidate = { repositoryRoot: root, revision: git(["rev-parse", "HEAD"]).trim() };
  const sources = await readLocalPurposeGitSources(candidate);
  const inputs = join(root, ".local/inputs");
  await mkdir(inputs, { recursive: true });
  return { candidate, sources, inputs, input: { language: "Solidity", settings: structuredClone(settings),
    sources: Object.fromEntries(Object.entries(sources).map(([name, content]) => [name, { content }])) } };
}
