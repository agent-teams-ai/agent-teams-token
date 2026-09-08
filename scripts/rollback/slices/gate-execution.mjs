import {
  lstatSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  abandonCleanupHandle,
  assertPinnedNodeRuntime,
  assertReportedPnpmStore,
  basicRun,
  cleanupIdentityBoundDirectory,
  pnpmOfflineInstallArguments,
  strictToolPaths,
  toolPath,
  trustedPnpmStore,
  validatePnpmWorkspaceLinks,
} from "../proof-runtime.mjs";
import { parseStrictTap } from "./gate-contract.mjs";
import { allowlistedChildEnvironment } from "../../toolchain-environment.mjs";
import {
  assertRollbackWorkspaceHandle,
  closeRollbackWorkspaceHandle,
} from "./workspace-handle.mjs";

function runPnpm(recorder, group, id, tools, ...execution) {
  const [root, environment, commandArguments, timeout = 600_000] = execution;
  return recorder.run(group, id, tools.pnpm, commandArguments, {
    cwd: root,
    env: environment,
    phase: "gate",
    timeout,
  });
}

function pinnedSlitherImage(root) {
  const lockPath = join(root, "tooling/toolchain.lock.json");
  const lockEntry = lstatSync(lockPath);
  if (!lockEntry.isFile() || lockEntry.isSymbolicLink()) {
    throw new Error("ROLLBACK_SLITHER_LOCK_UNSAFE");
  }
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const image = lock.securityImages?.slither;
  if (image === null || typeof image !== "object" || Array.isArray(image)
    || typeof image.repository !== "string" || !/^ghcr\.io\/[a-z0-9/_-]+$/u.test(image.repository)
    || typeof image.tag !== "string" || !/^[a-z0-9._-]+$/u.test(image.tag)
    || typeof image.manifestDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(image.manifestDigest)
    || typeof image.sourceRevision !== "string" || !/^[a-f0-9]{40}$/u.test(image.sourceRevision)
    || image.platform !== "linux/amd64") {
    throw new Error("ROLLBACK_SLITHER_LOCK_INVALID");
  }
  return {
    reference: image.repository + ":" + image.tag + "@" + image.manifestDigest,
    repositoryDigest: image.repository + "@" + image.manifestDigest,
    manifestDigest: image.manifestDigest,
    sourceRevision: image.sourceRevision,
    platform: image.platform,
  };
}

function assertPinnedSlitherImageInspection(raw, pinned) {
  let image;
  try {
    image = JSON.parse(raw);
  } catch {
    throw new Error("ROLLBACK_SLITHER_IMAGE_INSPECTION_INVALID");
  }
  const repositoryDigests = Array.isArray(image?.RepoDigests) ? image.RepoDigests : [];
  if (image?.Os !== "linux" || image?.Architecture !== "amd64"
    || !repositoryDigests.includes(pinned.repositoryDigest)
    || image?.Config?.Labels?.["org.opencontainers.image.revision"] !== pinned.sourceRevision) {
    throw new Error("ROLLBACK_SLITHER_IMAGE_CACHE_MISMATCH");
  }
  return {
    manifestDigest: pinned.manifestDigest,
    sourceRevision: pinned.sourceRevision,
    platform: pinned.platform,
  };
}

function directPreflightCommand(_id, command, arguments_, options) {
  return basicRun(command, arguments_, options);
}

