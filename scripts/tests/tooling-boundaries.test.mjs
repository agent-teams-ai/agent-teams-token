import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  parseSourceDependencyPolicy,
  readAndValidateToolingBoundaryPolicy,
  validateToolingBoundaryPolicy,
} from "../tooling-boundaries.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const policyPath = resolve(repositoryRoot, "architecture/foundation/source-dependencies.yaml");

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

test("committed policy has the exact three tooling dependency DAGs", () => {
  const policy = readAndValidateToolingBoundaryPolicy(policyPath);
  assert.equal(Object.keys(policy.boundaries).length, 12);
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
  assert.deepEqual(parsed, { boundaries: {}, governedRoots: ["elsewhere"] });
  assert.throws(() => validateToolingBoundaryPolicy(parsed), /TOOLING_BOUNDARY_ROOT_MISSING/);
});

test("every tooling lane routes representative non-TypeScript changes through the Foundation fast-full gate", async () => {
  const { loadAgentWorkflowPolicy, runChangedAgentWorkflow } = await foundationChangedWorkflow();
  const workflowPolicy = await loadAgentWorkflowPolicy(
    repositoryRoot,
    "architecture/foundation/repository-agent-workflow.yaml",
  );
  const representatives = [
    "tooling/local-evm/evidence-report.schema.v1.json",
    "tooling/local-solana/evidence-report.schema.v1.json",
    "tooling/deployment-plan/schema.v2.json",
    "tooling/security/slither/fixtures/vulnerable/contracts/src/Vulnerable.sol",
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
