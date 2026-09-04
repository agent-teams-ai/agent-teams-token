import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { descriptorChild } from "./common.mjs";
import {
  custodyDescriptorDirectory,
  registerCustodyDescriptor,
} from "./custody.mjs";
import { validateRuntimeNodeLock } from "./node-runtime-lock.mjs";
import { platformId } from "./offline-environment.mjs";
import {
  cleanupPreparedPayload,
  inspectInstallationInventory,
  inventoryInstallation,
  inventorySha256,
  prepareVerifiedPayload,
  provenanceFile,
} from "../../toolchain-archive.mjs";
import {
  parseToolchainProvenance,
  serializeToolchainProvenance,
} from "../../toolchain-provenance.mjs";

const RUNTIME_LOCK_MAX_BYTES = 2 * 1024 * 1024;
const RUNTIME_PROVENANCE_MAX_BYTES = 64 * 1024;
const RUNTIME_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const RUNTIME_EXECUTABLE_MAX_BYTES = 512 * 1024 * 1024;
const RUNTIME_COMPONENT = /^[a-zA-Z0-9.+_-]+$/u;

export function assertPinnedNodeRuntime(root) {
  const platform = platformId();
  assertSupportedRuntimePlatform(platform);
  const runtimeRoot = openRuntimeRoot(root);
  let executable;
  let prepared;
  try {
    const expected = loadRuntimeExpectations(root, runtimeRoot, platform);
    assertRuntimeArchive(runtimeRoot, expected.artifact);
    prepared = prepareVerifiedPayload({
      name: "node",
      platform,
      artifact: expected.artifact,
      archive: join(root, ".tools", "downloads", expected.artifact.archiveName),
      toolsRoot: join(root, ".tools"),
      missingCode: "ROLLBACK_RUNTIME_ARCHIVE_MISSING",
    });
    executable = openRuntimeRegularFile(
      runtimeRoot,
      [".tools", expected.artifact.installDirectory, "bin", "node"],
      {
        label: ".tools/" + expected.artifact.installDirectory + "/bin/node",
        missingCode: "ROLLBACK_RUNTIME_BINARY_MISSING",
        unsafeCode: "ROLLBACK_RUNTIME_BINARY_UNSAFE",
        maxBytes: RUNTIME_EXECUTABLE_MAX_BYTES,
        executable: true,
      },
    );
    assertRuntimeExecutable(executable, expected.executableSha256);
    assertRuntimeProvenance(runtimeRoot, platform, expected, prepared);
    assertLoadedRuntimeImage(executable, expected.executableSha256);
    assertFinalRuntimeExecutable(runtimeRoot, executable, expected.artifact);
    assertRuntimeIdentity(
      runtimeRoot.identity,
      lstatSync(root, { bigint: true }),
      "ROLLBACK_RUNTIME_ROOT_IDENTITY_CHANGED",
    );
    return {
      platform,
      version: process.version,
      executable: expected.executablePath,
      artifactSha256: expected.artifact.sha256,
      executableSha256: expected.executableSha256,
    };
  } finally {
    if (executable !== undefined) {closeSync(executable.descriptor);}
    closeSync(runtimeRoot.descriptor);
    if (prepared !== undefined) {cleanupPreparedPayload(prepared);}
  }
}

function assertSupportedRuntimePlatform(platform) {
  if (platform === "darwin-arm64") {
    throw new Error(
      "ROLLBACK_RUNTIME_LOADED_IMAGE_BINDING_UNAVAILABLE platform=darwin-arm64",
    );
  }
  if (platform !== "linux-x64") {
    throw new Error("ROLLBACK_RUNTIME_PLATFORM_UNSUPPORTED platform=" + platform);
  }
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw new Error("ROLLBACK_RUNTIME_NOFOLLOW_UNAVAILABLE platform=" + platform);
  }
}

