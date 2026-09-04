import { createHash } from "node:crypto";
import {
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  realpathSync,
  renameSync,
} from "node:fs";

import {
  assertCustodyDescriptor,
  assertCustodyIdentity,
  assertCustodyStableObject,
  closeCustodyDescriptors,
  collectCustodyDescriptorCloseFailure,
  custodyDescriptorChild as rollbackDescriptorChild,
  custodyDescriptorDirectory,
  registerCustodyDescriptor,
  updateCustodyDescriptor,
} from "../runtime/custody.mjs";
import {
  throwDescriptorCloseFailures,
} from "../runtime/descriptor-close.mjs";

import {
  ROLLBACK_PATH_MAX_DEPTH,
  ROLLBACK_REMOVAL_MAX_SLOTS,
} from "./config.mjs";
import { validateExactPath } from "./manifests.mjs";
import {
  assertRollbackWorkspaceHandle,
  parentDirectories,
  rollbackWorkspaceState,
} from "./workspace-handle.mjs";

export function orderedRemovableDirectories(manifest) {
  const retainedDirectories = new Set([manifest.ownedRoot]);
  for (const path of manifest.restoreFromBaseline) {
    for (const directory of parentDirectories(path, manifest.ownedRoot)) {
      retainedDirectories.add(directory);
    }
  }
  const removableDirectories = new Set();
  for (const path of manifest.ownedPaths) {
    for (const directory of parentDirectories(path, manifest.ownedRoot)) {
      if (!retainedDirectories.has(directory)) {
        removableDirectories.add(directory);
      }
    }
  }
  if (removableDirectories.size > ROLLBACK_REMOVAL_MAX_SLOTS) {
    throw new Error("ROLLBACK_OWNED_DIRECTORY_BOUNDS slice=" + manifest.sliceId);
  }
  return [...removableDirectories].toSorted((left, right) => {
    const depthDifference = right.split("/").length - left.split("/").length;
    return depthDifference === 0 ? (left < right ? -1 : left > right ? 1 : 0) : depthDifference;
  });
}

export function removeOwnedEmptyDirectoriesWithQuarantine(root, manifest, quarantine, options) {
  const ordered = options.orderedDirectories ?? runRollbackRemovalPhase(
    "plan-empty-directories",
    () => orderedRemovableDirectories(manifest),
  );
  const quarantined = [];
  for (const path of ordered) {
    stageRollbackRemoval(
      quarantine,
      path,
      "directory",
      options.onBoundary,
    );
    quarantined.push(path);
  }
  return {
    quarantinedDirectoryCount: quarantined.length,
    quarantinedDirectories: quarantined,
    quarantinedDirectoriesSha256: createHash("sha256")
      .update(Buffer.from(JSON.stringify(quarantined), "utf8"))
      .digest("hex"),
    deletionDeferredToIdentityBoundCleanup: true,
  };
}

export function runRollbackRemovalPhase(phase, action) {
  try {
    return action();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("ROLLBACK_REMOVAL_")) {
      throw error;
    }
    throw new Error(
      "ROLLBACK_REMOVAL_PHASE_FAILED phase=" + phase + " cause=" + detail,
      { cause: error },
    );
  }
}

export function createRollbackRemovalQuarantine(root, manifest, options) {
  return runRollbackRemovalPhase(
    "create-quarantine",
    () => createRollbackRemovalQuarantineUnchecked(root, manifest, options),
  );
}

