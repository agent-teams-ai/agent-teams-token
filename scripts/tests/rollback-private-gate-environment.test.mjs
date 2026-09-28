import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { EvidenceRecorder } from "../rollback/runtime/evidence.mjs";
import { gateEnvironment } from "../rollback/slices/gate-contract.mjs";
import { runCommonGates, runSurvivorGate } from "../rollback/slices/gate-execution.mjs";
import { derivePrivateGateChildEnvironment, trustedChildInvocation } from "../toolchain-environment.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const privateKeys = [
  "HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
];
const guardKeys = ["ALLOW_MAINNET_BROADCAST", "ALLOW_PUBLIC_NETWORK", "ENABLE_PUBLIC_RPC", "MAINNET_ENABLED"];
const probe = `process.stdout.write(JSON.stringify(Object.fromEntries(
  ${JSON.stringify([...privateKeys, ...guardKeys, "NODE_OPTIONS", "GIT_CONFIG_COUNT"])}
    .map((key) => [key, process.env[key] ?? null])
)))`;

test("rollback gate recorder passes its private environment to the actual child only", (context) => {
  const local = join(repositoryRoot, ".local");
  mkdirSync(local, { recursive: true });
  const root = mkdtempSync(join(local, "token-private-gate-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const gateTemporaryDirectory = join(root, "gate-tmp");
  const evidenceDirectory = join(root, "evidence");
  mkdirSync(gateTemporaryDirectory, { mode: 0o700 });
  mkdirSync(evidenceDirectory, { mode: 0o700 });
  const recorder = new EvidenceRecorder(evidenceDirectory, {});
  const tools = {
    node: process.execPath,
    pnpm: "/usr/bin/true",
    forge: "/usr/bin/true",
    solc: "/usr/bin/true",
    anvil: "/usr/bin/true",
  };
  const environment = gateEnvironment(root, gateTemporaryDirectory, tools);
  environment.NODE_OPTIONS = "--invalid-hostile-option";
  environment.GIT_CONFIG_COUNT = "1";
  const selected = recorder.run("gate", "private-paths", process.execPath, ["-e", probe], {
    cwd: root, env: environment,
  });
  const selectedValues = JSON.parse(selected.stdout);
  for (const key of privateKeys) {
    assert.equal(selectedValues[key], environment[key], key);
  }
  for (const key of guardKeys) {
    assert.equal(selectedValues[key], "false", key);
  }
  assert.equal(selectedValues.NODE_OPTIONS, null);
  assert.equal(selectedValues.GIT_CONFIG_COUNT, null);
  assert.equal(selected.entry.environment.TMPDIR, gateTemporaryDirectory);

  environment.GIT_AUTHOR_NAME = "Gate Test Identity";
  const git = trustedChildInvocation("/usr/bin/git", ["--version"], environment, {
    workingDirectory: root,
  });
  assert.equal(git.environment.HOME, environment.HOME);
  assert.equal(git.environment.TMPDIR, environment.TMPDIR);
  assert.equal(git.environment.GIT_AUTHOR_NAME, "Gate Test Identity");
  assert.equal(git.environment.GIT_CONFIG_COUNT, "0");
  assert.equal(git.environment.NODE_OPTIONS, undefined);

  const copied = recorder.run("gate", "copied-paths", process.execPath, ["-e", probe], {
    cwd: root,
    env: { ...environment, HOME: join(root, "hostile-home"), TMPDIR: join(root, "hostile-tmp") },
  });
  assert.equal(JSON.parse(copied.stdout).HOME, "/nonexistent");
  assert.equal(JSON.parse(copied.stdout).TMPDIR, "/tmp");
  assert.throws(
    () => derivePrivateGateChildEnvironment({ ...environment }, { FOUNDRY_PROFILE: "ci" }),
    /TOOLCHAIN_PRIVATE_GATE_DERIVATION_UNTRUSTED/u,
  );
  assert.throws(
    () => derivePrivateGateChildEnvironment(environment, { ALLOW_PUBLIC_NETWORK: "true" }),
    /TOOLCHAIN_PRIVATE_GATE_DERIVATION_OVERRIDE_FORBIDDEN/u,
  );

  const ambient = recorder.run("gate", "ambient-paths", process.execPath, ["-e", probe], {
    cwd: root,
    env: { ...process.env, HOME: join(root, "hostile-home"), TMPDIR: join(root, "hostile-tmp") },
  });
  const ambientValues = JSON.parse(ambient.stdout);
  assert.equal(ambientValues.HOME, "/nonexistent");
  assert.equal(ambientValues.TMPDIR, "/tmp");
  for (const key of privateKeys.slice(2)) {
    assert.equal(ambientValues[key], "/nonexistent");
  }
});

test("six gate-specific dispatches preserve validated private paths in real children", (context) => {
  const local = join(repositoryRoot, ".local");
  mkdirSync(local, { recursive: true });
  const root = mkdtempSync(join(local, "token-private-dispatch-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const temporaryDirectory = join(root, "gate-tmp");
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  const tools = { node: process.execPath, pnpm: "/usr/bin/true", forge: "/usr/bin/true", solc: "/usr/bin/true", anvil: "/usr/bin/true", docker: "/usr/bin/true" };
  const environment = gateEnvironment(root, temporaryDirectory, tools);
  const expected = new Set([
    "forge-unit-fuzz", "forge-invariants", "solana-unit-and-strict-real",
    "solana-real-fixture", "slither-real-analyzer", "slither-evidence-validate",
  ]);
  const seen = new Set();
  const recorder = {
    prepareSurvivorDirectory: () => join(root, "evidence"),
    run(_group, id, _command, _arguments, options) {
      if (expected.has(id)) {
        const invocation = trustedChildInvocation(process.execPath, ["-e", probe], options.env, { workingDirectory: root });
        const child = requireChild(invocation);
        assert.equal(child.status, 0, child.stderr);
        const values = JSON.parse(child.stdout);
        for (const key of privateKeys) { assert.equal(values[key], environment[key], `${id}: ${key}`); }
        for (const key of guardKeys) { assert.equal(values[key], "false", `${id}: ${key}`); }
        assert.equal(values.NODE_OPTIONS, null);
        seen.add(id);
      }
      return { stdout: "", entry: {} };
    },
  };
  runCommonGates(root, recorder, "gate", tools, environment);
  for (const survivor of ["local-solana", "slither"]) {
    runSurvivorGate({ survivor, root, rollbackSha: "a".repeat(40), recorder, group: "gate", tools, environment });
  }
  assert.deepEqual(seen, expected);
});

test("renamed private HOME replaced by a symlink is rejected before child launch", (context) => {
  const local = join(repositoryRoot, ".local");
  mkdirSync(local, { recursive: true });
  const root = mkdtempSync(join(local, "token-private-substitution-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const temporaryDirectory = join(root, "gate-tmp");
  const evidenceDirectory = join(root, "evidence");
  const foreign = join(root, "foreign");
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  mkdirSync(evidenceDirectory, { mode: 0o700 });
  mkdirSync(foreign, { mode: 0o700 });
  const tools = { node: process.execPath, pnpm: "/usr/bin/true", forge: "/usr/bin/true", solc: "/usr/bin/true", anvil: "/usr/bin/true" };
  const environment = gateEnvironment(root, temporaryDirectory, tools);
  renameSync(environment.HOME, join(root, "held-home"));
  symlinkSync(foreign, environment.HOME);
  const marker = join(foreign, "child-ran");
  const recorder = new EvidenceRecorder(evidenceDirectory, {});
  assert.throws(() => recorder.run("gate", "substitution", process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.env.HOME + '/child-ran', 'bad')"],
    { cwd: root, env: environment }), /TOOLCHAIN_PRIVATE_GATE_PATH_/u);
  assert.equal(exists(marker), false);
});

test("XDG child and private root replacements fail at invocation", (context) => {
  const local = join(repositoryRoot, ".local");
  mkdirSync(local, { recursive: true });
  const root = mkdtempSync(join(local, "token-private-replacement-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const temporaryDirectory = join(root, "gate-tmp");
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  const tools = { node: process.execPath, pnpm: "/usr/bin/true", forge: "/usr/bin/true", solc: "/usr/bin/true", anvil: "/usr/bin/true" };
  const environment = gateEnvironment(root, temporaryDirectory, tools);
  const derived = derivePrivateGateChildEnvironment(environment, { FOUNDRY_PROFILE: "ci" });
  renameSync(environment.XDG_CACHE_HOME, join(root, "held-cache"));
  mkdirSync(environment.XDG_CACHE_HOME, { mode: 0o700 });
  assert.throws(
    () => trustedChildInvocation(process.execPath, ["-e", probe], derived),
    /TOOLCHAIN_PRIVATE_GATE_PATH_SUBSTITUTED/u,
  );
  rmSync(environment.XDG_CACHE_HOME, { recursive: true });
  renameSync(join(root, "held-cache"), environment.XDG_CACHE_HOME);
  chmodSync(environment.XDG_DATA_HOME, 0o755);
  assert.throws(
    () => trustedChildInvocation(process.execPath, ["-e", probe], derived),
    /TOOLCHAIN_PRIVATE_GATE_PATH_INVALID/u,
  );
  chmodSync(environment.XDG_DATA_HOME, 0o700);
  renameSync(temporaryDirectory, join(root, "held-gate-tmp"));
  mkdirSync(temporaryDirectory, { mode: 0o700 });
  assert.throws(
    () => trustedChildInvocation(process.execPath, ["-e", probe], environment),
    /TOOLCHAIN_PRIVATE_GATE_PATH_SUBSTITUTED/u,
  );
});

function requireChild(invocation) {
  return spawnSync(process.execPath, invocation.arguments, { env: invocation.environment, encoding: "utf8" });
}

function exists(path) {
  try { return lstatSync(path) !== undefined; } catch { return false; }
}
