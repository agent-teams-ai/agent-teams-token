import * as proofSupport from "./proof-fixture.mjs";
import { deploymentPlanSharedEditBaseline } from "../slices/config.mjs";
import { restoreDeploymentPlanSharedEdits } from "../slices/transforms.mjs";
import { snapshotRollbackSharedPaths } from "../slices/shared-paths.mjs";
const { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture } = proofSupport;
export { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture };
const { cloneRepository, assertRegisteredLocalEvmCustody } = proofSupport;

const supplySurvivors = [
  "packages/contexts/supply/src/features/genesis-manifest/application/deployment-manifest.ts",
  "packages/contexts/supply/src/features/genesis-manifest/application/passport.ts",
  "packages/contexts/supply/src/features/genesis-manifest/application/reserve-facts.ts",
  "packages/contexts/supply/src/features/genesis-manifest/deployment.ts",
  "packages/contexts/supply/src/features/genesis-manifest/adapters/deployment-artifacts.ts",
  "packages/contexts/supply/src/features/genesis-manifest/application/prepare-production-deployment.ts",
  "packages/contexts/supply/src/features/genesis-manifest/composition/deployment-files.ts",
  "packages/contexts/supply/tests/deployment-cli.test.ts",
  "packages/contexts/supply/tests/production-deployment.test.ts",
];

const passiveSafeSurvivors = ["tooling/testnet-ccip/src/adapters/local-safe.ts", "tooling/testnet-ccip/src/adapters/safe-custody.ts"];

test("precise deployment-plan reversal preserves independently edited Supply bytes", () => {
  const boundary = temporaryDirectory("agtmai-rollback-supply-survivor-");
  const checkout = join(boundary, "checkout"), quarantineRoot = join(boundary, "gate-tmp");

  let workspaceHandle;
  try {
    cloneRepository(repositoryRoot, checkout, boundary);
    const edited = new Map([...supplySurvivors, ...passiveSafeSurvivors].map(path => {
      const original = readFileSync(join(repositoryRoot, path));
      const bytes = Buffer.concat([original, Buffer.from(`\n// Independent survivor edit: ${path}\n`)]);
      assert.notDeepEqual(bytes, original, path);
      writeFileSync(join(checkout, path), bytes); return [path, bytes];
    }));
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    const sharedPlan = snapshotRollbackSharedPaths(checkout, deploymentPlanSharedEditBaseline.paths, workspaceHandle);
    restoreDeploymentPlanSharedEdits(checkout, sharedPlan, workspaceHandle);
    for (const path of [...supplySurvivors, ...passiveSafeSurvivors]) {
      assert.deepEqual(readFileSync(join(checkout, path)), edited.get(path), path);
    }
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

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
      cloneRepository(repositoryRoot, checkout, boundary);
      copyCurrentRollbackSharedState(checkout, manifest);
      mkdirSync(quarantineRoot, { mode: 0o700 });
      workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
      const result = applyManifest(checkout, manifest, { workspaceHandle });
      assert.ok(result.quarantinedPathCount > 0, manifest.sliceId);
      assert.doesNotThrow(
        () => verifyAppliedState(checkout, manifest, { workspaceHandle }),
        manifest.sliceId,
      );
      if (manifest.sliceId === "deployment-plan") {
        // Real applied bytes must retain independent report/authentication semantics;
        // historical source fragments cannot qualify the surviving implementation.
        for (const path of [...supplySurvivors, ...passiveSafeSurvivors,
          "packages/contexts/supply/tests/local-purpose-artifacts.test.ts",
          "packages/contexts/supply/tests/local-purpose-planner.test.ts"]) {
          assert.deepEqual(readFileSync(join(checkout, path)), readFileSync(join(repositoryRoot, path)), path);
        }
        // The complete sequential suite must allow its slow per-case timeout budgets (~280s).
        const cleanup = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "tooling/local-evm/tests/cleanup.test.ts"], { cwd: checkout, env: {TMPDIR: tmpdir(), PATH: process.env.PATH}, encoding: "utf8", timeout: 360_000 });
        assert.equal(existsSync(join(checkout, "scripts/deployment/local-execution-proof.ts")), false); assert.equal(cleanup.error, undefined); assert.equal(cleanup.signal, null); assert.equal(cleanup.status, 0, cleanup.stdout + cleanup.stderr);
        for (const outcome of ["retains", "removes"]) {parseStrictTap(cleanup.stdout, `runner startup publication failure ${outcome} custody after real supervisor cleanup`);}
      }
    } finally {
      closeRollbackWorkspaceHandle(workspaceHandle);
      rmSync(boundary, { recursive: true, force: true });
    }
  }
});

