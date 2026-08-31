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
  const archive = join(root, ".tools", "downloads", archiveName);
  const provenance = join(
    root,
    ".tools",
    installDirectory,
    ".agtmai-toolchain-install.json",
  );
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(dirname(archive), { recursive: true });
  mkdirSync(join(root, "tooling"));
  copyFileSync(process.execPath, executable);
  chmodSync(executable, 0o755);
  writeFileSync(archive, "pinned runtime archive fixture\n");
  const executableSha256 = digestFile(executable);
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
    versionChecks: [{
      name: "node",
      path: "bin/node",
      args: ["--version"],
      pattern: "^v" + version.replaceAll(".", "\\.") + "$",
    }],
  };
  writeFileSync(join(root, "tooling/toolchain.lock.json"), `${JSON.stringify({
    schemaVersion: 2,
    tools: {
      node: {
        scope: "genesis-core",
        version,
        platforms: { "linux-x64": artifact },
      },
    },
  }, null, 2)}\n`);
  const writeProvenance = (binarySha256 = executableSha256) => {
    writeFileSync(provenance, `${JSON.stringify({
      schemaVersion: 1,
      tool: "node",
      version,
      platform: "linux-x64",
      artifactSha256,
      files: { "bin/node": binarySha256 },
    }, null, 2)}\n`);
  };
  writeProvenance();
  return {
    root,
    version,
    executable,
    archive,
    provenance,
    executableSha256,
    artifactSha256,
    writeProvenance,
  };
}

function invokePinnedRuntime(fixture, { executable = fixture.executable, setup = "" } = {}) {
  const source = `
    import { assertPinnedNodeRuntime } from ${JSON.stringify(proofRuntimeModuleUrl)};
    ${setup}
    process.stdout.write(JSON.stringify(assertPinnedNodeRuntime(${JSON.stringify(fixture.root)})));
  `;
  return spawnSync(executable, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
}

function git(root, arguments_) {
  return basicRun(gitExecutable(), arguments_, { cwd: root });
}

function gitFixture() {
  const boundary = temporaryDirectory("agtmai-rollback-git-");
  const root = join(boundary, "source");
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
};
