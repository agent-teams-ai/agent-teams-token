import type { AnalysisPort, GateExecution, RepositoryStatePort } from "./ports.ts";
import { assertProductionCoverage } from "./coverage.ts";
import { evaluatePolicy } from "./policy.ts";

export async function executeGate(
  candidateSha: string,
  repository: RepositoryStatePort,
  analysis: AnalysisPort,
): Promise<GateExecution> {
  await repository.assertExactClean(candidateSha);
  const trackedProductionSources = await repository.trackedProductionSources();
  const result = await analysis.run();
  assertProductionCoverage(trackedProductionSources, result.manifest);
  const decision = evaluatePolicy({
    input: result.input,
    manifest: result.manifest,
    expectedDetectors: result.expectedDetectors,
    suppressions: result.suppressions,
    triage: result.triage,
  });
  await repository.assertExactClean(candidateSha);
  return { ...result, decision };
}
