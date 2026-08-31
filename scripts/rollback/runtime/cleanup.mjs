import {
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  assertCleanupDestinationAbsent,
  assertCleanupStrictFingerprint,
  assertCleanupTreeSnapshot,
  assertDirectoryIdentity,
  boundary,
  cleanupStrictIdentityFingerprint,
  compareUtf8,
  createCleanupQuarantine,
  createStagingDirectory,
  descriptorChild,
  openDirectoryDescriptor,
  preflightCleanupTree,
  removeQuarantinedEntry,
  sortedDirectoryEntries,
} from "./cleanup-tree.mjs";

const CLEANUP_MAX_ALLOWED_ENTRIES = 2;
const CLEANUP_MAX_DEPTH = 128;
const CLEANUP_MAX_ENTRIES = 1_000_000;
const CLEANUP_MAX_RELATIVE_BYTES = 16_384;
const CLEANUP_MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/u;
// Every accepted target is an exact production mkdtemp namespace.
const CLEANUP_TARGET_PREFIX_ALLOWLIST = new Set([
  "agtmai-rollback-local-solana-",
  "agtmai-rollback-deployment-plan-",
  "agtmai-rollback-slither-",
  "agtmai-rollback-hashes-local-solana-",
  "agtmai-rollback-hashes-deployment-plan-",
  "agtmai-rollback-hashes-slither-",
]);
const CLEANUP_ALLOWED_TOP_LEVEL = new Set(["checkout", "gate-tmp"]);
const cleanupTreeSnapshots = new WeakMap();

