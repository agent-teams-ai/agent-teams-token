import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateCandidateStructure } from "../rollback/slices/proof-slice.mjs";
import { EvidenceRecorder, runEvidenceLifecycle } from "../rollback/runtime/evidence.mjs";
import { fetchArtifacts, installArtifacts } from "../toolchain.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";

function fixture(context) {
  // Tiny existing archive fixtures, no dependency install or full Node archive
  // compression. Their Node entrypoint execs the actual test runtime; both
  // wrappers below are produced by the real installation code, without edits.
  const value = makeFixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const args = { ...value, platform, offline: true };
  fetchArtifacts(args);
  installArtifacts(args);
  return { ...value, wrapper: join(value.toolsRoot, "bin/node") };
}

test("generated Node wrapper preserves only the explicit Safe qualification inputs", (context) => {
  const value = fixture(context);
  const safeInputs = {
    AGTMAI_SAFE_ARTIFACT_DIRECTORY: join(value.root, "Safe artifacts 'quoted' $directory"),
    AGTMAI_SAFE_PINS_SHA256: `0x${"ab".repeat(32)}`,
  };
  const unrelated = {
    AGTMAI_SAFE_UNRELATED: "must-not-reach-child",
    UNRELATED_VARIABLE: "must-not-reach-child",
    NODE_OPTIONS: "--invalid-hostile-option",
    HTTPS_PROXY: "http://sentinel.invalid/",
  };
  const keys = [...Object.keys(safeInputs), ...Object.keys(unrelated)];
  const source = `process.stdout.write(JSON.stringify(Object.fromEntries(
    ${JSON.stringify(keys)}.map(key => [key, process.env[key]])
  )))`;
  for (const inputs of [safeInputs, {}]) {
    const result = spawnSync(value.wrapper, ["--eval", source], {
      cwd: value.root,
      env: { ...inputs, ...unrelated },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), inputs);
  }
});

// Fixture records contain seven temporary paths; 16 KiB deliberately fails closed
// on oversized environments. FD 1 is borrowed, never reopened or closed here.
function createEventWriter(write) {
  let failure;
  return (event, extra = {}) => {
    if (failure) { throw failure; }
    try {
      const record = Buffer.from(JSON.stringify({ event, ...extra }) + "\n", "utf8");
      if (record.length > 16_384) { throw new Error("event record exceeds 16384 bytes"); }
      let offset = 0;
      let interruptions = 0;
      while (offset < record.length) {
        let count;
        try {
          count = write(1, record, offset, record.length - offset);
        } catch (error) {
          if (error.code === "EINTR" && interruptions++ < 8) { continue; }
          throw error;
        }
        if (!Number.isInteger(count) || count <= 0 || count > record.length - offset) {
          throw new Error("invalid event write progress: " + count);
        }
        offset += count;
      }
    } catch (error) {
      failure = error;
      throw error;
    }
  };
}

// Disarm before closing: close failure must neither retry that FD nor skip peers.
function withLogDescriptors(paths, action, io = fs) {
  const owned = [];
  const errors = [];
  let result;
  try {
    for (const path of paths) { owned.push(io.openSync(path, "wx", 0o600)); }
    result = action(owned);
  } catch (error) {
    errors.push(error);
  } finally {
    while (owned.length) {
      const fd = owned.shift();
      try { io.closeSync(fd); } catch (error) { errors.push(error); }
    }
  }
  return { result, errors };
}

function rawDescription(bytes) {
  return { byteLength: bytes.length, escaped: JSON.stringify(bytes.subarray(0, 2048).toString("latin1")), truncated: bytes.length > 2048 };
}

function readEvents(stdout) {
  const bytes = Buffer.from(stdout);
  const events = [];
  let offset = 0;
  try {
    if (!bytes.length) { throw new Error("empty evidence"); }
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) { throw new Error("incomplete event record (including SIGKILL-interrupted emission)"); }
      const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
      const record = JSON.parse(line);
      if (!record || typeof record.event !== "string") { throw new Error("invalid event record"); }
      events.push(record);
      offset = end + 1;
    }
    return events;
  } catch (cause) {
    throw new Error("event evidence " + JSON.stringify({ offset, ...rawDescription(bytes) }), { cause });
  }
}

