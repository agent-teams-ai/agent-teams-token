import * as proofSupport from "./proof-fixture.mjs";
const { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture } = proofSupport;
export { assert, spawnSync, createHash, appendFileSync, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, tmpdir, basename, dirname, join, resolve, test, applyManifest, applyExactSliceState, assertRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, createRollbackWorkspaceHandle, editPackage, expectedGateIds, finalizeRollbackTemporaryParent, gateCoverageSnapshot, parseCliArguments, parseStrictTap, preflightPinnedSlitherImage, removeOwnedEmptyDirectories, rollbackGateCoverage, validateManifestSet, verifyAppliedState, EvidenceRecorder, abandonCleanupHandle, assertExactDirectoryShape, assertExactCleanCandidate, assertGitStatusSnapshotEqual, assertInventoryEqual, assertPinnedNodeRuntime, assertPathsAbsent, basicRun, captureCleanupTreeSnapshot, captureGitStatusSnapshot, cleanupIdentityBoundDirectoryWithSnapshot, createCleanupHandle, gitExecutable, pnpmOfflineInstallArguments, strictToolPaths, trackedCandidateInventory, validatePnpmWorkspaceLinks, repositoryRoot, manifestDirectory, names, historicalLedgerLength, historicalLedgerSha256, proofRuntimeModuleUrl, manifests, copyCurrentRollbackSharedState, temporaryDirectory, cleanupIdentityBoundDirectory, writeExecutable, digestFile, pinnedRuntimeFixture, invokePinnedRuntime, git, gitFixture };

