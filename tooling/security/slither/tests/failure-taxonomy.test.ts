import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGateFailure } from "../src/application/failure.ts";

test("compiler, artifact, analyzer and environment failures have stable evidence exits", () => {
  assert.deepEqual(classifyGateFailure("COMPILER_BUILD_FAILED"), { category: "output-failure", exitCode: 40, stage: "compiler-build" });
  assert.deepEqual(classifyGateFailure("BUILD_INFO_INVALID"), { category: "output-failure", exitCode: 40, stage: "artifact-validation" });
  assert.deepEqual(classifyGateFailure("ARTIFACT_EXPORT_FAILED"), { category: "output-failure", exitCode: 40, stage: "artifact-validation" });
  assert.deepEqual(classifyGateFailure("ANALYZER_RUNTIME_FAILED"), { category: "tool-failure", exitCode: 30, stage: "analysis-runtime" });
  assert.deepEqual(classifyGateFailure("IMAGE_UNAVAILABLE"), { category: "environment-failure", exitCode: 50, stage: "environment" });
});