function assertSequence(events, signal) {
  assert.deepEqual(events.map(({ event }) => event), signal ? ["started", "signal"] : ["started", "completed"]);
  if (signal) { assert.deepEqual(events[1], { event: "signal", signal, privateExists: true }); }
}

function captureEvidence(result, durationMs, stdout, stderr, errors = []) {
  errors = [...errors];
  const diagnostic = JSON.stringify({
    status: result?.status, signal: result?.signal, durationMs,
    processError: result?.error && { message: result.error.message, code: result.error.code, stack: result.error.stack },
    errors: errors.map(error => ({ message: error.message, code: error.code, stack: error.stack })),
    stdout: rawDescription(stdout), stderr: rawDescription(stderr),
  });
  // Emit before parsing or any later assertion/fixture cleanup can hide evidence.
  process.stderr.write("LIFECYCLE_EVIDENCE " + diagnostic + "\n");
  let events;
  try { events = readEvents(stdout); } catch (error) { errors.push(error); }
  if (errors.length) { throw new AggregateError(errors, "lifecycle evidence failed: " + diagnostic); }
  return { ...result, durationMs, events, stdout, stderr: stderr.toString("utf8") };
}

const childSource = `
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const mode = process.argv[1];
const root = dirname(process.env.HOME);
const event = (${createEventWriter.toString()})(fs.writeSync);
if (mode === "ignore" || mode === "exit-zero") {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      event("signal", { signal, privateExists: fs.existsSync(process.env.HOME) });
      if (mode === "exit-zero") { process.exit(0); }
    });
  }
}
event("started", {
  pid: process.pid, root,
  paths: [root, ...["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"].map(key => process.env[key])],
  modes: [root, ...["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"].map(key => process.env[key])].map(path => fs.statSync(path).mode & 0o777),
  hostile: [process.env.HTTPS_PROXY, process.env.NODE_OPTIONS],
});
if (mode === "retained") { fs.writeFileSync(join(process.env.HOME, "output"), "retain-child-output"); }
if (mode === "substituted") {
  fs.renameSync(process.env.HOME, process.env.HOME + ".held");
  fs.mkdirSync(process.env.HOME, { mode: 0o700 });
}
if (mode === "ignore" || mode === "exit-zero") {
  setTimeout(() => event("completed"), 8_000);
} else {
  event("completed", { input: fs.readFileSync(0, "utf8") });
  process.exitCode = mode === "nonzero" ? 23 : 0;
}
`;

function assertChildReaped(events) {
  const started = events.find(({ event }) => event === "started");
  assert.ok(started, "the real child must start before interruption");
  assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
  return started;
}

function runFiles(value, mode, options = {}) {
  const stdoutPath = join(value.root, mode + ".stdout");
  const stderrPath = join(value.root, mode + ".stderr");
  const started = performance.now();
  const { result, errors } = withLogDescriptors([stdoutPath, stderrPath], ([stdout, stderr]) =>
    spawnSync(value.wrapper, ["--eval", childSource, mode], {
      cwd: value.root,
      env: { PATH: "/usr/bin:/bin", HTTPS_PROXY: "must-not-reach-child", NODE_OPTIONS: "--invalid-hostile-option" },
      input: "literal stdin\n",
      stdio: ["pipe", stdout, stderr],
      timeout: 10_000,
      ...options,
    }));
  const durationMs = performance.now() - started;
  const streams = [stdoutPath, stderrPath].map(path => {
    try { return fs.readFileSync(path); } catch (error) { errors.push(error); return Buffer.alloc(0); }
  });
  return captureEvidence(result, durationMs, ...streams, errors);
}

