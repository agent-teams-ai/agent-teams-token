import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  abandonCleanupHandle,
  assertCapturedCleanupTreeSnapshot,
  captureCleanupTreeSnapshot,
  cleanupIdentityBoundDirectory,
  createCleanupHandle,
  updateCleanupTreeSnapshot,
} from "./rollback/runtime/cleanup.mjs";
import {
  assertCustodyIdentity,
  assertCustodyStableObject,
  custodyIdentity,
} from "./rollback/runtime/custody.mjs";

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {return false;}
    throw error;
  }
}

function assertAbsent(path) {
  // lstat also sees dangling symlinks. As in the custody runtime, Node's
  // separate check/rename syscalls do not exclude a continuously racing peer.
  if (entryExists(path)) {
    throw new Error("TOOLCHAIN_PUBLICATION_TARGET_OCCUPIED path=" + path);
  }
}

function createPublicationBackup({ destination, toolsRoot, wrapper }) {
  const entries = [
    entryExists(destination) ? "payload" : undefined,
    wrapper !== undefined && entryExists(wrapper.target) ? "wrapper" : undefined,
  ].filter(Boolean);
  if (entries.length === 0) {
    return;
  }
  const root = mkdtempSync(join(toolsRoot, ".install-backup-"));
  const backup = {
    entries: new Set(),
    handle: createCleanupHandle(root, {
      temporaryRoot: toolsRoot,
      targetPrefix: ".install-backup-",
      allowedEntries: entries,
    }),
    root,
    sources: new Map([
      ...(entries.includes("payload") ? [["payload", destination]] : []),
      ...(entries.includes("wrapper") ? [["wrapper", wrapper.target]] : []),
    ]),
  };
  captureCleanupTreeSnapshot(backup.handle);
  return backup;
}

function backupCurrentEntry(backup, name) {
  const source = backup.sources.get(name);
  if (source === undefined) {
    return;
  }
  const target = join(backup.root, name);
  renameSync(source, target);
  backup.entries.add(name);
  try {
    updateCleanupTreeSnapshot(backup.handle, { allowAddedEntries: [name] });
  } catch (primaryFailure) {
    const failures = [];
    try {
      assertAbsent(source);
      renameSync(target, source);
      backup.entries.delete(name);
      assertCapturedCleanupTreeSnapshot(backup.handle);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...failures],
        "TOOLCHAIN_BACKUP_CUSTODY_TRANSITION_FAILED",
        { cause: primaryFailure },
      );
    }
    throw primaryFailure;
  }
}

function preparedPayloadTransition(prepared, direction) {
  if (prepared.source !== join(prepared.stageRoot, "payload")) {
    return {};
  }
  return direction === "published"
    ? { allowRemovedEntries: ["payload"] }
    : { allowAddedEntries: ["payload"] };
}

function writePublishedWrapper(transaction, onPublishBoundary) {
  const { wrapper } = transaction;
  const bin = dirname(wrapper.target);
  const part = wrapper.target + ".part";
  mkdirSync(bin, { recursive: true });
  let descriptor;
  let identity;
  let primaryFailure;
  const failures = [];
  try {
    descriptor = openSync(part, constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o755);
    identity = custodyIdentity(fstatSync(descriptor, { bigint: true }));
    writeFileSync(descriptor, wrapper.contents);
    fchmodSync(descriptor, 0o755);
    onPublishBoundary?.("before-wrapper-rename", { part, destination: wrapper.target });
    assertCustodyIdentity(fstatSync(descriptor, { bigint: true }),
      lstatSync(part, { bigint: true }), "TOOLCHAIN_WRAPPER_PART_SUBSTITUTED");
    assertAbsent(wrapper.target);
    transaction.wrapperIdentity = custodyIdentity(fstatSync(descriptor, { bigint: true }));
    renameSync(part, wrapper.target);
    transaction.wrapperPublished = true;
    onPublishBoundary?.("after-wrapper-rename", { destination: wrapper.target });
    transaction.wrapperIdentity = custodyIdentity(fstatSync(descriptor, { bigint: true }));
    transaction.wrapperIdentityCaptured = true;
    validatePublishedWrapper(wrapper, transaction.wrapperIdentity);
  } catch (error) {
    primaryFailure = error;
    if (identity !== undefined && !transaction.wrapperPublished) {
      try {
        assertCustodyStableObject(identity, lstatSync(part, { bigint: true }),
          "TOOLCHAIN_WRAPPER_PART_SUBSTITUTED");
        unlinkSync(part);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
  }
  if (descriptor !== undefined) {
    try {closeSync(descriptor);} catch (error) {failures.push(error);}
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure === undefined ? [] : [primaryFailure]), ...failures],
      "TOOLCHAIN_WRAPPER_PUBLICATION_FAILED", { cause: primaryFailure ?? failures[0] },
    );
  }
  if (primaryFailure !== undefined) {throw primaryFailure;}
}

