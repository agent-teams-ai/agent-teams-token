import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { EvidenceRecorder } from "../runtime/evidence.mjs";

const nativeSource = fileURLToPath(new URL("../runtime/subreaper.c", import.meta.url));
const compiler = "/usr/bin/x86_64-linux-gnu-gcc-13";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = {
  source: "7956cad529929cbdb14f0831c872449fa0f94088bdcd178f29fe96aa00ab16c0",
  compiler: "1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26",
  executable: "032c6386f941f677b054e4fcc2c296881d0dcff127928e1971d64af61f449deb",
};

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
  const built = spawnSync(compiler, ["-std=c11", "-O2", "-o", script, source], {encoding: "utf8"});
  assert.equal(built.status, 0, built.stderr);
  return { root, script };
}
function live(root, role) {
  const path = join(root, role + ".pid");
  if (!existsSync(path)) return false;
  const pid = Number(readFileSync(path, "utf8"));
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"
    && readlinkSync(`/proc/${pid}/exe`) === join(root, "fork"); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return false; throw error; }
}
function cleanup(root) {
  for (const role of ["root", "middle", "leaf"]) {
    if (live(root, role)) process.kill(Number(readFileSync(join(root, role + ".pid"), "utf8")), "SIGKILL");
  }
  rmSync(root, {recursive: true, force: true});
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
    const compiled = spawnSync(compiler, ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-fno-ident", "-o", output, nativeSource], {encoding: "utf8"});
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.equal(sha(readFileSync(output)), expected.executable);
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
  const built = spawnSync(compiler, ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    "-fno-ident", "-o", output, nativeSource]);
  assert.equal(built.status, 0);
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
    await new Promise((resolve) => launcher.once("close", resolve));
    assert.equal(existsSync(join(root, "leaf.pid")), true);
    const deadline = Date.now() + 3000;
    while ((!existsSync(reportPath) || readFileSync(reportPath, "utf8") === "") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.custody, "reaped");
    assert.equal(report.error.code, "ECANCELLED");
    assert.equal(live(root, "leaf"), false);
  } finally {
    if (existsSync(join(root, "helper.pid"))) {
      const pid = Number(readFileSync(join(root, "helper.pid"), "utf8"));
      try {if (readlinkSync(`/proc/${pid}/exe`) === output) process.kill(pid, "SIGKILL");}
      catch (error) {if (error.code !== "ESRCH" && error.code !== "ENOENT") throw error;}
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
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(live(root, "leaf"), true);
      parent.kill(parentSignal);
      await new Promise((resolve) => parent.once("close", resolve));
      const drainDeadline = Date.now() + 2500;
      while (live(root, "leaf") && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(live(root, "leaf"), false);
    } finally {parent.kill("SIGKILL"); cleanup(root);}
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} drains a live adopted setsid leaf`, {skip: process.platform !== "linux"}, async () => {
    const {root, script} = fixture();
    const output = join(root, "helper");
    const built = spawnSync(compiler, ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-fno-ident", "-o", output, nativeSource]);
    assert.equal(built.status, 0);
    const stdout = openSync(join(root, "stdout.log"), "w");
    const stderr = openSync(join(root, "stderr.log"), "w");
    const helper = spawn(output, ["5000", "5000", "1000", script, "hold", root],
      {cwd: root, stdio: ["ignore", "pipe", "pipe", stdout, stderr]});
    closeSync(stdout);
    closeSync(stderr);
    try {
      const chunks = [];
      helper.stdout.on("data", (chunk) => chunks.push(chunk));
      const deadline = Date.now() + 2000;
      while (!live(root, "leaf") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(live(root, "leaf"), true);
      helper.kill(signal);
      await new Promise((resolve) => helper.once("close", resolve));
      const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(report.custody, "reaped");
      assert.equal(report.error.code, "ECANCELLED");
      assert.equal(live(root, "leaf"), false);
    } finally {helper.kill("SIGKILL"); cleanup(root);}
  });
}
