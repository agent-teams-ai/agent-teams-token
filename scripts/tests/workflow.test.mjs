import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const requireFromSupply = createRequire(join(repositoryRoot, "packages/contexts/supply/package.json"));
const { parse } = requireFromSupply("yaml");
const workflowPath = join(repositoryRoot, ".github/workflows/ci.yml");
const workflowText = readFileSync(workflowPath, "utf8");
const workflow = parse(workflowText);

test("workflow syntax has the six integrated exact-scope jobs", () => {
  assert.equal(workflow.name, "CI");
  assert.deepEqual(Object.keys(workflow.jobs), [
    "foundation-and-typescript",
    "solidity",
    "local-evm-e2e",
    "local-solana-e2e",
    "deployment-plan-e2e",
    "solidity-security",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-24.04");
    assert.ok(Number.isInteger(job["timeout-minutes"]));
    if (name === "foundation-and-typescript") {
      assert.equal(job["timeout-minutes"], 120);
      assert.equal(job.needs, undefined);
    } else {
      assert.ok(job["timeout-minutes"] <= 20, name);
    }
  }
  assert.doesNotMatch(workflowText, /\bccip\b/i);
});

test("all third-party actions use immutable full commit SHAs without package-manager setup", () => {
  const uses = [...workflowText.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const action of uses) {assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/);}
  assert.ok(uses.every((value) =>
    value === "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
    || value === "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ));
  assert.equal(
    uses.filter((value) => value.startsWith("actions/upload-artifact@")).length,
    3,
  );
  assert.doesNotMatch(workflowText, /pnpm\/action-setup|actions\/setup-node|actions\/cache/);
});

test("every job asserts exact clean GITHUB_SHA before and after its gates", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const commands = job.steps.flatMap((step) => typeof step.run === "string" ? [step.run] : []);
    assert.equal(
      [...commands.join("\n").matchAll(/scripts\/assert-clean-head\.sh "\$GITHUB_SHA"/gu)].length,
      name === "foundation-and-typescript" ? 3 : 2,
      name,
    );
    if (name === "foundation-and-typescript") {
      assert.equal(
        job.steps.find((step) => step.id === "assert-complete-history-and-exact-clean-head-before").shell,
        "bash",
      );
    } else {
      assert.equal(job.steps.find((step) => step.name === "Assert exact clean checkout").shell, "bash");
    }
  }
});

