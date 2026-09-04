import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";

import {
  assertExactCleanCandidate,
  assertInventoryEqual,
  basicRun,
  gitExecutable,
  trackedCandidateInventory,
} from "../runtime/candidate.mjs";
import {
  assertCustodyIdentity,
  custodyIdentity,
} from "../runtime/custody.mjs";
import { toolPath } from "../runtime/offline-environment.mjs";
import { repositoryRoot } from "./config.mjs";
import { validateExactPath } from "./manifests.mjs";
import {
  snapshotRollbackSharedPaths,
} from "./shared-paths.mjs";
import {
  assertRollbackPathAbsentFromCheckout,
  readRollbackSharedBytes,
} from "./shared-file-operations.mjs";
import {
  assertRollbackWorkspaceHandle,
} from "./workspace-handle.mjs";
import { allowlistedChildEnvironment } from "../../toolchain-environment.mjs";

function run(command, commandArguments, options = {}) {
  return basicRun(command === "git" ? gitExecutable() : command, commandArguments, {
    ...options,
    cwd: options.cwd ?? repositoryRoot,
  });
}

export function verifyAppliedState(root, manifest, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => key !== "workspaceHandle")) {
    throw new Error("ROLLBACK_VERIFY_OPTIONS_INVALID");
  }
  const { workspaceHandle } = options;
  const restoredPlan = snapshotRollbackSharedPaths(
    root,
    manifest.restoreFromBaseline,
    workspaceHandle,
  );
  for (const path of manifest.ownedPaths) {
    assertRollbackPathAbsentFromCheckout(root, path, workspaceHandle);
  }
  for (const path of manifest.restoreFromBaseline) {
    const expected = run("git", ["show", manifest.baselineSha + ":" + path], { cwd: root });
    const actual = readRollbackSharedBytes(root, path, restoredPlan, workspaceHandle)
      ?.toString("utf8");
    if (actual !== expected) {
      throw new Error("ROLLBACK_BASELINE_RESTORE_MISMATCH path=" + path);
    }
  }

  assertRollbackWorkspaceHandle(workspaceHandle, root);
  const raw = run("git", [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ], { cwd: root });
  const records = raw.split("\0").filter(Boolean);
  const actualPaths = [];
  for (const record of records) {
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path || status.includes("R") || status.includes("C")
      || (status !== "??" && (status[0] !== " " || !["M", "D"].includes(status[1])))) {
      throw new Error("ROLLBACK_UNEXPECTED_STATUS status=" + JSON.stringify(status));
    }
    validateExactPath(path, manifest.sliceId + ":appliedStatus");
    actualPaths.push(path);
  }
  const expectedPaths = [...new Set([...manifest.ownedPaths, ...manifest.sharedPaths])].toSorted();
  if (JSON.stringify(actualPaths.toSorted()) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      "ROLLBACK_APPLIED_STATUS_COVERAGE slice=" + manifest.sliceId
      + " expected=" + expectedPaths.length + " actual=" + actualPaths.length,
    );
  }
  assertRollbackWorkspaceHandle(workspaceHandle, root);
}

export const rollbackGateCoverage = Object.freeze({
  common: [
    "doctor-core",
    "foundation-assert-dev-only",
    "foundation-assert-registry",
    "foundation-check",
    "lint",
    "typecheck",
    "build",
    "package-tests",
    "linux-parity",
    "genesis-vector",
    "security-check",
    "local-evm-unit",
    "local-evm-integration",
    "genesis-local-verifier",
    "forge-format",
    "forge-build",
    "forge-unit-fuzz",
    "forge-invariants",
    "forge-gas-size",
  ],
  survivors: {
    "local-solana": [
      "solana-offline-toolchain-verify",
      "solana-unit-and-strict-real",
      "solana-real-fixture",
    ],
    "deployment-plan": ["deployment-unit-suite", "deployment-strict-anvil"],
    slither: ["slither-unit", "slither-real-analyzer", "slither-evidence-validate"],
  },
});

