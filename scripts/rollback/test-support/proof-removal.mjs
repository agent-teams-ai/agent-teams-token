import { createRequire } from "node:module";
import { snapshotRollbackSharedPaths } from "../slices/shared-paths.mjs";
import { editWorkflowTest, removeWorkflowJob } from "../slices/transforms.mjs";
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

test("staged removal custody authenticates its destination and preserves replacements", () => {
  for (const mode of ["forbidden-residue", "raw-syscall", "replacement"]) {
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
            } else if (mode === "raw-syscall") {
              renameSync(details.sourcePath, rawOriginal);
            } else {
              renameSync(details.sourcePath, rawOriginal);
              mkdirSync(details.sourcePath);
              writeFileSync(
                join(details.sourcePath, "replacement"),
                "replacement-survives\n",
              );
            }
          },
        }),
        (error) => {
          primaryFailure = error;
          if (mode === "forbidden-residue") {
            return /ROLLBACK_REMOVAL_PHASE_FAILED.*ROLLBACK_FORBIDDEN_DIRECTORY_RESIDUE/u
              .test(error.message);
          }
          if (mode === "raw-syscall") {
            return /ROLLBACK_REMOVAL_PHASE_FAILED.*ENOENT/u.test(error.message);
          }
          return /ROLLBACK_REMOVAL_SUBSTITUTED/u.test(error.message);
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
        assert.equal(existsSync(owned), false);
        assert.equal(lstatSync(staged).isDirectory(), true);
        assert.equal(readFileSync(join(staged, "foreign"), "utf8"), "foreign-survives\n");
      } else if (mode === "raw-syscall") {
        assert.equal(lstatSync(rawOriginal).isDirectory(), true);
        assert.equal(existsSync(staged), false);
      } else {
        assert.equal(lstatSync(rawOriginal).isDirectory(), true);
        assert.equal(
          readFileSync(join(owned, "replacement"), "utf8"),
          "replacement-survives\n",
        );
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

const workflowPolicyTitle = "package-manager policy disables implicit downloads and the final check has no silent omissions";
const workflowPolicyPattern = "^(workflow syntax|all third-party|every job|workflow dispatch|foundation |solidity job|local EVM job|local Solana job|deployment-plan job|Slither job|Compose |package-manager policy)";
const workflowNodePolicyTitle = "actual workflow Node validation ignores inherited preload and proxy authority";
const workflowNodePolicyBlock = /^test\("actual workflow Node validation ignores inherited preload and proxy authority",[\s\S]*?^\}\);\n/gmu;