export function createCleanupHandle(path, policy) {
  if (!["linux", "darwin"].includes(process.platform) || typeof process.getuid !== "function") {
    throw new Error("ROLLBACK_CLEANUP_PLATFORM_UNSUPPORTED platform=" + process.platform);
  }
  const configuration = cleanupPolicy(path, policy);
  const owner = String(process.getuid());
  const rootDescriptor = openDirectoryDescriptor(configuration.temporaryRoot);
  let descriptor;
  try {
    const rootIdentity = fstatSync(rootDescriptor, { bigint: true });
    assertDirectoryIdentity(
      descriptorChild(rootDescriptor, "."),
      rootIdentity,
      "ROLLBACK_CLEANUP_TEMP_ROOT_IDENTITY_MISMATCH",
    );
    descriptor = openDirectoryDescriptor(descriptorChild(rootDescriptor, configuration.targetName));
    const identity = fstatSync(descriptor, { bigint: true });
    assertDirectoryIdentity(
      descriptorChild(rootDescriptor, configuration.targetName),
      identity,
      "ROLLBACK_CLEANUP_IDENTITY_MISMATCH",
    );
    if (String(identity.dev) !== String(rootIdentity.dev)) {
      throw new Error("ROLLBACK_CLEANUP_TARGET_CROSS_DEVICE path=" + path);
    }
    if (String(identity.uid) !== owner) {
      throw new Error("ROLLBACK_CLEANUP_TARGET_OWNER_UNSAFE path=" + path);
    }
    if ((identity.mode & 0o077n) !== 0n) {
      throw new Error("ROLLBACK_CLEANUP_TARGET_PERMISSIONS_UNSAFE path=" + path);
    }
    return {
      path,
      temporaryRoot: configuration.temporaryRoot,
      targetName: configuration.targetName,
      targetPrefix: configuration.targetPrefix,
      allowedEntries: configuration.allowedEntries,
      rootDescriptor,
      rootDevice: String(rootIdentity.dev),
      rootInode: String(rootIdentity.ino),
      descriptor,
      device: String(identity.dev),
      inode: String(identity.ino),
      owner,
      closed: false,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    closeSync(rootDescriptor);
    throw error;
  }
}

export function captureCleanupTreeSnapshot(handle) {
  validateCleanupHandle(handle);
  if (cleanupTreeSnapshots.has(handle)) {
    throw new Error("ROLLBACK_CLEANUP_SNAPSHOT_ALREADY_CAPTURED");
  }
  assertHandleIdentities(handle);
  const state = { count: 0, nextSlot: 0 };
  const snapshot = preflightCleanupTree(handle, state);
  assertHandleIdentities(handle);
  assertCleanupTreeSnapshot(handle.descriptor, snapshot);
  cleanupTreeSnapshots.set(handle, snapshot);
  return {
    schemaVersion: 1,
    result: "captured",
    entryCount: state.count,
    limits: {
      maxDepth: CLEANUP_MAX_DEPTH,
      maxEntries: CLEANUP_MAX_ENTRIES,
      maxRelativeBytes: CLEANUP_MAX_RELATIVE_BYTES,
    },
  };
}

export function cleanupIdentityBoundDirectory(handle, options = {}) {
  validateCleanupHandle(handle);
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => key !== "onBoundary")
    || (options.onBoundary !== undefined && typeof options.onBoundary !== "function")) {
    closeCleanupHandle(handle);
    throw new Error("ROLLBACK_CLEANUP_OPTIONS_INVALID");
  }

  const snapshot = cleanupTreeSnapshots.get(handle);
  if (snapshot === undefined) {
    closeCleanupHandle(handle);
    throw new Error("ROLLBACK_CLEANUP_SNAPSHOT_REQUIRED");
  }
  cleanupTreeSnapshots.delete(handle);

  let quarantine;
  let staging;
  const report = [];
  const state = { count: 0, nextSlot: 0 };
  try {
    assertHandleIdentities(handle);
    assertCleanupTreeSnapshot(handle.descriptor, snapshot);

    quarantine = createCleanupQuarantine(handle);
    const quarantineTargetName = "tree";
    const sourcePath = descriptorChild(handle.rootDescriptor, handle.targetName);
    const quarantinedPath = descriptorChild(quarantine.descriptor, quarantineTargetName);
    boundary(options, "before-target-quarantine", {
      targetName: handle.targetName,
      sourcePath,
      quarantinedPath,
    });
    assertDirectoryIdentity(
      sourcePath,
      fstatSync(handle.descriptor, { bigint: true }),
      "ROLLBACK_CLEANUP_TARGET_SUBSTITUTED_AT_QUARANTINE",
    );
    assertCleanupDestinationAbsent(
      quarantinedPath,
      "ROLLBACK_CLEANUP_TARGET_DESTINATION_SUBSTITUTED",
    );
    renameSync(sourcePath, quarantinedPath);
    assertDirectoryIdentity(
      quarantinedPath,
      fstatSync(handle.descriptor, { bigint: true }),
      "ROLLBACK_CLEANUP_TARGET_SUBSTITUTED_AT_QUARANTINE",
    );
    assertCleanupTreeSnapshot(handle.descriptor, snapshot);

    staging = createStagingDirectory(quarantine.descriptor);
    for (const entry of snapshot.entries) {
      removeQuarantinedEntry({
        parentDescriptor: handle.descriptor,
        expected: entry,
        logicalPath: entry.name,
        depth: 1,
        staging,
        rootDevice: handle.device,
        owner: handle.owner,
        state,
        report,
        options,
      });
    }

    if (sortedDirectoryEntries(handle.descriptor).length !== 0) {
      throw new Error("ROLLBACK_CLEANUP_TARGET_NOT_EMPTY_AT_BOUNDARY");
    }
    const targetDeleteFingerprint = cleanupStrictIdentityFingerprint(
      lstatSync(quarantinedPath, { bigint: true }),
      "directory",
      quarantinedPath,
    );
    boundary(options, "before-target-delete", {
      targetName: handle.targetName,
      quarantinedPath,
    });
    assertCleanupStrictFingerprint(
      targetDeleteFingerprint,
      quarantinedPath,
      handle.targetName,
      "ROLLBACK_CLEANUP_TARGET_SUBSTITUTED_AT_DELETE",
    );
    assertDirectoryIdentity(
      quarantinedPath,
      fstatSync(handle.descriptor, { bigint: true }),
      "ROLLBACK_CLEANUP_TARGET_SUBSTITUTED_AT_DELETE",
    );
    rmdirSync(quarantinedPath);
    closeSync(handle.descriptor);
    handle.descriptor = undefined;

    assertDirectoryIdentity(
      descriptorChild(quarantine.descriptor, staging.name),
      fstatSync(staging.descriptor, { bigint: true }),
      "ROLLBACK_CLEANUP_STAGING_IDENTITY_MISMATCH",
    );
    rmdirSync(descriptorChild(quarantine.descriptor, staging.name));
    closeSync(staging.descriptor);
    staging.descriptor = undefined;

    assertDirectoryIdentity(
      descriptorChild(handle.rootDescriptor, quarantine.name),
      fstatSync(quarantine.descriptor, { bigint: true }),
      "ROLLBACK_CLEANUP_QUARANTINE_IDENTITY_MISMATCH",
    );
    rmdirSync(descriptorChild(handle.rootDescriptor, quarantine.name));
    closeSync(quarantine.descriptor);
    quarantine.descriptor = undefined;

    report.sort((left, right) => compareUtf8(left.path, right.path));
    return {
      schemaVersion: 2,
      result: "contents-removed",
      device: handle.device,
      inode: handle.inode,
      allowedEntries: [...handle.allowedEntries],
      limits: {
        maxDepth: CLEANUP_MAX_DEPTH,
        maxEntries: CLEANUP_MAX_ENTRIES,
        maxRelativeBytes: CLEANUP_MAX_RELATIVE_BYTES,
      },
      removedEntryCount: report.length,
      removedEntries: report,
    };
  } catch (error) {
    if (quarantine !== undefined) {
      const preserved = join(handle.temporaryRoot, quarantine.name);
      throw new Error(
        (error instanceof Error ? error.message : String(error))
        + " preservedQuarantine=" + preserved,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (staging?.descriptor !== undefined) {
      closeSync(staging.descriptor);
    }
    if (quarantine?.descriptor !== undefined) {
      closeSync(quarantine.descriptor);
    }
    closeCleanupHandle(handle);
  }
}

export function abandonCleanupHandle(handle) {
  validateCleanupHandle(handle);
  const result = {
    schemaVersion: 1,
    result: "preserved",
    path: handle.path,
    device: handle.device,
    inode: handle.inode,
  };
  closeCleanupHandle(handle);
  return result;
}

function cleanupPolicy(path, policy) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error("ROLLBACK_CLEANUP_PATH_INVALID path=" + String(path));
  }
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)
    || JSON.stringify(Object.keys(policy).toSorted())
      !== JSON.stringify(["allowedEntries", "targetPrefix", "temporaryRoot"])) {
    throw new Error("ROLLBACK_CLEANUP_POLICY_INVALID");
  }
  if (typeof policy.temporaryRoot !== "string" || typeof policy.targetPrefix !== "string") {
    throw new Error("ROLLBACK_CLEANUP_POLICY_INVALID");
  }
  const temporaryRoot = realpathSync(policy.temporaryRoot);
  if (!isAbsolute(policy.temporaryRoot) || temporaryRoot !== resolve(policy.temporaryRoot)
    || dirname(path) !== temporaryRoot) {
    throw new Error("ROLLBACK_CLEANUP_TEMP_ROOT_INVALID path=" + String(policy.temporaryRoot));
  }
  if (!CLEANUP_TARGET_PREFIX_ALLOWLIST.has(policy.targetPrefix)) {
    throw new Error("ROLLBACK_CLEANUP_PREFIX_NOT_ALLOWLISTED prefix=" + String(policy.targetPrefix));
  }
  const targetName = basename(path);
  const suffix = targetName.slice(policy.targetPrefix.length);
  if (!targetName.startsWith(policy.targetPrefix) || !CLEANUP_MKDTEMP_SUFFIX.test(suffix)) {
    throw new Error("ROLLBACK_CLEANUP_TARGET_NAME_INVALID name=" + targetName);
  }
  const allowedEntries = validateAllowedEntries(policy.allowedEntries);
  return {
    temporaryRoot,
    targetName,
    targetPrefix: policy.targetPrefix,
    allowedEntries,
  };
}

