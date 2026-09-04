import { createHash } from "node:crypto";
import {
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";

import { descriptorChild as rollbackDescriptorChild } from "../runtime/common.mjs";
import {
  closeCustodyDescriptors,
  registerCustodyDescriptor,
} from "../runtime/custody.mjs";
import { ROLLBACK_SHARED_PATH_MAX_BYTES } from "./config.mjs";
import { validateExactPath } from "./manifests.mjs";
import {
  assertRollbackSharedSafeNode,
  assertRollbackSharedFinal,
  assertRollbackSharedSnapshotUnchanged,
  assertRollbackSharedStableIdentity,
  openRollbackSharedParent,
  openRollbackSharedRoot,
  rollbackSharedOpenFlags,
  rollbackSharedIdentity,
  rollbackSharedPathError,
  rollbackSharedPlanEntry,
} from "./shared-paths.mjs";
import { rollbackWorkspaceState } from "./workspace-handle.mjs";

export function assertRollbackSharedPathAtCheckout(root, logicalPath, plan, workspaceHandle) {
  const parent = openRollbackSharedParent(root, logicalPath, plan, workspaceHandle);
  let result;
  let primaryFailure;
  try {
    result = assertRollbackSharedFinal(parent);
  } catch (error) {
    primaryFailure = error;
  }
  closeRollbackSharedOwned(parent, primaryFailure);
  return result;
}

function closeRollbackSharedOwned(owned, primaryFailure) {
  const descriptors = [owned.descriptor, owned.parentDescriptor];
  owned.descriptor = undefined;
  owned.parentDescriptor = undefined;
  closeCustodyDescriptors(descriptors, "ROLLBACK_SHARED_PATH_CLOSE_FAILED", primaryFailure);
}

function useRollbackSharedOpened(opened, action) {
  let result;
  let primaryFailure;
  try {
    result = action();
  } catch (error) {
    primaryFailure = error;
  }
  closeRollbackSharedOwned(opened, primaryFailure);
  return result;
}

function openRollbackSharedFile(root, logicalPath, plan, workspaceHandle, { write = false } = {}) {
  const parent = openRollbackSharedParent(root, logicalPath, plan, workspaceHandle);
  let descriptor;
  try {
    const before = assertRollbackSharedFinal(parent);
    if (before === undefined) {
      throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_FINAL_MISSING", logicalPath);
    }
    const candidate = rollbackDescriptorChild(parent.descriptor, parent.name);
    descriptor = openSync(candidate, rollbackSharedOpenFlags({ write }));
    assertRollbackSharedStableIdentity(
      parent.entry.final.identity,
      fstatSync(descriptor, { bigint: true }),
      logicalPath,
    );
    assertRollbackSharedStableIdentity(
      parent.entry.final.identity,
      lstatSync(candidate, { bigint: true }),
      logicalPath,
    );
    const result = { descriptor, entry: parent.entry, parentDescriptor: parent.descriptor };
    descriptor = undefined;
    parent.descriptor = undefined;
    return result;
  } catch (error) {
    const primaryFailure = error instanceof Error
      && error.message.includes("ROLLBACK_SHARED_PATH_")
      ? error
      : rollbackSharedPathError("ROLLBACK_SHARED_PATH_FINAL_UNSAFE", logicalPath, error);
    const closing = [descriptor, parent.descriptor];
    descriptor = undefined;
    parent.descriptor = undefined;
    closeCustodyDescriptors(
      closing,
      "ROLLBACK_SHARED_PATH_ACQUISITION_CLOSE_FAILED",
      primaryFailure,
    );
  }
}

function readRollbackSharedDescriptor(descriptor, expected, logicalPath) {
  const before = fstatSync(descriptor, { bigint: true });
  assertRollbackSharedSnapshotUnchanged(expected, before, logicalPath);
  if (before.size < 0n || before.size > BigInt(ROLLBACK_SHARED_PATH_MAX_BYTES)) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_SIZE_UNSAFE", logicalPath);
  }
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) {
      throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_SHORT_READ", logicalPath);
    }
    offset += count;
  }
  assertRollbackSharedSnapshotUnchanged(
    expected,
    fstatSync(descriptor, { bigint: true }),
    logicalPath,
  );
  return bytes;
}

