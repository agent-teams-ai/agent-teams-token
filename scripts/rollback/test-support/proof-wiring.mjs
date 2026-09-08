import * as proofSupport from "./proof-fixture.mjs";
const { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture } = proofSupport;
export { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture };

test("portable root check and mandatory Linux proof wiring are integrated pending execution", () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["rollback:preflight"],
    ".tools/bin/node scripts/rollback/prove-slices.mjs --preflight-only",
  );
  assert.equal(
    packageJson.scripts["rollback:test"],
    ".tools/bin/node --test scripts/tests/rollback-*.test.mjs",
  );
  assert.doesNotMatch(packageJson.scripts.check, /rollback:(?:preflight|prove)/u);
  assert.equal(
    packageJson.scripts["check:linux"],
    "pnpm rollback:preflight && pnpm check && pnpm rollback:prove",
  );
  assert.doesNotMatch(packageJson.scripts.check, /ROLLBACK.*SKIP|--if-present/u);

  const request = JSON.parse(readFileSync(
    join(repositoryRoot, "architecture/rollback/ci-wiring-request.v1.json"),
    "utf8",
  ));
  assert.equal(request.status, "integrated-pending-execution");
  assert.equal(request.integrationStrategy, "augment-existing-root-check-job");
  assert.equal(request.job, undefined);
  const patch = request.existingJobPatch;
  assert.equal(patch.jobId, "foundation-and-typescript");
  assert.equal(patch.dedicated, false);
  assert.equal(patch.needsChange, "none");
  assert.deepEqual(patch.timeoutMinutes, { from: 15, to: 120 });
  assert.equal(
    patch.steps[0].env.AGTMAI_ROLLBACK_EVIDENCE_DIRECTORY,
    "${{ runner.temp }}/rollback-proof-${{ github.sha }}",
  );
  assert.equal(patch.environment.SLITHER_DOCKER_PATH, "/usr/bin/docker");
  assert.match(patch.environment.SLITHER_FORGE_PATH, /foundry-v1\.8\.0-linux-x64\/forge$/u);
  assert.match(patch.environment.SLITHER_SOLC_PATH, /solc-v0\.8\.36-linux-x64\/solc$/u);
  const rootCheck = patch.steps.find(({ id }) => id === "run-root-check-with-exact-rollback-proof");
  assert.equal(rootCheck.run, "source scripts/env.sh && pnpm check:linux");
  const preload = patch.steps.find(({ id }) => id === "preload-pinned-slither-image");
  assert.match(preload.run, /security:solidity:prepare-image/u);
  const preflight = patch.steps.find(
    ({ id }) => id === "non-pulling-rollback-environment-cache-preflight",
  );
  assert.equal(
    preflight.run,
    "source scripts/env.sh && pnpm rollback:preflight -- --expected-sha=\"$GITHUB_SHA\"",
  );
  const cleanAfter = patch.steps.find(
    ({ id }) => id === "assert-complete-history-and-exact-clean-head-after",
  );
  assert.equal(cleanAfter.if, "${{ always() }}");
  assert.match(cleanAfter.run, /assert-complete-history\.sh/u);
  assert.match(cleanAfter.run, /assert-clean-head\.sh/u);
  const validation = patch.steps.find(({ id }) => id === "validate-rollback-proof");
  assert.equal(validation.if, "${{ success() }}");
  assert.match(validation.run, /pnpm rollback:evidence:validate --/u);
  assert.match(validation.run, /assert-complete-history\.sh/u);
  assert.match(validation.run, /assert-clean-head\.sh/u);
  const upload = patch.steps.find(({ id }) => id === "upload-rollback-proof-evidence");
  assert.equal(
    upload.if,
    "${{ success() && steps.validate-rollback-proof.outcome == 'success' }}",
  );
  assert.equal(
    upload.with.path,
    "${{ runner.temp }}/rollback-proof-${{ github.sha }}",
  );
  assert.doesNotMatch(upload.with.path, /\$RUNNER_TEMP|\$GITHUB_SHA/u);
  assert.equal(upload.with["if-no-files-found"], "error");
  const diagnostics = patch.steps.find(({ id }) => id === "upload-rollback-failure-diagnostics");
  assert.equal(diagnostics.if, "${{ failure() }}");
  assert.match(diagnostics.with.name, /^rollback-diagnostics-/u);
  assert.doesNotMatch(diagnostics.with.path, /statement\.json|seal\.json|READY/u);
  assert.equal(diagnostics.with["if-no-files-found"], "warn");
  assert.equal(request.coordinatedExternalChanges.manifestRehash.required, false);
  assert.equal(
    request.coordinatedExternalChanges.manifestRehash.status,
    "rehashed-worktree-validated-pending-exact-head-full-proof",
  );
  assert.match(
    request.coordinatedExternalChanges.rollbackTransforms.join("\n"),
    /every operational slice removal strips rollback:test and rollback:prove/u,
  );
  assert.match(
    request.coordinatedExternalChanges.rollbackTransforms.join("\n"),
    /editWorkflowTest must reverse[\s\S]*timeout 120 back to 15/u,
  );
});

