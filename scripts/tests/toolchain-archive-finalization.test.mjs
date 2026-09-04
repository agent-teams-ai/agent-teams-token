import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { cleanupPreparedPayload, prepareVerifiedPayload } from "../toolchain-archive.mjs";
import { observeConsumerDescriptors } from "./rollback-consumer-close-fixture.mjs";

function archiveFixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "agtmai-archive-finalization-"));
  const archive = join(root, "tiny-executable");
  const bytes = "test fixture, never executed\n";
  fs.writeFileSync(archive, bytes, { mode: 0o600 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    name: "fixture", platform: `${process.platform}-${process.arch}`,
    toolsRoot: root, archive, missingCode: "TEST_ARCHIVE_MISSING",
    artifact: { archive: "executable", expectedFiles: ["bin/tool"], sha256,
      expectedFileSha256: { "bin/tool": sha256 } },
  };
}

function includesError(error, expected) {
  return error === expected || error instanceof AggregateError
    && error.errors.some((entry) => includesError(entry, expected))
    || error?.cause !== undefined && includesError(error.cause, expected);
}

for (const scenario of [
  "archive-close", "callback-and-close", "verification-and-close",
  "copy-and-closes", "cleanup-and-close", "successor-and-close",
  "snapshot-and-closes",
]) {
  test(`archive preparation finalizes all owners after ${scenario}`, () => {
    const fixture = archiveFixture();
    const root = fixture.toolsRoot;
    const primary = new Error(`TEST_PREPARATION_PRIMARY ${scenario}`);
    const cleanupFailure = new Error("TEST_PREPARATION_CLEANUP");
    let archiveReads = 0;
    let successor;
    if (scenario === "verification-and-close") { fixture.artifact.sha256 = "0".repeat(64); }
    const observation = observeConsumerDescriptors({
      beforeRead(record, state) {
        if (record.path !== fixture.archive) { return; }
        archiveReads += 1;
        if (["copy-and-closes", "snapshot-and-closes"].includes(scenario) && archiveReads === 2) {
          state.primaryInjected = true;
          throw primary;
        }
      },
      beforeStat(record, state) {
        if (scenario === "snapshot-and-closes" && state.primaryInjected
          && record.path.endsWith("/payload")) { throw cleanupFailure; }
      },
      closeTarget(record, state) {
        return record.path === fixture.archive
          || scenario === "copy-and-closes" && record.path.endsWith("/payload/bin/tool")
          || scenario === "snapshot-and-closes" && state.primaryInjected;
      },
    });
    try {
      assert.throws(() => prepareVerifiedPayload({
        ...fixture,
        onArchiveVerified() {
          if (scenario === "successor-and-close") {
            const stage = fs.readdirSync(root).find((entry) => entry.startsWith(".install-part-"));
            const payload = join(root, stage, "payload");
            fs.renameSync(payload, join(root, "held-payload"));
            fs.mkdirSync(payload);
            successor = join(payload, "foreign-sentinel");
            fs.writeFileSync(successor, "preserve foreign tree\n");
          }
          if (["callback-and-close", "cleanup-and-close", "successor-and-close"].includes(scenario)) {
            throw primary;
          }
        },
        onCleanupBoundary() {
          if (scenario === "cleanup-and-close") { throw cleanupFailure; }
        },
      }), (error) => {
        if (scenario === "archive-close") {
          assert.deepEqual(fs.readdirSync(root), [basename(fixture.archive)]);
        }
        assert.ok(error instanceof AggregateError);
        if (scenario === "verification-and-close") {
          assert.match(error.cause.message, /TOOLCHAIN_OFFLINE_UNVERIFIED_CACHE/u);
          assert.equal(error.errors[0], error.cause);
        } else if (scenario !== "archive-close") {
          assert.equal(error.cause, primary);
          assert.equal(error.errors[0], primary);
        }
        assert.ok(observation.state.closeErrors.length > 0);
        for (const closeError of observation.state.closeErrors) {
          assert.ok(includesError(error, closeError));
        }
        if (["cleanup-and-close", "snapshot-and-closes"].includes(scenario)) {
          assert.ok(includesError(error, cleanupFailure));
        }
        return true;
      });
      observation.restore();
      observation.assertReleased();
      if (scenario === "successor-and-close") {
        assert.equal(fs.readFileSync(successor, "utf8"), "preserve foreign tree\n");
        assert.equal(fs.existsSync(join(root, "held-payload")), true);
      } else if (scenario === "snapshot-and-closes") {
        const stages = fs.readdirSync(root).filter((entry) => entry.startsWith(".install-part-"));
        assert.equal(stages.length, 1, "uncertain snapshot is preserved, never adopted for deletion");
      } else if (scenario !== "cleanup-and-close") {
        assert.deepEqual(fs.readdirSync(root), [basename(fixture.archive)]);
      }
    } finally {
      observation.restore();
      observation.cleanupLeakedTestDescriptors();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("successful preparation transfers its cleanup owner only after archive close", () => {
  const fixture = archiveFixture();
  const observation = observeConsumerDescriptors();
  let prepared;
  try {
    prepared = prepareVerifiedPayload(fixture);
    assert.equal(prepared.cleanupHandle.closed, false);
    const archive = observation.state.records.filter((entry) => entry.path === fixture.archive);
    assert.equal(archive.length, 1);
    assert.equal(archive[0].closeCalls, 1);
    assert.equal(prepared.files["bin/tool"], fixture.artifact.sha256);
    cleanupPreparedPayload(prepared);
    assert.equal(prepared.cleanupHandle.closed, true);
    observation.restore();
    observation.assertReleased();
    assert.deepEqual(fs.readdirSync(fixture.toolsRoot), [basename(fixture.archive)]);
  } finally {
    observation.restore();
    observation.cleanupLeakedTestDescriptors();
    fs.rmSync(fixture.toolsRoot, { recursive: true, force: true });
  }
});

test("failed cleanup custody reports the preserved stage and releases acquired descriptors", () => {
  const fixture = archiveFixture();
  const primary = new Error("TEST_PREPARATION_CUSTODY_PRIMARY");
  let stageRoot;
  const observation = observeConsumerDescriptors({
    beforeStat(record) {
      if (record.path.includes(".install-part-") && record.statCalls === 1) {
        stageRoot = record.path;
        throw primary;
      }
    },
    closeTarget(record) { return record.path === stageRoot; },
  });
  try {
    assert.throws(() => prepareVerifiedPayload(fixture), (error) => {
      assert.match(error.message, /TOOLCHAIN_PREPARATION_CUSTODY_FAILED preservedStage=/u);
      assert.ok(includesError(error, primary));
      for (const closeError of observation.state.closeErrors) {
        assert.ok(includesError(error, closeError));
      }
      return true;
    });
    observation.restore();
    observation.assertReleased();
    assert.equal(fs.existsSync(stageRoot), true, "uncaptured pathname is reported, never adopted");
  } finally {
    observation.restore();
    observation.cleanupLeakedTestDescriptors();
    fs.rmSync(fixture.toolsRoot, { recursive: true, force: true });
  }
});
