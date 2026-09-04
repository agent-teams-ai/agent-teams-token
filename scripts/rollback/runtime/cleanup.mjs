import { cleanupRemovalResult, cleanupSnapshotSha256 } from "./cleanup-evidence.mjs";
import {
  fstatSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  closeDescriptorOnce,
  throwDescriptorCloseFailures,
} from "./descriptor-close.mjs";
import {
  assertCleanupDestinationAbsent,
  assertCleanupStrictFingerprint,
  assertCleanupTreeSnapshot,
  assertDirectoryIdentity,
  boundary,
  cleanupStrictIdentityFingerprint,
  createCleanupQuarantine,
  createStagingDirectory,
  openDirectoryDescriptor,
  preflightCleanupTree,
  removeQuarantinedEntry,
  sortedDirectoryEntries,
} from "./cleanup-tree.mjs";
import {
  assertCustodyCanonicalSpelling,
  assertCustodyDescriptor,
  assertCustodyDirectChild,
  custodyDescriptorChild as descriptorChild,
  custodyDescriptorDirectory,
  forgetCustodyDescriptor,
  updateCustodyDescriptor,
} from "./custody.mjs";

const CLEANUP_MAX_ALLOWED_ENTRIES = 2;
const CLEANUP_MAX_DEPTH = 128;
const CLEANUP_MAX_ENTRIES = 1_000_000;
const CLEANUP_MAX_RELATIVE_BYTES = 16_384;
const CLEANUP_MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/u;
// Every accepted target is an exact production mkdtemp namespace.
const CLEANUP_TARGET_PREFIX_ALLOWLIST = new Set([
  ".bootstrap-node-part.",
  ".install-backup-",
  ".install-failed-",
  ".install-part-",
  "agtmai-rollback-local-solana-",
  "agtmai-rollback-deployment-plan-",
  "agtmai-rollback-slither-",
  "agtmai-rollback-hashes-local-solana-",
  "agtmai-rollback-hashes-deployment-plan-",
  "agtmai-rollback-hashes-slither-",
]);
const CLEANUP_ALLOWED_TOP_LEVEL = new Set(["checkout", "gate-tmp", "payload", "wrapper"]);
const cleanupTreeSnapshots = new WeakMap();

