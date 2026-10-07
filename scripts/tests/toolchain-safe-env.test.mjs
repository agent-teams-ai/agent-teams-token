import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { digest, writeExecutable } from "./toolchain-fixtures.mjs";
import { fetchArtifacts, installArtifacts, runPnpm } from "../toolchain.mjs";
import { makeFixture } from "../toolchain-test-fixture.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");

export function registerSafeEnvTests() {
  test("bootstrap run-pnpm passes only validated Safe qualification inputs", testBootstrapSafeEnvironment);
  test("actual runPnpm package script receives only explicit validated Safe inputs", testRunPnpmSafeEnvironment);
}

function testBootstrapSafeEnvironment(context) {
  const root = mkdtempSync(join(tmpdir(), "agtmai-bootstrap-safe-env-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const nodeDirectory = "node-test-linux-x64";
  const payloadBin = join(root, "payload", nodeDirectory, "bin");
  const downloads = join(root, ".tools", "downloads");
  const archive = join(downloads, "node-test.tar.gz");
  const safeDirectory = join(root, "Safe artifacts 'quoted' $directory");
  mkdirSync(scripts);
  mkdirSync(payloadBin, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  mkdirSync(safeDirectory);
  copyFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), join(scripts, "bootstrap.sh"));
  writeExecutable(join(payloadBin, "node"), `#!/bin/sh\nif [ "\${1:-}" = --version ]; then echo v24.20.0; else exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"; fi\n`);
  writeFileSync(join(scripts, "toolchain-cleanup.mjs"), [
    'import { rmSync } from "node:fs";',
    'if (process.argv[2] === "capture-bootstrap-stage-custody") process.stdout.write("a".repeat(64) + "\\n");',
    'else if (process.argv[2] === "cleanup-bootstrap-stage") rmSync(process.argv[3], { recursive: true });',
  ].join("\n"));
  writeFileSync(join(scripts, "toolchain.mjs"), 'process.stdout.write("CHILD_ENV=" + JSON.stringify(process.env) + "\\n");\n');
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", join(root, "payload"), nodeDirectory]);
  const base = {
    PATH: "/hostile",
    NODE_OPTIONS: "--invalid-hostile-option",
    AGTMAI_SAFE_UNRELATED: "must-not-reach-child",
    TOKEN_BOOTSTRAP_TEST_MODE: "1",
    TOKEN_BOOTSTRAP_TEST_NODE_ARCHIVE: "node-test.tar.gz",
    TOKEN_BOOTSTRAP_TEST_NODE_DIRECTORY: nodeDirectory,
    TOKEN_BOOTSTRAP_TEST_NODE_URL: "https://fixtures.invalid/node-test.tar.gz",
    TOKEN_BOOTSTRAP_TEST_NODE_SHA256: digest(archive),
    TOKEN_BOOTSTRAP_TEST_NODE_TAR_FLAG: "-xzf",
    TOKEN_BOOTSTRAP_TEST_CURL: "/bin/false",
  };
  const run = (extra) => spawnSync("/bin/bash", [join(scripts, "bootstrap.sh"), "run-pnpm", "check"], {
    encoding: "utf8", env: { ...base, ...extra },
  });
  const pins = `0x${"ab".repeat(32)}`;
  for (const inputs of [{}, { AGTMAI_SAFE_ARTIFACT_DIRECTORY: safeDirectory, AGTMAI_SAFE_PINS_SHA256: pins }]) {
    const result = run(inputs);
    assert.equal(result.status, 0, result.stderr);
    const child = JSON.parse(result.stdout.match(/^CHILD_ENV=(.*)$/mu)?.[1] ?? "null");
    assert.ok(child, result.stdout);
    assert.equal(child.AGTMAI_SAFE_ARTIFACT_DIRECTORY, inputs.AGTMAI_SAFE_ARTIFACT_DIRECTORY);
    assert.equal(child.AGTMAI_SAFE_PINS_SHA256, inputs.AGTMAI_SAFE_PINS_SHA256);
    assert.equal(child.AGTMAI_SAFE_UNRELATED, undefined);
    assert.equal(child.NODE_OPTIONS, undefined);
  }
  const link = join(root, "safe-link");
  symlinkSync(safeDirectory, link, "dir");
  for (const inputs of [
    { AGTMAI_SAFE_ARTIFACT_DIRECTORY: "", AGTMAI_SAFE_PINS_SHA256: "" },
    { AGTMAI_SAFE_ARTIFACT_DIRECTORY: safeDirectory },
    { AGTMAI_SAFE_PINS_SHA256: pins },
    { AGTMAI_SAFE_ARTIFACT_DIRECTORY: "relative", AGTMAI_SAFE_PINS_SHA256: pins },
    { AGTMAI_SAFE_ARTIFACT_DIRECTORY: `${safeDirectory}\nunsafe`, AGTMAI_SAFE_PINS_SHA256: pins },
    { AGTMAI_SAFE_ARTIFACT_DIRECTORY: link, AGTMAI_SAFE_PINS_SHA256: pins },
    { AGTMAI_SAFE_ARTIFACT_DIRECTORY: safeDirectory, AGTMAI_SAFE_PINS_SHA256: "0x1234" },
  ]) {
    const result = run(inputs);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /TOOLCHAIN_SAFE_ARTIFACT_ENV_INVALID/u);
    assert.doesNotMatch(result.stdout, /CHILD_ENV=/u);
  }
}