export function pinnedEnvironmentPreflight(root, {
  dockerPath,
  execute = directPreflightCommand,
} = {}) {
  const runtime = assertPinnedNodeRuntime(root);
  const bootstrapEnvironment = allowlistedChildEnvironment(process.env, {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/lib/git-core",
  });
  execute("bootstrap-core-cache-verify", "/bin/bash", [
    "./dev", "bootstrap", "verify", "--offline",
  ], { cwd: root, env: bootstrapEnvironment, timeout: 600_000 });
  execute("bootstrap-solana-cache-verify", "/bin/bash", [
    "./dev", "bootstrap", "verify", "--offline", "--scope=solana",
  ], { cwd: root, env: bootstrapEnvironment, timeout: 600_000 });
  const tools = strictToolPaths(root, {
    requireSolana: true,
    requireDocker: true,
    dockerPath,
  });
  const commandEnvironment = allowlistedChildEnvironment(process.env, { PATH: toolPath(tools) });
  const trustedStore = trustedPnpmStore(join(root, ".tools", "pnpm-store"));
  const requestedStore = execute(
    "pnpm-store-path",
    tools.pnpm,
    ["--agtmai-trusted-store=" + trustedStore, "store", "path", "--silent"],
    { cwd: root, env: commandEnvironment, timeout: 30_000 },
  ).trim();
  assertReportedPnpmStore(trustedStore, requestedStore);
  execute(
    "pnpm-frozen-offline-completeness",
    tools.pnpm,
    pnpmOfflineInstallArguments(trustedStore),
    { cwd: root, env: commandEnvironment, timeout: 600_000 },
  );
  const links = validatePnpmWorkspaceLinks(root);
  const pinned = pinnedSlitherImage(root);
  const inspection = execute("slither-pinned-image-cache", tools.docker, [
    "image",
    "inspect",
    pinned.reference,
    "--format",
    "{{json .}}",
  ], {
    cwd: root,
    env: allowlistedChildEnvironment(process.env, { PATH: "/usr/bin:/bin" }),
    timeout: 30_000,
  });
  return {
    runtime,
    binaries: Object.keys(tools).toSorted(),
    store: trustedStore,
    workspaceLinkCount: links.length,
    slitherImage: assertPinnedSlitherImageInspection(inspection, pinned),
  };
}

export function preflightPinnedEnvironment(root, {
  dockerPath = process.env.SLITHER_DOCKER_PATH ?? "/usr/bin/docker",
} = {}) {
  return pinnedEnvironmentPreflight(root, { dockerPath });
}

export function preflightPinnedSlitherImage(root, {
  dockerPath = process.env.SLITHER_DOCKER_PATH ?? "/usr/bin/docker",
} = {}) {
  const tools = strictToolPaths(root, {
    requireSolana: true,
    requireDocker: true,
    dockerPath,
  });
  const pinned = pinnedSlitherImage(root);
  const inspection = basicRun(tools.docker, [
    "image", "inspect", pinned.reference, "--format", "{{json .}}",
  ], {
    cwd: root,
    env: allowlistedChildEnvironment(process.env, { PATH: "/usr/bin:/bin" }),
    timeout: 30_000,
  });
  return assertPinnedSlitherImageInspection(inspection, pinned);
}

export function preflightQualityGateEnvironment(root, manifest, recorder, group) {
  const requiresSlither = manifest.survivingGates.includes("slither");
  const tools = recorder.stage(
    group,
    "quality-gate-tool-cache-preflight",
    () => strictToolPaths(root, {
      requireSolana: true,
      requireDocker: requiresSlither,
      dockerPath: process.env.SLITHER_DOCKER_PATH ?? "/usr/bin/docker",
    }),
    (value) => ({
      binaries: Object.keys(value).toSorted(),
      slitherImageRequired: requiresSlither,
    }),
  );
  if (requiresSlither) {
    const pinned = recorder.stage(
      group,
      "slither-pinned-image-lock-preflight",
      () => pinnedSlitherImage(root),
      ({ manifestDigest, sourceRevision, platform }) => ({ manifestDigest, sourceRevision, platform }),
    );
    const inspection = recorder.run(
      group,
      "slither-pinned-image-cache-preflight",
      tools.docker,
      ["image", "inspect", pinned.reference, "--format", "{{json .}}"],
      {
        cwd: root,
        env: allowlistedChildEnvironment(process.env, { PATH: "/usr/bin:/bin" }),
        phase: "preflight",
        timeout: 30_000,
      },
    );
    recorder.stage(
      group,
      "slither-pinned-image-identity-preflight",
      () => assertPinnedSlitherImageInspection(inspection.stdout, pinned),
      (result) => result,
    );
  }
  return tools;
}

