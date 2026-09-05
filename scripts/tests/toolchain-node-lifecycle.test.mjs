import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

const childSource = `
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const mode = process.argv[1];
const root = dirname(process.env.HOME);
const event = (event, extra = {}) => console.log(JSON.stringify({ event, ...extra }));
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

function readEvents(stdout) {
  return stdout.trim().split("\n").map((line) => JSON.parse(line));
}

function assertChildReaped(events) {
  const started = events.find(({ event }) => event === "started");
  assert.ok(started, "the real child must start before interruption");
  assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
  return started;
}

function runFiles(value, mode, options = {}) {
  const stdoutPath = join(value.root, mode + ".stdout");
  const stderrPath = join(value.root, mode + ".stderr");
  const stdout = fs.openSync(stdoutPath, "wx", 0o600);
  const stderr = fs.openSync(stderrPath, "wx", 0o600);
  let result;
  const started = performance.now();
  try {
    result = spawnSync(value.wrapper, ["--eval", childSource, mode], {
      cwd: value.root,
      env: { PATH: "/usr/bin:/bin", HTTPS_PROXY: "must-not-reach-child", NODE_OPTIONS: "--invalid-hostile-option" },
      input: "literal stdin\n",
      stdio: ["pipe", stdout, stderr],
      timeout: 10_000,
      ...options,
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  return {
    ...result, durationMs: performance.now() - started,
    events: readEvents(fs.readFileSync(stdoutPath, "utf8")),
    stderr: fs.readFileSync(stderrPath, "utf8"),
  };
}

for (const mode of ["success", "nonzero", "retained", "substituted"]) {
  test(`generated Node wrapper finalizes once after ${mode}`, (context) => {
    const value = fixture(context);
    const result = runFiles(value, mode);
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
  assert.throws(() => runEvidenceLifecycle(evidence,
    () => new EvidenceRecorder(evidence, { mode: "test" }),
    (recorder) => recorder.run("test", "owned-child-timeout", value.wrapper,
      ["--eval", childSource, "ignore"], { cwd: value.root, env: {}, timeout: 1_000 }),
  ), (error) => {
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
  const events = readEvents(fs.readFileSync(join(evidence, entry.stdout.path), "utf8"));
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
