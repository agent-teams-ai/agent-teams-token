import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  realpathSync,
  openSync,
} from "node:fs";

import { descriptorChild as rollbackDescriptorChild } from "../runtime/common.mjs";
import {
  custodyDescriptorDirectory,
  forgetCustodyDescriptor,
  registerCustodyDescriptor,
} from "../runtime/custody.mjs";
import {
  closeDescriptorOnce,
  throwDescriptorCloseFailures,
} from "../runtime/descriptor-close.mjs";
import { validateExactPath } from "./manifests.mjs";
import { rollbackWorkspaceState } from "./workspace-handle.mjs";

const rollbackSharedPlanDescriptors = new WeakMap();

export function rollbackSharedPathError(code, logicalPath, cause) {
  return new Error(`${code} path=${logicalPath}`, cause === undefined ? undefined : { cause });
}

export function rollbackSharedOpenFlags({ create = false, directory = false, write = false } = {}) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_DIRECTORY)) {
    throw new Error("ROLLBACK_SHARED_PATH_NOFOLLOW_UNAVAILABLE");
  }
  let flags = write ? constants.O_RDWR : constants.O_RDONLY;
  flags |= constants.O_NOFOLLOW;
  if (directory) {
    flags |= constants.O_DIRECTORY;
  }
  if (create) {
    flags |= constants.O_CREAT | constants.O_EXCL;
  }
  return flags;
}

export function rollbackSharedIdentity(identity) {
  return Object.freeze({
    ctimeNs: String(identity.ctimeNs),
    dev: String(identity.dev),
    gid: String(identity.gid),
    ino: String(identity.ino),
    kind: identity.isDirectory() && !identity.isSymbolicLink()
      ? "directory"
      : identity.isFile() && !identity.isSymbolicLink() ? "file" : "unsafe",
    mode: String(identity.mode),
    mtimeNs: String(identity.mtimeNs),
    nlink: String(identity.nlink),
    size: String(identity.size),
    uid: String(identity.uid),
  });
}

export function assertRollbackSharedStableIdentity(expected, actual, logicalPath) {
  const observed = rollbackSharedIdentity(actual);
  if (expected.dev !== observed.dev || expected.ino !== observed.ino
    || expected.kind !== observed.kind || expected.uid !== observed.uid || expected.gid !== observed.gid
    || expected.nlink !== observed.nlink || expected.mode !== observed.mode) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_SUBSTITUTED", logicalPath);
  }
}

export function assertRollbackSharedStableAncestorIdentity(expected, actual, logicalPath) {
  const observed = rollbackSharedIdentity(actual);
  if (expected.dev !== observed.dev || expected.ino !== observed.ino
    || expected.kind !== observed.kind || expected.uid !== observed.uid || expected.gid !== observed.gid
    || expected.mode !== observed.mode) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_SUBSTITUTED", logicalPath);
  }
}

export function assertRollbackSharedSnapshotUnchanged(expected, actual, logicalPath) {
  assertRollbackSharedStableIdentity(expected, actual, logicalPath);
  const observed = rollbackSharedIdentity(actual);
  if (expected.size !== observed.size || expected.mtimeNs !== observed.mtimeNs
    || expected.ctimeNs !== observed.ctimeNs) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_CONTENT_CHANGED", logicalPath);
  }
}

export function assertRollbackSharedSafeNode(identity, kind, workspace, logicalPath) {
  const observed = rollbackSharedIdentity(identity);
  if (observed.kind !== kind || observed.dev !== String(workspace.checkoutIdentity.dev)
    || observed.uid !== workspace.owner || (kind === "file" && observed.nlink !== "1")) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_TYPE_UNSAFE", logicalPath);
  }
  return observed;
}

export function openRollbackSharedRoot(workspace, logicalPath) {
  let descriptor;
  try {
    descriptor = openSync(
      custodyDescriptorDirectory(workspace.checkoutDescriptor),
      rollbackSharedOpenFlags({ directory: true }),
    );
    assertRollbackSharedStableAncestorIdentity(
      rollbackSharedIdentity(workspace.checkoutIdentity),
      fstatSync(descriptor, { bigint: true }),
      logicalPath,
    );
    assertRollbackSharedStableAncestorIdentity(
      rollbackSharedIdentity(workspace.checkoutIdentity),
      lstatSync(workspace.checkoutPath, { bigint: true }),
      logicalPath,
    );
    registerCustodyDescriptor(descriptor, workspace.checkoutPath, workspace.checkoutIdentity);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (error instanceof Error && error.message.includes("ROLLBACK_SHARED_PATH_")) {
      throw error;
    }
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_ROOT_UNSAFE", logicalPath, error);
  }
}