export function expectedGateIds(manifest) {
  const survivorIds = manifest.survivingGates.flatMap((survivor) => {
    const gates = rollbackGateCoverage.survivors[survivor];
    if (gates === undefined) {
      throw new Error("ROLLBACK_UNKNOWN_SURVIVOR_GATE gate=" + survivor);
    }
    return gates;
  });
  return [...rollbackGateCoverage.common, ...survivorIds];
}

export function gateCoverageSnapshot(commands, manifest) {
  const expected = expectedGateIds(manifest);
  const entries = commands.filter((entry) =>
    entry.group === manifest.sliceId && entry.phase === "gate");
  const executed = entries.map(({ id }) => id);
  const counts = new Map();
  for (const id of executed) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const missing = expected.filter((id) => !counts.has(id));
  const unexpected = executed.filter((id) => !expected.includes(id));
  const duplicates = [...counts].filter(([, count]) => count !== 1).map(([id]) => id);
  const failed = entries.filter(({ status }) => status !== "passed").map(({ id }) => id);
  const ordered = JSON.stringify(executed) === JSON.stringify(expected);
  return {
    expected,
    executed,
    missing,
    unexpected,
    duplicates,
    failed,
    ordered,
    status: missing.length === 0 && unexpected.length === 0
      && duplicates.length === 0 && failed.length === 0 && ordered ? "passed" : "failed",
  };
}

export function parseStrictTap(stdout, requiredTitle) {
  const title = requiredTitle.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const titles = [...stdout.matchAll(new RegExp(`^# Subtest: ${title}$`, "gmu"))];
  const successfulTitles = [...stdout.matchAll(new RegExp(`^ok [0-9]+ - ${title}$`, "gmu"))];
  const summary = {};
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const values = [...stdout.matchAll(new RegExp(`^# ${key} ([0-9]+)$`, "gmu"))];
    if (values.length !== 1) {
      throw new Error("ROLLBACK_STRICT_TAP_SUMMARY_INVALID field=" + key);
    }
    summary[key] = Number(values[0][1]);
  }
  if (titles.length !== 1 || successfulTitles.length !== 1
    || summary.tests < 1 || summary.pass !== summary.tests
    || [summary.fail, summary.cancelled, summary.skipped, summary.todo]
      .some((value) => value !== 0)
    || /# SKIP\b/imu.test(stdout)) {
    throw new Error("ROLLBACK_STRICT_TEST_SKIPPED_OR_MISSING title=" + requiredTitle);
  }
  return {
    kind: "node-tap-no-skip",
    requiredTitle,
    requiredTitleCount: titles.length,
    successfulTitleCount: successfulTitles.length,
    ...summary,
    status: "passed",
  };
}

export function materializeCandidateCheckout({
  checkout,
  candidateSha,
  candidateInventory,
  recorder,
  group,
}) {
  const git = gitExecutable();
  recorder.run(group, "clone-candidate", git, [
    "clone",
    "--local",
    "--no-hardlinks",
    "--no-checkout",
    repositoryRoot,
    checkout,
  ], { cwd: repositoryRoot, timeout: 600_000 });
  recorder.run(group, "checkout-candidate", git, [
    "-c",
    "core.hooksPath=/dev/null",
    "checkout",
    "--detach",
    "--force",
    candidateSha,
  ], { cwd: checkout, timeout: 120_000 });
  recorder.stage(
    group,
    "checkout-clean-candidate-binding",
    () => assertExactCleanCandidate(checkout, candidateSha),
    (sha) => ({ sha }),
  );
  const checkoutInventory = recorder.stage(
    group,
    "checkout-complete-inventory",
    () => trackedCandidateInventory(checkout, candidateSha),
    (inventory) => ({
      tree: inventory.tree,
      sha256: inventory.sha256,
      entryCount: inventory.entryCount,
      totalBytes: inventory.totalBytes,
    }),
  );
  recorder.stage(
    group,
    "checkout-inventory-equality",
    () => assertInventoryEqual(candidateInventory, checkoutInventory, group),
  );
  return checkoutInventory;
}

