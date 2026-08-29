export type FailureClassification =
  | { readonly category: "tool-failure"; readonly exitCode: 30; readonly stage: string }
  | { readonly category: "output-failure"; readonly exitCode: 40; readonly stage: string }
  | { readonly category: "environment-failure"; readonly exitCode: 50; readonly stage: string };

const OUTPUT_FAILURES = new Set([
  "MALFORMED_JSON", "DETECTOR_INVENTORY_INVALID", "SLITHER_INVENTORY_EMPTY",
  "SLITHER_EXIT_INVALID", "BUILD_INFO_INVALID", "COMPILER_SETTINGS_MISMATCH",
  "BYTECODE_MISSING", "VULNERABLE_FIXTURE_NOT_BLOCKED", "COMPILER_BUILD_FAILED",
  "ARTIFACT_EXPORT_FAILED",
]);
const TOOL_FAILURES = new Set(["ANALYZER_RUNTIME_FAILED"]);

/** Stable exception-to-evidence taxonomy used by the CLI and its tests. */
export function classifyGateFailure(code: string): FailureClassification {
  if (TOOL_FAILURES.has(code)) { return { category: "tool-failure", exitCode: 30, stage: "analysis-runtime" }; }
  if (OUTPUT_FAILURES.has(code)) {
    const stage = code === "COMPILER_BUILD_FAILED" ? "compiler-build"
      : code === "ARTIFACT_EXPORT_FAILED" || code === "BUILD_INFO_INVALID" || code === "BYTECODE_MISSING" ? "artifact-validation"
        : "analysis-output";
    return { category: "output-failure", exitCode: 40, stage };
  }
  return { category: "environment-failure", exitCode: 50, stage: "environment" };
}
