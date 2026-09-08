import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  parseSourceDependencyPolicy,
  readAndValidateToolingBoundaryPolicy,
  validateToolingBoundaryPolicy,
} from "../tooling-boundaries.mjs";
import { basicRun, gitExecutable } from "../rollback/runtime/candidate.mjs";
import { rollbackBaselineSha } from "../rollback/slices/config.mjs";
import { restoreArchitectureBoundarySource } from "../rollback/slices/transforms.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const policyPath = resolve(repositoryRoot, "architecture/foundation/source-dependencies.yaml");

function normalPolicySource() {
  const source = readFileSync(policyPath, "utf8");
  // This retained test also runs after Slither rollback. Reintroduce only the
  // concrete adapter declaration to exercise normal-state rejection there.
  return source.replace(
    "      - tooling/security/slither/src/adapters\n    entrypoints: []",
    "      - tooling/security/slither/src/adapters\n    entrypoints:\n      - tooling/security/slither/src/adapters/validated-environment.ts",
  ).replace(
    "      boundaries:\n        - tooling.slither.application\n",
    "      boundaries:\n        - tooling.execution-environment\n        - tooling.slither.application\n",
  );
}

function baselinePolicySource() {
  return basicRun(gitExecutable(), [
    "show", `${rollbackBaselineSha}:architecture/foundation/source-dependencies.yaml`,
  ], { cwd: repositoryRoot });
}

async function foundationChangedWorkflow() {
  const packagePath = await realpath(resolve(
    repositoryRoot,
    "node_modules/@agent-teams/engineering-foundation/package.json",
  ));
  const foundationRoot = dirname(packagePath);
  const [{ loadAgentWorkflowPolicy }, { runChangedAgentWorkflow }] = await Promise.all([
    import(pathToFileURL(join(
      foundationRoot,
      "dist/capabilities/repository-agent-workflow/contract/config.js",
    )).href),
    import(pathToFileURL(join(
      foundationRoot,
      "dist/capabilities/repository-agent-workflow/application/use-cases/run-changed-agent-workflow.js",
    )).href),
  ]);
  return { loadAgentWorkflowPolicy, runChangedAgentWorkflow };
}

test("committed policy has the exact three tooling DAGs and shared execution boundary", () => {
  const policy = readAndValidateToolingBoundaryPolicy(policyPath);
  assert.equal(Object.keys(policy.boundaries).length, 13);
  assert.deepEqual(policy.boundaries["tooling.execution-environment"], []);
});

test("normal Slither requires exactly the execution-environment adapter edge", () => {
  const policy = parseSourceDependencyPolicy(normalPolicySource());
  assert.doesNotThrow(() => validateToolingBoundaryPolicy(policy));
  assert.deepEqual(policy.boundaries["tooling.slither.adapters"], [
    "tooling.execution-environment", "tooling.slither.application", "tooling.slither.domain",
  ]);
  const forged = structuredClone(policy);
  forged.boundaries["tooling.slither.adapters"].shift();
  forged.slitherRolledBack = true;
  assert.throws(() => validateToolingBoundaryPolicy(forged),
    /TOOLING_BOUNDARY_ALLOW_MISMATCH boundary=tooling.slither.adapters/);
  assert.throws(() => readAndValidateSource(normalPolicySource().replace(
    "        - tooling.execution-environment\n", "",
  )), /TOOLING_BOUNDARY_ALLOW_MISMATCH boundary=tooling.slither.adapters/);
});

function readAndValidateSource(source) {
  const policy = parseSourceDependencyPolicy(source);
  validateToolingBoundaryPolicy(policy);
  return policy;
}

test("all three production boundary reversals retain the shared root and exact survivor edges", () => {
  const source = normalPolicySource();
  const candidate = readAndValidateSource(source);
  const baseline = baselinePolicySource();
  for (const slice of ["local-solana", "deployment-plan", "slither"]) {
    const restored = readAndValidateSource(restoreArchitectureBoundarySource(source, baseline, slice));
    const expected = structuredClone(candidate.boundaries);
    if (slice === "slither") {
      expected["tooling.slither.adapters"] = ["tooling.slither.application", "tooling.slither.domain"];
    }
    assert.deepEqual(restored.boundaries, expected, slice);
    assert.deepEqual(restored.governedRoots, candidate.governedRoots, slice);
    assert.equal(Object.keys(restored.boundaries).length, 13, slice);
  }
});

