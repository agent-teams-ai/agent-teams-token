import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { useCustodyDescriptor } from "../rollback/runtime/custody.mjs";
import {
  openRuntimeRegularFile,
  openRuntimeRoot,
  readRuntimeFile,
} from "../rollback/runtime/node-runtime-files.mjs";
import { observeConsumerDescriptors } from "./rollback-consumer-close-fixture.mjs";

const CLOSE_FAILURE = "ROLLBACK_RUNTIME_FILE_CLOSE_FAILED";

function runtimeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "agtmai-runtime-files-")));
  fs.mkdirSync(join(root, "data/bin"), { recursive: true });
  fs.writeFileSync(join(root, "data/bin/payload"), "authenticated bytes\n", { mode: 0o600 });
  return root;
}

function readFixture(root) {
  const runtimeRoot = openRuntimeRoot(root);
  return useCustodyDescriptor(runtimeRoot.descriptor, CLOSE_FAILURE, () => {
    const file = openRuntimeRegularFile(runtimeRoot, ["data", "bin", "payload"], {
      label: "data/bin/payload",
      missingCode: "ROLLBACK_RUNTIME_TEST_MISSING",
      unsafeCode: "ROLLBACK_RUNTIME_TEST_UNSAFE",
      maxBytes: 1_024,
    });
    return useCustodyDescriptor(file.descriptor, CLOSE_FAILURE,
      () => readRuntimeFile(file, "ROLLBACK_RUNTIME_TEST_UNSAFE", { captureBytes: true }));
  });
}

for (const scenario of [
  "root-stat", "initial-stat", "next-stat", "predecessor-close", "file-stat",
  "parent-close", "file-read", "all-after-read", "unsafe-file", "missing-file",
]) {
  test(`actual runtime file ownership survives ${scenario}`, () => {
    const root = runtimeFixture();
    const file = join(root, "data/bin/payload");
    const primary = new Error(`ROLLBACK_RUNTIME_INJECTED_PRIMARY ${scenario}`);
    if (scenario === "unsafe-file") { fs.linkSync(file, join(root, "other-link")); }
    if (scenario === "missing-file") { fs.unlinkSync(file); }
    const observation = observeConsumerDescriptors({
      beforeStat(record) {
        if (record.statCalls !== 1) { return; }
        if (scenario === "root-stat" && record.path === root && record.occurrence === 1
          || scenario === "initial-stat" && record.path === root && record.occurrence === 2
          || scenario === "next-stat" && record.path === join(root, "data")
          || scenario === "file-stat" && record.path === file) { throw primary; }
      },
      beforeRead(record, state) {
        if (["file-read", "all-after-read"].includes(scenario) && record.path === file) {
          state.primaryInjected = true;
          throw primary;
        }
      },
      closeTarget(record, state) {
        if (scenario === "root-stat") { return record.path === root && record.occurrence === 1; }
        if (["initial-stat", "predecessor-close"].includes(scenario)) {
          return record.path === root && record.occurrence === 2;
        }
        if (scenario === "next-stat") { return record.path === join(root, "data"); }
        if (["parent-close", "unsafe-file", "missing-file"].includes(scenario)) {
          return record.path === join(root, "data/bin");
        }
        if (scenario === "all-after-read") { return state.primaryInjected; }
        return record.path === file;
      },
    });
    try {
      assert.throws(() => readFixture(root), (error) => {
        assert.ok(error instanceof AggregateError);
        let expectedPrimary;
        if (!["predecessor-close", "parent-close"].includes(scenario)) {
          expectedPrimary = error.cause;
          if (["unsafe-file", "missing-file"].includes(scenario)) {
            assert.match(expectedPrimary.message, scenario === "unsafe-file"
              ? /ROLLBACK_RUNTIME_TEST_UNSAFE/u : /ROLLBACK_RUNTIME_TEST_MISSING/u);
          } else {
            assert.equal(expectedPrimary, primary);
          }
        }
        assert.deepEqual(error.errors, expectedPrimary === undefined
          ? observation.state.closeErrors : [expectedPrimary, ...observation.state.closeErrors]);
        assert.ok(observation.state.closeErrors.length > 0);
        return true;
      });
      observation.restore();
      observation.assertReleased();
    } finally {
      observation.restore();
      observation.cleanupLeakedTestDescriptors();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("successful runtime file transfer preserves held bytes and leaves no registrations", () => {
  const root = runtimeFixture();
  const observation = observeConsumerDescriptors();
  try {
    const result = readFixture(root);
    assert.equal(result.bytes.toString("utf8"), "authenticated bytes\n");
    assert.equal(result.sha256, createHash("sha256").update(result.bytes).digest("hex"));
    observation.restore();
    observation.assertReleased();
  } finally {
    observation.restore();
    observation.cleanupLeakedTestDescriptors();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