test("isolated pnpm links are required at every importing workspace package", () => {
  const root = temporaryDirectory("agtmai-rollback-links-");
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({
      devDependencies: { typescript: "1.0.0" },
    }));
    const supply = join(root, "packages/contexts/supply");
    const domain = join(root, "packages/domain");
    mkdirSync(supply, { recursive: true });
    mkdirSync(domain, { recursive: true });
    writeFileSync(join(domain, "package.json"), JSON.stringify({ name: "@fixture/domain" }));
    writeFileSync(join(supply, "package.json"), JSON.stringify({
      dependencies: {
        "@fixture/domain": "workspace:*",
        "@noble/hashes": "1.0.0",
        yaml: "1.0.0",
      },
    }));

    const targets = {
      typescript: join(root, "node_modules/.pnpm/typescript@1/node_modules/typescript"),
      noble: join(root, "node_modules/.pnpm/@noble+hashes@1/node_modules/@noble/hashes"),
      yaml: join(root, "node_modules/.pnpm/yaml@1/node_modules/yaml"),
    };
    for (const [name, target] of [
      ["typescript", targets.typescript],
      ["@noble/hashes", targets.noble],
      ["yaml", targets.yaml],
    ]) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "package.json"), JSON.stringify({ name }));
    }
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(".pnpm/typescript@1/node_modules/typescript", join(root, "node_modules/typescript"));
    mkdirSync(join(supply, "node_modules/@noble"), { recursive: true });
    mkdirSync(join(supply, "node_modules/@fixture"), { recursive: true });
    symlinkSync(domain, join(supply, "node_modules/@fixture/domain"));
    symlinkSync(targets.noble, join(supply, "node_modules/@noble/hashes"));
    symlinkSync(targets.yaml, join(supply, "node_modules/yaml"));

    const packagePaths = [
      "package.json",
      "packages/contexts/supply/package.json",
      "packages/domain/package.json",
    ];
    const links = validatePnpmWorkspaceLinks(root, packagePaths);
    assert.equal(links.length, 4);
    const wrongWorkspace = join(root, "wrong-workspace");
    mkdirSync(wrongWorkspace);
    writeFileSync(join(wrongWorkspace, "package.json"), JSON.stringify({ name: "@fixture/domain" }));
    unlinkSync(join(supply, "node_modules/@fixture/domain"));
    symlinkSync(wrongWorkspace, join(supply, "node_modules/@fixture/domain"));
    assert.throws(
      () => validatePnpmWorkspaceLinks(root, packagePaths),
      /ROLLBACK_PNPM_WORKSPACE_LINK_TARGET/u,
    );
    unlinkSync(join(supply, "node_modules/@fixture/domain"));
    symlinkSync(domain, join(supply, "node_modules/@fixture/domain"));
    const unrelated = join(root, "tracked-but-not-a-package-link");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "package.json"), JSON.stringify({ name: "yaml" }));
    unlinkSync(join(supply, "node_modules/yaml"));
    symlinkSync(unrelated, join(supply, "node_modules/yaml"));
    assert.throws(
      () => validatePnpmWorkspaceLinks(root, packagePaths),
      /ROLLBACK_PNPM_EXTERNAL_LINK_TARGET.*yaml/u,
    );
    unlinkSync(join(supply, "node_modules/yaml"));
    mkdirSync(join(supply, "node_modules/yaml"));
    assert.throws(
      () => validatePnpmWorkspaceLinks(root, packagePaths),
      /ROLLBACK_PNPM_LINK_NOT_ISOLATED.*yaml/u,
    );
    rmSync(join(supply, "node_modules/yaml"), { recursive: true });
    assert.throws(
      () => validatePnpmWorkspaceLinks(root, packagePaths),
      /ROLLBACK_PNPM_LINK_MISSING.*yaml/u,
    );
    assert.deepEqual(pnpmOfflineInstallArguments("/cache/pnpm-store"), [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--package-import-method=copy",
      "--store-dir=/cache/pnpm-store",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed Linux Node runtime has an immutable inner-binary pin and Darwin fails closed", () => {
  const lock = JSON.parse(readFileSync(join(repositoryRoot, "tooling/toolchain.lock.json"), "utf8"));
  assert.equal(
    lock.tools.node.platforms["linux-x64"].expectedFileSha256["bin/node"],
    "89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7",
  );
  assert.equal(typeof assertPinnedNodeRuntime, "function");
  const source = readFileSync(
    join(repositoryRoot, "scripts/rollback/runtime/node-runtime.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /ROLLBACK_RUNTIME_LOADED_IMAGE_BINDING_UNAVAILABLE platform=darwin-arm64/u,
  );
});

test("production runtime proof binds process.execPath, procfs image, archive and provenance", (context) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    context.skip("Linux x64 provides the required /proc/self/exe binding");
    return;
  }
  const fixture = pinnedRuntimeFixture();
  try {
    const result = invokePinnedRuntime(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      platform: "linux-x64",
      version: process.version,
      executable: fixture.executable,
      artifactSha256: fixture.artifactSha256,
      executableSha256: fixture.executableSha256,
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runtime proof rejects a coherent binary and provenance forgery", (context) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    context.skip("Linux x64 provides the required /proc/self/exe binding");
    return;
  }
  const fixture = pinnedRuntimeFixture();
  try {
    appendFileSync(fixture.executable, Buffer.from([0]));
    fixture.writeProvenance(digestFile(fixture.executable));
    const result = invokePinnedRuntime(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_RUNTIME_BINARY_HASH_MISMATCH/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runtime proof rejects a missing or tampered pinned archive", (context) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    context.skip("Linux x64 provides the required /proc/self/exe binding");
    return;
  }
  const fixture = pinnedRuntimeFixture();
  try {
    unlinkSync(fixture.archive);
    let result = invokePinnedRuntime(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_RUNTIME_ARCHIVE_MISSING/u);
    writeFileSync(fixture.archive, "tampered archive\n");
    result = invokePinnedRuntime(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_RUNTIME_ARCHIVE_HASH_MISMATCH/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runtime proof rejects process path and loaded-image identity mismatches", (context) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    context.skip("Linux x64 provides the required /proc/self/exe binding");
    return;
  }
  const fixture = pinnedRuntimeFixture();
  try {
    let result = invokePinnedRuntime(fixture, { executable: process.execPath });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_RUNTIME_EXEC_PATH_MISMATCH/u);

    const displaced = fixture.executable + ".loaded";
    const setup = `
      const fs = await import("node:fs");
      fs.renameSync(${JSON.stringify(fixture.executable)}, ${JSON.stringify(displaced)});
      fs.copyFileSync(${JSON.stringify(displaced)}, ${JSON.stringify(fixture.executable)});
      fs.chmodSync(${JSON.stringify(fixture.executable)}, 0o755);
    `;
    result = invokePinnedRuntime(fixture, { setup });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_RUNTIME_IMAGE_IDENTITY_MISMATCH/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("every strict native survivor prerequisite fails when its binary is missing", () => {
  const root = temporaryDirectory("agtmai-rollback-tools-");
  const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const docker = join(root, "usr/bin/docker");
  const paths = [
    join(root, ".tools/node-v24.20.0-" + platform + "/bin/node"),
    join(root, ".tools/bin/pnpm"),
    join(root, ".tools/foundry-v1.8.0-" + platform + "/forge"),
    join(root, ".tools/foundry-v1.8.0-" + platform + "/cast"),
    join(root, ".tools/foundry-v1.8.0-" + platform + "/anvil"),
    join(root, ".tools/solc-v0.8.36-" + platform + "/solc"),
    ...["solana", "solana-keygen", "solana-test-validator", "spl-token"].map((name) =>
      join(root, ".tools/agave-v4.2.1-" + platform + "/bin/" + name)),
    docker,
  ];
  try {
    for (const path of paths) {
      writeExecutable(path);
    }
    assert.ok(strictToolPaths(root, {
      platform,
      requireSolana: true,
      requireDocker: true,
      dockerPath: docker,
    }).docker);
    for (const path of paths) {
      unlinkSync(path);
      assert.throws(
        () => strictToolPaths(root, {
          platform,
          requireSolana: true,
          requireDocker: true,
          dockerPath: docker,
        }),
        /ROLLBACK_STRICT_BINARY_MISSING/u,
        path,
      );
      writeExecutable(path);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
