import * as proofSupport from "./proof-fixture.mjs";
const { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture } = proofSupport;
export { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture };
const { cloneRepository } = proofSupport;

test("per-slice rollback replay requires exact status, byte tree and forbidden-residue equivalence", () => {
  const fixture = gitFixture();
  const quarantineRoot = join(fixture.boundary, "gate-tmp");
  mkdirSync(quarantineRoot, { mode: 0o700 });
  let workspaceHandle;
  const manifest = {
    sliceId: "fixture-slice",
    ownedRoot: "slice",
    ownedPaths: ["slice/owned/feature.txt"],
    restoreFromBaseline: ["slice/src/README.md"],
    sharedPaths: ["shared.txt", "slice/src/README.md"],
  };
  try {
    workspaceHandle = createRollbackWorkspaceHandle(fixture.root, quarantineRoot);
    assert.deepEqual(
      assertRollbackWorkspaceHandle(workspaceHandle, fixture.root),
      {
        checkoutDevice: workspaceHandle.checkoutDevice,
        checkoutInode: workspaceHandle.checkoutInode,
        quarantineDevice: workspaceHandle.quarantineDevice,
        quarantineInode: workspaceHandle.quarantineInode,
      },
    );
    mkdirSync(join(fixture.root, "slice/owned"), { recursive: true });
    writeFileSync(join(fixture.root, "slice/owned/feature.txt"), "slice-owned\n");
    writeFileSync(join(fixture.root, "shared.txt"), "with-slice\n");
    git(fixture.root, ["add", "-A"]);
    git(fixture.root, ["commit", "--quiet", "-m", "test: integrated slice"]);
    const candidateSha = git(fixture.root, ["rev-parse", "HEAD"]).trim();
    const candidateInventory = trackedCandidateInventory(fixture.root, candidateSha);

    unlinkSync(join(fixture.root, "slice/owned/feature.txt"));
    writeFileSync(join(fixture.root, "shared.txt"), "pre-state\n");
    mkdirSync(join(fixture.root, "slice/src"), { recursive: true });
    writeFileSync(join(fixture.root, "slice/src/README.md"), "baseline stub\n");
    assert.equal(removeOwnedEmptyDirectories(fixture.root, manifest, {
      workspaceHandle,
    }).quarantinedDirectoryCount, 1);
    const expectedStatus = captureGitStatusSnapshot(fixture.root);
    git(fixture.root, ["add", "-A"]);
    const expectedTree = git(fixture.root, ["write-tree"]).trim();
    git(fixture.root, ["commit", "--quiet", "-m", "test: captured pre-state"]);
    const preStateSha = git(fixture.root, ["rev-parse", "HEAD"]).trim();
    const preStateInventory = trackedCandidateInventory(fixture.root, preStateSha);
    assert.equal(preStateInventory.tree, expectedTree);

    const evidence = join(fixture.boundary, "evidence");
    mkdirSync(evidence);
    const recorder = new EvidenceRecorder(evidence, { mode: "fixture" });
    const applied = applyExactSliceState(
      fixture.root,
      manifest,
      candidateSha,
      candidateInventory.tree,
      recorder,
      manifest.sliceId,
    );
    assert.equal(applied.tree, candidateInventory.tree);
    assert.equal(applied.pathCount, 3);
    git(fixture.root, ["reset", "--hard", candidateSha]);
    assert.equal(assertExactCleanCandidate(fixture.root, candidateSha), candidateSha);
    assert.doesNotThrow(() => assertInventoryEqual(
      candidateInventory,
      trackedCandidateInventory(fixture.root, candidateSha),
      "applied-fixture-slice",
    ));

    unlinkSync(join(fixture.root, "slice/owned/feature.txt"));
    writeFileSync(join(fixture.root, "shared.txt"), "pre-state\n");
    mkdirSync(join(fixture.root, "slice/src"), { recursive: true });
    writeFileSync(join(fixture.root, "slice/src/README.md"), "baseline stub\n");
    assert.equal(removeOwnedEmptyDirectories(fixture.root, manifest, {
      workspaceHandle,
    }).quarantinedDirectoryCount, 1);
    const actualStatus = captureGitStatusSnapshot(fixture.root);
    assert.doesNotThrow(() => assertGitStatusSnapshotEqual(
      expectedStatus,
      actualStatus,
      "fixture",
    ));
    assert.deepEqual(
      assertPathsAbsent(fixture.root, manifest.ownedPaths, "fixture"),
      {
        status: "passed",
        pathCount: 1,
        pathsSha256: createHash("sha256")
          .update('["slice/owned/feature.txt"]').digest("hex"),
      },
    );
    assert.equal(
      assertExactDirectoryShape(
        fixture.root,
        manifest.ownedRoot,
        manifest.restoreFromBaseline,
        "fixture",
      ).fileCount,
      1,
    );
    git(fixture.root, ["add", "-A"]);
    assert.equal(git(fixture.root, ["write-tree"]).trim(), expectedTree);
    git(fixture.root, ["reset", "--hard", preStateSha]);
    assert.equal(assertExactCleanCandidate(fixture.root, preStateSha), preStateSha);
    assert.doesNotThrow(() => assertInventoryEqual(
      preStateInventory,
      trackedCandidateInventory(fixture.root, preStateSha),
      "executed-fixture-rollback",
    ));

    assertReplayAdversaries({
      candidateSha,
      expectedStatus,
      expectedTree,
      fixture,
      manifest,
      workspaceHandle,
    });
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

function assertReplayAdversaries({
  candidateSha,
  expectedStatus,
  expectedTree,
  fixture,
  manifest,
  workspaceHandle,
}) {
  mkdirSync(join(fixture.root, "slice/empty-forbidden"));
  assert.throws(
    () => assertExactDirectoryShape(
      fixture.root,
      manifest.ownedRoot,
      manifest.restoreFromBaseline,
      "empty-directory-adversary",
    ),
    /ROLLBACK_FORBIDDEN_DIRECTORY_RESIDUE/u,
  );
  rmdirSync(join(fixture.root, "slice/empty-forbidden"));
  git(fixture.root, ["reset", "--hard", candidateSha]);
  unlinkSync(join(fixture.root, "slice/owned/feature.txt"));
  writeFileSync(join(fixture.root, "shared.txt"), "byte-drift-with-same-status\n");
  mkdirSync(join(fixture.root, "slice/src"), { recursive: true });
  writeFileSync(join(fixture.root, "slice/src/README.md"), "baseline stub\n");
  removeOwnedEmptyDirectories(fixture.root, manifest, { workspaceHandle });
  assert.doesNotThrow(() => assertGitStatusSnapshotEqual(
    expectedStatus,
    captureGitStatusSnapshot(fixture.root),
    "same-status-byte-drift",
  ));
  git(fixture.root, ["add", "-A"]);
  assert.notEqual(git(fixture.root, ["write-tree"]).trim(), expectedTree);
  git(fixture.root, ["reset", "--hard", candidateSha]);
  unlinkSync(join(fixture.root, "slice/owned/feature.txt"));
  writeFileSync(join(fixture.root, "slice/owned/unexpected.txt"), "must survive\n");
  assert.throws(
    () => removeOwnedEmptyDirectories(fixture.root, manifest, { workspaceHandle }),
    /ROLLBACK_FORBIDDEN_DIRECTORY_RESIDUE/u,
  );
  assert.equal(
    readFileSync(join(fixture.root, "slice/owned/unexpected.txt"), "utf8"),
    "must survive\n",
  );
  writeFileSync(join(fixture.root, "slice/owned/feature.txt"), "forbidden residue\n");
  assert.throws(
    () => assertPathsAbsent(fixture.root, manifest.ownedPaths, "fixture"),
    /ROLLBACK_FORBIDDEN_RESIDUE/u,
  );
  assert.throws(
    () => assertGitStatusSnapshotEqual(
      expectedStatus,
      { ...expectedStatus, base64: expectedStatus.base64 + "A" },
      "forged",
    ),
    /ROLLBACK_STATUS_SNAPSHOT_INVALID/u,
  );
}

test("production manifest rollback executes in quarantine and verifies the transformed slice", () => {
  const boundary = temporaryDirectory("agtmai-rollback-production-apply-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  const manifest = manifests().find(({ sliceId }) => sliceId === "deployment-plan");
  let workspaceHandle;
  try {
    cloneRepository(repositoryRoot, checkout, boundary);
    copyCurrentRollbackSharedState(checkout, manifest);
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    const result = applyManifest(checkout, manifest, {
      verifyDeclaredDigests: false,
      workspaceHandle,
    });
    assert.ok(result.directoryCleanup.quarantinedDirectoryCount > 0);
    assert.equal(result.directoryCleanup.deletionDeferredToIdentityBoundCleanup, true);
    assert.equal(result.quarantinedPathCount, result.quarantinedPaths.length);
    assert.deepEqual(result.quarantinedPaths, [...result.quarantinedPaths].toSorted());
    assert.doesNotThrow(() => verifyAppliedState(checkout, manifest, { workspaceHandle }));
    assert.ok(readFileSync(join(checkout, manifest.restoreFromBaseline[0]), "utf8").length > 0);
    assert.deepEqual(readdirSync(quarantineRoot), ["rollback-removals-deployment-plan-0001"]);
    assert.ok(readFileSync(join(
      quarantineRoot,
      "rollback-removals-deployment-plan-0001",
      "entry-0000001",
    )).length > 0);
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("production baseline restoration creates absent files and overwrites existing files safely", () => {
  const expectedCandidatePresence = {
    "deployment-plan": false,
    "local-solana": false,
    slither: true,
  };
  for (const manifest of manifests()) {
    const boundary = temporaryDirectory(`agtmai-rollback-restore-${manifest.sliceId}-`);
    const checkout = join(boundary, "checkout");
    const quarantineRoot = join(boundary, "gate-tmp");
    const restoredPath = manifest.restoreFromBaseline[0];
    let workspaceHandle;
    try {
      cloneRepository(repositoryRoot, checkout, boundary);
      copyCurrentRollbackSharedState(checkout, manifest);
      mkdirSync(quarantineRoot, { mode: 0o700 });
      assert.equal(
        existsSync(join(checkout, restoredPath)),
        expectedCandidatePresence[manifest.sliceId],
        manifest.sliceId,
      );
      const expected = git(checkout, ["show", `${manifest.baselineSha}:${restoredPath}`]);
      workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
      applyManifest(checkout, manifest, {
        verifyDeclaredDigests: false,
        workspaceHandle,
      });
      assert.equal(readFileSync(join(checkout, restoredPath), "utf8"), expected, manifest.sliceId);
      assert.doesNotThrow(
        () => verifyAppliedState(checkout, manifest, { workspaceHandle }),
        manifest.sliceId,
      );
    } finally {
      closeRollbackWorkspaceHandle(workspaceHandle);
      rmSync(boundary, { recursive: true, force: true });
    }
  }
});

test("production manifest and empty-directory rollback preserve substituted identities", () => {
  const boundary = temporaryDirectory("agtmai-rollback-production-substitution-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  const manifest = manifests().find(({ sliceId }) => sliceId === "deployment-plan");
  let checkoutWorkspaceHandle;
  let directoryWorkspaceHandle;
  let ancestorWorkspaceHandle;
  try {
    cloneRepository(repositoryRoot, checkout, boundary);
    copyCurrentRollbackSharedState(checkout, manifest);
    mkdirSync(quarantineRoot, { mode: 0o700 });
    checkoutWorkspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    const firstOwnedPath = manifest.ownedPaths[0];
    const original = join(checkout, firstOwnedPath + ".held-original");
    let replacement;
    assert.throws(
      () => applyManifest(checkout, manifest, {
        verifyDeclaredDigests: false,
        workspaceHandle: checkoutWorkspaceHandle,
        onBoundary(name, details) {
          if (name !== "before-rollback-removal-quarantine" || details.path !== firstOwnedPath) {
            return;
          }
          renameSync(details.sourcePath, original);
          writeFileSync(details.sourcePath, "foreign replacement\n");
          replacement = join(realpathSync(dirname(details.sourcePath)), basename(details.sourcePath));
        },
      }),
      /ROLLBACK_REMOVAL_SUBSTITUTED/u,
    );
    assert.ok(readFileSync(original).length > 0);
    assert.equal(readFileSync(replacement, "utf8"), "foreign replacement\n");

    const directoryBoundary = join(boundary, "directory-fixture");
    const directoryRoot = join(directoryBoundary, "checkout");
    const directoryQuarantine = join(directoryBoundary, "gate-tmp");
    mkdirSync(join(directoryRoot, "slice/owned"), { recursive: true });
    mkdirSync(directoryQuarantine, { mode: 0o700 });
    directoryWorkspaceHandle = createRollbackWorkspaceHandle(
      directoryRoot,
      directoryQuarantine,
    );
    const directoryManifest = {
      sliceId: "fixture-slice",
      ownedRoot: "slice",
      ownedPaths: ["slice/owned/file.txt"],
      restoreFromBaseline: [],
    };
    const directoryOriginal = join(directoryRoot, "slice/owned.original");
    let stagedDirectory;
    assert.throws(
      () => removeOwnedEmptyDirectories(directoryRoot, directoryManifest, {
        workspaceHandle: directoryWorkspaceHandle,
        onBoundary(name, details) {
          if (name !== "before-rollback-removal-quarantine") {
            return;
          }
          renameSync(details.sourcePath, directoryOriginal);
          mkdirSync(details.sourcePath);
          stagedDirectory = join(
            realpathSync(dirname(details.sourcePath)),
            basename(details.sourcePath),
          );
        },
      }),
      /ROLLBACK_REMOVAL_SUBSTITUTED/u,
    );
    assert.equal(lstatSync(directoryOriginal).isDirectory(), true);
    assert.equal(lstatSync(stagedDirectory).isDirectory(), true);

    const ancestorBoundary = join(boundary, "ancestor-fixture");
    const ancestorRoot = join(ancestorBoundary, "checkout");
    const ancestorQuarantine = join(ancestorBoundary, "gate-tmp");
    const outside = join(ancestorBoundary, "outside");
    mkdirSync(ancestorRoot, { recursive: true });
    mkdirSync(ancestorQuarantine, { mode: 0o700 });
    mkdirSync(join(outside, "owned"), { recursive: true });
    symlinkSync(outside, join(ancestorRoot, "slice"), "dir");
    ancestorWorkspaceHandle = createRollbackWorkspaceHandle(ancestorRoot, ancestorQuarantine);
    assert.throws(
      () => removeOwnedEmptyDirectories(ancestorRoot, directoryManifest, {
        workspaceHandle: ancestorWorkspaceHandle,
      }),
      /ROLLBACK_REMOVAL_ANCESTOR_UNSAFE/u,
    );
    assert.equal(lstatSync(join(outside, "owned")).isDirectory(), true);
  } finally {
    closeRollbackWorkspaceHandle(ancestorWorkspaceHandle);
    closeRollbackWorkspaceHandle(directoryWorkspaceHandle);
    closeRollbackWorkspaceHandle(checkoutWorkspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});
