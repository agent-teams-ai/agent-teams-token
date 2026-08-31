import assert from "node:assert/strict";
import {
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
import { join } from "node:path";
import test from "node:test";

import {
  cleanupPreparedPayload,
  fetchArtifacts,
  installArtifacts,
  installPreparedArtifact,
  prepareVerifiedPayload,
} from "../toolchain.mjs";
import { cleanupBootstrapNodeStage } from "../toolchain-cleanup.mjs";
import {
  allowlistedChildEnvironment,
  canonicalGitArguments,
  canonicalGitEnvironment,
} from "../toolchain-environment.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";

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
    "-c", "credential.helper=",
    "-c", "credential.interactive=never",
  ]);
});

test("bootstrap cleanup preserves a foreign successor at its remembered stage pathname", (context) => {
  const toolsRoot = mkdtempSync(join(tmpdir(), "agtmai-bootstrap-cleanup-test-"));
  context.after(() => rmSync(toolsRoot, { recursive: true, force: true }));
  const stage = mkdtempSync(join(toolsRoot, ".bootstrap-node-part."));
  const payload = join(stage, "payload");
  mkdirSync(payload);
  writeFileSync(join(payload, "owned"), "owned\n");
  const identity = lstatSync(stage, { bigint: true });
  const successor = join(stage, "foreign-sentinel");
  assert.throws(
    () => cleanupBootstrapNodeStage({
      path: stage,
      toolsRoot,
      device: identity.dev,
      inode: identity.ino,
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
