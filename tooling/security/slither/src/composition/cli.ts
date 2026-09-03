import { OwnedProcess } from "../adapters/process.ts";
import { GitRepositoryState } from "../adapters/repository.ts";
import { ExclusiveDirectoryPublication, writeFailureEvidence, writeReadyEvidence } from "../adapters/evidence.ts";
import { runGate } from "../adapters/runner.ts";
import { resolveDockerCli } from "../adapters/executable.ts";
import { validateEnvironment } from "../adapters/validated-environment.ts";
import { executeGate } from "../application/gate.ts";
import { classifyGateFailure } from "../application/failure.ts";
import { SlitherGateError } from "../domain/model.ts";

async function main(): Promise<void> {
  let validated: Awaited<ReturnType<typeof validateEnvironment>> | undefined;
  try {
    validated = await validateEnvironment(process.env.SLITHER_REPOSITORY_ROOT ?? process.cwd(), [process.env.GITHUB_SHA, process.env.SLITHER_CANDIDATE_SHA], process.env.SLITHER_EVIDENCE_DIRECTORY);
    const {repositoryRoot: root, candidateSha: sha, output} = validated;
    const processPort = new OwnedProcess(); const repository = new GitRepositoryState(root, processPort);
    try {
      const dockerPath = await resolveDockerCli(process.env.SLITHER_DOCKER_PATH ?? "");
      const result = await executeGate(sha, repository, {run: async () => await runGate({repositoryRoot: root, processPort, forgePath: process.env.SLITHER_FORGE_PATH ?? "", solcPath: process.env.SLITHER_SOLC_PATH ?? "", dockerPath})});
      await writeReadyEvidence({output, candidateSha: sha, manifest: result.manifest, input: result.input, decision: result.decision, hashes: {config: result.configHash, policy: result.policyHash}, triageHash: result.triageHash, schemaDirectory: `${root}/tooling/security/slither`, assertReadyPrecondition: async () => await repository.assertExactClean(sha), publication: new ExclusiveDirectoryPublication()});
      process.exitCode = result.decision.exitCode;
    } catch (error) {
      const code = error instanceof SlitherGateError ? error.code : "UNEXPECTED_ENVIRONMENT_FAILURE"; const failure = classifyGateFailure(code);
      await writeFailureEvidence({output, candidateSha: sha, category: failure.category, exitCode: failure.exitCode, stage: failure.stage, errorCode: code, schemaDirectory: `${root}/tooling/security/slither`, assertReadyPrecondition: async () => await repository.assertExactClean(sha), publication: new ExclusiveDirectoryPublication()});
      process.exitCode = failure.exitCode;
    }
  } catch (error) {
    const code = error instanceof SlitherGateError ? error.code : "UNEXPECTED_ENVIRONMENT_FAILURE";
    process.stderr.write(`SLITHER_GATE_FAILED ${code}\n`); process.exitCode = classifyGateFailure(code).exitCode;
  }
}
await main();
