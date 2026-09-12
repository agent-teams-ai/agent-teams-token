import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { basicRun, gitExecutable } from "../runtime/candidate.mjs";
import { repositoryRoot, sliceRoots } from "./config.mjs";
import { requireArray, validateExactPath } from "./manifests.mjs";
import {
  closeRollbackRemovalQuarantine,
  createRollbackRemovalQuarantine,
  orderedRemovableDirectories,
  removeOwnedEmptyDirectoriesWithQuarantine,
  runRollbackRemovalPhase,
  snapshotRollbackRemovalPlan,
  stageRollbackRemoval,
} from "./removal-quarantine.mjs";
import {
  closeRollbackSharedPlan,
  snapshotRollbackSharedPaths,
} from "./shared-paths.mjs";
import {
  hashRollbackSharedOrAbsent,
  markRollbackSharedPathAbsent,
  restoreRollbackSharedFile,
} from "./shared-file-operations.mjs";
import {
  editPackage,
  editToolchain,
  editWorkflowTest,
  removeWorkflowJob,
  restoreArchitectureBoundaries,
} from "./transforms.mjs";

function run(command, commandArguments, options = {}) {
  return basicRun(command === "git" ? gitExecutable() : command, commandArguments, {
    ...options,
    cwd: options.cwd ?? repositoryRoot,
  });
}

function validateRollbackOperationManifest(manifest, { requireApplyFields = false } = {}) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("ROLLBACK_OPERATION_MANIFEST_INVALID");
  }
  if (typeof manifest.sliceId !== "string" || !/^[a-z0-9-]{1,64}$/u.test(manifest.sliceId)) {
    throw new Error("ROLLBACK_REMOVAL_SLICE_INVALID");
  }
  validateExactPath(manifest.ownedRoot, manifest.sliceId + ":ownedRoot");
  const pathArrays = [
    ["ownedPaths", requireArray(manifest.ownedPaths, manifest.sliceId + ":ownedPaths")],
    [
      "restoreFromBaseline",
      requireArray(manifest.restoreFromBaseline, manifest.sliceId + ":restoreFromBaseline"),
    ],
  ];
  if (requireApplyFields) {
    pathArrays.push([
      "sharedPaths",
      requireArray(manifest.sharedPaths, manifest.sliceId + ":sharedPaths"),
    ]);
    const reverseEdits = requireArray(
      manifest.reverseEdits,
      manifest.sliceId + ":reverseEdits",
    );
    for (const [index, edit] of reverseEdits.entries()) {
      if (edit === null || typeof edit !== "object" || Array.isArray(edit)) {
        throw new Error(
          "ROLLBACK_OPERATION_MANIFEST_INVALID field=reverseEdits index=" + String(index),
        );
      }
      validateExactPath(edit.path, manifest.sliceId + ":reverseEdits");
    }
  }
  for (const [field, paths] of pathArrays) {
    for (const path of paths) {
      validateExactPath(path, manifest.sliceId + ":" + field);
    }
  }
}

export function removeOwnedEmptyDirectories(root, manifest, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !["onBoundary", "workspaceHandle"].includes(key))
    || (options.onBoundary !== undefined && typeof options.onBoundary !== "function")) {
    throw new Error("ROLLBACK_REMOVAL_OPTIONS_INVALID");
  }
  validateRollbackOperationManifest(manifest);
  const orderedDirectories = runRollbackRemovalPhase(
    "plan-empty-directories",
    () => orderedRemovableDirectories(manifest),
  );
  const quarantine = createRollbackRemovalQuarantine(root, manifest, options);
  let result;
  let primaryFailure;
  try {
    snapshotRollbackRemovalPlan(
      quarantine,
      orderedDirectories.map((path) => ({ path, kind: "directory" })),
    );
    result = removeOwnedEmptyDirectoriesWithQuarantine(root, manifest, quarantine, {
      ...options,
      orderedDirectories,
    });
  } catch (error) {
    primaryFailure = error;
  }
  closeRollbackRemovalQuarantine(quarantine, primaryFailure);
  return result;
}

export function applyManifest(root, manifest, options = {}) {
  validateApplyOptions(options);
  const context = {
    root,
    manifest,
    onBoundary: options.onBoundary,
    verifyDeclaredDigests: options.verifyDeclaredDigests ?? true,
    workspaceHandle: options.workspaceHandle,
  };
  validateRollbackOperationManifest(manifest, { requireApplyFields: true });
  context.sharedPlan = snapshotRollbackSharedPaths(
    root,
    manifest.sharedPaths,
    context.workspaceHandle,
    { holdDescriptors: true },
  );
  let result;
  let primaryFailure;
  try {
    result = applyManifestWithSharedPlan(context);
  } catch (error) {
    primaryFailure = error;
  }
  closeRollbackSharedPlan(context.sharedPlan, primaryFailure);
  return result;
}

function validateApplyOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => ![
      "onBoundary", "verifyDeclaredDigests", "workspaceHandle",
    ].includes(key))
    || (options.verifyDeclaredDigests !== undefined
      && typeof options.verifyDeclaredDigests !== "boolean")
    || (options.onBoundary !== undefined && typeof options.onBoundary !== "function")) {
    throw new Error("ROLLBACK_APPLY_OPTIONS_INVALID");
  }
}

