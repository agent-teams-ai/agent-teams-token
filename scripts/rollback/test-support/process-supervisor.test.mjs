import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { EvidenceRecorder } from "../runtime/evidence.mjs";

const nativeSource = fileURLToPath(new URL("../runtime/subreaper.c", import.meta.url));
const compiler = "/usr/bin/x86_64-linux-gnu-gcc-13";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = {
  source: "49d155937ed05346fc0260ce79dcd63f2de41d6463ecba4b8947bdf80249c496",
  compiler: "1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26",
  executable: "ba1e163135594195d1c3233da681436af7de81985f7c7c28bb23e18b9d0c9486",
};

function compileNative(source, output, root, strict = true) {
  assert.equal(sha(readFileSync(compiler)), expected.compiler);
  const flags = strict ? ["-Wall", "-Wextra", "-Werror", "-fno-ident"] : [];
  const built = spawnSync(compiler, ["-B/usr/lib/gcc/x86_64-linux-gnu/13/",
    "-B/usr/bin/x86_64-linux-gnu-", "-std=c11", "-O2", ...flags,
    "-o", output, source], {
    cwd: root, env: {PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC", TMPDIR: root},
    encoding: "utf8", timeout: 30_000,
  });
  assert.ok(built.error === undefined, built.error?.message);
  assert.equal(built.status, 0, built.stderr);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rollback-subreaper-test-"));
  const source = join(root, "fork.c");
  const script = join(root, "fork");
  writeFileSync(source, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
static void marker(const char *root, const char *role) {
  char path[4096]; snprintf(path, sizeof(path), "%s/%s.pid", root, role);
  FILE *file = fopen(path, "w"); if (!file) _exit(91);
  fprintf(file, "%ld", (long)getpid()); fclose(file);
}
int main(int argc, char **argv) {
  if (argc != 3) return 90;
  marker(argv[2], "root");
  if (strcmp(argv[1], "hold-ignore") == 0) signal(SIGTERM, SIG_IGN);
  write(1, "root-out\\n", 9); write(2, "root-err\\n", 9);
  pid_t middle = fork(); if (middle < 0) return 92;
  if (middle == 0) {
    marker(argv[2], "middle");
    if (setsid() < 0) _exit(93);
    pid_t leaf = fork(); if (leaf < 0) _exit(94);
    if (leaf == 0) {
      marker(argv[2], "leaf");
      write(1, "leaf-out\\n", 9); write(2, "leaf-err\\n", 9);
      for (;;) pause();
    }
    _exit(0);
  }
  waitpid(middle, NULL, 0);
  if (strncmp(argv[1], "hold", 4) == 0) for (;;) pause();
  return 0;
}
`);
  compileNative(source, script, root, false);
  return { root, script };
}
function live(root, role) {
  const path = join(root, role + ".pid");
  if (!existsSync(path)) {return false;}
  const pid = Number(readFileSync(path, "utf8"));
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"
    && readlinkSync(`/proc/${pid}/exe`) === join(root, "fork"); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") {return false;} throw error; }
}
function cleanup(root) {
  for (const role of ["root", "middle", "leaf"]) {
    if (live(root, role)) {process.kill(Number(readFileSync(join(root, role + ".pid"), "utf8")), "SIGKILL");}
  }
  rmSync(root, {recursive: true, force: true});
}

function killIfPresent(pid) {
  try {process.kill(pid, "SIGKILL");}
  catch (error) {if (error.code !== "ESRCH") {throw error;}}
}
function killPinnedProcess(pid, executable) {
  try {
    if (readlinkSync(`/proc/${pid}/exe`) === executable) {process.kill(pid, "SIGKILL");}
  } catch (error) {
    if (error.code !== "ESRCH" && error.code !== "ENOENT") {throw error;}
  }
}

// Adversarial NEW TEST: an orphan escapes both the root session and the 50 ms
// /proc ancestry poll before the old supervisor first observes it.
test("double fork setsid leak fails and is reaped without touching unrelated process", {skip: process.platform !== "linux"}, () => {
  const {root, script} = fixture();
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
  try {
    const recorder = new EvidenceRecorder(root, {test: "double-fork"});
    assert.throws(() => recorder.run("test", "double-fork", script,
      ["exit", root], {cwd: root, timeout: 2000}), /ROLLBACK_COMMAND_FAILED/u);
    const command = JSON.parse(readFileSync(join(root, "diagnostics.json"), "utf8")).commands[0];
    assert.equal(command.processCustody, "reaped");
    assert.equal(command.spawnError, "ELEAK");
    assert.match(readFileSync(join(root, command.stdout.path), "utf8"), /leaf-out/u);
    assert.match(readFileSync(join(root, command.stderr.path), "utf8"), /leaf-err/u);
    assert.equal(live(root, "leaf"), false);
    assert.equal(sentinel.exitCode, null);
  } finally { sentinel.kill("SIGKILL"); cleanup(root); }
});

test("clean command retains exact stdout and stderr and ECHILD completion", () => {
  const root = mkdtempSync(join(tmpdir(), "rollback-supervisor-normal-"));
  try {
    const recorder = new EvidenceRecorder(root, {test: "normal"});
    const result = recorder.run("test", "normal", process.execPath,
      ["-e", "process.stdout.write('normal-out'); process.stderr.write('normal-err')"],
      {cwd: root, timeout: 2000});
    assert.equal(result.stdout, "normal-out");
    assert.equal(result.stderr, "normal-err");
    assert.equal(result.entry.processCustody, "completed");
  } finally {rmSync(root, {recursive: true, force: true});}
});

test("helper source, compiler and output match pinned tuple", {skip: process.platform !== "linux"}, () => {
  const root = mkdtempSync(join(tmpdir(), "rollback-build-test-"));
  try {
    assert.equal(sha(readFileSync(nativeSource)), expected.source);
    assert.equal(sha(readFileSync(compiler)), expected.compiler);
    const output = join(root, "helper");
    compileNative(nativeSource, output, root);
    assert.equal(sha(readFileSync(output)), expected.executable);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test("ambient compiler proxy cannot create an unrecorded detached descendant", {skip: process.platform !== "linux"}, () => {
  const root = mkdtempSync(join(tmpdir(), "rollback-compiler-proxy-"));
  const proxy = join(root, "proxy");
  mkdirSync(proxy);
  const marker = join(root, "assembler-ran");
  const childPid = join(root, "escaped.pid");
  const assembler = join(proxy, "as");
  writeFileSync(assembler, `#!/bin/sh\nprintf 'ran' > '${marker}'\nsetsid sleep 30 >/dev/null 2>&1 &\necho $! > '${childPid}'\nexec /usr/bin/x86_64-linux-gnu-as "$@"\n`);
  chmodSync(assembler, 0o700);
  const evidenceModule = new URL("../runtime/evidence.mjs", import.meta.url).href;
  const code = `import {EvidenceRecorder} from ${JSON.stringify(evidenceModule)};
    const recorder = new EvidenceRecorder(process.argv[1], {});
    const result = recorder.run('test', 'proxy', process.execPath,
      ['-e', 'process.stdout.write("ok")'], {cwd: process.argv[1], timeout: 2000, env: {}});
    if (result.entry.processCustody !== 'completed' || result.stdout !== 'ok') process.exitCode = 2;`;
  try {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", code, root], {
      env: {...process.env, COMPILER_PATH: proxy}, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(marker), false, "the assembler proxy ran before native custody");
    assert.equal(existsSync(childPid), false, "the proxy escaped a detached child");
  } finally {
    if (existsSync(childPid)) {
      const pid = Number(readFileSync(childPid, "utf8"));
      killIfPresent(pid);
    }
    rmSync(root, {recursive: true, force: true});
  }
});