for (const mode of ["success", "nonzero", "retained", "substituted"]) {
  test(`generated Node wrapper finalizes once after ${mode}`, (context) => {
    const value = fixture(context);
    const result = runFiles(value, mode);
    assertSequence(result.events);
    const started = assertChildReaped(result.events);
    context.diagnostic(JSON.stringify({ mode, status: result.status, signal: result.signal, durationMs: result.durationMs }));
    assert.equal(result.error, undefined);
    assert.equal(result.status, { success: 0, nonzero: 23, retained: 1, substituted: 1 }[mode], result.stderr);
    assert.deepEqual(started.modes, Array(7).fill(0o700));
    assert.deepEqual(started.hostile, [null, null]);
    assert.equal(result.events.at(-1).input, "literal stdin\n");
    if (mode === "retained" || mode === "substituted") {
      assert.equal(result.stderr.trim(), "TOOLCHAIN_PRIVATE_ENVIRONMENT_PRESERVED path=" + started.root);
      assert.equal(fs.existsSync(started.root), true);
      if (mode === "retained") {
        assert.equal(fs.readFileSync(join(started.root, "home/output"), "utf8"), "retain-child-output");
        fs.unlinkSync(join(started.root, "home/output"));
      } else {
        assert.equal(fs.existsSync(join(started.root, "home.held")), true);
        fs.rmdirSync(join(started.root, "home.held"));
      }
      // Only the exact empty fixture directories; no recursive private cleanup.
      fs.rmdirSync(join(started.root, "home"));
      fs.rmdirSync(started.root);
    } else {
      assert.equal(result.stderr, "");
      assert.equal(fs.existsSync(started.root), false);
    }
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  for (const mode of ["ignore", "exit-zero"]) {
    test(`generated Node wrapper bounds ${signal} timeout for ${mode} child with real file FDs`, (context) => {
      const value = fixture(context);
      const result = runFiles(value, mode, { timeout: 1_000, killSignal: signal });
      assertSequence(result.events, signal);
      const started = assertChildReaped(result.events);
      context.diagnostic(JSON.stringify({ mode, signal, status: result.status, error: result.error?.code, durationMs: result.durationMs }));
      assert.equal(result.error?.code, "ETIMEDOUT");
      assert.equal(result.status, signal === "SIGTERM" ? 143 : 130, result.stderr);
      assert.equal(result.signal, null);
      assert.ok(result.durationMs < 4_000, "1s command deadline + bounded termination/finalization");
      assert.deepEqual(result.events.filter(({ event }) => event === "signal"), [
        { event: "signal", signal, privateExists: true },
      ]);
      assert.equal(result.events.some(({ event }) => event === "completed"), false);
      assert.equal(result.stderr, "");
      assert.equal(fs.existsSync(started.root), false);
    });
  }
}

test("structural command timeout remains failed with complete logs and no READY", (context) => {
  const value = fixture(context);
  const evidence = join(value.root, "evidence");
  fs.mkdirSync(evidence, { mode: 0o700 });
  let commandError;
  assert.throws(() => runEvidenceLifecycle(evidence,
    () => new EvidenceRecorder(evidence, { mode: "test" }),
    (recorder) => recorder.run("test", "owned-child-timeout", value.wrapper,
      ["--eval", childSource, "ignore"], { cwd: value.root, env: {}, timeout: 1_000 }),
  ), (error) => {
    commandError = error;
    assert.match(error.message, /ROLLBACK_COMMAND_FAILED/u);
    assert.equal(error.cause.code, "ETIMEDOUT");
    return true;
  });
  const document = JSON.parse(fs.readFileSync(join(evidence, "diagnostics.json"), "utf8"));
  assert.equal(document.status, "failed");
  assert.equal(fs.existsSync(join(evidence, "READY")), false);
  assert.equal(document.commands.length, 1);
  const entry = document.commands[0];
  context.diagnostic(JSON.stringify(entry));
  assert.equal(entry.status, "failed");
  assert.equal(entry.timedOut, true);
  assert.equal(entry.spawnError, "ETIMEDOUT");
  assert.equal(entry.exitCode, 143);
  assert.equal(entry.signal, null);
  assert.ok(entry.durationMs < 4_000);
  for (const stream of ["stdout", "stderr"]) {
    const bytes = fs.readFileSync(join(evidence, entry[stream].path));
    assert.equal(bytes.length, entry[stream].byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry[stream].sha256);
  }
  const { events } = captureEvidence({ status: entry.exitCode, signal: entry.signal, error: commandError.cause },
    entry.durationMs, fs.readFileSync(join(evidence, entry.stdout.path)), fs.readFileSync(join(evidence, entry.stderr.path)));
  assertSequence(events, "SIGTERM");
  const started = assertChildReaped(events);
  assert.equal(events.some(({ event }) => event === "completed"), false);
  assert.equal(fs.existsSync(started.root), false);
  assert.equal(entry.stderr.byteLength, 0);
});


test("structural gate budgets the complete suite and propagates command failure before clean-stage success", () => {
  const commandFailure = new Error("stop at command boundary");
  let calls = 0;
  const recorder = {
    run(group, id, command, args, options) {
      calls += 1;
      assert.equal(group, "local-solana");
      assert.equal(id, "rollback-structural-candidate");
      assert.equal(command, "/owned/.tools/bin/node");
      assert.deepEqual(args, ["--test", "scripts/tests/rollback-proof.test.mjs"]);
      assert.equal(options.cwd, "/owned");
      assert.equal(options.phase, "candidate-validation");
      assert.equal(options.timeout, 900_000);
      throw commandFailure;
    },
    stage() { assert.fail("command failure must stop candidate acceptance"); },
  };
  assert.throws(() => validateCandidateStructure({
    candidateSha: "a".repeat(40), checkout: "/owned", group: "local-solana", recorder,
  }, { tools: {
    node: "/owned/.tools/bin/node", pnpm: "/owned/.tools/bin/pnpm",
    forge: "/owned/.tools/foundry/forge", solc: "/owned/.tools/solc/solc",
  } }),
  (error) => error === commandFailure);
  assert.equal(calls, 1);
});

test("event writer completes short writes and EINTR exactly once", () => {
  const chunks = [];
  let calls = 0;
  const emit = createEventWriter((fd, bytes, offset, length) => {
    assert.equal(fd, 1);
    if (++calls <= 2) { throw Object.assign(new Error("interrupted"), { code: "EINTR" }); }
    const count = Math.min(3, length);
    chunks.push(Buffer.from(bytes.subarray(offset, offset + count)));
    return count;
  });
  emit("started", { text: "é" });
  assert.equal(Buffer.concat(chunks).toString(), '{"event":"started","text":"é"}\n');
});

test("event writer terminalizes zero, hard errors, exhausted EINTR and invalid progress", () => {
  for (const outcome of [0, -1, 0.5, NaN, Infinity, undefined, 100_000, "1", "EIO", "EINTR"]) {
    let calls = 0;
    const cause = Object.assign(new Error(String(outcome)), { code: outcome });
    const emit = createEventWriter(() => {
      calls++;
      if (typeof outcome === "string" && outcome !== "1") { throw cause; }
      return outcome;
    });
    let failure;
    assert.throws(() => emit("started"), error => { failure = error; return true; });
    assert.equal(calls, outcome === "EINTR" ? 9 : 1);
    if (outcome === "EIO" || outcome === "EINTR") { assert.equal(failure, cause); }
    const before = calls;
    assert.throws(() => emit("completed"), error => error === failure);
    assert.equal(calls, before);
  }
  let calls = 0;
  const emit = createEventWriter(() => { calls++; });
  assert.throws(() => emit("started", { text: "x".repeat(16_384) }), /exceeds/);
  assert.equal(calls, 0);
});

test("strict evidence rejects empty, partial and invalid sequences", () => {
  for (const bytes of ["", '{"event":', '{"event":"started"}', '\xff\n', '{}\n']) {
    assert.throws(() => readEvents(Buffer.from(bytes, "latin1")), /offset.*byteLength.*escaped/);
  }
  const started = { event: "started" };
  const signal = { event: "signal", signal: "SIGINT", privateExists: true };
  for (const events of [[started], [started, signal, signal], [started, { ...signal, signal: "SIGTERM" }],
    [started, signal, { event: "completed" }], [started, { ...signal, privateExists: false }]]) {
    assert.throws(() => assertSequence(readEvents(events.map(event => JSON.stringify(event) + "\n").join("")), "SIGINT"));
  }
  assertSequence([started, signal], "SIGINT");
});

test("log descriptor failures preserve acquisition, action and every close error", () => {
  for (const failOpen of [0, 1, 2]) {
    const opened = [];
    const closed = [];
    const acquisition = new Error("open failure");
    const action = new Error("process failure");
    const closeErrors = [new Error("close first"), new Error("close second")];
    const outcome = withLogDescriptors(["stdout", "stderr"], () => { throw action; }, {
      openSync() {
        if (opened.length === failOpen) { throw acquisition; }
        const fd = 10 + opened.length;
        opened.push(fd);
        return fd;
      },
      closeSync(fd) { closed.push(fd); throw closeErrors[fd - 10]; },
    });
    assert.deepEqual(closed, opened);
    assert.deepEqual(outcome.errors, [failOpen < 2 ? acquisition : action, ...closeErrors.slice(0, failOpen)]);
  }
  const closed = [];
  const result = withLogDescriptors(["a", "b"], fds => fds.slice(), {
    openSync(path) { return path === "a" ? 0 : 1; }, closeSync(fd) { closed.push(fd); },
  });
  assert.deepEqual(result, { result: [0, 1], errors: [] });
  assert.deepEqual(closed, [0, 1]);
});

// These are manually signalled boundary regressions, NOT spawnSync timeouts.
// The four original timeout tests above retain their pre-readiness 1s deadline.
for (const interrupted of [false, true]) {
  test(`acknowledged startup manual SIGINT; interrupted emission=${interrupted}`, async (context) => {
    const value = fixture(context);
    const source = interrupted ? childSource.replace('(fs.writeSync)', `(function(fd, bytes, offset, length) {
      if (bytes.toString().includes('"event":"signal"')) {
        fs.writeSync(fd, bytes, offset, 9);
        process.kill(process.pid, "SIGKILL");
        throw new Error("SIGKILL failed to interrupt emission");
      }
      return fs.writeSync(fd, bytes, offset, length);
    })`) : childSource;
    const startedAt = performance.now();
    const child = spawn(value.wrapper, ["--eval", source, "exit-zero"], {
      cwd: value.root, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const errors = [];
    let acknowledged = false;
    const deadline = setTimeout(() => {
      errors.push(new Error("acknowledged boundary deadline exceeded"));
      child.kill("SIGTERM");
    }, 1_000);
    child.stdout.on("data", bytes => {
      stdout.push(bytes);
      if (!acknowledged && Buffer.concat(stdout).includes(10)) {
        try {
          const events = readEvents(Buffer.concat(stdout));
          assert.deepEqual(events.map(event => event.event), ["started"]);
          acknowledged = true;
          child.kill("SIGINT");
        } catch (error) { errors.push(error); child.kill("SIGTERM"); }
      }
    });
    child.stderr.on("data", bytes => stderr.push(bytes));
    child.on("error", error => errors.push(error));
    const result = await new Promise(resolve => { child.on("close", (status, signal) => resolve({ status, signal })); });
    clearTimeout(deadline);
    const durationMs = performance.now() - startedAt;
    const raw = Buffer.concat(stdout);
    if (interrupted) {
      assert.throws(() => captureEvidence(result, durationMs, raw, Buffer.concat(stderr), errors), error => {
        assert.ok(error.errors.some(item => item.cause?.message.includes("incomplete event record")));
        return true;
      });
      const started = assertChildReaped(readEvents(raw.subarray(0, raw.indexOf(10) + 1)));
      assert.equal(fs.existsSync(started.root), false);
      assert.equal(Buffer.concat(stderr).length, 0);
    } else {
      const evidence = captureEvidence(result, durationMs, raw, Buffer.concat(stderr), errors);
      assertSequence(evidence.events, "SIGINT");
      const started = assertChildReaped(evidence.events);
      assert.equal(fs.existsSync(started.root), false);
      assert.equal(evidence.stderr, "");
    }
    assert.equal(acknowledged, true);
    assert.equal(result.status, 130);
    assert.equal(result.signal, null);
    assert.ok(durationMs < 4_000);
    assert.deepEqual(errors, []);
  });
}

test("parse failure retains raw streams, process outcome and cleanup causes before removal", () => {
  const cleanup = Object.assign(new Error("close failure"), { code: "EIO" });
  const processError = Object.assign(new Error("deadline"), { code: "ETIMEDOUT" });
  const original = process.stderr.write;
  const diagnostics = [];
  process.stderr.write = value => { diagnostics.push(value); return true; };
  try {
    assert.throws(() => captureEvidence({ status: 130, signal: null, error: processError }, 123,
      Buffer.from('{"event":"started"}\n{"event":'), Buffer.from('stderr\x00detail'), [cleanup]), error => {
      assert.equal(error.errors[0], cleanup);
      assert.match(error.errors[1].message, /"offset":20/);
      for (const text of ['ETIMEDOUT', 'close failure', 'stderr', 'byteLength', '130', '123']) {
        assert.ok(error.message.includes(text), text);
        assert.ok(diagnostics[0].includes(text), text);
      }
      assert.equal(diagnostics.length, 1);
      return true;
    });
    assert.equal(rawDescription(Buffer.alloc(3000)).escaped.length, 12_290);
    assert.equal(rawDescription(Buffer.alloc(3000)).truncated, true);
  } finally { process.stderr.write = original; }
});