function exactSliceTransitionPaths(manifest) {
  return [...new Set([...manifest.ownedPaths, ...manifest.sharedPaths])].toSorted();
}

export function applyExactSliceState(root, manifest, candidateSha, candidateTree, ...recording) {
  const [recorder, group] = recording;
  const git = gitExecutable();
  const expectedPaths = exactSliceTransitionPaths(manifest);
  const rawChangedPaths = recorder.run(group, "identify-exact-slice-delta", git, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    "HEAD",
    candidateSha,
    "--",
  ], { cwd: root, timeout: 60_000 }).stdout;
  const actualPaths = rawChangedPaths.split("\0").filter(Boolean).toSorted();
  for (const path of actualPaths) {
    validateExactPath(path, manifest.sliceId + ":sliceDelta");
  }
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw new Error(
      "ROLLBACK_SLICE_DELTA_COVERAGE slice=" + manifest.sliceId
      + " expected=" + expectedPaths.length + " actual=" + actualPaths.length,
    );
  }
  recorder.run(group, "apply-exact-slice", git, [
    "restore",
    "--source=" + candidateSha,
    "--staged",
    "--worktree",
    "--",
    ...expectedPaths,
  ], { cwd: root, timeout: 120_000 });
  const appliedTree = recorder.run(group, "git-write-applied-slice-tree", git, ["write-tree"], {
    cwd: root,
    timeout: 60_000,
  }).stdout.trim();
  if (appliedTree !== candidateTree) {
    throw new Error(
      "ROLLBACK_APPLIED_SLICE_TREE_MISMATCH slice=" + manifest.sliceId
      + " expected=" + candidateTree + " actual=" + appliedTree,
    );
  }
  return {
    tree: appliedTree,
    pathCount: expectedPaths.length,
    pathsSha256: createHash("sha256")
      .update(Buffer.from(JSON.stringify(expectedPaths), "utf8"))
      .digest("hex"),
  };
}

export function syntheticRollbackCommit(root, manifest, candidateSha, recorder, group) {
  const git = gitExecutable();
  stageExactWorktreePaths(
    root,
    exactSliceTransitionPaths(manifest),
    recorder,
    group,
    "rollback-state",
  );
  const tree = recorder.run(group, "git-write-rollback-tree", git, ["write-tree"], {
    cwd: root,
    timeout: 60_000,
  }).stdout.trim();
  const identityEnvironment = allowlistedChildEnvironment(process.env, {
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_AUTHOR_EMAIL: "rollback-proof@invalid.example",
    GIT_AUTHOR_NAME: "AGTMAI Rollback Proof",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_EMAIL: "rollback-proof@invalid.example",
    GIT_COMMITTER_NAME: "AGTMAI Rollback Proof",
  });
  const sha = recorder.run(group, "git-commit-rollback-tree", git, [
    "commit-tree",
    tree,
    "-p",
    candidateSha,
    "-m",
    "test(rollback): capture pre-state before " + manifest.sliceId,
  ], { cwd: root, env: identityEnvironment, timeout: 60_000 }).stdout.trim();
  recorder.run(group, "git-reset-rollback-state", git, ["reset", "--hard", sha], {
    cwd: root,
    timeout: 60_000,
  });
  recorder.stage(
    group,
    "synthetic-clean-identity",
    () => assertExactCleanCandidate(root, sha),
    (actualSha) => ({ sha: actualSha, tree }),
  );
  return { sha, tree };
}