test("native ECHILD after command cancellation cannot report completion", {skip: process.platform !== "linux"}, async () => {
  const root = mkdtempSync(join(tmpdir(), "rollback-cancel-race-"));
  const output = join(root, "helper");
  const logs = openSync(join(root, "logs"), "w");
  try {
    compileNative(nativeSource, output, root);
    const helper = spawn(output, ["2000", "5000", "1000", "/bin/sh", "-c", "kill -STOP $PPID; exit 0"],
      {stdio: ["ignore", "pipe", "pipe", logs, logs]});
    const chunks = [];
    helper.stdout.on("data", (chunk) => {chunks.push(chunk);});
    try {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !/^State:\s+T/mu.test(readFileSync(`/proc/${helper.pid}/status`, "utf8"))) {
        await new Promise((resolve) => {setTimeout(resolve, 5);});
      }
      assert.match(readFileSync(`/proc/${helper.pid}/status`, "utf8"), /^State:\s+T/mu);
      await new Promise((resolve) => {setTimeout(resolve, 30);});
      helper.kill("SIGTERM");
      helper.kill("SIGCONT");
      const [exitCode] = await new Promise((resolve) => {helper.once("close", (...args) => {resolve(args);});});
      const reportText = Buffer.concat(chunks).toString("utf8");
      assert.equal(exitCode, 0, reportText);
      const report = JSON.parse(reportText);
      assert.notEqual(report.custody, "completed", reportText);
      assert.equal(report.error.code, "ECANCELLED");
    } finally {helper.kill("SIGKILL");}
  } finally {closeSync(logs); rmSync(root, {recursive: true, force: true});}
});

