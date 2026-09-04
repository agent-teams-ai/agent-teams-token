import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  cleanupPreparedPayload,
  fetchArtifacts,
  installArtifacts,
  installPreparedArtifact,
  prepareVerifiedPayload,
} from "../toolchain.mjs";
import {
  captureBootstrapNodeStageCustody,
  cleanupBootstrapNodeStage,
} from "../toolchain-cleanup.mjs";
import {
  allowlistedChildEnvironment,
  canonicalGitArguments,
  canonicalGitEnvironment,
} from "../toolchain-environment.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");

test("canonical child and Git environments reject preload, config, proxy and npm authority", () => {
  const hostile = {
    ...process.env,
    ALL_PROXY: "sentinel-all-proxy",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "/tmp/hostile-fsmonitor",
    HTTPS_PROXY: "sentinel-https-proxy",
    HTTP_PROXY: "sentinel-http-proxy",
    NODE_OPTIONS: "--require=/tmp/hostile-preload.cjs",
    NODE_PATH: "/tmp/hostile-node-path",
    npm_config_registry: "https://sentinel.invalid/",
  };
  const child = allowlistedChildEnvironment(hostile);
  for (const key of [
    "ALL_PROXY", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    "HTTPS_PROXY", "HTTP_PROXY", "NODE_OPTIONS", "NODE_PATH", "npm_config_registry",
  ]) {
    assert.equal(child[key], undefined, key);
  }
  const gitEnvironment = canonicalGitEnvironment(hostile);
  assert.equal(gitEnvironment.GIT_CONFIG_COUNT, "0");
  assert.equal(gitEnvironment.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(gitEnvironment.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(gitEnvironment.GIT_CONFIG_NOSYSTEM, "1");
  assert.deepEqual(canonicalGitArguments, [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.attributesFile=/dev/null",
    "-c", "credential.helper=",
    "-c", "credential.interactive=never",
  ]);
  assert.equal(child.HOME, "/nonexistent");
  assert.equal(child.XDG_CONFIG_HOME, "/nonexistent");
  assert.equal(child.NPM_CONFIG_USERCONFIG, "/dev/null");
  assert.equal(child.npm_config_globalconfig, "/dev/null");
});

test("actual pnpm commands ignore inherited pnpmfile, proxy and Node preload authority", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-pnpm-authority-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const lock = JSON.parse(readFileSync(join(repositoryRoot, "tooling", "toolchain.lock.json"), "utf8"));
  const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const toolsRoot = join(root, "tools");
  const downloads = join(toolsRoot, "downloads");
  mkdirSync(downloads, { recursive: true });
  for (const name of [...lock.coreTools, "pnpm"]) {
    const artifact = name === "pnpm" ? lock.tools.pnpm : lock.tools[name].platforms[platform];
    copyFileSync(
      join(repositoryRoot, ".tools", "downloads", artifact.archiveName),
      join(downloads, artifact.archiveName),
    );
  }
  installArtifacts({ lock, platform, toolsRoot, offline: true });
  const hostileHome = join(root, "hostile-home");
  mkdirSync(hostileHome);
  const preloadMarker = join(root, "preload-attacker-marker");
  const pnpmfileMarker = join(root, "pnpmfile-attacker-marker");
  const preload = join(root, "preload.cjs");
  const pnpmfile = join(root, "pnpmfile.cjs");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "executed\\n");\n`);
  writeFileSync(pnpmfile, `require("node:fs").writeFileSync(${JSON.stringify(pnpmfileMarker)}, "executed\\n");\nmodule.exports = {};\n`);
  writeFileSync(join(hostileHome, ".npmrc"), `global-pnpmfile=${pnpmfile}\nproxy=http://sentinel.invalid/\n`);
  writeFileSync(join(root, ".npmrc"), `pnpmfile=${pnpmfile}\n`);
  writeFileSync(join(root, ".pnpmfile.cjs"), readFileSync(pnpmfile));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "agtmai-pnpm-authority-probe",
    packageManager: "pnpm@11.24.0",
    private: true,
    version: "1.0.0",
  }) + "\n");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
  const hostileEnvironment = {
    ...process.env,
    ALL_PROXY: "http://sentinel.invalid/",
    HOME: hostileHome,
    HTTPS_PROXY: "http://sentinel.invalid/",
    HTTP_PROXY: "http://sentinel.invalid/",
    NODE_OPTIONS: `--require=${preload}`,
    NPM_CONFIG_USERCONFIG: join(hostileHome, ".npmrc"),
    npm_config_global_pnpmfile: pnpmfile,
  };
  const install = spawnSync(join(toolsRoot, "bin", "pnpm"), [
    "install", "--offline", "--frozen-lockfile", "--ignore-scripts",
  ], { cwd: root, encoding: "utf8", env: hostileEnvironment, timeout: 60_000 });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(existsSync(preloadMarker), false);
  assert.equal(existsSync(pnpmfileMarker), false);
  const inspect = spawnSync(join(toolsRoot, "bin", "pnpm"), [
    "exec",
    "node",
    "--eval",
    "process.stdout.write([process.env.ALL_PROXY,process.env.HTTP_PROXY,process.env.NODE_OPTIONS,process.env.npm_config_global_pnpmfile].every((value)=>value===undefined)?'clean':'tainted')",
  ], { cwd: root, encoding: "utf8", env: hostileEnvironment, timeout: 60_000 });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(inspect.stdout, "clean");
  assert.equal(existsSync(preloadMarker), false);
  assert.equal(existsSync(pnpmfileMarker), false);
});

