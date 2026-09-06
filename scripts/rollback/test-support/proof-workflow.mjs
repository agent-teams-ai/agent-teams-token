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