export function runCommonGates(root, recorder, group, tools, environment) {
  recorder.run(group, "doctor-core", join(root, "dev"), ["doctor", "--scope=core"], {
    cwd: root,
    env: environment,
    phase: "gate",
    timeout: 600_000,
  });
  for (const [id, script] of [
    ["foundation-assert-dev-only", "foundation:assert-dev-only"],
    ["foundation-assert-registry", "foundation:assert-registry"],
    ["foundation-check", "foundation:check"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["build", "build"],
    ["package-tests", "test"],
    ["linux-parity", "test:linux-parity"],
    ["genesis-vector", "genesis:vector:check"],
    ["security-check", "security:check"],
    ["local-evm-unit", "test:local-evm"],
    ["local-evm-integration", "test:local-evm:integration"],
    ["genesis-local-verifier", "genesis:verify:local"],
  ]) {
    runPnpm(recorder, group, id, tools, root, environment, [script]);
  }

  const contracts = join(root, "contracts/evm");
  recorder.run(group, "forge-format", tools.forge, ["fmt", "--check"], {
    cwd: contracts,
    env: environment,
    phase: "gate",
    timeout: 120_000,
  });
  recorder.run(group, "forge-build", tools.forge, [
    "build", "--offline", "--no-auto-detect", "--sizes", "--use", tools.solc,
  ], { cwd: contracts, env: environment, phase: "gate", timeout: 300_000 });
  const foundryEnvironment = { ...environment, FOUNDRY_PROFILE: "ci" };
  recorder.run(group, "forge-unit-fuzz", tools.forge, [
    "test",
    "--offline",
    "--no-auto-detect",
    "--no-match-path",
    "test/invariant/**",
    "--use",
    tools.solc,
  ], { cwd: contracts, env: foundryEnvironment, phase: "gate", timeout: 600_000 });
  recorder.run(group, "forge-invariants", tools.forge, [
    "test",
    "--offline",
    "--no-auto-detect",
    "--match-path",
    "test/invariant/**",
    "--use",
    tools.solc,
  ], { cwd: contracts, env: foundryEnvironment, phase: "gate", timeout: 600_000 });
  recorder.run(group, "forge-gas-size", tools.forge, [
    "test",
    "--offline",
    "--no-auto-detect",
    "--gas-report",
    "--match-test",
    "testWorstCase32AllocationsFitsLocalBlockAndCodeLimits",
    "--use",
    tools.solc,
    "-vvvv",
  ], { cwd: contracts, env: environment, phase: "gate", timeout: 600_000 });
}

export function runSurvivorGate({
  survivor,
  root,
  rollbackSha,
  recorder,
  group,
  tools,
  environment,
}) {
  if (survivor === "local-solana") {
    recorder.run(group, "solana-offline-toolchain-verify", "/bin/bash", [
      "./dev", "bootstrap", "verify", "--offline", "--scope=solana",
    ], { cwd: root, env: environment, phase: "gate", timeout: 600_000 });
    const strictEnvironment = {
      ...environment,
      AGTMAI_SOLANA_REAL_TESTS_REQUIRED: "1",
    };
    runPnpm(
      recorder,
      group,
      "solana-unit-and-strict-real",
      tools,
      root,
      strictEnvironment,
      ["test:local-solana"],
      900_000,
    );
    const output = join(recorder.prepareSurvivorDirectory("local-solana"), group);
    runPnpm(
      recorder,
      group,
      "solana-real-fixture",
      tools,
      root,
      strictEnvironment,
      ["solana:fixture:local", "--", "--output", output],
      900_000,
    );
    return;
  }

  if (survivor === "deployment-plan") {
    runPnpm(
      recorder,
      group,
      "deployment-unit-suite",
      tools,
      root,
      environment,
      ["test:deployment-plan"],
      900_000,
    );
    const requiredTitle = "real loopback Anvil estimates freshly built exact AGTMAIToken initcode within tolerance";
    const result = recorder.run(
      group,
      "deployment-strict-anvil",
      tools.node,
      [
        "--test",
        "--test-reporter=tap",
        "tooling/deployment-plan/tests/anvil.integration.test.ts",
      ],
      { cwd: root, env: environment, phase: "gate", timeout: 900_000 },
    );
    try {
      result.entry.validation = parseStrictTap(result.stdout, requiredTitle);
      recorder.update(() => {});
    } catch (error) {
      result.entry.status = "failed";
      result.entry.validation = {
        kind: "node-tap-no-skip",
        requiredTitle,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      recorder.update(() => {});
      throw error;
    }
    return;
  }

  if (survivor === "slither") {
    if (tools.docker === undefined) {
      throw new Error("ROLLBACK_SLITHER_PREFLIGHT_MISSING");
    }
    const slitherTools = tools;
    runPnpm(recorder, group, "slither-unit", slitherTools, root, environment, ["security:slither:test"]);
    const output = join(recorder.prepareSurvivorDirectory("slither"), group);
    const slitherEnvironment = {
      ...environment,
      GITHUB_SHA: rollbackSha,
      PATH: toolPath(slitherTools),
      SLITHER_CANDIDATE_SHA: rollbackSha,
      SLITHER_DOCKER_PATH: slitherTools.docker,
      SLITHER_EVIDENCE_DIRECTORY: output,
      SLITHER_FORGE_PATH: slitherTools.forge,
      SLITHER_REPOSITORY_ROOT: root,
      SLITHER_SOLC_PATH: slitherTools.solc,
    };
    runPnpm(
      recorder,
      group,
      "slither-real-analyzer",
      slitherTools,
      root,
      slitherEnvironment,
      ["security:solidity"],
      900_000,
    );
    recorder.run(
      group,
      "slither-evidence-validate",
      slitherTools.node,
      ["tooling/security/slither/src/composition/validate-evidence.ts"],
      { cwd: root, env: slitherEnvironment, phase: "gate", timeout: 120_000 },
    );
    return;
  }
  throw new Error("ROLLBACK_UNKNOWN_SURVIVOR_GATE gate=" + survivor);
}

function combineRollbackFailures(first, second, message) {
  return first === undefined ? second : new AggregateError([first, second], message, { cause: first });
}

export function finalizeRollbackTemporaryParent({
  cleanupHandle,
  workspaceHandle,
  primaryFailure,
}) {
  let effectivePrimaryFailure = primaryFailure;
  let cleanupFailure;
  let cleanup;
  if (workspaceHandle !== undefined) {
    try {
      assertRollbackWorkspaceHandle(workspaceHandle);
    } catch (error) {
      effectivePrimaryFailure = combineRollbackFailures(
        effectivePrimaryFailure,
        error,
        "rollback proof and persistent workspace identity validation both failed",
      );
    }
  }
  try {
    if (effectivePrimaryFailure !== undefined) {
      cleanup = {
        status: "preserved",
        result: abandonCleanupHandle(cleanupHandle),
      };
    } else {
      cleanup = {
        status: "passed",
        result: cleanupIdentityBoundDirectory(cleanupHandle, workspaceHandle === undefined ? {} : {
          onBoundary(details) {
            if (details.stage === "before-target-quarantine") {
              assertRollbackWorkspaceHandle(workspaceHandle);
            }
          },
        }),
      };
    }
  } catch (error) {
    cleanupFailure = error;
    cleanup = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    closeRollbackWorkspaceHandle(workspaceHandle);
  } catch (error) {
    cleanupFailure = combineRollbackFailures(
      cleanupFailure,
      error,
      "rollback cleanup and workspace finalization both failed",
    );
    cleanup = {
      ...cleanup,
      status: "failed",
      error: cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure),
    };
  }
  return { cleanup, cleanupFailure, primaryFailure: effectivePrimaryFailure };
}