function loadRuntimeExpectations(root, runtimeRoot, platform) {
  const lockFile = openRuntimeRegularFile(runtimeRoot, ["tooling", "toolchain.lock.json"], {
    label: "tooling/toolchain.lock.json",
    missingCode: "ROLLBACK_RUNTIME_LOCK_MISSING",
    unsafeCode: "ROLLBACK_RUNTIME_LOCK_UNSAFE",
    maxBytes: RUNTIME_LOCK_MAX_BYTES,
  });
  let lockBytes;
  try {
    lockBytes = readRuntimeFile(
      lockFile,
      "ROLLBACK_RUNTIME_LOCK_UNSAFE",
      { captureBytes: true },
    ).bytes;
  } finally {
    closeSync(lockFile.descriptor);
  }
  const lock = parseRuntimeJson(lockBytes, "ROLLBACK_RUNTIME_LOCK_INVALID");
  const expected = validateRuntimeNodeLock(lock, platform);
  expected.executablePath = join(root, ".tools", expected.artifact.installDirectory, "bin", "node");
  assertRuntimeExecutablePath(expected.node, expected.executablePath);
  return expected;
}

function assertRuntimeExecutablePath(node, expectedExecutable) {
  if (process.version !== "v" + node.version) {
    throw new Error(
      "ROLLBACK_RUNTIME_VERSION_MISMATCH expected=v" + node.version
      + " actual=" + process.version,
    );
  }
  let actualRealpath;
  try {
    actualRealpath = realpathSync(process.execPath);
  } catch (error) {
    throw new Error("ROLLBACK_RUNTIME_EXEC_PATH_UNSAFE path=" + process.execPath, { cause: error });
  }
  if (!isAbsolute(process.execPath) || resolve(process.execPath) !== expectedExecutable
    || actualRealpath !== expectedExecutable) {
    throw new Error(
      "ROLLBACK_RUNTIME_EXEC_PATH_MISMATCH expected=" + expectedExecutable
      + " actual=" + process.execPath + " realpath=" + actualRealpath,
    );
  }
}

function assertRuntimeArchive(runtimeRoot, artifact) {
  const archiveFile = openRuntimeRegularFile(
    runtimeRoot,
    [".tools", "downloads", artifact.archiveName],
    {
      label: ".tools/downloads/" + artifact.archiveName,
      missingCode: "ROLLBACK_RUNTIME_ARCHIVE_MISSING",
      unsafeCode: "ROLLBACK_RUNTIME_ARCHIVE_UNSAFE",
      maxBytes: RUNTIME_ARCHIVE_MAX_BYTES,
    },
  );
  let archive;
  try {
    archive = readRuntimeFile(archiveFile, "ROLLBACK_RUNTIME_ARCHIVE_UNSAFE");
  } finally {
    closeSync(archiveFile.descriptor);
  }
  if (archive.sha256 !== artifact.sha256) {
    throw new Error(
      "ROLLBACK_RUNTIME_ARCHIVE_HASH_MISMATCH expected=" + artifact.sha256
      + " actual=" + archive.sha256,
    );
  }
}

function assertRuntimeExecutable(executable, executableSha256) {
  const installed = readRuntimeFile(executable, "ROLLBACK_RUNTIME_BINARY_UNSAFE");
  if (installed.sha256 !== executableSha256) {
    throw new Error(
      "ROLLBACK_RUNTIME_BINARY_HASH_MISMATCH expected=" + executableSha256
      + " actual=" + installed.sha256,
    );
  }
}

