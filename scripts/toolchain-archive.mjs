import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertExpectedFileHashes } from "./toolchain-policy.mjs";
import {
  assertCapturedCleanupTreeSnapshot,
  captureCleanupTreeSnapshot,
  cleanupIdentityBoundDirectory,
  createCleanupHandle,
  updateCleanupTreeSnapshot,
} from "./rollback/runtime/cleanup.mjs";
import { allowlistedChildEnvironment } from "./toolchain-environment.mjs";
import { toolchainProvenanceFile } from "./toolchain-provenance.mjs";

export const completeTreeAuthority = "pinned-archive-complete-tree-v1";
export const provenanceFile = toolchainProvenanceFile;

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Descriptor(descriptor, size) {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let position = 0n;
  while (position < size) {
    const remaining = size - position;
    const length = Number(remaining > BigInt(chunk.length) ? BigInt(chunk.length) : remaining);
    const read = readSync(descriptor, chunk, 0, length, Number(position));
    if (read <= 0) {throw new Error("TOOLCHAIN_ARCHIVE_DESCRIPTOR_TRUNCATED");}
    hash.update(chunk.subarray(0, read));
    position += BigInt(read);
  }
  return hash.digest("hex");
}

function openVerifiedArchive({ name, platform, artifact, archive, missingCode }) {
  if (!existsSync(archive)) {
    throw new Error(`${missingCode} tool=${name} platform=${platform} expected=${archive}`);
  }
  let descriptor;
  try {
    descriptor = openSync(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = fstatSync(descriptor, { bigint: true });
    if (!identity.isFile()) {
      throw new Error(`TOOLCHAIN_ARCHIVE_UNSAFE tool=${name} platform=${platform} reason=not-regular-file`);
    }
    const actual = sha256Descriptor(descriptor, identity.size);
    if (actual !== artifact.sha256) {
      throw new Error(
        `TOOLCHAIN_OFFLINE_UNVERIFIED_CACHE tool=${name} platform=${platform} expected=${artifact.sha256} actual=${actual}`,
      );
    }
    return { descriptor, identity };
  } catch (error) {
    if (descriptor !== undefined) {closeSync(descriptor);}
    throw error;
  }
}

function sameArchiveIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.gid === right.gid && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.isFile() === right.isFile();
}

function assertArchiveStable({ name, platform, artifact, archive, verified }) {
  const descriptorIdentity = fstatSync(verified.descriptor, { bigint: true });
  let pathIdentity;
  try {
    pathIdentity = lstatSync(archive, { bigint: true });
  } catch {
    throw new Error(`TOOLCHAIN_ARCHIVE_SUBSTITUTED tool=${name} platform=${platform} reason=path-missing`);
  }
  if (!sameArchiveIdentity(verified.identity, descriptorIdentity)
    || !sameArchiveIdentity(verified.identity, pathIdentity)
    || sha256Descriptor(verified.descriptor, verified.identity.size) !== artifact.sha256) {
    throw new Error(
      `TOOLCHAIN_ARCHIVE_SUBSTITUTED tool=${name} platform=${platform} reason=identity-or-content-changed`,
    );
  }
}

function copyDescriptor(descriptor, size, target) {
  const targetDescriptor = openSync(target, "wx", 0o700);
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let position = 0n;
  try {
    while (position < size) {
      const remaining = size - position;
      const length = Number(remaining > BigInt(chunk.length) ? BigInt(chunk.length) : remaining);
      const read = readSync(descriptor, chunk, 0, length, Number(position));
      if (read <= 0) {throw new Error("TOOLCHAIN_ARCHIVE_DESCRIPTOR_TRUNCATED");}
      writeFileSync(targetDescriptor, chunk.subarray(0, read));
      position += BigInt(read);
    }
  } finally {
    closeSync(targetDescriptor);
  }
}

