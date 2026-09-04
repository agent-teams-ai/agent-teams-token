import {
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename } from "node:path";

import {
  assertCustodyDescriptor,
  closeCustodyDescriptors,
  custodyDescriptorChild as descriptorChild,
  custodyDescriptorDirectory,
  registerCustodyDescriptor,
  retainCustodyDescriptor,
  updateCustodyDescriptor,
  useCustodyDescriptor,
} from "./custody.mjs";

const CLEANUP_MAX_DEPTH = 128;
const CLEANUP_MAX_ENTRIES = 1_000_000;
const CLEANUP_MAX_RELATIVE_BYTES = 16_384;

export function preflightCleanupTree(handle, state) {
  const entries = sortedDirectoryEntries(handle.descriptor);
  const unexpected = entries.find((entry) => !handle.allowedEntries.includes(entry));
  if (unexpected !== undefined) {
    throw new Error("ROLLBACK_CLEANUP_PATH_NOT_ALLOWLISTED path=" + unexpected);
  }
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => {
      const identity = lstatDescriptorChild(handle.descriptor, entry);
      if (entry !== "payload" && !identity.isDirectory()) {
        throw new Error("ROLLBACK_CLEANUP_TOP_LEVEL_TYPE_UNSAFE path=" + entry);
      }
      return preflightEntry(handle.descriptor, entry, entry, 1, {
        rootDevice: handle.device,
        owner: handle.owner,
        state,
      });
    })),
  });
}

function preflightEntry(parentDescriptor, name, logicalPath, depth, context) {
  const { rootDevice, owner, state } = context;
  countCleanupEntry(logicalPath, depth, state);
  const sourcePath = descriptorChild(parentDescriptor, name);
  const identity = lstatSync(sourcePath, { bigint: true });
  const kind = cleanupEntryKind(identity, logicalPath);
  if (kind !== "symlink" && String(identity.dev) !== rootDevice) {
    throw new Error("ROLLBACK_CLEANUP_CROSS_DEVICE_ENTRY path=" + logicalPath);
  }
  if (kind === "file" && identity.nlink !== 1n) {
    throw new Error("ROLLBACK_CLEANUP_FILE_NLINK_UNSAFE path=" + logicalPath);
  }
  if (String(identity.uid) !== owner) {
    throw new Error("ROLLBACK_CLEANUP_ENTRY_OWNER_UNSAFE path=" + logicalPath);
  }
  const fingerprint = cleanupStrictIdentityFingerprint(identity, kind, sourcePath);
  if (kind !== "directory") {
    return Object.freeze({
      name,
      identity,
      fingerprint,
      kind,
      children: Object.freeze([]),
    });
  }
  const descriptor = openDirectoryDescriptor(sourcePath);
  return useCustodyDescriptor(
    descriptor,
    "ROLLBACK_CLEANUP_TRAVERSAL_CLOSE_FAILED",
    () => {
    assertSameIdentity(identity, fstatSync(descriptor, { bigint: true }), logicalPath);
    return Object.freeze({
      name,
      identity,
      fingerprint,
      kind,
      children: Object.freeze(sortedDirectoryEntries(descriptor).map((child) =>
        preflightEntry(descriptor, child, logicalPath + "/" + child, depth + 1, context))),
    });
    },
  );
}

export function assertCleanupTreeSnapshot(rootDescriptor, snapshot) {
  assertSnapshotDirectoryEntries(rootDescriptor, snapshot.entries, ".");
  for (const entry of snapshot.entries) {
    assertCleanupEntrySnapshot(rootDescriptor, entry, entry.name);
  }
}

function assertCleanupEntrySnapshot(parentDescriptor, expected, logicalPath) {
  const sourcePath = descriptorChild(parentDescriptor, expected.name);
  assertCleanupStrictFingerprint(expected.fingerprint, sourcePath, logicalPath);
  if (expected.kind !== "directory") {
    return;
  }
  const descriptor = openDirectoryDescriptor(sourcePath);
  return useCustodyDescriptor(
    descriptor,
    "ROLLBACK_CLEANUP_TRAVERSAL_CLOSE_FAILED",
    () => {
      assertSameIdentity(expected.identity, fstatSync(descriptor, { bigint: true }), logicalPath);
      assertSnapshotDirectoryEntries(descriptor, expected.children, logicalPath);
      for (const child of expected.children) {
        assertCleanupEntrySnapshot(descriptor, child, logicalPath + "/" + child.name);
      }
    },
  );
}