function testRunPnpmSafeEnvironment(context) {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const project = join(fixture.root, "safe-pnpm-project");
  const directory = join(fixture.root, "Safe artifacts 'quoted' $directory");
  const link = join(fixture.root, "safe-link");
  const writable = join(fixture.root, "unsafe-writable");
  const pinsSha256 = `0x${"ab".repeat(32)}`;
  const keys = [
    "AGTMAI_SAFE_ARTIFACT_DIRECTORY", "AGTMAI_SAFE_PINS_SHA256", "AGTMAI_SAFE_UNRELATED",
    "NODE_OPTIONS", "NODE_PATH", "HTTPS_PROXY", "npm_config_registry",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  context.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) {delete process.env[key];}
      else {process.env[key] = previous[key];}
    }
  });
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  mkdirSync(project);
  mkdirSync(directory);
  mkdirSync(writable, { mode: 0o777 });
  chmodSync(writable, 0o777);
  symlinkSync(directory, link);
  const probe = keys.map((key) => `"\${${key}-unset}"`).join(" ");
  writeFileSync(join(project, "package.json"), `${JSON.stringify({
    name: "safe-pnpm-project", private: true,
    scripts: { probe: `printf '%s\\n' ${probe} > safe-env` },
  })}\n`);
  Object.assign(process.env, {
    AGTMAI_SAFE_ARTIFACT_DIRECTORY: "/hostile/artifacts",
    AGTMAI_SAFE_PINS_SHA256: `0x${"cd".repeat(32)}`,
    AGTMAI_SAFE_UNRELATED: "hostile-safe-variable",
    NODE_OPTIONS: "--invalid-hostile-option",
    NODE_PATH: "/hostile/node-path",
    HTTPS_PROXY: "https://hostile.invalid",
    npm_config_registry: "https://hostile.invalid",
  });
  const run = (safeArtifactEnvironment) => runPnpm({
    lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot,
    args: ["--dir", project, "run", "probe"], safeArtifactEnvironment,
  });
  const values = () => readFileSync(join(project, "safe-env"), "utf8").trimEnd().split("\n");
  assert.equal(run(), 0);
  assert.deepEqual(values(), keys.map(() => "unset"), "ambient Safe and hostile values must not enter pnpm");
  assert.equal(run({ directory, pinsSha256 }), 0);
  assert.deepEqual(values(), [directory, pinsSha256, ...keys.slice(2).map(() => "unset")],
    "the package script must receive the exact validated pair and no hostile values");
  rmSync(join(project, "safe-env"));
  for (const invalid of [
    {}, { directory }, { pinsSha256 }, { directory: "relative", pinsSha256 },
    { directory: `${directory}\nunsafe`, pinsSha256 }, { directory: link, pinsSha256 },
    { directory: writable, pinsSha256 }, { directory, pinsSha256: "0x1234" },
    { directory, pinsSha256, extra: "smuggled" },
  ]) {
    assert.throws(() => run(invalid), /TOOLCHAIN_SAFE_ARTIFACT_ENV_INVALID/u,
      "direct runPnpm must reject malformed or partial Safe options before invocation");
    assert.equal(existsSync(join(project, "safe-env")), false,
      "an invalid option must be rejected before the package script runs");
  }
}
