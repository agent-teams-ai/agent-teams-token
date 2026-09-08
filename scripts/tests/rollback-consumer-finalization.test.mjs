import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertExactDirectoryShape } from "../rollback/runtime/directory-shape.mjs";
import { stageExactWorktreePaths } from "../rollback/slices/gate-contract.mjs";
import { observeConsumerDescriptors } from "./rollback-consumer-close-fixture.mjs";

function shapeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "agtmai-shape-finalization-")));
  fs.mkdirSync(join(root, "slice/nested"), { recursive: true });
  fs.writeFileSync(join(root, "slice/nested/file.txt"), "held bytes\n");
  return root;
}

function verifyFailure(action, expectedPrimary, observation) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof AggregateError);
    if (expectedPrimary !== undefined) {
      if (expectedPrimary instanceof RegExp) {
        assert.match(error.cause?.message, expectedPrimary);
      } else {
        assert.equal(error.cause, expectedPrimary);
      }
      assert.equal(error.errors[0], error.cause);
      assert.deepEqual(error.errors.slice(1), observation.state.closeErrors);
    } else {
      assert.deepEqual(error.errors, observation.state.closeErrors);
    }
    assert.ok(observation.state.closeErrors.length > 0);
    return true;
  });
}

for (const scenario of [
  "predecessor-close", "initial-stat", "next-stat", "file-read",
  "forbidden-child", "file-close", "final-owned-close", "root-close", "all-finalizers",
]) {
  test(`actual directory-shape preserves ownership and failures: ${scenario}`, () => {
    const root = shapeFixture();
    const primary = new Error(`injected shape failure: ${scenario}`);
    const file = join(root, "slice/nested/file.txt");
    if (scenario === "forbidden-child") {
      fs.writeFileSync(join(root, "slice/nested/unknown.txt"), "must reject\n");
    }
    const observation = observeConsumerDescriptors({
      beforeStat(record) {
        if (record.statCalls === 2 && (
          scenario === "initial-stat" && record.path === root && record.occurrence === 2
          || scenario === "next-stat" && record.path === join(root, "slice")
        )) { throw primary; }
      },
      beforeRead(record, state) {
        if (["file-read", "all-finalizers"].includes(scenario) && record.path === file) {
          state.primaryInjected = true;
          throw primary;
        }
      },
      closeTarget(record, state) {
        if (["predecessor-close", "initial-stat"].includes(scenario)) {
          return record.path === root && record.occurrence === 2;
        }
        if (scenario === "next-stat") { return record.path === join(root, "slice"); }
        if (scenario === "forbidden-child") { return record.path === join(root, "slice/nested"); }
        if (["file-close", "file-read"].includes(scenario)) { return record.path === file; }
        if (scenario === "root-close") { return record.path === root && record.occurrence === 1; }
        if (scenario === "all-finalizers") { return state.primaryInjected; }
        return record.path === join(root, "slice") && record.occurrence === 2;
      },
    });
    const expectedPrimary = scenario === "forbidden-child" ? /ROLLBACK_FORBIDDEN_RESIDUE/u
      : ["initial-stat", "next-stat", "file-read", "all-finalizers"].includes(scenario) ? primary : undefined;
    try {
      verifyFailure(
        () => assertExactDirectoryShape(root, "slice", ["slice/nested/file.txt"], "fixture"),
        expectedPrimary,
        observation,
      );
      observation.restore();
      observation.assertReleased();
    } finally {
      observation.restore();
      observation.cleanupLeakedTestDescriptors();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const readFailure of [false, true]) {
  test(`actual shape iterator closes once and preserves read error: ${readFailure}`, () => {
    const root = shapeFixture();
    const primary = new Error("injected iterator read failure");
    const secondary = new Error("injected iterator close failure");
    const nativeOpen = fs.opendirSync;
    const observation = observeConsumerDescriptors();
    let closes = 0;
    fs.opendirSync = (...arguments_) => {
      const directory = nativeOpen(...arguments_);
      const close = directory.closeSync.bind(directory);
      if (readFailure) { directory.readSync = () => { throw primary; }; }
      directory.closeSync = () => { closes += 1; close(); throw secondary; };
      return directory;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => assertExactDirectoryShape(root, "slice", ["slice/nested/file.txt"], "iterator"),
        (error) => error instanceof AggregateError
          && error.cause === (readFailure ? primary : undefined)
          && error.errors.length === (readFailure ? 2 : 1)
          && error.errors.at(-1) === secondary,
      );
      assert.equal(closes, 1);
      observation.restore();
      observation.assertReleased();
    } finally {
      fs.opendirSync = nativeOpen;
      syncBuiltinESMExports();
      observation.restore();
      observation.cleanupLeakedTestDescriptors();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const consumer of ["shape", "staging"]) {
  test(`successful ${consumer} preserves its result and releases all descriptors`, () => {
    const root = shapeFixture();
    const observation = observeConsumerDescriptors();
    const calls = [];
    const recorder = {
      run(_group, id, _command, commandArguments, options) {
        calls.push({ id, commandArguments, input: options.input });
        return { stdout: "a".repeat(40) + "\n" };
      },
    };
    try {
      if (consumer === "shape") {
        const result = assertExactDirectoryShape(root, "slice", ["slice/nested/file.txt"], "success");
        assert.equal(result.status, "passed");
        assert.equal(result.fileCount, 1);
        assert.equal(result.directoryCount, 2);
        assert.equal(result.totalBytes, Buffer.byteLength("held bytes\n"));
      } else {
        assert.equal(stageExactWorktreePaths(root, ["slice/nested/file.txt"], recorder, "fixture", "stage"), undefined);
        assert.deepEqual(calls.map(({ id }) => id), ["stage-hash-1", "stage-index-1"]);
        assert.equal(calls[0].input.toString("utf8"), "held bytes\n");
        assert.deepEqual(calls[1].commandArguments, [
          "update-index", "--add", "--cacheinfo", "100644", "a".repeat(40), "slice/nested/file.txt",
        ]);
      }
      observation.restore();
      observation.assertReleased();
      assert.equal(observation.state.closeErrors.length, 0);
    } finally {
      observation.restore();
      observation.cleanupLeakedTestDescriptors();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const scenario of ["capture-read", "capture-stat", "hash", "index", "success"]) {
  test(`actual staging retains primary failure across uncertain close: ${scenario}`, () => {
    const root = shapeFixture();
    const primary = new Error(`injected staging failure: ${scenario}`);
    const file = join(root, "slice/nested/file.txt");
    const observation = observeConsumerDescriptors({
      beforeStat(record) {
        if (scenario === "capture-stat" && record.path === file) { throw primary; }
      },
      beforeRead(record) {
        if (scenario === "capture-read" && record.path === file) { throw primary; }
      },
      closeTarget(record) { return record.path === file; },
    });
    const recorder = {
      run(_group, id) {
        if (scenario === "hash" && id.includes("-hash-")
          || scenario === "index" && id.includes("-index-")) { throw primary; }
        return { stdout: "a".repeat(40) + "\n" };
      },
    };
    try {
      verifyFailure(
        () => stageExactWorktreePaths(root, ["slice/nested/file.txt"], recorder, "fixture", "stage"),
        scenario === "success" ? undefined : primary,
        observation,
      );
      observation.restore();
      observation.assertReleased();
    } finally {
      observation.restore();
      observation.cleanupLeakedTestDescriptors();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
