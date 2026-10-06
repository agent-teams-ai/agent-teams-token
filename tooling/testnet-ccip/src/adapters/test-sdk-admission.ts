import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, registerHooks } from "node:module";
import { dirname, join, resolve, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import tables from "../../tests/fixtures/test-sdk-execution-v1.json" with { type: "json" };
import { readDevProviderArchive, payloadHash, payloadPath } from "./dev-provider-archive.mjs";
import { RESOLUTION_EDGES, OPTIONAL_BRANCHES } from "./dev-provider-policy.mjs";
import { TEST_SDK_PACKAGES, TEST_SDK_ROOT_HASHES, TEST_SDK_NODE_HASH, TEST_SDK_ENTRIES, TEST_SDK_BUILTINS, TEST_SDK_NATIVE_ABSENCES, TEST_SDK_EXTRA_ABSENCES } from "./test-sdk-policy.ts";
import type * as Evm from "../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/evm/index.js";
import type * as Solana from "../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js";
import type * as Api from "../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/api/index.js";
import type * as Types from "../../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/types.js";
import type * as Abi from "../../../../.local/INPUT/provider/node_modules/ethers/lib.esm/abi/index.js";
import type * as Contract from "../../../../.local/INPUT/provider/node_modules/ethers/lib.esm/contract/index.js";
import type * as Web3 from "../../../../.local/INPUT/provider/node_modules/@solana/web3.js/lib/index.js";
import type * as Spl from "../../../../.local/INPUT/provider/node_modules/@solana/spl-token/lib/types/index.js";
import type Bs58 from "../../../../.local/INPUT/provider/node_modules/bs58/src/cjs/index.js";

/** Internal constructor record, never a worker capability or signing view. */
export interface NativeSolanaProvider {
  readonly web3: Pick<typeof Web3, "PublicKey" | "SystemProgram" | "Transaction" | "TransactionInstruction" |
    "TransactionMessage" | "VersionedTransaction" | "AddressLookupTableAccount" | "Keypair">;
  readonly spl: Pick<typeof Spl, "TOKEN_PROGRAM_ID" | "createInitializeMint2Instruction" |
    "getAssociatedTokenAddressSync" | "unpackMint" | "unpackAccount">;
  readonly bs58: Pick<typeof Bs58, "encode">;
}
// PR71's actual main source replaces the tree-equivalent reviewed candidate.
export const TEST_SDK_ADMISSION_SOURCE = Object.freeze({
  commit: "1bba690f26bc6b966b2329c2860999f1acf90269",
  tree: "842ee64fc7701f780a51f8edfc2e0ed2af0b02d4",
  priorEquivalentSource: "30e008ac053b22ba6278d90c08efece3c5f6ce45",
});

function fail(reason: string): never { throw new Error("TEST SDK admission: " + reason); }
export interface PayloadEntry { type: "file" | "directory"; mode: number; bytes?: Buffer; sha256?: string }
export interface AdmissionOptions { readonly root: string; readonly archives: string }
export interface AdmissionEvidence {
  readonly sourceBaseline: typeof TEST_SDK_ADMISSION_SOURCE;
  readonly qualification: "complete-byte-admission"; readonly owners: number; readonly uniqueArchives: number;
  readonly members: number; readonly memberInventorySha256: string; readonly archives: Readonly<Record<string, string>>; readonly root: string;
  readonly rootHashes: typeof TEST_SDK_ROOT_HASHES;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) { return fail("invalid object"); }
  return value as Record<string, unknown>;
}
function json(bytes: Buffer): Record<string, unknown> { return record(JSON.parse(bytes.toString("utf8")) as unknown); }
function code(error: unknown): unknown { return error && typeof error === "object" && "code" in error ? error.code : undefined; }
function directory(path: string, privateMode = true): void {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== path ||
    (privateMode && (s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o700))) { fail("physical directory/mode/owner: " + path); }
}
function physical(path: string, privateMode = true): void {
  if (resolve(path) !== path) { fail("absolute canonical path required"); }
  for (let p = path; ; p = dirname(p)) { directory(p, privateMode && p === path); if (p === dirname(p)) { break; } }
}
export function readTestSdkBytes(path: string, mode?: number, limit = 32 * 1024 * 1024): Buffer {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.size > limit ||
    (mode !== undefined && (s.mode & 0o7777) !== mode)) { fail("file type/mode/link: " + path); }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = fstatSync(fd);
    if (held.ino !== s.ino || held.dev !== s.dev || held.size !== s.size) { fail("file replaced"); }
    const data = readFileSync(fd), after = fstatSync(fd);
    if (data.length !== s.size || after.size !== s.size || after.mtimeMs !== held.mtimeMs || after.ctimeMs !== held.ctimeMs) { fail("file changed during read"); }
    return data;
  } finally { closeSync(fd); }
}
function absent(path: string): void {
  try { lstatSync(path); } catch (error) { if (code(error) === "ENOENT") { return; } throw error; }
  fail("unexpected installed path: " + path);
}
export function checkTestSdkRuntime(): void {
  if (process.version !== "v24.20.0" || process.platform !== "linux" || process.arch !== "x64" ||
    payloadHash(readFileSync("/proc/self/exe")) !== TEST_SDK_NODE_HASH || realpathSync(process.execPath) !== realpathSync("/proc/self/exe")) {
    fail("requires pinned Linux x64 Node 24.20.0 binary");
  }
  const forbidden = /^(?:NODE_OPTIONS|NODE_PATH|NODE_BINDINGS_.*|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_V8_COVERAGE|NODE_COMPILE_CACHE|ANCHOR_WALLET|SOLANA_KEYPAIR|LD_.*|DYLD_.*|.*_PROXY|.*_proxy|AGTMAI_.*(?:PUBLIC|MAINNET|NETWORK).*)$/;
  if (process.execArgv.some(arg => !["--test", "--test-concurrency=1"].includes(arg)) ||
    Object.entries(process.env).some(([key, value]) => value && forbidden.test(key)) || Object.keys(requireCache()).some(p => p !== fileURLToPath(new URL("../../tests/fixtures/test-sdk-execution-v1.json", import.meta.url)))) {
    fail("unreviewed runtime environment/conditions/preload/cache");
  }
}
const hostRequire = createRequire(import.meta.url);
function requireCache(): Record<string, unknown> { return hostRequire.cache; }
/** Only these three SRI- and SHA-bound archives enter the exact table dispatch. */
type FixedTable = { archive: string; size: number; rows: readonly (readonly (string | number)[])[] };
function readDefaultPayload(archive: Buffer, integrity: string): Map<string, PayloadEntry> {
    const raw: unknown = readDevProviderArchive(archive, integrity), result = new Map<string, PayloadEntry>();
    if (!(raw instanceof Map)) { return fail("invalid default reader result"); }
    for (const [key, value] of raw) {
      const r = record(value);
      if (typeof key !== "string" || typeof r.mode !== "number" || !["file", "directory"].includes(String(r.type))) { fail("invalid payload entry"); }
      if (r.type === "file") {
        if (!Buffer.isBuffer(r.bytes) || typeof r.sha256 !== "string") { fail("invalid payload bytes"); }
        result.set(key, { type: "file", mode: r.mode, bytes: r.bytes, sha256: r.sha256 });
      } else { result.set(key, { type: "directory", mode: r.mode }); }
    }
    return result;
}
function fixedHeader(tar: Buffer, row: readonly (string | number)[], cursor: number) {
    const [offset, name, size, mode, type] = row;
    if (typeof offset !== "number" || typeof name !== "string" || typeof size !== "number" || typeof mode !== "number" || typeof type !== "number" || offset !== cursor) { fail("fixed row contract"); }
    const h = tar.subarray(offset, offset + 512);
    const field = (a: number, b: number): string => {
      const bytes = h.subarray(a, b), end = bytes.indexOf(0), text = end < 0 ? bytes : bytes.subarray(0, end);
      if (text.some(v => v < 32 || v > 126) || (end >= 0 && bytes.subarray(end).some(v => v))) { fail("fixed header text"); }
      return text.toString("ascii");
    };
    const octal = (a: number, b: number): number => { const s = field(a, b).trim(); if (!/^[0-7]+$/.test(s)) { fail("fixed numeric header"); } return parseInt(s, 8); };
    const prefix = field(345, 500);
    if ((prefix ? prefix + "/" : "") + field(0, 100) !== name || h.subarray(257, 265).toString("hex") !== "7573746172003030" ||
      field(157, 257) || octal(100, 108) !== mode || octal(124, 136) !== size || h[156] !== type ||
      [...h].reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0) !== octal(148, 156)) { fail("fixed header mismatch"); }
    return { offset, name, size, mode, type };
}
function addFixedParents(entries: Map<string, PayloadEntry>): void {
  for (const [local, entry] of entries) {
    if (entry.type !== "file") { continue; }
    for (let p = posix.dirname(local); p !== "."; p = posix.dirname(p)) {
      if (entries.has(p) && entries.get(p)?.type !== "directory") { fail("fixed parent collision"); }
      entries.set(p, { type: "directory", mode: 0o700 });
    }
  }
}
function readFixedPayload(table: FixedTable, archive: Buffer): Map<string, PayloadEntry> {
  if (payloadHash(archive) !== table.archive) { fail("fixed archive SHA256 mismatch"); }
  const tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }), entries = new Map<string, PayloadEntry>();
  if (tar.length !== table.size || tar.length % 512) { fail("fixed tar framing"); }
  let cursor = 0;
  for (const row of table.rows) {
    const { offset, name, size, mode, type } = fixedHeader(tar, row, cursor);
    cursor = offset + 512 + Math.ceil(size / 512) * 512;
    if (cursor > tar.length || tar.subarray(offset + 512 + size, cursor).some(v => v)) { fail("fixed padding"); }
    if (name === "package") { if (type !== 53 || size !== 0) { fail("fixed root"); } continue; }
    if (!name.startsWith("package/")) { fail("fixed prefix"); }
    const local = payloadPath(name.slice(8));
    if (entries.has(local)) { fail("fixed duplicate"); }
    if (type === 53 && size === 0) { entries.set(local, { type: "directory", mode: 0o700 }); }
    else if (type === 48) { const bytes = tar.subarray(offset + 512, offset + 512 + size); entries.set(local, { type: "file", mode: mode & 0o700, bytes, sha256: payloadHash(bytes) }); }
    else { fail("fixed type"); }
  }
  if (tar.length - cursor < 1024 || tar.subarray(cursor).some(v => v)) { fail("fixed termination"); }
  addFixedParents(entries);
  return entries;
}
export function readTestSdkPayload(owner: string, archive: Buffer, integrity: string): Map<string, PayloadEntry> {
  if (!Buffer.isBuffer(archive) || archive.length > 32 * 1024 * 1024 || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity) ||
    "sha512-" + createHash("sha512").update(archive).digest("base64") !== integrity) { fail("archive SRI mismatch: " + owner); }
  const fixed: Record<string, FixedTable> = tables.fixedMembers, table = fixed[owner];
  return table ? readFixedPayload(table, archive) : readDefaultPayload(archive, integrity);
}

