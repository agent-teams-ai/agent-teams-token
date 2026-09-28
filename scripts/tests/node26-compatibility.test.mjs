import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromSupply = createRequire(join(repositoryRoot, "packages/contexts/supply/package.json"));
const { parse } = requireFromSupply("yaml");
const node26WorkflowPath = join(repositoryRoot, ".github/workflows/node26-compatibility.yml");
const node26WorkflowText = readFileSync(node26WorkflowPath, "utf8");
const node26Workflow = parse(node26WorkflowText);
const node26Policy = JSON.parse(readFileSync(join(repositoryRoot, "tooling/compatibility/node26-policy.json"), "utf8"));

function pinnedPnpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(repositoryRoot, ".tools/pnpm-11.24.0/dist/pnpm.mjs"),
    join(repositoryRoot, ".local/node-tools/pnpm/node_modules/pnpm/bin/pnpm.mjs"),
  ];
  const cli = candidates.find((candidate) => candidate && /pnpm\.(?:mjs|cjs)$/u.test(basename(candidate)) && existsSync(candidate));
  assert.ok(cli, "pinned pnpm JavaScript CLI is available");
  return cli;
}

function runPinnedPnpm(cli, cwd, args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("Node 26 policy preserves the Node 24 production default and skips Node 25", () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const toolchain = JSON.parse(readFileSync(join(repositoryRoot, "tooling/toolchain.lock.json"), "utf8"));
  assert.equal(node26Policy.schemaVersion, 1);
  assert.deepEqual(node26Policy.runtimePolicy, {
    productionDefault: "24.20.0",
    productionRange: ">=24.20.0 <25",
    compatibilityVersion: "26.10.0",
    compatibilityRange: ">=26.10.0 <27",
    skippedMajor: 25,
    cutover: "Node 26 must be official LTS and the owner must authorize the production cutover",
  });
  assert.equal(readFileSync(join(repositoryRoot, ".node-version"), "utf8"), "24.20.0\n");
  assert.equal(toolchain.policy.node, ">=24.20.0 <25");
  assert.equal(toolchain.tools.node.version, "24.20.0");
  assert.deepEqual(packageJson.engines, node26Policy.workspaceEngines);
});

