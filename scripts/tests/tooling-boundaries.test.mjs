import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  parseSourceDependencyPolicy,
  readAndValidateToolingBoundaryPolicy,
  validateToolingBoundaryPolicy,
} from "../tooling-boundaries.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const policyPath = resolve(repositoryRoot, "architecture/foundation/source-dependencies.yaml");

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