function extractDescriptor(descriptor, artifact, staged) {
  const flag = artifact.archive === "tar.xz"
    ? "-xJf"
    : artifact.archive === "tar.bz2" ? "-xjf" : "-xzf";
  const result = spawnSync(
    "/usr/bin/tar",
    ["--no-same-owner", "--no-same-permissions", flag, "/dev/fd/3", "-C", staged],
    {
      encoding: "utf8",
      env: allowlistedChildEnvironment(process.env, { PATH: "/usr/bin:/bin" }),
      stdio: ["ignore", "pipe", "pipe", descriptor],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `TOOLCHAIN_ARCHIVE_EXTRACTION_FAILED status=${String(result.status)} stderr=${singleLine(result.stderr)}`,
      { cause: result.error },
    );
  }
}

function installationSource(staged) {
  const entries = readdirSync(staged);
  if (entries.length !== 1) {return staged;}
  const candidate = join(staged, entries[0]);
  return lstatSync(candidate).isDirectory() ? candidate : staged;
}

function normalizeTreeMetadata(root) {
  for (const name of readdirSync(root).toSorted()) {
    const target = join(root, name);
    const stats = lstatSync(target);
    if (stats.isDirectory()) {
      chmodSync(target, 0o755);
      normalizeTreeMetadata(target);
    } else if (stats.isFile()) {
      chmodSync(target, (stats.mode & 0o111) === 0 ? 0o644 : 0o755);
    } else if (!stats.isSymbolicLink()) {
      throw new Error(`TOOLCHAIN_INSTALL_ENTRY_UNSAFE path=${relative(root, target)} type=special`);
    }
  }
}

function isInside(root, target) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

export function inventoryInstallation(root, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const inventory = {};
  walkInventory(root, root, excluded, inventory);
  return inventory;
}

function walkInventory(root, directory, excluded, inventory) {
  for (const name of readdirSync(directory).toSorted()) {
    const target = join(directory, name);
    const path = relative(root, target).split(sep).join("/");
    if (excluded.has(path)) {continue;}
    const stats = lstatSync(target);
    const mode = stats.mode & 0o777;
    if (stats.isDirectory()) {
      inventory[path] = { type: "directory", mode };
      walkInventory(root, target, excluded, inventory);
    } else if (stats.isFile()) {
      inventory[path] = { type: "file", mode, size: stats.size, sha256: sha256(target) };
    } else if (stats.isSymbolicLink()) {
      const link = readlinkSync(target);
      if (!isInside(root, resolve(dirname(target), link))) {
        throw new Error(`TOOLCHAIN_INSTALL_SYMLINK_ESCAPE path=${path}`);
      }
      inventory[path] = { type: "symlink", mode, link };
    } else {
      throw new Error(`TOOLCHAIN_INSTALL_ENTRY_UNSAFE path=${path} type=special`);
    }
  }
}

export function inventorySha256(inventory) {
  return createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
}

export function inspectInstallationInventory(destination, authorityInventory) {
  let actual;
  try {
    actual = inventoryInstallation(destination, { exclude: [provenanceFile] });
  } catch (error) {
    return `inventory-unsafe:${singleLine(error instanceof Error ? error.message : error)}`;
  }
  for (const [path, expected] of Object.entries(authorityInventory)) {
    const found = actual[path];
    if (found === undefined) {return `entry-missing:${path}`;}
    if (found.type !== expected.type) {return `entry-type:${path}`;}
    if (found.mode !== expected.mode) {return `entry-mode:${path}`;}
    if (expected.type === "file" && found.sha256 !== expected.sha256) {return `file-checksum:${path}`;}
    if (expected.type === "file" && found.size !== expected.size) {return `file-size:${path}`;}
    if (expected.type === "symlink" && found.link !== expected.link) {return `symlink-target:${path}`;}
  }
  const injected = Object.keys(actual).find((path) => authorityInventory[path] === undefined);
  return injected === undefined ? undefined : `entry-injected:${injected}`;
}