function assertSnapshotDirectoryEntries(descriptor, expected, logicalPath) {
  const actual = sortedDirectoryEntries(descriptor);
  const names = expected.map(({ name }) => name);
  if (actual.length !== names.length || actual.some((name, index) => name !== names[index])) {
    throw new Error("ROLLBACK_CLEANUP_ENTRY_SET_MISMATCH path=" + logicalPath);
  }
}

export function removeQuarantinedEntry({
  parentDescriptor,
  expected,
  logicalPath,
  depth,
  staging,
  rootDevice,
  owner,
  state,
  report,
  options,
}) {
  countCleanupEntry(logicalPath, depth, state);
  const { name } = expected;
  const sourcePath = descriptorChild(parentDescriptor, name);
  const before = assertCleanupStrictFingerprint(expected.fingerprint, sourcePath, logicalPath);
  const kind = cleanupEntryKind(before, logicalPath);
  if (kind !== expected.kind) {
    throw new Error("ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=" + logicalPath);
  }
  if (kind !== "symlink" && String(before.dev) !== rootDevice) {
    throw new Error("ROLLBACK_CLEANUP_CROSS_DEVICE_ENTRY path=" + logicalPath);
  }
  if (kind === "file" && before.nlink !== 1n) {
    throw new Error("ROLLBACK_CLEANUP_FILE_NLINK_UNSAFE path=" + logicalPath);
  }
  if (String(before.uid) !== owner) {
    throw new Error("ROLLBACK_CLEANUP_ENTRY_OWNER_UNSAFE path=" + logicalPath);
  }
  let heldDescriptor;
  if (kind === "directory") {
    heldDescriptor = openDirectoryDescriptor(sourcePath);
  } else if (kind === "file") {
    heldDescriptor = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  }
  let primaryFailure;
  try {
    if (heldDescriptor !== undefined) {
      assertSameIdentity(before, fstatSync(heldDescriptor, { bigint: true }), logicalPath);
    }
    state.nextSlot += 1;
    const slot = "entry-" + String(state.nextSlot).padStart(7, "0");
    const stagedPath = descriptorChild(staging.descriptor, slot);
    boundary(options, "before-entry-quarantine", {
      path: logicalPath,
      kind,
      sourcePath,
      stagedPath,
    });
    assertCustodyDescriptor(parentDescriptor);
    assertCustodyDescriptor(staging.descriptor);
    const atQuarantineBoundary = assertCleanupStrictFingerprint(
      expected.fingerprint,
      sourcePath,
      logicalPath,
    );
    if (heldDescriptor !== undefined) {
      assertSameIdentity(
        atQuarantineBoundary,
        fstatSync(heldDescriptor, { bigint: true }),
        logicalPath,
      );
    }
    assertCleanupDestinationAbsent(
      stagedPath,
      "ROLLBACK_CLEANUP_ENTRY_DESTINATION_SUBSTITUTED path=" + logicalPath,
    );
    renameSync(sourcePath, stagedPath);
    const stagedIdentity = lstatSync(stagedPath, { bigint: true });
    if (kind === "directory") {
      updateCustodyDescriptor(heldDescriptor, realpathSync(stagedPath), stagedIdentity);
    }
    assertSameIdentity(before, stagedIdentity, logicalPath);
    if (heldDescriptor !== undefined) {
      assertSameIdentity(stagedIdentity, fstatSync(heldDescriptor, { bigint: true }), logicalPath);
    }
    let stagedFingerprint = cleanupStrictIdentityFingerprint(
      stagedIdentity,
      kind,
      stagedPath,
    );

    if (kind === "directory") {
      assertSnapshotDirectoryEntries(heldDescriptor, expected.children, logicalPath);
      for (const child of expected.children) {
        removeQuarantinedEntry({
          parentDescriptor: heldDescriptor,
          expected: child,
          logicalPath: logicalPath + "/" + child.name,
          depth: depth + 1,
          staging,
          rootDevice,
          owner,
          state,
          report,
          options,
        });
      }
      stagedFingerprint = cleanupStrictIdentityFingerprint(
        lstatSync(stagedPath, { bigint: true }),
        kind,
        stagedPath,
      );
      boundary(options, "before-entry-delete", { path: logicalPath, kind, stagedPath });
      assertCustodyDescriptor(staging.descriptor);
      assertCleanupStrictFingerprint(stagedFingerprint, stagedPath, logicalPath);
      assertDirectoryIdentity(
        stagedPath,
        fstatSync(heldDescriptor, { bigint: true }),
        "ROLLBACK_CLEANUP_ENTRY_SUBSTITUTED_AT_DELETE path=" + logicalPath,
      );
      rmdirSync(stagedPath);
    } else {
      boundary(options, "before-entry-delete", { path: logicalPath, kind, stagedPath });
      assertCustodyDescriptor(staging.descriptor);
      const atBoundary = assertCleanupStrictFingerprint(
        stagedFingerprint,
        stagedPath,
        logicalPath,
      );
      assertSameIdentity(stagedIdentity, atBoundary, logicalPath);
      if (heldDescriptor !== undefined) {
        assertSameIdentity(atBoundary, fstatSync(heldDescriptor, { bigint: true }), logicalPath);
      }
      unlinkSync(stagedPath);
      if (heldDescriptor !== undefined) {
        const unlinked = fstatSync(heldDescriptor, { bigint: true });
        assertSameIdentity(stagedIdentity, unlinked, logicalPath);
        if (unlinked.nlink !== 0n) {
          throw new Error("ROLLBACK_CLEANUP_UNLINK_TRANSITION_UNSAFE path=" + logicalPath);
        }
      }
    }
    report.push({ path: logicalPath, kind });
  } catch (error) {
    primaryFailure = error;
  }
  const closing = heldDescriptor;
  heldDescriptor = undefined;
  closeCustodyDescriptors(
    [closing],
    "ROLLBACK_CLEANUP_ENTRY_CLOSE_FAILED",
    primaryFailure,
  );
}

