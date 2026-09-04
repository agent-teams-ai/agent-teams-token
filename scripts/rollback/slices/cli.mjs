import { join } from "node:path";

import {
  EvidenceRecorder,
  assertExactCleanCandidate,
  assertInventoryEqual,
  assertPinnedNodeRuntime,
  basicRun,
  createEvidenceDirectory,
  evidenceDirectoryPath,
  publishEvidenceSeal,
  publishReadyMarker,
  runEvidenceLifecycle,
  trackedCandidateInventory,
  verifyEvidenceDirectory,
} from "../proof-runtime.mjs";
import {
  completedGlobalManifestEvidence,
  expectedSlices,
  pendingGlobalManifestEvidence,
  repositoryRoot,
  rollbackBaselineSha,
  rollbackTemporaryRoot,
} from "./config.mjs";
import {
  rollbackGateCoverage,
} from "./gate-contract.mjs";
import { pinnedEnvironmentPreflight } from "./gate-execution.mjs";
import {
  readManifests,
  validateManifestSet,
} from "./manifests.mjs";
import {
  manifestFingerprint,
  printReverseHashes,
} from "./manifest-proof.mjs";
import { proveSlice } from "./proof-slice.mjs";

export function parseCliArguments(argv, environment = {}) {
  const parsed = parseCliOptions(argv);
  const mode = selectedMode(parsed.seen);
  if (parsed.seen.has("--evidence-dir")
    && ["preflight", "validate", "print-hashes"].includes(mode)) {
    throw new Error("ROLLBACK_ARGUMENT_INVALID value=--evidence-dir-for-" + mode);
  }
  const expectedSha = parsed.values.get("--expected-sha") ?? environment.GITHUB_SHA;
  if (expectedSha !== undefined && !/^[0-9a-f]{40}$/u.test(expectedSha)) {
    throw new Error("ROLLBACK_ARGUMENT_SHA_INVALID value=" + expectedSha);
  }
  const evidencePath = selectedEvidencePath(parsed.values, mode, environment);
  return {
    mode,
    expectedSha,
    evidencePath,
    printHashesSlice: parsed.values.get("--print-hashes"),
  };
}

function parseCliOptions(argv) {
  const booleanOptions = new Set(["--preflight-only", "--validate-only", "--prepare-only"]);
  const valuedOptions = new Set(["--print-hashes", "--expected-sha", "--evidence-dir"]);
  const seen = new Set();
  const values = new Map();
  for (const argument of argv) {
    const parsed = parseCliOption(argument);
    if ((!booleanOptions.has(parsed.name) && !valuedOptions.has(parsed.name))
      || (booleanOptions.has(parsed.name) && parsed.value !== undefined)
      || (valuedOptions.has(parsed.name)
        && (parsed.value === undefined || parsed.value.length === 0))) {
      throw new Error("ROLLBACK_ARGUMENT_INVALID value=" + argument);
    }
    if (seen.has(parsed.name)) {
      throw new Error("ROLLBACK_ARGUMENT_DUPLICATE value=" + parsed.name);
    }
    seen.add(parsed.name);
    if (parsed.value !== undefined) {
      values.set(parsed.name, parsed.value);
    }
  }
  return { seen, values };
}

function parseCliOption(argument) {
  const equals = argument.indexOf("=");
  return equals < 0
    ? { name: argument, value: undefined }
    : { name: argument.slice(0, equals), value: argument.slice(equals + 1) };
}

function selectedMode(seen) {
  const selectors = [
    seen.has("--preflight-only") ? "preflight" : undefined,
    seen.has("--validate-only") ? "validate" : undefined,
    seen.has("--prepare-only") ? "prepare" : undefined,
    seen.has("--print-hashes") ? "print-hashes" : undefined,
  ].filter(Boolean);
  if (selectors.length > 1) {
    throw new Error("ROLLBACK_ARGUMENT_INVALID value=<mode-conflict>");
  }
  return selectors[0] ?? "full";
}

function selectedEvidencePath(values, mode, environment) {
  const path = values.get("--evidence-dir")
    ?? (["full", "prepare"].includes(mode)
      ? environment.AGTMAI_ROLLBACK_EVIDENCE_DIRECTORY
      : undefined);
  if (path !== undefined && path.length === 0) {
    throw new Error("ROLLBACK_ARGUMENT_INVALID value=<empty-evidence-path>");
  }
  return path;
}

function printManifestValidation(manifests) {
  for (const manifest of manifests) {
    process.stdout.write(
      "rollback-manifest slice=" + manifest.sliceId
      + " sha256=" + manifestFingerprint(manifest)
      + " result=schema-valid globalEvidence=" + pendingGlobalManifestEvidence + "\n",
    );
  }
}


