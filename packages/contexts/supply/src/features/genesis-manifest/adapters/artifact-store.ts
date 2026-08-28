import { constants, open, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { canonicalJson, type JsonValue } from "../application/canonical.js";
import { normalizeLocalSource, type LocalGenesisManifest, type LocalGenesisSource } from "../domain/model.js";
import { encodeAllocationCommitment } from "./abi.js";
import { sha256 } from "./digest.js";

export interface ReadyMarker {
  readonly sourceSha256: string;
  readonly localFixtureArtifactSha256: string;
}

export async function readSafeSource(sourcePath: string, outputRoot: string): Promise<string> {
  const handle = await openRegularNoLinks(sourcePath, "SOURCE");
  try {
    const source = await handle.stat();
    try {
      const output = await lstat(outputRoot);
      if (output.isSymbolicLink()) throw new Error("GENESIS_IO_OUTPUT_SYMLINK");
      if (source.dev === output.dev && source.ino === output.ino) throw new Error("GENESIS_IO_SOURCE_OUTPUT_SAME_INODE");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function assertSafeSource(sourcePath: string, outputRoot: string): Promise<void> {
  await readSafeSource(sourcePath, outputRoot);
}

export async function writeArtifact(outputRoot: string, manifest: LocalGenesisManifest, canonicalBytes: Uint8Array): Promise<string> {
  if (!(canonicalBytes instanceof Uint8Array) || !isLocalManifest(manifest) || !verifyManifest(manifest, canonicalBytes)) {
    throw new Error("GENESIS_INTERNAL_INVALID_MANIFEST");
  }
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const digestName = manifest.localFixtureArtifactSha256.slice(2);
  const directory = join(outputRoot, digestName);
  await assertRealDirectory(outputRoot, "OUTPUT_ROOT");
  await mkdir(directory, { mode: 0o700 });
  const nonce = `${process.pid}-${Date.now()}`;
  const temporary = join(directory, `.manifest-${nonce}.tmp`);
  const readyTemporary = join(directory, `.READY-${nonce}.tmp`);
  const artifact = join(directory, "manifest.json");
  try {
    await writeSyncedExclusive(temporary, canonicalBytes);
    await rename(temporary, artifact);
    await syncDirectory(directory);
    const marker: ReadyMarker = {
      sourceSha256: manifest.sourceSha256,
      localFixtureArtifactSha256: manifest.localFixtureArtifactSha256,
    };
    await writeSyncedExclusive(readyTemporary, Buffer.from(`${JSON.stringify(marker)}\n`, "utf8"));
    await rename(readyTemporary, join(directory, "READY"));
    await syncDirectory(directory);
    await syncDirectory(outputRoot);
    return directory;
  } catch (cause) {
    await rm(temporary, { force: true });
    await rm(readyTemporary, { force: true });
    await rm(directory, { force: true, recursive: true });
    throw cause;
  }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw new Error(`GENESIS_IO_${label}_SYMLINK`);
  if (!entry.isDirectory()) throw new Error(`GENESIS_IO_${label}_NOT_DIRECTORY`);
}

export async function inspectArtifacts(outputRoot: string): Promise<Array<{ directory: string; marker: ReadyMarker; manifest: LocalGenesisManifest }>> {
  const output: Array<{ directory: string; marker: ReadyMarker; manifest: LocalGenesisManifest }> = [];
  await assertRealDirectory(outputRoot, "OUTPUT_ROOT");
  for (const name of (await readdir(outputRoot)).sort()) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const directory = resolve(outputRoot, name);
    const entry = await lstat(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory() || entry.nlink < 2) continue;
    try {
      const markerBytes = await readRegularNoLinks(join(directory, "READY"), "READY");
      const artifactBytes = await readRegularNoLinks(join(directory, "manifest.json"), "MANIFEST");
      const markerValue: unknown = JSON.parse(markerBytes.toString("utf8"));
      const manifestValue: unknown = JSON.parse(artifactBytes.toString("utf8"));
      if (!isReadyMarker(markerValue) || !isLocalManifest(manifestValue)) continue;
      if (
        basename(directory) === markerValue.localFixtureArtifactSha256.slice(2)
        && markerValue.localFixtureArtifactSha256 === manifestValue.localFixtureArtifactSha256
        && markerValue.sourceSha256 === manifestValue.sourceSha256
        && verifyManifest(manifestValue, artifactBytes)
      ) {
        output.push({ directory, marker: markerValue, manifest: manifestValue });
      }
    } catch {
      // Incomplete, linked, malformed, or forged outputs are intentionally not ready.
    }
  }
  return output;
}

async function openRegularNoLinks(path: string, label: string) {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`GENESIS_IO_${label}_SYMLINK`);
    throw cause;
  }
  const file = await handle.stat();
  if (!file.isFile() || file.nlink !== 1) {
    await handle.close();
    throw new Error(`GENESIS_IO_${label}_HARDLINK`);
  }
  if (noFollow === 0) {
    const pathEntry = await lstat(path);
    if (pathEntry.isSymbolicLink()) {
      await handle.close();
      throw new Error(`GENESIS_IO_${label}_SYMLINK`);
    }
    if (pathEntry.dev !== file.dev || pathEntry.ino !== file.ino) {
      await handle.close();
      throw new Error(`GENESIS_IO_${label}_CHANGED_DURING_OPEN`);
    }
  }
  return handle;
}

async function readRegularNoLinks(path: string, label: string): Promise<Buffer> {
  const handle = await openRegularNoLinks(path, label);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeSyncedExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isReadyMarker(value: unknown): value is ReadyMarker {
  const marker = asRecord(value);
  return marker !== undefined
    && hasExactKeys(marker, ["sourceSha256", "localFixtureArtifactSha256"])
    && isHash(marker.sourceSha256)
    && isHash(marker.localFixtureArtifactSha256);
}

function isLocalManifest(value: unknown): value is LocalGenesisManifest {
  const manifest = asRecord(value);
  if (!manifest || !hasExactKeys(manifest, ["schemaVersion", "purpose", "status", "network", "token", "allocations", "sourceSha256", "rawAllocationAbi", "genesisAllocationHash", "tool", "localFixtureArtifactSha256"])) return false;
  const network = asRecord(manifest.network);
  const token = asRecord(manifest.token);
  const tool = asRecord(manifest.tool);
  if (
    manifest.schemaVersion !== 1 || manifest.purpose !== "local-fixture-artifact" || manifest.status !== "test-only"
    || !network || !hasExactKeys(network, ["kind", "chainId"]) || network.kind !== "local-evm" || network.chainId !== "31337"
    || !token || !hasExactKeys(token, ["name", "symbol", "decimals", "initialSupplyBaseUnits"])
    || token.name !== "Agent Teams AI" || token.symbol !== "AGTMAI" || token.decimals !== 9 || !isUint(token.initialSupplyBaseUnits)
    || !tool || !hasExactKeys(tool, ["name", "feature", "version"]) || tool.name !== "@agent-teams/supply" || tool.feature !== "genesis-manifest" || tool.version !== "1"
    || !isHash(manifest.sourceSha256) || !isHash(manifest.genesisAllocationHash) || !isHash(manifest.localFixtureArtifactSha256)
    || typeof manifest.rawAllocationAbi !== "string" || !/^0x(?:[0-9a-f]{2})+$/.test(manifest.rawAllocationAbi)
    || !Array.isArray(manifest.allocations) || manifest.allocations.length < 1 || manifest.allocations.length > 32
  ) return false;
  return manifest.allocations.every(isManifestAllocation);
}

function isManifestAllocation(value: unknown): boolean {
  const allocation = asRecord(value);
  return allocation !== undefined
    && hasExactKeys(allocation, allocation.bps === undefined ? ["id", "idBytes32", "recipient", "amountBaseUnits"] : ["id", "idBytes32", "recipient", "amountBaseUnits", "bps"])
    && typeof allocation.id === "string"
    && isHash(allocation.idBytes32)
    && typeof allocation.recipient === "string" && /^0x[0-9a-f]{40}$/.test(allocation.recipient)
    && isUint(allocation.amountBaseUnits)
    && (allocation.bps === undefined || Number.isInteger(allocation.bps));
}

function verifyManifest(manifest: LocalGenesisManifest, artifactBytes: Uint8Array): boolean {
  const canonical = canonicalJson(manifest as unknown as JsonValue);
  if (!Buffer.from(artifactBytes).equals(Buffer.from(canonical, "utf8"))) return false;
  const { localFixtureArtifactSha256: _digest, ...withoutDigest } = manifest;
  const prefix = Buffer.from("AGTMAI_LOCAL_FIXTURE_ARTIFACT_V1\0", "ascii");
  const expectedDigest = sha256(Buffer.concat([prefix, Buffer.from(canonicalJson(withoutDigest as unknown as JsonValue), "utf8")]));
  if (expectedDigest !== manifest.localFixtureArtifactSha256) return false;
  const source: LocalGenesisSource = {
    schemaVersion: 1,
    purpose: "local-fixture",
    status: "test-only",
    network: manifest.network,
    token: manifest.token,
    allocations: manifest.allocations,
  };
  const normalized = normalizeLocalSource(source);
  if (!normalized.allocations || canonicalJson(normalized.allocations as unknown as JsonValue) !== canonicalJson(manifest.allocations as unknown as JsonValue)) return false;
  const commitment = encodeAllocationCommitment(source, normalized.allocations);
  return commitment.rawAbi === manifest.rawAllocationAbi && commitment.hash === manifest.genesisAllocationHash;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function isHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
}

function isUint(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}