test("native ECHILD after deadline cannot report completion", {skip: process.platform !== "linux"}, async () => {
  const root = mkdtempSync(join(tmpdir(), "rollback-deadline-race-"));
  const output = join(root, "helper");
  const logs = openSync(join(root, "logs"), "w");
  try {
    compileNative(nativeSource, output, root);
    const helper = spawn(output, ["1000", "5000", "1000", "/bin/sh", "-c", "kill -STOP $PPID; exit 0"],
      {stdio: ["ignore", "pipe", "pipe", logs, logs]});
    const chunks = [];
    helper.stdout.on("data", (chunk) => {chunks.push(chunk);});
    try {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !/^State:\s+T/mu.test(readFileSync(`/proc/${helper.pid}/status`, "utf8"))) {
        await new Promise((resolve) => {setTimeout(resolve, 5);});
      }
      assert.match(readFileSync(`/proc/${helper.pid}/status`, "utf8"), /^State:\s+T/mu);
      await new Promise((resolve) => {setTimeout(resolve, 1200);});
      helper.kill("SIGCONT");
      const [exitCode] = await new Promise((resolve) => {helper.once("close", (...args) => {resolve(args);});});
      const reportText = Buffer.concat(chunks).toString("utf8");
      assert.equal(exitCode, 0, reportText);
      const report = JSON.parse(reportText);
      assert.notEqual(report.custody, "completed", reportText);
      assert.equal(report.error.code, "ETIMEDOUT");
    } finally {helper.kill("SIGKILL");}
  } finally {closeSync(logs); rmSync(root, {recursive: true, force: true});}
});