export function deterministicProofStatement(document) {
  if (document.mode !== "full" || document.slices.length !== expectedSlices.length
    || document.manifests.length !== expectedSlices.length || document.candidate === null
    || document.globalEnvironment === undefined) {
    throw new Error("ROLLBACK_EVIDENCE_STATEMENT_INCOMPLETE");
  }
  const runtime = document.globalEnvironment.runtime;
  return {
    schemaVersion: 1,
    kind: "agtmai-recovery-proof-statement",
    status: "passed",
    mode: "full",
    baselineSha: rollbackBaselineSha,
    globalManifestEvidence: completedGlobalManifestEvidence,
    candidate: document.candidate,
    environment: {
      binaries: document.globalEnvironment.binaries,
      runtime: {
        platform: runtime.platform,
        version: runtime.version,
        artifactSha256: runtime.artifactSha256,
        executableSha256: runtime.executableSha256,
      },
      slitherImage: document.globalEnvironment.slitherImage,
      workspaceLinkCount: document.globalEnvironment.workspaceLinkCount,
    },
    manifests: document.manifests.map(({ sliceId, sha256, artifact }) => ({
      sliceId,
      sha256,
      artifact,
    })),
    slices: document.slices.map((slice) => ({
      sliceId: slice.sliceId,
      manifestSha256: slice.manifestSha256,
      candidateSha: slice.candidateSha,
      checkoutInventorySha256: slice.checkoutInventory.sha256,
      preState: {
        sha: slice.preState.sha,
        tree: slice.preState.tree,
        statusSha256: slice.preState.statusSha256,
        status: slice.preState.status,
        inventorySha256: slice.preState.inventorySha256,
        inventory: slice.preState.inventory,
        entryCount: slice.preState.entryCount,
        totalBytes: slice.preState.totalBytes,
      },
      application: {
        candidateSha: slice.application.candidateSha,
        tree: slice.application.tree,
        pathCount: slice.application.pathCount,
        pathsSha256: slice.application.pathsSha256,
      },
      rollback: {
        sha: slice.rollback.sha,
        tree: slice.rollback.tree,
        statusSha256: slice.rollback.statusSha256,
        status: slice.rollback.status,
        inventorySha256: slice.rollback.inventorySha256,
        inventory: slice.rollback.inventory,
        entryCount: slice.rollback.entryCount,
        totalBytes: slice.rollback.totalBytes,
      },
      assertions: {
        candidateByteEquivalent: slice.application.byteEquivalentToCandidate,
        rollbackStatusEquivalent: slice.rollback.statusEquivalentToPreState,
        rollbackTreeEquivalent: slice.rollback.treeEquivalentToPreState,
        rollbackInventoryEquivalent: slice.rollback.inventoryEquivalentToPreState,
        forbiddenResidueAbsent: slice.rollback.forbiddenResidue.status === "passed",
        ownedRootShapeValid: slice.rollback.ownedRootShape.status === "passed",
      },
      expectedGateIds: slice.gateCoverage.expected,
      executedGateIds: slice.gateCoverage.executed,
      cleanupStatus: slice.cleanup.status,
      status: slice.status,
    })),
  };
}



export function runCli() {
  const options = parseCliArguments(process.argv.slice(2), process.env);
  if (options.mode === "preflight") {
    runPreflight(options);
    return;
  }
  if (options.mode === "validate") {
    runValidation(options);
    return;
  }
  if (options.mode === "print-hashes") {
    runHashMaintenance(options);
    return;
  }
  runRecordedProof(options);
}

function runPreflight(options) {
  const candidate = bindCandidate(options.expectedSha);
  const result = pinnedEnvironmentPreflight(repositoryRoot);
  revalidateCandidate(candidate, "preflight-final-candidate");
  process.stdout.write(
    "rollback-environment-preflight candidate=" + candidate.sha
    + " image=" + result.slitherImage.manifestDigest
    + " platform=" + result.slitherImage.platform
    + " result=pass\n",
  );
}

function runValidation(options) {
  const candidate = bindCandidate(options.expectedSha);
  const manifests = validateManifestSet(readManifests());
  printManifestValidation(manifests);
  validateManifestSet(manifests, { verifyGitCoverage: true });
  revalidateCandidate(candidate, "validation-final-candidate");
  process.stdout.write(
    "rollback-manifest-coverage candidate=" + candidate.sha + " result=pass\n",
  );
  process.stdout.write("rollback-validation candidate=" + candidate.sha + " result=pass\n");
}