export function closeRollbackSharedPlan(plan, primaryFailure) {
  const descriptors = rollbackSharedPlanDescriptors.get(plan);
  if (descriptors === undefined) {
    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
    return;
  }
  rollbackSharedPlanDescriptors.delete(plan);
  const closing = descriptors.toReversed();
  descriptors.length = 0;
  const failures = [];
  for (const descriptor of closing) {
    forgetCustodyDescriptor(descriptor);
    try {
      closeDescriptorOnce(descriptor);
    } catch (error) {
      failures.push(error);
    }
  }
  throwDescriptorCloseFailures(
    failures, "ROLLBACK_SHARED_PATH_CLOSE_FAILED", primaryFailure,
  );
}

export function snapshotRollbackSharedPaths(root, paths, workspaceHandle, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => key !== "holdDescriptors")
    || (options.holdDescriptors !== undefined && typeof options.holdDescriptors !== "boolean")) {
    throw new Error("ROLLBACK_SHARED_PATH_OPTIONS_INVALID");
  }
  const { holdDescriptors = false } = options;
  const workspace = rollbackWorkspaceState(workspaceHandle, root);
  const plan = new Map();
  const heldDescriptors = [];
  if (holdDescriptors) {
    rollbackSharedPlanDescriptors.set(plan, heldDescriptors);
  }
  try {
    for (const logicalPath of paths) {
      validateExactPath(logicalPath, "shared");
      if (plan.has(logicalPath)) {
        throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_DUPLICATE", logicalPath);
      }
      plan.set(logicalPath, snapshotRollbackSharedPath({
        heldDescriptors,
        holdDescriptors,
        logicalPath,
        workspace,
      }));
    }
    return plan;
  } catch (error) {
    closeRollbackSharedPlan(plan, error);
  }
}

function snapshotRollbackSharedPath(context) {
  const { logicalPath, workspace } = context;
  const components = logicalPath.split("/");
  let descriptor = openRollbackSharedRoot(workspace, logicalPath);
  const ancestors = [];
  try {
    for (const component of components.slice(0, -1)) {
      const next = snapshotRollbackSharedAncestor(descriptor, component, context);
      ancestors.push(Object.freeze({ component, identity: next.identity }));
      closeSync(descriptor);
      descriptor = next.descriptor;
    }
    return {
      ancestors: Object.freeze(ancestors),
      final: snapshotRollbackSharedFinal(descriptor, components.at(-1), context),
      logicalPath,
    };
  } finally {
    closeSync(descriptor);
  }
}

function snapshotRollbackSharedAncestor(descriptor, component, context) {
  const { heldDescriptors, holdDescriptors, logicalPath, workspace } = context;
  const candidate = rollbackDescriptorChild(descriptor, component);
  let held;
  let next;
  try {
    const captured = lstatSync(candidate, { bigint: true });
    const identity = assertRollbackSharedSafeNode(
      captured,
      "directory",
      workspace,
      logicalPath,
    );
    next = openSync(candidate, rollbackSharedOpenFlags({ directory: true }));
    assertRollbackSharedStableAncestorIdentity(
      identity,
      fstatSync(next, { bigint: true }),
      logicalPath,
    );
    assertRollbackSharedStableAncestorIdentity(
      identity,
      lstatSync(candidate, { bigint: true }),
      logicalPath,
    );
    if (holdDescriptors) {
      held = openHeldSharedDescriptor(candidate, identity, logicalPath, true);
      heldDescriptors.push(held);
      held = undefined;
    }
    registerCustodyDescriptor(next, realpathSync(candidate), captured);
    const result = { descriptor: next, identity };
    next = undefined;
    return result;
  } catch (error) {
    if (held !== undefined) {
      closeSync(held);
    }
    if (next !== undefined) {
      closeSync(next);
    }
    if (error instanceof Error && error.message.includes("ROLLBACK_SHARED_PATH_")) {
      throw error;
    }
    throw rollbackSharedPathError(
      "ROLLBACK_SHARED_PATH_ANCESTOR_UNSAFE",
      logicalPath,
      error,
    );
  }
}

