export const IMPACTS = ["High", "Medium", "Low", "Informational", "Optimization"] as const;
export type Impact = (typeof IMPACTS)[number];
export type ResultCategory = "clean" | "policy-failure" | "tool-failure" | "output-failure" | "environment-failure";

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
  readonly detectorInventory: ClosureEntry;
}

export interface DetectorInventoryDocument {
  readonly schemaVersion: 1;
  readonly slitherVersion: "0.11.6";
  readonly detectors: readonly string[];
}

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
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = "SlitherGateError"; }
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