test("native ECHILD after parent death cannot report completion", {skip: process.platform !== "linux"}, async () => {
  const root = mkdtempSync(join(tmpdir(), "rollback-parent-race-"));
  const output = join(root, "helper");
  const reportPath = join(root, "report.json");
  const helperPidPath = join(root, "helper.pid");
  try {
    compileNative(nativeSource, output, root);
    const code = `const {spawn} = require('node:child_process');
      const {openSync,readFileSync,writeFileSync} = require('node:fs');
      const [helper,root,report,pidPath] = process.argv.slice(1);
      const result = openSync(report,'w');
      const logs = openSync(root+'/logs','w');
      const child = spawn(helper,['2000','5000','1000','/bin/sh','-c','kill -STOP $PPID; exit 0'],
        {stdio:['ignore',result,logs,logs,logs]});
      writeFileSync(pidPath,String(child.pid));
      const deadline = Date.now()+2000;
      const timer = setInterval(() => {
        if (/^State:\\s+T/m.test(readFileSync('/proc/'+child.pid+'/status','utf8'))) {
          clearInterval(timer); setTimeout(() => process.exit(0),30);
        } else if (Date.now()>deadline) process.exit(2);
      },5);`;
    const launcher = spawn(process.execPath, ["-e", code, output, root, reportPath, helperPidPath], {stdio: "ignore"});
    const [launcherCode] = await new Promise((resolve) => {launcher.once("close", (...args) => {resolve(args);});});
    assert.equal(launcherCode, 0);
    const helperPid = Number(readFileSync(helperPidPath, "utf8"));
    try {
      process.kill(helperPid, "SIGCONT");
      const deadline = Date.now() + 2000;
      while (readFileSync(reportPath, "utf8") === "" && Date.now() < deadline) {
        await new Promise((resolve) => {setTimeout(resolve, 5);});
      }
      const reportText = readFileSync(reportPath, "utf8");
      const report = JSON.parse(reportText);
      assert.notEqual(report.custody, "completed", reportText);
      assert.equal(report.error.code, "ECANCELLED");
    } finally {
      killPinnedProcess(helperPid, output);
    }
  } finally {rmSync(root, {recursive: true, force: true});}
});

test("timeout escalates TERM to KILL and proves ECHILD", {skip: process.platform !== "linux"}, () => {
  const {root, script} = fixture();
  try {
    const recorder = new EvidenceRecorder(root, {test: "timeout"});
    const started = Date.now();
    assert.throws(() => recorder.run("test", "timeout", script,
      ["hold-ignore", root], {cwd: root, timeout: 100}), /ROLLBACK_COMMAND_FAILED/u);
    const command = JSON.parse(readFileSync(join(root, "diagnostics.json"), "utf8")).commands[0];
    assert.equal(command.processCustody, "reaped");
    assert.equal(command.spawnError, "ETIMEDOUT");
    assert.equal(command.signal, "SIGKILL");
    assert.equal(command.timedOut, true);
    assert.equal(live(root, "root"), false);
    assert.equal(live(root, "leaf"), false);
    assert.ok(Date.now() - started < 5000);
  } finally {cleanup(root);}
});

test("aborted Docker gate with no exact container ID stays uncertain", {skip: process.platform !== "linux"}, () => {
  const {root, script} = fixture();
  try {
    const recorder = new EvidenceRecorder(root, {test: "docker-unknown"});
    assert.throws(() => recorder.run("test", "slither-real-analyzer", script,
      ["hold", root], {cwd: root, timeout: 100}), /ROLLBACK_COMMAND_FAILED/u);
    const command = JSON.parse(readFileSync(join(root, "diagnostics.json"), "utf8")).commands[0];
    assert.equal(command.processCustody, "uncertain");
    assert.equal(command.processUncertainty, "ROLLBACK_DOCKER_EXACT_ID_SETTLEMENT_UNPROVEN");
    assert.equal(command.spawnError, "ETIMEDOUT");
    assert.equal(live(root, "leaf"), false);
  } finally {cleanup(root);}
});

