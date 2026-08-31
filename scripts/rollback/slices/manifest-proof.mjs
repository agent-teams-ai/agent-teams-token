import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";

import {
  assertExactCleanCandidate,
  assertInventoryEqual,
  basicRun,
  captureCleanupTreeSnapshot,
  createCleanupHandle,
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
import { createRollbackWorkspaceHandle } from "./workspace-handle.mjs";

function run(command, commandArguments, options = {}) {
  return basicRun(command === "git" ? gitExecutable() : command, commandArguments, {
    ...options,
    cwd: options.cwd ?? repositoryRoot,
  });
}

export function printReverseHashes(manifest, candidateSha, candidateInventory) {
  const temporaryParent = mkdtempSync(
    join(rollbackTemporaryRoot, "agtmai-rollback-hashes-" + manifest.sliceId + "-"),
  );
  chmodSync(temporaryParent, 0o700);
  const cleanupHandle = createCleanupHandle(temporaryParent, {
    temporaryRoot: rollbackTemporaryRoot,
    targetPrefix: "agtmai-rollback-hashes-" + manifest.sliceId + "-",
    allowedEntries: ["checkout", "gate-tmp"],
  });
  const checkout = join(temporaryParent, "checkout");
  const quarantineRoot = join(temporaryParent, "gate-tmp");
  mkdirSync(quarantineRoot, { mode: 0o700 });
  let failure;
  let workspaceHandle;
  try {
    run("git", [
      "clone", "--local", "--no-hardlinks", "--no-checkout", repositoryRoot, checkout,
    ]);
    run("git", ["checkout", "--detach", "--force", candidateSha], { cwd: checkout });
    assertExactCleanCandidate(checkout, candidateSha);
    assertInventoryEqual(candidateInventory, trackedCandidateInventory(checkout, candidateSha));
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
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
