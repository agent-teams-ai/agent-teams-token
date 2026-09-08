import { closeSync } from "node:fs";

import * as proofSupport from "./proof-fixture.mjs";
import {
  assertRollbackSharedFinal,
  assertRollbackSharedStableAncestorIdentity,
  openRollbackSharedParent,
  rollbackSharedIdentity,
  snapshotRollbackSharedPaths,
} from "../slices/shared-paths.mjs";
const { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture } = proofSupport;
export { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture };
const { cloneRepository } = proofSupport;

test("shared path ancestors tolerate an actually retained sibling", () => {
  const boundary = temporaryDirectory("agtmai-rollback-shared-sibling-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  const sharedDirectory = join(checkout, "shared");
  let workspaceHandle;
  let parent;
  try {
    mkdirSync(sharedDirectory, { recursive: true });
    writeFileSync(join(sharedDirectory, "target.txt"), "target\n");
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    const plan = snapshotRollbackSharedPaths(
      checkout,
      ["shared/target.txt"],
      workspaceHandle,
    );
    mkdirSync(join(sharedDirectory, "retained-sibling"));
    const actual = lstatSync(sharedDirectory, { bigint: true });
    const captured = rollbackSharedIdentity(actual);
    assert.throws(
      () => assertRollbackSharedStableAncestorIdentity(
        { ...captured, gid: String(actual.gid + 1n) }, actual, "shared/target.txt",
      ),
      /ROLLBACK_SHARED_PATH_SUBSTITUTED/u,
    );
    parent = openRollbackSharedParent(
      checkout,
      "shared/target.txt",
      plan,
      workspaceHandle,
    );
    assert.doesNotThrow(() => assertRollbackSharedFinal(parent));
    assert.equal(lstatSync(join(sharedDirectory, "retained-sibling")).isDirectory(), true);
  } finally {
    if (parent !== undefined) {
      closeSync(parent.descriptor);
    }
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("shared rollback edits reject an ancestor symlink swap and preserve composed evidence", () => {
  const temporaryRoot = temporaryDirectory("agtmai-rollback-shared-swap-root-");
  const temporaryParent = mkdtempSync(join(
    temporaryRoot,
    "agtmai-rollback-deployment-plan-",
  ));
  chmodSync(temporaryParent, 0o700);
  const checkout = join(temporaryParent, "checkout");
  const quarantineRoot = join(temporaryParent, "gate-tmp");
  const outside = join(temporaryRoot, "outside-foundation");
  const outsideSentinel = join(outside, "source-dependencies.yaml");
  const sharedAncestor = join(checkout, "architecture/foundation");
  const heldAncestor = join(checkout, "architecture/foundation.held-original");
  const manifest = manifests().find(({ sliceId }) => sliceId === "deployment-plan");
  let cleanupHandle;
  let workspaceHandle;
  let finalized = false;
  try {
    cloneRepository(repositoryRoot, checkout, temporaryParent);
    copyCurrentRollbackSharedState(checkout, manifest);
    mkdirSync(quarantineRoot, { mode: 0o700 });
    mkdirSync(outside);
    writeFileSync(outsideSentinel, "outside-must-not-change\n");
    cleanupHandle = createCleanupHandle(temporaryParent, {
      temporaryRoot,
      targetPrefix: "agtmai-rollback-deployment-plan-",
      allowedEntries: ["checkout", "gate-tmp"],
    });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    let primaryFailure;
    let swapped = false;
    assert.throws(
      () => applyManifest(checkout, manifest, {
        verifyDeclaredDigests: false,
        workspaceHandle,
        onBoundary(name) {
          if (swapped || name !== "before-rollback-removal-quarantine") {
            return;
          }
          swapped = true;
          renameSync(sharedAncestor, heldAncestor);
          symlinkSync(outside, sharedAncestor, "dir");
        },
      }),
      (error) => {
        primaryFailure = error;
        return /ROLLBACK_REMOVAL_PHASE_FAILED phase=shared-edits/u.test(error.message)
          && /ROLLBACK_SHARED_PATH_(?:SUBSTITUTED|TYPE_UNSAFE)/u.test(error.message);
      },
    );
    const result = finalizeRollbackTemporaryParent({
      cleanupHandle,
      workspaceHandle,
      primaryFailure,
    });
    finalized = true;
    assert.equal(result.primaryFailure, primaryFailure);
    assert.equal(result.cleanupFailure, undefined);
    assert.equal(result.cleanup.status, "preserved");
    assert.equal(result.cleanup.result.result, "preserved");
    assert.equal(readFileSync(outsideSentinel, "utf8"), "outside-must-not-change\n");
    assert.equal(existsSync(temporaryParent), true);
    assert.equal(lstatSync(sharedAncestor).isSymbolicLink(), true);
    assert.equal(lstatSync(heldAncestor).isDirectory(), true);
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    if (cleanupHandle !== undefined && !finalized) {
      abandonCleanupHandle(cleanupHandle);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("persistent rollback workspace rejects whole-checkout and gate-tmp replacement", () => {
  const manifest = {
    sliceId: "fixture-slice",
    ownedRoot: "slice",
    ownedPaths: ["slice/owned/file.txt"],
    restoreFromBaseline: [],
  };
  for (const replacement of ["checkout", "gate-tmp"]) {
    const boundary = temporaryDirectory("agtmai-rollback-workspace-replacement-");
    const checkout = join(boundary, "checkout");
    const quarantineRoot = join(boundary, "gate-tmp");
    const held = join(boundary, replacement + ".held-original");
    let workspaceHandle;
    try {
      mkdirSync(join(checkout, "slice/owned"), { recursive: true });
      mkdirSync(quarantineRoot, { mode: 0o700 });
      workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
      if (replacement === "checkout") {
        renameSync(checkout, held);
        mkdirSync(join(checkout, "slice/owned"), { recursive: true });
      } else {
        renameSync(quarantineRoot, held);
        mkdirSync(quarantineRoot, { mode: 0o700 });
      }
      assert.throws(
        () => removeOwnedEmptyDirectories(checkout, manifest, { workspaceHandle }),
        /ROLLBACK_REMOVAL_WORKSPACE_SUBSTITUTED/u,
        replacement,
      );
      assert.equal(lstatSync(held).isDirectory(), true);
      assert.equal(
        lstatSync(replacement === "checkout" ? checkout : quarantineRoot).isDirectory(),
        true,
      );
      if (replacement === "checkout") {
        assert.equal(lstatSync(join(held, "slice/owned")).isDirectory(), true);
        assert.equal(lstatSync(join(checkout, "slice/owned")).isDirectory(), true);
      }
    } finally {
      closeRollbackWorkspaceHandle(workspaceHandle);
      rmSync(boundary, { recursive: true, force: true });
    }
  }
});

test("rollback removal refuses a destination injected after its boundary hook", () => {
  const boundary = temporaryDirectory("agtmai-rollback-destination-injection-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  const manifest = {
    sliceId: "fixture-slice",
    ownedRoot: "slice",
    ownedPaths: ["slice/owned/file.txt"],
    restoreFromBaseline: [],
  };
  let workspaceHandle;
  let injectedPath;
  try {
    mkdirSync(join(checkout, "slice/owned"), { recursive: true });
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    assert.throws(
      () => removeOwnedEmptyDirectories(checkout, manifest, {
        workspaceHandle,
        onBoundary(name, details) {
          if (name !== "before-rollback-removal-quarantine") {
            return;
          }
          injectedPath = join(realpathSync(dirname(details.stagedPath)), basename(details.stagedPath));
          mkdirSync(details.stagedPath);
        },
      }),
      /ROLLBACK_REMOVAL_DESTINATION_OCCUPIED/u,
    );
    assert.equal(lstatSync(join(checkout, "slice/owned")).isDirectory(), true);
    assert.equal(lstatSync(injectedPath).isDirectory(), true);
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("production finalization preserves the temporary parent after removal identity failure", () => {
  const temporaryRoot = temporaryDirectory("agtmai-rollback-preservation-root-");
  const temporaryParent = mkdtempSync(join(temporaryRoot, "agtmai-rollback-deployment-plan-"));
  chmodSync(temporaryParent, 0o700);
  const checkout = join(temporaryParent, "checkout");
  const quarantineRoot = join(temporaryParent, "gate-tmp");
  const manifest = {
    sliceId: "fixture-slice",
    ownedRoot: "slice",
    ownedPaths: ["slice/owned/file.txt"],
    restoreFromBaseline: [],
  };
  let cleanupHandle;
  let workspaceHandle;
  let finalized = false;
  let heldOriginal;
  let stagedReplacement;
  try {
    cleanupHandle = createCleanupHandle(temporaryParent, {
      temporaryRoot,
      targetPrefix: "agtmai-rollback-deployment-plan-",
      allowedEntries: ["checkout", "gate-tmp"],
    });
    mkdirSync(join(checkout, "slice/owned"), { recursive: true });
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    let primaryFailure;
    assert.throws(
      () => removeOwnedEmptyDirectories(checkout, manifest, {
        workspaceHandle,
        onBoundary(name, details) {
          if (name !== "before-rollback-removal-quarantine") {
            return;
          }
          heldOriginal = join(
            realpathSync(dirname(details.sourcePath)),
            basename(details.sourcePath) + ".held-original",
          );
          renameSync(details.sourcePath, heldOriginal);
          mkdirSync(details.sourcePath);
          stagedReplacement = join(
            realpathSync(dirname(details.sourcePath)),
            basename(details.sourcePath),
          );
        },
      }),
      (error) => {
        primaryFailure = error;
        return /ROLLBACK_REMOVAL_SUBSTITUTED/u.test(error.message);
      },
    );
    const result = finalizeRollbackTemporaryParent({
      cleanupHandle,
      workspaceHandle,
      primaryFailure,
    });
    finalized = true;
    assert.equal(result.primaryFailure, primaryFailure);
    assert.equal(result.cleanupFailure, undefined);
    assert.equal(result.cleanup.status, "preserved");
    assert.equal(result.cleanup.result.result, "preserved");
    assert.equal(existsSync(temporaryParent), true);
    assert.equal(lstatSync(heldOriginal).isDirectory(), true);
    assert.equal(lstatSync(stagedReplacement).isDirectory(), true);
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    if (cleanupHandle !== undefined && !finalized) {
      abandonCleanupHandle(cleanupHandle);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("production finalization holds workspace identities through actual cleanup", () => {
  const temporaryRoot = temporaryDirectory("agtmai-rollback-finalization-root-");
  const temporaryParent = mkdtempSync(join(temporaryRoot, "agtmai-rollback-deployment-plan-"));
  chmodSync(temporaryParent, 0o700);
  const checkout = join(temporaryParent, "checkout");
  const quarantineRoot = join(temporaryParent, "gate-tmp");
  let cleanupHandle;
  let workspaceHandle;
  let finalized = false;
  try {
    cleanupHandle = createCleanupHandle(temporaryParent, {
      temporaryRoot,
      targetPrefix: "agtmai-rollback-deployment-plan-",
      allowedEntries: ["checkout", "gate-tmp"],
    });
    mkdirSync(checkout, { mode: 0o700 });
    writeFileSync(join(checkout, "sentinel.txt"), "owned cleanup fixture\n");
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    captureCleanupTreeSnapshot(cleanupHandle);
    const result = finalizeRollbackTemporaryParent({ cleanupHandle, workspaceHandle });
    finalized = true;
    assert.equal(result.primaryFailure, undefined);
    assert.equal(result.cleanupFailure, undefined);
    assert.equal(result.cleanup.status, "passed");
    assert.equal(result.cleanup.result.result, "contents-removed");
    assert.equal(existsSync(temporaryParent), false);
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    if (cleanupHandle !== undefined && !finalized) {
      abandonCleanupHandle(cleanupHandle);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("trusted cleanup snapshot preserves pre-finalizer substitutions and additions", () => {
  for (const mode of ["substitution", "addition"]) {
    const temporaryRoot = temporaryDirectory("agtmai-rollback-pre-finalizer-root-");
    const temporaryParent = mkdtempSync(join(
      temporaryRoot,
      "agtmai-rollback-deployment-plan-",
    ));
    chmodSync(temporaryParent, 0o700);
    const checkout = join(temporaryParent, "checkout");
    const quarantineRoot = join(temporaryParent, "gate-tmp");
    const sentinel = join(checkout, "sentinel.txt");
    const heldOriginal = join(temporaryRoot, "held-original.txt");
    let cleanupHandle;
    let workspaceHandle;
    let finalized = false;
    try {
      cleanupHandle = createCleanupHandle(temporaryParent, {
        temporaryRoot,
        targetPrefix: "agtmai-rollback-deployment-plan-",
        allowedEntries: ["checkout", "gate-tmp"],
      });
      mkdirSync(checkout, { mode: 0o700 });
      mkdirSync(quarantineRoot, { mode: 0o700 });
      writeFileSync(sentinel, "trusted-original\n");
      workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
      captureCleanupTreeSnapshot(cleanupHandle);
      if (mode === "substitution") {
        renameSync(sentinel, heldOriginal);
        writeFileSync(sentinel, "foreign-substitute\n");
      } else {
        writeFileSync(join(checkout, "foreign-addition.txt"), "foreign-addition\n");
      }
      const result = finalizeRollbackTemporaryParent({ cleanupHandle, workspaceHandle });
      finalized = true;
      assert.equal(result.primaryFailure, undefined, mode);
      assert.equal(result.cleanup.status, "failed", mode);
      assert.match(result.cleanupFailure.message, /ROLLBACK_CLEANUP_ENTRY_(?:IDENTITY|SET)_MISMATCH/u);
      assert.equal(existsSync(temporaryParent), true, mode);
      if (mode === "substitution") {
        assert.equal(readFileSync(sentinel, "utf8"), "foreign-substitute\n");
        assert.equal(readFileSync(heldOriginal, "utf8"), "trusted-original\n");
      } else {
        assert.equal(
          readFileSync(join(checkout, "foreign-addition.txt"), "utf8"),
          "foreign-addition\n",
        );
      }
    } finally {
      closeRollbackWorkspaceHandle(workspaceHandle);
      if (cleanupHandle !== undefined && !finalized) {
        abandonCleanupHandle(cleanupHandle);
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
});
