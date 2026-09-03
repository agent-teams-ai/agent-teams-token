import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-24.04");
    assert.ok(Number.isInteger(job["timeout-minutes"]));
    assert.ok(job["timeout-minutes"] <= 20);
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
    1,
  );
  assert.doesNotMatch(workflowText, /pnpm\/action-setup|actions\/setup-node|actions\/cache/);
});

test("every job asserts exact clean GITHUB_SHA before and after its gates", () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const commands = job.steps.flatMap((step) => typeof step.run === "string" ? [step.run] : []);
    assert.equal(commands.filter((command) => command === 'scripts/assert-clean-head.sh "$GITHUB_SHA"').length, 2, name);
    assert.equal(job.steps.find((step) => step.name === "Assert exact clean checkout").shell, "bash");
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

test("foundation and TypeScript job bootstraps verified pnpm and runs the final gate", () => {
  const commands = runs("foundation-and-typescript");
  for (const expected of [
    "source scripts/env.sh && pnpm install --frozen-lockfile",
    "source scripts/env.sh && pnpm check",
  ]) {assert.ok(commands.includes(expected), `missing command: ${expected}`);}
  const bootstrap = commands.join("\n");
  assert.match(bootstrap, /bootstrap fetch/);
  assert.match(bootstrap, /bootstrap install --offline/);
  assert.match(bootstrap, /bootstrap verify --offline/);
  assert.match(bootstrap, /command -v pnpm.*\.tools\/bin\/pnpm/);
});

test("solidity job selects pinned solc for format/build/unit/fuzz/invariants/gas-size", () => {
  const commands = runs("solidity").join("\n");
  assert.match(commands, /\.\/dev bootstrap fetch/);
  assert.match(commands, /\.\/dev bootstrap install --offline/);
  assert.match(commands, /\.\/dev bootstrap verify --offline/);
  assert.match(commands, /forge fmt --check/);
  assert.match(commands, /forge build --sizes --use "\$token_solc"/);
  assert.match(commands, /FOUNDRY_PROFILE=ci forge test --no-match-path 'test\/invariant\/\*\*' --use "\$token_solc"/);
  assert.match(commands, /FOUNDRY_PROFILE=ci forge test --match-path 'test\/invariant\/\*\*' --use "\$token_solc"/);
  assert.match(commands, /forge test --gas-report --match-test testWorstCase32AllocationsFitsLocalBlockAndCodeLimits/);
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
  assert.match(commands, /pnpm test:deployment-plan/);
  assert.match(job.steps.find((step) => step.name === "Prove unsigned deployment plan against loopback Anvil").env.AGTMAI_ANVIL_BINARY, /foundry-v1\.8\.0-linux-x64\/anvil/u);
  assert.doesNotMatch(JSON.stringify(job), /public-rpc|sepolia|mainnet|sendTransaction|continue-on-error/i);
});

test("Slither job is exact-SHA-bound, fail closed and uploads immutable evidence", () => {
  const job = workflow.jobs["solidity-security"];
  assert.deepEqual(job.needs, ["solidity"]);
  assert.equal(job.if, "${{ always() }}");
  const prerequisite = job.steps.find((step) => step.name === "Assert solidity prerequisite completed successfully");
  assert.equal(prerequisite.if, "${{ always() }}");
  assert.match(prerequisite.run, /SOLIDITY_PREREQUISITE_FAILED/);
  assert.equal(job.env.SLITHER_CANDIDATE_SHA, "${{ github.sha }}");
  assert.equal(job.env.SLITHER_DOCKER_PATH, "/usr/bin/docker");
  assert.match(job.env.SLITHER_FORGE_PATH, /foundry-v1\.8\.0-linux-x64\/forge/u);
  assert.match(job.env.SLITHER_SOLC_PATH, /solc-v0\.8\.36-linux-x64\/solc/u);
  const commands = runs("solidity-security").join("\n");
  assert.match(commands, /pnpm security:solidity:prepare-image/);
  assert.match(commands, /pnpm security:solidity/);
  assert.match(commands, /node tooling\/security\/slither\/src\/composition\/validate-evidence\.ts/);
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
  const packageBin = environmentText.indexOf('"$token_env_tools_root/bin"');
  assert.ok(node >= 0 && node < foundry && foundry < solc && solc < packageBin);
  assert.match(environmentText, /export PATH="\$token_env_path_prefix:\$PATH"/);
  assert.doesNotMatch(environmentText, /\bfind\b/);
});

test("package-manager policy disables implicit downloads and the final check has no silent omissions", () => {
  const npmrc = readFileSync(join(repositoryRoot, ".npmrc"), "utf8");
  const lock = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  assert.match(npmrc, /^auto-install-peers=false$/m);
  assert.match(npmrc, /^manage-package-manager-versions=false$/m);
  assert.match(npmrc, /^package-manager-strict-version=true$/m);
  assert.match(npmrc, /^registry=https:\/\/registry\.npmjs\.org\/$/m);
  assert.match(lock, /^  autoInstallPeers: false$/m);
  assert.equal(packageJson.packageManager, "pnpm@11.24.0");
  for (const command of ["test:linux-parity", "genesis:vector:check", "security:check", "test:local-evm:built", "test:local-solana", "test:deployment-plan", "security:slither:test"]) {
    assert.match(packageJson.scripts.check, new RegExp(`pnpm ${command.replaceAll(":", "\\:")}`));
  }
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