export function createCleanupQuarantine(handle) {
  const created = mkdtempSync(descriptorChild(handle.rootDescriptor, ".agtmai-rollback-cleanup-"));
  const name = basename(created);
  const descriptor = retainCustodyDescriptor(
    openDirectoryDescriptor(descriptorChild(handle.rootDescriptor, name)),
    "ROLLBACK_CLEANUP_QUARANTINE_CLOSE_FAILED",
    (held) => {
      const identity = fstatSync(held, { bigint: true });
      assertDirectoryIdentity(
        descriptorChild(handle.rootDescriptor, name),
        identity,
        "ROLLBACK_CLEANUP_QUARANTINE_IDENTITY_MISMATCH",
      );
      if ((identity.mode & 0o777n) !== 0o700n) {
        throw new Error("ROLLBACK_CLEANUP_QUARANTINE_PERMISSIONS_UNSAFE");
      }
      if (String(identity.uid) !== String(process.getuid())) {
        throw new Error("ROLLBACK_CLEANUP_QUARANTINE_OWNER_UNSAFE");
      }
    },
  );
  return { name, descriptor };
}

export function createStagingDirectory(quarantineDescriptor) {
  const name = "entries";
  mkdirSync(descriptorChild(quarantineDescriptor, name), { mode: 0o700 });
  const descriptor = retainCustodyDescriptor(
    openDirectoryDescriptor(descriptorChild(quarantineDescriptor, name)),
    "ROLLBACK_CLEANUP_STAGING_CLOSE_FAILED",
    (held) => {
      const identity = fstatSync(held, { bigint: true });
      assertDirectoryIdentity(
        descriptorChild(quarantineDescriptor, name),
        identity,
        "ROLLBACK_CLEANUP_STAGING_IDENTITY_MISMATCH",
      );
      if ((identity.mode & 0o777n) !== 0o700n
        || String(identity.uid) !== String(process.getuid())) {
        throw new Error("ROLLBACK_CLEANUP_STAGING_PERMISSIONS_UNSAFE");
      }
    },
  );
  return { name, descriptor };
}

function countCleanupEntry(logicalPath, depth, state) {
  state.count += 1;
  if (state.count > CLEANUP_MAX_ENTRIES) {
    throw new Error("ROLLBACK_CLEANUP_ENTRY_LIMIT_EXCEEDED");
  }
  if (depth > CLEANUP_MAX_DEPTH) {
    throw new Error("ROLLBACK_CLEANUP_DEPTH_LIMIT_EXCEEDED path=" + logicalPath);
  }
  if (Buffer.byteLength(logicalPath, "utf8") > CLEANUP_MAX_RELATIVE_BYTES) {
    throw new Error("ROLLBACK_CLEANUP_PATH_LIMIT_EXCEEDED");
  }
}

function cleanupEntryKind(identity, logicalPath) {
  if (identity.isDirectory()) {
    return "directory";
  }
  if (identity.isFile()) {
    return "file";
  }
  if (identity.isSymbolicLink()) {
    return "symlink";
  }
  throw new Error("ROLLBACK_CLEANUP_ENTRY_TYPE_UNSAFE path=" + logicalPath);
}