function snapshotRollbackSharedFinal(descriptor, name, context) {
  const { heldDescriptors, holdDescriptors, logicalPath, workspace } = context;
  const candidate = rollbackDescriptorChild(descriptor, name);
  let held;
  try {
    const identity = assertRollbackSharedSafeNode(
      lstatSync(candidate, { bigint: true }),
      "file",
      workspace,
      logicalPath,
    );
    if (holdDescriptors) {
      held = openHeldSharedDescriptor(candidate, identity, logicalPath, false);
      heldDescriptors.push(held);
      held = undefined;
    }
    return Object.freeze({ identity, kind: "file" });
  } catch (error) {
    if (held !== undefined) {
      closeSync(held);
    }
    if (error?.code === "ENOENT") {
      return Object.freeze({ kind: "absent" });
    }
    if (error instanceof Error && error.message.includes("ROLLBACK_SHARED_PATH_")) {
      throw error;
    }
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_FINAL_UNSAFE", logicalPath, error);
  }
}

function openHeldSharedDescriptor(candidate, identity, logicalPath, directory) {
  const descriptor = openSync(candidate, rollbackSharedOpenFlags({ directory }));
  try {
    const captured = fstatSync(descriptor, { bigint: true });
    const assertIdentity = directory
      ? assertRollbackSharedStableAncestorIdentity
      : assertRollbackSharedSnapshotUnchanged;
    assertIdentity(identity, captured, logicalPath);
    assertIdentity(identity, lstatSync(candidate, { bigint: true }), logicalPath);
    registerCustodyDescriptor(descriptor, realpathSync(candidate), captured);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function rollbackSharedPlanEntry(plan, logicalPath) {
  const entry = plan?.get?.(logicalPath);
  if (entry === undefined || entry.logicalPath !== logicalPath) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_PLAN_MISSING", logicalPath);
  }
  return entry;
}

export function openRollbackSharedParent(root, logicalPath, plan, workspaceHandle) {
  validateExactPath(logicalPath, "shared");
  const workspace = rollbackWorkspaceState(workspaceHandle, root);
  const entry = rollbackSharedPlanEntry(plan, logicalPath);
  const components = logicalPath.split("/");
  if (entry.ancestors.length !== components.length - 1) {
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_PLAN_INVALID", logicalPath);
  }
  let descriptor = openRollbackSharedRoot(workspace, logicalPath);
  try {
    for (const [index, component] of components.slice(0, -1).entries()) {
      const expected = entry.ancestors[index];
      if (expected.component !== component) {
        throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_PLAN_INVALID", logicalPath);
      }
      const candidate = rollbackDescriptorChild(descriptor, component);
      let next;
      try {
        const before = lstatSync(candidate, { bigint: true });
        assertRollbackSharedSafeNode(before, "directory", workspace, logicalPath);
        assertRollbackSharedStableAncestorIdentity(expected.identity, before, logicalPath);
        next = openSync(candidate, rollbackSharedOpenFlags({ directory: true }));
        assertRollbackSharedStableAncestorIdentity(
          expected.identity,
          fstatSync(next, { bigint: true }),
          logicalPath,
        );
        registerCustodyDescriptor(next, realpathSync(candidate), before);
      } catch (error) {
        if (next !== undefined) {
          closeSync(next);
        }
        if (error instanceof Error && error.message.includes("ROLLBACK_SHARED_PATH_")) {
          throw error;
        }
        throw rollbackSharedPathError(
          "ROLLBACK_SHARED_PATH_ANCESTOR_UNSAFE",
          logicalPath,
          error,
        );
      }
      closeSync(descriptor);
      descriptor = next;
    }
    return {
      descriptor,
      entry,
      name: components.at(-1),
      workspace,
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function assertRollbackSharedFinal(parent) {
  const logicalPath = parent.entry.logicalPath;
  const candidate = rollbackDescriptorChild(parent.descriptor, parent.name);
  try {
    const current = lstatSync(candidate, { bigint: true });
    if (parent.entry.final.kind === "absent") {
      throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_SUBSTITUTED", logicalPath);
    }
    assertRollbackSharedSafeNode(current, "file", parent.workspace, logicalPath);
    assertRollbackSharedStableIdentity(parent.entry.final.identity, current, logicalPath);
    return current;
  } catch (error) {
    if (error?.code === "ENOENT" && parent.entry.final.kind === "absent") {
      return;
    }
    if (error instanceof Error && error.message.includes("ROLLBACK_SHARED_PATH_")) {
      throw error;
    }
    throw rollbackSharedPathError("ROLLBACK_SHARED_PATH_FINAL_UNSAFE", logicalPath, error);
  }
}