test("parent death triggers native cancellation and adopted-child drain", {skip: process.platform !== "linux"}, async () => {
  const {root, script} = fixture();
  const output = join(root, "helper");
  compileNative(nativeSource, output, root);
  const reportPath = join(root, "report.json");
  const launcherCode = `
const {spawn} = require('node:child_process');
const {openSync,writeFileSync,existsSync} = require('node:fs');
const [helper,script,root,report] = process.argv.slice(1);
const protocol = openSync(report,'w');
const logs = openSync(root+'/logs','w');
const child = spawn(helper,['5000','5000','1000',script,'hold',root],
  {stdio:['ignore',protocol,logs,logs,logs]});
writeFileSync(root+'/helper.pid',String(child.pid));
const timer = setInterval(() => {
  if (existsSync(root+'/leaf.pid')) {clearInterval(timer);process.exit(0);}
},10);
`;
  const launcher = spawn(process.execPath, ["-e", launcherCode, output, script, root, reportPath], {stdio: "ignore"});
  try {
    await new Promise((resolve) => {launcher.once("close", resolve);});
    assert.equal(existsSync(join(root, "leaf.pid")), true);
    const deadline = Date.now() + 3000;
    while ((!existsSync(reportPath) || readFileSync(reportPath, "utf8") === "") && Date.now() < deadline) {
      await new Promise((resolve) => {setTimeout(resolve, 10);});
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.custody, "reaped");
    assert.equal(report.error.code, "ECANCELLED");
    assert.equal(live(root, "leaf"), false);
  } finally {
    if (existsSync(join(root, "helper.pid"))) {
      const pid = Number(readFileSync(join(root, "helper.pid"), "utf8"));
      killPinnedProcess(pid, output);
    }
    cleanup(root);
  }
});

for (const parentSignal of ["SIGINT", "SIGTERM"]) {
  test(`${parentSignal} of synchronous evidence parent still drains its detached descendants`, {skip: process.platform !== "linux"}, async () => {
    const {root, script} = fixture();
    const evidenceModule = new URL("../runtime/evidence.mjs", import.meta.url).href;
    const code = `import {EvidenceRecorder} from ${JSON.stringify(evidenceModule)};
    const recorder = new EvidenceRecorder(process.argv[1], {});
    recorder.run('test', 'parent-signal', process.argv[2], ['hold-ignore', process.argv[1]],
      {cwd: process.argv[1], timeout: 4000});`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", code, root, script],
      {stdio: "ignore"});
    try {
      const deadline = Date.now() + 2000;
      while (!live(root, "leaf") && Date.now() < deadline) {
        await new Promise((resolve) => {setTimeout(resolve, 10);});
      }
      assert.equal(live(root, "leaf"), true);
      parent.kill(parentSignal);
      await new Promise((resolve) => {parent.once("close", resolve);});
      const drainDeadline = Date.now() + 2500;
      while (live(root, "leaf") && Date.now() < drainDeadline) {
        await new Promise((resolve) => {setTimeout(resolve, 10);});
      }
      assert.equal(live(root, "leaf"), false);
    } finally {parent.kill("SIGKILL"); cleanup(root);}
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} drains a live adopted setsid leaf`, {skip: process.platform !== "linux"}, async () => {
    const {root, script} = fixture();
    const output = join(root, "helper");
    compileNative(nativeSource, output, root);
    const stdout = openSync(join(root, "stdout.log"), "w");
    const stderr = openSync(join(root, "stderr.log"), "w");
    const helper = spawn(output, ["5000", "5000", "1000", script, "hold", root],
      {cwd: root, stdio: ["ignore", "pipe", "pipe", stdout, stderr]});
    closeSync(stdout);
    closeSync(stderr);
    try {
      const chunks = [];
      helper.stdout.on("data", (chunk) => {chunks.push(chunk);});
      const deadline = Date.now() + 2000;
      while (!live(root, "leaf") && Date.now() < deadline) {
        await new Promise((resolve) => {setTimeout(resolve, 10);});
      }
      assert.equal(live(root, "leaf"), true);
      helper.kill(signal);
      await new Promise((resolve) => {helper.once("close", resolve);});
      const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(report.custody, "reaped");
      assert.equal(report.error.code, "ECANCELLED");
      assert.equal(live(root, "leaf"), false);
    } finally {helper.kill("SIGKILL"); cleanup(root);}
  });
}
