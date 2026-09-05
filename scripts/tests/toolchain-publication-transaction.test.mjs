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
    if (typeof path === "number") {
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

function backupRoot(value) {
  return join(value.fixture.toolsRoot, fs.readdirSync(value.fixture.toolsRoot)
    .find((name) => name.startsWith(".install-backup-")));
}

for (const [stage, mutation] of [
  ["after-destination-publish", "added-file"],
  ["before-backup-cleanup", "added-file"],
  ["before-backup-cleanup", "changed-bytes"],
  ["before-backup-cleanup", "removed-file"],
]) {
  test(`published payload ${mutation} at ${stage} preserves backup evidence`, (context) => {
    const value = replacementFixture(context);
    assert.throws(() => installNode(value.fixture, value.replacement, {
      onPublishBoundary(boundary) {
        if (boundary === stage) {
          if (mutation === "added-file") {
            fs.writeFileSync(join(value.replacement.destination, "foreign"), "foreign");
          } else if (mutation === "changed-bytes") {
            fs.writeFileSync(value.binary, "foreign");
          } else {fs.unlinkSync(value.binary);}
        }
      },
    }), /TOOLCHAIN_INSTALL_ROLLBACK_FAILED/u);
    if (mutation === "added-file") {
      assert.equal(fs.readFileSync(join(value.replacement.destination, "foreign"), "utf8"), "foreign");
    } else if (mutation === "changed-bytes") {
      assert.equal(fs.readFileSync(value.binary, "utf8"), "foreign");
    } else {assert.equal(fs.existsSync(value.binary), false);}
    assert.equal(fs.readFileSync(join(backupRoot(value), "payload",
      value.replacement.artifact.versionChecks[0].path), "utf8"), "tampered-old-payload\n");
  });
}

for (const kind of ["wrapper", "payload", "dangling-wrapper"]) {
  test(`foreign ${kind} during restore is never overwritten`, (context) => {
    const value = replacementFixture(context);
    const primary = new Error("TEST_FOREIGN_DURING_RESTORE");
    const target = kind === "payload" ? value.replacement.destination : value.replacement.wrapper;
    assert.throws(() => installNode(value.fixture, value.replacement, {
      onPublishBoundary(stage) {
        if (stage === "after-backup") {
          if (kind === "dangling-wrapper") {fs.symlinkSync("missing-foreign", target);}
          else {fs.writeFileSync(target, "foreign");}
          throw primary;
        }
      },
    }), (error) => error instanceof AggregateError && error.errors[0] === primary);
    if (kind === "dangling-wrapper") {assert.equal(fs.readlinkSync(target), "missing-foreign");}
    else {assert.equal(fs.readFileSync(target, "utf8"), "foreign");}
    assert.equal(fs.existsSync(join(backupRoot(value), kind === "payload" ? "payload" : "wrapper")), true);
  });
}

test("dangling wrapper part symlink never creates its foreign target", (context) => {
  const value = replacementFixture(context);
  const foreign = join(value.fixture.root, "missing-foreign");
  const part = value.replacement.wrapper + ".part";
  fs.symlinkSync(foreign, part);
  assert.throws(() => installNode(value.fixture, value.replacement), /EEXIST/u);
  assert.equal(fs.readlinkSync(part), foreign);
  assert.equal(fs.existsSync(foreign), false);
  assertPreviousStateRestored(value);
});

test("wrapper part pathname replacement preserves foreign symlink and target", (context) => {
  const value = replacementFixture(context);
  const foreign = join(value.fixture.root, "foreign");
  fs.writeFileSync(foreign, "untouched");
  assert.throws(() => installNode(value.fixture, value.replacement, {
    onPublishBoundary(stage, details) {
      if (stage === "before-wrapper-rename") {
        fs.renameSync(details.part, details.part + ".held");
        fs.symlinkSync(foreign, details.part);
      }
    },
  }), /TOOLCHAIN_WRAPPER_PUBLICATION_FAILED/u);
  assert.equal(fs.readFileSync(foreign, "utf8"), "untouched");
  assert.equal(fs.readlinkSync(value.replacement.wrapper + ".part"), foreign);
  assertPreviousStateRestored(value);
});

test("failure after wrapper rename before identity capture preserves exact primary", (context) => {
  const value = replacementFixture(context);
  const primary = new Error("TEST_AFTER_RENAME_BEFORE_CAPTURE");
  assert.throws(() => installNode(value.fixture, value.replacement, {
    onPublishBoundary(stage) {
      if (stage === "after-wrapper-rename") {throw primary;}
    },
  }), (error) => error === primary);
  assertPreviousStateRestored(value);
});

test("wrapper rename failure aggregates primary, close and rollback failures", (context) => {
  const value = replacementFixture(context);
  const primary = new Error("TEST_AFTER_RENAME");
  const closeFailure = new Error("TEST_WRAPPER_CLOSE");
  const originalClose = fs.closeSync;
  context.after(() => {
    fs.closeSync = originalClose;
    syncBuiltinESMExports();
  });
  assert.throws(() => installNode(value.fixture, value.replacement, {
    onPublishBoundary(stage) {
      if (stage === "after-wrapper-rename") {
        fs.renameSync(value.replacement.wrapper, value.replacement.wrapper + ".held");
        fs.writeFileSync(value.replacement.wrapper, "foreign");
        fs.closeSync = (descriptor) => {
          fs.closeSync = originalClose;
          syncBuiltinESMExports();
          originalClose(descriptor);
          throw closeFailure;
        };
        syncBuiltinESMExports();
        throw primary;
      }
    },
  }), (error) => error instanceof AggregateError
    && error.errors[0].errors[0] === primary
    && error.errors[0].errors[1] === closeFailure
    && /SUBSTITUTED/u.test(error.errors[1].message));
  assert.equal(fs.readFileSync(value.replacement.wrapper, "utf8"), "foreign");
  assert.equal(fs.readFileSync(join(backupRoot(value), "wrapper"), "utf8"), "tampered-old-wrapper\n");
});

test("identical foreign destination tree is rejected by identity before commit", (context) => {
  const value = replacementFixture(context);
  assert.throws(() => installNode(value.fixture, value.replacement, {
    onPublishBoundary(stage) {
      if (stage === "before-backup-cleanup") {
        const held = value.replacement.destination + ".held";
        fs.renameSync(value.replacement.destination, held);
        fs.cpSync(held, value.replacement.destination, { recursive: true });
      }
    },
  }), (error) => error instanceof AggregateError
    && error.errors[0].message === "TOOLCHAIN_DESTINATION_SUBSTITUTED");
  assert.equal(fs.existsSync(value.binary), true);
  assert.equal(fs.existsSync(join(backupRoot(value), "payload")), true);
});

test("wrapper mutation immediately before commit preserves foreign content and backup", (context) => {
  const value = replacementFixture(context);
  assert.throws(() => installNode(value.fixture, value.replacement, {
    onPublishBoundary(stage) {
      if (stage === "before-backup-cleanup") {
        fs.writeFileSync(value.replacement.wrapper, "foreign");
      }
    },
  }), (error) => error instanceof AggregateError
    && error.errors[0].message === "TOOLCHAIN_WRAPPER_PUBLICATION_SUBSTITUTED");
  assert.equal(fs.readFileSync(value.replacement.wrapper, "utf8"), "foreign");
  assert.equal(fs.readFileSync(join(backupRoot(value), "wrapper"), "utf8"), "tampered-old-wrapper\n");
});

test("backup cleanup failure after commit retains the validated installation", (context) => {
  const value = replacementFixture(context);
  const primary = new Error("TEST_BACKUP_CLEANUP_FAILED");
  const originalUnlink = fs.unlinkSync;
  let publicationCommitted = false;
  fs.unlinkSync = (...arguments_) => {
    if (publicationCommitted) {
      throw primary;
    }
    return originalUnlink(...arguments_);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => installNode(value.fixture, value.replacement, {
      onPublishBoundary(stage) {
        if (stage === "after-publication-commit") {
          publicationCommitted = true;
        }
      },
    }),
      (error) => error === primary || error.cause === primary
        || (error instanceof AggregateError && error.errors.includes(primary)));
  } finally {
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
  }
  assert.notEqual(fs.readFileSync(value.binary, "utf8"), "tampered-old-payload\n");
  assert.notEqual(fs.readFileSync(value.replacement.wrapper, "utf8"), "tampered-old-wrapper\n");
  assert.equal(fs.existsSync(value.replacement.prepared.source), false);
});

test("first installation also validates published content without a backup", (context) => {
  const fixture = makeFixture();
  fetchArtifacts({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    downloader: fixture.downloader,
  });
  const value = prepareNode(fixture);
  context.after(() => {
    cleanupPreparedPayload(value.prepared);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  assert.throws(() => installNode(fixture, value, {
    onPublishBoundary(stage) {
      if (stage === "after-destination-publish") {
        fs.writeFileSync(join(value.destination, "foreign"), "foreign");
      }
    },
  }), (error) => error instanceof AggregateError
    && /TOOLCHAIN_PUBLISHED_AUTHORITY_INVALID/u.test(error.errors[0].message));
  assert.equal(fs.readFileSync(join(value.destination, "foreign"), "utf8"), "foreign");
});