function inventory(root: string, packages: Record<string, unknown>): string[] {
  const paths = Object.keys(packages).filter(p => p && !record(packages[p]).optional && !record(packages[p]).extraneous);
  if (paths.length !== 202) { fail("placement count"); }
  const parents = new Map<string, Set<string>>();
  const add = (parent: string, child: string): void => { const s = parents.get(parent) ?? new Set<string>(); s.add(child); parents.set(parent, s); };
  for (const p of paths) {
    payloadPath(p); if (!p.startsWith("node_modules/") || record(packages[p]).link) { fail("placement contract"); }
    directory(join(root, p)); add(posix.dirname(p), posix.basename(p));
    if (posix.basename(posix.dirname(p)).startsWith("@")) { add(posix.dirname(posix.dirname(p)), posix.basename(posix.dirname(p))); }
  }
  add("node_modules", ".package-lock.json");
  for (const [parent, expected] of parents) {
    directory(join(root, parent)); const actual = readdirSync(join(root, parent));
    if (actual.length !== expected.size || actual.some(n => !expected.has(n))) { fail("injected/missing placement: " + parent); }
  }
  for (const p of Object.keys(packages).filter(placement => placement && !paths.includes(placement))) { absent(join(root, p)); }
  for (const p of paths) { if (!parents.has(p + "/node_modules")) { absent(join(root, p, "node_modules")); } }
  const generated = json(readTestSdkBytes(join(root, "node_modules/.package-lock.json"), 0o600, 1024 * 1024));
  const generatedPackages = record(generated.packages);
  if (generated.lockfileVersion !== 3 || Object.keys(generatedPackages).length !== paths.length || paths.some(placement =>
    JSON.stringify(generatedPackages[placement]) !== JSON.stringify(packages[placement]))) { fail("generated npm metadata drift"); }
  return paths;
}
function compare(root: string, owner: string, payload: Map<string, PayloadEntry>, placements: string[]): void {
  const expected = new Map<string, PayloadEntry | { type: "package"; mode: number }>(payload);
  const nested = placements.filter(p => p.startsWith(owner + "/node_modules/"));
  for (const p of nested) {
    const local = p.slice(owner.length + 1); expected.set(local, { type: "package", mode: 0o700 });
    for (let parent = posix.dirname(local); parent !== "."; parent = posix.dirname(parent)) {
      if (expected.has(parent) && expected.get(parent)?.type !== "directory") { fail("placement/payload collision"); }
      expected.set(parent, { type: "directory", mode: 0o700 });
    }
  }
  const seen = new Set<string>();
  function walk(path: string, prefix = "", depth = 0): void {
    if (depth > 20) { fail("payload depth"); } directory(path);
    for (const name of readdirSync(path)) {
      const local = payloadPath(prefix ? prefix + "/" + name : name), entry = expected.get(local), target = join(path, name);
      if (!entry) { fail("injected payload: " + owner + "/" + local); }
      seen.add(local);
      if (entry.type === "file") {
        if (payloadHash(readTestSdkBytes(target, entry.mode)) !== entry.sha256) { fail("payload byte drift: " + owner + "/" + local); }
      } else { directory(target); if (entry.type === "directory") { walk(target, local, depth + 1); } }
    }
  }
  walk(join(root, owner));
  for (const name of expected.keys()) { if (!seen.has(name) && !nested.some(p => (owner + "/" + name).startsWith(p + "/"))) { fail("missing payload: " + owner + "/" + name); } }
}
function resolveExact(root: string, owner: string, specifier: string, expected: string): string {
  const target = createRequire(join(root, owner)).resolve(specifier);
  if (target !== join(root, expected)) { fail("shadow resolution: " + specifier); } return target;
}
type RuntimeMember = { bytes: Buffer; format: "module" | "commonjs" | "json" };
function publishedFormat(name: string, payload: Map<string, PayloadEntry>) {
      let format: "module" | "commonjs" | "json" = name.endsWith(".json") ? "json" : name.endsWith(".mjs") ? "module" : "commonjs";
      if (name.endsWith(".js")) {
        for (let scope = posix.dirname(name); ; scope = posix.dirname(scope)) {
          const metadata = payload.get(scope === "." ? "package.json" : scope + "/package.json")?.bytes;
          if (metadata) { format = json(metadata).type === "module" ? "module" : "commonjs"; break; }
          if (scope === ".") { break; }
        }
      }
      return format;
}
function collectRuntimeMembers(root: string, owner: string, payload: Map<string, PayloadEntry>, members: Map<string, RuntimeMember>) {
    for (const [name, entry] of payload) {
      if (!entry.bytes || /(?:^|\/)(?:test|tests|__tests__|examples|bench|benchmark|scripts|bin)(?:\/|$)/.test(name) || /(?:^|\/)(?:cli|build|bin)\.[cm]?js$/.test(name) || !/\.(?:js|cjs|mjs|json)$/.test(name) || owner === "node_modules/jayson/node_modules/ws" ||
        (owner === "node_modules/@chainlink/ccip-sdk" && !tables.sdkMembers.includes(name))) { continue; }
      const format = publishedFormat(name, payload);
      members.set(pathToFileURL(join(root, owner, name)).href, { bytes: Buffer.from(entry.bytes), format });
    }
 }
