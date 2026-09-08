export const IMPACTS = ["High", "Medium", "Low", "Informational", "Optimization"] as const;
export type Impact = (typeof IMPACTS)[number];
export type ResultCategory = "clean" | "policy-failure" | "tool-failure" | "output-failure" | "environment-failure";

/** Closed set of failures that may cross the serialized gate boundary. */
export type GateErrorCode =
  | "ABSOLUTE_PATH_REQUIRED" | "ANALYZER_RUNTIME_FAILED" | "ARTIFACT_EXPORT_FAILED"
  | "BUILD_INFO_INVALID" | "BYTECODE_MISSING" | "CANDIDATE_SHA_MISMATCH"
  | "CANDIDATE_SHA_INVALID" | "CI_PREREQUISITE_FAILED" | "COMPILER_BUILD_FAILED"
  | "COMPILER_SETTINGS_MISMATCH" | "CONTAINER_FAILED" | "CONTAINER_TIMEOUT"
  | "DETECTOR_INVENTORY_INVALID" | "DOCKER_CLI_INVALID" | "EVIDENCE_BUNDLE_INVALID"
  | "EVIDENCE_INSIDE_REPOSITORY" | "EVIDENCE_SCHEMA_INVALID" | "FORGE_PIN_MISMATCH"
  | "GIT_STATE_UNAVAILABLE" | "IMAGE_ENVIRONMENT_INVALID" | "IMAGE_METADATA_INVALID"
  | "IMAGE_PIN_MISMATCH" | "IMAGE_PREPARATION_FAILED" | "IMAGE_PULL_FAILED"
  | "IMAGE_UNAVAILABLE" | "INPUT_CLOSURE_MUTATED" | "INPUT_HASH_MISMATCH"
  | "MALFORMED_JSON" | "POLICY_SHAPE_INVALID" | "PRODUCTION_SOURCE_UNASSIGNED"
  | "SLITHER_EXIT_INVALID" | "SLITHER_INVENTORY_EMPTY" | "SOLC_PIN_MISMATCH"
  | "SUPPRESSION_SHAPE_INVALID" | "TARGET_MANIFEST_INVALID" | "TOOLCHAIN_LOCK_INVALID"
  | "TOOL_VERSION_MISMATCH" | "UNEXPECTED_ENVIRONMENT_FAILURE" | "CONTAINER_ID_INVALID" | "CGROUP_RUNTIME_UNPROVEN" | "TEMP_ROOT_INVALID" | "PUBLICATION_UNAVAILABLE"
  | "VULNERABLE_FIXTURE_NOT_BLOCKED" | "WORKTREE_NOT_CLEAN";

export interface SourceLocation {
  readonly path: string;
  readonly start: number;
  readonly length: number;
  readonly sourceHash: string;
  readonly snippetHash: string;
}

export interface Finding {
  readonly detectorId: string;
  readonly impact: Impact;
  readonly confidence: string;
  readonly identity: string;
  readonly findingIdentityHash: string;
  readonly location: SourceLocation;
  readonly fingerprint: string;
}

export interface Suppression {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly detectorId: string;
  readonly path: string;
  readonly start: number;
  readonly length: number;
  readonly sourceHash: string;
  readonly snippetHash: string;
  readonly findingIdentityHash: string;
  readonly reason: string;
  readonly owner: string;
  readonly expiresAt: string;
  readonly reviewAt: string;
  readonly regressionEvidence: string;
}

