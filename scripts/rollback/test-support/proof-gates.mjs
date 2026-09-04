import { pinnedEnvironmentPreflight } from "../slices/gate-execution.mjs";
import * as proofSupport from "./proof-fixture.mjs";
const { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture } = proofSupport;
export { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture };
const { cloneRepository } = proofSupport;

test("default preflight options reach fail-closed runtime validation", () => {
  const root = temporaryDirectory("agtmai-rollback-preflight-defaults-");
  try {
    assert.throws(
      () => pinnedEnvironmentPreflight(root),
      process.platform === "darwin"
        ? /ROLLBACK_RUNTIME_LOADED_IMAGE_BINDING_UNAVAILABLE/u
        : /ROLLBACK_RUNTIME_LOCK_MISSING/u,
    );
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-pulling image preflight verifies exact cached Slither image identity", () => {
  const root = temporaryDirectory("agtmai-rollback-preflight-");
  const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const docker = join(root, "usr/bin/docker");
  const repository = "ghcr.io/trailofbits/eth-security-toolbox";
  const digest = "sha256:" + "9".repeat(64);
  const revision = "8".repeat(40);
  const inspection = JSON.stringify({
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [repository + "@" + digest],
    Config: { Labels: { "org.opencontainers.image.revision": revision } },
  });
  try {
    for (const path of [
      join(root, ".tools/bin/node"),
      join(root, ".tools/bin/pnpm"),
      join(root, ".tools/foundry-v1.8.0-" + platform + "/forge"),
      join(root, ".tools/foundry-v1.8.0-" + platform + "/cast"),
      join(root, ".tools/foundry-v1.8.0-" + platform + "/anvil"),
      join(root, ".tools/solc-v0.8.36-" + platform + "/solc"),
      ...["solana", "solana-keygen", "solana-test-validator", "spl-token"].map((name) =>
        join(root, ".tools/agave-v4.2.1-" + platform + "/bin/" + name)),
    ]) {
      writeExecutable(path);
    }
    writeExecutable(
      docker,
      "#!/bin/sh\n"
      + "test \"$1\" = image && test \"$2\" = inspect || exit 91\n"
      + "printf '%s\\n' '" + inspection + "'\n",
    );
    mkdirSync(join(root, "tooling"), { recursive: true });
    writeFileSync(join(root, "tooling/toolchain.lock.json"), JSON.stringify({
      securityImages: {
        slither: {
          repository,
          tag: "nightly-test",
          manifestDigest: digest,
          sourceRevision: revision,
          platform: "linux/amd64",
        },
      },
    }));
    const result = preflightPinnedSlitherImage(root, { dockerPath: docker });
    assert.equal(result.manifestDigest, digest);
    assert.equal(result.sourceRevision, revision);
    assert.equal(result.platform, "linux/amd64");

    writeExecutable(
      docker,
      "#!/bin/sh\nprintf '%s\\n' '"
      + inspection.replace(revision, "7".repeat(40)) + "'\n",
    );
    assert.throws(
      () => preflightPinnedSlitherImage(root, { dockerPath: docker }),
      /ROLLBACK_SLITHER_IMAGE_CACHE_MISMATCH/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forced analyzer failure retains complete logs and machine-readable status", () => {
  const root = temporaryDirectory("agtmai-rollback-evidence-test-");
  try {
    const recorder = new EvidenceRecorder(root, { mode: "test" });
    assert.throws(
      () => recorder.run(
        "slither",
        "slither-real-analyzer",
        process.execPath,
        ["-e", "process.stdout.write('analyzer-out'); process.stderr.write('analyzer-err'); process.exit(23)"],
        { cwd: repositoryRoot, env: process.env, timeout: 30_000 },
      ),
      /ROLLBACK_COMMAND_FAILED/u,
    );
    recorder.finalize("failed", new Error("forced analyzer failure"));
    const evidence = JSON.parse(readFileSync(join(root, "diagnostics.json"), "utf8"));
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.commands.length, 1);
    assert.equal(evidence.commands[0].id, "slither-real-analyzer");
    assert.equal(evidence.commands[0].exitCode, 23);
    assert.equal(evidence.commands[0].status, "failed");
    assert.equal(
      readFileSync(join(root, evidence.commands[0].stdout.path), "utf8"),
      "analyzer-out",
    );
    assert.equal(
      readFileSync(join(root, evidence.commands[0].stderr.path), "utf8"),
      "analyzer-err",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strict TAP validation requires the named real test and zero skips or failures", () => {
  const title = "real loopback Anvil estimates freshly built exact AGTMAIToken initcode within tolerance";
  const valid = [
    "TAP version 13",
    "# Subtest: " + title,
    "ok 1 - " + title,
    "1..1",
    "# tests 1",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "",
  ].join("\n");
  assert.equal(parseStrictTap(valid, title).status, "passed");
  for (const forged of [
    valid.replace("# Subtest: " + title, "# Subtest: unit-only"),
    valid.replace("# skipped 0", "# skipped 1"),
    valid.replace("# fail 0", "# fail 1"),
    valid.replace("# cancelled 0", "# cancelled 1"),
    valid.replace("# todo 0", "# todo 1"),
    valid.replace("# tests 1", "# tests 0").replace("# pass 1", "# pass 0"),
    valid.replace("ok 1 - " + title, "not ok 1 - " + title),
    valid.replace("# skipped 0\n", ""),
    valid.replace("# skipped 0", "# skipped 0\n# skipped 0"),
    valid.replace("ok 1 - " + title, "ok 1 - " + title + " # SKIP unavailable"),
  ]) {
    assert.throws(
      () => parseStrictTap(forged, title),
      /ROLLBACK_STRICT_(?:TAP_SUMMARY_INVALID|TEST_SKIPPED_OR_MISSING)/u,
    );
  }
});

test("machine gate coverage is the exact ordered plan and rejects every drift", () => {
  const manifest = manifests()[0];
  const expected = expectedGateIds(manifest);
  const exact = expected.map((id, index) => ({
    sequence: index + 1,
    group: manifest.sliceId,
    id,
    phase: "gate",
    status: "passed",
  }));
  exact.push({
    sequence: exact.length + 1,
    group: manifest.sliceId,
    id: "clone-candidate",
    phase: "preparation",
    status: "passed",
  });
  assert.equal(gateCoverageSnapshot(exact, manifest).status, "passed");
  const mutations = [
    exact.filter(({ id }) => id !== expected[0]),
    [...exact, { ...exact[0], sequence: 999 }],
    [...exact, { ...exact[0], id: "unknown-gate", sequence: 999 }],
    exact.map((entry, index) => index === 0 ? { ...entry, group: "wrong-slice" } : entry),
    exact.map((entry, index) => index === 0 ? { ...entry, status: "failed" } : entry),
    [exact[1], exact[0], ...exact.slice(2)],
  ];
  for (const mutation of mutations) {
    assert.equal(gateCoverageSnapshot(mutation, manifest).status, "failed");
  }
});

test("CLI parsing rejects duplicates, conflicts and ignored evidence options", () => {
  assert.deepEqual(parseCliArguments([], {}), {
    mode: "full",
    expectedSha: undefined,
    evidencePath: undefined,
    printHashesSlice: undefined,
  });
  const sha = "a".repeat(40);
  assert.equal(parseCliArguments([], { GITHUB_SHA: sha }).expectedSha, sha);
  assert.equal(parseCliArguments(["--expected-sha=" + "b".repeat(40)], {
    GITHUB_SHA: sha,
  }).expectedSha, "b".repeat(40));
  assert.equal(parseCliArguments(["--prepare-only", "--evidence-dir=/tmp/proof"], {}).mode, "prepare");
  assert.equal(parseCliArguments(["--preflight-only"], {}).mode, "preflight");
  assert.equal(parseCliArguments(["--validate-only"], {
    AGTMAI_ROLLBACK_EVIDENCE_DIRECTORY: "/tmp/ambient",
  }).evidencePath, undefined);
  for (const cliArguments of [
    ["--validate-only", "--validate-only"],
    ["--preflight-only", "--preflight-only"],
    ["--prepare-only", "--prepare-only"],
    ["--expected-sha=" + sha, "--expected-sha=" + sha],
    ["--print-hashes=slither", "--print-hashes=slither"],
    ["--evidence-dir=/tmp/a", "--evidence-dir=/tmp/b"],
    ["--validate-only", "--prepare-only"],
    ["--preflight-only", "--validate-only"],
    ["--preflight-only", "--prepare-only"],
    ["--preflight-only", "--print-hashes=slither"],
    ["--validate-only", "--print-hashes=slither"],
    ["--prepare-only", "--print-hashes=slither"],
    ["--validate-only", "--evidence-dir=/tmp/proof"],
    ["--preflight-only", "--evidence-dir=/tmp/proof"],
    ["--print-hashes=slither", "--evidence-dir=/tmp/proof"],
    ["--expected-sha="],
    ["--expected-sha=" + "A".repeat(40)],
    ["--expected-sha=" + "a".repeat(39)],
    ["--evidence-dir="],
    ["--print-hashes="],
    ["--validate-only=true"],
    ["--expected-sha-extra=" + sha],
    ["--unknown"],
  ]) {
    assert.throws(() => parseCliArguments(cliArguments, {}), /ROLLBACK_ARGUMENT_/u);
  }
});

test("full-mode preflight failure still finalizes machine-readable evidence", () => {
  const boundary = temporaryDirectory("agtmai-rollback-early-evidence-");
  const evidence = join(boundary, "evidence");
  try {
    const result = spawnSync(process.execPath, [
      join(repositoryRoot, "scripts/rollback/prove-slices.mjs"),
      "--expected-sha=" + "0".repeat(40),
      "--evidence-dir=" + evidence,
    ], { cwd: repositoryRoot, encoding: "utf8", env: process.env, timeout: 120_000 });
    assert.notEqual(result.status, 0);
    const document = JSON.parse(readFileSync(join(evidence, "diagnostics.json"), "utf8"));
    assert.equal(document.status, "failed");
    assert.equal(document.mode, "full");
    assert.equal(
      document.globalManifestEvidence,
      "candidate-bound-manifests-pending-proof-completion",
    );
    assert.match(document.error.message, /ROLLBACK_CANDIDATE_SHA_MISMATCH/u);
    assert.equal(document.stages.find(({ id }) => id === "exact-clean-candidate").status, "failed");
    assert.deepEqual(document.commands, []);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});

test("clean-candidate CLI validates current hashes and rejects drift and unpinned maintenance", () => {
  const boundary = temporaryDirectory("agtmai-rollback-cli-lifecycle-");
  const checkout = join(boundary, "candidate");
  const temporaryRoot = join(boundary, "tmp");
  try {
    cloneRepository(repositoryRoot, checkout, boundary);
    cpSync(join(repositoryRoot, "architecture/rollback"), join(checkout, "architecture/rollback"), {
      recursive: true,
    });
    cpSync(join(repositoryRoot, "scripts/rollback"), join(checkout, "scripts/rollback"), {
      recursive: true,
    });
    cpSync(
      join(repositoryRoot, "scripts/assert-complete-history.sh"),
      join(checkout, "scripts/assert-complete-history.sh"),
    );
    for (const path of [
      "scripts/toolchain-archive.mjs",
      "scripts/toolchain-environment.mjs",
      "scripts/toolchain-policy.mjs",
      "scripts/toolchain-provenance.mjs",
    ]) {
      cpSync(join(repositoryRoot, path), join(checkout, path));
    }
    cpSync(
      join(repositoryRoot, "architecture/foundation/repository-agent-workflow.yaml"),
      join(checkout, "architecture/foundation/repository-agent-workflow.yaml"),
    );
    cpSync(
      join(repositoryRoot, "scripts/tests/tooling-boundaries.test.mjs"),
      join(checkout, "scripts/tests/tooling-boundaries.test.mjs"),
    );
    writeFileSync(join(checkout, "package.json"), readFileSync(join(repositoryRoot, "package.json")));
    git(checkout, ["config", "user.name", "Rollback CLI Test"]);
    git(checkout, ["config", "user.email", "rollback-cli-test@invalid.local"]);
    git(checkout, [
      "add",
      "architecture/rollback",
      "architecture/foundation/repository-agent-workflow.yaml",
      "scripts/assert-complete-history.sh",
      "scripts/rollback",
      "scripts/tests/tooling-boundaries.test.mjs",
      "scripts/toolchain-archive.mjs",
      "scripts/toolchain-environment.mjs",
      "scripts/toolchain-policy.mjs",
      "scripts/toolchain-provenance.mjs",
      "package.json",
    ]);
    git(checkout, ["commit", "--quiet", "-m", "test: integrated rollback candidate"]);
    let candidateSha = git(checkout, ["rev-parse", "HEAD"]).trim();
    mkdirSync(temporaryRoot, { mode: 0o700 });
    const environment = {
      ...process.env,
      AGTMAI_ROLLBACK_TMPDIR: temporaryRoot,
      PATH: "/usr/local/bin:/usr/bin:/bin",
    };

    const cleanValidation = spawnSync(process.execPath, [
      "scripts/rollback/prove-slices.mjs",
      "--validate-only",
      "--expected-sha=" + candidateSha,
    ], { cwd: checkout, encoding: "utf8", env: environment, timeout: 120_000 });
    assert.equal(cleanValidation.status, 0, cleanValidation.stderr);
    assert.ok(cleanValidation.stdout.includes(
      "rollback-validation candidate=" + candidateSha + " result=pass",
    ));
    assert.deepEqual(readdirSync(temporaryRoot), []);

    appendFileSync(join(checkout, "package.json"), "\n");
    git(checkout, ["add", "package.json"]);
    git(checkout, ["commit", "--quiet", "-m", "test: stale rollback transition"]);
    candidateSha = git(checkout, ["rev-parse", "HEAD"]).trim();

    const validation = spawnSync(process.execPath, [
      "scripts/rollback/prove-slices.mjs",
      "--validate-only",
      "--expected-sha=" + candidateSha,
    ], { cwd: checkout, encoding: "utf8", env: environment, timeout: 120_000 });
    assert.notEqual(validation.status, 0);
    assert.match(
      validation.stderr,
      /ROLLBACK_INTEGRATOR_REHASH_REQUIRED/u,
    );
    assert.deepEqual(readdirSync(temporaryRoot), []);

    const hashes = spawnSync(process.execPath, [
      "scripts/rollback/prove-slices.mjs",
      "--print-hashes=deployment-plan",
      "--expected-sha=" + candidateSha,
    ], { cwd: checkout, encoding: "utf8", env: environment, timeout: 120_000 });
    assert.notEqual(hashes.status, 0);
    assert.equal(hashes.stdout, "");
    const lock = JSON.parse(readFileSync(join(checkout, "tooling/toolchain.lock.json"), "utf8"));
    const expectedRuntimeFailure = process.platform === "darwin"
      ? "ROLLBACK_RUNTIME_LOADED_IMAGE_BINDING_UNAVAILABLE"
      : process.version !== "v" + lock.tools.node.version
        ? "ROLLBACK_RUNTIME_VERSION_MISMATCH"
        : "ROLLBACK_RUNTIME_EXEC_PATH_MISMATCH";
    assert.ok(hashes.stderr.includes(expectedRuntimeFailure), hashes.stderr);
    assert.deepEqual(readdirSync(temporaryRoot), []);
  } finally {
    rmSync(boundary, { recursive: true, force: true });
  }
});
