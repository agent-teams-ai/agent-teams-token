import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { descriptorRoot, executeOpenedNode, executeVerifiedFile } from "./toolchain-execution.mjs";
import { validateLock } from "./toolchain-lock-validation.mjs";
import { fetchArtifacts, installArtifacts, runPnpm } from "./toolchain.mjs";
import {
  artifact,
  coreTool,
  digest,
  futureTool,
  packageManagerTool,
  packageTool,
  securityImage,
  writeExecutable,
} from "./tests/toolchain-fixtures.mjs";

function createArchives(root, artifacts) {
  const nodePayload = join(root, "node-payload", "node-test-linux-x64", "bin");
  mkdirSync(nodePayload, { recursive: true });
  writeExecutable(
    join(nodePayload, "node"),
    `#!/bin/sh\nif [ "\${1:-}" = --version ]; then echo 'v24.20.0'; else exec ${shellQuote(process.execPath)} "$@"; fi\n`,
  );
  const node = join(artifacts, "node-test.tar.gz");
  execFileSync("tar", ["-czf", node, "-C", join(root, "node-payload"), "node-test-linux-x64"]);

  const foundryPayload = join(root, "foundry-payload", "foundry-test-linux-x64");
  mkdirSync(foundryPayload, { recursive: true });
  for (const command of ["forge", "cast", "anvil", "chisel"]) {
    writeExecutable(join(foundryPayload, command), [
      "#!/bin/sh",
      `if [ "\${1:-}" = --fixture-probe ]; then echo 'authenticated-${command}'; else echo '${command} Version: 1.8.0'; fi`,
      "",
    ].join("\n"));
  }
  const foundry = join(artifacts, "foundry-test.tar.gz");
  execFileSync("tar", ["-czf", foundry, "-C", join(root, "foundry-payload"), "foundry-test-linux-x64"]);

  const solc = join(artifacts, "solc-test");
  writeExecutable(solc, "#!/bin/sh\necho 'Version: 0.8.36+commit.8a079791.Linux.g++'\n");

  const agavePayload = join(root, "agave-payload", "solana-release", "bin");
  mkdirSync(agavePayload, { recursive: true });
  const agaveVersions = {
    solana: "solana-cli 4.2.1 (src:test; feat:test, client:Agave)",
    "solana-keygen": "solana-keygen 4.2.1 (src:test; feat:test, client:Agave)",
    "solana-test-validator": "solana-test-validator 4.2.1 (src:test; feat:test, client:Agave)",
    "spl-token": "spl-token-cli 5.6.1",
  };
  for (const [command, version] of Object.entries(agaveVersions)) {
    writeExecutable(join(agavePayload, command), [
      "#!/bin/sh",
      `if [ "\${1:-}" = --fixture-probe ]; then echo 'authenticated-${command}'; else echo '${version}'; fi`,
      "",
    ].join("\n"));
  }
  const agave = join(artifacts, "agave-test.tar.bz2");
  execFileSync("tar", ["-cjf", agave, "-C", join(root, "agave-payload"), "solana-release"]);

  const pnpmPayload = join(root, "pnpm-payload", "package");
  mkdirSync(join(pnpmPayload, "bin"), { recursive: true });
  mkdirSync(join(pnpmPayload, "dist"), { recursive: true });
  writeFileSync(join(pnpmPayload, "bin", "pnpm.cjs"), "process.stdout.write('11.24.0\\n');\n");
  writeFileSync(
    join(pnpmPayload, "dist", "pnpm.mjs"),
    [
      "// Runtime payload intentionally differs from the compatibility shim.",
      "import { spawnSync } from 'node:child_process';",
      "import { readFileSync } from 'node:fs';",
      "if (process.argv[2] === '--version') { process.stdout.write('11.24.0\\n'); }",
      "else {",
      "  const directoryIndex = process.argv.indexOf('--dir');",
      "  const runIndex = process.argv.indexOf('run');",
      "  const directory = process.argv[directoryIndex + 1];",
      "  const scriptName = process.argv[runIndex + 1];",
      "  const script = JSON.parse(readFileSync(new URL('package.json', `file://${directory}/`))).scripts[scriptName];",
      "  const result = spawnSync('/bin/sh', ['-c', script], { cwd: directory, env: process.env, stdio: 'inherit' });",
      "  process.exitCode = result.status ?? 1;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(pnpmPayload, "package.json"), '{"name":"pnpm","version":"11.24.0"}\n');
  const pnpm = join(artifacts, "pnpm-test.tgz");
  execFileSync("tar", ["-czf", pnpm, "-C", join(root, "pnpm-payload"), "package"]);
  return { agave, agavePayload, agaveVersions, foundry, node, pnpm, solc };
}

function fixtureLock(archives) {
  const definitions = {
    node: artifact({ name: "node-test.tar.gz", path: archives.node, archive: "tar.gz", installDirectory: "node-test-linux-x64", expectedFiles: ["bin/node"], versionPath: "bin/node", pattern: "^v24\\.20\\.0$" }),
    foundry: artifact({ name: "foundry-test.tar.gz", path: archives.foundry, archive: "tar.gz", installDirectory: "foundry-test-linux-x64", expectedFiles: ["forge", "cast", "anvil", "chisel"], versionPath: "forge", pattern: "^forge Version: 1\\.8\\.0$" }),
    solc: artifact({ name: "solc-test", path: archives.solc, archive: "executable", installDirectory: "solc-test-linux-x64", expectedFiles: ["solc"], versionPath: "solc", pattern: "Version: 0\\.8\\.36\\+commit\\.8a079791\\." }),
    agave: artifact({
      name: "agave-test.tar.bz2",
      path: archives.agave,
      archive: "tar.bz2",
      installDirectory: "agave-test-linux-x64",
      expectedFiles: Object.keys(archives.agaveVersions).map((name) => `bin/${name}`),
      versionPath: "bin/solana",
      pattern: "^solana-cli 4\\.2\\.1 .*client:Agave\\)$",
    }),
  };
  definitions.agave.versionChecks = Object.keys(archives.agaveVersions).map((name) => ({
    name,
    path: `bin/${name}`,
    args: ["--version"],
    pattern: name === "spl-token"
      ? "^spl-token-cli 5\\.6\\.1$"
      : `^${name === "solana" ? "solana-cli" : name} 4\\.2\\.1 .*client:Agave\\)$`,
  }));
  definitions.agave.expectedFileSha256 = Object.fromEntries(
    Object.keys(archives.agaveVersions)
      .map((name) => [`bin/${name}`, digest(join(archives.agavePayload, name))]),
  );
  return {
    schemaVersion: 2,
    platforms: ["darwin-arm64", "linux-x64"],
    coreTools: ["node", "foundry", "solc"],
    fixtureTools: ["agave"],
    tools: {
      node: coreTool("24.20.0", definitions.node),
      foundry: coreTool("1.8.0", definitions.foundry),
      solc: coreTool("0.8.36", definitions.solc),
      pnpm: packageManagerTool(archives.pnpm),
      typescript: packageTool("7.0.2"),
      oxlint: packageTool("1.80.0"),
      engineeringFoundation: packageTool("0.20.0"),
      agave: {
        scope: "local-solana-fixture",
        enabledForCore: false,
        version: "4.2.1",
        splTokenVersion: "5.6.1",
        sourceRelease: "https://github.com/anza-xyz/agave/releases/tag/v4.2.1",
        platforms: { "darwin-arm64": definitions.agave, "linux-x64": definitions.agave },
      },
      ccipSdk: futureTool(),
      ccipSolanaPrograms: futureTool(),
    },
    securityImages: { slither: securityImage() },
  };
}

export function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "agtmai-toolchain-test-"));
  const artifacts = join(root, "artifacts");
  const toolsRoot = join(root, "tools");
  mkdirSync(artifacts);
  const lock = fixtureLock(createArchives(root, artifacts));
  validateLock(lock);
  return {
    root,
    toolsRoot,
    lock,
    downloader: (url, partFd) => {
      writeSync(partFd, readFileSync(join(artifacts, basename(url))));
      return 0;
    },
  };
}