export interface ClosureEntry { readonly path: string; readonly sha256: string }
export interface GateManifest {
  readonly schemaVersion: 1;
  readonly targets: readonly { readonly path: string; readonly contract: string }[];
  readonly expectedContracts: readonly string[];
  readonly sources: readonly ClosureEntry[];
  readonly config: readonly ClosureEntry[];
  readonly compiler: {
    readonly version: "0.8.36+commit.8a079791";
    readonly evmVersion: "paris";
    readonly optimizerEnabled: true;
    readonly optimizerRuns: 200;
    readonly bytecodeHash: "ipfs";
    readonly cborMetadata: true;
    readonly useLiteralContent: false;
    readonly viaIR: false;
    readonly experimental: false;
    readonly remappings: readonly ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"];
  };
  readonly tools: {
    readonly forgeArchiveSha256: "8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57";
    readonly forgeBinarySha256: "c0fbe3ba32d7f498507042dbb94f5954be51126a76ce84e37d71749e7c9c571f";
    readonly solcBinarySha256: "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6";
  };
  readonly creationBytecodeSha256: string;
  readonly vulnerableFixture: { readonly source: ClosureEntry; readonly creationBytecodeSha256: string };
  readonly detectorInventory: ClosureEntry;
}

export interface DetectorInventoryDocument {
  readonly schemaVersion: 1;
  readonly slitherVersion: "0.11.6";
  readonly detectors: readonly string[];
}

export interface CompilerEvidence { readonly buildInfoSha256: string; readonly compilerInputSha256: string; readonly compilerSettingsSha256: string; readonly compilerInput: Readonly<Record<string, unknown>>; readonly compilerSettings: Readonly<Record<string, unknown>>; readonly sourceHashes: readonly ClosureEntry[]; readonly artifactSha256: string; readonly abiSha256: string; readonly creationBytecode: string; readonly creationBytecodeSha256: string; readonly rawBuildInfo: string; readonly rawArtifact: string }
export interface FixtureProof { readonly sourceSha256: string; readonly buildInfoSha256: string; readonly artifactSha256: string; readonly abiSha256: string; readonly creationBytecodeSha256: string; readonly rawBuildInfo: string; readonly rawArtifact: string }

export interface AnalysisInput {
  readonly success: boolean;
  readonly findings: readonly Finding[];
  readonly analyzedContracts: readonly string[];
  readonly analyzedSources: readonly string[];
  readonly closure: readonly ClosureEntry[];
  readonly detectorInventory: readonly string[];
  readonly compiler: GateManifest["compiler"];
  readonly creationBytecodeSha256: string;
  readonly freshFoundryCreationBytecodeSha256: string;
  readonly analysisErrors: readonly string[];
  readonly forgeBinarySha256: string;
  readonly solcBinarySha256: string;
  readonly compilerEvidence: CompilerEvidence;
  readonly fixtureProof: FixtureProof;
}

export interface FindingTriage {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly owner: string;
  readonly disposition: "accepted-design" | "false-positive" | "future-hardening";
  readonly rationale: string;
  readonly reviewedAt: string;
}

export interface PolicyDecision {
  readonly category: ResultCategory;
  readonly exitCode: 0 | 20 | 30 | 40 | 50;
  readonly blocking: readonly Finding[];
  readonly visible: readonly Finding[];
  readonly suppressed: readonly Finding[];
  readonly errors: readonly string[];
}

export class SlitherGateError extends Error {
  readonly code: GateErrorCode;
  constructor(code: GateErrorCode, message: string) { super(message); this.code = code; this.name = "SlitherGateError"; }
}

const COMPILER_PROFILE: GateManifest["compiler"] = {
  version: "0.8.36+commit.8a079791",
  evmVersion: "paris",
  optimizerEnabled: true,
  optimizerRuns: 200,
  bytecodeHash: "ipfs",
  cborMetadata: true,
  useLiteralContent: false,
  viaIR: false,
  experimental: false,
  remappings: [
    "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
    "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/",
  ],
};

export function parseCompilerProfile(value: unknown): GateManifest["compiler"] {
  if (JSON.stringify(value) !== JSON.stringify(COMPILER_PROFILE)) {
    throw new SlitherGateError(
      "COMPILER_SETTINGS_MISMATCH",
      "compiler settings differ from the exact approved profile",
    );
  }
  return COMPILER_PROFILE;
}
