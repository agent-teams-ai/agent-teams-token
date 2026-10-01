import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { basicRun, captureGitStatusSnapshot } from "../rollback/runtime/candidate.mjs";
import { EvidenceRecorder } from "../rollback/runtime/evidence.mjs";
import { captureCleanupTreeSnapshot, createCleanupHandle } from "../rollback/runtime/cleanup.mjs";
import { finalizeRollbackTemporaryParent } from "../rollback/slices/gate-execution.mjs";
import { createRollbackWorkspaceHandle } from "../rollback/slices/workspace-handle.mjs";
import * as execution from "../toolchain-execution.mjs";
import { containsFailure, invocationFault } from "./toolchain-invocation-fault-fixture.mjs";
import { digest } from "./toolchain-fixtures.mjs";
import { injectedUncertainClose } from "./rollback-descriptor-close-fixture.mjs";

function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-quiescence-test-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, recorder: new EvidenceRecorder(root, {}) };
}

function run(consumer, value, script, options = {}) {
  const args = ["-e", script];
  const settings = { cwd: value.root, env: {}, timeout: 200, ...options };
  return consumer === "evidence"
    ? value.recorder.run("test", "command", process.execPath, args, settings)
    : basicRun(process.execPath, args, settings);
}

for (const consumer of ["evidence", "candidate"]) {
  test(`${consumer}: ignores TERM timeout is bounded and cannot write later`, (context) => {
    const value = fixture(context);
    const marker = join(value.root, "late");
    const script = `process.on('SIGTERM', () => {}); setTimeout(() => {
      require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'); process.exit(0);
    }, 2000);`;
    const start = Date.now();
    assert.throws(() => run(consumer, value, script), /ROLLBACK_COMMAND_FAILED/u);
    const elapsed = Date.now() - start;
    context.diagnostic(`timeout elapsed=${elapsed}ms`);
    assert.ok(elapsed < 1500, `timeout took ${elapsed}ms`);
    assert.equal(existsSync(marker), false, "timed-out command wrote its delayed marker");
    if (consumer === "evidence") {
      const [entry] = value.recorder.document.commands;
      assert.equal(entry.status, "failed");
      assert.equal(entry.timedOut, true);
      assert.equal(entry.spawnError, "ETIMEDOUT");
    }
  });

  for (const exitCode of [0, 23]) {
    test(`${consumer}: ordinary descendant quiet after parent exit ${exitCode}`, async (context) => {
      const value = fixture(context);
      const marker = join(value.root, "descendant-late");
      const child = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 700)`;
      const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}],
        {stdio: 'ignore'}).unref(); process.stdout.write('parent'); process.exit(${exitCode});`;
      if (exitCode === 0) {
        const result = run(consumer, value, script, { timeout: 5000 });
        assert.equal(consumer === "evidence" ? result.stdout : result, "parent");
      } else {
        assert.throws(() => run(consumer, value, script, { timeout: 5000 }), /status=23/u);
      }
      await new Promise((resolve) => { setTimeout(resolve, 850); });
      assert.equal(existsSync(marker), false, "ordinary descendant wrote after command returned");
    });
  }
}

test("quick commands preserve cwd, allowlisted env, stdin and byte captures", (context) => {
  const value = fixture(context);
  const result = run("evidence", value,
    "process.stdout.write(process.cwd() + ':' + process.env.CI + ':' + require('node:fs').readFileSync(0)); process.stderr.write('err')",
    { input: "input", env: { CI: "test" }, timeout: 5000 });
  assert.equal(result.stdout, `${value.root}:test:input`);
  assert.equal(result.stderr, "err");
  assert.equal(result.entry.status, "passed");
  assert.equal(run("candidate", value, "process.stdout.write(require('node:fs').readFileSync(0))",
    { input: "text", timeout: 5000 }), "text");
  basicRun("/usr/bin/git", ["init", "--quiet"], { cwd: value.root });
  writeFileSync(join(value.root, "unicode-\u00e9.txt"), "bytes");
  const snapshot = captureGitStatusSnapshot(value.root);
  const bytes = Buffer.from(snapshot.base64, "base64");
  assert.ok(bytes.includes(Buffer.from("unicode-\u00e9.txt\0")));
  assert.equal(bytes.length, snapshot.byteLength);
});

