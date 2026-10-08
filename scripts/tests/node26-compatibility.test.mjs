import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
const docsCohortPackages = JSON.parse(readFileSync(join(repositoryRoot, "architecture/foundation/docs-consumer-integration.json"), "utf8")).cohort?.packages;

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

function runPinnedPnpm(cli, cwd, args, fixture) {
  const environment = fixture ? {
    ...process.env,
    HOME: join(fixture, "home"),
    TMPDIR: join(fixture, "tmp"),
    XDG_CACHE_HOME: join(fixture, "xdg-cache"),
    XDG_CONFIG_HOME: join(fixture, "xdg-config"),
    XDG_DATA_HOME: join(fixture, "xdg-data"),
    XDG_RUNTIME_DIR: join(fixture, "xdg-runtime"),
    PNPM_HOME: join(fixture, "pnpm-home"),
    npm_config_cache: join(fixture, "npm-cache"),
    npm_config_store_dir: join(fixture, "pnpm-store"),
    npm_config_engine_strict: "true",
    npm_config_strict_peer_dependencies: "true",
  } : process.env;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, env: environment, encoding: "utf8", timeout: 30_000,
  });
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
  assert.equal(node26Workflow.jobs["node26-strict-install"]["continue-on-error"], undefined);
  for (const job of Object.values(node26Workflow.jobs)) {
    assert.deepEqual(job.strategy.matrix["node-version"], ["24.21.0", "26.10.0"]);
    assert.equal(job.strategy["fail-fast"], false);
  }
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
    assert.equal(action.with["node-version"], "${{ matrix.node-version }}");
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

