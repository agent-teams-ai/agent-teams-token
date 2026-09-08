import { createHash } from "node:crypto";

import {
  assertExactCleanCandidate,
  assertInventoryEqual,
  basicRun,
  captureCleanupTreeSnapshot,
  gitExecutable,
  trackedCandidateInventory,
} from "../proof-runtime.mjs";
import {
  repositoryRoot,
  rollbackTemporaryRoot,
} from "./config.mjs";
import { applyManifest } from "./apply-manifest.mjs";
import { finalizeRollbackTemporaryParent } from "./gate-execution.mjs";
import { verifyAppliedState } from "./gate-contract.mjs";
import {
  snapshotRollbackSharedPaths,
} from "./shared-paths.mjs";
import { hashRollbackSharedOrAbsent } from "./shared-file-operations.mjs";
import { createRollbackProofWorkspace } from "./proof-workspace.mjs";

function run(command, commandArguments, options = {}) {
  return basicRun(command === "git" ? gitExecutable() : command, commandArguments, {
    ...options,
    cwd: options.cwd ?? repositoryRoot,
  });
}

export function printReverseHashes(manifest, candidateSha, candidateInventory) {
  const workspace = createRollbackProofWorkspace({
    temporaryRoot: rollbackTemporaryRoot,
    targetPrefix: "agtmai-rollback-hashes-" + manifest.sliceId + "-",
  });
  const {
    checkout,
    cleanupHandle,
    workspaceHandle,
  } = workspace;
  let failure;
  try {
    run("git", [
      "clone", "--local", "--no-hardlinks", "--no-checkout", repositoryRoot, checkout,
    ]);
    run("git", ["checkout", "--detach", "--force", candidateSha], { cwd: checkout });
    assertExactCleanCandidate(checkout, candidateSha);
    assertInventoryEqual(candidateInventory, trackedCandidateInventory(checkout, candidateSha));
    const beforePlan = snapshotRollbackSharedPaths(
      checkout,
      manifest.sharedPaths,
      workspaceHandle,
    );
    const before = Object.fromEntries(
      manifest.sharedPaths.map((path) => [
        path,
        hashRollbackSharedOrAbsent(checkout, path, beforePlan, workspaceHandle),
      ]),
    );
    applyManifest(checkout, manifest, {
      verifyDeclaredDigests: false,
      workspaceHandle,
    });
    verifyAppliedState(checkout, manifest, { workspaceHandle });
    const afterPlan = snapshotRollbackSharedPaths(
      checkout,
      manifest.sharedPaths,
      workspaceHandle,
    );
    const reverseEdits = manifest.sharedPaths.map((path) => ({
      path,
      beforeSha256: before[path],
      afterSha256: hashRollbackSharedOrAbsent(checkout, path, afterPlan, workspaceHandle),
    }));
    process.stdout.write(JSON.stringify(reverseEdits, null, 2) + "\n");
    captureCleanupTreeSnapshot(cleanupHandle);
  } catch (error) {
    failure = error;
  }
  const finalized = finalizeRollbackTemporaryParent({
    cleanupHandle,
    workspaceHandle,
    primaryFailure: failure,
  });
  failure = finalized.primaryFailure;
  if (finalized.cleanupFailure !== undefined) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, finalized.cleanupFailure],
        "hash calculation and cleanup failed",
      );
    }
    throw finalized.cleanupFailure;
  }
  if (failure !== undefined) {
    throw failure;
  }
}

export function manifestFingerprint(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
