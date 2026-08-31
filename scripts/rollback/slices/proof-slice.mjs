import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";

import {
  assertExactCleanCandidate,
  assertExactDirectoryShape,
  assertGitStatusSnapshotEqual,
  assertInventoryEqual,
  assertPathsAbsent,
  captureCleanupTreeSnapshot,
  captureGitStatusSnapshot,
  copyAndInstallOfflineEnvironment,
  createCleanupHandle,
  gitExecutable,
  toolPath,
  trackedCandidateInventory,
} from "../proof-runtime.mjs";
import { applyManifest } from "./apply-manifest.mjs";
import {
  applyExactSliceState,
  gateCoverageSnapshot,
  materializeCandidateCheckout,
  syntheticRollbackCommit,
  verifyAppliedState,
} from "./gate-contract.mjs";
import {
  finalizeRollbackTemporaryParent,
} from "./gate-execution.mjs";
import { manifestFingerprint } from "./manifest-proof.mjs";
import { executeSliceGates } from "./proof-gates.mjs";
import {
  repositoryRoot,
  rollbackTemporaryRoot,
} from "./config.mjs";
import {
  assertRollbackWorkspaceHandle,
  createRollbackWorkspaceHandle,
} from "./workspace-handle.mjs";

export function proveSlice({
  manifest,
  manifestArtifact,
  candidateSha,
  candidateInventory,
  recorder,
  runGates,
}) {
  const context = createSliceContext({
    manifest,
    manifestArtifact,
    candidateSha,
    candidateInventory,
    recorder,
    runGates,
  });
  let primaryFailure;
  try {
    const preState = prepareSlicePreState(context);
    applyCandidateSlice(context);
    executeRollback(context, preState);
    if (runGates) {
      executeSliceGates(context, preState.identity);
    }
    context.record.cleanup.snapshot = captureCleanupTreeSnapshot(context.cleanupHandle);
    recorder.update(() => {});
  } catch (error) {
    primaryFailure = recordSliceFailure(context, error);
  }
  finalizeSlice(context, primaryFailure);
}

function createSliceContext(input) {
  const group = input.manifest.sliceId;
  const temporaryParent = mkdtempSync(join(rollbackTemporaryRoot, "agtmai-rollback-" + group + "-"));
  chmodSync(temporaryParent, 0o700);
  const cleanupHandle = createCleanupHandle(temporaryParent, {
    temporaryRoot: rollbackTemporaryRoot,
    targetPrefix: "agtmai-rollback-" + group + "-",
    allowedEntries: ["checkout", "gate-tmp"],
  });
  const checkout = join(temporaryParent, "checkout");
  const gateTemporaryDirectory = join(temporaryParent, "gate-tmp");
  mkdirSync(gateTemporaryDirectory, { mode: 0o700 });
  const record = {
    sliceId: group,
    manifestSha256: manifestFingerprint(input.manifest),
    manifest: input.manifestArtifact,
    candidateSha: input.candidateSha,
    status: "preparing",
    cleanup: { status: "pending", device: cleanupHandle.device, inode: cleanupHandle.inode },
  };
  input.recorder.update((document) => {
    document.slices.push(record);
  });
  return {
    ...input,
    checkout,
    cleanupHandle,
    gateTemporaryDirectory,
    group,
    record,
    workspaceHandle: undefined,
  };
}

function prepareSlicePreState(context) {
  const {
    candidateInventory,
    candidateSha,
    checkout,
    group,
    manifest,
    recorder,
    record,
  } = context;
  const checkoutInventory = materializeCandidateCheckout({
    checkout,
    candidateSha,
    candidateInventory,
    recorder,
    group,
  });
  context.workspaceHandle = createRollbackWorkspaceHandle(checkout, context.gateTemporaryDirectory);
  record.workspaceIdentity = assertRollbackWorkspaceHandle(context.workspaceHandle, checkout);
  const environment = copyAndInstallOfflineEnvironment({
    sourceRoot: repositoryRoot,
    checkout,
    recorder,
    group,
  });
  record.checkoutInventory = inventoryFacts(checkoutInventory);
  record.offlineEnvironment = {
    platform: environment.platform,
    store: environment.store,
    copiedArchives: environment.copiedArchives,
    workspaceLinks: environment.workspaceLinks,
  };
  recorder.update(() => {});
  validateCandidateStructure(context, environment);
  recorder.stage(
    group,
    "derive-declared-pre-state",
    () => applyManifest(checkout, manifest, { workspaceHandle: context.workspaceHandle }),
    (result) => result,
  );
  recorder.stage(
    group,
    "verify-declared-pre-state",
    () => verifyAppliedState(checkout, manifest, { workspaceHandle: context.workspaceHandle }),
  );
  return capturePreState(context);
}