test("the full plan names every genuine common and strict survivor gate", () => {
  for (const id of [
    "foundation-check",
    "lint",
    "typecheck",
    "build",
    "local-evm-integration",
    "forge-unit-fuzz",
    "forge-invariants",
  ]) {
    assert.ok(rollbackGateCoverage.common.includes(id), id);
  }
  assert.ok(rollbackGateCoverage.survivors["local-solana"].includes("solana-unit-and-strict-real"));
  assert.ok(rollbackGateCoverage.survivors["deployment-plan"].includes("deployment-unit-suite"));
  assert.ok(rollbackGateCoverage.survivors["deployment-plan"].includes("deployment-strict-anvil"));
  assert.ok(rollbackGateCoverage.survivors.slither.includes("slither-real-analyzer"));
  assert.ok(rollbackGateCoverage.survivors.slither.includes("slither-evidence-validate"));

  const runner = readFileSync(
    join(repositoryRoot, "scripts/rollback/slices/gate-execution.mjs"),
    "utf8",
  );
  assert.match(runner, /--offline/u);
  assert.match(runner, /--no-auto-detect/u);
  assert.match(runner, /AGTMAI_SOLANA_REAL_TESTS_REQUIRED: "1"/u);
  assert.match(runner, /GITHUB_SHA: rollbackSha/u);
  assert.match(runner, /\["security:solidity"\]/u);
  assert.doesNotMatch(
    JSON.stringify(rollbackGateCoverage),
    /security:solidity:prepare-image/u,
  );
});

test("production proof orders capture, slice application, rollback and exact equivalence per slice", () => {
  const source = readFileSync(
    join(repositoryRoot, "scripts/rollback/slices/proof-slice.mjs"),
    "utf8",
  );
  const orchestration = source.slice(
    source.indexOf("export function proveSlice("),
    source.indexOf("\nfunction createSliceContext("),
  );
  let orchestrationCursor = -1;
  for (const operation of [
    "prepareSlicePreState(context)",
    "applyCandidateSlice(context)",
    "executeRollback(context, preState)",
    "executeSliceGates(context, preState.identity)",
    "finalizeSlice(context, primaryFailure)",
  ]) {
    const index = orchestration.indexOf(operation);
    assert.ok(index > orchestrationCursor, operation);
    orchestrationCursor = index;
  }
  const proof = source.slice(
    source.indexOf("function capturePreState("),
    source.indexOf("\nfunction recordSliceFailure("),
  );
  let cursor = -1;
  for (const stage of [
    "capture-pre-state-status",
    "pre-state-owned-root-shape",
    "capture-pre-state-complete-inventory",
    "apply-slice-from-captured-pre-state",
    "verify-applied-slice-byte-equivalence",
    "execute-production-rollback",
    "verify-rollback-status-equivalence",
    "verify-rollback-forbidden-residue-absent",
    "verify-rollback-owned-root-shape",
  ]) {
    const index = proof.indexOf('"' + stage + '"');
    assert.ok(index > cursor, stage);
    cursor = index;
  }
  const treeVerification = proof.indexOf("assertRollbackTree(context");
  const inventoryVerification = proof.indexOf('"verify-rollback-inventory-equivalence"');
  assert.ok(treeVerification > cursor && inventoryVerification > treeVerification);
  assert.match(source, /"verify-rollback-byte-tree-equivalence"/u);
  assert.match(proof, /statusEquivalentToPreState: true/u);
  assert.match(proof, /treeEquivalentToPreState: true/u);
  assert.match(proof, /inventoryEquivalentToPreState: true/u);
});

