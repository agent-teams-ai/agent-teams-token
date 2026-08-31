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

test("actual installPreparedArtifact output crosses assertPinnedNodeRuntime and preflight", (context) => {
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

test("trusted pinned Node wrapper rejects hostile preload, proxy and npm authority", (context) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    context.skip("Linux x64 provides the required /proc/self/exe binding");
    return;
  }
  const fixture = pinnedRuntimeFixture();
  try {
    const marker = join(fixture.root, "hostile-node-options-executed");
    const preload = join(fixture.root, "hostile-preload.cjs");
    writeFileSync(
      preload,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed\\n");\n`,
    );
    const result = invokePinnedRuntime(fixture, {
      environment: {
        ...process.env,
        ALL_PROXY: "sentinel-all-proxy",
        HTTPS_PROXY: "sentinel-https-proxy",
        HTTP_PROXY: "sentinel-http-proxy",
        NODE_OPTIONS: `--require=${preload}`,
        NODE_PATH: join(fixture.root, "hostile-node-path"),
        npm_config_registry: "https://sentinel.invalid/",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runtime proof rejects inventory injected after canonical installation", (context) => {
  if (process.platform !== "linux" || process.arch !== "x64") {
    context.skip("Linux x64 provides the required /proc/self/exe binding");
    return;
  }
  const fixture = pinnedRuntimeFixture();
  try {
    writeFileSync(join(dirname(fixture.executable), "foreign-sentinel"), "foreign\n");
    const result = invokePinnedRuntime(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK_RUNTIME_PROVENANCE_INVENTORY_MISMATCH/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("actual Git commands disable hostile system, global, local and command config", () => {
  const fixture = gitFixture();
  const saved = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith("GIT_CONFIG_"))
      .map((key) => [key, process.env[key]]),
  );
  const hostileKeys = [
    "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_1",
    "GIT_CONFIG_VALUE_0", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM",
  ];
  try {
    const marker = join(fixture.boundary, "hostile-git-authority-executed");
    const helper = join(fixture.boundary, "hostile-git-helper");
    const globalConfig = join(fixture.boundary, "global.gitconfig");
    const systemConfig = join(fixture.boundary, "system.gitconfig");
    writeExecutable(helper, `#!/bin/sh\n/bin/echo executed >>${JSON.stringify(marker)}\nexit 0\n`);
    const hostileConfig = `[core]\n\tfsmonitor = ${helper}\n[credential]\n\thelper = ${helper}\n`;
    writeFileSync(globalConfig, hostileConfig);
    writeFileSync(systemConfig, hostileConfig);
    git(fixture.root, ["config", "core.fsmonitor", helper]);
    git(fixture.root, ["config", "credential.helper", helper]);

    Object.assign(process.env, {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_0: helper,
      GIT_CONFIG_VALUE_1: helper,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_SYSTEM: systemConfig,
    });
    assert.equal(assertExactCleanCandidate(fixture.root, fixture.sha), fixture.sha);
    assert.equal(existsSync(marker), false);
  } finally {
    for (const key of hostileKeys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    rmSync(fixture.boundary, { recursive: true, force: true });
  }
});

test("recorded offline children exclude proxy, npm, Node and Git authority", () => {
  const root = temporaryDirectory("agtmai-rollback-evidence-environment-");
  const gitCandidate = gitFixture();
  try {
    const evidence = join(root, "evidence");
    mkdirSync(evidence);
    const recorder = new EvidenceRecorder(evidence, { test: "hostile-environment" });
    const sentinel = "agtmai-hostile-environment-sentinel";
    const result = recorder.run("test", "environment", "/usr/bin/env", [], {
      cwd: root,
      env: {
        ...process.env,
        ALL_PROXY: sentinel,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: sentinel,
        HTTPS_PROXY: sentinel,
        HTTP_PROXY: sentinel,
        NODE_OPTIONS: `--require=${sentinel}`,
        NODE_PATH: sentinel,
        npm_config_registry: `https://${sentinel}.invalid/`,
      },
    });
    assert.doesNotMatch(result.stdout, new RegExp(sentinel, "u"));
    assert.equal(Object.values(result.entry.environment).includes(sentinel), false);
    assert.deepEqual(result.entry.arguments, []);

    const gitResult = recorder.run("test", "git-command-contract", gitExecutable(), [
      "rev-parse", "--verify", "HEAD^{commit}",
    ], { cwd: gitCandidate.root, env: process.env });
    assert.deepEqual(gitResult.entry.arguments.slice(0, 11), [
      "-c", "core.fsmonitor=false",
      "-c", "credential.helper=",
      "-c", "credential.interactive=never",
      "-c", `safe.directory=${gitCandidate.root}`,
      "rev-parse", "--verify", "HEAD^{commit}",
    ]);
  } finally {
    rmSync(gitCandidate.boundary, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
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
      const archive = await import(${JSON.stringify(
        new URL("../../toolchain-archive.mjs", import.meta.url).href,
      )});
      const provenance = await import(${JSON.stringify(
        new URL("../../toolchain-provenance.mjs", import.meta.url).href,
      )});
      fs.renameSync(${JSON.stringify(fixture.executable)}, ${JSON.stringify(displaced)});
      fs.copyFileSync(${JSON.stringify(displaced)}, ${JSON.stringify(fixture.executable)});
      fs.chmodSync(${JSON.stringify(fixture.executable)}, 0o755);
      const document = provenance.parseToolchainProvenance(
        fs.readFileSync(${JSON.stringify(fixture.provenance)}),
      );
      document.inventorySha256 = archive.inventorySha256(archive.inventoryInstallation(
        ${JSON.stringify(dirname(fixture.provenance))},
        { exclude: [archive.provenanceFile] },
      ));
      fs.writeFileSync(
        ${JSON.stringify(fixture.provenance)},
        provenance.serializeToolchainProvenance(document),
      );
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