export function readRollbackSharedBytes(root, logicalPath, plan, workspaceHandle) {
  const entry = rollbackSharedPlanEntry(plan, logicalPath);
  if (entry.final.kind === "absent") {
    assertRollbackSharedPathAtCheckout(root, logicalPath, plan, workspaceHandle);
    return;
  }
  const opened = openRollbackSharedFile(root, logicalPath, plan, workspaceHandle);
  return useRollbackSharedOpened(opened, () => {
    const bytes = readRollbackSharedDescriptor(
      opened.descriptor,
      opened.entry.final.identity,
      logicalPath,
    );
    assertRollbackSharedPathAtCheckout(root, logicalPath, plan, workspaceHandle);
    return bytes;
  });
}

function writeRollbackSharedDescriptor(root, logicalPath, plan, workspaceHandle, ...writeState) {
  const [opened, bytes] = writeState;
  if (!Buffer.isBuffer(bytes) || bytes.length > ROLLBACK_SHARED_PATH_MAX_BYTES) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_SIZE_UNSAFE", logicalPath);
  }
  const expected = opened.entry.final.identity;
  assertRollbackSharedSnapshotUnchanged(
    expected,
    fstatSync(opened.descriptor, { bigint: true }),
    logicalPath,
  );
  assertRollbackSharedPathAtCheckout(root, logicalPath, plan, workspaceHandle);
  assertRollbackSharedSnapshotUnchanged(
    expected,
    fstatSync(opened.descriptor, { bigint: true }),
    logicalPath,
  );
  ftruncateSync(opened.descriptor, 0);
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(opened.descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) {
      throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_SHORT_WRITE", logicalPath);
    }
    offset += count;
  }
  const written = fstatSync(opened.descriptor, { bigint: true });
  assertRollbackSharedStableIdentity(expected, written, logicalPath);
  if (written.size !== BigInt(bytes.length)) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_SHORT_WRITE", logicalPath);
  }
  opened.entry.final = Object.freeze({
    identity: rollbackSharedIdentity(written),
    kind: "file",
  });
  const readback = readRollbackSharedDescriptor(
    opened.descriptor,
    opened.entry.final.identity,
    logicalPath,
  );
  if (!readback.equals(bytes)) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_WRITE_VERIFY_FAILED", logicalPath);
  }
  assertRollbackSharedPathAtCheckout(root, logicalPath, plan, workspaceHandle);
}

export function editRollbackSharedText(root, logicalPath, plan, workspaceHandle, edit) {
  const opened = openRollbackSharedFile(root, logicalPath, plan, workspaceHandle, { write: true });
  useRollbackSharedOpened(opened, () => {
    const source = readRollbackSharedDescriptor(
      opened.descriptor,
      opened.entry.final.identity,
      logicalPath,
    ).toString("utf8");
    const result = edit(source);
    if (typeof result !== "string") {
      throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_EDIT_INVALID", logicalPath);
    }
    writeRollbackSharedDescriptor(
      root,
      logicalPath,
      plan,
      workspaceHandle,
      opened,
      Buffer.from(result, "utf8"),
    );
  });
}

export function createRollbackSharedFile(root, logicalPath, plan, workspaceHandle, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const parent = openRollbackSharedParent(root, logicalPath, plan, workspaceHandle);
  let descriptor;
  let primaryFailure;
  try {
    if (parent.entry.final.kind !== "absent" || assertRollbackSharedFinal(parent) !== undefined) {
      throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_EXPECTED_ABSENT", logicalPath);
    }
    const candidate = rollbackDescriptorChild(parent.descriptor, parent.name);
    try {
      descriptor = openSync(
        candidate,
        rollbackSharedOpenFlags({ create: true, write: true }),
        0o600,
      );
    } catch (error) {
      throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_CREATE_FAILED", logicalPath, error);
    }
    fchmodSync(descriptor, 0o644);
    const created = fstatSync(descriptor, { bigint: true });
    parent.entry.final = Object.freeze({
      identity: assertRollbackSharedSafeNode(created, "file", parent.workspace, logicalPath),
      kind: "file",
    });
    assertRollbackSharedPathAtCheckout(root, logicalPath, plan, workspaceHandle);
    writeRollbackSharedDescriptor(
      root,
      logicalPath,
      plan,
      workspaceHandle,
      { descriptor, entry: parent.entry },
      bytes,
    );
  } catch (error) {
    primaryFailure = error;
  }
  const closing = [descriptor, parent.descriptor];
  descriptor = undefined;
  parent.descriptor = undefined;
  closeCustodyDescriptors(
    closing,
    "ROLLBACK_SHARED_PATH_CLOSE_FAILED",
    primaryFailure,
  );
}

