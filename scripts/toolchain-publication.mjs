import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  custodyIdentity,
} from "./rollback/runtime/custody.mjs";

function createPublicationBackup({ destination, toolsRoot, wrapper }) {
  const entries = [
    existsSync(destination) ? "payload" : undefined,
    wrapper !== undefined && existsSync(wrapper.target) ? "wrapper" : undefined,
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

function writePublishedWrapper(wrapper) {
  const bin = dirname(wrapper.target);
  const part = wrapper.target + ".part";
  mkdirSync(bin, { recursive: true });
  if (existsSync(part)) {
    throw new Error("TOOLCHAIN_WRAPPER_PART_EXISTS path=" + part);
  }
  try {
    writeFileSync(part, wrapper.contents, { mode: 0o755 });
    chmodSync(part, 0o755);
    renameSync(part, wrapper.target);
  } catch (error) {
    const failures = [];
    if (existsSync(part)) {
      try {
        const entry = lstatSync(part, { bigint: true });
        if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid())) {
          throw new Error("TOOLCHAIN_WRAPPER_PART_UNSAFE path=" + part, { cause: error });
        }
        unlinkSync(part);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        "TOOLCHAIN_WRAPPER_PUBLICATION_FAILED",
        { cause: error },
      );
    }
    throw error;
  }
  const identity = custodyIdentity(lstatSync(wrapper.target, { bigint: true }));
  if (identity.kind !== "file" || !readFileSync(wrapper.target).equals(Buffer.from(wrapper.contents))) {
    throw new Error("TOOLCHAIN_WRAPPER_PUBLICATION_MISMATCH path=" + wrapper.target);
  }
  return identity;
}

function removePublishedWrapper(wrapper, identity) {
  assertCustodyIdentity(
    identity,
    lstatSync(wrapper.target, { bigint: true }),
    "TOOLCHAIN_WRAPPER_PUBLICATION_SUBSTITUTED",
  );
  if (!readFileSync(wrapper.target).equals(Buffer.from(wrapper.contents))) {
    throw new Error("TOOLCHAIN_WRAPPER_PUBLICATION_SUBSTITUTED");
  }
  unlinkSync(wrapper.target);
}

function restoreBackupEntry(backup, name, target) {
  if (!backup?.entries.has(name)) {
    return;
  }
  renameSync(join(backup.root, name), target);
  updateCleanupTreeSnapshot(backup.handle, { allowRemovedEntries: [name] });
  backup.entries.delete(name);
}

function rollbackPublication(transaction) {
  const { backup, destination, prepared, wrapper } = transaction;
  if (backup?.handle.closed) {
    return;
  }
  if (backup !== undefined) {
    assertCapturedCleanupTreeSnapshot(backup.handle);
  }
  if (transaction.wrapperIdentity !== undefined) {
    removePublishedWrapper(wrapper, transaction.wrapperIdentity);
  }
  restoreBackupEntry(backup, "wrapper", wrapper?.target);
  if (transaction.destinationPublished) {
    transaction.validateDestination();
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
    prepared,
    validateDestination,
    wrapper,
    wrapperIdentity: undefined,
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
      transaction.wrapperIdentity = writePublishedWrapper(wrapper);
    }
    if (transaction.backup !== undefined) {
      onPublishBoundary?.("before-backup-cleanup", {
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