function validatePublishedWrapper(wrapper, identity, pendingRenameCapture = false) {
  // Rename changes ctime. Only the interrupted capture path may use the
  // pre-rename stable identity; normal validation keeps every identity field.
  const assertIdentity = pendingRenameCapture ? assertCustodyStableObject : assertCustodyIdentity;
  assertIdentity(
    identity,
    lstatSync(wrapper.target, { bigint: true }),
    "TOOLCHAIN_WRAPPER_PUBLICATION_SUBSTITUTED",
  );
  if (!readFileSync(wrapper.target).equals(Buffer.from(wrapper.contents))) {
    throw new Error("TOOLCHAIN_WRAPPER_PUBLICATION_SUBSTITUTED");
  }
}

function restoreBackupEntry(backup, name, target) {
  if (!backup?.entries.has(name)) {
    return;
  }
  assertAbsent(target);
  renameSync(join(backup.root, name), target);
  updateCleanupTreeSnapshot(backup.handle, { allowRemovedEntries: [name] });
  backup.entries.delete(name);
}

function rollbackPublication(transaction) {
  const { backup, destination, prepared, wrapper } = transaction;
  if (transaction.committed || backup?.handle.closed) {
    return;
  }
  if (backup !== undefined) {
    assertCapturedCleanupTreeSnapshot(backup.handle);
  }
  if (transaction.wrapperPublished) {
    validatePublishedWrapper(wrapper, transaction.wrapperIdentity,
      !transaction.wrapperIdentityCaptured);
    unlinkSync(wrapper.target);
  }
  restoreBackupEntry(backup, "wrapper", wrapper?.target);
  if (transaction.destinationPublished) {
    assertCustodyStableObject(transaction.destinationIdentity,
      lstatSync(destination, { bigint: true }), "TOOLCHAIN_DESTINATION_SUBSTITUTED");
    transaction.validateDestination();
    assertAbsent(prepared.source);
    renameSync(destination, prepared.source);
    updateCleanupTreeSnapshot(
      prepared.cleanupHandle,
      preparedPayloadTransition(prepared, "restored"),
    );
  }
  restoreBackupEntry(backup, "payload", destination);
  if (backup !== undefined) {
    cleanupIdentityBoundDirectory(backup.handle);
    transaction.backup = undefined;
  }
}

function finishFailedPublication(transaction, primaryFailure) {
  const failures = [];
  try {
    rollbackPublication(transaction);
  } catch (error) {
    failures.push(error);
  }
  if (transaction.backup !== undefined && !transaction.backup.handle.closed) {
    try {
      abandonCleanupHandle(transaction.backup.handle);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...failures],
      "TOOLCHAIN_INSTALL_ROLLBACK_FAILED",
      { cause: primaryFailure },
    );
  }
  throw primaryFailure;
}

export function publishPreparedInstallation({
  destination,
  onPublishBoundary,
  prepared,
  toolsRoot,
  validateDestination,
  wrapper,
}) {
  const transaction = {
    backup: undefined,
    destination,
    destinationPublished: false,
    committed: false,
    destinationIdentity: custodyIdentity(lstatSync(prepared.source, { bigint: true })),
    prepared,
    validateDestination,
    wrapper,
    wrapperIdentity: undefined,
    wrapperIdentityCaptured: false,
    wrapperPublished: false,
  };
  try {
    transaction.backup = createPublicationBackup({ destination, toolsRoot, wrapper });
    if (transaction.backup !== undefined) {
      backupCurrentEntry(transaction.backup, "payload");
      backupCurrentEntry(transaction.backup, "wrapper");
      onPublishBoundary?.("after-backup", {
        backup: transaction.backup.root,
        destination,
      });
    }
    assertAbsent(destination);
    renameSync(prepared.source, destination);
    transaction.destinationPublished = true;
    updateCleanupTreeSnapshot(
      prepared.cleanupHandle,
      preparedPayloadTransition(prepared, "published"),
    );
    onPublishBoundary?.("after-destination-publish", {
      backup: transaction.backup?.root,
      destination,
    });
    if (wrapper !== undefined) {
      writePublishedWrapper(transaction, onPublishBoundary);
    }
    if (transaction.backup !== undefined) {
      onPublishBoundary?.("before-backup-cleanup", {
        backup: transaction.backup.root,
        destination,
      });
    }
    assertCustodyStableObject(transaction.destinationIdentity,
      lstatSync(destination, { bigint: true }), "TOOLCHAIN_DESTINATION_SUBSTITUTED");
    validateDestination();
    if (transaction.wrapperPublished) {
      validatePublishedWrapper(wrapper, transaction.wrapperIdentity);
    }
    // Backup deletion is irreversible: after this boundary failures preserve
    // the validated new installation and any remaining backup evidence.
    transaction.committed = true;
    if (transaction.backup !== undefined) {
      onPublishBoundary?.("after-publication-commit", {
        backup: transaction.backup.root,
        destination,
      });
      cleanupIdentityBoundDirectory(transaction.backup.handle);
      transaction.backup = undefined;
    }
  } catch (error) {
    finishFailedPublication(transaction, error);
  }
}