test("Node 26 lane requires strict engines and runs observable regression suites", () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const lock = parse(readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8"));
  const workspace = parse(readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8"));
  assert.ok(docsCohortPackages, "accepted cohort packages are required");
  assert.ok(lock.packages, "frozen lock packages are required");
  const lockBlockers = Object.entries(lock.packages)
    .filter(([, value]) => value.engines?.node === ">=24.18.0 <25")
    .map(([name]) => name)
    .toSorted();
  assert.deepEqual(lockBlockers, [], "the frozen lock contains no old Node 24-only package engines");
  const managedPackages = JSON.parse(readFileSync(join(repositoryRoot, "architecture/foundation/docs-protocol-managed-state.json"), "utf8")).packages;
  assert.ok(managedPackages, "managed state packages are required");
  assert.ok(lock.importers, "frozen lock importers are required");
  const rootImporter = lock.importers["."];
  assert.ok(rootImporter, "frozen lock root importer is required");
  assert.ok(rootImporter.devDependencies, "frozen lock root devDependencies are required");
  assert.ok(packageJson.devDependencies, "root package devDependencies are required");
  for (const [role, name] of Object.entries({
    docsProtocol: "@agent-teams/docs-protocol",
    docsProtocolAgentTeams: "@agent-teams/docs-protocol-agent-teams",
    documentAuthoring: "@agent-teams/document-authoring",
    engineeringFoundation: "@agent-teams/engineering-foundation",
    repositoryMutation: "@agent-teams/repository-mutation",
  })) {
    const accepted = docsCohortPackages[role];
    assert.ok(accepted, `${role}: accepted cohort record is required`);
    assert.equal(typeof accepted.version, "string", `${role}: accepted cohort version must be a string`);
    assert.ok(accepted.version.length > 0, `${role}: accepted cohort version is required`);
    assert.equal(typeof accepted.integrity, "string", `${role}: accepted cohort integrity must be a string`);
    assert.ok(accepted.integrity.length > 0, `${role}: accepted cohort integrity is required`);
    const { version } = accepted;
    const metadata = lock.packages[`${name}@${version}`];
    assert.ok(metadata, `${name}@${version}: frozen lock package metadata is required`);
    assert.ok(metadata.engines, `${name}@${version}: frozen lock engines are required`);
    assert.equal(metadata.engines.node, "^24.18.0 || ^26.0.0", name);
    assert.ok(metadata.resolution, `${name}@${version}: frozen lock resolution is required`);
    assert.equal(metadata.resolution.integrity, accepted.integrity, `${name}: frozen lock integrity matches cohort`);
    assert.deepEqual(managedPackages[role], accepted, `${role}: managed state matches cohort`);
    if (["@agent-teams/docs-protocol", "@agent-teams/docs-protocol-agent-teams", "@agent-teams/engineering-foundation"].includes(name)) {
      const directPin = rootImporter.devDependencies[name];
      assert.ok(directPin, `${name}: root lock direct pin is required`);
      assert.equal(directPin.specifier, version, `${name}: root lock specifier matches cohort`);
      assert.equal(typeof directPin.version, "string", `${name}: root lock resolution must be a string`);
      assert.equal(directPin.version.split("(")[0], version, `${name}: root lock resolution matches cohort`);
      assert.equal(packageJson.devDependencies[name], version, name);
    }
  }
  // Docs Cohort owns this published dependency transitively; Foundation rejects a direct root role.
  assert.equal(packageJson.devDependencies["@agent-teams/repository-mutation"], undefined);
  assert.equal(rootImporter.devDependencies["@agent-teams/repository-mutation"], undefined);
  assert.deepEqual(workspace.publicHoistPattern, ["@agent-teams/repository-mutation"]);
  assert.ok(lock.snapshots, "frozen lock snapshots are required");
  const docsProtocolSnapshot = lock.snapshots[`@agent-teams/docs-protocol@${docsCohortPackages.docsProtocol.version}`];
  assert.ok(docsProtocolSnapshot, "Docs Protocol lock snapshot is required");
  assert.ok(docsProtocolSnapshot.dependencies, "Docs Protocol lock snapshot dependencies are required");
  assert.equal(docsProtocolSnapshot.dependencies["@agent-teams/repository-mutation"], docsCohortPackages.repositoryMutation.version, "Docs Protocol lock snapshot resolves cohort repository mutation");
  assert.deepEqual(node26Policy.strictInstall, {
    command: "pnpm install --frozen-lockfile --config.engine-strict=true",
    status: "qualified",
    blockers: [],
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
  const focusedInstall = node26Workflow.jobs["node26-focused-checks"].steps.find((step) => step.name === "Install frozen workspace with strict engines").run;
  const packageScripts = packageJson.scripts;
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

test("docs gate resolves transitive repository mutation v2 from the root physical install", () => {
  const installed = join(repositoryRoot, "node_modules/@agent-teams/repository-mutation");
  const physical = realpathSync(installed);
  const manifest = JSON.parse(readFileSync(join(physical, "package.json"), "utf8"));
  assert.equal(manifest.name, "@agent-teams/repository-mutation");
  assert.ok(docsCohortPackages, "accepted cohort packages are required");
  const accepted = docsCohortPackages.repositoryMutation;
  assert.ok(accepted, "repositoryMutation: accepted cohort record is required");
  assert.equal(typeof accepted.version, "string", "repositoryMutation: accepted cohort version must be a string");
  const { version } = accepted;
  assert.ok(version.length > 0, "repositoryMutation: accepted cohort version is required");
  assert.equal(manifest.version, version);
  assert.ok(physical.endsWith(`/node_modules/.pnpm/@agent-teams+repository-mutation@${version}/node_modules/@agent-teams/repository-mutation`), "root repository mutation resolves to the cohort pnpm package");
});

test("pinned pnpm rejects invalid fresh peers and its lock graph after frozen install", () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(packageJson.packageManager, "pnpm@11.24.0");
  const cli = pinnedPnpmCli();
  const fixture = mkdtempSync(join(tmpdir(), "agtmai-node26-peers-"));
  try {
    for (const name of ["home", "tmp", "xdg-cache", "xdg-config", "xdg-data", "xdg-runtime", "pnpm-home", "npm-cache", "pnpm-store"]) {
      mkdirSync(join(fixture, name));
    }
    // The fixture owns its workspace before any pnpm command can search parents.
    writeFileSync(join(fixture, "pnpm-workspace.yaml"), "packages: []\nautoInstallPeers: false\n");
    writeFileSync(join(fixture, ".npmrc"), "engine-strict=true\nstrict-peer-dependencies=true\n");
    writeFileSync(join(fixture, "package.json"), JSON.stringify({
      name: "node26-peer-fixture", version: "1.0.0", private: true,
      packageManager: "pnpm@11.24.0",
      dependencies: { consumer: "file:./consumer-1.0.0.tgz", provider: "file:./provider-1.0.0.tgz" },
    }));
    assert.deepEqual(runPinnedPnpm(cli, fixture, ["--version"], fixture), {
      status: 0, output: "11.24.0\n",
    });
    for (const [name, manifest] of [
      ["consumer", { name: "consumer", version: "1.0.0", peerDependencies: { provider: "^2.0.0" } }],
      ["provider", { name: "provider", version: "1.0.0" }],
    ]) {
      const directory = join(fixture, name);
      mkdirSync(directory);
      writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
      const packed = runPinnedPnpm(cli, directory, ["pack", "--pack-destination", fixture], fixture);
      assert.equal(packed.status, 0, packed.output);
    }

    const fresh = runPinnedPnpm(cli, fixture, ["install", "--offline", "--config.strict-peer-dependencies=true"], fixture);
    assert.equal(fresh.status, 1, fresh.output);
    assert.match(fresh.output, /ERR_PNPM_PEER_DEP_ISSUES/u);
    assert.match(fresh.output, /provider[\s\S]*\^2\.0\.0/u);
    const frozen = runPinnedPnpm(cli, fixture, ["install", "--frozen-lockfile", "--offline", "--config.strict-peer-dependencies=true"], fixture);
    assert.equal(frozen.status, 0, frozen.output);
    const checked = runPinnedPnpm(cli, fixture, ["peers", "check", "--lockfile-only"], fixture);
    assert.equal(checked.status, 1, checked.output);
    assert.match(checked.output, /Issues with peer dependencies found/u);
    assert.match(checked.output, /provider[\s\S]*\^2\.0\.0/u);
    assert.ok(existsSync(join(fixture, "xdg-cache/pnpm")), "pnpm cache belongs to the peer fixture");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("focused lanes bootstrap pinned cast before supply tests while retaining the matrix Node on PATH", () => {
  const steps = node26Workflow.jobs["node26-focused-checks"].steps;
  const bootstrapIndex = steps.findIndex((step) => step.name === "Fetch, install and verify pinned repository tools");
  const installIndex = steps.findIndex((step) => step.name === "Install frozen workspace with strict engines");
  const checksIndex = steps.findIndex((step) => step.name === "Run focused Node 26 compatibility checks");
  assert.ok(bootstrapIndex > 0 && bootstrapIndex < installIndex && installIndex < checksIndex);
  assert.deepEqual(steps[bootstrapIndex].run.trimEnd().split("\n"), [
    "./dev bootstrap fetch",
    "./dev bootstrap install --offline",
    "./dev bootstrap verify --offline",
    'test "$(node --version)" = "v${{ matrix.node-version }}"',
    'test "$(.tools/bin/node --version)" = "v24.20.0"',
  ]);
  assert.ok(steps[checksIndex].run.split("\n").includes('test "$(node --version)" = "v${{ matrix.node-version }}"'));
  const rootScripts = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).scripts;
  assert.match(rootScripts.test, /pnpm --filter @agent-teams\/token-domain test:built/u);
  assert.match(rootScripts.test, /pnpm --filter @agent-teams\/supply test:built/u);
  for (const packagePath of ["packages/domain/package.json", "packages/contexts/supply/package.json"]) {
    const scripts = JSON.parse(readFileSync(join(repositoryRoot, packagePath), "utf8")).scripts;
    assert.match(scripts["test:built"], /\bnode --test\b/u, packagePath);
  }
});