export function restoreRollbackSharedFile(root, logicalPath, plan, workspaceHandle, content) {
  const entry = rollbackSharedPlanEntry(plan, logicalPath);
  if (entry.final.kind === "absent") {
    createRollbackSharedFile(root, logicalPath, plan, workspaceHandle, content);
    return;
  }
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const opened = openRollbackSharedFile(
    root,
    logicalPath,
    plan,
    workspaceHandle,
    { write: true },
  );
  useRollbackSharedOpened(opened, () => {
    writeRollbackSharedDescriptor(
      root,
      logicalPath,
      plan,
      workspaceHandle,
      opened,
      bytes,
    );
  });
}

export function markRollbackSharedPathAbsent(plan, logicalPath) {
  const entry = rollbackSharedPlanEntry(plan, logicalPath);
  if (entry.final.kind !== "file") {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_PLAN_INVALID", logicalPath);
  }
  entry.final = Object.freeze({ kind: "absent" });
}

export function hashRollbackSharedOrAbsent(root, logicalPath, plan, workspaceHandle) {
  const bytes = readRollbackSharedBytes(root, logicalPath, plan, workspaceHandle);
  return bytes === undefined ? "absent" : createHash("sha256").update(bytes).digest("hex");
}

export function assertRollbackPathAbsentFromCheckout(root, logicalPath, workspaceHandle) {
  validateExactPath(logicalPath, "absent");
  const workspace = rollbackWorkspaceState(workspaceHandle, root);
  const components = logicalPath.split("/");
  let descriptor = openRollbackSharedRoot(workspace, logicalPath);
  let primaryFailure;
  try {
    for (const [index, component] of components.entries()) {
      const candidate = rollbackDescriptorChild(descriptor, component);
      let identity;
      try {
        identity = lstatSync(candidate, { bigint: true });
      } catch (error) {
        if (error?.code === "ENOENT") {
          break;
        }
        throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_ABSENCE_UNSAFE", logicalPath, error);
      }
      if (index === components.length - 1) {
        throw new Error("ROLLBACK_OWNED_PATH_SURVIVED path=" + logicalPath);
      }
      assertRollbackSharedSafeNode(identity, "directory", workspace, logicalPath);
      let next;
      try {
        next = openSync(candidate, rollbackSharedOpenFlags({ directory: true }));
        assertRollbackSharedStableIdentity(
          rollbackSharedIdentity(identity),
          fstatSync(next, { bigint: true }),
          logicalPath,
        );
        assertRollbackSharedStableIdentity(
          rollbackSharedIdentity(identity),
          lstatSync(candidate, { bigint: true }),
          logicalPath,
        );
        registerCustodyDescriptor(next, realpathSync(candidate), identity);
      } catch (error) {
        const acquisitionFailure = error instanceof Error
          && error.message.includes("ROLLBACK_SHARED_PATH_")
          ? error
          : rollbackSharedPathError(
            "ROLLBACK_SHARED_PATH_ABSENCE_UNSAFE",
            logicalPath,
            error,
          );
        const closing = next;
        next = undefined;
        closeCustodyDescriptors(
          [closing],
          "ROLLBACK_SHARED_PATH_ACQUISITION_CLOSE_FAILED",
          acquisitionFailure,
        );
      }
      const previous = descriptor;
      descriptor = next;
      next = undefined;
      closeCustodyDescriptors(
        [previous],
        "ROLLBACK_SHARED_PATH_TRAVERSAL_CLOSE_FAILED",
      );
    }
  } catch (error) {
    primaryFailure = error;
  }
  const closing = descriptor;
  descriptor = undefined;
  closeCustodyDescriptors(
    [closing],
    "ROLLBACK_SHARED_PATH_TRAVERSAL_CLOSE_FAILED",
    primaryFailure,
  );
}