function checkSdkExports(root: string, owner: string, payload: Map<string, PayloadEntry>) {
    if (owner === "node_modules/@chainlink/ccip-sdk") {
      const metadata = payload.get("package.json")?.bytes;
      if (!metadata || record(json(metadata).exports)["./dist/*"] !== "./dist/*") { fail("SDK public wildcard export changed"); }
      for (const [, [specifier, member, symbol]] of Object.entries(TEST_SDK_ENTRIES)) {
        if (!payload.has(member.replace(/\.js$/, ".d.ts")) || !payload.get(member)?.bytes?.toString().includes("export " + (symbol === "ExecutionState" ? "const " : "class ") + symbol)) { fail("SDK declaration/export member"); }
        resolveExact(root, "package.json", specifier, owner + "/" + member);
      }
    }
 }

function authenticateRoot(options: AdmissionOptions) {
  checkTestSdkRuntime();
  if (Object.keys(options).toSorted().join(",") !== "archives,root") { fail("only public root/archives accepted"); }
  const { root, archives } = options; physical(root); physical(archives, false);
  if (readdirSync(root).toSorted().join(",") !== "node_modules,package-lock.json,package.json") { fail("root entries"); }
  for (const [name, digest] of Object.entries(TEST_SDK_ROOT_HASHES)) {
    if (payloadHash(readTestSdkBytes(join(root, name), 0o600, 1024 * 1024)) !== digest) { fail("root/lock identity: " + name); }
  }
  const packages = record(json(readTestSdkBytes(join(root, "package-lock.json"), 0o600)).packages), placements = inventory(root, packages);
  return { packages, placements };
}
function archiveLocators(archives: string) {
  const indexBytes = readTestSdkBytes(join(archives, "index.json"), undefined, 1024 * 1024);
  const index = json(indexBytes), locators = record(index.placements);
  const locatorKeys = [...indexBytes.toString().matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map(m => JSON.parse('"' + m[1] + '"') as unknown);
  if (Object.keys(index).toSorted().join(",") !== "placements,schema" || locatorKeys.length !== 101 || new Set(locatorKeys).size !== 101) { fail("ambiguous archive locator index"); }
  if (index.schema !== "agtmai-test-sdk-archive-locator-v1" || Object.keys(locators).length !== 99 || Object.keys(locators).some(p => !TEST_SDK_PACKAGES.includes(p))) { fail("archive locator owners"); }
  return locators;
}

function authenticatePackage(options: AdmissionOptions, owner: string, locators: Record<string, unknown>,
  packages: Record<string, unknown>, placements: string[]) {
    const { root, archives } = options;
    const name = locators[owner], locked = record(packages[owner]);
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(name) || name.includes("..") || typeof locked.integrity !== "string") { fail("unsafe/missing archive locator"); }
    const archive = readTestSdkBytes(join(archives, name)), payload = readTestSdkPayload(owner, archive, locked.integrity);
    if (owner === "node_modules/jayson") {
      const original = payload.get(".gitignore");
      if (original?.sha256 !== "b2d141921f6d7fbfa6a5e0b0145fae2992c27343b7fb2f58e9ac4521fcb5f48b" || payload.has(".npmignore")) { fail("unapproved npm rename"); }
      payload.delete(".gitignore"); payload.set(".npmignore", original);
    }
    compare(root, owner, payload, placements);
    return { payload, archiveSha256: payloadHash(archive) };
}

