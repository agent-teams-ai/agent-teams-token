import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  closeEvidenceDirectory,
  createEvidenceDirectory,
  evidenceDirectoryPath,
  EvidenceRecorder,
  runEvidenceLifecycle,
  verifyEvidenceDirectory,
} from "../rollback/proof-runtime.mjs";

const repositoryRoot = resolve(new URL("../..", import.meta.url).pathname);

test("successful evidence lifecycle closes custody after publication work", () => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-evidence-lifecycle-"));
  const evidence = createEvidenceDirectory(undefined, root, repositoryRoot);
  const path = evidenceDirectoryPath(evidence);
  try {
    const result = runEvidenceLifecycle(
      evidence,
      () => new EvidenceRecorder(evidence, { mode: "custody-success" }),
      (recorder) => {
        recorder.finalize("prepared");
        return "complete";
      },
    );
    assert.equal(result, "complete");
    assert.equal(JSON.parse(readFileSync(join(path, "diagnostics.json"), "utf8")).status, "prepared");
    assert.throws(() => verifyEvidenceDirectory(evidence), /ROLLBACK_CUSTODY_HANDLE_CLOSED/u);
  } finally {
    closeEvidenceDirectory(evidence);
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained evidence custody refuses a foreign root successor", () => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-evidence-custody-"));
  const evidence = createEvidenceDirectory(undefined, root, repositoryRoot);
  const path = evidenceDirectoryPath(evidence);
  const heldPath = path + ".held";
  try {
    assert.throws(
      () => runEvidenceLifecycle(
        evidence,
        () => new EvidenceRecorder(evidence, { mode: "custody-regression" }),
        (recorder) => {
          renameSync(path, heldPath);
          mkdirSync(path, { mode: 0o700 });
          writeFileSync(
            join(path, "diagnostics.json"),
            '{"status":"successor-sentinel"}\n',
            { mode: 0o600 },
          );
          recorder.finalize("passed");
        },
      ),
      (error) => error instanceof AggregateError
        && error.message === "ROLLBACK_EVIDENCE_FAILURE_FINALIZATION_FAILED"
        && error.errors.every((entry) =>
          /ROLLBACK_EVIDENCE_CUSTODY_SUBSTITUTED/u.test(entry.message)),
    );
    assert.throws(() => verifyEvidenceDirectory(evidence), /ROLLBACK_CUSTODY_HANDLE_CLOSED/u);
    assert.equal(
      JSON.parse(readFileSync(join(heldPath, "diagnostics.json"), "utf8")).status,
      "running",
    );
    assert.equal(
      JSON.parse(readFileSync(join(path, "diagnostics.json"), "utf8")).status,
      "successor-sentinel",
    );
  } finally {
    closeEvidenceDirectory(evidence);
    rmSync(root, { recursive: true, force: true });
  }
});