function applyManifestWithSharedPlan(context) {
  assertDeclaredSharedDigests(context, "beforeSha256", "ROLLBACK_SHARED_EDIT_SOURCE_DRIFT");
  context.orderedDirectories = runRollbackRemovalPhase(
    "plan-empty-directories",
    () => orderedRemovableDirectories(context.manifest),
  );
  context.additionalRemoval = additionalRemovalPaths(context.manifest.sliceId);
  const removalPlan = [
    ...context.manifest.ownedPaths.map((path) => ({ path, kind: "file" })),
    ...context.additionalRemoval.map((path) => ({ path, kind: "file" })),
    ...context.orderedDirectories.map((path) => ({ path, kind: "directory" })),
  ];
  const quarantine = createRollbackRemovalQuarantine(context.root, context.manifest, {
    workspaceHandle: context.workspaceHandle,
    onBoundary: context.onBoundary,
  });
  let result;
  let primaryFailure;
  try {
    snapshotRollbackRemovalPlan(quarantine, removalPlan);
    result = applyManifestInQuarantine(context, quarantine);
  } catch (error) {
    primaryFailure = error;
  }
  closeRollbackRemovalQuarantine(quarantine, primaryFailure);
  return result;
}

function applyManifestInQuarantine(context, quarantine) {
  stageRemovalPaths(
    quarantine,
    context.manifest.ownedPaths,
    context.onBoundary,
  );
  applySharedEdits(context);
  stageRemovalPaths(
    quarantine,
    context.additionalRemoval,
    context.onBoundary,
    (path) => markRollbackSharedPathAbsent(context.sharedPlan, path),
  );
  restoreBaselinePaths(context);
  const directoryCleanup = removeOwnedEmptyDirectoriesWithQuarantine(
    context.root,
    context.manifest,
    quarantine,
    { onBoundary: context.onBoundary, orderedDirectories: context.orderedDirectories },
  );
  restoreSliceSourceBoundaryDirectories(context.root, context.manifest.sliceId);
  assertDeclaredSharedDigests(context, "afterSha256", "ROLLBACK_SHARED_EDIT_RESULT_DRIFT");
  return rollbackApplicationReport(quarantine, directoryCleanup);
}

function stageRemovalPaths(quarantine, paths, onBoundary, afterStage) {
  for (const path of paths) {
    stageRollbackRemoval(quarantine, path, "file", onBoundary);
    afterStage?.(path);
  }
}

function applySharedEdits(context) {
  const { root, manifest, sharedPlan, workspaceHandle } = context;
  runRollbackRemovalPhase("shared-edits", () => {
    restoreArchitectureBoundaries(root, manifest, sharedPlan, workspaceHandle);
    editPackage(root, manifest.sliceId, { sharedPlan, workspaceHandle });
    removeWorkflowJob(root, manifest, sharedPlan, workspaceHandle);
    editWorkflowTest(root, manifest, sharedPlan, workspaceHandle);
    if (manifest.sharedPaths.includes("tooling/toolchain.lock.json")) {
      editToolchain(root, manifest.sliceId, sharedPlan, workspaceHandle);
    }
  });
}

function restoreBaselinePaths(context) {
  const { root, manifest, sharedPlan, workspaceHandle } = context;
  runRollbackRemovalPhase("baseline-restoration", () => {
    for (const path of manifest.restoreFromBaseline) {
      const content = run("git", ["show", `${manifest.baselineSha}:${path}`], { cwd: root });
      restoreRollbackSharedFile(root, path, sharedPlan, workspaceHandle, content);
    }
  });
}

function restoreSliceSourceBoundaryDirectories(root, sliceId) {
  const ownedRoot = sliceRoots[sliceId];
  if (typeof ownedRoot !== "string") {
    throw new Error("ROLLBACK_SLICE_SOURCE_ROOT_UNKNOWN slice=" + sliceId);
  }
  runRollbackRemovalPhase("source-boundary-directories", () => {
    for (const layer of ["domain", "application", "adapters", "composition"]) {
      mkdirSync(join(root, ownedRoot, "src", layer), { recursive: true });
    }
  });
}

function assertDeclaredSharedDigests(context, field, code) {
  if (!context.verifyDeclaredDigests) {
    return;
  }
  const { root, manifest, sharedPlan, workspaceHandle } = context;
  for (const edit of manifest.reverseEdits) {
    if (hashRollbackSharedOrAbsent(root, edit.path, sharedPlan, workspaceHandle) !== edit[field]) {
      throw new Error(`${code} slice=${manifest.sliceId} path=${edit.path}`);
    }
  }
}

function additionalRemovalPaths(sliceId) {
  if (sliceId === "slither") {
    return [];
  }
  return [sliceId === "local-solana"
    ? "scripts/solana/local-fixture.ts"
    : "scripts/deployment/estimate-local.ts"];
}

function rollbackApplicationReport(quarantine, directoryCleanup) {
  const quarantinedPaths = [...quarantine.logicalPaths].toSorted();
  return {
    directoryCleanup,
    quarantinedPathCount: quarantinedPaths.length,
    quarantinedPaths,
    quarantinedPathsSha256: createHash("sha256")
      .update(Buffer.from(JSON.stringify(quarantinedPaths), "utf8"))
      .digest("hex"),
  };
}
