import type { AnalysisInput, FindingTriage, GateManifest, PolicyDecision, Suppression } from "../domain/model.ts";

export interface ProcessResult { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }
export interface ProcessOptions { readonly env?: NodeJS.ProcessEnv }
export interface ProcessPort { run(command: string, args: readonly string[], timeoutMs: number, options?: ProcessOptions): Promise<ProcessResult> }

export interface RepositoryStatePort {
  assertExactClean(candidateSha: string): Promise<void>;
  trackedProductionSources(): Promise<readonly string[]>;
}

export interface GateExecution {
  readonly input: AnalysisInput;
  readonly decision: PolicyDecision;
  readonly manifest: GateManifest;
  readonly triage: readonly FindingTriage[];
  readonly configHash: string;
  readonly policyHash: string;
  readonly triageHash: string;
}

export interface GateAnalysis {
  readonly input: AnalysisInput;
  readonly manifest: GateManifest;
  readonly expectedDetectors: readonly string[];
  readonly suppressions: readonly Suppression[];
  readonly triage: readonly FindingTriage[];
  readonly configHash: string;
  readonly policyHash: string;
  readonly triageHash: string;
}

export interface AnalysisPort { run(): Promise<GateAnalysis> }