export function sortedDirectoryEntries(descriptor) {
  const directory = opendirSync(custodyDescriptorDirectory(descriptor), { encoding: "buffer" });
  const entries = [];
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) {
        break;
      }
      if (entries.length >= CLEANUP_MAX_ENTRIES) {
        throw new Error("ROLLBACK_CLEANUP_ENTRY_LIMIT_EXCEEDED");
      }
      entries.push(Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, "utf8"));
    }
  } finally {
    directory.closeSync();
  }
  entries.sort(Buffer.compare);
  return entries.map((bytes) => {
    const entry = bytes.toString("utf8");
    if (!Buffer.from(entry, "utf8").equals(bytes) || entry === "." || entry === ".."
      || entry.includes("/") || entry.includes("\0") || bytes.length > 255) {
      throw new Error("ROLLBACK_CLEANUP_ENTRY_NAME_INVALID");
    }
    return entry;
  });
}

export function openDirectoryDescriptor(path) {
  return retainCustodyDescriptor(
    openSync(
      path,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    ),
    "ROLLBACK_CLEANUP_ACQUISITION_CLOSE_FAILED",
    (descriptor) => {
      const identity = fstatSync(descriptor, { bigint: true });
      if (!identity.isDirectory()) {
        throw new Error("ROLLBACK_CLEANUP_NOT_DIRECTORY path=" + path);
      }
      registerCustodyDescriptor(descriptor, realpathSync(path), identity);
    },
  );
}

function lstatDescriptorChild(descriptor, name) {
  return lstatSync(descriptorChild(descriptor, name), { bigint: true });
}

export function assertDirectoryIdentity(path, expected, message) {
  let actual;
  try {
    actual = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  if (!actual.isDirectory() || actual.isSymbolicLink()) {
    throw new Error(message);
  }
  assertSameIdentity(expected, actual, path, message);
}

export function assertCleanupDestinationAbsent(path, message) {
  try {
    lstatSync(path, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw new Error(message, { cause: error });
  }
  throw new Error(message);
}

const CLEANUP_STRICT_IDENTITY_FIELDS = Object.freeze([
  "birthtimeNs",
  "ctimeNs",
  "dev",
  "gid",
  "ino",
  "mode",
  "mtimeNs",
  "nlink",
  "size",
  "uid",
]);

export function cleanupStrictIdentityFingerprint(identity, kind, path) {
  const fingerprint = { kind };
  for (const field of CLEANUP_STRICT_IDENTITY_FIELDS) {
    fingerprint[field] = String(identity[field]);
  }
  if (kind === "symlink") {
    const first = readlinkSync(path, { encoding: "buffer" });
    const repeatedIdentity = lstatSync(path, { bigint: true });
    const second = readlinkSync(path, { encoding: "buffer" });
    if (!first.equals(second) || CLEANUP_STRICT_IDENTITY_FIELDS.some(
      (field) => identity[field] !== repeatedIdentity[field],
    ) || !repeatedIdentity.isSymbolicLink()) {
      throw new Error("ROLLBACK_CLEANUP_SYMLINK_CHANGED");
    }
    fingerprint.linkTargetBase64 = first.toString("base64");
  } else {
    fingerprint.linkTargetBase64 = null;
  }
  return Object.freeze(fingerprint);
}

export function assertCleanupStrictFingerprint(expected, path, logicalPath, message) {
  let actualIdentity;
  let actual;
  try {
    actualIdentity = lstatSync(path, { bigint: true });
    const kind = cleanupEntryKind(actualIdentity, logicalPath);
    actual = cleanupStrictIdentityFingerprint(actualIdentity, kind, path);
  } catch (error) {
    throw new Error(
      message ?? "ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=" + logicalPath,
      { cause: error },
    );
  }
  const fields = ["kind", ...CLEANUP_STRICT_IDENTITY_FIELDS, "linkTargetBase64"];
  if (fields.some((field) => actual[field] !== expected[field])) {
    throw new Error(message ?? "ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=" + logicalPath);
  }
  return actualIdentity;
}

export function assertSameIdentity(expected, actual, logicalPath, message) {
  if (String(actual.dev) !== String(expected.dev) || String(actual.ino) !== String(expected.ino)
    || actual.isDirectory() !== expected.isDirectory()
    || actual.isFile() !== expected.isFile()
    || actual.isSymbolicLink() !== expected.isSymbolicLink()) {
    throw new Error(message ?? "ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH path=" + logicalPath);
  }
}

export function boundary(options, stage, detail) {
  options.onBoundary?.({ stage, ...detail });
}

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
