import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { EvidenceRecorder } from "../rollback/runtime/evidence.mjs";
import { gateEnvironment } from "../rollback/slices/gate-contract.mjs";
import { trustedChildInvocation } from "../toolchain-environment.mjs";

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
