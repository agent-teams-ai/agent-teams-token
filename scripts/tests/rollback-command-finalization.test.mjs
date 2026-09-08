import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceRecorder } from "../rollback/runtime/evidence.mjs";
import {
  assertOtherDescriptorsClosed,
  injectedUncertainClose,
} from "./rollback-descriptor-close-fixture.mjs";

function createFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "agtmai-command-finalization-")));
  const recorder = new EvidenceRecorder(root, { mode: "test" });
  const stdout = join(root, "commands/001-test-command.stdout.log");
  const stderr = join(root, "commands/001-test-command.stderr.log");
  fs.mkdirSync(join(root, "commands"), { mode: 0o700 });
  return { root, recorder, stdout, stderr };
}

function observeLogDescriptors(value) {
  const opened = [];
  const original = fs.openSync;
  fs.openSync = (path, ...arguments_) => {
    const descriptor = original(path, ...arguments_);
    const creating = typeof arguments_[0] === "number" && (arguments_[0] & fs.constants.O_CREAT) !== 0;
    if (creating && (path === value.stdout || path === value.stderr)) {
      opened.push({ descriptor, identity: fs.fstatSync(descriptor, { bigint: true }) });
    }
    return descriptor;
  };
  syncBuiltinESMExports();
  return {
    opened,
    restore() {
      fs.openSync = original;
      syncBuiltinESMExports();
    },
  };
}

function releaseFixture(value, observation, injection) {
  observation.restore();
  injection?.restore();
  // A red regression can expose a genuinely leaked descriptor. Close only
  // the exact file opened by this fixture, never a reused descriptor number.
  for (const { descriptor, identity } of observation.opened) {
    let current;
    try { current = fs.fstatSync(descriptor, { bigint: true }); } catch { continue; }
    if (current.dev === identity.dev && current.ino === identity.ino) {
      fs.closeSync(descriptor);
    }
  }
  const reused = injection?.reusedDescriptor();
  if (Number.isInteger(reused)) {
    fs.closeSync(reused);
  }
  fs.rmSync(value.root, { recursive: true, force: true });
}

function runCommand(value, exitCode = 0) {
  return value.recorder.run("test", "command", process.execPath, [
    "-e",
    "process.stdout.write('command-out'); process.stderr.write('command-err'); process.exit(" + exitCode + ")",
  ], { cwd: value.root, env: {}, timeout: 10_000 });
}

function assertClosedLogs(observation, injection) {
  const descriptors = observation.opened.map(({ descriptor }) => descriptor);
  assert.equal(new Set(injection.calls).size, descriptors.length);
  assert.equal(injection.calls.length, descriptors.length);
  assert.deepEqual(injection.calls, descriptors);
  assertOtherDescriptorsClosed(descriptors, injection.reusedDescriptor());
  assert.doesNotThrow(() => fs.fstatSync(injection.reusedDescriptor()));
}

for (const failure of ["stdout", "stderr", "invocation"]) {
  test(`command acquisition closes every acquired log after ${failure} failure`, () => {
    const value = createFixture();
    if (failure !== "invocation") {
      fs.writeFileSync(value[failure], "preexisting-must-survive\n", { flag: "wx" });
    }
    const observation = observeLogDescriptors(value);
    try {
      assert.throws(
        () => failure === "invocation"
          ? value.recorder.run("test", "command", "/usr/bin/git", ["--version"])
          : runCommand(value),
        failure === "invocation"
          ? /TOOLCHAIN_GIT_WORKING_DIRECTORY_INVALID/u
          : { code: "EEXIST" },
      );
      assert.equal(observation.opened.length, { stdout: 0, stderr: 1, invocation: 2 }[failure]);
      for (const { descriptor } of observation.opened) {
        assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
      }
      if (failure !== "invocation") {
        assert.equal(fs.readFileSync(value[failure], "utf8"), "preexisting-must-survive\n");
      }
      assert.equal(value.recorder.document.commands.length, 0);
    } finally {
      releaseFixture(value, observation);
    }
  });
}

for (const exitCode of [0, 23]) {
  for (const closeIndex of [0, 1]) {
    test(`recorded command exit ${exitCode} retains consumed close ${closeIndex} failure`, () => {
      const value = createFixture();
      const observation = observeLogDescriptors(value);
      const injection = injectedUncertainClose(closeIndex);
      try {
        assert.throws(() => runCommand(value, exitCode), (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.message, "ROLLBACK_COMMAND_FINALIZATION_FAILED");
          const closeFailure = error.errors.at(-1);
          assert.equal(closeFailure.code, "EINTR");
          if (exitCode !== 0) {
            assert.equal(error.errors.length, 2);
            assert.equal(error.cause, error.errors[0]);
            assert.match(error.errors[0].message, /ROLLBACK_COMMAND_FAILED.*status=23/u);
            assert.match(error.errors[0].message, /command-out\ncommand-err/u);
          } else {
            assert.equal(error.errors.length, 1);
          }
          return true;
        });
        assertClosedLogs(observation, injection);
        const persisted = JSON.parse(fs.readFileSync(join(value.root, "diagnostics.json"), "utf8"));
        assert.equal(persisted.commands[0].status, "failed");
        assert.equal(persisted.commands[0].exitCode, exitCode);
        assert.equal(fs.readFileSync(value.stdout, "utf8"), "command-out");
        assert.equal(fs.readFileSync(value.stderr, "utf8"), "command-err");
      } finally {
        releaseFixture(value, observation, injection);
      }
    });
  }
}

