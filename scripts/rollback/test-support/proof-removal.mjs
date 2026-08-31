import * as proofSupport from "./proof-fixture.mjs";
const { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture } = proofSupport;
export { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture };

test("every primary proof failure abandons cleanup and preserves drift evidence", () => {
  for (const failureMessage of [
    "ROLLBACK_SHARED_EDIT_SOURCE_DRIFT path=package.json",
    "ROLLBACK_FORBIDDEN_RESIDUE path=foreign.txt",
    "ordinary-quality-gate-failure",
  ]) {
    const temporaryRoot = temporaryDirectory("agtmai-rollback-primary-failure-root-");
    const temporaryParent = mkdtempSync(join(
      temporaryRoot,
      "agtmai-rollback-deployment-plan-",
    ));
    chmodSync(temporaryParent, 0o700);
    const checkout = join(temporaryParent, "checkout");
    const quarantineRoot = join(temporaryParent, "gate-tmp");
    const evidence = join(checkout, "foreign-evidence.txt");
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
      writeFileSync(evidence, "preserved-primary-failure-evidence\n");
      workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
      const primaryFailure = new Error(failureMessage);
      const result = finalizeRollbackTemporaryParent({
        cleanupHandle,
        workspaceHandle,
        primaryFailure,
      });
      finalized = true;
      assert.equal(result.primaryFailure, primaryFailure);
      assert.equal(result.cleanupFailure, undefined);
      assert.equal(result.cleanup.status, "preserved");
      assert.equal(existsSync(temporaryParent), true);
      assert.equal(readFileSync(evidence, "utf8"), "preserved-primary-failure-evidence\n");
    } finally {
      closeRollbackWorkspaceHandle(workspaceHandle);
      if (cleanupHandle !== undefined && !finalized) {
        abandonCleanupHandle(cleanupHandle);
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
});

test("pre-staged removal plan preserves a later directory replaced from an earlier hook", () => {
  const temporaryRoot = temporaryDirectory("agtmai-rollback-plan-snapshot-root-");
  const temporaryParent = mkdtempSync(join(temporaryRoot, "agtmai-rollback-deployment-plan-"));
  chmodSync(temporaryParent, 0o700);
  const checkout = join(temporaryParent, "checkout");
  const quarantineRoot = join(temporaryParent, "gate-tmp");
  const later = join(checkout, "slice/z");
  const laterOriginal = later + ".held-original";
  const manifest = {
    sliceId: "fixture-slice",
    ownedRoot: "slice",
    ownedPaths: ["slice/a/file.txt", "slice/z/file.txt"],
    restoreFromBaseline: [],
  };
  let cleanupHandle;
  let workspaceHandle;
  let finalized = false;
  try {
    cleanupHandle = createCleanupHandle(temporaryParent, {
      temporaryRoot,
      targetPrefix: "agtmai-rollback-deployment-plan-",
      allowedEntries: ["checkout", "gate-tmp"],
    });
    mkdirSync(join(checkout, "slice/a"), { recursive: true });
    mkdirSync(later, { recursive: true });
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    let primaryFailure;
    assert.throws(
      () => removeOwnedEmptyDirectories(checkout, manifest, {
        workspaceHandle,
        onBoundary(name, details) {
          if (name === "before-rollback-removal-quarantine" && details.path === "slice/a") {
            renameSync(later, laterOriginal);
            mkdirSync(later);
          }
        },
      }),
      (error) => {
        primaryFailure = error;
        return /ROLLBACK_REMOVAL_SUBSTITUTED path=slice\/z/u.test(error.message);
      },
    );
    const result = finalizeRollbackTemporaryParent({
      cleanupHandle,
      workspaceHandle,
      primaryFailure,
    });
    finalized = true;
    assert.equal(result.cleanup.status, "preserved");
    assert.equal(existsSync(temporaryParent), true);
    assert.equal(lstatSync(laterOriginal).isDirectory(), true);
    assert.equal(lstatSync(later).isDirectory(), true);
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    if (cleanupHandle !== undefined && !finalized) {
      abandonCleanupHandle(cleanupHandle);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("held removal descriptors reject an unlink-recreated later directory", () => {
  const boundary = temporaryDirectory("agtmai-rollback-held-plan-reuse-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  const later = join(checkout, "slice/z");
  const manifest = {
    sliceId: "fixture-slice",
    ownedRoot: "slice",
    ownedPaths: ["slice/a/file.txt", "slice/z/file.txt"],
    restoreFromBaseline: [],
  };
  let workspaceHandle;
  let identities;
  try {
    mkdirSync(join(checkout, "slice/a"), { recursive: true });
    mkdirSync(later, { recursive: true });
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    assert.throws(
      () => removeOwnedEmptyDirectories(checkout, manifest, {
        workspaceHandle,
        onBoundary(name, details) {
          if (name === "before-rollback-removal-quarantine" && details.path === "slice/a") {
            const before = lstatSync(later, { bigint: true });
            rmdirSync(later);
            mkdirSync(later);
            const after = lstatSync(later, { bigint: true });
            identities = { before: String(before.ino), after: String(after.ino) };
          }
        },
      }),
      /ROLLBACK_REMOVAL_SUBSTITUTED path=slice\/z/u,
    );
    assert.notEqual(identities.after, identities.before);
    assert.equal(lstatSync(later).isDirectory(), true);
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("held removal descriptors tolerate child staging metadata changes on a planned parent", () => {
  const boundary = temporaryDirectory("agtmai-rollback-held-plan-parent-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  const manifest = {
    sliceId: "fixture-slice",
    ownedRoot: "slice",
    ownedPaths: ["slice/parent/child/file.txt"],
    restoreFromBaseline: [],
  };
  let workspaceHandle;
  try {
    mkdirSync(join(checkout, "slice/parent/child"), { recursive: true });
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    const result = removeOwnedEmptyDirectories(checkout, manifest, { workspaceHandle });
    assert.deepEqual(result.quarantinedDirectories, ["slice/parent/child", "slice/parent"]);
    assert.equal(existsSync(join(checkout, "slice/parent")), false);
    assert.equal(lstatSync(join(checkout, "slice")).isDirectory(), true);
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("every removal-phase failure preserves forbidden residue and raw syscall identities", () => {
  for (const mode of ["forbidden-residue", "raw-syscall"]) {
    const temporaryRoot = temporaryDirectory("agtmai-rollback-removal-failure-root-");
    const temporaryParent = mkdtempSync(join(
      temporaryRoot,
      "agtmai-rollback-deployment-plan-",
    ));
    chmodSync(temporaryParent, 0o700);
    const checkout = join(temporaryParent, "checkout");
    const quarantineRoot = join(temporaryParent, "gate-tmp");
    const owned = join(checkout, "slice/owned");
    const rawOriginal = owned + ".raw-original";
    const manifest = {
      sliceId: "fixture-slice",
      ownedRoot: "slice",
      ownedPaths: ["slice/owned/file.txt"],
      restoreFromBaseline: [],
    };
    let cleanupHandle;
    let workspaceHandle;
    let finalized = false;
    let staged;
    try {
      cleanupHandle = createCleanupHandle(temporaryParent, {
        temporaryRoot,
        targetPrefix: "agtmai-rollback-deployment-plan-",
        allowedEntries: ["checkout", "gate-tmp"],
      });
      mkdirSync(owned, { recursive: true });
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
            staged = join(realpathSync(dirname(details.stagedPath)), basename(details.stagedPath));
            if (mode === "forbidden-residue") {
              writeFileSync(join(details.sourcePath, "foreign"), "foreign-survives\n");
            } else {
              renameSync(details.sourcePath, rawOriginal);
            }
          },
        }),
        (error) => {
          primaryFailure = error;
          return mode === "forbidden-residue"
            ? /ROLLBACK_REMOVAL_PHASE_FAILED.*ROLLBACK_FORBIDDEN_DIRECTORY_RESIDUE/u
              .test(error.message)
            : /ROLLBACK_REMOVAL_PHASE_FAILED.*ENOENT/u.test(error.message);
        },
      );
      const result = finalizeRollbackTemporaryParent({
        cleanupHandle,
        workspaceHandle,
        primaryFailure,
      });
      finalized = true;
      assert.equal(result.cleanup.status, "preserved", mode);
      assert.equal(existsSync(temporaryParent), true, mode);
      if (mode === "forbidden-residue") {
        assert.equal(readFileSync(join(staged, "foreign"), "utf8"), "foreign-survives\n");
      } else {
        assert.equal(lstatSync(rawOriginal).isDirectory(), true);
        assert.equal(existsSync(staged), false);
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

test("production cleanup and removal traverse directories with bounded incremental reads", () => {
  const cleanup = readFileSync(
    join(repositoryRoot, "scripts/rollback/runtime/cleanup-tree.mjs"),
    "utf8",
  );
  const removal = readFileSync(
    join(repositoryRoot, "scripts/rollback/slices/removal-quarantine.mjs"),
    "utf8",
  );
  const shapeTraversal = readFileSync(
    join(repositoryRoot, "scripts/rollback/runtime/directory-shape.mjs"),
    "utf8",
  );
  const cleanupTraversal = cleanup.slice(
    cleanup.indexOf("export function sortedDirectoryEntries"),
    cleanup.indexOf("export function openDirectoryDescriptor"),
  );
  const removalTraversal = removal.slice(
    removal.indexOf("function rollbackDirectoryHasEntries"),
    removal.indexOf("function assertRollbackRemovalIdentity"),
  );
  assert.match(cleanupTraversal, /opendirSync[\s\S]*directory\.readSync\(\)/u);
  assert.match(cleanupTraversal, /entries\.length >= CLEANUP_MAX_ENTRIES/u);
  assert.doesNotMatch(cleanupTraversal, /readdirSync/u);
  assert.match(removalTraversal, /opendirSync[\s\S]*directory\.readSync\(\) !== null/u);
  assert.doesNotMatch(removalTraversal, /readdirSync/u);
  assert.match(shapeTraversal, /opendirSync[\s\S]*directory\.readSync\(\)/u);
  assert.match(shapeTraversal, /SHAPE_MAX_ENTRIES[\s\S]*SHAPE_MAX_FILE_BYTES/u);
  assert.match(shapeTraversal, /readSync\(descriptor/u);
  assert.doesNotMatch(shapeTraversal, /readdirSync|readFileSync/u);
});

test("owned-root shape verification rejects symlink escape and entry overflow", () => {
  const boundary = temporaryDirectory("agtmai-rollback-shape-bounds-");
  const checkout = join(boundary, "checkout");
  const outside = join(boundary, "outside");
  const outsideFile = join(outside, "allowed.txt");
  try {
    mkdirSync(checkout);
    mkdirSync(outside);
    writeFileSync(outsideFile, "outside-must-survive\n");
    symlinkSync(outside, join(checkout, "slice"), "dir");
    assert.throws(
      () => assertExactDirectoryShape(checkout, "slice", ["slice/allowed.txt"], "symlink"),
      /ROLLBACK_OWNED_ROOT_NODE_UNSAFE/u,
    );
    assert.equal(readFileSync(outsideFile, "utf8"), "outside-must-survive\n");

    unlinkSync(join(checkout, "slice"));
    mkdirSync(join(checkout, "slice"));
    writeFileSync(join(checkout, "slice/allowed.txt"), "allowed\n");
    for (let index = 0; index < 4_095; index += 1) {
      writeFileSync(join(checkout, "slice", "foreign-" + String(index).padStart(4, "0")), "");
    }
    assert.throws(
      () => assertExactDirectoryShape(checkout, "slice", ["slice/allowed.txt"], "overflow"),
      /ROLLBACK_OWNED_ROOT_SHAPE_BOUNDS/u,
    );
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});