function assertRuntimeProvenance(runtimeRoot, platform, expected, prepared) {
  const { node, artifact, executableSha256 } = expected;
  const expectedFields = {
    tool: "node",
    version: node.version,
    platform,
    artifactSha256: artifact.sha256,
    inventorySha256: prepared.inventorySha256,
    files: { "bin/node": executableSha256 },
  };
  const provenanceEntry = openRuntimeRegularFile(
    runtimeRoot,
    [".tools", artifact.installDirectory, ".agtmai-toolchain-install.json"],
    {
      label: ".tools/" + artifact.installDirectory + "/.agtmai-toolchain-install.json",
      missingCode: "ROLLBACK_RUNTIME_PROVENANCE_MISSING",
      unsafeCode: "ROLLBACK_RUNTIME_PROVENANCE_UNSAFE",
      maxBytes: RUNTIME_PROVENANCE_MAX_BYTES,
    },
  );
  let actualBytes;
  try {
    actualBytes = readRuntimeFile(
      provenanceEntry,
      "ROLLBACK_RUNTIME_PROVENANCE_UNSAFE",
      { captureBytes: true },
    ).bytes;
  } finally {
    closeSync(provenanceEntry.descriptor);
  }
  let provenance;
  try {
    provenance = parseToolchainProvenance(actualBytes, expectedFields);
  } catch (error) {
    throw new Error("ROLLBACK_RUNTIME_PROVENANCE_MISMATCH", { cause: error });
  }
  const canonicalBytes = Buffer.from(serializeToolchainProvenance(provenance), "utf8");
  if (!actualBytes.equals(canonicalBytes)) {
    throw new Error("ROLLBACK_RUNTIME_PROVENANCE_MISMATCH");
  }
  let actualInventory;
  try {
    actualInventory = inventoryInstallation(
      join(runtimeRootPath(runtimeRoot), ".tools", artifact.installDirectory),
      { exclude: [provenanceFile] },
    );
  } catch (error) {
    throw new Error("ROLLBACK_RUNTIME_PROVENANCE_INVENTORY_UNSAFE", { cause: error });
  }
  if (inventorySha256(actualInventory) !== provenance.inventorySha256) {
    throw new Error("ROLLBACK_RUNTIME_PROVENANCE_INVENTORY_MISMATCH");
  }
  const authorityMismatch = inspectInstallationInventory(
    join(runtimeRootPath(runtimeRoot), ".tools", artifact.installDirectory),
    prepared.inventory,
  );
  if (authorityMismatch !== undefined) {
    throw new Error(
      "ROLLBACK_RUNTIME_ARCHIVE_INVENTORY_MISMATCH reason=" + authorityMismatch,
    );
  }
}

function runtimeRootPath(runtimeRoot) {
  return realpathSync(custodyDescriptorDirectory(runtimeRoot.descriptor));
}

function assertLoadedRuntimeImage(executable, executableSha256) {
  const procEntry = readProcExecutableEntry();
  if (!procEntry.isSymbolicLink()) {
    throw new Error("ROLLBACK_RUNTIME_LOADED_IMAGE_UNSAFE path=/proc/self/exe");
  }
  const loadedDescriptor = openProcExecutable();
  try {
    const loadedIdentity = fstatSync(loadedDescriptor, { bigint: true });
    assertLoadedRuntimeIdentity(loadedIdentity);
    const loaded = readRuntimeFile(
      { descriptor: loadedDescriptor, identity: loadedIdentity, maxBytes: RUNTIME_EXECUTABLE_MAX_BYTES },
      "ROLLBACK_RUNTIME_LOADED_IMAGE_UNSAFE",
    );
    if (loaded.sha256 !== executableSha256) {
      throw new Error(
        "ROLLBACK_RUNTIME_LOADED_IMAGE_HASH_MISMATCH expected=" + executableSha256
        + " actual=" + loaded.sha256,
      );
    }
    assertRuntimeIdentity(
      executable.identity,
      loadedIdentity,
      "ROLLBACK_RUNTIME_IMAGE_IDENTITY_MISMATCH",
    );
  } finally {
    closeSync(loadedDescriptor);
  }
}

function readProcExecutableEntry() {
  try {
    return lstatSync("/proc/self/exe", { bigint: true });
  } catch (error) {
    throw new Error("ROLLBACK_RUNTIME_LOADED_IMAGE_UNAVAILABLE path=/proc/self/exe", { cause: error });
  }
}

