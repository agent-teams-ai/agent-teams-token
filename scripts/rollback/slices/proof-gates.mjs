import {
  assertExactCleanCandidate,
  assertExactDirectoryShape,
  assertPathsAbsent,
} from "../proof-runtime.mjs";
import {
  gateCoverageSnapshot,
  gateEnvironment,
} from "./gate-contract.mjs";
import {
  preflightQualityGateEnvironment,
  runCommonGates,
  runSurvivorGate,
} from "./gate-execution.mjs";

export function executeSliceGates(context, preStateIdentity) {
  const { checkout, gateTemporaryDirectory, group, manifest, recorder, record } = context;
  const tools = preflightQualityGateEnvironment(checkout, manifest, recorder, group);
  const completedPreflightSequence = recorder.sequence;
  record.gatePreflight = {
    status: "passed",
    completedCommandSequence: completedPreflightSequence,
    slitherImageRequired: manifest.survivingGates.includes("slither"),
  };
  recorder.update(() => {});
  const environment = gateEnvironment(checkout, gateTemporaryDirectory, tools);
  runCommonGates(checkout, recorder, group, tools, environment);
  for (const survivor of manifest.survivingGates) {
    recorder.stage(
      group,
      "clean-before-survivor-" + survivor,
      () => assertExactCleanCandidate(checkout, preStateIdentity.sha),
      (sha) => ({ sha }),
    );
    runSurvivorGate({
      survivor,
      root: checkout,
      rollbackSha: preStateIdentity.sha,
      recorder,
      group,
      tools,
      environment,
      evidenceDirectory: recorder.directory,
    });
  }
  validatePostGateState(context, preStateIdentity.sha, completedPreflightSequence);
}

function validatePostGateState(context, rollbackSha, completedPreflightSequence) {
  const { checkout, group, manifest, recorder, record } = context;
  recorder.stage(
    group,
    "clean-after-all-gates",
    () => assertExactCleanCandidate(checkout, rollbackSha),
    (sha) => ({ sha }),
  );
  recorder.stage(
    group,
    "forbidden-residue-absent-after-all-gates",
    () => assertPathsAbsent(checkout, manifest.ownedPaths, group + ":post-gates"),
    (result) => result,
  );
  recorder.stage(
    group,
    "owned-root-shape-valid-after-all-gates",
    () => assertExactDirectoryShape(
      checkout,
      manifest.ownedRoot,
      manifest.restoreFromBaseline,
      group + ":post-gates",
    ),
    (result) => result,
  );
  const gateSequences = recorder.document.commands.filter((entry) =>
    entry.group === group && entry.phase === "gate").map(({ sequence }) => sequence);
  if (gateSequences.length === 0
    || gateSequences.some((sequence) => sequence <= completedPreflightSequence)) {
    throw new Error("ROLLBACK_GATE_RAN_BEFORE_PREFLIGHT slice=" + group);
  }
  record.gatePreflight.firstGateCommandSequence = Math.min(...gateSequences);
  record.gateCoverage = gateCoverageSnapshot(recorder.document.commands, manifest);
  if (record.gateCoverage.status !== "passed") {
    throw new Error("ROLLBACK_GATE_COVERAGE_MISMATCH slice=" + group);
  }
  record.status = "passed";
  recorder.update(() => {});
}
