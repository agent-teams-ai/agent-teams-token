import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  cleanupPreparedPayload,
  installPreparedArtifact,
  prepareVerifiedPayload,
} from "../../toolchain.mjs";
import {
  parseToolchainProvenance,
  serializeToolchainProvenance,
} from "../../toolchain-provenance.mjs";

import {
  applyManifest,
  applyExactSliceState,
  assertRollbackWorkspaceHandle,
  closeRollbackWorkspaceHandle,
  createRollbackWorkspaceHandle,
  editPackage,
  expectedGateIds,
  finalizeRollbackTemporaryParent,
  gateCoverageSnapshot,
  parseCliArguments,
  parseStrictTap,
  preflightPinnedSlitherImage,
  removeOwnedEmptyDirectories,
  rollbackGateCoverage,
  stageExactWorktreePaths,
  syntheticRollbackCommit,
  validateManifestSet,
  verifyAppliedState,
} from "../prove-slices.mjs";
import {
  EvidenceRecorder,
  abandonCleanupHandle,
  assertExactDirectoryShape,
  assertExactCleanCandidate,
  assertGitStatusSnapshotEqual,
  assertInventoryEqual,
  assertPinnedNodeRuntime,
  assertPathsAbsent,
  basicRun,
  captureCleanupTreeSnapshot,
  captureGitStatusSnapshot,
  cleanupIdentityBoundDirectory as cleanupIdentityBoundDirectoryWithSnapshot,
  createCleanupHandle,
  gitExecutable,
  pnpmOfflineInstallArguments,
  strictToolPaths,
  trackedCandidateInventory,
  validatePnpmWorkspaceLinks,
} from "../proof-runtime.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const manifestDirectory = join(repositoryRoot, "architecture/rollback");
const names = ["local-solana.json", "deployment-plan.json", "slither.json"];
const historicalLedgerLength = 19_751;
const historicalLedgerSha256 = "7256836c5c16ecbdea0d2a273606cec4501e719971a783f69c9dcf75f4ed2e33";
const proofRuntimeModuleUrl = new URL("../proof-runtime.mjs", import.meta.url).href;

function manifests() {
  return names.map((name) => JSON.parse(readFileSync(join(manifestDirectory, name), "utf8")));
}