function validateAllowedEntries(value) {
  if (!Array.isArray(value) || value.length === 0
    || value.length > CLEANUP_MAX_ALLOWED_ENTRIES
    || value.some((entry) => typeof entry !== "string" || !CLEANUP_ALLOWED_TOP_LEVEL.has(entry))) {
    throw new Error("ROLLBACK_CLEANUP_ALLOWLIST_INVALID");
  }
  const entries = [...value].toSorted();
  if (new Set(entries).size !== entries.length) {
    throw new Error("ROLLBACK_CLEANUP_ALLOWLIST_INVALID");
  }
  return entries;
}

function validateCleanupHandle(handle) {
  if (handle === null || typeof handle !== "object" || handle.closed) {
    throw new Error("ROLLBACK_CLEANUP_HANDLE_CLOSED");
  }
  if (!Number.isInteger(handle.descriptor) || !Number.isInteger(handle.rootDescriptor)
    || typeof handle.targetName !== "string" || typeof handle.temporaryRoot !== "string"
    || !Array.isArray(handle.allowedEntries)) {
    throw new Error("ROLLBACK_CLEANUP_HANDLE_INVALID");
  }
}

function closeCleanupHandle(handle) {
  if (handle.closed) {
    return;
  }
  if (Number.isInteger(handle.descriptor)) {
    closeSync(handle.descriptor);
  }
  if (Number.isInteger(handle.rootDescriptor)) {
    closeSync(handle.rootDescriptor);
  }
  handle.descriptor = undefined;
  handle.rootDescriptor = undefined;
  handle.closed = true;
  cleanupTreeSnapshots.delete(handle);
}

function assertHandleIdentities(handle) {
  const rootIdentity = fstatSync(handle.rootDescriptor, { bigint: true });
  if (String(rootIdentity.dev) !== handle.rootDevice
    || String(rootIdentity.ino) !== handle.rootInode) {
    throw new Error("ROLLBACK_CLEANUP_TEMP_ROOT_DESCRIPTOR_MISMATCH");
  }
  assertDirectoryIdentity(
    descriptorChild(handle.rootDescriptor, "."),
    rootIdentity,
    "ROLLBACK_CLEANUP_TEMP_ROOT_IDENTITY_MISMATCH",
  );
  const targetIdentity = fstatSync(handle.descriptor, { bigint: true });
  if (String(targetIdentity.dev) !== handle.device || String(targetIdentity.ino) !== handle.inode) {
    throw new Error("ROLLBACK_CLEANUP_TARGET_DESCRIPTOR_MISMATCH");
  }
  assertDirectoryIdentity(
    descriptorChild(handle.rootDescriptor, handle.targetName),
    targetIdentity,
    "ROLLBACK_CLEANUP_IDENTITY_MISMATCH",
  );
}
