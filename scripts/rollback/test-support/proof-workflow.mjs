import { realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import {
  assert, spawnSync, join, dirname, mkdirSync, rmSync, copyFileSync, cpSync,
  existsSync, readFileSync, writeFileSync,
  temporaryDirectory, repositoryRoot, cloneRepository, copyCurrentRollbackSharedState,
  createRollbackWorkspaceHandle, closeRollbackWorkspaceHandle, parseStrictTap,
} from "./proof-fixture.mjs";

export const workflowPolicyTitle = "package-manager policy disables implicit downloads and the final check has no silent omissions";

const node26TestCount = 6;
const node26PnpmVersion = "11.24.0\n";

function fixturePnpmPackage() {
  const candidates = [
    join(repositoryRoot, ".tools/pnpm-11.24.0"),
    join(repositoryRoot, ".local/node-tools/pnpm/node_modules/pnpm"),
  ];
  const packageRoot = candidates.find((path) => existsSync(join(path, "dist/pnpm.mjs")));
  assert.ok(packageRoot, "pinned pnpm 11.24.0 package is available for rollback policy fixture");
  return packageRoot;
}

export function checkNode26Policies(checkout, { failures = 0, failingTitle } = {}) {
  const cli = join(checkout, ".tools/pnpm-11.24.0/dist/pnpm.mjs");
  const env = { ...process.env, npm_execpath: cli };
  delete env.NODE_TEST_CONTEXT;
  const version = spawnSync(process.execPath, [cli, "--version"], {
    cwd: checkout, env, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(version.error, undefined, version.stderr);
  assert.equal(version.status, 0, version.stdout + version.stderr);
  assert.equal(version.stdout, node26PnpmVersion);
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", "scripts/tests/node26-compatibility.test.mjs",
  ], { cwd: checkout, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, output);
  assert.equal(result.signal, null, output);
  assert.equal(result.status, failures === 0 ? 0 : 1, output);
  for (const [field, expected] of Object.entries({
    tests: node26TestCount,
    pass: node26TestCount - failures,
    fail: failures,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  })) {
    assert.match(result.stdout, new RegExp(`^# ${field} ${expected}$`, "mu"), output);
  }
  assert.equal([...result.stdout.matchAll(/^# Subtest: /gmu)].length, node26TestCount, output);
  assert.match(result.stdout, /^ok 5 - pinned pnpm rejects invalid fresh peers and its lock graph after frozen install$/mu, output);
  if (failingTitle !== undefined) {
    assert.match(result.stdout, new RegExp(`^not ok [0-9]+ - ${failingTitle}$`, "mu"), output);
  }
  return result;
}

export function rejectNode26PolicyMutation(checkout) {
  const policyPath = join(checkout, "tooling/compatibility/node26-policy.json");
  const original = readFileSync(policyPath, "utf8");
  try {
    const changed = JSON.parse(original);
    changed.runtimePolicy.productionDefault = "0.0.0";
    writeFileSync(policyPath, JSON.stringify(changed));
    checkNode26Policies(checkout, {
      failures: 1,
      failingTitle: "Node 26 policy preserves the Node 24 production default and skips Node 25",
    });
  } finally {
    writeFileSync(policyPath, original);
  }
}

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
  copyFileSync(
    join(repositoryRoot, "scripts/tests/node26-compatibility.test.mjs"),
    join(checkout, "scripts/tests/node26-compatibility.test.mjs"),
  );
  const requireFromSupply = createRequire(join(repositoryRoot, "packages/contexts/supply/package.json"));
  mkdirSync(join(checkout, "node_modules"));
  cpSync(dirname(requireFromSupply.resolve("yaml/package.json")), join(checkout, "node_modules/yaml"), {
    recursive: true, dereference: true,
  });
  const repositoryMutationPhysical = join(
    checkout, "node_modules/.pnpm/@agent-teams+repository-mutation@0.2.2/node_modules/@agent-teams/repository-mutation",
  );
  mkdirSync(dirname(repositoryMutationPhysical), { recursive: true });
  cpSync(realpathSync(join(repositoryRoot, "node_modules/@agent-teams/repository-mutation")), repositoryMutationPhysical, {
    recursive: true, dereference: true,
  });
  const repositoryMutationLink = join(checkout, "node_modules/@agent-teams/repository-mutation");
  mkdirSync(dirname(repositoryMutationLink), { recursive: true });
  symlinkSync("../.pnpm/@agent-teams+repository-mutation@0.2.2/node_modules/@agent-teams/repository-mutation", repositoryMutationLink);
  assert.ok(readFileSync(join(checkout, "pnpm-workspace.yaml"), "utf8").startsWith("packages:\n"));
  const fixturePackage = join(checkout, ".tools/pnpm-11.24.0");
  mkdirSync(dirname(fixturePackage), { recursive: true });
  cpSync(fixturePnpmPackage(), fixturePackage, { recursive: true, dereference: true });
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