test("bootstrap cleanup preserves a foreign successor at its remembered stage pathname", (context) => {
  const toolsRoot = mkdtempSync(join(tmpdir(), "agtmai-bootstrap-cleanup-test-"));
  context.after(() => rmSync(toolsRoot, { recursive: true, force: true }));
  const stage = mkdtempSync(join(toolsRoot, ".bootstrap-node-part."));
  const payload = join(stage, "payload");
  mkdirSync(payload);
  writeFileSync(join(payload, "owned"), "owned\n");
  const identity = lstatSync(stage, { bigint: true });
  const custodySha256 = captureBootstrapNodeStageCustody({
    path: stage,
    toolsRoot,
    device: identity.dev,
    inode: identity.ino,
  });
  const successor = join(stage, "foreign-sentinel");
  assert.throws(
    () => cleanupBootstrapNodeStage({
      path: stage,
      toolsRoot,
      device: identity.dev,
      inode: identity.ino,
      custodySha256,
      onBoundary({ stage: boundary }) {
        if (boundary === "before-target-quarantine") {
          renameSync(stage, `${stage}.held`);
          mkdirSync(stage);
          writeFileSync(successor, "foreign\n");
        }
      },
    }),
    /ROLLBACK_CLEANUP_TARGET_SUBSTITUTED_AT_QUARANTINE/u,
  );
  assert.equal(readFileSync(successor, "utf8"), "foreign\n");
  assert.equal(readFileSync(join(`${stage}.held`, "payload", "owned"), "utf8"), "owned\n");
});

test("bootstrap cleanup rejects a replaced payload before cleanup adoption", (context) => {
  const toolsRoot = mkdtempSync(join(tmpdir(), "agtmai-bootstrap-payload-custody-test-"));
  context.after(() => rmSync(toolsRoot, { recursive: true, force: true }));
  const stage = mkdtempSync(join(toolsRoot, ".bootstrap-node-part."));
  const payload = join(stage, "payload");
  mkdirSync(payload);
  writeFileSync(join(payload, "owned"), "owned\n");
  const identity = lstatSync(stage, { bigint: true });
  const custodySha256 = captureBootstrapNodeStageCustody({
    path: stage,
    toolsRoot,
    device: identity.dev,
    inode: identity.ino,
  });
  const held = join(toolsRoot, "held-bootstrap-payload");
  renameSync(payload, held);
  mkdirSync(payload);
  const successor = join(payload, "foreign-sentinel");
  writeFileSync(successor, "foreign\n");
  assert.throws(
    () => cleanupBootstrapNodeStage({
      path: stage,
      toolsRoot,
      device: identity.dev,
      inode: identity.ino,
      custodySha256,
    }),
    /TOOLCHAIN_BOOTSTRAP_STAGE_CUSTODY_MISMATCH/u,
  );
  assert.equal(readFileSync(successor, "utf8"), "foreign\n");
  assert.equal(readFileSync(join(held, "owned"), "utf8"), "owned\n");
});

test("archive preparation cleanup preserves a foreign successor stage", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    downloader: fixture.downloader,
  });
  const artifact = fixture.lock.tools.foundry.platforms["linux-x64"];
  const prepared = prepareVerifiedPayload({
    name: "foundry",
    platform: "linux-x64",
    artifact,
    archive: join(fixture.toolsRoot, "downloads", artifact.archiveName),
    toolsRoot: fixture.toolsRoot,
    missingCode: "TEST_ARCHIVE_MISSING",
  });
  const successor = join(prepared.stageRoot, "foreign-sentinel");
  assert.throws(
    () => cleanupPreparedPayload(prepared, {
      onBoundary({ stage: boundary }) {
        if (boundary === "before-target-quarantine") {
          renameSync(prepared.stageRoot, `${prepared.stageRoot}.held`);
          mkdirSync(prepared.stageRoot);
          writeFileSync(successor, "foreign\n");
        }
      },
    }),
    /ROLLBACK_CLEANUP_TARGET_SUBSTITUTED_AT_QUARANTINE/u,
  );
  assert.equal(readFileSync(successor, "utf8"), "foreign\n");
  assert.equal(existsSync(join(`${prepared.stageRoot}.held`, "payload")), true);
});

