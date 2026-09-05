import { OwnedProcess } from "../adapters/process.ts";
import { GitRepositoryState } from "../adapters/repository.ts";
import { ExclusiveDirectoryPublication, writeFailureEvidence, writeReadyEvidence } from "../adapters/evidence.ts";
import { runGate } from "../adapters/runner.ts";
import { resolveDockerCli } from "../adapters/executable.ts";
import { validateEnvironment } from "../adapters/validated-environment.ts";
import { executeGate } from "../application/gate.ts";
import { classifyGateFailure } from "../application/failure.ts";
import { SlitherGateError } from "../domain/model.ts";
import { assertNotCancelled, SlitherCancellation } from "../application/cancellation.ts";

/** Scoped to an invocation; importing the composition installs no listeners. */
export async function main(): Promise<void> {
  const cancellation = new AbortController();
  const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
    if (!cancellation.signal.aborted) { cancellation.abort(new SlitherCancellation(signal)); }
  };
  const onInt = (): void => { interrupt("SIGINT"); };
  const onTerm = (): void => { interrupt("SIGTERM"); };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let validated: Awaited<ReturnType<typeof validateEnvironment>> | undefined;
  try {
    validated = await validateEnvironment(process.env.SLITHER_REPOSITORY_ROOT ?? process.cwd(), [process.env.GITHUB_SHA, process.env.SLITHER_CANDIDATE_SHA], process.env.SLITHER_EVIDENCE_DIRECTORY);
    assertNotCancelled(cancellation.signal);
    const {repositoryRoot: root, candidateSha: sha, output} = validated;
    const processPort = new OwnedProcess(cancellation.signal); const repository = new GitRepositoryState(root, processPort);
    const assertReadyPrecondition = async (): Promise<void> => {
      assertNotCancelled(cancellation.signal);
      await repository.assertExactClean(sha);
      assertNotCancelled(cancellation.signal);
    };
    try {
      const dockerPath = await resolveDockerCli(process.env.SLITHER_DOCKER_PATH ?? "");
      assertNotCancelled(cancellation.signal);
      const result = await executeGate(sha, repository, {run: async () => {
        assertNotCancelled(cancellation.signal);
        return await runGate({repositoryRoot: root, processPort, forgePath: process.env.SLITHER_FORGE_PATH ?? "", solcPath: process.env.SLITHER_SOLC_PATH ?? "", dockerPath});
      }});
      assertNotCancelled(cancellation.signal);
      await writeReadyEvidence({output, candidateSha: sha, manifest: result.manifest, input: result.input, decision: result.decision, hashes: {config: result.configHash, policy: result.policyHash}, triageHash: result.triageHash, schemaDirectory: `${root}/tooling/security/slither`, assertReadyPrecondition, publication: new ExclusiveDirectoryPublication()});
      assertNotCancelled(cancellation.signal);
      process.exitCode = result.decision.exitCode;
    } catch (error) {
      if (cancellation.signal.aborted) { throw error; }
      const code = error instanceof SlitherGateError ? error.code : "UNEXPECTED_ENVIRONMENT_FAILURE"; const failure = classifyGateFailure(code);
      await writeFailureEvidence({output, candidateSha: sha, category: failure.category, exitCode: failure.exitCode, stage: failure.stage, errorCode: code, schemaDirectory: `${root}/tooling/security/slither`, assertReadyPrecondition, publication: new ExclusiveDirectoryPublication()});
      assertNotCancelled(cancellation.signal);
      process.exitCode = failure.exitCode;
    }
  } catch (error) {
    if (cancellation.signal.aborted) {
      const reason = cancellation.signal.reason as SlitherCancellation;
      process.stderr.write(`${reason.message}\n`);
      if (hasAdditionalFailure(error, reason)) { process.stderr.write("SLITHER_CANCELLED_FINALIZATION: additional lifecycle failure; cleanup may be unconfirmed\n"); }
      process.exitCode = reason.exitCode;
      return;
    }
    const code = error instanceof SlitherGateError ? error.code : "UNEXPECTED_ENVIRONMENT_FAILURE";
    process.stderr.write(`SLITHER_GATE_FAILED ${code}\n`); process.exitCode = classifyGateFailure(code).exitCode;
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

function hasAdditionalFailure(error: unknown, reason: SlitherCancellation): boolean {
  return error instanceof AggregateError ? error.errors.some((entry: unknown) => hasAdditionalFailure(entry, reason)) : error !== reason;
}

if (import.meta.main) { await main(); }