test("all tool and cached Slither image preflights precede dependent quality gates", () => {
  const gates = readFileSync(
    join(repositoryRoot, "scripts/rollback/slices/gate-execution.mjs"),
    "utf8",
  );
  const cliSource = readFileSync(
    join(repositoryRoot, "scripts/rollback/slices/cli.mjs"),
    "utf8",
  );
  const proofGates = readFileSync(
    join(repositoryRoot, "scripts/rollback/slices/proof-gates.mjs"),
    "utf8",
  );
  const globalStart = gates.indexOf("export function pinnedEnvironmentPreflight(");
  const globalEnd = gates.indexOf("\nexport function preflightPinnedEnvironment(", globalStart);
  const globalPreflight = gates.slice(globalStart, globalEnd);
  let globalCursor = -1;
  for (const token of [
    "assertPinnedNodeRuntime(root)",
    '"bootstrap-core-cache-verify"',
    '"bootstrap-solana-cache-verify"',
    "strictToolPaths(root",
    '"pnpm-store-path"',
    '"pnpm-frozen-offline-completeness"',
    "validatePnpmWorkspaceLinks(root)",
    '"slither-pinned-image-cache"',
  ]) {
    const index = globalPreflight.indexOf(token);
    assert.ok(index > globalCursor, token);
    globalCursor = index;
  }

  const cli = cliSource.slice(
    cliSource.indexOf("function runRecordedProof("),
    cliSource.indexOf("\nfunction createProofRecorder("),
  );
  const history = cli.indexOf("recordCandidateAndManifests(");
  const global = cli.indexOf("recordGlobalEnvironment(");
  const coverage = cli.indexOf("recordManifestGitCoverage(");
  const materialize = cli.indexOf("proveAllSlices(");
  assert.ok(history >= 0 && global > history && coverage > global && materialize > coverage);

  const proof = proofGates.slice(
    proofGates.indexOf("export function executeSliceGates("),
    proofGates.indexOf("\nfunction validatePostGateState("),
  );
  const preflight = proof.indexOf("preflightQualityGateEnvironment(checkout, manifest, recorder, group)");
  const commonGates = proof.indexOf("runCommonGates(checkout, recorder, group, tools, environment)");
  assert.ok(preflight >= 0 && commonGates > preflight);

  const preflightStart = gates.indexOf("export function preflightQualityGateEnvironment(");
  const preflightEnd = gates.indexOf("\nexport function runCommonGates(", preflightStart);
  const preflightSource = gates.slice(preflightStart, preflightEnd);
  assert.match(preflightSource, /quality-gate-tool-cache-preflight/u);
  assert.match(preflightSource, /slither-pinned-image-cache-preflight/u);
  assert.match(preflightSource, /\["image", "inspect", pinned\.reference/u);
  assert.match(preflightSource, /phase: "preflight"/u);

  const survivorStart = gates.indexOf("export function runSurvivorGate(");
  const survivorEnd = gates.indexOf("\nfunction combineRollbackFailures(", survivorStart);
  const survivorSource = gates.slice(survivorStart, survivorEnd);
  assert.doesNotMatch(survivorSource, /strictToolPaths/u);
  assert.match(survivorSource, /ROLLBACK_SLITHER_PREFLIGHT_MISSING/u);
});
