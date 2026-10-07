import { readFileSync } from "node:fs";
import { sha256, tail } from "./common.mjs";
import { commandOutcomeFields, selectedEnvironment } from "./evidence-command.mjs";

export function commandCustodyFacts(result, id) {
  // Local group quiescence does not prove settlement of the daemon container.
  const dockerSettlementUnproven = id === "slither-real-analyzer"
    && ((result.error !== undefined && result.error !== null)
      || result.status !== 0 || result.signal !== null);
  const nativeCustodyUncertain = result.custody !== undefined
    && result.custody !== "completed" && result.custody !== "reaped";
  return { dockerSettlementUnproven, nativeCustodyUncertain };
}

export function commandPassed(result) {
  return !result.error && result.status === 0 && result.targetStatus.quiescent === true
    && (result.custody === undefined || result.custody === "completed");
}

export function captureCommandEvidence({
  sequence, group, id, command, invocation, options, startedAt, started, result,
  primaryFailure, dockerSettlementUnproven, passed, finalizationFailures,
  stdoutPath, stderrPath, stdoutRelative, stderrRelative,
}) {
  const stdout = readFileSync(stdoutPath);
  const stderr = readFileSync(stderrPath);
  if (primaryFailure !== undefined) {
    primaryFailure.message += "\n" + tail(stdout.toString("utf8") + "\n" + stderr.toString("utf8"), 80);
  }
  const entry = {
    sequence,
    group,
    id,
    phase: options.phase ?? "preparation",
    command,
    arguments: invocation.arguments,
    cwd: options.cwd,
    environment: selectedEnvironment(invocation.environment),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - started,
    ...commandOutcomeFields(result),
    // Record native custody only when the executor actually supplies it.
    ...(result.custody === undefined ? {} : {
      processCustody: result.custody,
      processUncertainty: result.uncertainty ?? null,
      ...(result.signalledCount === undefined ? {} : { signalledCount: result.signalledCount }),
    }),
    ...(dockerSettlementUnproven ? {
      processCustody: "uncertain",
      processUncertainty: "ROLLBACK_DOCKER_EXACT_ID_SETTLEMENT_UNPROVEN",
    } : {}),
    status: passed && finalizationFailures.length === 0 ? "passed" : "failed",
    stdout: { path: stdoutRelative, byteLength: stdout.length, sha256: sha256(stdout) },
    stderr: { path: stderrRelative, byteLength: stderr.length, sha256: sha256(stderr) },
  };
  return { stdout, stderr, entry };
}