function workspace(root) {
  const parent = mkdtempSync(join(root, "agtmai-rollback-slither-"));
  const cleanupHandle = createCleanupHandle(parent, {
    temporaryRoot: root, targetPrefix: "agtmai-rollback-slither-", allowedEntries: ["checkout", "gate-tmp"],
  });
  const checkout = join(parent, "checkout");
  const quarantine = join(parent, "gate-tmp");
  mkdirSync(checkout, { mode: 0o700 });
  mkdirSync(quarantine, { mode: 0o700 });
  const workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantine);
  writeFileSync(join(checkout, "custody"), "retain");
  captureCleanupTreeSnapshot(cleanupHandle);
  return { cleanupHandle, workspaceHandle, checkout };
}

for (const processesQuiescent of [false, true]) {
  test(`workspace deletion requires confirmed quiescence=${processesQuiescent}`, (context) => {
    const value = fixture(context);
    const custody = workspace(value.root);
    const finalized = finalizeRollbackTemporaryParent({ ...custody, processesQuiescent });
    assert.equal(finalized.cleanup.status, processesQuiescent ? "passed" : "preserved");
    assert.equal(existsSync(custody.checkout), !processesQuiescent);
    if (!processesQuiescent) {
      assert.match(finalized.primaryFailure.message, /ROLLBACK_PROCESS_QUIESCENCE_UNCERTAIN/u);
    }
  });
}

for (const signal of ["SIGKILL", "SIGSTOP"]) {
  test(`lost supervisor (${signal}) is bounded and retains uncertain custody`, async (context) => {
    const value = fixture(context);
    const { cleanupHandle, workspaceHandle, checkout } = workspace(value.root);
    const pidFile = join(value.root, "pid");
    const script = `process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      process.kill(process.ppid, '${signal}'); setTimeout(() => process.exit(0), 7000);`;
    const start = Date.now();
    let failure;
    try { run("evidence", value, script, { cwd: checkout }); } catch (error) { failure = error; }
    const elapsed = Date.now() - start;
    context.diagnostic(`lost supervisor elapsed=${elapsed}ms`);
    assert.ok(elapsed < 6000, `outer supervisor wait took ${elapsed}ms`);
    assert.match(failure?.cause?.message ?? "", /TOOLCHAIN_PROCESS_GROUP_QUIESCENCE_UNCERTAIN/u);
    const [lost] = value.recorder.document.commands;
    assert.equal(lost.processesQuiescent, false);
    assert.equal(lost.supervisor.signal, "SIGKILL");
    assert.equal(lost.supervisor.error, signal === "SIGSTOP" ? "ETIMEDOUT" : null);
    assert.equal(lost.timedOut, signal === "SIGSTOP");
    assert.equal(lost.exitCode, null, "supervisor exit is not the child's exit");
    assert.equal(lost.signal, null, "supervisor signal is not the child's signal");
    run("evidence", value, "process.stdout.write('next command')", { timeout: 5000 });
    assert.equal(value.recorder.processesQuiescent, false, "a later success must not clear uncertainty");
    assert.equal(value.recorder.document.commands[0].status, "failed");
    const invocation = failure.cause.message.split("invocation=")[1];
    assert.equal(existsSync(invocation), true, "uncertain invocation must survive");
    context.after(() => rmSync(invocation, { recursive: true, force: true }));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    const pid = Number(readFileSync(pidFile, "utf8"));
    let state;
    try { state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0]; } catch {}
    assert.ok(state === undefined || state === "Z", `fallback left live target ${pid} (${state})`);
    // Even a swallowed command error cannot authorize deletion of the workspace.
    const finalized = finalizeRollbackTemporaryParent({
      cleanupHandle, workspaceHandle, processesQuiescent: value.recorder.processesQuiescent,
    });
    assert.equal(finalized.cleanup.status, "preserved");
    assert.match(finalized.primaryFailure.message, /ROLLBACK_PROCESS_QUIESCENCE_UNCERTAIN/u);
    assert.equal(readFileSync(join(checkout, "custody"), "utf8"), "retain");
  });
}

