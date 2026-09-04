import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";

import {
  cleanupPreparedPayload,
  fetchArtifacts,
  installPreparedArtifact,
  prepareVerifiedPayload,
} from "../toolchain.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";

function prepareNode(fixture) {
  const platform = "linux-x64";
  const tool = fixture.lock.tools.node;
  const artifact = tool.platforms[platform];
  return {
    artifact,
    destination: join(fixture.toolsRoot, artifact.installDirectory),
    platform,
    prepared: prepareVerifiedPayload({
      name: "node",
      platform,
      artifact,
      archive: join(fixture.toolsRoot, "downloads", artifact.archiveName),
      toolsRoot: fixture.toolsRoot,
      missingCode: "TEST_ARCHIVE_MISSING",
    }),
    tool,
    wrapper: join(fixture.toolsRoot, "bin", "node"),
  };
}

function installNode(fixture, value, options = {}) {
  installPreparedArtifact({
    name: "node",
    tool: value.tool,
    artifact: value.artifact,
    prepared: value.prepared,
    destination: value.destination,
    platform: value.platform,
    toolsRoot: fixture.toolsRoot,
    lock: fixture.lock,
    ...options,
  });
}

function replacementFixture(context) {
  const fixture = makeFixture();
  fetchArtifacts({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    downloader: fixture.downloader,
  });
  const initial = prepareNode(fixture);
  installNode(fixture, initial);
  cleanupPreparedPayload(initial.prepared);
  const binary = join(initial.destination, initial.artifact.versionChecks[0].path);
  fs.writeFileSync(binary, "tampered-old-payload\n");
  fs.writeFileSync(initial.wrapper, "tampered-old-wrapper\n");
  const replacement = prepareNode(fixture);
  context.after(() => {
    if (!replacement.prepared.cleanupHandle.closed) {
      cleanupPreparedPayload(replacement.prepared);
    }
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  return { binary, fixture, replacement };
}

function assertPreviousStateRestored(value) {
  assert.equal(fs.readFileSync(value.binary, "utf8"), "tampered-old-payload\n");
  assert.equal(fs.readFileSync(value.replacement.wrapper, "utf8"), "tampered-old-wrapper\n");
  assert.equal(fs.existsSync(value.replacement.prepared.source), true);
  assert.deepEqual(
    fs.readdirSync(value.fixture.toolsRoot).filter((name) => name.startsWith(".install-backup-")),
    [],
  );
}

test("wrapper write failure restores the previous payload and wrapper", (context) => {
  const value = replacementFixture(context);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (path, ...arguments_) => {
    if (path === value.replacement.wrapper + ".part") {
      throw new Error("TEST_WRAPPER_PUBLICATION_FAILED");
    }
    return originalWrite(path, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => installNode(value.fixture, value.replacement),
      /TEST_WRAPPER_PUBLICATION_FAILED/u,
    );
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
  }
  assertPreviousStateRestored(value);
  assert.equal(fs.existsSync(value.replacement.wrapper + ".part"), false);
});

test("failure after wrapper publication restores the complete previous install", (context) => {
  const value = replacementFixture(context);
  assert.throws(
    () => installNode(value.fixture, value.replacement, {
      onPublishBoundary(stage) {
        if (stage === "before-backup-cleanup") {
          throw new Error("TEST_AFTER_WRAPPER_PUBLICATION_FAILED");
        }
      },
    }),
    /TEST_AFTER_WRAPPER_PUBLICATION_FAILED/u,
  );
  assertPreviousStateRestored(value);
});

test("failure after backup restores the complete previous install", (context) => {
  const value = replacementFixture(context);
  assert.throws(
    () => installNode(value.fixture, value.replacement, {
      onPublishBoundary(stage) {
        if (stage === "after-backup") {
          throw new Error("TEST_AFTER_BACKUP_FAILED");
        }
      },
    }),
    /TEST_AFTER_BACKUP_FAILED/u,
  );
  assertPreviousStateRestored(value);
});

test("second backup rename failure restores the first backup entry", (context) => {
  const value = replacementFixture(context);
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (source === value.replacement.wrapper && target.endsWith("/wrapper")) {
      throw new Error("TEST_SECOND_BACKUP_RENAME_FAILED");
    }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => installNode(value.fixture, value.replacement),
      /TEST_SECOND_BACKUP_RENAME_FAILED/u,
    );
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  assertPreviousStateRestored(value);
});

test("failure after payload publication restores the complete previous install", (context) => {
  const value = replacementFixture(context);
  assert.throws(
    () => installNode(value.fixture, value.replacement, {
      onPublishBoundary(stage) {
        if (stage === "after-destination-publish") {
          throw new Error("TEST_AFTER_PAYLOAD_PUBLICATION_FAILED");
        }
      },
    }),
    /TEST_AFTER_PAYLOAD_PUBLICATION_FAILED/u,
  );
  assertPreviousStateRestored(value);
});
