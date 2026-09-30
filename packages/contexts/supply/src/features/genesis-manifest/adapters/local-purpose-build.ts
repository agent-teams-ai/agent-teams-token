import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, realpath, rm, constants } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deploymentBytes } from "../application/compile-deployment.js";
import { readDeploymentFile } from "./deployment-store.js";
import { sha256 } from "./digest.js";

export interface LocalPurposeCandidate {
  readonly repositoryRoot: string;
  readonly revision: string;
}
const refuse = (): never => { throw new Error("DEPLOYMENT_ARTIFACT_PINS_INVALID"); };
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : refuse();
const same = (a: unknown, b: unknown): boolean => sha256(deploymentBytes(a)) === sha256(deploymentBytes(b));
const environment = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C", TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0" };
const sourcePrefix = "contracts/evm/";
const canonicalPaths = ["contracts/evm/src", "contracts/evm/lib", "contracts/evm/foundry.toml",
  "contracts/evm/remappings.txt", "tooling/security/vendor-dependencies.json", "tooling/toolchain.lock.json"];

function git(root: string, args: readonly string[]): Buffer {
  const result = spawnSync("/usr/bin/git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "core.attributesFile=/dev/null", "-C", root, ...args], { env: environment, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) { return refuse(); }
  return result.stdout;
}

function authenticatedGitObject(root: string, type: "commit" | "tree", identity: string): Buffer {
  const bytes = git(root, ["cat-file", type, identity]);
  if (createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex") !== identity) { return refuse(); }
  return bytes;
}

/** Follow only child IDs decoded from authenticated parent bytes, never ls-tree traversal. */
function authenticatedGitBlobs(root: string, revision: string): readonly { path: string; identity: string }[] {
  const commit = authenticatedGitObject(root, "commit", revision);
  const tree = /^tree ([0-9a-f]{40})\n/.exec(commit.toString("utf8"));
  if (!tree) { return refuse(); }
  const blobs: { path: string; identity: string }[] = [];
  const walk = (identity: string, prefix: string): void => {
    const bytes = authenticatedGitObject(root, "tree", identity);
    for (let offset = 0; offset < bytes.length;) {
      // Git tree records are: octal mode, space, name, NUL, twenty raw SHA1 bytes.
      const space = bytes.indexOf(0x20, offset), nul = bytes.indexOf(0, offset);
      if (space <= offset || nul <= space + 1 || nul + 21 > bytes.length) { return refuse(); }
      const mode = bytes.subarray(offset, space).toString("utf8");
      const name = bytes.subarray(space + 1, nul).toString("utf8");
      const child = bytes.subarray(nul + 1, nul + 21).toString("hex");
      offset = nul + 21;
      const path = `${prefix}${name}`;
      if (!canonicalPaths.some(p => path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`))) { continue; }
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") { return refuse(); }
      if (mode === "40000") { walk(child, `${path}/`); }
      else if (mode === "100644" || mode === "100755") { blobs.push({ path, identity: child }); }
      else { return refuse(); }
    }
  };
  walk(tree[1]!, "");
  return blobs;
}

/** IO authority: Git objects, not an authored source map. Recheck even files hidden by index flags. */
export async function readLocalPurposeGitSources(candidate: LocalPurposeCandidate): Promise<Readonly<Record<string, string>>> {
  if (!candidate || typeof candidate.repositoryRoot !== "string" || !/^[0-9a-f]{40}$/.test(candidate.revision)) { return refuse(); }
  const root = resolve(candidate.repositoryRoot);
  if (await realpath(root) !== root || git(root, ["rev-parse", "--show-toplevel"]).toString().trim() !== root
    || git(root, ["rev-parse", "HEAD"]).toString().trim() !== candidate.revision
    || git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]).length) { return refuse(); }
  const entries = authenticatedGitBlobs(root, candidate.revision);
  const files = new Map<string, Uint8Array>();
  const sources: Record<string, string> = {};
  for (const { path, identity: expected } of entries) {
    if (files.has(path)) { return refuse(); }
    const bytes = await readDeploymentFile(join(root, path));
    // Recompute Git's blob identity. cat-file can return substituted loose blob bytes
    // without checking their hash, so comparing two reads is not source authority.
    const identity = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (identity !== expected) { return refuse(); }
    files.set(path, bytes);
    if (path.endsWith(".sol") && (path.startsWith(`${sourcePrefix}src/`) || path.startsWith(`${sourcePrefix}lib/`))) {
      sources[path.slice(sourcePrefix.length)] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  }
  for (const path of canonicalPaths.slice(2)) { if (!files.has(path)) { return refuse(); } }
  assertLocalPurposeVendorPins(files);
  if (!Object.keys(sources).length) { return refuse(); }
  return sources;
}

/** Require the complete vendored inventory to match the selected dependency pins. */
function assertLocalPurposeVendorPins(files: ReadonlyMap<string, Uint8Array>): void {
  const vendor = object(JSON.parse(new TextDecoder().decode(files.get("tooling/security/vendor-dependencies.json")!)));
  if (vendor.schemaVersion !== 1 || !Array.isArray(vendor.dependencies) || vendor.dependencies.length !== 1) { return refuse(); }
  const dependency = object(vendor.dependencies[0]);
  if (dependency.name !== "@openzeppelin/contracts" || dependency.version !== "5.7.0"
    || dependency.sourceCommit !== "cab19933c33c2ad1d4c7a84864a3601dddfd16f3"
    || dependency.root !== "contracts/evm/lib/openzeppelin-contracts") { return refuse(); }
  const pinnedFiles = object(dependency.files);
  if (!Object.keys(pinnedFiles).length) { return refuse(); }
  for (const [name, digest] of Object.entries(pinnedFiles)) {
    const bytes = files.get(`${dependency.root}/${name}`);
    if (!bytes || typeof digest !== "string" || sha256(bytes) !== `0x${digest}`) { return refuse(); }
  }
  const vendored = [...files.keys()].filter(p => p.startsWith(`${sourcePrefix}lib/`));
  if (vendored.length !== Object.keys(pinnedFiles).length) { return refuse(); }
}

/** Validate the exact standard-JSON input before invoking solc without filesystem imports. */
export function verifiedLocalPurposeCompilerInput(input: unknown, sources: Readonly<Record<string, string>>): Record<string, unknown> {
  const value = object(input), supplied = object(value.sources), settings = object(value.settings);
  if (value.language !== "Solidity" || !Object.keys(supplied).length
    || Object.keys(value).some(k => !["language", "sources", "settings", "version", "allowPaths", "basePath", "includePaths"].includes(k))) { return refuse(); }
  for (const [name, source] of Object.entries(supplied)) {
    const entry = object(source);
    if (!Object.hasOwn(sources, name) || entry.content !== sources[name] || Object.keys(entry).join() !== "content") { return refuse(); }
  }
  assertLocalPurposeCompilerSettings(settings);
  // Foundry's non-standard wrapper fields and experimental=false are not solc standard-JSON fields.
  const solcSettings = { ...settings };
  delete solcSettings.experimental;
  return { language: "Solidity", sources: supplied, settings: solcSettings };
}

/** Admit only the pinned code-generation, metadata and import settings. */
function assertLocalPurposeCompilerSettings(settings: Record<string, unknown>): void {
  const optimizer = object(settings.optimizer), metadata = object(settings.metadata);
  if (settings.evmVersion !== "paris" || optimizer.enabled !== true || optimizer.runs !== 200
    || Object.keys(optimizer).some(k => !["enabled", "runs"].includes(k))
    || (settings.viaIR !== undefined && settings.viaIR !== false)
    || ("viaSSACFG" in settings && settings.viaSSACFG !== false)
    || (settings.experimental !== undefined && settings.experimental !== false)
    || metadata.bytecodeHash !== "ipfs" || metadata.appendCBOR !== true
    || (metadata.useLiteralContent !== undefined && metadata.useLiteralContent !== false)
    || Object.keys(metadata).some(k => !["bytecodeHash", "appendCBOR", "useLiteralContent"].includes(k))
    || Object.keys(object(settings.libraries)).length
    || !same(settings.remappings, ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
      "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"])
    || Object.keys(settings).some(k => !["optimizer", "evmVersion", "viaIR", "viaSSACFG", "experimental", "metadata", "libraries", "remappings", "outputSelection"].includes(k))) { return refuse(); }
  object(settings.outputSelection);
}

/** Foundry reorders ABI entries; nested parameter/component order remains significant. */
function abiMultiset(value: unknown): readonly string[] | null {
  if (value === undefined) { return null; }
  if (!Array.isArray(value)) { return refuse(); }
  return value.map(entry => sha256(deploymentBytes(object(entry)))).toSorted();
}

function contractSemantics(value: unknown): Record<string, unknown> {
  const contract = object(value), evm = object(contract.evm);
  const bytecode = object(evm.bytecode), runtime = object(evm.deployedBytecode);
  if (typeof contract.metadata !== "string" || typeof bytecode.object !== "string" || typeof runtime.object !== "string") { return refuse(); }
  // Compare every contract, including unselected libraries/interfaces. Documentation,
  // storageLayout, methodIdentifiers and disassembly are not decoder inputs.
  return { metadata: contract.metadata, abi: abiMultiset(contract.abi), bytecode: bytecode.object, runtime: runtime.object,
    linkReferences: object(bytecode.linkReferences === undefined ? {} : bytecode.linkReferences),
    runtimeLinkReferences: object(runtime.linkReferences === undefined ? {} : runtime.linkReferences),
    immutableReferences: object(runtime.immutableReferences === undefined ? {} : runtime.immutableReferences) };
}

/** Only absent versus empty AST nodes is presentation; all other fields/order are identity. */
function withoutEmptyNodes(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(withoutEmptyNodes); }
  if (value === null || typeof value !== "object") { return value; }
  return Object.fromEntries(Object.entries(value).filter(([key, child]) =>
    !(key === "nodes" && Array.isArray(child) && child.length === 0)).map(([key, child]) => [key, withoutEmptyNodes(child)]));
}

/** Fresh solc is authority for code, metadata, ABI and the complete immutable-name source inventory. */
export function assertLocalPurposeCompilerOutput(supplied: unknown, fresh: unknown): void {
  const claimed = object(supplied), compiled = object(fresh);
  const contracts = (value: unknown) => Object.fromEntries(Object.entries(object(value)).map(([source, entries]) =>
    [source, Object.fromEntries(Object.entries(object(entries)).map(([name, contract]) => [name, contractSemantics(contract)]))]));
  if (!same(contracts(claimed.contracts), contracts(compiled.contracts))
    // Keep the entire source records bound: immutableNames traverses all their fields.
    || !same(withoutEmptyNodes(object(claimed.sources)), withoutEmptyNodes(object(compiled.sources)))) { refuse(); }
}

/** Fresh pinned compiler, private snapshot, bounded process, and no callback/import path to ambient files. */
export async function compileLocalPurposeBuild(candidate: LocalPurposeCandidate, input: unknown): Promise<Record<string, unknown>> {
  if (process.platform !== "linux" || process.arch !== "x64") { return refuse(); }
  const sources = await readLocalPurposeGitSources(candidate);
  const verified = verifiedLocalPurposeCompilerInput(input, sources);
  const root = resolve(candidate.repositoryRoot);
  const lock = object(JSON.parse(new TextDecoder().decode(await readDeploymentFile(join(root, "tooling/toolchain.lock.json")))));
  const solc = object(object(lock.tools).solc), pin = object(object(solc.platforms)["linux-x64"]);
  if (solc.version !== "0.8.36" || solc.build !== "8a079791" || pin.archive !== "executable"
    || pin.installDirectory !== "solc-v0.8.36-linux-x64"
    || pin.sha256 !== "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6") { return refuse(); }
  const binary = await readDeploymentFile(join(root, ".tools", pin.installDirectory as string, "solc"), 64 * 1024 * 1024);
  if (sha256(binary) !== `0x${pin.sha256}`) { return refuse(); }
  const parent = join(root, ".local");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (await realpath(parent) !== parent) { return refuse(); }
  const custody = await mkdtemp(join(parent, "local-purpose-solc-"));
  try {
    await chmod(custody, 0o700);
    const path = join(custody, "solc");
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
    try { await file.writeFile(binary); } finally { await file.close(); }
    const executable = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Execute the held authenticated snapshot, not a subsequently resolved installation path.
      const run = (args: readonly string[], stdin?: Uint8Array): string => {
        const result = spawnSync("/proc/self/fd/3", args, { cwd: custody, env: environment,
          stdio: ["pipe", "pipe", "pipe", executable.fd], input: stdin, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
        if (result.error || result.status !== 0) { return refuse(); }
        return result.stdout.toString();
      };
      if (!/^Version: 0\.8\.36\+commit\.8a079791\.Linux\.g\+\+$/m.test(run(["--version"]))) { return refuse(); }
      const output = object(JSON.parse(run(["--standard-json"], deploymentBytes(verified))));
      if (Array.isArray(output.errors) && output.errors.some(e => object(e).severity === "error")) { return refuse(); }
      if (sha256(await readDeploymentFile(path, 64 * 1024 * 1024)) !== `0x${pin.sha256}`) { return refuse(); }
      await readLocalPurposeGitSources(candidate);
      return output;
    } finally { await executable.close(); }
  } finally { await rm(custody, { recursive: true, force: true }); }
}