function workflowPolicyFixture(context, manifest) {
  const boundary = temporaryDirectory("agtmai-rollback-workflow-policy-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  let workspaceHandle;
  context.after(() => {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  });
  proofSupport.cloneRepository(repositoryRoot, checkout, boundary);
  copyCurrentRollbackSharedState(checkout, manifest);
  const requireFromSupply = createRequire(join(repositoryRoot, "packages/contexts/supply/package.json"));
  mkdirSync(join(checkout, "node_modules"));
  symlinkSync(dirname(requireFromSupply.resolve("yaml/package.json")), join(checkout, "node_modules/yaml"), "dir");
  mkdirSync(quarantineRoot, { mode: 0o700 });
  workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
  return { checkout, workspaceHandle, parse: requireFromSupply("yaml").parse };
}

function checkWorkflowPolicies(checkout, pattern, count, failures = 0) {
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`,
    "scripts/tests/workflow.test.mjs",
  ], { cwd: checkout, env: {}, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, output);
  assert.equal(result.signal, null, output);
  assert.equal(result.status, failures === 0 ? 0 : 1, output);
  assert.match(result.stdout, new RegExp(`^# tests ${count}$`, "mu"), output);
  assert.match(result.stdout, new RegExp(`^# fail ${failures}$`, "mu"), output);
  assert.match(result.stdout, /^# skipped 0$/mu, output);
  if (failures === 0) {
    parseStrictTap(result.stdout, workflowPolicyTitle);
  } else {
    assert.match(result.stdout, new RegExp(`^not ok [0-9]+ - ${workflowPolicyTitle}$`, "mu"), output);
  }
}

for (const manifest of manifests()) {
  test(`workflow rollback ${manifest.sliceId} preserves executable candidate and restored policies`, (context) => {
    const { checkout, workspaceHandle, parse } = workflowPolicyFixture(context, manifest);
    const packagePath = "package.json";
    const workflowPath = ".github/workflows/ci.yml";
    const testPath = "scripts/tests/workflow.test.mjs";
    const candidatePackage = JSON.parse(readFileSync(join(checkout, packagePath), "utf8"));
    const candidateWorkflow = parse(readFileSync(join(checkout, workflowPath), "utf8"));
    const candidateNodePolicy = readFileSync(join(checkout, testPath), "utf8").match(workflowNodePolicyBlock);
    assert.equal(candidateNodePolicy?.length, 1);
    const reject = (path, changed) => {
      const original = readFileSync(join(checkout, path));
      try {
        writeFileSync(join(checkout, path), typeof changed === "string" ? changed : JSON.stringify(changed));
        checkWorkflowPolicies(checkout, `^${workflowPolicyTitle}$`, 1, 1);
      } finally {
        writeFileSync(join(checkout, path), original);
      }
    };
    checkWorkflowPolicies(checkout, workflowPolicyPattern, 12);
    reject(packagePath, { ...candidatePackage, scripts: { ...candidatePackage.scripts, "check:linux": "pnpm check" } });
    const candidateJobs = candidateWorkflow.jobs;
    const candidateFoundation = candidateJobs["foundation-and-typescript"];
    reject(workflowPath, { ...candidateWorkflow, jobs: {
      ...candidateJobs,
      "foundation-and-typescript": { ...candidateFoundation, steps: candidateFoundation.steps.map((step) =>
        step.id === "run-root-check-with-exact-rollback-proof" ? { ...step, run: "pnpm check" } : step) },
    } });

    const sharedPlan = snapshotRollbackSharedPaths(checkout, [packagePath, workflowPath, testPath], workspaceHandle);
    editPackage(checkout, manifest.sliceId, { sharedPlan, workspaceHandle });
    removeWorkflowJob(checkout, manifest, sharedPlan, workspaceHandle);
    editWorkflowTest(checkout, manifest, sharedPlan, workspaceHandle);
    const slitherRemoved = manifest.sliceId === "slither";
    checkWorkflowPolicies(checkout, slitherRemoved ? ".*" : workflowPolicyPattern, slitherRemoved ? 14 : 11);
    assert.deepEqual(
      readFileSync(join(checkout, testPath), "utf8").match(workflowNodePolicyBlock),
      manifest.sliceId === "slither" ? null : candidateNodePolicy,
    );

    const restoredPackage = JSON.parse(readFileSync(join(checkout, packagePath), "utf8"));
    const restoredWorkflow = parse(readFileSync(join(checkout, workflowPath), "utf8"));
    for (const [name, job] of Object.entries(restoredWorkflow.jobs)) {
      if (name !== "foundation-and-typescript") {
        assert.deepEqual(job, candidateJobs[name], name);
      }
    }
    for (const key of ["check:linux", "rollback:preflight", "rollback:prove", "rollback:test", "rollback:evidence:validate"]) {
      assert.equal(restoredPackage.scripts[key], undefined, key);
    }
    assert.doesNotMatch(restoredPackage.scripts.check, /rollback:/u);
    const removedCheck = {
      "local-solana": "test:local-solana",
      "deployment-plan": "test:deployment-plan",
      slither: "security:slither:test",
    }[manifest.sliceId];
    const survivingChecks = [
      "test:linux-parity", "genesis:vector:check", "security:check", "test:local-evm:built",
      "test:local-solana", "test:deployment-plan", "security:slither:test",
    ].filter((command) => command !== removedCheck);
    for (const check of [
      ...survivingChecks.map((command) => restoredPackage.scripts.check.replace(`pnpm ${command}`, "true")),
      ...[" || true", " --if-present", " && pnpm rollback:preflight", " && pnpm rollback:prove"]
        .map((suffix) => restoredPackage.scripts.check + suffix),
    ]) {
      reject(packagePath, { ...restoredPackage, scripts: { ...restoredPackage.scripts, check } });
    }
    reject(packagePath, { ...restoredPackage, packageManager: "pnpm@0.0.0" });
    reject(packagePath, { ...restoredPackage, scripts: { ...restoredPackage.scripts, "check:linux": "pnpm check" } });
    reject(packagePath, { ...restoredPackage, scripts: { ...restoredPackage.scripts, "test:linux-parity": "node --test scripts/tests/workflow.test.mjs" } });
    for (const [path, before, after] of [
      [".npmrc", "manage-package-manager-versions=false", "manage-package-manager-versions=true"],
      ["pnpm-workspace.yaml", "autoInstallPeers: false", "autoInstallPeers: true"],
      ["pnpm-lock.yaml", "autoInstallPeers: false", "autoInstallPeers: true"],
    ]) {
      reject(path, readFileSync(join(checkout, path), "utf8").replace(before, after));
    }
    const foundation = restoredWorkflow.jobs["foundation-and-typescript"];
    for (const steps of [
      foundation.steps.filter((step) => step.name !== "Final repository check"),
      foundation.steps.map((step) => step.name === "Final repository check"
        ? { ...step, run: "source scripts/env.sh && pnpm check:linux" } : step),
      [...foundation.steps, { id: "run-root-check-with-exact-rollback-proof", run: "pnpm check:linux" }],
    ]) {
      reject(workflowPath, { ...restoredWorkflow, jobs: {
        ...restoredWorkflow.jobs, "foundation-and-typescript": { ...foundation, steps },
      } });
    }
    context.diagnostic(`12 candidate and ${slitherRemoved ? 14 : 11} restored policy tests; 21 policy mutations rejected; Slither Node policy removed only with Slither`);
  });

  test(`workflow rollback ${manifest.sliceId} rejects missing or duplicated slice-only tests and assertions without writing`, (context) => {
    const { checkout, workspaceHandle } = workflowPolicyFixture(context, manifest);
    const path = "scripts/tests/workflow.test.mjs";
    const source = readFileSync(join(checkout, path), "utf8");
    const assertions = [
      ["workflow-linux-check-policy", /  assert.equal\(\n    packageJson.scripts\["check:linux"\],[\s\S]*?\n  \);/u],
      ["workflow-root-check-policy", /  assert.match\(\n    workflow.jobs\["foundation-and-typescript"\].steps\n      .find\(\(step\) => step.id === "run-root-check-with-exact-rollback-proof"\).run,[\s\S]*?\n  \);/u],
    ];
    if (manifest.sliceId === "slither") {assertions.push([workflowNodePolicyTitle, workflowNodePolicyBlock]);}
    for (const [label, pattern] of assertions) {
      const assertion = source.match(pattern)?.[0];
      assert.ok(assertion, label);
      const replacements = ["", `${assertion}\n${assertion}`];
      if (label === workflowNodePolicyTitle) {
        replacements.push(`${assertion}\n${assertion.replace("30_000", "29_000")}`);
      }
      for (const replacement of replacements) {
        const changed = source.replace(assertion, replacement);
        writeFileSync(join(checkout, path), changed);
        const sharedPlan = snapshotRollbackSharedPaths(checkout, [path], workspaceHandle);
        assert.throws(
          () => editWorkflowTest(checkout, manifest, sharedPlan, workspaceHandle),
          { message: label === workflowNodePolicyTitle
            ? `ROLLBACK_WORKFLOW_TEST_${replacement === "" ? "MISSING" : "AMBIGUOUS"} title=${label}`
            : `ROLLBACK_EXACT_EDIT_MISMATCH edit=${manifest.sliceId}:${label}` },
        );
        assert.equal(readFileSync(join(checkout, path), "utf8"), changed);
      }
    }
  });
}
