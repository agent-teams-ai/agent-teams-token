import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceRecorder } from "../runtime/evidence.mjs";

function runAnalyzerExit(code) {
  const directory = mkdtempSync(join(tmpdir(), "rollback-docker-custody-"));
  try {
    const recorder = new EvidenceRecorder(directory, { test: "docker-custody" });
    let failure;
    try {
      recorder.run("test", "slither-real-analyzer", process.execPath,
        ["-e", code], { cwd: directory, timeout: 2000 });
    } catch (error) {
      failure = error;
    }
    const entry = JSON.parse(readFileSync(join(directory, "diagnostics.json"), "utf8")).commands[0];
    return { entry, failure };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("direct SIGKILL of analyzer remains uncertain after ECHILD", { skip: process.platform !== "linux" }, () => {
  const { entry, failure } = runAnalyzerExit("process.kill(process.pid, 'SIGKILL')");
  assert.match(failure?.message ?? "", /ROLLBACK_COMMAND_FAILED/u);
  assert.equal(entry.exitCode, null);
  assert.equal(entry.signal, "SIGKILL");
  assert.equal(entry.timedOut, false);
  assert.equal(entry.spawnError, null);
  assert.equal(entry.status, "failed");
  assert.equal(entry.processCustody, "uncertain");
  assert.equal(entry.processUncertainty, "ROLLBACK_DOCKER_EXACT_ID_SETTLEMENT_UNPROVEN");
});

test("abnormal analyzer exit remains uncertain without exact container settlement", { skip: process.platform !== "linux" }, () => {
  const { entry, failure } = runAnalyzerExit("process.exit(7)");
  assert.match(failure?.message ?? "", /ROLLBACK_COMMAND_FAILED/u);
  assert.equal(entry.exitCode, 7);
  assert.equal(entry.signal, null);
  assert.equal(entry.timedOut, false);
  assert.equal(entry.status, "failed");
  assert.equal(entry.processCustody, "uncertain");
  assert.equal(entry.processUncertainty, "ROLLBACK_DOCKER_EXACT_ID_SETTLEMENT_UNPROVEN");
});

test("successful analyzer command retains completed process custody", { skip: process.platform !== "linux" }, () => {
  const { entry, failure } = runAnalyzerExit("process.exit(0)");
  assert.equal(failure, undefined);
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.signal, null);
  assert.equal(entry.status, "passed");
  assert.equal(entry.processCustody, "completed");
  assert.equal(entry.processUncertainty, null);
});