function validateCandidateStructure(context, environment) {
  const { candidateSha, checkout, group, recorder } = context;
  recorder.run(
    group,
    "rollback-structural-candidate",
    environment.tools.node,
    ["--test", "scripts/tests/rollback-proof.test.mjs"],
    {
      cwd: checkout,
      env: { ...process.env, PATH: toolPath(environment.tools) },
      phase: "candidate-validation",
      timeout: 120_000,
    },
  );
  recorder.stage(
    group,
    "candidate-clean-before-pre-state-derivation",
    () => assertExactCleanCandidate(checkout, candidateSha),
    (sha) => ({ sha }),
  );
}

function capturePreState(context) {
  const { checkout, group, manifest, recorder, record } = context;
  const status = recorder.stage(
    group,
    "capture-pre-state-status",
    () => captureGitStatusSnapshot(checkout),
    ({ byteLength, sha256 }) => ({ byteLength, sha256 }),
  );
  const statusArtifact = recorder.writeArtifact(
    "slices/" + group + "/pre-state-status.v1.json",
    status,
  );
  const residue = recorder.stage(
    group,
    "pre-state-forbidden-residue-absent",
    () => assertPathsAbsent(checkout, manifest.ownedPaths, group + ":pre-state"),
    (result) => result,
  );
  const shape = captureOwnedRootShape(context, "pre-state-owned-root-shape", "pre-state");
  const identity = syntheticRollbackCommit(
    checkout,
    manifest,
    context.candidateSha,
    recorder,
    group,
  );
  const inventory = recorder.stage(
    group,
    "capture-pre-state-complete-inventory",
    () => trackedCandidateInventory(checkout, identity.sha),
    inventoryFacts,
  );
  const inventoryArtifact = recorder.writeArtifact(
    "slices/" + group + "/pre-state-inventory.v1.json",
    inventory,
  );
  record.preState = {
    sha: identity.sha,
    tree: identity.tree,
    status: statusArtifact,
    statusSha256: status.sha256,
    inventory: inventoryArtifact,
    ...inventoryFacts(inventory),
    inventorySha256: inventory.sha256,
    forbiddenResidue: residue,
    ownedRootShape: shape,
  };
  record.status = "applying-slice";
  recorder.update(() => {});
  return { status, identity, inventory };
}

function applyCandidateSlice(context) {
  const { candidateInventory, candidateSha, checkout, group, manifest, recorder, record } = context;
  const applied = recorder.stage(
    group,
    "apply-slice-from-captured-pre-state",
    () => applyExactSliceState(
      checkout,
      manifest,
      candidateSha,
      candidateInventory.tree,
      recorder,
      group,
    ),
    (result) => result,
  );
  recorder.run(group, "bind-applied-slice-to-candidate", gitExecutable(), [
    "reset",
    "--hard",
    candidateSha,
  ], { cwd: checkout, timeout: 60_000 });
  recorder.stage(
    group,
    "verify-applied-slice-clean-candidate",
    () => assertExactCleanCandidate(checkout, candidateSha),
    (sha) => ({ sha }),
  );
  recorder.stage(
    group,
    "verify-applied-slice-byte-equivalence",
    () => assertInventoryEqual(
      candidateInventory,
      trackedCandidateInventory(checkout, candidateSha),
      group + ":applied-slice",
    ),
  );
  record.application = {
    candidateSha,
    tree: applied.tree,
    pathCount: applied.pathCount,
    pathsSha256: applied.pathsSha256,
    byteEquivalentToCandidate: true,
  };
  record.status = "executing-rollback";
  recorder.update(() => {});
}

function executeRollback(context, preState) {
  const { checkout, group, manifest, recorder, record, workspaceHandle } = context;
  recorder.stage(
    group,
    "execute-production-rollback",
    () => applyManifest(checkout, manifest, { workspaceHandle }),
    (result) => result,
  );
  recorder.stage(
    group,
    "verify-executed-rollback-state",
    () => verifyAppliedState(checkout, manifest, { workspaceHandle }),
  );
  const status = captureRollbackStatus(context, preState.status);
  const observed = captureRollbackTreeAndInventory(context, preState);
  record.rollback = {
    sha: preState.identity.sha,
    tree: observed.tree,
    status: status.artifact,
    statusSha256: status.snapshot.sha256,
    inventory: observed.artifact,
    ...inventoryFacts(observed.inventory),
    inventorySha256: observed.inventory.sha256,
    forbiddenResidue: observed.residue,
    ownedRootShape: observed.shape,
    statusEquivalentToPreState: true,
    treeEquivalentToPreState: true,
    inventoryEquivalentToPreState: true,
  };
  record.status = context.runGates ? "proving" : "prepared";
  recorder.update(() => {});
}

