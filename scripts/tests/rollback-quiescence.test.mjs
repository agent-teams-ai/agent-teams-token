import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { basicRun, captureGitStatusSnapshot } from "../rollback/runtime/candidate.mjs";
import { EvidenceRecorder } from "../rollback/runtime/evidence.mjs";
import { captureCleanupTreeSnapshot, createCleanupHandle } from "../rollback/runtime/cleanup.mjs";
import { finalizeRollbackTemporaryParent } from "../rollback/slices/gate-execution.mjs";
import { createRollbackWorkspaceHandle } from "../rollback/slices/workspace-handle.mjs";
import * as execution from "../toolchain-execution.mjs";

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
    assert.match(error.message, /TOOLCHAIN_PROCESS_GROUP_QUIESCENCE_UNCERTAIN/u);
    const invocation = error.message.split("invocation=")[1];
    assert.equal(existsSync(invocation), true);
    context.after(() => rmSync(invocation, { recursive: true, force: true }));
    return true;
  });
  assert.ok(Date.now() - start < 6000, "captured streams held the outer wait open");
});
