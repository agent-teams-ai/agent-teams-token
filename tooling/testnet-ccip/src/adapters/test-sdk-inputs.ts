import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readVerifiedBytes } from "../../../../scripts/toolchain-files.mjs";
import { assertOwnedDirectoryChain } from "../../../../scripts/toolchain-paths.mjs";
import { readTestSdkPayload } from "./test-sdk-admission.ts";
import { TEST_SDK_PACKAGES, TEST_SDK_ROOT_HASHES } from "./test-sdk-policy.ts";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const metadata = fileURLToPath(new URL("../../sdk-inputs/", import.meta.url));
export const sdkInputCache = join(repository, ".tools/downloads/test-sdk-inputs-v1");
const maximumArchiveBytes = 32 * 1024 * 1024;
function fail(reason: string): never { throw new Error("TEST SDK inputs: " + reason); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) { fail("invalid descriptor object"); }
  return value as Record<string, unknown>;
}
function read(path: string): Buffer { return readVerifiedBytes(path, { maximumBytes: maximumArchiveBytes }).bytes; }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function ownedPath(path: string): void {
  if (resolve(path) !== path) { fail("absolute canonical path required"); }
  assertOwnedDirectoryChain(path);
}
function prepareDirectory(path: string): void {
  ownedPath(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  ownedPath(path);
}
function plan() {
  const files = new Map<string, Buffer>();
  for (const [name, sha256] of Object.entries(TEST_SDK_ROOT_HASHES)) {
    const bytes = read(join(metadata, name === "package.json" ? "provider-root.json" : "provider-lock.json"));
    if (hash(bytes) !== sha256) { fail("root metadata hash: " + name); }
    files.set(name, bytes);
  }
  const lock = record(JSON.parse(files.get("package-lock.json")!.toString()) as unknown);
  const packages = record(lock.packages);
  const index = record(JSON.parse(read(join(metadata, "archives.json")).toString()) as unknown);
  const placements = record(index.placements);
  if (index.schema !== "agtmai-test-sdk-archive-locator-v1" ||
    Object.keys(index).toSorted().join(",") !== "placements,schema" ||
    Object.keys(placements).toSorted().join("\n") !== [...TEST_SDK_PACKAGES].toSorted().join("\n") ||
    new Set(Object.values(placements)).size !== 95) { fail("finite 99-placement/95-archive descriptor"); }
  const archives = TEST_SDK_PACKAGES.map(owner => {
    const name = placements[owner], locked = record(packages[owner]);
    if (typeof name !== "string" || !/^[a-f0-9]{64}\.tgz$/.test(name) ||
      typeof locked.resolved !== "string" || typeof locked.integrity !== "string" || typeof locked.version !== "string") {
      fail("locked public archive metadata: " + owner);
    }
    const url = new URL(locked.resolved);
    if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash ||
      !/^\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+\/-\/[a-z0-9._-]+\.tgz$/.test(url.pathname) || url.href !== locked.resolved) {
      fail("public registry locator: " + owner);
    }
    return { owner, name, url: url.href, integrity: locked.integrity, version: locked.version };
  });
  for (const archive of archives) {
    if (archives.some(other => other.name === archive.name &&
      (other.url !== archive.url || other.integrity !== archive.integrity))) { fail("ambiguous archive locator"); }
  }
  return { files, archives };
}
async function download(url: string, deadline: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", credentials: "omit",
    signal: AbortSignal.any([deadline, AbortSignal.timeout(30_000)]) });
  if (!response.ok || response.redirected || !response.body) { fail("public archive fetch failed"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) { break; }
      size += chunk.value.length;
      if (size > maximumArchiveBytes) { fail("public archive exceeds bound"); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
async function cachedPayload(cache: string, retainedCache: string, archive: ReturnType<typeof plan>["archives"][number], fetchArchives: boolean, deadline: AbortSignal) {
  const path = join(cache, archive.name);
  let bytes: Buffer, fetched = false;
  // An existing corrupt or unsafe cache is rejected, never replaced by a fetch.
  if (lstatIfPresent(path)) { bytes = read(path); }
  else {
    if (!fetchArchives) { fail("offline cache miss: " + archive.name); }
    bytes = await download(archive.url, deadline); fetched = true;
  }
  const payload = readTestSdkPayload(archive.owner, bytes, archive.integrity);
  const manifest = payload.get("package.json")?.bytes;
  if (!manifest || record(JSON.parse(manifest.toString()) as unknown).version !== archive.version) { fail("public package version"); }
  if (fetched) {
    prepareDirectory(cache);
    writeFileSync(path, bytes, { flag: "wx", mode: 0o400 });
  }
  if (retainedCache !== cache) {
    const retained = join(retainedCache, archive.name);
    if (lstatIfPresent(retained)) {
      if (!read(retained).equals(bytes)) { fail("retained cache byte drift: " + archive.name); }
    } else {
      prepareDirectory(retainedCache); writeFileSync(retained, bytes, { flag: "wx", mode: 0o400 });
    }
  }
  return payload;
}
function verifyProjection(destination: string, files: ReadonlyMap<string, Buffer>, directories: ReadonlySet<string>): void {
  const remaining = new Set([...files.keys(), ...directories]);
  function visit(local: string): void {
    const path = local ? join(destination, local) : destination, stat = lstatSync(path);
    if (stat.uid !== process.getuid?.() || stat.isSymbolicLink()) { fail("projection owner/link: " + local); }
    if (stat.isDirectory()) {
      if ((local && !directories.has(local)) || (stat.mode & 0o7777) !== 0o500) { fail("projection directory/mode: " + local); }
      for (const name of readdirSync(path)) { visit(local ? local + "/" + name : name); }
    } else {
      const bytes = files.get(local);
      if (!bytes || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o400 || !read(path).equals(bytes)) {
        fail("projection file/mode/bytes: " + local);
      }
    }
    remaining.delete(local);
  }
  visit("");
  if (remaining.size) { fail("projection missing member: " + remaining.values().next().value); }
}
/** Compile inputs only: no package evaluation, install scripts or execution admission. */
export async function stageSdkInputs(options: { readonly cache: string; readonly destination: string; readonly fetchArchives: boolean; readonly retainCache?: string }) {
  const { cache, destination, fetchArchives } = options;
  const retainedCache = options.retainCache ?? cache;
  ownedPath(cache); ownedPath(destination); ownedPath(retainedCache);
  for (const path of [cache, retainedCache]) {
    if (destination === path || destination.startsWith(path + "/") || path.startsWith(destination + "/")) { fail("cache/destination overlap"); }
  }
  const { files, archives } = plan(), unique = new Set<string>();
  const deadline = AbortSignal.timeout(8 * 60_000);
  for (const archive of archives) {
    const payload = await cachedPayload(cache, retainedCache, archive, fetchArchives, deadline);
    unique.add(archive.name);
    for (const [local, entry] of payload) {
      if (entry.type === "file" && entry.bytes && (local === "package.json" || /\.d\.(?:ts|mts|cts)$/.test(local))) {
        files.set(archive.owner + "/" + local, entry.bytes);
      }
    }
  }
  const directories = new Set<string>(["node_modules"]);
  for (const file of files.keys()) {
    for (let parent = dirname(file); parent !== "."; parent = dirname(parent)) {
      if (files.has(parent)) { fail("projection file as parent"); }
      directories.add(parent);
    }
  }
  if (!lstatIfPresent(destination)) {
    prepareDirectory(dirname(destination));
    mkdirSync(destination, { mode: 0o700 }); // Exclusive; never overwrite a foreign snapshot.
    for (const directory of [...directories].toSorted()) { mkdirSync(join(destination, directory), { mode: 0o700 }); }
    for (const [local, bytes] of files) { writeFileSync(join(destination, local), bytes, { flag: "wx", mode: 0o400 }); }
    for (const directory of [...directories].toSorted().toReversed()) { chmodSync(join(destination, directory), 0o500); }
    chmodSync(destination, 0o500);
  }
  // Repeat calls validate all cached SRI and every staged byte; they never edit the input.
  verifyProjection(destination, files, directories);
  return { purpose: "declarations-only", owners: archives.length, uniqueArchives: unique.size,
    declarationFiles: [...files.keys()].filter(name => /\.d\.(?:ts|mts|cts)$/.test(name)).length,
    rootHashes: TEST_SDK_ROOT_HASHES, destination } as const;
}
function lstatIfPresent(path: string) {
  try { return lstatSync(path); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") { return; } throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (!["--fetch", "--offline"].includes(mode ?? "") || (args.length !== 0 && (args.length !== 2 || args[0] !== "--cache" || !args[1]))) {
    fail("usage: test-sdk-inputs.ts --fetch|--offline [--cache ABSOLUTE_DIRECTORY]");
  }
  process.stdout.write(JSON.stringify(await stageSdkInputs({ cache: args[1] ?? sdkInputCache,
    retainCache: sdkInputCache, destination: join(repository, ".local/INPUT/provider"), fetchArchives: mode === "--fetch" })) + "\n");
}