function runHashMaintenance(options) {
  const candidate = bindCandidate(options.expectedSha);
  assertPinnedNodeRuntime(repositoryRoot);
  const manifests = validateManifestSet(readManifests());
  const manifest = manifests.find(({ sliceId }) => sliceId === options.printHashesSlice);
  if (manifest === undefined) {
    throw new Error("ROLLBACK_UNKNOWN_SLICE slice=" + options.printHashesSlice);
  }
  process.stderr.write(
    "rollback-hash-maintenance candidate=" + candidate.sha
    + " slice=" + manifest.sliceId
    + " evidence=none result=maintenance-only-no-proof\n",
  );
  printReverseHashes(manifest, candidate.sha, candidate.inventory);
  revalidateCandidate(candidate, "hash-maintenance-final-candidate");
}

function bindCandidate(expectedSha) {
  const sha = assertExactCleanCandidate(repositoryRoot, expectedSha);
  assertCompleteHistory(sha);
  return {
    sha,
    inventory: trackedCandidateInventory(repositoryRoot, sha),
  };
}

function assertCompleteHistory(candidateSha) {
  return basicRun("/bin/bash", [
    join(repositoryRoot, "scripts/assert-complete-history.sh"),
    candidateSha,
    rollbackBaselineSha,
  ], { cwd: repositoryRoot, timeout: 120_000 });
}

function revalidateCandidate(candidate, label) {
  assertExactCleanCandidate(repositoryRoot, candidate.sha);
  assertInventoryEqual(
    candidate.inventory,
    trackedCandidateInventory(repositoryRoot, candidate.sha),
    label,
  );
}

function runRecordedProof(options) {
  const evidenceDirectory = createEvidenceDirectory(
    options.evidencePath,
    rollbackTemporaryRoot,
    repositoryRoot,
  );
  const candidateSha = runEvidenceLifecycle(
    evidenceDirectory,
    () => createProofRecorder(evidenceDirectory, options),
    (recorder) => executeRecordedProof(recorder, evidenceDirectory, options),
  );
  printProofResult(options, candidateSha, evidenceDirectoryPath(evidenceDirectory));
}

function executeRecordedProof(recorder, evidenceDirectory, options) {
  const state = recordCandidateAndManifests(recorder, options);
  recordGlobalEnvironment(recorder);
  recordManifestGitCoverage(recorder, state);
  proveAllSlices(recorder, options, state);
  finalizeRecordedProof(recorder, options, state);
  if (options.mode === "full") {
    publishFullProof(recorder, evidenceDirectory, state);
  }
  return state.candidate.sha;
}

function createProofRecorder(evidenceDirectory, options) {
  return new EvidenceRecorder(evidenceDirectory, {
    mode: options.mode,
    phase: "manifest-validation",
    globalManifestEvidence: pendingGlobalManifestEvidence,
    expectedCandidateSha: options.expectedSha ?? null,
    candidate: null,
    manifests: [],
    requestedCoverage: options.mode === "full" ? rollbackGateCoverage : null,
  });
}

function recordCandidateAndManifests(recorder, options) {
  const candidate = recordCandidate(recorder, options.expectedSha);
  const manifests = recorder.stage(
    "candidate",
    "manifest-validation",
    () => validateManifestSet(readManifests()),
    (value) => ({ count: value.length, slices: value.map(({ sliceId }) => sliceId) }),
  );
  printManifestValidation(manifests);
  const manifestArtifacts = recordManifestArtifacts(recorder, manifests);
  return { candidate, manifests, manifestArtifacts };
}

function recordCandidate(recorder, expectedSha) {
  const sha = recorder.stage(
    "candidate",
    "exact-clean-candidate",
    () => assertExactCleanCandidate(repositoryRoot, expectedSha),
    (value) => ({ sha: value }),
  );
  recorder.run(
    "candidate",
    "complete-history-preflight",
    "/bin/bash",
    [
      join(repositoryRoot, "scripts/assert-complete-history.sh"),
      sha,
      rollbackBaselineSha,
    ],
    { cwd: repositoryRoot, phase: "preflight", timeout: 120_000 },
  );
  const inventory = recorder.stage(
    "candidate",
    "candidate-complete-inventory",
    () => trackedCandidateInventory(repositoryRoot, sha),
    inventoryFacts,
  );
  const artifact = recorder.writeArtifact("candidate-inventory.v1.json", inventory);
  recorder.update((document) => {
    document.candidate = {
      sha,
      tree: inventory.tree,
      inventorySha256: inventory.sha256,
      entryCount: inventory.entryCount,
      totalBytes: inventory.totalBytes,
      inventory: artifact,
    };
  });
  return { sha, inventory };
}