function copyCurrentRollbackSharedState(checkout, manifest) {
  for (const path of manifest.sharedPaths) {
    const source = join(repositoryRoot, path);
    const destination = join(checkout, path);
    if (!existsSync(source)) {
      rmSync(destination, { force: true });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupIdentityBoundDirectory(handle, options) {
  captureCleanupTreeSnapshot(handle);
  return cleanupIdentityBoundDirectoryWithSnapshot(handle, options);
}

function writeExecutable(path, contents = "#!/bin/sh\nexit 0\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function digestFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pinnedRuntimeFixture() {
  const root = temporaryDirectory("agtmai-rollback-runtime-");
  const version = process.version.slice(1);
  const installDirectory = "node-v" + version + "-linux-x64";
  const archiveName = installDirectory + ".tar.xz";
  const executable = join(root, ".tools", installDirectory, "bin", "node");
  const trustedNode = join(root, ".tools", "bin", "node");
  const archive = join(root, ".tools", "downloads", archiveName);
  const provenance = join(
    root,
    ".tools",
    installDirectory,
    ".agtmai-toolchain-install.json",
  );
  mkdirSync(dirname(archive), { recursive: true });
  mkdirSync(join(root, "tooling"));
  const archiveSource = join(root, "runtime-archive-source");
  const archiveExecutable = join(archiveSource, installDirectory, "bin", "node");
  mkdirSync(dirname(archiveExecutable), { recursive: true });
  copyFileSync(process.execPath, archiveExecutable);
  chmodSync(archiveExecutable, 0o755);
  mkdirSync(join(archiveSource, installDirectory, "lib"));
  writeFileSync(
    join(archiveSource, installDirectory, "lib", "runtime-metadata.json"),
    '{"runtime":"pinned-fixture"}\n',
  );
  const executableSha256 = digestFile(archiveExecutable);
  const archiveResult = spawnSync("/usr/bin/tar", [
    "-cJf", archive, "-C", archiveSource, installDirectory,
  ], {
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", XZ_OPT: "-0" },
  });
  assert.equal(archiveResult.status, 0, archiveResult.stderr);
  rmSync(archiveSource, { recursive: true, force: true });
  const artifactSha256 = digestFile(archive);
  const artifact = {
    url: "https://nodejs.org/dist/v" + version + "/" + archiveName,
    checksumSource: "https://nodejs.org/dist/v" + version + "/SHASUMS256.txt",
    sha256: artifactSha256,
    archive: "tar.xz",
    archiveName,
    installDirectory,
    expectedFiles: ["bin/node"],
    expectedFileSha256: { "bin/node": executableSha256 },
    installationAuthority: "pinned-archive-complete-tree-v1",
    versionChecks: [{
      name: "node",
      path: "bin/node",
      args: ["--version"],
      pattern: "^v" + version.replaceAll(".", "\\.") + "$",
    }],
  };
  const lock = {
    schemaVersion: 2,
    tools: {
      node: {
        scope: "genesis-core",
        version,
        platforms: { "linux-x64": artifact },
      },
    },
  };
  writeFileSync(join(root, "tooling/toolchain.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const prepared = prepareVerifiedPayload({
    name: "node",
    platform: "linux-x64",
    artifact,
    archive,
    toolsRoot: join(root, ".tools"),
    missingCode: "TEST_RUNTIME_ARCHIVE_MISSING",
  });
  try {
    installPreparedArtifact({
      name: "node",
      tool: lock.tools.node,
      artifact,
      prepared,
      destination: join(root, ".tools", installDirectory),
      platform: "linux-x64",
      toolsRoot: join(root, ".tools"),
      lock,
    });
  } finally {
    cleanupPreparedPayload(prepared);
  }
  const writeProvenance = (binarySha256 = executableSha256) => {
    const current = parseToolchainProvenance(readFileSync(provenance));
    writeFileSync(provenance, serializeToolchainProvenance({
      ...current,
      files: { "bin/node": binarySha256 },
    }));
  };
  return {
    root,
    version,
    executable,
    trustedNode,
    archive,
    provenance,
    executableSha256,
    artifactSha256,
    writeProvenance,
  };
}

function invokePinnedRuntime(fixture, {
  executable = fixture.trustedNode,
  setup = "",
  environment = process.env,
} = {}) {
  const source = `
    import { assertPinnedNodeRuntime } from ${JSON.stringify(proofRuntimeModuleUrl)};
    ${setup}
    process.stdout.write(JSON.stringify(assertPinnedNodeRuntime(${JSON.stringify(fixture.root)})));
  `;
  return spawnSync(executable, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: environment,
    timeout: 60_000,
  });
}

function git(root, arguments_) {
  return basicRun(gitExecutable(), arguments_, { cwd: root });
}

function gitFixture() {
  const boundary = temporaryDirectory("agtmai-rollback-git-");
  const root = join(boundary, "checkout");
  mkdirSync(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Rollback Test"]);
  git(root, ["config", "user.email", "rollback-test@invalid.example"]);
  writeFileSync(join(root, "alpha.txt"), "alpha\n");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  writeExecutable(join(root, "executable.sh"));
  symlinkSync("alpha.txt", join(root, "alpha-link"));
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "test: inventory fixture"]);
  return { boundary, root, sha: git(root, ["rev-parse", "HEAD"]).trim() };
}

function cloneRepository(source, destination, cwd = dirname(destination)) {
  if (typeof process.getuid !== "function"
    || String(lstatSync(source, { bigint: true }).uid) === String(process.getuid())) {
    basicRun(gitExecutable(), [
      "clone", "--quiet", "--no-hardlinks", source, destination,
    ], { cwd });
    return;
  }

  const transport = temporaryDirectory("agtmai-rollback-clone-transport-");
  const bundle = join(transport, "source.bundle");
  const bare = join(transport, "source.git");
  try {
    basicRun(gitExecutable(), ["bundle", "create", bundle, "--all"], { cwd: source });
    basicRun(gitExecutable(), ["clone", "--quiet", "--bare", bundle, bare], {
      cwd: transport,
    });
    basicRun(gitExecutable(), [
      "clone", "--quiet", "--no-hardlinks", bare, destination,
    ], { cwd });
  } finally {
    rmSync(transport, { recursive: true, force: true });
  }
}


export {
  assert,
  spawnSync,
  createHash,
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  tmpdir,
  basename,
  dirname,
  join,
  resolve,
  test,
  applyManifest,
  applyExactSliceState,
  assertRollbackWorkspaceHandle,
  closeRollbackWorkspaceHandle,
  createRollbackWorkspaceHandle,
  editPackage,
  expectedGateIds,
  finalizeRollbackTemporaryParent,
  gateCoverageSnapshot,
  parseCliArguments,
  parseStrictTap,
  preflightPinnedSlitherImage,
  removeOwnedEmptyDirectories,
  rollbackGateCoverage,
  stageExactWorktreePaths,
  syntheticRollbackCommit,
  validateManifestSet,
  verifyAppliedState,
  EvidenceRecorder,
  abandonCleanupHandle,
  assertExactDirectoryShape,
  assertExactCleanCandidate,
  assertGitStatusSnapshotEqual,
  assertInventoryEqual,
  assertPinnedNodeRuntime,
  assertPathsAbsent,
  basicRun,
  captureCleanupTreeSnapshot,
  captureGitStatusSnapshot,
  cleanupIdentityBoundDirectoryWithSnapshot,
  createCleanupHandle,
  gitExecutable,
  pnpmOfflineInstallArguments,
  strictToolPaths,
  trackedCandidateInventory,
  validatePnpmWorkspaceLinks,
  repositoryRoot,
  manifestDirectory,
  names,
  historicalLedgerLength,
  historicalLedgerSha256,
  proofRuntimeModuleUrl,
  manifests,
  copyCurrentRollbackSharedState,
  temporaryDirectory,
  cleanupIdentityBoundDirectory,
  writeExecutable,
  digestFile,
  pinnedRuntimeFixture,
  invokePinnedRuntime,
  git,
  gitFixture,
  cloneRepository,
};