function checkResolutions(root: string) {
  for (const [source, specifier, target] of RESOLUTION_EDGES) { resolveExact(root, source!, specifier!, target!); }
  for (const local of TEST_SDK_NATIVE_ABSENCES) { absent(join(root, "node_modules/bigint-buffer", local)); }
  const optional: readonly (readonly string[])[] = [...OPTIONAL_BRANCHES, ...TEST_SDK_EXTRA_ABSENCES, ["node_modules/bigint-buffer/dist/node.js", "node-gyp-build"]];
  for (const [source, specifier] of optional) {
    if (!source || !specifier) { fail("optional policy contract"); }
    try { createRequire(join(root, source)).resolve(specifier); }
    catch (error) { if (code(error) === "MODULE_NOT_FOUND") { continue; } throw error; }
    fail("optional/native branch reachable: " + specifier + " from " + source);
  }
}

function admit(options: AdmissionOptions) {
  const { root, archives } = options;
  const { packages, placements } = authenticateRoot(options), locators = archiveLocators(archives);
  const members = new Map<string, RuntimeMember>(), archiveIds: Record<string, string> = {}, unique = new Set<string>();
  for (const owner of TEST_SDK_PACKAGES) {
    const { payload, archiveSha256 } = authenticatePackage(options, owner, locators, packages, placements);
    archiveIds[owner] = archiveSha256; unique.add(archiveSha256);
    collectRuntimeMembers(root, owner, payload, members);
    checkSdkExports(root, owner, payload);
  }
  if (unique.size !== 95) { fail("archive uniqueness drift"); }
  checkResolutions(root);
  const evidence: AdmissionEvidence = Object.freeze({ qualification: "complete-byte-admission", root,
    sourceBaseline: TEST_SDK_ADMISSION_SOURCE,
    owners: 99, uniqueArchives: unique.size, members: members.size,
    memberInventorySha256: payloadHash(Buffer.from(JSON.stringify([...members].map(([url, member]) => [url.slice(pathToFileURL(root + "/").href.length), member.format, payloadHash(member.bytes)]).toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))))), archives: Object.freeze(archiveIds), rootHashes: TEST_SDK_ROOT_HASHES });
  return { members, evidence };
}
/** No candidate evaluation. Caller retains operator-enforced read-only metadata custody. */
export function admitTestSdk(options: AdmissionOptions): AdmissionEvidence { return admit(options).evidence; }
let processOwned = false;
let processCounters: (() => Readonly<{ loads: number; denied: number; closed: boolean }>) | undefined;
/** Read-only diagnostics for this dedicated TEST process, including a closed client. */
export function testSdkCounters() { return processCounters?.() ?? null; }
/** Internal consumer seam. No import capability or admitted map escapes. One lifetime per process. */
export async function openTestSdk(options: AdmissionOptions) {
  if (processOwned) { fail("dedicated process already used"); }
  const { members, evidence } = admit(options); processOwned = true;
  let violation: Error | undefined, loads = 0, denied = 0, closed = false;
  const counters = () => Object.freeze({ loads, denied, closed });
  processCounters = counters;
  const reject = (reason: string): never => { denied++; const error = new Error("TEST SDK guard: " + reason); violation ??= error; throw error; };
  const candidate = (url: string): boolean => url.startsWith(pathToFileURL(options.root + "/").href);
  const allowed = (url: string): void => { if (!members.has(url) || pathToFileURL(fileURLToPath(url)).href !== url) { reject("unadmitted/canonical target: " + url); } };
  const oldWs = [process.env.WS_NO_BUFFER_UTIL, process.env.WS_NO_UTF_8_VALIDATE];
  process.env.WS_NO_BUFFER_UTIL = "1"; process.env.WS_NO_UTF_8_VALIDATE = "1";
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const builtin = specifier.replace(/^node:/, "");
      if (TEST_SDK_BUILTINS.includes(builtin)) { return next(specifier, context); }
      if (specifier.startsWith("node:") || /^(?:data:|https?:)/.test(specifier) || /[?#]/.test(specifier)) { return reject("specifier: " + specifier); }
      let result: ReturnType<typeof next>;
      try { result = next(specifier, context); }
      catch (error) {
        const parent = context.parentURL;
        const optionalMiss = [...OPTIONAL_BRANCHES, ...TEST_SDK_EXTRA_ABSENCES].some(([owner, name]) => specifier === name && parent === pathToFileURL(join(options.root, owner!)).href);
        const nativeMiss = parent === pathToFileURL(join(options.root, "node_modules/bindings/bindings.js")).href &&
          TEST_SDK_NATIVE_ABSENCES.some(local => specifier === join(options.root, "node_modules/bigint-buffer", local));
        if (code(error) === "MODULE_NOT_FOUND" && (optionalMiss || nativeMiss)) { throw error; }
        return reject("resolution failed: " + specifier);
      }
      if (result.url.startsWith("node:")) { return reject("builtin: " + result.url); }
      // Candidate parents can never enter host modules. Host imports after installation
      // also require an admitted target; trusted host dependencies are preloaded.
      if (result.url.endsWith(".node")) { return reject("native target: " + result.url); }
      if (context.parentURL && candidate(context.parentURL) && !candidate(result.url)) { return reject("candidate into host"); }
      allowed(result.url); return result;
    },
    load(url, context, _next) {
      if (url.startsWith("node:")) { if (!TEST_SDK_BUILTINS.includes(url.slice(5))) { return reject("builtin load"); } return _next(url, context); }
      allowed(url);
      const member = members.get(url)!;
      const format = context.format ?? member.format;
      if (format !== member.format || !["module", "commonjs", "json"].includes(String(format))) { return reject("format: " + String(format)); }
      loads++; return { format: format!, source: member.bytes, shortCircuit: true };
    },
  });
  const assertHealthy = (): void => { if (violation) { throw violation; } if (closed) { fail("session destroyed"); } };
  const close = (): void => {
    if (closed) { return; } closed = true; hooks.deregister(); process.removeListener("exit", close);
    for (const [i, key] of ["WS_NO_BUFFER_UTIL", "WS_NO_UTF_8_VALIDATE"].entries()) { const previous = oldWs[i]; if (previous === undefined) { delete process.env[key]; } else { process.env[key] = previous; } }
    members.clear();
  };
  process.once("exit", close);
  try {
    const require = createRequire(join(options.root, "package.json"));
    const evm: typeof Evm = await import(pathToFileURL(require.resolve(TEST_SDK_ENTRIES.evm[0])).href);
    // The SDK destination builder registry needs the selected Solana entry's registration,
    // even for an EVM-only unsigned consumer. No Solana client is constructed.
    const solana: typeof Solana = await import(pathToFileURL(require.resolve(TEST_SDK_ENTRIES.solana[0])).href);
    const api: typeof Api = await import(pathToFileURL(require.resolve(TEST_SDK_ENTRIES.api[0])).href);
    const types: typeof Types = await import(pathToFileURL(require.resolve(TEST_SDK_ENTRIES.types[0])).href);
    if (typeof solana.SolanaChain !== "function" || typeof api.CCIPAPIClient !== "function" || !types.ExecutionState) { fail("selected exports missing"); }
    const abi: typeof Abi = await import(pathToFileURL(require.resolve("ethers/abi")).href);
    const contract: typeof Contract = await import(pathToFileURL(require.resolve("ethers/contract")).href);
    const web3: typeof Web3 = require("@solana/web3.js");
    const spl: typeof Spl = require("@solana/spl-token");
    const bs58: { default: typeof Bs58 } = require("bs58");
    const native: NativeSolanaProvider = Object.freeze({
      web3: Object.freeze({ PublicKey: web3.PublicKey, SystemProgram: web3.SystemProgram, Transaction: web3.Transaction,
        TransactionInstruction: web3.TransactionInstruction, TransactionMessage: web3.TransactionMessage,
        VersionedTransaction: web3.VersionedTransaction, AddressLookupTableAccount: web3.AddressLookupTableAccount, Keypair: web3.Keypair }),
      spl: Object.freeze({ TOKEN_PROGRAM_ID: spl.TOKEN_PROGRAM_ID, createInitializeMint2Instruction: spl.createInitializeMint2Instruction,
        getAssociatedTokenAddressSync: spl.getAssociatedTokenAddressSync, unpackMint: spl.unpackMint, unpackAccount: spl.unpackAccount }),
      bs58: Object.freeze({ encode: bs58.default.encode }),
    });
    assertHealthy();
    return Object.freeze({ evm, solana, api, types, native, abi, contract, evidence, assertHealthy, close,
      counters });
  } catch (error) { close(); throw error; }
}