test("shared captures preserve binary stdin/stdout and enforce the output limit", (context) => {
  const value = fixture(context);
  const input = Buffer.from([0, 255, 128, 13, 10]);
  const result = execution.executeSupervisedCommand({
    command: process.execPath, args: ["-e", "process.stdout.write(require('node:fs').readFileSync(0))"],
    cwd: value.root, env: {}, input, encoding: null, timeoutMs: 5000,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout, input);
  const overflow = execution.executeSupervisedCommand({
    command: process.execPath, args: ["-e", "process.stdout.write(Buffer.alloc(8192)); setInterval(() => {}, 1000)"],
    cwd: value.root, env: {}, maxBuffer: 1024, timeoutMs: 5000,
  });
  assert.equal(overflow.error.code, "ENOBUFS");
  assert.equal(overflow.targetStatus.quiescent, true);
  assert.equal(overflow.stdout.length, 1024);
});

test("stopped supervisor with captured pipes returns within its outer kill bound", (context) => {
  const value = fixture(context);
  const script = "process.on('SIGTERM', () => {}); process.kill(process.ppid, 'SIGSTOP'); setTimeout(() => {}, 7000)";
  const start = Date.now();
  assert.throws(() => run("candidate", value, script), (error) => {
    assert.match(error.message, /ROLLBACK_COMMAND_FAILED/u);
    assert.match(error.cause.message, /TOOLCHAIN_PROCESS_GROUP_QUIESCENCE_UNCERTAIN/u);
    assert.equal(error.cause.cause.code, "ETIMEDOUT");
    assert.equal(error.result.targetStatus.quiescent, false);
    const invocation = error.cause.message.split("invocation=")[1];
    assert.equal(existsSync(invocation), true);
    context.after(() => rmSync(invocation, { recursive: true, force: true }));
    return true;
  });
  assert.ok(Date.now() - start < 6000, "captured streams held the outer wait open");
});

for (const consumer of ["text", "buffer"]) {
  test(`candidate ${consumer} normalizes a real executor finalization exception`, (context) => {
    const value = fixture(context);
    basicRun("/usr/bin/git", ["init", "--quiet"], { cwd: value.root });
    writeFileSync(join(value.root, "unicode-\u00e9.txt"), "bytes");
    const injection = invocationFault({ cleanup: true });
    try {
      assert.throws(() => consumer === "text"
        ? run("candidate", value, "process.stdout.write('out'); process.stderr.write('err'); process.exit(23)", { timeout: 5000 })
        : captureGitStatusSnapshot(value.root), (error) => {
        assert.match(error.message, /ROLLBACK_COMMAND_FAILED command=/u);
        assert.match(error.message, consumer === "text" ? /status=23.*\nout\nerr/su : /status=0.*unicode-\u00e9.txt/su);
        assert.ok(containsFailure(error.cause, injection.failures[0]));
        assert.equal(error.result, error.cause.result);
        assert.equal(error.result.targetStatus.quiescent, true);
        if (consumer === "buffer") { assert.ok(Buffer.isBuffer(error.result.stdout)); }
        return true;
      });
      injection.assertCloses();
    } finally { injection.release(); }
  });
}

test("maxBuffer bounds captured pipes independently and leaves passed FDs to their owner", (context) => {
  const value = fixture(context);
  const script = "process.stdout.write(Buffer.alloc(8192, 'o')); process.stderr.write(Buffer.alloc(8192, 'e'))";
  const settings = { cwd: value.root, env: {}, maxBuffer: 1024, timeoutMs: 5000 };
  const pipes = execution.executeSupervisedCommand({ command: process.execPath, args: ["-e", script], ...settings });
  assert.equal(pipes.error.code, "ENOBUFS");
  assert.equal(pipes.stdout.length, 1024);
  assert.equal(pipes.stderr.length, 1024);
  assert.equal(pipes.targetStatus.quiescent, true);
  const output = join(value.root, "fd-output");
  const descriptor = openSync(output, "w+");
  try {
    for (const nodeCompatible of [true, false]) {
      const options = { ...settings, stdio: ["ignore", descriptor, "ignore"] };
      const result = nodeCompatible
        ? spawnSync(process.execPath, ["-e", script], { ...options, timeout: options.timeoutMs })
        : execution.executeSupervisedCommand({ command: process.execPath, args: ["-e", script], ...options });
      assert.equal(result.status, 0);
      assert.equal(result.error, undefined);
      assert.equal(fstatSync(descriptor).size, nodeCompatible ? 8192 : 16384);
      assert.equal(result.stdout, null);
    }
    assert.equal(readFileSync(output).length, 16384);
  } finally { closeSync(descriptor); }
});

const lifecycleCases = [
  { name: "success", script: "process.exit(0)", exitCode: 0, signal: null, spawnError: null },
  { name: "exit23", script: "process.exit(23)", exitCode: 23, signal: null, spawnError: null },
  { name: "signal", script: "process.kill(process.pid, 'SIGTERM')", exitCode: null, signal: "SIGTERM", spawnError: null },
  { name: "timeout", script: "setInterval(() => {}, 1000)", exitCode: null, signal: "SIGTERM", spawnError: "ETIMEDOUT" },
  { name: "spawn error", exitCode: null, signal: null, spawnError: "ENOENT" },
];

function assertObserved(entry, expected) {
  assert.equal(entry.exitCode, expected.exitCode);
  assert.equal(entry.signal, expected.signal);
  assert.equal(entry.spawnError, expected.spawnError);
  assert.equal(entry.timedOut, expected.spawnError === "ETIMEDOUT");
  assert.equal(entry.processesQuiescent, true);
  assert.equal(entry.status, "failed");
}

for (const fault of [
  { name: "close before", close: "before" },
  { name: "close after consumption and reuse", close: "after" },
  { name: "cleanup npmrc open", cleanup: true },
  { name: "cleanup plus close", cleanup: true, close: "before" },
]) {
  for (const expected of lifecycleCases.filter((entry) => fault.cleanup || entry.script?.includes("process.exit"))) {
    test(`invocation finalization ${fault.name}: evidence preserves ${expected.name}`, (context) => {
      const value = fixture(context);
      const injection = invocationFault(fault);
      try {
        let failure;
        try {
          value.recorder.run("test", "command", expected.script ? process.execPath : join(value.root, "missing"),
            expected.script ? ["-e", "process.stdout.write('out'); process.stderr.write('err'); " + expected.script] : [],
            { cwd: value.root, env: {}, timeout: expected.name === "timeout" ? 300 : 5000 });
        } catch (error) { failure = error; }
        assert.equal(injection.failures.length, fault.cleanup && fault.close ? 2 : 1);
        injection.assertCloses();
        const [entry] = value.recorder.document.commands;
        context.diagnostic(`observed exit=${entry.exitCode} quiescent=${entry.processesQuiescent} status=${entry.status}; all owned closes attempted once`);
        assertObserved(entry, expected);
        assert.ok(failure, "cleanup failure must reject even a successful command");
        assert.equal(failure.message, "ROLLBACK_COMMAND_FINALIZATION_FAILED");
        for (const error of injection.failures) { assert.ok(containsFailure(failure, error)); }
        if (expected.name !== "success") {
          assert.equal(failure.cause, failure.errors[0]);
          assert.match(failure.cause.message, /ROLLBACK_COMMAND_FAILED/u);
          assert.match(failure.cause.message, new RegExp(`status=${expected.exitCode}`, "u"));
        }
        if (fault.cleanup && fault.close) {
          const finalization = failure.errors[expected.name === "success" ? 0 : 1];
          assert.equal(finalization.errors[0].cause, injection.failures[0], "cleanup failure precedes close failure");
          assert.equal(finalization.errors[1], injection.failures[1]);
        }
        assert.equal(value.recorder.processesQuiescent, true, "filesystem uncertainty cannot erase proven quiescence");
        const persisted = JSON.parse(readFileSync(join(value.root, "diagnostics.json"), "utf8"));
        assertObserved(persisted.commands[0], expected);
        const out = expected.script ? "out" : "";
        const err = expected.script ? "err" : "";
        assert.equal(readFileSync(join(value.root, entry.stdout.path), "utf8"), out);
        assert.equal(readFileSync(join(value.root, entry.stderr.path), "utf8"), err);
        assert.equal(entry.stdout.sha256, createHash("sha256").update(out).digest("hex"));
        assert.equal(entry.stderr.sha256, createHash("sha256").update(err).digest("hex"));
        assert.equal(existsSync(injection.root), Boolean(fault.cleanup), "retain uncertain filesystem custody");
      } finally { injection.release(); }
    });
  }
}

test("invocation finalization preserves shared capture bytes and observed result", (context) => {
  const value = fixture(context);
  const injection = invocationFault({ cleanup: true, close: "after" });
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  try {
    assert.throws(() => execution.executeSupervisedCommand({
      command: process.execPath,
      args: ["-e", "const b=require('node:fs').readFileSync(0); process.stdout.write(b); process.stderr.write(b); process.exit(23)"],
      cwd: value.root, env: {}, input: bytes, encoding: null, timeoutMs: 5000,
    }), (error) => {
      assert.equal(error.result.status, 23);
      assert.equal(error.result.signal, null);
      assert.equal(error.result.error, undefined);
      assert.equal(error.result.targetStatus.quiescent, true);
      assert.deepEqual(error.result.stdout, bytes);
      assert.deepEqual(error.result.stderr, bytes);
      assert.ok(containsFailure(error, injection.failures[0]));
      assert.ok(containsFailure(error, injection.failures[1]));
      return true;
    });
    injection.assertCloses();
  } finally { injection.release(); }
});

test("invocation finalization orders command, invocation, log close and reporting failures", (context) => {
  const value = fixture(context);
  const reporting = new Error("injected reporting failure");
  value.recorder.flush = () => { throw reporting; };
  const injection = invocationFault({ cleanup: true, close: "before" });
  const logClose = injectedUncertainClose(0);
  try {
    assert.throws(() => run("evidence", value,
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(23)", { timeout: 5000 }), (error) => {
      assert.equal(error.message, "ROLLBACK_COMMAND_FINALIZATION_FAILED");
      assert.equal(error.errors.length, 4);
      assert.equal(error.cause, error.errors[0]);
      assert.match(error.cause.message, /ROLLBACK_COMMAND_FAILED.*status=23/u);
      assert.match(error.cause.message, /out\nerr/u);
      assert.equal(error.errors[1].errors[0].cause, injection.failures[0]);
      assert.equal(error.errors[1].errors[1], injection.failures[1]);
      assert.equal(error.errors[2].code, "EINTR");
      assert.equal(error.errors[3], reporting);
      return true;
    });
    injection.assertCloses();
    assert.equal(logClose.calls.length, 2, "both log closes attempted once despite invocation failures");
    assert.equal(new Set(logClose.calls).size, 2);
    assert.ok(fstatSync(logClose.reusedDescriptor()).isCharacterDevice());
    assert.throws(() => fstatSync(logClose.calls[1]), { code: "EBADF" });
    assertObserved(value.recorder.document.commands[0], lifecycleCases[1]);
  } finally {
    logClose.restore();
    injection.release();
    closeSync(logClose.reusedDescriptor());
  }
});

for (const consumer of ["verified file", "opened node"]) {
  for (const fault of [{ cleanup: true }, { close: "before" }, { close: "after" }]) {
    test(`invocation finalization ${consumer} rejects ${JSON.stringify(fault)}`, (context) => {
      const value = fixture(context);
      const script = join(value.root, "tool");
      writeFileSync(script, consumer === "verified file" ? "#!/bin/sh\nprintf verified\n" : "process.stdout.write('verified')",
        { mode: 0o700 });
      const scriptHash = digest(script);
      const nodeHash = digest(process.execPath);
      const injection = invocationFault(fault);
      try {
        assert.throws(() => consumer === "verified file"
          ? execution.executeVerifiedFile({ path: script, expectedSha256: scriptHash })
          : execution.executeOpenedNode({ node: { path: process.execPath, sha256: nodeHash },
            script: { path: script, sha256: scriptHash }, args: [], timeoutMs: 5000 }), (error) => {
          assert.ok(containsFailure(error, injection.failures[0]));
          return true;
        });
        injection.assertCloses();
        assert.equal(existsSync(injection.root), Boolean(fault.cleanup));
      } finally { injection.release(); }
    });
  }
}

// Observed failure: real EMFILE on npm-globalrc left npmrc open with no close
// attempt while the actual EvidenceRecorder correctly rejected before launch.
test("partial acquisition EMFILE releases the real EvidenceRecorder invocation FD", {
  skip: process.platform !== "linux",
}, (context) => {
  const value = fixture(context);
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { EvidenceRecorder } from ${JSON.stringify(new URL("../rollback/runtime/evidence.mjs", import.meta.url).href)};
    import { basicRun, captureGitStatusSnapshot } from ${JSON.stringify(new URL("../rollback/runtime/candidate.mjs", import.meta.url).href)};
    import { invocationFault } from ${JSON.stringify(new URL("./toolchain-invocation-fault-fixture.mjs", import.meta.url).href)};
    const root = process.argv[1];
    const recorder = new EvidenceRecorder(root, {});
    const injection = invocationFault({ exhaust: true });
    const originalSpawn = childProcess.spawnSync;
    let launches = 0;
    childProcess.spawnSync = (...args) => { launches++; return originalSpawn(...args); };
    syncBuiltinESMExports();
    try {
      let failure;
      try {
        recorder.run('test', 'emfile', process.execPath,
          ['-e', 'require("node:fs").writeFileSync(' + JSON.stringify(root + '/launched') + ', "child")'],
          { env: {}, timeout: 5000 });
      } catch (error) { failure = error; }
      assert.equal(failure.cause.code, 'EMFILE');
      assert.ok(failure.cause.path.endsWith('/npm-globalrc'));
      assert.equal(injection.files.length, 1);
      injection.assertCloses();
      assert.equal(launches, 0);
      assert.equal(recorder.document.commands[0].status, 'failed');
      assert.equal(recorder.processesQuiescent, true, 'failed prelaunch acquisition created no process');
      assert.equal(recorder.document.commands[0].processesQuiescent, true);
      recorder.finalize('failed', failure);
    } finally {
      childProcess.spawnSync = originalSpawn;
      syncBuiltinESMExports();
      injection.release();
    }
    assert.equal(fs.existsSync(root + '/launched'), false);
    assert.equal(fs.existsSync(root + '/READY'), false);
    const [entry] = JSON.parse(fs.readFileSync(root + '/diagnostics.json', 'utf8')).commands;
    assert.equal(entry.status, 'failed');
    assert.equal(JSON.parse(fs.readFileSync(root + '/diagnostics.json', 'utf8')).status, 'failed');
    assert.equal(entry.processesQuiescent, true);
    assert.equal(entry.spawnError, 'EMFILE');
    assert.equal(entry.exitCode, null);
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(entry[stream].byteLength, 0);
      assert.equal(fs.readFileSync(root + '/' + entry[stream].path).length, 0);
    }
    for (const consumer of ['text', 'buffer']) {
      const fault = invocationFault({ exhaust: true });
      try {
        assert.throws(() => consumer === 'text'
          ? basicRun(process.execPath, ['-e', 'process.exit(0)'], { env: {}, cwd: root })
          : captureGitStatusSnapshot(root), error => {
            assert.match(error.message, /ROLLBACK_COMMAND_FAILED command=.*status=unknown/su);
            assert.equal(error.cause.code, 'EMFILE');
            assert.equal(error.cause.execution.launched, false);
            assert.equal(Object.hasOwn(error, 'result'), false, 'no result was observed');
            return true;
          });
        fault.assertCloses();
      } finally { fault.release(); }
    }
    console.log('real EMFILE; npmrc EBADF; one close per invocation; zero launches; failed evidence; empty logs; text/buffer boundaries without invented result');
  `;
  const result = spawnSync("/bin/bash", ["-c", 'ulimit -n 128; exec "$@"', "emfile-test",
    process.execPath, "--input-type=module", "-e", program, value.root], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  context.diagnostic(result.stdout.trim());
});