test("Node 26 workflow keeps strict install independent from focused behavior checks", () => {
  assert.equal(node26Workflow.name, "Node 26 Compatibility");
  assert.deepEqual(Object.keys(node26Workflow.jobs), ["node26-strict-install", "node26-focused-checks"]);
  assert.deepEqual(node26Workflow.permissions, { contents: "read" });
  assert.match(node26WorkflowText, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/mu);
  assert.equal(node26Workflow.concurrency["cancel-in-progress"], true);
  for (const job of Object.values(node26Workflow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-24.04");
    assert.ok(Number.isInteger(job["timeout-minutes"]));
    assert.ok(job["timeout-minutes"] <= 20);
  }
  assert.equal(node26Workflow.jobs["node26-strict-install"]["continue-on-error"], true);
  assert.equal(node26Workflow.jobs["node26-focused-checks"]["continue-on-error"], undefined);
  for (const [name, job] of Object.entries(node26Workflow.jobs)) {
    const checkout = job.steps.find((step) => step.name === "Checkout exact head");
    assert.equal(checkout.with.ref, "${{ github.sha }}", name);
    assert.equal(checkout.with["persist-credentials"], false, name);
    assert.equal(checkout.with["fetch-depth"], name === "node26-focused-checks" ? 0 : undefined, name);
  }

  const setupActions = Object.values(node26Workflow.jobs).map((job) => job.steps.find((step) => step.uses?.startsWith("actions/setup-node@")));
  for (const action of setupActions) {
    assert.equal(action.uses, "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38");
    assert.equal(action.with["node-version"], "26.10.0");
    assert.equal(action.with["check-latest"], false);
  }

  const uses = [...node26WorkflowText.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  for (const action of uses) {assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/u);}
  assert.ok(uses.every((value) =>
    value === "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
    || value === "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"
    || value === "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ));
  assert.equal(uses.filter((value) => value.startsWith("actions/upload-artifact@")).length, 1);
});

test("Node 26 lane records upstream engine blockers and runs observable regression suites", () => {
  const lock = parse(readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8"));
  const blockers = node26Policy.strictInstall.blockers.map(({ name, version }) => `${name}@${version}`).toSorted();
  const lockBlockers = Object.entries(lock.packages)
    .filter(([, value]) => value.engines?.node === ">=24.18.0 <25")
    .map(([name]) => name)
    .toSorted();
  assert.deepEqual(blockers, lockBlockers);
  for (const blocker of node26Policy.strictInstall.blockers) {
    assert.equal(lock.packages[`${blocker.name}@${blocker.version}`].engines.node, blocker.nodeEngine);
    assert.equal(blocker.resolution, "upstream release with a Node 26-compatible engine range");
  }
  assert.deepEqual(node26Policy.strictInstall, {
    command: "pnpm install --frozen-lockfile --config.engine-strict=true",
    status: "blocked-by-upstream-engine-ranges",
    blockers: node26Policy.strictInstall.blockers,
  });

  for (const dependency of node26Policy.publishedArtifactAudit.runtimeDependencies) {
    assert.equal(lock.packages[`${dependency.name}@${dependency.version}`].engines.node, dependency.nodeEngine);
  }
  assert.deepEqual(node26Policy.publishedArtifactAudit.runtimeDependencyBlockers, []);
  for (const packagePath of ["package.json", "packages/domain/package.json", "packages/contexts/supply/package.json"]) {
    assert.equal(JSON.parse(readFileSync(join(repositoryRoot, packagePath), "utf8")).private, true, packagePath);
  }

  const strictInstall = node26Workflow.jobs["node26-strict-install"].steps.find((step) => step.name === "Attempt frozen strict install").run;
  const focusedChecks = node26Workflow.jobs["node26-focused-checks"].steps.find((step) => step.name === "Run focused Node 26 compatibility checks").run;
  const focusedInstall = node26Workflow.jobs["node26-focused-checks"].steps.find((step) => step.name === "Install frozen workspace with recorded upstream engine exceptions").run;
  const packageScripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts;
  assert.ok(strictInstall.includes('pnpm peers check --lockfile-only 2>&1 | tee "$RUNNER_TEMP/node26-strict-install.log"'));
  assert.ok(strictInstall.includes(node26Policy.strictInstall.command + ' 2>&1 | tee "$RUNNER_TEMP/node26-strict-install.log"'));
  assert.deepEqual(focusedInstall.trimEnd().split("\n"), [
    "pnpm peers check --lockfile-only",
    node26Policy.focusedCompatibility.install,
  ]);
  for (const command of node26Policy.focusedCompatibility.checks) {
    const present = focusedChecks.split("\n").includes(command);
    assert.equal(present, command === "pnpm rollback:test" ? "rollback:test" in packageScripts : true, command);
  }
  assert.doesNotMatch(node26WorkflowText, /agent commands|launch|provisioning|terminal runtime|task assignment|smoke flows|mainnet|seed phrase|private key/iu);
});

test("pinned pnpm rejects invalid fresh peers and its lock graph after frozen install", () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageJson.packageManager, "pnpm@11.24.0");
  const cli = pinnedPnpmCli();
  assert.deepEqual(runPinnedPnpm(cli, repositoryRoot, ["--version"]), {
    status: 0, output: "11.24.0\n",
  });

  const fixture = mkdtempSync(join(tmpdir(), "agtmai-node26-peers-"));
  try {
    // The fixture owns its workspace before any pnpm command can search parents.
    writeFileSync(join(fixture, "pnpm-workspace.yaml"), "packages: []\nautoInstallPeers: false\n");
    writeFileSync(join(fixture, ".npmrc"), "engine-strict=true\nstrict-peer-dependencies=true\n");
    writeFileSync(join(fixture, "package.json"), JSON.stringify({
      name: "node26-peer-fixture", version: "1.0.0", private: true,
      packageManager: "pnpm@11.24.0",
      dependencies: { consumer: "file:./consumer-1.0.0.tgz", provider: "file:./provider-1.0.0.tgz" },
    }));
    for (const [name, manifest] of [
      ["consumer", { name: "consumer", version: "1.0.0", peerDependencies: { provider: "^2.0.0" } }],
      ["provider", { name: "provider", version: "1.0.0" }],
    ]) {
      const directory = join(fixture, name);
      mkdirSync(directory);
      writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
      const packed = runPinnedPnpm(cli, directory, ["pack", "--pack-destination", fixture]);
      assert.equal(packed.status, 0, packed.output);
    }

    const fresh = runPinnedPnpm(cli, fixture, ["install", "--offline", "--config.strict-peer-dependencies=true"]);
    assert.equal(fresh.status, 1, fresh.output);
    assert.match(fresh.output, /ERR_PNPM_PEER_DEP_ISSUES/u);
    assert.match(fresh.output, /provider[\s\S]*\^2\.0\.0/u);
    const frozen = runPinnedPnpm(cli, fixture, ["install", "--frozen-lockfile", "--offline", "--config.strict-peer-dependencies=true"]);
    assert.equal(frozen.status, 0, frozen.output);
    const checked = runPinnedPnpm(cli, fixture, ["peers", "check", "--lockfile-only"]);
    assert.equal(checked.status, 1, checked.output);
    assert.match(checked.output, /Issues with peer dependencies found/u);
    assert.match(checked.output, /provider[\s\S]*\^2\.0\.0/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("focused lane bootstraps pinned cast before supply tests while retaining Node 26 on PATH", () => {
  const steps = node26Workflow.jobs["node26-focused-checks"].steps;
  const bootstrapIndex = steps.findIndex((step) => step.name === "Fetch, install and verify pinned repository tools");
  const installIndex = steps.findIndex((step) => step.name === "Install frozen workspace with recorded upstream engine exceptions");
  const checksIndex = steps.findIndex((step) => step.name === "Run focused Node 26 compatibility checks");
  assert.ok(bootstrapIndex > 0 && bootstrapIndex < installIndex && installIndex < checksIndex);
  assert.deepEqual(steps[bootstrapIndex].run.trimEnd().split("\n"), [
    "./dev bootstrap fetch",
    "./dev bootstrap install --offline",
    "./dev bootstrap verify --offline",
    'test "$(node --version)" = "v26.10.0"',
    'test "$(.tools/bin/node --version)" = "v24.20.0"',
  ]);
  assert.ok(steps[checksIndex].run.split("\n").includes('test "$(node --version)" = "v26.10.0"'));
  const rootScripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts;
  assert.match(rootScripts.test, /pnpm --filter @agent-teams\/token-domain test:built/u);
  assert.match(rootScripts.test, /pnpm --filter @agent-teams\/supply test:built/u);
  for (const packagePath of ["packages/domain/package.json", "packages/contexts/supply/package.json"]) {
    const scripts = JSON.parse(readFileSync(join(repositoryRoot, packagePath), "utf8")).scripts;
    assert.match(scripts["test:built"], /\bnode --test\b/u, packagePath);
  }
});