function recordManifestArtifacts(recorder, manifests) {
  const artifacts = new Map();
  recorder.update((document) => {
    for (const manifest of manifests) {
      const artifact = recorder.writeArtifact(
        "slices/" + manifest.sliceId + "/manifest.v1.json",
        manifest,
      );
      document.manifests.push({
        sliceId: manifest.sliceId,
        sha256: manifestFingerprint(manifest),
        artifact,
      });
      artifacts.set(manifest.sliceId, artifact);
    }
  });
  return artifacts;
}

function recordGlobalEnvironment(recorder) {
  const environment = recorder.stage(
    "candidate",
    "global-offline-environment-preflight",
    () => pinnedEnvironmentPreflight(repositoryRoot, {
      dockerPath: process.env.SLITHER_DOCKER_PATH ?? "/usr/bin/docker",
      execute(id, command, commandArguments, commandOptions) {
        return recorder.run(
          "candidate",
          id,
          command,
          commandArguments,
          { ...commandOptions, phase: "preflight" },
        ).stdout;
      },
    }),
    (result) => ({
      binaries: result.binaries,
      runtime: result.runtime,
      slitherImage: result.slitherImage,
      store: result.store,
      workspaceLinkCount: result.workspaceLinkCount,
    }),
  );
  recorder.update((document) => {
    document.globalEnvironment = environment;
  });
}

function recordManifestGitCoverage(recorder, state) {
  recorder.stage(
    "candidate",
    "manifest-git-coverage",
    () => validateManifestSet(state.manifests, { verifyGitCoverage: true }),
    (value) => ({ count: value.length }),
  );
  process.stdout.write(
    "rollback-manifest-coverage candidate=" + state.candidate.sha + " result=pass\n",
  );
}

function proveAllSlices(recorder, options, state) {
  for (const manifest of state.manifests) {
    proveSlice({
      manifest,
      manifestArtifact: state.manifestArtifacts.get(manifest.sliceId),
      candidateSha: state.candidate.sha,
      candidateInventory: state.candidate.inventory,
      recorder,
      runGates: options.mode === "full",
    });
  }
}

function finalizeRecordedProof(recorder, options, state) {
  revalidateCandidate(state.candidate, "final-candidate");
  if (options.mode === "full" && recorder.document.slices.some((slice) =>
    slice.status !== "passed" || slice.gateCoverage?.status !== "passed")) {
    throw new Error("ROLLBACK_GATE_COVERAGE_INCOMPLETE");
  }
  if (options.mode === "full") {
    recorder.update((document) => {
      document.globalManifestEvidence = completedGlobalManifestEvidence;
    });
  }
  recorder.finalize(options.mode === "prepare" ? "prepared" : "passed");
}

function publishFullProof(recorder, evidenceDirectory, state) {
  const statement = deterministicProofStatement(recorder.document);
  const publication = publishEvidenceSeal(
    evidenceDirectory,
    statement,
    join(repositoryRoot, "architecture/rollback/recovery-evidence.schema.json"),
  );
  validatePublishedProof(evidenceDirectory, state.candidate, true);
  publishReadyMarker(evidenceDirectory, publication);
  validatePublishedProof(evidenceDirectory, state.candidate, false);
}

function validatePublishedProof(evidenceDirectory, candidate, allowMissingReady) {
  const path = verifyEvidenceDirectory(evidenceDirectory);
  const argumentsList = [
    join(repositoryRoot, "scripts/rollback/validate-evidence.mjs"),
    "--bundle=" + path,
    "--expected-sha=" + candidate.sha,
  ];
  if (allowMissingReady) {
    argumentsList.push("--allow-missing-ready");
  }
  basicRun(join(repositoryRoot, ".tools", "bin", "node"), argumentsList, {
    cwd: repositoryRoot,
    timeout: 120_000,
  });
  verifyEvidenceDirectory(evidenceDirectory);
  revalidateCandidate(
    candidate,
    allowMissingReady ? "post-seal-validator-candidate" : "post-ready-validator-candidate",
  );
}

function printProofResult(options, candidateSha, evidenceDirectory) {
  process.stdout.write(
    (options.mode === "prepare" ? "rollback-preparation" : "rollback-proof")
    + " candidate=" + candidateSha
    + " slices=" + expectedSlices.join(",")
    + " result=" + (options.mode === "prepare" ? "prepared-not-proven" : "pass")
    + " evidence=" + evidenceDirectory + "\n",
  );
}

function inventoryFacts(inventory) {
  return {
    tree: inventory.tree,
    sha256: inventory.sha256,
    entryCount: inventory.entryCount,
    totalBytes: inventory.totalBytes,
  };
}
