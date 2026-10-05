import { createRequire } from "node:module";
import {
  assert, spawnSync, join, dirname, mkdirSync, symlinkSync, rmSync,
  temporaryDirectory, repositoryRoot, cloneRepository, copyCurrentRollbackSharedState,
  createRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, parseStrictTap,
} from "./proof-fixture.mjs";

export const workflowPolicyTitle = "package-manager policy disables implicit downloads and the final check has no silent omissions";

export function workflowPolicyFixture(context, manifest) {
  const boundary = temporaryDirectory("agtmai-rollback-workflow-policy-");
  const checkout = join(boundary, "checkout");
  const quarantineRoot = join(boundary, "gate-tmp");
  let workspaceHandle;
  context.after(() => {
    closeRollbackWorkspaceHandle(workspaceHandle);
    rmSync(boundary, { recursive: true, force: true });
  });
  cloneRepository(repositoryRoot, checkout, boundary);
  copyCurrentRollbackSharedState(checkout, manifest);
  const requireFromSupply = createRequire(join(repositoryRoot, "packages/contexts/supply/package.json"));
  mkdirSync(join(checkout, "node_modules"));
  symlinkSync(dirname(requireFromSupply.resolve("yaml/package.json")), join(checkout, "node_modules/yaml"), "dir");
  mkdirSync(quarantineRoot, { mode: 0o700 });
  workspaceHandle = createRollbackWorkspaceHandle(checkout, quarantineRoot);
  return { checkout, workspaceHandle, parse: requireFromSupply("yaml").parse };
}

export function checkWorkflowPolicies(checkout, pattern, count, failures = 0) {
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`,
    "scripts/tests/workflow.test.mjs",
  ], { cwd: checkout, env: {}, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, output);
  assert.equal(result.signal, null, output);
  assert.equal(result.status, failures === 0 ? 0 : 1, output);
  assert.match(result.stdout, new RegExp(`^# tests ${count}$`, "mu"), output);
  assert.match(result.stdout, new RegExp(`^# fail ${failures}$`, "mu"), output);
  assert.match(result.stdout, /^# skipped 0$/mu, output);
  if (failures === 0) {
    parseStrictTap(result.stdout, workflowPolicyTitle);
  } else {
    assert.match(result.stdout, new RegExp(`^not ok [0-9]+ - ${workflowPolicyTitle}$`, "mu"), output);
  }
}

export function assertRestoredSdkWorkflow(workflow, scripts, baselineFoundation) {
  const foundation = workflow.jobs["foundation-and-typescript"];
  const sdkSteps = foundation.steps.filter((step) => step.id === "stage-pinned-sdk-inputs");
  assert.equal(sdkSteps.length, 1, "restored workflow must stage required SDK inputs exactly once");
  const [sdkStep] = sdkSteps;
  assert.deepEqual(sdkStep, {
    name: "Stage finite public SDK check inputs",
    id: "stage-pinned-sdk-inputs",
    shell: "bash",
    run: "./dev bootstrap sdk-inputs --fetch",
  });
  const install = foundation.steps.find((step) => step.name === "Install frozen workspace");
  const rootCheck = foundation.steps.find((step) => step.name === "Final repository check");
  assert.ok(foundation.steps.indexOf(sdkStep) < foundation.steps.indexOf(install));
  assert.ok(foundation.steps.indexOf(install) < foundation.steps.indexOf(rootCheck));
  assert.equal(rootCheck.if, undefined);
  assert.equal(rootCheck["continue-on-error"], undefined);
  assert.equal(rootCheck.run, "source scripts/env.sh && pnpm check");
  assert.ok(scripts.check.split(" && ").includes("pnpm typecheck"));
  for (const command of [
    "tsc -p tooling/testnet-ccip/tsconfig.sdk-execution.json --pretty false",
    "tsc -p tooling/testnet-ccip/tsconfig.json --pretty false",
  ]) {
    assert.equal(scripts.typecheck.split(" && ").filter((entry) => entry === command).length, 1);
  }
  assert.doesNotMatch(scripts.typecheck, /\|\||--if-present/u);
  // The current SDK step is the sole addition to the historical foundation:
  // proof timeout, environments, preflight, validation and uploads all disappear.
  assert.deepEqual({
    ...foundation,
    steps: foundation.steps.filter((step) => step !== sdkStep),
  }, baselineFoundation);
}
