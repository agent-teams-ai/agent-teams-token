import type { GateErrorCode } from "../domain/model.ts";

export type FailureClassification =
  | { readonly category: "tool-failure"; readonly exitCode: 30; readonly stage: string }
  | { readonly category: "output-failure"; readonly exitCode: 40; readonly stage: string }
  | { readonly category: "environment-failure"; readonly exitCode: 50; readonly stage: string };

const output = <const Stage extends string>(stage: Stage) => ({ category: "output-failure" as const, exitCode: 40 as const, stage });
const tool = <const Stage extends string>(stage: Stage) => ({ category: "tool-failure" as const, exitCode: 30 as const, stage });
const environment = <const Stage extends string>(stage: Stage) => ({ category: "environment-failure" as const, exitCode: 50 as const, stage });

/**
 * The sole authority for serialized gate failures. Every code emitted by the
 * Slither module has one stable category, process exit and phase marker.
 */
export const FAILURE_REGISTRY = {
  ABSOLUTE_PATH_REQUIRED: environment("initialization"),
  ANALYZER_RUNTIME_FAILED: tool("analysis-runtime"),
  ARTIFACT_EXPORT_FAILED: output("artifact-validation"),
  BUILD_INFO_INVALID: output("artifact-validation"),
  BYTECODE_MISSING: output("artifact-validation"),
  CANDIDATE_SHA_MISMATCH: environment("repository-validation"),
  CANDIDATE_SHA_INVALID: environment("initialization"),
  CI_PREREQUISITE_FAILED: environment("ci-prerequisite"),
  COMPILER_BUILD_FAILED: output("compiler-build"),
  COMPILER_SETTINGS_MISMATCH: output("artifact-validation"),
  CONTAINER_FAILED: environment("container-execution"),
  CONTAINER_TIMEOUT: environment("container-execution"),
  DETECTOR_INVENTORY_INVALID: output("detector-inventory"),
  DOCKER_CLI_INVALID: environment("image-preflight"),
  EVIDENCE_BUNDLE_INVALID: output("final-validation"),
  EVIDENCE_INSIDE_REPOSITORY: environment("initialization"),
  EVIDENCE_SCHEMA_INVALID: output("schema-validation"),
  FORGE_PIN_MISMATCH: environment("toolchain-validation"),
  GIT_STATE_UNAVAILABLE: environment("repository-validation"),
  IMAGE_ENVIRONMENT_INVALID: environment("image-preflight"),
  IMAGE_METADATA_INVALID: environment("image-preflight"),
  IMAGE_PIN_MISMATCH: environment("image-preflight"),
  IMAGE_PREPARATION_FAILED: environment("image-preflight"),
  IMAGE_PULL_FAILED: environment("image-pull"),
  IMAGE_UNAVAILABLE: environment("image-preflight"),
  INPUT_CLOSURE_MUTATED: environment("repository-validation"),
  INPUT_HASH_MISMATCH: output("input-validation"),
  MALFORMED_JSON: output("artifact-parsing"),
  POLICY_SHAPE_INVALID: output("policy-validation"),
  PRODUCTION_SOURCE_UNASSIGNED: output("manifest-validation"),
  SLITHER_EXIT_INVALID: output("artifact-parsing"),
  SLITHER_INVENTORY_EMPTY: output("artifact-parsing"),
  SOLC_PIN_MISMATCH: environment("toolchain-validation"),
  SUPPRESSION_SHAPE_INVALID: output("policy-validation"),
  TARGET_MANIFEST_INVALID: output("manifest-validation"),
  TOOLCHAIN_LOCK_INVALID: environment("toolchain-validation"),
  TOOL_VERSION_MISMATCH: environment("version-inventory"),
  CONTAINER_ID_INVALID: environment("container-identity"),
  CGROUP_RUNTIME_UNPROVEN: environment("container-isolation"),
  TEMP_ROOT_INVALID: environment("initialization"),
  PUBLICATION_UNAVAILABLE: output("publication"),
  UNEXPECTED_ENVIRONMENT_FAILURE: environment("environment"),
  VULNERABLE_FIXTURE_NOT_BLOCKED: output("semantic-validation"),
  WORKTREE_NOT_CLEAN: environment("repository-validation"),
} as const satisfies Record<GateErrorCode, FailureClassification>;

export function isGateErrorCode(code: string): code is GateErrorCode {
  return Object.hasOwn(FAILURE_REGISTRY, code);
}

/** Stable exception-to-evidence taxonomy used by every composition root. */
export function classifyGateFailure(code: GateErrorCode): FailureClassification {
  return FAILURE_REGISTRY[code];
}