for (const failure of ["stderr", "invocation"]) {
  test(`partial command acquisition preserves ${failure} plus real close failure`, () => {
    const value = createFixture();
    if (failure === "stderr") {
      fs.writeFileSync(value.stderr, "preexisting\n", { flag: "wx" });
    }
    const observation = observeLogDescriptors(value);
    const injection = injectedUncertainClose(0);
    try {
      assert.throws(
        () => failure === "invocation"
          ? value.recorder.run("test", "command", "/usr/bin/git", ["--version"])
          : runCommand(value),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.message, "ROLLBACK_COMMAND_FINALIZATION_FAILED");
          assert.equal(error.errors.length, 2);
          assert.equal(error.cause, error.errors[0]);
          if (failure === "stderr") {
            assert.equal(error.errors[0].code, "EEXIST");
          } else {
            assert.equal(error.errors[0].message, "TOOLCHAIN_GIT_WORKING_DIRECTORY_INVALID");
          }
          assert.equal(error.errors[1].code, "EINTR");
          return true;
        },
      );
      assertClosedLogs(observation, injection);
    } finally {
      releaseFixture(value, observation, injection);
    }
  });
}

test("command, consumed close and reporting failures remain in order", () => {
  const value = createFixture();
  const reportingFailure = new Error("injected reporting failure");
  value.recorder.flush = () => { throw reportingFailure; };
  const observation = observeLogDescriptors(value);
  const injection = injectedUncertainClose(0);
  try {
    assert.throws(() => runCommand(value, 23), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "ROLLBACK_COMMAND_FINALIZATION_FAILED");
      assert.equal(error.errors.length, 3);
      assert.equal(error.cause, error.errors[0]);
      assert.match(error.errors[0].message, /ROLLBACK_COMMAND_FAILED.*status=23/u);
      assert.equal(error.errors[1].code, "EINTR");
      assert.equal(error.errors[2], reportingFailure);
      return true;
    });
    assertClosedLogs(observation, injection);
  } finally {
    releaseFixture(value, observation, injection);
  }
});

test("a failed spawn retains its OS cause when log close also fails", () => {
  const value = createFixture();
  const observation = observeLogDescriptors(value);
  const injection = injectedUncertainClose(0);
  try {
    assert.throws(() => value.recorder.run(
      "test", "command", join(value.root, "missing-executable"), [],
      { cwd: value.root, env: {}, timeout: 10_000 },
    ), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal(error.cause, error.errors[0]);
      assert.match(error.errors[0].message, /ROLLBACK_COMMAND_FAILED/u);
      assert.equal(error.errors[0].cause.code, "ENOENT");
      assert.equal(error.errors[1].code, "EINTR");
      return true;
    });
    assertClosedLogs(observation, injection);
    assert.equal(value.recorder.document.commands[0].spawnError, "ENOENT");
    assert.equal(value.recorder.document.commands[0].status, "failed");
  } finally {
    releaseFixture(value, observation, injection);
  }
});

test("command failure survives a later log read failure and consumed close", () => {
  const value = createFixture();
  const observation = observeLogDescriptors(value);
  const injection = injectedUncertainClose(0);
  const originalRead = fs.readFileSync;
  const readFailure = new Error("injected log read failure");
  fs.readFileSync = (path, ...arguments_) => {
    if (path === value.stdout) { throw readFailure; }
    return originalRead(path, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => runCommand(value, 23), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 3);
      assert.equal(error.cause, error.errors[0]);
      assert.match(error.errors[0].message, /ROLLBACK_COMMAND_FAILED.*status=23/u);
      assert.equal(error.errors[1].code, "EINTR");
      assert.equal(error.errors[2], readFailure);
      return true;
    });
    assertClosedLogs(observation, injection);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    releaseFixture(value, observation, injection);
  }
});

test("successful recorded command retains its existing result contract", () => {
  const value = createFixture();
  const observation = observeLogDescriptors(value);
  try {
    const result = runCommand(value);
    assert.equal(result.stdout, "command-out");
    assert.equal(result.stderr, "command-err");
    assert.equal(result.entry.status, "passed");
    for (const { descriptor } of observation.opened) {
      assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
    }
  } finally {
    releaseFixture(value, observation);
  }
});