function captureStagingEntry(root, logicalPath) {
  const path = join(root, logicalPath);
  const before = custodyIdentity(lstatSync(path, { bigint: true }));
  if (before.kind === "file") {
    if (before.nlink !== 1n) throw new Error(`ROLLBACK_STAGE_NLINK_UNSAFE path=${logicalPath}`);
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assertCustodyIdentity(before, fstatSync(descriptor, { bigint: true }));
      assertCustodyIdentity(before, lstatSync(path, { bigint: true }));
      const bytes = readFileSync(descriptor);
      assertCustodyIdentity(before, fstatSync(descriptor, { bigint: true }));
      assertCustodyIdentity(before, lstatSync(path, { bigint: true }));
      return {
        assertCurrent() {
          assertCustodyIdentity(before, fstatSync(descriptor, { bigint: true }));
          assertCustodyIdentity(before, lstatSync(path, { bigint: true }));
        },
        bytes,
        close() { closeSync(descriptor); },
        mode: (before.mode & 0o111n) === 0n ? "100644" : "100755",
      };
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }
  if (before.kind === "symlink") {
    const bytes = readlinkSync(path, { encoding: "buffer" });
    const assertCurrent = () => {
      assertCustodyIdentity(before, lstatSync(path, { bigint: true }));
      const repeated = readlinkSync(path, { encoding: "buffer" });
      assertCustodyIdentity(before, lstatSync(path, { bigint: true }));
      if (!bytes.equals(repeated)) throw new Error(`ROLLBACK_STAGE_SYMLINK_CHANGED path=${logicalPath}`);
    };
    assertCurrent();
    return { assertCurrent, bytes, close() {}, mode: "120000" };
  }
  throw new Error(`ROLLBACK_STAGE_ENTRY_UNSUPPORTED path=${logicalPath}`);
}

export function stageExactWorktreePaths(root, paths, recorder, group, label) {
  const git = gitExecutable();
  let index = 0;
  for (const path of [...paths].toSorted()) {
    validateExactPath(path, group + ":" + label);
    index += 1;
    let staged;
    try {
      staged = captureStagingEntry(root, path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      recorder.run(group, `${label}-remove-${index}`, git, [
        "update-index", "--force-remove", "--", path,
      ], { cwd: root, timeout: 60_000 });
      continue;
    }
    try {
      staged.assertCurrent();
      const oid = recorder.run(group, `${label}-hash-${index}`, git, [
        "hash-object", "-w", "--no-filters", "--stdin",
      ], { cwd: root, input: staged.bytes, timeout: 60_000 }).stdout.trim();
      staged.assertCurrent();
      if (!/^[a-f0-9]{40}$/u.test(oid)) {
        throw new Error(`ROLLBACK_STAGE_OBJECT_INVALID path=${path}`);
      }
      staged.assertCurrent();
      recorder.run(group, `${label}-index-${index}`, git, [
        "update-index", "--add", "--cacheinfo", staged.mode, oid, path,
      ], { cwd: root, timeout: 60_000 });
      staged.assertCurrent();
    } finally {
      staged.close();
    }
  }
}

export function gateEnvironment(root, gateTemporaryDirectory, tools) {
  const privateHome = join(gateTemporaryDirectory, "home");
  const xdgCache = join(gateTemporaryDirectory, "xdg-cache");
  const xdgConfig = join(gateTemporaryDirectory, "xdg-config");
  const xdgData = join(gateTemporaryDirectory, "xdg-data");
  const xdgRuntime = join(gateTemporaryDirectory, "xdg-runtime");
  for (const path of [privateHome, xdgCache, xdgConfig, xdgData, xdgRuntime]) {
    mkdirSync(path, { mode: 0o700 });
  }
  return allowlistedChildEnvironment(process.env, {
    AGTMAI_ANVIL_BINARY: tools.anvil,
    AGTMAI_FORGE_BINARY: tools.forge,
    AGTMAI_SOLC_BINARY: tools.solc,
    ALLOW_MAINNET_BROADCAST: "false",
    ALLOW_PUBLIC_NETWORK: "false",
    CI: "1",
    ENABLE_PUBLIC_RPC: "false",
    HOME: privateHome,
    LANG: "C",
    LC_ALL: "C",
    MAINNET_ENABLED: "false",
    PATH: toolPath(tools),
    TMPDIR: gateTemporaryDirectory,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_RUNTIME_DIR: xdgRuntime,
  });
}