function captureRollbackStatus(context, expectedStatus) {
  const { checkout, group, recorder } = context;
  const snapshot = recorder.stage(
    group,
    "capture-executed-rollback-status",
    () => captureGitStatusSnapshot(checkout),
    ({ byteLength, sha256 }) => ({ byteLength, sha256 }),
  );
  const artifact = recorder.writeArtifact(
    "slices/" + group + "/executed-rollback-status.v1.json",
    snapshot,
  );
  recorder.stage(
    group,
    "verify-rollback-status-equivalence",
    () => assertGitStatusSnapshotEqual(expectedStatus, snapshot, group),
    () => ({ sha256: snapshot.sha256 }),
  );
  return { snapshot, artifact };
}

function captureRollbackTreeAndInventory(context, preState) {
  const { checkout, group, manifest, recorder } = context;
  const residue = recorder.stage(
    group,
    "verify-rollback-forbidden-residue-absent",
    () => assertPathsAbsent(checkout, manifest.ownedPaths, group + ":executed-rollback"),
    (result) => result,
  );
  const shape = captureOwnedRootShape(
    context,
    "verify-rollback-owned-root-shape",
    "executed-rollback",
  );
  recorder.run(group, "git-add-executed-rollback-state", gitExecutable(), ["add", "-A"], {
    cwd: checkout,
    timeout: 60_000,
  });
  const tree = recorder.run(
    group,
    "git-write-executed-rollback-tree",
    gitExecutable(),
    ["write-tree"],
    { cwd: checkout, timeout: 60_000 },
  ).stdout.trim();
  assertRollbackTree(context, preState.identity.tree, tree);
  recorder.run(group, "bind-executed-rollback-to-pre-state", gitExecutable(), [
    "reset",
    "--hard",
    preState.identity.sha,
  ], { cwd: checkout, timeout: 60_000 });
  recorder.stage(
    group,
    "verify-executed-rollback-clean-pre-state",
    () => assertExactCleanCandidate(checkout, preState.identity.sha),
    (sha) => ({ sha }),
  );
  const inventory = recorder.stage(
    group,
    "capture-executed-rollback-complete-inventory",
    () => trackedCandidateInventory(checkout, preState.identity.sha),
    inventoryFacts,
  );
  recorder.stage(
    group,
    "verify-rollback-inventory-equivalence",
    () => assertInventoryEqual(preState.inventory, inventory, group + ":executed-rollback"),
  );
  const artifact = recorder.writeArtifact(
    "slices/" + group + "/executed-rollback-inventory.v1.json",
    inventory,
  );
  return { artifact, inventory, residue, shape, tree };
}

function assertRollbackTree(context, expectedTree, actualTree) {
  context.recorder.stage(
    context.group,
    "verify-rollback-byte-tree-equivalence",
    () => {
      if (actualTree !== expectedTree) {
        throw new Error(
          "ROLLBACK_PRE_STATE_TREE_MISMATCH slice=" + context.group
          + " expected=" + expectedTree + " actual=" + actualTree,
        );
      }
    },
    () => ({ tree: actualTree }),
  );
}

function captureOwnedRootShape(context, stage, label) {
  const { checkout, group, manifest, recorder } = context;
  return recorder.stage(
    group,
    stage,
    () => assertExactDirectoryShape(
      checkout,
      manifest.ownedRoot,
      manifest.restoreFromBaseline,
      group + ":" + label,
    ),
    (result) => result,
  );
}

function recordSliceFailure(context, error) {
  if (context.runGates) {
    context.record.gateCoverage = gateCoverageSnapshot(
      context.recorder.document.commands,
      context.manifest,
    );
  }
  context.record.status = "failed";
  context.record.error = error instanceof Error ? error.message : String(error);
  context.recorder.update(() => {});
  return error;
}

function finalizeSlice(context, primaryFailure) {
  const finalized = finalizeRollbackTemporaryParent({
    cleanupHandle: context.cleanupHandle,
    workspaceHandle: context.workspaceHandle,
    primaryFailure,
  });
  const effectiveFailure = finalized.primaryFailure;
  const cleanupFailure = finalized.cleanupFailure;
  context.record.cleanup = { ...context.record.cleanup, ...finalized.cleanup };
  const failure = effectiveFailure ?? cleanupFailure;
  if (failure !== undefined) {
    context.record.status = "failed";
    context.record.error = failure instanceof Error ? failure.message : String(failure);
  }
  context.recorder.update(() => {});
  if (effectiveFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [effectiveFailure, cleanupFailure],
      "rollback proof and identity-bound cleanup both failed for " + context.group,
    );
  }
  if (effectiveFailure !== undefined) {
    throw effectiveFailure;
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }
}

function inventoryFacts(inventory) {
  return {
    tree: inventory.tree,
    sha256: inventory.sha256,
    entryCount: inventory.entryCount,
    totalBytes: inventory.totalBytes,
  };
}