function openProcExecutable() {
  try {
    return openSync("/proc/self/exe", constants.O_RDONLY);
  } catch (error) {
    throw new Error("ROLLBACK_RUNTIME_LOADED_IMAGE_UNAVAILABLE path=/proc/self/exe", { cause: error });
  }
}

function assertLoadedRuntimeIdentity(identity) {
  if (!identity.isFile() || identity.size < 0n
    || identity.size > BigInt(RUNTIME_EXECUTABLE_MAX_BYTES)
    || (identity.mode & 0o111n) === 0n) {
    throw new Error("ROLLBACK_RUNTIME_LOADED_IMAGE_UNSAFE path=/proc/self/exe");
  }
}

function assertFinalRuntimeExecutable(runtimeRoot, executable, artifact) {
  const finalExecutable = openRuntimeRegularFile(
    runtimeRoot,
    [".tools", artifact.installDirectory, "bin", "node"],
    {
      label: ".tools/" + artifact.installDirectory + "/bin/node",
      missingCode: "ROLLBACK_RUNTIME_BINARY_MISSING",
      unsafeCode: "ROLLBACK_RUNTIME_BINARY_UNSAFE",
      maxBytes: RUNTIME_EXECUTABLE_MAX_BYTES,
      executable: true,
    },
  );
  try {
    assertRuntimeIdentity(
      executable.identity,
      finalExecutable.identity,
      "ROLLBACK_RUNTIME_BINARY_IDENTITY_CHANGED",
    );
  } finally {
    closeSync(finalExecutable.descriptor);
  }
}

function openRuntimeRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) {
    throw new Error("ROLLBACK_RUNTIME_ROOT_UNSAFE path=" + String(root));
  }
  let canonical;
  let identity;
  try {
    canonical = realpathSync(root);
    identity = lstatSync(root, { bigint: true });
  } catch (error) {
    throw new Error("ROLLBACK_RUNTIME_ROOT_UNSAFE path=" + root, { cause: error });
  }
  if (canonical !== root || !identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error("ROLLBACK_RUNTIME_ROOT_UNSAFE path=" + root);
  }
  let descriptor;
  try {
    descriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    assertRuntimeIdentity(
      identity,
      fstatSync(descriptor, { bigint: true }),
      "ROLLBACK_RUNTIME_ROOT_IDENTITY_CHANGED",
    );
    assertRuntimeIdentity(
      identity,
      lstatSync(root, { bigint: true }),
      "ROLLBACK_RUNTIME_ROOT_IDENTITY_CHANGED",
    );
    registerCustodyDescriptor(descriptor, canonical, identity);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (error instanceof Error && error.message.startsWith("ROLLBACK_RUNTIME_")) {
      throw error;
    }
    throw new Error("ROLLBACK_RUNTIME_ROOT_UNSAFE path=" + root, { cause: error });
  }
  return { canonicalPath: canonical, descriptor, identity };
}

function openRuntimeRegularFile(runtimeRoot, components, options) {
  if (!Array.isArray(components) || components.length < 2
    || components.some((component) => !RUNTIME_COMPONENT.test(component))) {
    throw new Error(options.unsafeCode + " path=" + options.label);
  }
  let directory;
  try {
    directory = openSync(
      custodyDescriptorDirectory(runtimeRoot.descriptor),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    assertRuntimeIdentity(
      runtimeRoot.identity,
      fstatSync(directory, { bigint: true }),
      options.unsafeCode + " path=.",
    );
    registerCustodyDescriptor(directory, runtimeRoot.canonicalPath, runtimeRoot.identity);
    for (const component of components.slice(0, -1)) {
      const candidate = descriptorChild(directory, component);
      const before = readRuntimePathEntry(candidate, options);
      assertRuntimeOwnedDirectory(before, runtimeRoot.identity, options);
      const next = openRuntimeDirectoryEntry(candidate, before, options);
      closeSync(directory);
      directory = next;
    }
    const candidate = descriptorChild(directory, components.at(-1));
    const identity = readRuntimePathEntry(candidate, options);
    assertRuntimeOwnedFile(identity, runtimeRoot.identity, options);
    return openRuntimeFileEntry(candidate, identity, options);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ROLLBACK_RUNTIME_")) {
      throw error;
    }
    throw new Error(options.unsafeCode + " path=" + options.label, { cause: error });
  } finally {
    if (directory !== undefined) {
      closeSync(directory);
    }
  }
}

