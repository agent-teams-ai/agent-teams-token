import type { AnalysisPort, GateExecution, RepositoryStatePort } from "./ports.ts";
import { assertProductionCoverage } from "./coverage.ts";
import { evaluatePolicy } from "./policy.ts";
import { SlitherGateError } from "../domain/model.ts";

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
  if (decision.category === "tool-failure") {
    throw new SlitherGateError("ANALYZER_RUNTIME_FAILED", "Slither reported analysis errors");
  }
  if (decision.category === "output-failure") {
    throw new SlitherGateError("POLICY_SHAPE_INVALID", "analysis or policy semantics failed closed");
  }
  await repository.assertExactClean(candidateSha);
  return { ...result, decision };
}
