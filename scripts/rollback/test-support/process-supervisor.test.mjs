import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EvidenceRecorder } from "../runtime/evidence.mjs";
import { superviseCommand } from "../runtime/process-supervisor.mjs";

const fakeProgram = `
const { spawn } = require('node:child_process');
const { writeFileSync, readFileSync } = require('node:fs');
const role = process.argv[2], root = process.argv[3];
const stat = readFileSync('/proc/' + process.pid + '/stat', 'utf8');
writeFileSync(root + '/' + role + '.pid', process.pid + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
process.stdout.write(role + '-out\\n');
process.stderr.write(role + '-err\\n');
if (role === 'wrapper') spawn(process.execPath, [__filename, 'child', root], { stdio: 'inherit' });
if (role === 'child') spawn(process.execPath, [__filename, 'grandchild', root], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`;

function aliveExact(root, role) {
  const marker = join(root, role + ".pid");
  if (!existsSync(marker)) {return false;}
  const [pid, identity] = readFileSync(marker, "utf8").split(":");
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] === identity && fields[0] !== "Z";
  } catch (error) {
    if (error.code === "ENOENT") {return false;}
    throw error;
  }
}

test("normal command preserves stdout and stderr custody", () => {
  const root = mkdtempSync(join(tmpdir(), "rollback-supervisor-normal-"));
  try {
    const recorder = new EvidenceRecorder(root, { test: "normal" });
    const result = recorder.run("test", "normal", process.execPath,
      ["-e", "process.stdout.write('normal-out'); process.stderr.write('normal-err')"],
      { cwd: root, timeout: 2_000 });
    assert.equal(result.stdout, "normal-out");
    assert.equal(result.stderr, "normal-err");
    assert.equal(result.entry.processCustody, "completed");
    assert.equal(result.entry.status, "passed");
  } finally {rmSync(root, { recursive: true, force: true });}
});

test("timeout reaps wrapper descendants and leaves unrelated process alone", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "rollback-supervisor-timeout-"));
  const script = join(root, "fake-process.cjs");
  writeFileSync(script, fakeProgram);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const recorder = new EvidenceRecorder(root, { test: "timeout" });
    assert.throws(() => recorder.run("test", "tree", process.execPath,
      [script, "wrapper", root], { cwd: root, timeout: 600 }), /ROLLBACK_COMMAND_FAILED/u);
    const command = JSON.parse(readFileSync(join(root, "diagnostics.json"), "utf8")).commands[0];
    assert.equal(command.timedOut, true);
    assert.equal(command.processCustody, "reaped");
    assert.equal(command.processUncertainty, null);
    assert.match(readFileSync(join(root, command.stdout.path), "utf8"), /grandchild-out/u);
    assert.match(readFileSync(join(root, command.stderr.path), "utf8"), /grandchild-err/u);
    for (const role of ["wrapper", "child", "grandchild"]) {
      assert.equal(existsSync(join(root, role + ".pid")), true, role);
      assert.equal(aliveExact(root, role), false, role);
    }
    assert.equal(unrelated.exitCode, null);
  } finally {
    for (const role of ["wrapper", "child", "grandchild"]) {
      if (aliveExact(root, role)) {
        const pid = Number(readFileSync(join(root, role + ".pid"), "utf8").split(":")[0]);
        process.kill(pid, "SIGKILL");
      }
    }
    unrelated.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("unconfirmed process observation fails closed without signalling guessed descendants", async () => {
  const child = new EventEmitter();
  child.pid = 9001;
  child.kill = () => {child.emit("exit", null, "SIGTERM"); return true;};
  let tick = 0;
  const signalled = [];
  const result = await superviseCommand({ command: "fake", arguments: [], timeout: 1 }, {
    supported: false,
    spawn: () => child,
    kill: (pid) => signalled.push(pid),
    now: () => tick,
    wait: async (ms) => {tick += ms;},
  });
  assert.equal(result.custody, "uncertain");
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.match(result.uncertainty, /ROLLBACK_PROCESS_PLATFORM_UNSUPPORTED/u);
  assert.deepEqual(signalled, []);
});

test("unconfirmed reaping reports uncertainty and signals only an exact observed identity", async () => {
  const child = new EventEmitter();
  child.pid = 9001;
  let tick = 0;
  const signalled = [];
  const result = await superviseCommand({ command: "fake", arguments: [], timeout: 1 }, {
    supported: true,
    spawn: () => child,
    list: () => [
      { pid: 9001, ppid: 1, group: 9001, session: 9001, identity: "start-a", state: "S" },
      { pid: 9002, ppid: 1, group: 9002, session: 9002, identity: "start-b", state: "S" },
    ],
    kill: (pid, sig) => signalled.push([pid, sig]),
    now: () => tick,
    wait: async (ms) => {tick += ms;},
  });
  assert.equal(result.custody, "uncertain");
  assert.equal(result.uncertainty, "ROLLBACK_PROCESS_REAP_UNCONFIRMED");
  assert.deepEqual(result.ownedPids, [9001]);
  assert.equal(signalled.every(([pid]) => pid === 9001), true);
  assert.equal(signalled.some(([, sig]) => sig === "SIGKILL"), true);
});