function readRuntimePathEntry(candidate, options) {
  try {
    return lstatSync(candidate, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(options.missingCode + " path=" + options.label, { cause: error });
    }
    throw error;
  }
}

function assertRuntimeOwnedDirectory(identity, rootIdentity, options) {
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || identity.dev !== rootIdentity.dev || identity.uid !== rootIdentity.uid) {
    throw new Error(options.unsafeCode + " path=" + options.label);
  }
}

function openRuntimeDirectoryEntry(candidate, identity, options) {
  const descriptor = openSync(
    candidate,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    assertRuntimeIdentity(
      identity,
      fstatSync(descriptor, { bigint: true }),
      options.unsafeCode + " path=" + options.label,
    );
    assertRuntimeIdentity(
      identity,
      lstatSync(candidate, { bigint: true }),
      options.unsafeCode + " path=" + options.label,
    );
    registerCustodyDescriptor(descriptor, realpathSync(candidate), identity);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertRuntimeOwnedFile(identity, rootIdentity, options) {
  const executableUnsafe = options.executable === true && (identity.mode & 0o111n) === 0n;
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1n
    || identity.dev !== rootIdentity.dev || identity.uid !== rootIdentity.uid
    || identity.size < 0n || identity.size > BigInt(options.maxBytes) || executableUnsafe) {
    throw new Error(options.unsafeCode + " path=" + options.label);
  }
}

function openRuntimeFileEntry(candidate, identity, options) {
  const descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertRuntimeIdentity(
      identity,
      fstatSync(descriptor, { bigint: true }),
      options.unsafeCode + " path=" + options.label,
    );
    return { descriptor, identity, maxBytes: options.maxBytes };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readRuntimeFile(file, unsafeCode, { captureBytes = false } = {}) {
  const length = Number(file.identity.size);
  if (!Number.isSafeInteger(length) || length < 0 || length > file.maxBytes) {
    throw new Error(unsafeCode + " size=" + String(file.identity.size));
  }
  const hash = createHash("sha256");
  const chunks = captureBytes ? [] : undefined;
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < length) {
    const count = readSync(
      file.descriptor,
      buffer,
      0,
      Math.min(buffer.length, length - offset),
      offset,
    );
    if (count === 0) {
      throw new Error(unsafeCode + " reason=short-read");
    }
    const chunk = Buffer.from(buffer.subarray(0, count));
    chunks?.push(chunk);
    hash.update(chunk);
    offset += count;
  }
  const after = fstatSync(file.descriptor, { bigint: true });
  assertRuntimeIdentity(file.identity, after, unsafeCode + " reason=identity-changed");
  if (after.size !== file.identity.size || after.mtimeNs !== file.identity.mtimeNs
    || after.ctimeNs !== file.identity.ctimeNs) {
    throw new Error(unsafeCode + " reason=content-changed");
  }
  return {
    bytes: captureBytes ? Buffer.concat(chunks, length) : undefined,
    sha256: hash.digest("hex"),
  };
}

function parseRuntimeJson(bytes, code) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(code + " reason=utf8");
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("object-required");
    }
    return value;
  } catch (error) {
    throw new Error(code, { cause: error });
  }
}

function assertRuntimeIdentity(expected, actual, code) {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino
    || expected.mode !== actual.mode || expected.uid !== actual.uid || expected.gid !== actual.gid
    || expected.isDirectory() !== actual.isDirectory()
    || expected.isFile() !== actual.isFile()
    || expected.isSymbolicLink() !== actual.isSymbolicLink()) {
    throw new Error(code);
  }
}
