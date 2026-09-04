import {
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";

import {
  collectCustodyDescriptorCloseFailure,
  custodyDescriptorDirectory,
  useCustodyDescriptor,
} from "./custody.mjs";
import { throwDescriptorCloseFailures } from "./descriptor-close.mjs";
import {
  assertRuntimeExecutablePath,
  assertSupportedRuntimePlatform,
} from "./node-runtime-authority.mjs";
import { validateRuntimeNodeLock } from "./node-runtime-lock.mjs";
import {
  assertRuntimeIdentity,
  openRuntimeRegularFile,
  openRuntimeRoot,
  readRuntimeFile,
} from "./node-runtime-files.mjs";
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
const RUNTIME_CLOSE_FAILURE = "ROLLBACK_RUNTIME_FINALIZATION_FAILED";

export function assertPinnedNodeRuntime(root) {
  const platform = platformId();
  assertSupportedRuntimePlatform(platform);
  const runtimeRoot = openRuntimeRoot(root);
  let executable;
  let prepared;
  let result;
  let primaryFailure;
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
    result = {
      platform,
      version: process.version,
      executable: expected.executablePath,
      artifactSha256: expected.artifact.sha256,
      executableSha256: expected.executableSha256,
    };
  } catch (error) {
    primaryFailure = error;
  }
  const descriptors = [executable?.descriptor, runtimeRoot.descriptor];
  executable = undefined;
  runtimeRoot.descriptor = undefined;
  const failures = [];
  for (const descriptor of descriptors) { collectCustodyDescriptorCloseFailure(descriptor, failures); }
  const closingPayload = prepared;
  prepared = undefined;
  if (closingPayload !== undefined) {
    try { cleanupPreparedPayload(closingPayload); } catch (error) { failures.push(error); }
  }
  throwDescriptorCloseFailures(failures, RUNTIME_CLOSE_FAILURE, primaryFailure);
  return result;
}

function loadRuntimeExpectations(root, runtimeRoot, platform) {
  const lockFile = openRuntimeRegularFile(runtimeRoot, ["tooling", "toolchain.lock.json"], {
    label: "tooling/toolchain.lock.json",
    missingCode: "ROLLBACK_RUNTIME_LOCK_MISSING",
    unsafeCode: "ROLLBACK_RUNTIME_LOCK_UNSAFE",
    maxBytes: RUNTIME_LOCK_MAX_BYTES,
  });
  const lockBytes = useCustodyDescriptor(lockFile.descriptor, RUNTIME_CLOSE_FAILURE,
    () => readRuntimeFile(
      lockFile,
      "ROLLBACK_RUNTIME_LOCK_UNSAFE",
      { captureBytes: true },
    ).bytes);
  const lock = parseRuntimeJson(lockBytes, "ROLLBACK_RUNTIME_LOCK_INVALID");
  const expected = validateRuntimeNodeLock(lock, platform);
  expected.executablePath = join(root, ".tools", expected.artifact.installDirectory, "bin", "node");
  assertRuntimeExecutablePath(expected.node, expected.executablePath);
  return expected;
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
  const archive = useCustodyDescriptor(archiveFile.descriptor, RUNTIME_CLOSE_FAILURE,
    () => readRuntimeFile(archiveFile, "ROLLBACK_RUNTIME_ARCHIVE_UNSAFE"));
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
  const actualBytes = useCustodyDescriptor(provenanceEntry.descriptor, RUNTIME_CLOSE_FAILURE,
    () => readRuntimeFile(
      provenanceEntry,
      "ROLLBACK_RUNTIME_PROVENANCE_UNSAFE",
      { captureBytes: true },
    ).bytes);
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
  useCustodyDescriptor(openProcExecutable(), RUNTIME_CLOSE_FAILURE, (loadedDescriptor) => {
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
  });
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
  useCustodyDescriptor(finalExecutable.descriptor, RUNTIME_CLOSE_FAILURE, () => {
    assertRuntimeIdentity(
      executable.identity,
      finalExecutable.identity,
      "ROLLBACK_RUNTIME_BINARY_IDENTITY_CHANGED",
    );
  });
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
