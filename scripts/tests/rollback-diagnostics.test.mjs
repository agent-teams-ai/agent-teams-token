import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { EvidenceRecorder } from "../rollback/runtime/evidence.mjs";
import * as execution from "../toolchain-execution.mjs";

function fixture(context) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-quiescence-test-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, recorder: new EvidenceRecorder(root, {}) };
}

function run(value, script) {
  return value.recorder.run("test", "command", process.execPath, ["-e", script], {cwd: value.root, env: {}, timeout: 200});
}

function registerInvocationCleanup(context, error) {
  const path = / invocation=(.+)$/u.exec(error.message)?.[1];
  assert.equal(typeof path, "string", "real failure must identify its retained invocation");
  assert.equal(realpathSync(dirname(path)), realpathSync(tmpdir()));
  assert.match(basename(path), /^agtmai-toolchain-exec-[A-Za-z0-9]+$/u);
  const identity = lstatSync(path, { bigint: true });
  assert.equal(identity.isDirectory(), true);
  context.after(() => {
    const current = lstatSync(path, { bigint: true });
    assert.equal(current.isDirectory(), true);
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    rmSync(path, { recursive: true });
    assert.equal(existsSync(path), false);
  });
}

// Launch the real supervisor with a preload that causes an actual filesystem
// exception, or kills it before it can write status. Never fabricate a result.
function supervisorFault(value, source) {
  const preload = join(value.root, "supervisor-fault.mjs");
  writeFileSync(preload, source);
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, options) => original(command,
    args.includes("--agtmai-toolchain-process-supervisor") ? ["--import", preload, ...args] : args, options);
  syncBuiltinESMExports();
  return () => { childProcess.spawnSync = original; syncBuiltinESMExports(); };
}

test("observed deadline survives a real post-timeout inspection exception", {
  skip: process.platform !== "linux" && "fault injects the Linux /proc inspection syscall",
}, (context) => {
  const value = fixture(context);
  const restore = supervisorFault(value, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readdirSync;
    fs.readdirSync = (path, ...args) => original(path === '/proc' ? ${JSON.stringify(join(value.root, "missing-proc"))} : path, ...args);
    syncBuiltinESMExports();
  `);
  try {
    assert.throws(() => run(value,
      "process.stdout.write('out'); process.stderr.write('err'); setInterval(() => {}, 1000)"), (error) => {
      registerInvocationCleanup(context, error.cause);
      assert.match(error.message, /ROLLBACK_COMMAND_FAILED/u);
      assert.equal(error.cause.code, "TOOLCHAIN_PROCESS_GROUP_QUIESCENCE_UNCERTAIN");
      const result = error.cause.result;
      assert.equal(result.targetStatus.timedOut, true);
      assert.equal(result.targetStatus.error, "ENOENT");
      assert.equal(result.targetStatus.signal, "SIGTERM");
      assert.equal(result.targetStatus.quiescent, false);
      return true;
    });
    const [entry] = JSON.parse(readFileSync(join(value.root, "diagnostics.json"), "utf8")).commands;
    assert.equal(entry.timedOut, true);
    assert.equal(entry.spawnError, "ETIMEDOUT");
    assert.equal(entry.processesQuiescent, false);
    assert.equal(value.recorder.processesQuiescent, false);
    assert.equal(entry.status, "failed");
    assert.equal(readFileSync(join(value.root, entry.stdout.path), "utf8"), "out");
    assert.equal(readFileSync(join(value.root, entry.stderr.path), "utf8"), "err");
    assert.equal(existsSync(join(value.root, "READY")), false);
  } finally { restore(); }
});

test("missing supervisor status preserves real signal and bounded captures", (context) => {
  const value = fixture(context);
  const restore = supervisorFault(value,
    "process.stdout.write('startup out'); process.stderr.write('startup err'); process.kill(process.pid, 'SIGKILL');");
  try {
    assert.throws(() => execution.executeSupervisedCommand({
      command: process.execPath, cwd: value.root, env: {}, maxBuffer: 7, timeoutMs: 5000,
    }), (error) => {
      registerInvocationCleanup(context, error);
      assert.equal(error.code, "TOOLCHAIN_PROCESS_GROUP_QUIESCENCE_UNCERTAIN");
      assert.equal(error.result.supervisorStatus.signal, "SIGKILL");
      assert.equal(error.result.supervisorStatus.status, null);
      assert.equal(error.result.targetStatus.quiescent, false);
      assert.equal(error.result.status, null);
      assert.equal(error.result.signal, null);
      assert.equal(error.result.stdout, "startup");
      assert.equal(error.result.stderr, "startup");
      return true;
    });
  } finally { restore(); }
});