function createRollbackRemovalQuarantineUnchecked(root, manifest, options) {
  const workspace = rollbackWorkspaceState(options?.workspaceHandle, root);
  if (typeof manifest.sliceId !== "string" || !/^[a-z0-9-]{1,64}$/u.test(manifest.sliceId)) {
    throw new Error("ROLLBACK_REMOVAL_SLICE_INVALID");
  }
  let descriptor;
  try {
    let created;
    for (let sequence = 1; sequence <= ROLLBACK_REMOVAL_MAX_SLOTS; sequence += 1) {
      const candidate = rollbackDescriptorChild(
        workspace.quarantineDescriptor,
        "rollback-removals-" + manifest.sliceId + "-" + String(sequence).padStart(4, "0"),
      );
      try {
        mkdirSync(candidate, { mode: 0o700 });
        created = candidate;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }
    }
    if (created === undefined) {
      throw new Error("ROLLBACK_REMOVAL_QUARANTINE_LIMIT");
    }
    descriptor = openSync(
      created,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const identity = fstatSync(descriptor, { bigint: true });
    assertRollbackRemovalIdentity(
      lstatSync(created, { bigint: true }), identity, created,
    );
    if (!identity.isDirectory() || (identity.mode & 0o777n) !== 0o700n
      || String(identity.uid) !== String(process.getuid())
      || String(identity.dev) !== String(workspace.quarantineIdentity.dev)) {
      throw new Error("ROLLBACK_REMOVAL_QUARANTINE_UNSAFE path=" + created);
    }
    registerCustodyDescriptor(descriptor, realpathSync(created), identity);
    assertRollbackWorkspaceHandle(options.workspaceHandle, root);
    const result = {
      descriptor,
      rootDescriptor: workspace.checkoutDescriptor,
      nextSlot: 0,
      device: String(identity.dev),
      owner: workspace.owner,
      logicalPaths: [],
      plannedIdentities: undefined,
      workspaceHandle: options.workspaceHandle,
      rootPath: root,
    };
    descriptor = undefined;
    return result;
  } catch (error) {
    const closing = descriptor;
    descriptor = undefined;
    closeCustodyDescriptors(
      [closing],
      "ROLLBACK_REMOVAL_QUARANTINE_CLOSE_FAILED",
      error,
    );
  }
}

export function snapshotRollbackRemovalPlan(quarantine, plan) {
  return runRollbackRemovalPhase("snapshot-plan", () => {
    if (!Array.isArray(plan) || plan.length > ROLLBACK_REMOVAL_MAX_SLOTS) {
      throw new Error("ROLLBACK_REMOVAL_PLAN_LIMIT");
    }
    assertRollbackWorkspaceHandle(quarantine.workspaceHandle, quarantine.rootPath);
    if (quarantine.plannedIdentities !== undefined) {
      throw new Error("ROLLBACK_REMOVAL_PLAN_ALREADY_CAPTURED");
    }
    const plannedIdentities = new Map();
    try {
      for (const removal of plan) {
        if (removal === null || typeof removal !== "object" || Array.isArray(removal)
          || !["directory", "file"].includes(removal.kind)
          || plannedIdentities.has(removal.path)) {
          throw new Error("ROLLBACK_REMOVAL_PLAN_INVALID path=" + String(removal?.path));
        }
        plannedIdentities.set(
          removal.path,
          snapshotRollbackRemovalIdentity(quarantine, removal.path, removal.kind),
        );
      }
      assertRollbackWorkspaceHandle(quarantine.workspaceHandle, quarantine.rootPath);
      quarantine.plannedIdentities = plannedIdentities;
    } catch (error) {
      closeRollbackRemovalDescriptors(plannedIdentities, error);
    }
  });
}

function snapshotRollbackRemovalIdentity(quarantine, logicalPath, expectedKind) {
  const parent = openRollbackRemovalParent(quarantine, logicalPath);
  let descriptor;
  let result;
  let primaryFailure;
  try {
    const sourcePath = rollbackDescriptorChild(parent.descriptor, parent.name);
    const identity = lstatSync(sourcePath, { bigint: true });
    const kind = rollbackRemovalKind(identity);
    if (kind !== expectedKind || String(identity.dev) !== quarantine.device
      || String(identity.uid) !== quarantine.owner) {
      throw new Error("ROLLBACK_REMOVAL_TYPE_UNSAFE path=" + logicalPath);
    }
    descriptor = openSync(
      sourcePath,
      expectedKind === "directory"
        ? constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
        : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    assertRollbackRemovalIdentity(
      identity,
      fstatSync(descriptor, { bigint: true }),
      logicalPath,
    );
    registerCustodyDescriptor(descriptor, realpathSync(sourcePath), identity);
    result = { descriptor, identity, kind };
  } catch (error) {
    primaryFailure = error;
  }
  const failures = [];
  const parentDescriptor = parent.descriptor;
  parent.descriptor = undefined;
  collectCustodyDescriptorCloseFailure(parentDescriptor, failures);
  if (primaryFailure !== undefined || failures.length > 0) {
    const retainedDescriptor = descriptor;
    descriptor = undefined;
    collectCustodyDescriptorCloseFailure(retainedDescriptor, failures);
    throwDescriptorCloseFailures(
      failures,
      "ROLLBACK_REMOVAL_ACQUISITION_CLOSE_FAILED",
      primaryFailure,
    );
  }
  descriptor = undefined;
  return result;
}

function takeRollbackRemovalDescriptors(plannedIdentities) {
  const descriptors = [];
  if (!(plannedIdentities instanceof Map)) {
    return descriptors;
  }
  for (const planned of plannedIdentities.values()) {
    if (Number.isInteger(planned?.descriptor)) {
      descriptors.push(planned.descriptor);
      planned.descriptor = undefined;
    }
  }
  return descriptors;
}

function closeRollbackRemovalDescriptors(plannedIdentities, primaryFailure) {
  closeCustodyDescriptors(
    takeRollbackRemovalDescriptors(plannedIdentities),
    "ROLLBACK_REMOVAL_DESCRIPTOR_CLOSE_FAILED",
    primaryFailure,
  );
}

function takeRollbackRemovalPlan(quarantine) {
  const plannedIdentities = quarantine.plannedIdentities;
  quarantine.plannedIdentities = undefined;
  return plannedIdentities;
}

export function closeRollbackRemovalPlan(quarantine, primaryFailure) {
  closeRollbackRemovalDescriptors(takeRollbackRemovalPlan(quarantine), primaryFailure);
}

export function closeRollbackRemovalQuarantine(quarantine, primaryFailure) {
  const descriptors = takeRollbackRemovalDescriptors(takeRollbackRemovalPlan(quarantine));
  const quarantineDescriptor = quarantine.descriptor;
  quarantine.descriptor = undefined;
  if (Number.isInteger(quarantineDescriptor)) {
    descriptors.push(quarantineDescriptor);
  }
  closeCustodyDescriptors(
    descriptors,
    "ROLLBACK_REMOVAL_QUARANTINE_CLOSE_FAILED",
    primaryFailure,
  );
}

export function stageRollbackRemoval(quarantine, logicalPath, expectedKind, onBoundary) {
  return runRollbackRemovalPhase(
    "stage path=" + logicalPath,
    () => stageRollbackRemovalUnchecked(quarantine, logicalPath, expectedKind, onBoundary),
  );
}

function stageRollbackRemovalUnchecked(quarantine, logicalPath, expectedKind, onBoundary) {
  const planned = quarantine.plannedIdentities?.get(logicalPath);
  if (planned === undefined || planned.kind !== expectedKind
    || !Number.isInteger(planned.descriptor)) {
    throw new Error("ROLLBACK_REMOVAL_PLAN_MISSING path=" + logicalPath);
  }
  const parent = openRollbackRemovalParent(quarantine, logicalPath);
  let primaryFailure;
  try {
    const sourcePath = rollbackDescriptorChild(parent.descriptor, parent.name);
    const before = lstatSync(sourcePath, { bigint: true });
    const kind = rollbackRemovalKind(before);
    if (kind !== expectedKind || String(before.dev) !== quarantine.device
      || String(before.uid) !== quarantine.owner) {
      throw new Error("ROLLBACK_REMOVAL_TYPE_UNSAFE path=" + logicalPath);
    }
    const held = fstatSync(planned.descriptor, { bigint: true });
    assertRollbackRemovalIdentity(planned.identity, held, logicalPath);
    assertRollbackRemovalIdentity(before, held, logicalPath);
    if (expectedKind === "directory" && rollbackDirectoryHasEntries(planned.descriptor)) {
      throw new Error("ROLLBACK_FORBIDDEN_DIRECTORY_RESIDUE path=" + logicalPath);
    }
    if (quarantine.nextSlot >= ROLLBACK_REMOVAL_MAX_SLOTS) {
      throw new Error("ROLLBACK_REMOVAL_SLOT_LIMIT");
    }
    quarantine.nextSlot += 1;
    const stagedPath = rollbackDescriptorChild(
      quarantine.descriptor,
      "entry-" + String(quarantine.nextSlot).padStart(7, "0"),
    );
    onBoundary?.("before-rollback-removal-quarantine", {
      path: logicalPath,
      kind: expectedKind,
      sourcePath,
      stagedPath,
    });
    assertCustodyDescriptor(parent.descriptor);
    assertCustodyDescriptor(quarantine.descriptor);
    const atBoundary = lstatSync(sourcePath, { bigint: true });
    if (rollbackRemovalKind(atBoundary) !== expectedKind
      || String(atBoundary.dev) !== quarantine.device
      || String(atBoundary.uid) !== quarantine.owner) {
      throw new Error("ROLLBACK_REMOVAL_TYPE_UNSAFE path=" + logicalPath);
    }
    assertRollbackRemovalIdentity(
      atBoundary,
      fstatSync(planned.descriptor, { bigint: true }),
      logicalPath,
    );
    try {
      lstatSync(stagedPath);
      throw new Error("ROLLBACK_REMOVAL_DESTINATION_OCCUPIED path=" + logicalPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    renameSync(sourcePath, stagedPath);
    const staged = lstatSync(stagedPath, { bigint: true });
    assertRollbackRemovalIdentity(
      staged,
      fstatSync(planned.descriptor, { bigint: true }),
      logicalPath,
      { transition: true },
    );
    updateCustodyDescriptor(
      planned.descriptor,
      realpathSync(stagedPath),
      staged,
    );
    if (expectedKind === "directory" && rollbackDirectoryHasEntries(planned.descriptor)) {
      throw new Error("ROLLBACK_FORBIDDEN_DIRECTORY_RESIDUE path=" + logicalPath);
    }
    assertRollbackWorkspaceHandle(quarantine.workspaceHandle, quarantine.rootPath);
    quarantine.logicalPaths.push(logicalPath);
  } catch (error) {
    primaryFailure = error;
  }
  const failures = [];
  const plannedDescriptor = planned.descriptor;
  planned.descriptor = undefined;
  collectCustodyDescriptorCloseFailure(plannedDescriptor, failures);
  const parentDescriptor = parent.descriptor;
  parent.descriptor = undefined;
  collectCustodyDescriptorCloseFailure(parentDescriptor, failures);
  throwDescriptorCloseFailures(
    failures,
    "ROLLBACK_REMOVAL_STAGE_CLOSE_FAILED",
    primaryFailure,
  );
}

function openRollbackRemovalParent(quarantine, logicalPath) {
  validateExactPath(logicalPath, "removal");
  const components = logicalPath.split("/");
  if (components.length < 2 || components.length > ROLLBACK_PATH_MAX_DEPTH) {
    throw new Error("ROLLBACK_REMOVAL_PATH_DEPTH_UNSAFE path=" + logicalPath);
  }
  let descriptor = openSync(
    custodyDescriptorDirectory(quarantine.rootDescriptor),
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    registerCustodyDescriptor(
      descriptor, quarantine.workspaceHandle.checkoutPath, fstatSync(descriptor, { bigint: true }));
    for (const component of components.slice(0, -1)) {
      const candidate = rollbackDescriptorChild(descriptor, component);
      const before = lstatSync(candidate, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()
        || String(before.dev) !== quarantine.device
        || String(before.uid) !== quarantine.owner) {
        throw new Error("ROLLBACK_REMOVAL_ANCESTOR_UNSAFE path=" + logicalPath);
      }
      let next = openSync(
        candidate,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        assertRollbackRemovalIdentity(
          before,
          fstatSync(next, { bigint: true }),
          logicalPath,
        );
      } catch (error) {
        const closing = next;
        next = undefined;
        closeCustodyDescriptors(
          [closing],
          "ROLLBACK_REMOVAL_ACQUISITION_CLOSE_FAILED",
          error,
        );
      }
      registerCustodyDescriptor(next, realpathSync(candidate), before);
      const previous = descriptor;
      descriptor = next;
      next = undefined;
      closeCustodyDescriptors(
        [previous],
        "ROLLBACK_REMOVAL_TRAVERSAL_CLOSE_FAILED",
      );
    }
    const result = { descriptor, name: components.at(-1) };
    descriptor = undefined;
    return result;
  } catch (error) {
    const closing = descriptor;
    descriptor = undefined;
    closeCustodyDescriptors(
      [closing],
      "ROLLBACK_REMOVAL_TRAVERSAL_CLOSE_FAILED",
      error,
    );
  }
}

function rollbackRemovalKind(identity) {
  if (identity.isDirectory() && !identity.isSymbolicLink()) {
    return "directory";
  }
  if (identity.isFile() && !identity.isSymbolicLink()) {
    return "file";
  }
  return "unsafe";
}

function rollbackDirectoryHasEntries(descriptor) {
  const directory = opendirSync(custodyDescriptorDirectory(descriptor), {
    encoding: "buffer",
  });
  try {
    return directory.readSync() !== null;
  } finally {
    directory.closeSync();
  }
}

function assertRollbackRemovalIdentity(expected, actual, logicalPath, { transition = false } = {}) {
  try {
    if (!transition && expected.isFile?.() && actual.isFile?.()) {
      assertCustodyIdentity(expected, actual);
    } else {
      assertCustodyStableObject(expected, actual);
    }
  } catch (error) {
    throw new Error("ROLLBACK_REMOVAL_SUBSTITUTED path=" + logicalPath, { cause: error });
  }
}