test("workflow dispatch records GitHub exact-SHA metadata", () => {
  const step = workflow.jobs["foundation-and-typescript"].steps
    .find(({ name }) => name === "Record workflow-dispatch exact-SHA evidence");
  assert.equal(step.if, "${{ github.event_name == 'workflow_dispatch' }}");
  for (const field of ["GITHUB_EVENT_NAME", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REF", "GITHUB_SHA"]) {
    assert.match(step.run, new RegExp(field));
  }
  assert.equal(step.uses, undefined);
});

test("foundation job proves complete exact history and preflights every rollback prerequisite before root gates", () => {
  const job = workflow.jobs["foundation-and-typescript"];
  assert.equal(job["timeout-minutes"], 120);
  assert.equal(job.needs, undefined);
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.deepEqual(job.env, {
    SLITHER_REPOSITORY_ROOT: "${{ github.workspace }}",
    SLITHER_CANDIDATE_SHA: "${{ github.sha }}",
    SLITHER_DOCKER_PATH: "/usr/bin/docker",
    SLITHER_FORGE_PATH: "${{ github.workspace }}/.tools/foundry-v1.8.0-linux-x64/forge",
    SLITHER_SOLC_PATH: "${{ github.workspace }}/.tools/solc-v0.8.36-linux-x64/solc",
  });

  // runner is available in step env, but unavailable in job env.
  const request = JSON.parse(readFileSync(join(repositoryRoot, "architecture/rollback/ci-wiring-request.v1.json"), "utf8"));
  assert.deepEqual(job.env, request.existingJobPatch.environment);
  assert.doesNotMatch(JSON.stringify(job.env), /\$\{\{\s*runner\./u);
  const runnerEnvironment = {
    AGTMAI_ROLLBACK_TMPDIR: "${{ runner.temp }}",
    AGTMAI_ROLLBACK_EVIDENCE_DIRECTORY: "${{ runner.temp }}/rollback-proof-${{ github.sha }}",
    SLITHER_EVIDENCE_DIRECTORY: "${{ runner.temp }}/rollback-proof-${{ github.sha }}",
  };
  for (const step of job.steps) {
    assert.deepEqual(step.env, runnerEnvironment, step.name);
  }
  for (const step of request.existingJobPatch.steps) {
    assert.deepEqual(step.env, runnerEnvironment, step.id);
  }

  const byId = (id) => job.steps.find((step) => step.id === id);
  const checkout = byId("checkout-complete-history-at-exact-head");
  assert.equal(checkout.uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.deepEqual(checkout.with, {
    ref: "${{ github.sha }}",
    "fetch-depth": 0,
    "persist-credentials": false,
  });

  const historyBefore = byId("assert-complete-history-and-exact-clean-head-before");
  assert.equal(historyBefore.run.trim(), [
    'scripts/assert-complete-history.sh "$GITHUB_SHA" b7a868f85d89c4bb7a9aeed1d854a5f949306a45 3231e8a918c6079c8b384b5389fef2be9f25d33f',
    'scripts/assert-clean-head.sh "$GITHUB_SHA"',
  ].join("\n"));
  const fetch = byId("fetch-pinned-core-and-solana-prerequisites");
  assert.match(fetch.run, /bootstrap fetch\n.*bootstrap fetch --scope=solana/u);
  const offline = byId("offline-install-and-verify-pinned-prerequisites");
  assert.match(offline.run, /bootstrap install --offline\n.*bootstrap install --offline --scope=solana/u);
  assert.match(offline.run, /bootstrap verify --offline\n.*bootstrap verify --offline --scope=solana/u);
  assert.match(offline.run, /doctor --scope=core/u);
  assert.match(offline.run, /command -v pnpm.*\.tools\/bin\/pnpm/u);
  const workspace = byId("install-frozen-source-workspace-and-populate-store");
  assert.equal(workspace.run, "source scripts/env.sh && pnpm install --frozen-lockfile");
  const buildArtifacts = byId("build-canonical-evm-artifacts");
  assert.equal(
    buildArtifacts.run,
    'source scripts/env.sh\n'
      + '(\n'
      + '  cd contracts/evm\n'
      + '  "$AGTMAI_FORGE_BINARY" build --offline --no-auto-detect --sizes --use "$AGTMAI_SOLC_BINARY"\n'
      + ')\n',
  );
  const preload = byId("preload-pinned-slither-image");
  assert.equal(preload.run, "source scripts/env.sh && pnpm security:solidity:prepare-image");
  const preflight = byId("non-pulling-rollback-environment-cache-preflight");
  assert.equal(
    preflight.run,
    'source scripts/env.sh && pnpm rollback:preflight --expected-sha="$GITHUB_SHA"',
  );
  const rootCheck = byId("run-root-check-with-exact-rollback-proof");
  assert.equal(rootCheck.run, "source scripts/env.sh && pnpm check:linux");
  const historyAfter = byId("assert-complete-history-and-exact-clean-head-after");
  assert.equal(historyAfter.if, "${{ always() }}");
  assert.equal(historyAfter.run.trim(), historyBefore.run.trim());
  const validation = byId("validate-rollback-proof");
  assert.equal(validation.if, "${{ success() }}");
  assert.equal(
    validation.run.replace(/\\\r?\n\s*/gu, "").split("\n").map((line) => line.trim()).filter(Boolean).join("\n"),
    'source scripts/env.sh\n'
      + 'pnpm rollback:evidence:validate --bundle="$AGTMAI_ROLLBACK_EVIDENCE_DIRECTORY" --expected-sha="$GITHUB_SHA"\n'
      + 'scripts/assert-complete-history.sh "$GITHUB_SHA" b7a868f85d89c4bb7a9aeed1d854a5f949306a45 3231e8a918c6079c8b384b5389fef2be9f25d33f\n'
      + 'scripts/assert-clean-head.sh "$GITHUB_SHA"',
  );
  assert.match(validation.run, /--expected-sha="\$GITHUB_SHA"/u);
  assert.match(validation.run, /assert-complete-history\.sh "\$GITHUB_SHA"/u);
  assert.match(validation.run, /assert-clean-head\.sh "\$GITHUB_SHA"/u);
  const upload = byId("upload-rollback-proof-evidence");
  assert.equal(upload.if, "${{ success() && steps.validate-rollback-proof.outcome == 'success' }}");
  assert.equal(upload.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.deepEqual(upload.with, {
    name: "rollback-proof-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
    path: "${{ runner.temp }}/rollback-proof-${{ github.sha }}",
    "if-no-files-found": "error",
    "retention-days": 14,
  });
  assert.equal(upload["continue-on-error"], false);
  const diagnostics = byId("upload-rollback-failure-diagnostics");
  assert.equal(diagnostics.if, "${{ failure() }}");
  assert.equal(diagnostics.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.match(diagnostics.with.name, /^rollback-diagnostics-/u);
  assert.doesNotMatch(diagnostics.with.path, /statement\.json|seal\.json|READY/u);
  assert.equal(diagnostics.with["if-no-files-found"], "warn");
  assert.equal(diagnostics["continue-on-error"], false);

  for (const [earlier, later] of [
    [checkout, historyBefore],
    [historyBefore, fetch],
    [fetch, offline],
    [offline, workspace],
    [workspace, preload],
    [preload, preflight],
    [preflight, rootCheck],
    [rootCheck, historyAfter],
    [historyAfter, validation],
    [validation, upload],
    [upload, diagnostics],
  ]) {
    assert.ok(job.steps.indexOf(earlier) < job.steps.indexOf(later));
  }
});

test("solidity job selects pinned solc for format/build/unit/fuzz/invariants/gas-size", () => {
  const commands = runs("solidity").join("\n");
  assert.match(commands, /\.\/dev bootstrap fetch/);
  assert.match(commands, /\.\/dev bootstrap install --offline/);
  assert.match(commands, /\.\/dev bootstrap verify --offline/);
  assert.match(commands, /forge fmt --check/);
  assert.match(commands, /forge build --offline --no-auto-detect --sizes --use "\$token_solc"/);
  assert.match(commands, /FOUNDRY_PROFILE=ci forge test --offline --no-auto-detect --no-match-path 'test\/invariant\/\*\*' --use "\$token_solc"/);
  assert.match(commands, /FOUNDRY_PROFILE=ci forge test --offline --no-auto-detect --match-path 'test\/invariant\/\*\*' --use "\$token_solc"/);
  assert.match(commands, /forge test --offline --no-auto-detect --gas-report --match-test testWorstCase32AllocationsFitsLocalBlockAndCodeLimits/);
  assert.doesNotMatch(commands, /foundryup|solc-select|latest/);
});

test("local EVM job exposes the narrow W3 command seam without mocked delivery", () => {
  const job = workflow.jobs["local-evm-e2e"];
  assert.deepEqual(job.needs, ["foundation-and-typescript", "solidity"]);
  const commands = runs("local-evm-e2e").join("\n");
  assert.match(commands, /bootstrap verify --offline[\s\S]*doctor --scope=core/);
  assert.match(commands, /source scripts\/env\.sh/);
  assert.match(commands, /pnpm test:local-evm\n/);
  assert.match(commands, /pnpm test:local-evm:integration/);
  assert.match(commands, /pnpm genesis:verify:local/);
  assert.doesNotMatch(JSON.stringify(job), /mock|public-rpc|sepolia|mainnet/i);
});

test("local Solana job installs the pinned fixture tools and proves the real zero-supply lifecycle", () => {
  const job = workflow.jobs["local-solana-e2e"];
  assert.equal(job.needs, undefined);
  const commands = runs("local-solana-e2e").join("\n");
  assert.match(commands, /bootstrap fetch --scope=solana/);
  assert.match(commands, /bootstrap install --offline --scope=solana/);
  assert.match(commands, /bootstrap verify --offline --scope=solana/);
  assert.match(commands, /pnpm test:local-solana/);
  assert.match(commands, /pnpm solana:fixture:local -- --output/);
  assert.doesNotMatch(JSON.stringify(job), /public-rpc|devnet|mainnet|continue-on-error/i);
});

test("deployment-plan job proves the real unsigned loopback path", () => {
  const job = workflow.jobs["deployment-plan-e2e"];
  assert.deepEqual(job.needs, ["foundation-and-typescript", "solidity"]);
  const commands = runs("deployment-plan-e2e").join("\n");
  assert.match(commands, /bootstrap verify --offline[\s\S]*doctor --scope=core/);
  const install = job.steps.find((step) => step.name === "Install frozen workspace");
  const supplyBuild = job.steps.find((step) => step.name === "Build Supply workspace dependency");
  const deploymentPlan = job.steps.find((step) => step.name === "Prove unsigned deployment plan against loopback Anvil");
  assert.ok(install, "Install frozen workspace step is required");
  assert.ok(supplyBuild, "Build Supply workspace dependency step is required");
  assert.ok(deploymentPlan, "Prove unsigned deployment plan against loopback Anvil step is required");
  assert.equal(supplyBuild.run, "source scripts/env.sh && pnpm --filter @agent-teams/supply build");
  assert.equal(supplyBuild.if, undefined);
  assert.ok(job.steps.indexOf(install) < job.steps.indexOf(supplyBuild));
  assert.ok(job.steps.indexOf(supplyBuild) < job.steps.indexOf(deploymentPlan));
  assert.match(commands, /pnpm test:deployment-plan/);
  assert.match(deploymentPlan.env.AGTMAI_ANVIL_BINARY, /foundry-v1\.8\.0-linux-x64\/anvil/u);
  assert.doesNotMatch(JSON.stringify(job), /public-rpc|sepolia|mainnet|sendTransaction|continue-on-error/i);
});

test("Slither job is exact-SHA-bound, fail closed and uploads immutable evidence", () => {
  const job = workflow.jobs["solidity-security"];
  assert.deepEqual(job.needs, ["solidity"]);
  assert.equal(job.if, "${{ always() }}");
  const prerequisite = job.steps.find((step) => step.name === "Assert solidity prerequisite completed successfully");
  assert.equal(prerequisite.if, "${{ always() }}");
  const finalGuard = job.steps.find((step) => step.name === "Fail closed on solidity prerequisite result");
  assert.equal(finalGuard.if, "${{ always() }}");
  assert.match(finalGuard.run, /\$\{\{ needs\.solidity\.result \}\}/);
  assert.match(finalGuard.run, /SOLIDITY_PREREQUISITE_FAILED/);
  assert.doesNotMatch(JSON.stringify(job), /GITHUB_ENV/);
  assert.equal(job.env.SLITHER_CANDIDATE_SHA, "${{ github.sha }}");
  assert.equal(job.env.SLITHER_DOCKER_PATH, "/usr/bin/docker");
  assert.match(job.env.SLITHER_FORGE_PATH, /foundry-v1\.8\.0-linux-x64\/forge/u);
  assert.match(job.env.SLITHER_SOLC_PATH, /solc-v0\.8\.36-linux-x64\/solc/u);
  const commands = runs("solidity-security").join("\n");
  assert.match(commands, /pnpm security:solidity:prepare-image/);
  assert.match(commands, /pnpm security:solidity/);
  assert.match(commands, /\.tools\/bin\/node tooling\/security\/slither\/src\/composition\/validate-evidence\.ts/);
  const validation = job.steps.find((step) => step.name === "Validate finalized Slither evidence");
  assert.equal(validation.id, "validate-slither-evidence");
  assert.equal(validation.if, "${{ always() }}");
  const upload = job.steps.find((step) => step.name === "Upload immutable Slither evidence");
  assert.equal(upload.if, "${{ always() && steps.validate-slither-evidence.outcome == 'success' }}");
  assert.equal(upload.uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 14);
  assert.doesNotMatch(JSON.stringify(job), /continue-on-error|:latest\b/u);
});

test("actual workflow Node validation ignores inherited preload and proxy authority", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-workflow-node-authority-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "workflow-node-attacker-marker");
  const preload = join(root, "preload.cjs");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed\\n");\n`);
  const command = workflow.jobs["solidity-security"].steps
    .find((step) => step.name === "Validate finalized Slither evidence").run;
  const result = spawnSync("/bin/bash", ["-c", command], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ALL_PROXY: "http://sentinel.invalid/",
      GITHUB_SHA: "invalid",
      HTTP_PROXY: "http://sentinel.invalid/",
      NODE_OPTIONS: `--require=${preload}`,
      SLITHER_CANDIDATE_SHA: "invalid",
    },
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CANDIDATE_SHA_INVALID/u);
  assert.equal(existsSync(marker), false);
});

test("Compose is digest-pinned, local-only and hardened", () => {
  const composeText = readFileSync(join(repositoryRoot, "compose.yaml"), "utf8");
  const compose = parse(composeText);
  assert.deepEqual(Object.keys(compose.services), ["anvil"]);
  const anvil = compose.services.anvil;
  assert.match(anvil.image, /^ghcr\.io\/foundry-rs\/foundry:v1\.8\.0@sha256:[a-f0-9]{64}$/);
  assert.equal(anvil.read_only, true);
  assert.equal(anvil.user, "10001:10001");
  assert.deepEqual(anvil.environment, { HOME: "/tmp" });
  assert.deepEqual(anvil.ports, ["127.0.0.1:8545:8545"]);
  assert.deepEqual(anvil.security_opt, ["no-new-privileges:true"]);
  assert.ok(anvil.healthcheck);
  assert.doesNotMatch(composeText, /:latest\b|0\.0\.0\.0:8545:8545|https?:\/\/(?!127\.0\.0\.1(?::|\/)|localhost(?::|\/))/);
});

test("owned environment files contain no public RPC, secret material or floating assets", () => {
  const text = [
    workflowText,
    readFileSync(join(repositoryRoot, "compose.yaml"), "utf8"),
    readFileSync(join(repositoryRoot, "tooling/toolchain.lock.json"), "utf8"),
    readFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(text, /https?:\/\/(?:[^\s/]+\.)?(?:mainnet|sepolia|devnet)\b/i);
  assert.doesNotMatch(text, /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----|\b(?:seed phrase|mnemonic)\s*[:=]/i);
  assert.doesNotMatch(text, /@(?:latest|main|master)\b|:latest\b|UNVERIFIED-UPSTREAM/i);
});

test("environment PATH keeps verified Core tools ahead of the package-manager bin", () => {
  const environmentText = readFileSync(join(repositoryRoot, "scripts/env.sh"), "utf8");
  const node = environmentText.indexOf("node-v24.20.0-$token_env_platform/bin");
  const foundry = environmentText.indexOf("foundry-v1.8.0-$token_env_platform");
  const solc = environmentText.indexOf("solc-v0.8.36-$token_env_platform");
  const agave = environmentText.indexOf("agave-v4.2.1-$token_env_platform/bin");
  const packageBin = environmentText.indexOf('"$token_env_tools_root/bin"');
  assert.ok(node >= 0 && node < foundry && foundry < solc && solc < agave && agave < packageBin);
  assert.match(environmentText, /export PATH="\$token_env_node:\$token_env_foundry:\$token_env_solc\$\{token_env_agave:\+:\$token_env_agave\}:\$token_env_package_bin"/);
  assert.doesNotMatch(environmentText, /:\$PATH/);
  assert.doesNotMatch(environmentText, /\bfind\b/);
});

test("package-manager policy disables implicit downloads and the final check has no silent omissions", () => {
  const npmrc = readFileSync(join(repositoryRoot, ".npmrc"), "utf8");
  const workspace = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const lock = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  assert.doesNotMatch(npmrc, /^auto-install-peers=/m);
  assert.match(workspace, /^autoInstallPeers: false$/m);
  assert.match(npmrc, /^manage-package-manager-versions=false$/m);
  assert.match(npmrc, /^package-manager-strict-version=true$/m);
  assert.match(npmrc, /^registry=https:\/\/registry\.npmjs\.org\/$/m);
  assert.match(lock, /^  autoInstallPeers: false$/m);
  assert.equal(packageJson.packageManager, "pnpm@11.24.0");
  for (const command of ["test:linux-parity", "genesis:vector:check", "security:check", "test:local-evm:built", "test:local-solana", "test:deployment-plan", "security:slither:test"]) {
    assert.match(packageJson.scripts.check, new RegExp(`pnpm ${command.replaceAll(":", "\\:")}`));
  }
  assert.match(
    packageJson.scripts["test:linux-parity"],
    /scripts\/tests\/toolchain-hardening\.test\.mjs/u,
  );
  assert.doesNotMatch(packageJson.scripts.check, /rollback:(?:preflight|prove)/u);
  assert.equal(
    packageJson.scripts["check:linux"],
    "pnpm rollback:preflight && pnpm check && pnpm rollback:prove",
  );
  assert.match(
    workflow.jobs["foundation-and-typescript"].steps
      .find((step) => step.id === "run-root-check-with-exact-rollback-proof").run,
    /pnpm check:linux$/u,
  );
  assert.doesNotMatch(packageJson.scripts.check, /\|\|\s*true|--if-present/);
});

test("committed TypeScript and Solidity vectors use the same raw bytes and hash", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "packages/contexts/supply/tests/fixtures/local.golden.json"), "utf8"));
  const solidity = JSON.parse(readFileSync(join(repositoryRoot, "contracts/evm/evidence/shared-test-vector.json"), "utf8"));
  assert.equal(manifest.rawAllocationAbi, solidity.rawAbiBytes);
  assert.equal(manifest.genesisAllocationHash, solidity.keccak256);
  assert.match(solidity.method, /committed bytes/);
});

function runs(jobName) {
  return workflow.jobs[jobName].steps.flatMap((step) => typeof step.run === "string" ? [step.run] : []);
}