test("archive cleanup rejects a replaced payload before cleanup", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    downloader: fixture.downloader,
  });
  const artifact = fixture.lock.tools.foundry.platforms["linux-x64"];
  const prepared = prepareVerifiedPayload({
    name: "foundry",
    platform: "linux-x64",
    artifact,
    archive: join(fixture.toolsRoot, "downloads", artifact.archiveName),
    toolsRoot: fixture.toolsRoot,
    missingCode: "TEST_ARCHIVE_MISSING",
  });
  const payload = join(prepared.stageRoot, "payload");
  const held = join(fixture.root, "held-archive-payload");
  renameSync(payload, held);
  mkdirSync(payload);
  const successor = join(payload, "foreign-sentinel");
  writeFileSync(successor, "foreign\n");
  assert.throws(
    () => cleanupPreparedPayload(prepared),
    /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH/u,
  );
  assert.equal(readFileSync(successor, "utf8"), "foreign\n");
  assert.equal(existsSync(held), true);
});

test("atomic installation backup cleanup preserves a foreign successor", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    downloader: fixture.downloader,
  });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  const tool = fixture.lock.tools.foundry;
  const artifact = tool.platforms["linux-x64"];
  const destination = join(fixture.toolsRoot, artifact.installDirectory);
  writeFileSync(join(destination, "forge"), "tampered\n");
  const prepared = prepareVerifiedPayload({
    name: "foundry",
    platform: "linux-x64",
    artifact,
    archive: join(fixture.toolsRoot, "downloads", artifact.archiveName),
    toolsRoot: fixture.toolsRoot,
    missingCode: "TEST_ARCHIVE_MISSING",
  });
  let successor;
  try {
    assert.throws(
      () => installPreparedArtifact({
        name: "foundry",
        tool,
        artifact,
        prepared,
        destination,
        platform: "linux-x64",
        toolsRoot: fixture.toolsRoot,
        lock: fixture.lock,
        onPublishBoundary(boundary, { backup }) {
          if (boundary === "before-backup-cleanup") {
            renameSync(backup, `${backup}.held`);
            mkdirSync(backup);
            successor = join(backup, "foreign-sentinel");
            writeFileSync(successor, "foreign\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_IDENTITY_MISMATCH/u,
    );
  } finally {
    cleanupPreparedPayload(prepared);
  }
  assert.equal(readFileSync(successor, "utf8"), "foreign\n");
});

test("atomic installation rejects a replaced backup payload before cleanup", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    downloader: fixture.downloader,
  });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  const tool = fixture.lock.tools.foundry;
  const artifact = tool.platforms["linux-x64"];
  const destination = join(fixture.toolsRoot, artifact.installDirectory);
  writeFileSync(join(destination, "forge"), "tampered\n");
  const prepared = prepareVerifiedPayload({
    name: "foundry",
    platform: "linux-x64",
    artifact,
    archive: join(fixture.toolsRoot, "downloads", artifact.archiveName),
    toolsRoot: fixture.toolsRoot,
    missingCode: "TEST_ARCHIVE_MISSING",
  });
  let successor;
  const held = join(fixture.root, "held-backup-payload");
  try {
    assert.throws(
      () => installPreparedArtifact({
        name: "foundry",
        tool,
        artifact,
        prepared,
        destination,
        platform: "linux-x64",
        toolsRoot: fixture.toolsRoot,
        lock: fixture.lock,
        onPublishBoundary(boundary, { backup }) {
          if (boundary === "before-backup-cleanup") {
            renameSync(join(backup, "payload"), held);
            mkdirSync(join(backup, "payload"));
            successor = join(backup, "payload", "foreign-sentinel");
            writeFileSync(successor, "foreign\n");
          }
        },
      }),
      /ROLLBACK_CLEANUP_ENTRY_IDENTITY_MISMATCH/u,
    );
  } finally {
    cleanupPreparedPayload(prepared);
  }
  assert.equal(readFileSync(successor, "utf8"), "foreign\n");
  assert.equal(existsSync(held), true);
});

test("prepared and installed artifact authority must be the same object", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    downloader: fixture.downloader,
  });
  const tool = fixture.lock.tools.foundry;
  const artifact = tool.platforms["linux-x64"];
  const prepared = prepareVerifiedPayload({
    name: "foundry",
    platform: "linux-x64",
    artifact,
    archive: join(fixture.toolsRoot, "downloads", artifact.archiveName),
    toolsRoot: fixture.toolsRoot,
    missingCode: "TEST_ARCHIVE_MISSING",
  });
  try {
    assert.throws(
      () => installPreparedArtifact({
        name: "foundry",
        tool,
        artifact: { ...artifact },
        prepared,
        destination: join(fixture.toolsRoot, artifact.installDirectory),
        platform: "linux-x64",
        toolsRoot: fixture.toolsRoot,
        lock: fixture.lock,
      }),
      /TOOLCHAIN_PREPARED_ARTIFACT_AUTHORITY_MISMATCH/u,
    );
  } finally {
    cleanupPreparedPayload(prepared);
  }
});
