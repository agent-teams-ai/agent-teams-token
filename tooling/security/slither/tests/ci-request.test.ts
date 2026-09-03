import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("CI wiring request is exact, dependency-ordered and fail closed", async () => {
  const raw = await readFile("tooling/security/slither/ci-wiring-request.v1.json", "utf8");
  const request = JSON.parse(raw) as { workflow: { needs: string[]; checkoutAction: string; uploadAction: string; requirements: string[] }; packageScripts: Record<string, string> };
  assert.deepEqual(request.workflow.needs, ["solidity"]);
  assert.match(request.workflow.checkoutAction, /@[0-9a-f]{40}$/u); assert.match(request.workflow.uploadAction, /@[0-9a-f]{40}$/u);
  assert.match(request.packageScripts["check:release"] ?? "", /security:solidity/u);
  const requirements = request.workflow.requirements.join("\n");
  for (const required of ["persist-credentials false", "if: always()", "if-no-files-found: error", "missing READY", "without a path filter", "do not use a pipeline", "SLITHER_CANDIDATE_SHA=$GITHUB_SHA", "validate-evidence.ts", "validation succeeds"]) {assert.match(requirements, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));}
  assert.doesNotMatch(raw, /continue-on-error[^\n]*true/u);
});

test("the one canonical CI job binds SHA, dependencies, failures and immutable upload", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.equal([...workflow.matchAll(/^  solidity-security:$/gmu)].length, 1);
  const job = workflow.slice(workflow.indexOf("  solidity-security:"));
  for (const required of ["needs: [solidity]", "ref: ${{ github.sha }}", "persist-credentials: false", "timeout-minutes: 20", "SLITHER_DOCKER_PATH: /usr/bin/docker", "pnpm security:solidity:prepare-image", "pnpm security:solidity", "needs.solidity.result == 'success'", "needs.solidity.result != 'success'", "Create minimal environment-failure evidence", "UNEXPECTED_ENVIRONMENT_FAILURE", "if: ${{ always() }}", "validate-evidence.ts", "steps.validate-slither-evidence.outcome == 'success'", "if-no-files-found: error", "scripts/assert-clean-head.sh", "@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"]) {assert.match(job, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));}
  assert.doesNotMatch(job, /continue-on-error|paths-ignore|--network[ =]host/u);
});