export function createCleanupHandle(path, policy) {
  if (!["linux", "darwin"].includes(process.platform) || typeof process.getuid !== "function") {
    throw new Error("ROLLBACK_CLEANUP_PLATFORM_UNSUPPORTED platform=" + process.platform);
  }
  const configuration = cleanupPolicy(path, policy);
  const owner = String(process.getuid());
  let rootDescriptor = openDirectoryDescriptor(configuration.temporaryRoot);
  let descriptor;
  try {
    const rootIdentity = fstatSync(rootDescriptor, { bigint: true });
    assertDirectoryIdentity(
      custodyDescriptorDirectory(rootDescriptor),
      rootIdentity,
      "ROLLBACK_CLEANUP_TEMP_ROOT_IDENTITY_MISMATCH",
    );
    const rootMode = rootIdentity.mode & 0o7777n;
    const ownedPrivateRoot = String(rootIdentity.uid) === owner && (rootMode & 0o022n) === 0n;
    const rootOwnedStickyRoot = rootIdentity.uid === 0n && (rootMode & 0o1000n) !== 0n
      && (rootMode & 0o002n) !== 0n;
    if (!ownedPrivateRoot && !rootOwnedStickyRoot) {
      throw new Error("ROLLBACK_CLEANUP_TEMP_ROOT_AUTHORITY_UNSAFE");
    }
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
    if ((identity.mode & 0o777n) !== 0o700n) {
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
    const failures = [];
    const descriptors = [descriptor, rootDescriptor];
    descriptor = undefined;
    rootDescriptor = undefined;
    for (const openedDescriptor of descriptors) {
      if (!Number.isInteger(openedDescriptor)) {
        continue;
      }
      forgetCustodyDescriptor(openedDescriptor);
      try {
        closeDescriptorOnce(openedDescriptor);
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    throwDescriptorCloseFailures(failures, "ROLLBACK_CLEANUP_CLOSE_FAILED", error);
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
    custodySha256: cleanupSnapshotSha256(snapshot),
    entryCount: state.count,
    limits: {
      maxDepth: CLEANUP_MAX_DEPTH,
      maxEntries: CLEANUP_MAX_ENTRIES,
      maxRelativeBytes: CLEANUP_MAX_RELATIVE_BYTES,
    },
  };
}

export function assertCapturedCleanupTreeSnapshot(handle) {
  validateCleanupHandle(handle);
  const snapshot = cleanupTreeSnapshots.get(handle);
  if (snapshot === undefined) {
    throw new Error("ROLLBACK_CLEANUP_SNAPSHOT_REQUIRED");
  }
  assertHandleIdentities(handle);
  assertCleanupTreeSnapshot(handle.descriptor, snapshot);
  assertHandleIdentities(handle);
  return cleanupSnapshotSha256(snapshot);
}

export function updateCleanupTreeSnapshot(handle, options = {}) {
  validateCleanupHandle(handle);
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !["allowAddedEntries", "allowRemovedEntries"].includes(key))) {
    throw new Error("ROLLBACK_CLEANUP_CUSTODY_UPDATE_INVALID");
  }
  const allowAddedEntries = validateCustodyEntryChanges(options.allowAddedEntries ?? []);
  const allowRemovedEntries = validateCustodyEntryChanges(options.allowRemovedEntries ?? []);
  const previous = cleanupTreeSnapshots.get(handle);
  if (previous === undefined) {
    throw new Error("ROLLBACK_CLEANUP_SNAPSHOT_REQUIRED");
  }
  assertHandleIdentities(handle);
  const state = { count: 0, nextSlot: 0 };
  const next = preflightCleanupTree(handle, state);
  const previousByName = new Map(previous.entries.map((entry) => [entry.name, entry]));
  const nextByName = new Map(next.entries.map((entry) => [entry.name, entry]));
  const added = next.entries.filter((entry) => !previousByName.has(entry.name)).map((entry) => entry.name);
  const removed = previous.entries.filter((entry) => !nextByName.has(entry.name)).map((entry) => entry.name);
  if (JSON.stringify(added.toSorted()) !== JSON.stringify(allowAddedEntries)
    || JSON.stringify(removed.toSorted()) !== JSON.stringify(allowRemovedEntries)) {
    throw new Error("ROLLBACK_CLEANUP_CUSTODY_ENTRY_SET_MISMATCH");
  }
  for (const [name, expected] of previousByName) {
    const actual = nextByName.get(name);
    if (actual !== undefined) {
      assertRetainedCustodyIdentity(expected, actual, name);
    }
  }
  assertHandleIdentities(handle);
  assertCleanupTreeSnapshot(handle.descriptor, next);
  cleanupTreeSnapshots.set(handle, next);
  return {
    schemaVersion: 1,
    result: "updated",
    custodySha256: cleanupSnapshotSha256(next),
    entryCount: state.count,
    addedEntries: added.toSorted(),
    removedEntries: removed.toSorted(),
  };
}

export function cleanupIdentityBoundDirectory(handle, options = {}) {
  validateCleanupHandle(handle);
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => key !== "onBoundary")
    || (options.onBoundary !== undefined && typeof options.onBoundary !== "function")) {
    const primaryFailure = new Error("ROLLBACK_CLEANUP_OPTIONS_INVALID");
    const failures = [];
    closeCleanupHandle(handle, failures);
    throwDescriptorCloseFailures(
      failures, "ROLLBACK_CLEANUP_CLOSE_FAILED", primaryFailure,
    );
  }

  const snapshot = cleanupTreeSnapshots.get(handle);
  if (snapshot === undefined) {
    const primaryFailure = new Error("ROLLBACK_CLEANUP_SNAPSHOT_REQUIRED");
    const failures = [];
    closeCleanupHandle(handle, failures);
    throwDescriptorCloseFailures(
      failures, "ROLLBACK_CLEANUP_CLOSE_FAILED", primaryFailure,
    );
  }
  cleanupTreeSnapshots.delete(handle);

  let quarantine;
  let staging;
  const report = [];
  const state = { count: 0, nextSlot: 0 };
  let result;
  let primaryFailure;
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
    assertCustodyDescriptor(handle.rootDescriptor);
    assertCustodyDescriptor(quarantine.descriptor);
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
    updateCustodyDescriptor(
      handle.descriptor, realpathSync(quarantinedPath), fstatSync(handle.descriptor, { bigint: true }),
    );
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
    assertCustodyDescriptor(quarantine.descriptor);
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
    closeCleanupOwnedDescriptor(handle, "descriptor");

    assertCustodyDescriptor(quarantine.descriptor);
    assertCustodyDescriptor(staging.descriptor);
    assertDirectoryIdentity(
      descriptorChild(quarantine.descriptor, staging.name),
      fstatSync(staging.descriptor, { bigint: true }),
      "ROLLBACK_CLEANUP_STAGING_IDENTITY_MISMATCH",
    );
    rmdirSync(descriptorChild(quarantine.descriptor, staging.name));
    closeCleanupOwnedDescriptor(staging, "descriptor");

    assertCustodyDescriptor(handle.rootDescriptor);
    assertCustodyDescriptor(quarantine.descriptor);
    assertDirectoryIdentity(
      descriptorChild(handle.rootDescriptor, quarantine.name),
      fstatSync(quarantine.descriptor, { bigint: true }),
      "ROLLBACK_CLEANUP_QUARANTINE_IDENTITY_MISMATCH",
    );
    rmdirSync(descriptorChild(handle.rootDescriptor, quarantine.name));
    closeCleanupOwnedDescriptor(quarantine, "descriptor");

    result = cleanupRemovalResult(handle, report, {
      maxDepth: CLEANUP_MAX_DEPTH,
      maxEntries: CLEANUP_MAX_ENTRIES,
      maxRelativeBytes: CLEANUP_MAX_RELATIVE_BYTES,
    });
  } catch (error) {
    if (quarantine !== undefined) {
      const preserved = join(handle.temporaryRoot, quarantine.name);
      primaryFailure = new Error(
        (error instanceof Error ? error.message : String(error))
        + " preservedQuarantine=" + preserved,
        { cause: error },
      );
    } else {
      primaryFailure = error;
    }
  }
  const failures = [];
  closeCleanupOwnedDescriptor(staging, "descriptor", failures);
  closeCleanupOwnedDescriptor(quarantine, "descriptor", failures);
  closeCleanupHandle(handle, failures);
  throwDescriptorCloseFailures(
    failures, "ROLLBACK_CLEANUP_CLOSE_FAILED", primaryFailure,
  );
  return result;
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
  if (!isAbsolute(policy.temporaryRoot) || resolve(policy.temporaryRoot) !== policy.temporaryRoot) {
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
  const requestedTemporaryRoot = resolve(policy.temporaryRoot);
  const canonicalPath = realpathSync(path);
  assertCustodyCanonicalSpelling({
    requestedPath: policy.temporaryRoot,
    canonicalPath: temporaryRoot,
    allowDarwinTemporaryAlias: true,
  });
  if (dirname(path) !== requestedTemporaryRoot) {
    throw new Error("ROLLBACK_CLEANUP_TEMP_ROOT_INVALID path=" + policy.temporaryRoot);
  }
  assertCustodyDirectChild(temporaryRoot, canonicalPath, targetName);
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

function validateCustodyEntryChanges(value) {
  if (!Array.isArray(value) || value.some((entry) =>
    typeof entry !== "string" || !CLEANUP_ALLOWED_TOP_LEVEL.has(entry))) {
    throw new Error("ROLLBACK_CLEANUP_CUSTODY_UPDATE_INVALID");
  }
  const entries = [...value].toSorted();
  if (new Set(entries).size !== entries.length) {
    throw new Error("ROLLBACK_CLEANUP_CUSTODY_UPDATE_INVALID");
  }
  return entries;
}

function assertRetainedCustodyIdentity(expected, actual, logicalPath) {
  const fields = ["dev", "gid", "ino", "mode", "uid"];
  if (expected.kind !== actual.kind
    || fields.some((field) => String(expected.identity[field]) !== String(actual.identity[field]))) {
    throw new Error("ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=" + logicalPath);
  }
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

function closeCleanupOwnedDescriptor(owner, key, failures) {
  const descriptor = owner?.[key];
  if (!Number.isInteger(descriptor)) {
    return;
  }
  owner[key] = undefined;
  forgetCustodyDescriptor(descriptor);
  try {
    closeDescriptorOnce(descriptor);
  } catch (error) {
    if (failures === undefined) {
      throw error;
    }
    failures.push(error);
  }
}

function closeCleanupHandle(handle, failures) {
  if (handle.closed) {
    return;
  }
  handle.closed = true;
  cleanupTreeSnapshots.delete(handle);
  const collectedFailures = failures ?? [];
  closeCleanupOwnedDescriptor(handle, "descriptor", collectedFailures);
  closeCleanupOwnedDescriptor(handle, "rootDescriptor", collectedFailures);
  if (failures === undefined) {
    throwDescriptorCloseFailures(
      collectedFailures,
      "ROLLBACK_CLEANUP_CLOSE_FAILED",
    );
  }
}

function assertHandleIdentities(handle) {
  const rootIdentity = fstatSync(handle.rootDescriptor, { bigint: true });
  if (String(rootIdentity.dev) !== handle.rootDevice
    || String(rootIdentity.ino) !== handle.rootInode) {
    throw new Error("ROLLBACK_CLEANUP_TEMP_ROOT_DESCRIPTOR_MISMATCH");
  }
  assertDirectoryIdentity(
    custodyDescriptorDirectory(handle.rootDescriptor),
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
