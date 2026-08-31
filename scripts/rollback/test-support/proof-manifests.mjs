import * as proofSupport from "./proof-fixture.mjs";
const { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture } = proofSupport;
export { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture };

test("all three rollback manifest schemas have complete, non-overlapping exact ownership", () => {
  assert.equal(validateManifestSet(manifests()).length, 3);
});

test("operational manifest coverage matches the final integrated candidate", () => {
  assert.equal(validateManifestSet(manifests(), { verifyGitCoverage: true }).length, 3);
});

test("every production manifest verifies declared hashes through the default apply path", () => {
  for (const manifest of manifests()) {
    const boundary = temporaryDirectory(`agtmai-rollback-default-apply-${manifest.sliceId}-`);
    const checkout = join(boundary, "checkout");
    const quarantineRoot = join(boundary, "gate-tmp");
    let workspaceHandle;
    try {
      basicRun(gitExecutable(), [
        "clone", "--quiet", "--no-hardlinks", repositoryRoot, checkout,
      ], { cwd: boundary });
      copyCurrentRollbackSharedState(checkout, manifest);
      mkdirSync(quarantineRoot, { mode: 0o700 });
      workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
      const result = applyManifest(checkout, manifest, { workspaceHandle });
      assert.ok(result.quarantinedPathCount > 0, manifest.sliceId);
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

test("held shared ancestor descriptors reject an equal-shape replacement", {
  skip: process.platform !== "linux",
}, () => {
  const boundary = temporaryDirectory("agtmai-rollback-shared-ancestor-reuse-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  const heldChildren = join(boundary, "held-architecture-children");
  const manifest = manifests().find(({ sliceId }) => sliceId === "deployment-plan");
  let workspaceHandle;
  try {
    basicRun(gitExecutable(), [
      "clone", "--quiet", "--no-hardlinks", repositoryRoot, checkout,
    ], { cwd: boundary });
    copyCurrentRollbackSharedState(checkout, manifest);
    mkdirSync(quarantineRoot, { mode: 0o700 });
    mkdirSync(heldChildren, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    let replacement;
    assert.throws(
      () => applyManifest(checkout, manifest, {
        workspaceHandle,
        onBoundary(stage, details) {
          if (replacement !== undefined || stage !== "before-rollback-removal-quarantine"
            || details.path !== manifest.ownedPaths[0]) {
            return;
          }
          const architecture = join(checkout, "architecture");
          for (const name of readdirSync(architecture)) {
            renameSync(join(architecture, name), join(heldChildren, name));
          }
          const expectedInode = String(lstatSync(architecture, { bigint: true }).ino);
          rmdirSync(architecture);
          let observedInode;
          for (let attempt = 0; attempt < 256; attempt += 1) {
            mkdirSync(architecture);
            observedInode = String(lstatSync(architecture, { bigint: true }).ino);
            if (observedInode === expectedInode) {
              break;
            }
            if (attempt < 255) {
              rmdirSync(architecture);
            }
          }
          assert.notEqual(
            observedInode,
            expectedInode,
            "held descriptor must prevent directory inode reuse",
          );
          for (const name of readdirSync(heldChildren)) {
            renameSync(join(heldChildren, name), join(architecture, name));
          }
          rmdirSync(heldChildren);
          replacement = { expectedInode, observedInode };
        },
      }),
      /ROLLBACK_SHARED_PATH_SUBSTITUTED path=architecture\/foundation\/source-dependencies\.yaml/u,
    );
    assert.notEqual(replacement.observedInode, replacement.expectedInode);
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("every manifest requires a unique exact survivor complement", () => {
  for (const [index, manifest] of manifests().entries()) {
    const expected = [...manifest.survivingGates];
    const mutations = [
      ["empty", []],
      ["missing one", expected.slice(1)],
      ["unknown substitution", [expected[0], "unknown"]],
      ["self reference", [expected[0], manifest.sliceId]],
      ["duplicate", [...expected, expected[0]]],
    ];
    for (const [label, survivors] of mutations) {
      const forged = structuredClone(manifests());
      forged[index].survivingGates = survivors;
      assert.throws(
        () => validateManifestSet(forged),
        /ROLLBACK_(?:SURVIVOR_COMPLEMENT_INVALID|DUPLICATE_ENTRY)/u,
        manifest.sliceId + ": " + label,
      );
    }

    const missing = structuredClone(manifests());
    delete missing[index].survivingGates;
    assert.throws(
      () => validateManifestSet(missing),
      /ROLLBACK_MANIFEST_(?:OBJECT_INVALID|ARRAY_REQUIRED)/u,
      manifest.sliceId + ": missing field",
    );

    const reordered = structuredClone(manifests());
    reordered[index].survivingGates.reverse();
    assert.equal(validateManifestSet(reordered).length, 3);
  }
});

test("every declared shared reversal is mandatory for every slice", () => {
  for (const [index, manifest] of manifests().entries()) {
    for (const edit of manifest.reverseEdits) {
      const forged = structuredClone(manifests());
      forged[index].reverseEdits = forged[index].reverseEdits
        .filter((candidate) => candidate.path !== edit.path);
      assert.throws(
        () => validateManifestSet(forged),
        /ROLLBACK_SHARED_EDIT_COVERAGE/u,
        manifest.sliceId + ": " + edit.path,
      );
    }
  }
});

test("traversal is rejected in every path-bearing manifest field", () => {
  const mutations = [
    (value) => { value[0].ownedRoot = "../tooling"; },
    (value) => { value[0].ownedPaths[0] = "../owned"; },
    (value) => { value[0].restoreFromBaseline[0] = "../restore"; },
    (value) => { value[0].sharedPaths[0] = "../shared"; },
    (value) => { value[0].retainedSharedPaths[0].path = "../retained"; },
    (value) => { value[0].reverseEdits[0].path = "../reverse"; },
  ];
  for (const mutate of mutations) {
    const forged = structuredClone(manifests());
    mutate(forged);
    assert.throws(() => validateManifestSet(forged), /ROLLBACK_UNSAFE_PATH/u);
  }
});

test("manifest count, path bytes and operation inputs are bounded before staging", () => {
  assert.throws(
    () => validateManifestSet(manifests().slice(0, 2)),
    /ROLLBACK_MANIFEST_SET_INCOMPLETE/u,
  );
  assert.throws(
    () => validateManifestSet([...manifests(), structuredClone(manifests()[0])]),
    /ROLLBACK_MANIFEST_ARRAY_REQUIRED/u,
  );

  const oversizedManifestSet = structuredClone(manifests());
  oversizedManifestSet[0].ownedPaths = Array.from(
    { length: 4_097 },
    (_, index) => "tooling/local-solana/generated/file-" + String(index),
  );
  assert.throws(
    () => validateManifestSet(oversizedManifestSet),
    /ROLLBACK_MANIFEST_ARRAY_REQUIRED/u,
  );

  const overlongManifestSet = structuredClone(manifests());
  overlongManifestSet[0].ownedPaths[0] = "tooling/local-solana/" + "x".repeat(1_025);
  assert.throws(() => validateManifestSet(overlongManifestSet), /ROLLBACK_UNSAFE_PATH/u);

  const boundary = temporaryDirectory("agtmai-rollback-operation-bounds-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  let workspaceHandle;
  try {
    mkdirSync(join(checkout, "slice/owned"), { recursive: true });
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    const oversizedOperation = {
      sliceId: "fixture-slice",
      ownedRoot: "slice",
      ownedPaths: Array.from(
        { length: 4_097 },
        (_, index) => "slice/owned/file-" + String(index),
      ),
      restoreFromBaseline: [],
      sharedPaths: [],
      reverseEdits: [],
    };
    assert.throws(
      () => removeOwnedEmptyDirectories(checkout, oversizedOperation, { workspaceHandle }),
      /ROLLBACK_MANIFEST_ARRAY_REQUIRED/u,
    );
    assert.throws(
      () => applyManifest(checkout, oversizedOperation, {
        verifyDeclaredDigests: false,
        workspaceHandle,
      }),
      /ROLLBACK_MANIFEST_ARRAY_REQUIRED/u,
    );

    const overlongOperation = {
      ...oversizedOperation,
      ownedPaths: ["slice/" + "x".repeat(1_025)],
    };
    assert.throws(
      () => removeOwnedEmptyDirectories(checkout, overlongOperation, { workspaceHandle }),
      /ROLLBACK_UNSAFE_PATH/u,
    );
    assert.throws(
      () => applyManifest(checkout, overlongOperation, {
        verifyDeclaredDigests: false,
        workspaceHandle,
      }),
      /ROLLBACK_UNSAFE_PATH/u,
    );
    assert.deepEqual(readdirSync(quarantineRoot), []);

    const configSource = readFileSync(
      join(repositoryRoot, "scripts/rollback/slices/config.mjs"),
      "utf8",
    );
    const removalSource = readFileSync(
      join(repositoryRoot, "scripts/rollback/slices/removal-quarantine.mjs"),
      "utf8",
    );
    assert.match(configSource, /export const ROLLBACK_REMOVAL_MAX_SLOTS = 4_096;/u);
    assert.match(
      removalSource,
      /if \(quarantine\.nextSlot >= ROLLBACK_REMOVAL_MAX_SLOTS\)/u,
    );
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("hierarchical and category ownership overlap fails closed", () => {
  const hierarchical = structuredClone(manifests());
  hierarchical[0].ownedPaths.push("tooling/local-solana/tests");
  assert.throws(() => validateManifestSet(hierarchical), /ROLLBACK_PATH_OVERLAP/u);

  const crossSlice = structuredClone(manifests());
  crossSlice[0].ownedPaths.push(crossSlice[1].ownedPaths[0]);
  assert.throws(
    () => validateManifestSet(crossSlice),
    /ROLLBACK_(?:CROSS_SLICE_OWNERSHIP|OWNERSHIP_OVERLAP)/u,
  );

  const sharedOwned = structuredClone(manifests());
  sharedOwned[0].sharedPaths[0] = sharedOwned[0].ownedPaths[0];
  assert.throws(() => validateManifestSet(sharedOwned), /ROLLBACK_PATH_OVERLAP/u);

  const retainedShared = structuredClone(manifests());
  retainedShared[0].retainedSharedPaths[0].path = retainedShared[0].sharedPaths[0];
  assert.throws(() => validateManifestSet(retainedShared), /ROLLBACK_PATH_OVERLAP/u);
});

test("exact candidate enforcement rejects tracked, staged and untracked dirt", () => {
  for (const mode of ["tracked", "staged", "untracked"]) {
    const fixture = gitFixture();
    try {
      assert.equal(assertExactCleanCandidate(fixture.root, fixture.sha), fixture.sha);
      if (mode === "untracked") {
        writeFileSync(join(fixture.root, "sentinel.untracked"), "must refuse\n");
      } else {
        writeFileSync(join(fixture.root, "alpha.txt"), mode + "\n");
        if (mode === "staged") {
          git(fixture.root, ["add", "alpha.txt"]);
        }
      }
      assert.throws(
        () => assertExactCleanCandidate(fixture.root, fixture.sha),
        /ROLLBACK_CANDIDATE_DIRTY/u,
      );
    } finally {
      rmSync(fixture.boundary, { recursive: true, force: true });
    }
  }
});

test("complete inventory covers binary, executable and symlink bytes and detects mismatch", () => {
  const fixture = gitFixture();
  try {
    const expected = trackedCandidateInventory(fixture.root, fixture.sha);
    assert.equal(expected.entryCount, 4);
    assert.deepEqual(
      expected.entries.map(({ path, mode }) => [path, mode]),
      [
        ["alpha-link", "120000"],
        ["alpha.txt", "100644"],
        ["binary.bin", "100644"],
        ["executable.sh", "100755"],
      ],
    );
    const clone = join(fixture.boundary, "clone");
    basicRun(gitExecutable(), ["clone", "--quiet", "--no-hardlinks", fixture.root, clone], {
      cwd: fixture.boundary,
    });
    const actual = trackedCandidateInventory(clone, fixture.sha);
    assertInventoryEqual(expected, actual);

    writeFileSync(join(clone, "binary.bin"), Buffer.from([9, 8, 7]));
    const tampered = trackedCandidateInventory(clone, fixture.sha);
    assert.throws(
      () => assertInventoryEqual(expected, tampered, "tampered"),
      /ROLLBACK_INVENTORY_MISMATCH/u,
    );
  } finally {
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});