export function prepareVerifiedPayload({
  name,
  platform,
  artifact,
  archive,
  toolsRoot,
  missingCode,
  onArchiveVerified,
  onCleanupBoundary,
}) {
  const stageRoot = mkdtempSync(join(toolsRoot, ".install-part-"));
  const cleanupHandle = createCleanupHandle(stageRoot, {
    temporaryRoot: toolsRoot,
    targetPrefix: ".install-part-",
    allowedEntries: ["payload"],
  });
  const staged = join(stageRoot, "payload");
  let verified;
  let internalTreeUpdateAllowed = false;
  try {
    mkdirSync(staged);
    captureCleanupTreeSnapshot(cleanupHandle);
    verified = openVerifiedArchive({ name, platform, artifact, archive, missingCode });
    onArchiveVerified?.({ archive, descriptor: verified.descriptor });
    assertCapturedCleanupTreeSnapshot(cleanupHandle);
    internalTreeUpdateAllowed = true;
    if (artifact.archive === "executable") {
      const target = join(staged, artifact.expectedFiles[0]);
      mkdirSync(dirname(target), { recursive: true });
      copyDescriptor(verified.descriptor, verified.identity.size, target);
      chmodSync(target, 0o755);
    } else {
      extractDescriptor(verified.descriptor, artifact, staged);
    }
    assertArchiveStable({ name, platform, artifact, archive, verified });
    const source = artifact.archive === "executable" ? staged : installationSource(staged);
    normalizeTreeMetadata(source);
    const inventory = inventoryInstallation(source);
    if (inventory[provenanceFile] !== undefined) {
      throw new Error(`TOOLCHAIN_INSTALL_RESERVED_ENTRY tool=${name} path=${provenanceFile}`);
    }
    const files = Object.fromEntries(artifact.expectedFiles.map((path) => {
      const entry = inventory[path];
      if (entry?.type !== "file") {
        throw new Error(`TOOLCHAIN_INSTALL_EXPECTED_FILE tool=${name} platform=${platform} path=${path}`);
      }
      return [path, entry.sha256];
    }));
    assertExpectedFileHashes({ name, platform, artifact, files });
    updateCleanupTreeSnapshot(cleanupHandle);
    internalTreeUpdateAllowed = false;
    return {
      artifact,
      artifactAuthoritySha256: artifactAuthoritySha256(name, platform, artifact),
      cleanupHandle,
      files,
      inventory,
      inventorySha256: inventorySha256(inventory),
      source,
      stageRoot,
    };
  } catch (error) {
    try {
      if (internalTreeUpdateAllowed) {
        updateCleanupTreeSnapshot(cleanupHandle);
      }
      cleanupPreparedPayload({ cleanupHandle, stageRoot }, { onBoundary: onCleanupBoundary });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${error instanceof Error ? error.message : String(error)}; cleanup=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw error;
  } finally {
    if (verified !== undefined) {closeSync(verified.descriptor);}
  }
}

export function cleanupPreparedPayload(prepared, options = {}) {
  if (prepared?.cleanupHandle === undefined) {
    throw new Error("TOOLCHAIN_CLEANUP_HANDLE_REQUIRED");
  }
  return cleanupIdentityBoundDirectory(prepared.cleanupHandle, options);
}

export function assertPreparedArtifactAuthority(prepared, { name, platform, artifact }) {
  if (prepared?.artifact !== artifact
    || prepared.artifactAuthoritySha256 !== artifactAuthoritySha256(name, platform, artifact)) {
    throw new Error(`TOOLCHAIN_PREPARED_ARTIFACT_AUTHORITY_MISMATCH tool=${name} platform=${platform}`);
  }
  assertCapturedCleanupTreeSnapshot(prepared.cleanupHandle);
}

function artifactAuthoritySha256(name, platform, artifact) {
  const authority = {
    name,
    platform,
    archive: artifact?.archive,
    archiveName: artifact?.archiveName,
    sha256: artifact?.sha256,
    installDirectory: artifact?.installDirectory,
    expectedFiles: artifact?.expectedFiles,
    expectedFileSha256: artifact?.expectedFileSha256 ?? null,
    versionChecks: artifact?.versionChecks,
    installationAuthority: artifact?.installationAuthority,
  };
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

function singleLine(value) {
  return String(value).replaceAll(/\s+/g, " ").trim();
}