test("only all four exact pinned Slither baseline declarations authorize its rollback DAG", () => {
  const source = normalPolicySource();
  const baseline = baselinePolicySource();
  const restoredSource = restoreArchitectureBoundarySource(source, baseline, "slither");
  const restored = readAndValidateSource(restoredSource);
  assert.deepEqual(restored.boundaries["tooling.slither.adapters"], [
    "tooling.slither.application", "tooling.slither.domain",
  ]);
  for (const layer of ["domain", "application", "adapters", "composition"]) {
    const changed = restoredSource.replace(
      `      - tooling/security/slither/src/${layer}\n    entrypoints: []`,
      `      - tooling/security/slither/src/${layer}\n    entrypoints:\n      - tooling/security/slither/src/${layer}/forged.ts`,
    );
    assert.notEqual(changed, restoredSource, layer);
    assert.throws(() => readAndValidateSource(changed),
      /TOOLING_BOUNDARY_ALLOW_MISMATCH boundary=tooling.slither.adapters/, layer);
  }
  const forged = structuredClone(restored);
  forged.boundaries["tooling.slither.adapters"].push("tooling.execution-environment");
  assert.throws(() => validateToolingBoundaryPolicy(forged),
    /TOOLING_BOUNDARY_ALLOW_MISMATCH boundary=tooling.slither.adapters/);
});

test("normal and Slither rollback reject every missing or extra edge, ID and required root", () => {
  const source = normalPolicySource();
  for (const state of [source, restoreArchitectureBoundarySource(source, baselinePolicySource(), "slither")]) {
    const policy = readAndValidateSource(state);
    for (const [id, edges] of Object.entries(policy.boundaries)) {
      for (const changedEdges of [[...edges, "tooling.unexpected"], ...edges.map((_, index) =>
        edges.filter((__, edgeIndex) => edgeIndex !== index))]) {
        const forged = structuredClone(policy);
        forged.boundaries[id] = changedEdges;
        assert.throws(() => validateToolingBoundaryPolicy(forged), /TOOLING_BOUNDARY_ALLOW_MISMATCH/, id);
      }
      const missing = structuredClone(policy);
      delete missing.boundaries[id];
      assert.throws(() => validateToolingBoundaryPolicy(missing), /TOOLING_BOUNDARY_IDS_MISMATCH/, id);
    }
    const extra = structuredClone(policy);
    extra.boundaries["tooling.unexpected"] = [];
    assert.throws(() => validateToolingBoundaryPolicy(extra), /TOOLING_BOUNDARY_IDS_MISMATCH/);
    for (const root of ["tooling/local-solana/src", "tooling/deployment-plan/src",
      "tooling/security/slither/src", "scripts/execution-environment"]) {
      const forged = structuredClone(policy);
      forged.governedRoots = forged.governedRoots.filter((value) => value !== root);
      assert.throws(() => validateToolingBoundaryPolicy(forged), /TOOLING_BOUNDARY_ROOT_MISSING/, root);
    }
    assert.throws(() => parseSourceDependencyPolicy(state + "  - id: tooling.execution-environment\n"),
      /TOOLING_BOUNDARY_ID_DUPLICATE/);
  }
});

test("domain depending on an adapter fails closed", () => {
  const policy = readAndValidateToolingBoundaryPolicy(policyPath);
  const forged = structuredClone(policy);
  forged.boundaries["tooling.local-solana.domain"].push("tooling.local-solana.adapters");
  assert.throws(
    () => validateToolingBoundaryPolicy(forged),
    /TOOLING_BOUNDARY_ALLOW_MISMATCH boundary=tooling.local-solana.domain/,
  );
});