export function assertProtectedPnpmResolvesAuthenticatedTools() {
  const fixture = makeFixture();
  const project = join(fixture.root, "protected-pnpm-project");
  const hostile = join(fixture.root, "hostile-path");
  const packagePath = join(project, "package.json");
  const run = () => runPnpm({
    lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot,
    args: ["--dir", project, "run", "probe"],
  });
  const oldPath = process.env.PATH;
  try {
    fetchArtifacts({
      lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot,
      downloader: fixture.downloader,
    });
    installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
    mkdirSync(project);
    mkdirSync(hostile);
    for (const command of ["forge", "anvil", "solc", "solana"]) {
      writeExecutable(join(hostile, command), `#!/bin/sh\nprintf 'hostile-${command}\\n'\n`);
    }
    writeFileSync(packagePath, `${JSON.stringify({
      name: "protected-pnpm-probe", private: true,
      scripts: {
        probe: "forge --fixture-probe > probe-output && anvil --fixture-probe >> probe-output && solc --version >> probe-output",
      },
    })}\n`);
    process.env.PATH = hostile;
    assert.equal(run(), 0);
    assert.equal(
      readFileSync(join(project, "probe-output"), "utf8"),
      "authenticated-forge\nauthenticated-anvil\nVersion: 0.8.36+commit.8a079791.Linux.g++\n",
    );

    fetchArtifacts({
      lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot,
      downloader: fixture.downloader, scope: "solana",
    });
    installArtifacts({
      lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true, scope: "solana",
    });
    writeFileSync(packagePath, `${JSON.stringify({
      name: "protected-pnpm-probe", private: true,
      scripts: { probe: "solana --fixture-probe > probe-output" },
    })}\n`);
    assert.equal(run(), 0);
    assert.equal(readFileSync(join(project, "probe-output"), "utf8"), "authenticated-solana\n");

    writeFileSync(join(fixture.toolsRoot, "agave-test-linux-x64", "bin", "solana"), "tampered\n");
    assert.throws(run, /TOOLCHAIN_RUN_INVALID tool=agave reason=file-checksum:bin\/solana/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function writePathSemanticPnpmFixture(root) {
  const script = join(root, "pnpm-runtime.mjs");
  writeFileSync(script, [
    "import { basename } from 'node:path';",
    "if (basename(import.meta.filename) === 'pnpm.mjs') process.stdout.write('11.24.0\\n');",
    "",
  ].join("\n"));
  return script;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function writeCurrentNodeWrapper(root) {
  const wrapper = join(root, "node-wrapper");
  writeExecutable(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`);
  return wrapper;
}

export function assertPrivateInvocationRejectsAmbientConfig(context) {
  const root = mkdtempSync(join(tmpdir(), "agtmai-config-poisoning-"));
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const ambientConfigRoot = join("/tmp", ".config");
  const ambientPnpmRoot = join(ambientConfigRoot, "pnpm");
  const ambientConfig = join(ambientPnpmRoot, "config.yaml");
  let createdConfigRoot = false;
  let createdPnpmRoot = false;
  let createdConfig = false;
  const poisonShell = join(root, "poison-shell");
  const marker = join(root, "ambient-config-executed");
  const project = join(root, "project");
  const output = join(project, "probe-output");
  try {
    if (existsSync(ambientPnpmRoot)) {
      context.skip("ambient /tmp/.config/pnpm already exists; refusing to alter non-fixture state");
      return;
    }
    if (!existsSync(ambientConfigRoot)) {
      mkdirSync(ambientConfigRoot, { mode: 0o700 });
      createdConfigRoot = true;
    }
    mkdirSync(ambientPnpmRoot, { mode: 0o700 });
    createdPnpmRoot = true;
    const configFd = openSync(ambientConfig, "wx", 0o600);
    createdConfig = true;
    closeSync(configFd);
    writeExecutable(poisonShell, `#!/bin/sh\nprintf poison > ${shellQuote(marker)}\nexec /bin/sh "$@"\n`);
    writeFileSync(ambientConfig, `scriptShell: ${poisonShell}\n`);
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), `${JSON.stringify({
      name: "config-poisoning-probe",
      private: true,
      scripts: { probe: "printf safe > probe-output" },
    })}\n`);
    const pnpm = join(repositoryRoot, ".tools", "pnpm-11.24.0", "dist", "pnpm.mjs");
    executeOpenedNode({
      node: { path: process.execPath, sha256: digest(process.execPath) },
      script: { path: pnpm, sha256: digest(pnpm) },
      args: ["--dir", project, "run", "probe"],
      platform: process.platform,
    });
    assert.equal(readFileSync(output, "utf8"), "safe");
    assert.equal(existsSync(marker), false);
  } finally {
    if (createdConfig) {try {unlinkSync(ambientConfig);} catch {}}
    if (createdPnpmRoot) {try {rmdirSync(ambientPnpmRoot);} catch {}}
    if (createdConfigRoot) {try {rmdirSync(ambientConfigRoot);} catch {}}
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertTimedOutProcessGroupCannotWriteLate() {
  const root = mkdtempSync(join(tmpdir(), "agtmai-process-group-"));
  try {
    const runtime = join(root, "pnpm-runtime.mjs");
    const marker = join(root, "late-write");
    writeFileSync(runtime, [
      "import { spawn } from 'node:child_process';",
      `const marker = ${JSON.stringify(marker)};`,
      "const code = `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>{}); setTimeout(()=>writeFileSync(process.argv[1],'late'),700); setInterval(()=>{},1000);`;",
      "spawn(process.execPath, ['-e', code, marker], { stdio: 'ignore' });",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n"));
    assert.throws(() => executeOpenedNode({
      node: { path: process.execPath, sha256: digest(process.execPath) },
      script: { path: runtime, sha256: digest(runtime) },
      args: [],
      platform: process.platform,
      timeoutMs: 100,
    }), /TOOLCHAIN_PROCESS_GROUP_TIMEOUT/);
    spawnSync("/bin/sleep", ["0.8"]);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertDarwinDescriptorEntrypointIsSemanticallyWrong() {
  const root = mkdtempSync(join(tmpdir(), "agtmai-darwin-pnpm-fd-"));
  try {
    const script = writePathSemanticPnpmFixture(root);
    const fd = openSync(script, "r");
    try {
      const result = spawnSync(process.execPath, ["/dev/fd/3", "--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", fd],
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertDarwinMjsSnapshotEntrypointWorks() {
  const root = mkdtempSync(join(tmpdir(), "agtmai-darwin-pnpm-snapshot-"));
  try {
    // Snapshot a relocatable fixture, not the test runner's potentially
    // layout-dependent executable. The wrapper delegates only after its own
    // authenticated pathname and the pnpm.mjs pathname have been established.
    const node = writeCurrentNodeWrapper(root);
    const script = writePathSemanticPnpmFixture(root);
    assert.equal(executeOpenedNode({
      node: { path: node, sha256: digest(node) },
      script: { path: script, sha256: digest(script) },
      args: ["--version"], platform: "darwin",
    }), "11.24.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function assertDarwinSnapshotBehavior() {
  const root = mkdtempSync(join(tmpdir(), "agtmai-darwin-execution-"));
  const preserved = [];
  const expectPreserved = (run, code = /TOOLCHAIN_INVOCATION_CLEANUP_UNCERTAIN/) => {
    let failure;
    try {run();} catch (error) {failure = error;}
    assert.match(failure?.message ?? "", code);
    const invocation = failure.message.match(/invocation=(\S+)/)?.[1];
    assert.ok(invocation);
    preserved.push(invocation);
    return invocation;
  };
  try {
    const executable = join(root, "tool");
    writeExecutable(executable, "#!/bin/sh\nprintf '%s\\n' \"$0\"\n");
    const genericTarget = executeVerifiedFile({
      path: executable, expectedSha256: digest(executable), platform: "darwin",
    });
    assert.equal(genericTarget.startsWith(`${tmpdir()}/agtmai-toolchain-exec-`), true);
    assert.equal(basename(genericTarget), "executable");
    assert.equal(genericTarget.startsWith("/dev/fd/"), false);
    assert.equal(existsSync(genericTarget), false);

    const node = join(root, "node");
    const script = join(root, "script.mjs");
    writeExecutable(node, "#!/bin/sh\nprintf '%s|%s\\n' \"$0\" \"$1\"\n");
    writeFileSync(script, "// authenticated test script\n");
    const [nodeTarget, scriptTarget] = executeOpenedNode({
      node: { path: node, sha256: digest(node) },
      script: { path: script, sha256: digest(script) },
      args: [], platform: "darwin",
    }).split("|");
    assert.equal(nodeTarget.startsWith(`${tmpdir()}/agtmai-toolchain-exec-`), true);
    assert.equal(basename(nodeTarget), "node");
    assert.equal(nodeTarget.startsWith("/dev/fd/"), false);
    assert.equal(scriptTarget.startsWith(`${tmpdir()}/agtmai-toolchain-exec-`), true);
    assert.equal(dirname(scriptTarget), dirname(nodeTarget));
    assert.equal(basename(scriptTarget), "pnpm.mjs");
    assert.equal(scriptTarget.startsWith("/dev/fd/"), false);
    assert.equal(existsSync(nodeTarget), false);
    assert.equal(existsSync(scriptTarget), false);
    assert.equal(descriptorRoot("darwin"), "/dev/fd");

    writeExecutable(node, ["#!/bin/sh", "printf 'foreign evidence\\n' > \"${0%/*}/foreign\"", ""].join("\n"));
    const foreignRoot = expectPreserved(() => executeOpenedNode({
      node: { path: node, sha256: digest(node) }, script: { path: script, sha256: digest(script) },
      args: [], platform: "darwin",
    }));
    assert.equal(readFileSync(join(foreignRoot, "foreign"), "utf8"), "foreign evidence\n");
    assert.equal(existsSync(join(foreignRoot, "node")), true);
    assert.equal(existsSync(join(foreignRoot, "pnpm.mjs")), true);

    writeExecutable(executable, ["#!/bin/sh", "/bin/mv \"$0\" \"$0.original\"", "/bin/mkdir \"$0\"", "printf '%s\\n' \"$0\"", ""].join("\n"));
    const substitutedRoot = expectPreserved(() => executeVerifiedFile({
      path: executable, expectedSha256: digest(executable), platform: "darwin",
    }));
    assert.equal(lstatSync(substitutedRoot).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(substitutedRoot, "executable")).isDirectory(), true);
    assert.equal(lstatSync(join(substitutedRoot, "executable.original")).isFile(), true);
    assert.equal(lstatSync(join(substitutedRoot, "executable.original")).mode & 0o777, 0o500);

    writeExecutable(executable, ["#!/bin/sh", "root=${0%/*}", "/bin/mv \"$root\" \"$root.original\"", "/bin/mkdir -m 700 \"$root\"", "printf '%s\\n' \"$0\"", ""].join("\n"));
    const replacedRoot = expectPreserved(() => executeVerifiedFile({
      path: executable, expectedSha256: digest(executable), platform: "darwin",
    }));
    preserved.push(`${replacedRoot}.original`);
    assert.equal(lstatSync(replacedRoot).isDirectory(), true);
    assert.equal(lstatSync(join(`${replacedRoot}.original`, "executable")).isFile(), true);

    writeExecutable(executable, ["#!/bin/sh", "printf 'foreign evidence\\n' > \"${0%/*}/foreign\"", "printf '%s\\n' \"$0\"", ""].join("\n"));
    const secondForeignRoot = expectPreserved(() => executeVerifiedFile({
      path: executable, expectedSha256: digest(executable), platform: "darwin",
    }));
    assert.equal(existsSync(join(secondForeignRoot, "executable")), true);
    assert.equal(lstatSync(join(secondForeignRoot, "executable")).mode & 0o777, 0o500);
    assert.equal(readFileSync(join(secondForeignRoot, "foreign"), "utf8"), "foreign evidence\n");

    const externalHardlink = join(root, "external-hardlink");
    writeExecutable(executable, ["#!/bin/sh", `/bin/ln "$0" ${shellQuote(externalHardlink)}`, ""].join("\n"));
    const hardlinkRoot = expectPreserved(() => executeVerifiedFile({
      path: executable, expectedSha256: digest(executable), platform: "darwin",
    }));
    assert.equal(lstatSync(join(hardlinkRoot, "executable")).nlink, 2);
    assert.equal(lstatSync(externalHardlink).ino, lstatSync(join(hardlinkRoot, "executable")).ino);

    writeExecutable(executable, ["#!/bin/sh", "/bin/chmod 700 \"$0\"", "printf '# late mutation\\n' >> \"$0\"", ""].join("\n"));
    const mutatedRoot = expectPreserved(() => executeVerifiedFile({
      path: executable, expectedSha256: digest(executable), platform: "darwin",
    }));
    assert.match(readFileSync(join(mutatedRoot, "executable"), "utf8"), /late mutation/);
  } finally {
    for (const path of preserved) {rmSync(path, { recursive: true, force: true });}
    rmSync(root, { recursive: true, force: true });
  }
}
