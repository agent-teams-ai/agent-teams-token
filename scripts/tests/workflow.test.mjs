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

test("workflow syntax has only the three exact-scope Barrier 1 jobs", () => {
  assert.equal(workflow.name, "CI");
  assert.deepEqual(Object.keys(workflow.jobs), [
    "foundation-and-typescript",
    "solidity",
    "local-evm-e2e",
  ]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-24.04");
    assert.ok(Number.isInteger(job["timeout-minutes"]));
    assert.ok(job["timeout-minutes"] <= 20);
  }
  assert.doesNotMatch(workflowText, /\b(?:agave|slither|ccip)\b/i);
});

test("all third-party actions use immutable full commit SHAs and peeled pnpm action", () => {
  const uses = [...workflowText.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const action of uses) {assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/);}
  assert.ok(uses.includes("pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271"));
  assert.ok(!uses.includes("pnpm/action-setup@008330803749db0355799c700092d9a85fd074e9"));
  assert.doesNotMatch(workflowText, /actions\/upload-artifact|actions\/cache/);
});

test("foundation and TypeScript job runs frozen install and canonical package gates", () => {
  const commands = runs("foundation-and-typescript");
  for (const expected of [
    "pnpm install --frozen-lockfile",
    "node --test scripts/tests/*.test.mjs",
    "docker compose -f compose.yaml config --quiet",
    "pnpm foundation:assert-dev-only && pnpm foundation:assert-registry && pnpm foundation:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm genesis:vector:check",
  ]) {assert.ok(commands.includes(expected), `missing command: ${expected}`);}
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
  assert.ok(runs("local-evm-e2e").includes("source scripts/env.sh && pnpm genesis:verify:local"));
  assert.match(runs("local-evm-e2e").join("\n"), /bootstrap verify --offline.*doctor --scope=core/);
  assert.doesNotMatch(JSON.stringify(job), /mock|public-rpc|sepolia|mainnet/i);
});

test("Compose is digest-pinned, local-only and hardened", () => {
  const composeText = readFileSync(join(repositoryRoot, "compose.yaml"), "utf8");
  const compose = parse(composeText);
  assert.deepEqual(Object.keys(compose.services), ["anvil"]);
  const anvil = compose.services.anvil;
  assert.match(anvil.image, /^ghcr\.io\/foundry-rs\/foundry:v1\.8\.0@sha256:[a-f0-9]{64}$/);
  assert.equal(anvil.read_only, true);
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