test("application losing its domain dependency fails closed", () => {
  const policy = readAndValidateToolingBoundaryPolicy(policyPath);
  const forged = structuredClone(policy);
  forged.boundaries["tooling.deployment-plan.application"] = [];
  assert.throws(
    () => validateToolingBoundaryPolicy(forged),
    /TOOLING_BOUNDARY_ALLOW_MISMATCH boundary=tooling.deployment-plan.application/,
  );
});

test("a missing governed tooling root fails closed", () => {
  const policy = readAndValidateToolingBoundaryPolicy(policyPath);
  const forged = structuredClone(policy);
  forged.governedRoots = forged.governedRoots.filter((root) => root !== "tooling/security/slither/src");
  assert.throws(
    () => validateToolingBoundaryPolicy(forged),
    /TOOLING_BOUNDARY_ROOT_MISSING root=tooling\/security\/slither\/src/,
  );
});

test("parser ignores non-tooling boundaries and rejects an incomplete fixture", () => {
  const parsed = parseSourceDependencyPolicy("governedRoots:\n  - elsewhere\nboundaries:\n  - id: other.domain\n");
  assert.deepEqual(parsed, { boundaries: {}, governedRoots: ["elsewhere"], slitherBoundarySource: "" });
  assert.throws(() => validateToolingBoundaryPolicy(parsed), /TOOLING_BOUNDARY_ROOT_MISSING/);
});

test("every toolchain, tooling and recovery lane routes representative changes through the Foundation fast-full gate", async () => {
  const { loadAgentWorkflowPolicy, runChangedAgentWorkflow } = await foundationChangedWorkflow();
  const workflowPolicy = await loadAgentWorkflowPolicy(
    repositoryRoot,
    "architecture/foundation/repository-agent-workflow.yaml",
  );
  const representatives = [
    "dev",
    "scripts/bootstrap.sh",
    "scripts/doctor.mjs",
    "scripts/env.sh",
    "scripts/tests/root-entrypoint.test.mjs",
    "scripts/tests/toolchain-authority.test.mjs",
    "scripts/tests/toolchain-fixture.mjs",
    "scripts/tests/toolchain.test.mjs",
    "scripts/toolchain-archive.mjs",
    "scripts/toolchain-installation.mjs",
    "scripts/toolchain-policy.mjs",
    "scripts/toolchain.mjs",
    "scripts/execution-environment/toolchain-environment.mjs",
    "tooling/toolchain.lock.json",
    "tooling/local-evm/evidence-report.schema.v1.json",
    "tooling/local-solana/evidence-report.schema.v1.json",
    "tooling/deployment-plan/schema.v2.json",
    "tooling/security/slither/fixtures/vulnerable/contracts/src/Vulnerable.sol",
    "architecture/rollback/local-solana.json",
    "scripts/rollback/prove-slices.mjs",
    "scripts/assert-complete-history.sh",
    "scripts/tests/rollback-ci-history.test.mjs",
    "scripts/tests/rollback-cleanup-safety.test.mjs",
    "scripts/tests/rollback-evidence.test.mjs",
    "scripts/tests/rollback-proof.test.mjs",
    "scripts/tests/rollback-routing.test.mjs",
  ];

  for (const changedPath of representatives) {
    const invocations = [];
    const report = await runChangedAgentWorkflow(
      { consumerRoot: repositoryRoot, policy: workflowPolicy },
      {
        collect: async () => ({
          baselineRef: "HEAD^",
          baselineCommit: "0".repeat(40),
          requestedBaseRef: undefined,
          resolvedBaseRef: "HEAD^",
          baseCommit: "0".repeat(40),
          headRef: "HEAD",
          headCommit: "1".repeat(40),
          mergeBaseCommit: "0".repeat(40),
          changeGroups: Object.freeze([]),
          scopeDigest: "2".repeat(64),
          changedPaths: Object.freeze([changedPath]),
          existingPaths: Object.freeze([changedPath]),
          deletedPaths: Object.freeze([]),
        }),
      },
      {
        run: async (input) => {
          invocations.push(input);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    );

    assert.equal(report.coverage, "fast-full", changedPath);
    assert.deepEqual(invocations.map(({ script, paths }) => ({ script, paths })), [
      { script: "check:fast", paths: [] },
    ], changedPath);
  }
});