// Exercise the surviving caller and durable lease, rather than accepting a
// rehashed historical process implementation that leaves lease.anvil null.
test("deployment-plan rollback preserves Local EVM supervisor registration before acknowledgement", {timeout: 40_000}, () => {
  const boundary = temporaryDirectory("agtmai-rollback-evm-custody-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  const manifest = manifests().find(({ sliceId }) => sliceId === "deployment-plan");
  let workspaceHandle;
  try {
    cloneRepository(repositoryRoot, checkout, boundary);
    copyCurrentRollbackSharedState(checkout, manifest);
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    applyManifest(checkout, manifest, { workspaceHandle });
    verifyAppliedState(checkout, manifest, { workspaceHandle });
    for (const path of ["tooling/local-evm/process.ts", "tooling/local-evm/toolchain.ts"]) {
      const retained = manifest.retainedSharedPaths.find(entry => entry.path === path);
      assert.ok(retained, "independent Local EVM behavior has exact retained authority");
      assert.equal(digestFile(join(checkout, path)), retained.sha256);
      assert.deepEqual(readFileSync(join(checkout, path)), readFileSync(join(repositoryRoot, path)));
    }
    // These additions serve the removed execution proof only. Their genuine
    // historical reversals still run while the independent supervisor survives.
    for (const path of ["tooling/local-evm/rpc.ts", "tooling/local-evm/tests/rpc.test.ts"]) {
      assert.equal(readFileSync(join(checkout, path), "utf8"), git(checkout, [
        "show", "dfe89da4c77a186aefbaead50981a327317f3bc4:" + path,
      ]));
    }
    assertRegisteredLocalEvmCustody(checkout);
    // The cases observe durable registration at the parent callback, reject a
    // foreign lease before exposing identity, and independently observe exit.
    for (const path of manifest.ownedPaths) {assert.equal(existsSync(join(checkout, path)), false, path);}
    verifyAppliedState(checkout, manifest, { workspaceHandle });
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("retained Local EVM authority rejects digest drift and arbitrary reclassification", () => {
  const drifted = manifests();
  const deployment = drifted.find(({ sliceId }) => sliceId === "deployment-plan");
  deployment.retainedSharedPaths.find(entry => entry.path === "tooling/local-evm/process.ts").sha256 = "0".repeat(64);
  assert.throws(() => validateManifestSet(drifted), /ROLLBACK_RETAINED_SHARED_PATH_DRIFT/u);

  const arbitrary = manifests();
  arbitrary.find(({ sliceId }) => sliceId === "deployment-plan").retainedSharedPaths.push({
    path: "tooling/local-evm/runner.ts", reason: "Undeclared retention must remain forbidden", sha256: digestFile(join(repositoryRoot, "tooling/local-evm/runner.ts")),
  });
  assert.throws(() => validateManifestSet(arbitrary), /ROLLBACK_RETAINED_SHARED_PATH_COVERAGE/u);

  const otherSlice = manifests();
  otherSlice[0].retainedSharedPaths.push(deployment.retainedSharedPaths.find(entry => entry.path === "tooling/local-evm/toolchain.ts"));
  assert.throws(() => validateManifestSet(otherSlice), /ROLLBACK_RETAINED_SHARED_PATH_COVERAGE/u);
});

// Regression trigger: whole-file restoration removes these named public exports
// while the local-purpose implementation survives and all manifest hashes pass.
test("deployment-plan rollback preserves the local-purpose public named-import consumer", () => {
  const boundary = temporaryDirectory("agtmai-rollback-public-consumer-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  const supply = join(checkout, "packages/contexts/supply");
  const consumer = join(supply, ".local");
  const manifest = manifests().find(({ sliceId }) => sliceId === "deployment-plan");
  const compiler = join(repositoryRoot, "node_modules/typescript/bin/tsc");
  let workspaceHandle;
  try {
    cloneRepository(repositoryRoot, checkout, boundary);
    copyCurrentRollbackSharedState(checkout, manifest);
    for (const path of ["node_modules", "packages/contexts/supply/node_modules"]) {
      mkdirSync(join(checkout, path), { recursive: true });
      for (const name of readdirSync(join(repositoryRoot, path))) {
        symlinkSync(join(repositoryRoot, path, name), join(checkout, path, name));
      }
    }
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, "public-consumer.mjs"), `
import assert from "node:assert/strict";
import { localPurposeCompilerPorts, prepareLocalPurposeGenesis, readLocalPurposeArtifactPins }
  from "@agent-teams/supply/deployment-files";
const bytes = new TextEncoder().encode("abc");
assert.equal(localPurposeCompilerPorts.sha256(bytes),
  "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(localPurposeCompilerPorts.createAddress("0x" + "11".repeat(20), "0"),
  "0x8f7a45ebde059392e46a46dcc14ab24681a961ea");
assert.throws(() => prepareLocalPurposeGenesis({}, "0".repeat(40),
  { sourceRevision: "0".repeat(40), artifacts: [] }, localPurposeCompilerPorts),
  /LOCAL_PURPOSE_GENESIS_INVALID/);
await assert.rejects(readLocalPurposeArtifactPins("./invalid-pins.json",
  { repositoryRoot: process.cwd(), revision: "0".repeat(40) }),
  /DEPLOYMENT_ARTIFACT_PINS_INVALID/);
`);
    writeFileSync(join(consumer, "invalid-pins.json"), "{}\n");
    writeFileSync(join(consumer, "public-consumer.mts"), `
import { localPurposeCompilerPorts, prepareLocalPurposeGenesis, readLocalPurposeArtifactPins,
  type LocalPurposeCandidate } from "@agent-teams/supply/deployment-files";
const candidate: LocalPurposeCandidate = { repositoryRoot: ".", revision: "0".repeat(40) };
const readerCandidate: Parameters<typeof readLocalPurposeArtifactPins>[1] = candidate;
const ports: Parameters<typeof prepareLocalPurposeGenesis>[3] = localPurposeCompilerPorts;
void readerCandidate;
void ports;
`);
    const verifyConsumer = () => {
      // Rebuild from the applied sources, including declarations, so neither
      // stale dist nor the root workspace link can supply the missing exports.
      basicRun(process.execPath, [compiler, "--build", "--force", "--pretty", "false"], { cwd: checkout });
      basicRun(process.execPath, ["public-consumer.mjs"], { cwd: consumer });
      basicRun(process.execPath, [compiler, "--ignoreConfig", "--noEmit", "--strict", "--module", "NodeNext",
        "--moduleResolution", "NodeNext", "--target", "ES2024", "--types", "node",
        "public-consumer.mts"], { cwd: consumer });
    };
    verifyConsumer();
    mkdirSync(quarantineRoot, { mode: 0o700 });
    workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
    applyManifest(checkout, manifest, { workspaceHandle });
    verifyAppliedState(checkout, manifest, { workspaceHandle });
    verifyConsumer();
    const applied = readFileSync(join(supply, "src/features/genesis-manifest/composition/deployment-files.ts"), "utf8");
    const current = readFileSync(join(repositoryRoot,
      "packages/contexts/supply/src/features/genesis-manifest/composition/deployment-files.ts"), "utf8");
    assert.equal(applied, current, "Supply construction and exports are independent survivors");
    basicRun(process.execPath, ["--input-type=module", "--eval", `
import assert from "node:assert/strict";
import { productionCompilerPorts, readProductionArtifactPins } from "@agent-teams/supply/deployment-files";
import { constructProductionAssembly, prepareAssemblyManifest, materializeObservedAssemblyManifest, generatePassport } from "@agent-teams/supply/deployment";
assert.equal(typeof productionCompilerPorts.encodePurposeVault, "function");
assert.equal(typeof readProductionArtifactPins, "function");
assert.equal(typeof constructProductionAssembly, "function");
assert.equal(typeof prepareAssemblyManifest, "function");
assert.equal(typeof materializeObservedAssemblyManifest, "function");
assert.equal(typeof generatePassport, "function");
`], { cwd: supply });
  } finally {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("deployment-plan retains every Supply assembly and passive Safe custody byte", () => {
  const manifest = manifests().find(({ sliceId }) => sliceId === "deployment-plan");

  for (const path of [...supplySurvivors, ...passiveSafeSurvivors]) {
    assert.ok(!manifest.sharedPaths.includes(path));
    assert.ok(!manifest.reverseEdits.some(edit => edit.path === path));
    assert.equal(manifest.retainedSharedPaths.find(entry => entry.path === path)?.sha256,
      digestFile(join(repositoryRoot, path)), path);
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
    cloneRepository(repositoryRoot, checkout, boundary);
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
