import { OwnedProcess } from "../adapters/process.ts";
import { GitRepositoryState } from "../adapters/repository.ts";
import { ExclusiveDirectoryPublication, writeFailureEvidence, writeReadyEvidence } from "../adapters/evidence.ts";
import { runGate } from "../adapters/runner.ts";
import { resolveDockerCli } from "../adapters/executable.ts";
import { validateEnvironment } from "../adapters/validated-environment.ts";
import { executeGate } from "../application/gate.ts";
import { classifyGateFailure } from "../application/failure.ts";
import { SlitherGateError } from "../domain/model.ts";
import { assertNotCancelled, SlitherCancellation } from "../application/ports.ts";

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
  const publication = new ExclusiveDirectoryPublication(cancellation.signal);
  const failures: unknown[] = [];
  const priorFailures: unknown[] = [];
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
      await writeReadyEvidence({output, candidateSha: sha, manifest: result.manifest, input: result.input, decision: result.decision, hashes: {config: result.configHash, policy: result.policyHash}, triageHash: result.triageHash, schemaDirectory: `${root}/tooling/security/slither`, assertReadyPrecondition, publication});
      assertNotCancelled(cancellation.signal);
      process.exitCode = result.decision.exitCode;
    } catch (error) {
      if (cancellation.signal.aborted) { throw error; }
      priorFailures.push(error);
      const code = error instanceof SlitherGateError ? error.code : "UNEXPECTED_ENVIRONMENT_FAILURE"; const failure = classifyGateFailure(code);
      try {
        await writeFailureEvidence({output, candidateSha: sha, category: failure.category, exitCode: failure.exitCode, stage: failure.stage, errorCode: code, schemaDirectory: `${root}/tooling/security/slither`, assertReadyPrecondition, publication});
        assertNotCancelled(cancellation.signal);
      } catch (publicationError) { throw new AggregateError([error, publicationError], "gate and failure publication failed"); }
      process.exitCode = failure.exitCode;
    }
  } catch (error) { failures.push(error); }
  try {
    if (failures.length === 0) { await publication.finalize(); }
  } catch (error) { failures.push(error); }
  try {
    if (failures.length !== 0 || cancellation.signal.aborted) { await publication.revoke(); }
  } catch (error) { failures.push(error); }
  // Final commit boundary: all awaited publication/staging finalization is done.
  // The last cancellation check, status selection and listener removal below are
  // synchronous. READY is revocable until here, not after a committed invocation.
  try {
    reportInvocation(failures, priorFailures, cancellation.signal);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

function reportInvocation(failures: readonly unknown[], priorFailures: readonly unknown[], signal: AbortSignal): void {
  if (signal.aborted) {
    const reason = signal.reason as SlitherCancellation;
    process.stderr.write(`${reason.message}\n`);
    if ([...priorFailures, ...failures].some((error) => hasAdditionalFailure(error, reason))) { process.stderr.write("SLITHER_CANCELLED_FINALIZATION: additional lifecycle failure; cleanup may be unconfirmed\n"); }
    process.exitCode = reason.exitCode;
  } else if (failures.length !== 0) {
    const error = failures[0];
    const code = error instanceof SlitherGateError ? error.code : "UNEXPECTED_ENVIRONMENT_FAILURE";
    process.stderr.write(`SLITHER_GATE_FAILED ${code}\n`); process.exitCode = classifyGateFailure(code).exitCode;
  }
}

function hasAdditionalFailure(error: unknown, reason: SlitherCancellation): boolean {
  return error instanceof AggregateError ? error.errors.some((entry: unknown) => hasAdditionalFailure(entry, reason)) : error !== reason;
}

if (import.meta.main) { await main(); }
