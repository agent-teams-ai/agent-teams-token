import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { digest, writeExecutable } from "./toolchain-fixtures.mjs";
const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
export function registerBootstrapTests() {
test("Bash bootstrap starts from checksum-pinned Node without a system Node fallback", () => {
  const bootstrap = readFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), "utf8");
  assert.match(bootstrap, /node-v24\.20\.0-linux-x64\.tar\.xz/);
  assert.match(bootstrap, /2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2/);
  assert.match(bootstrap, /node-v24\.20\.0-darwin-arm64\.tar\.gz/);
  assert.match(bootstrap, /40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8/);
  assert.match(bootstrap, /\.part/);
  assert.match(bootstrap, /local token_part_fd=9[\s\S]*exec 9>/);
  assert.doesNotMatch(bootstrap, /exec \{token_part_fd\}/);
  assert.match(bootstrap, /--output - .*>&"\$token_part_fd"/);
  assert.doesNotMatch(bootstrap, /--output "?\$token_part/);
  assert.match(bootstrap, /token_run_node\(\)[\s\S]*token_pinned_node/);
  assert.match(bootstrap, /fetch --scope=solana/);
  assert.doesNotMatch(bootstrap, /foundry-v1\.8\.0-linux-x64:.*solc-v0\.8\.36-linux-x64/);
  assert.match(bootstrap, /\/usr\/bin\/tar --no-same-owner --no-same-permissions/u);
  assert.match(bootstrap, /exec 7<"\$token_archive_path"/u);
  assert.match(bootstrap, /exec 8<"\$token_archive_path"/u);
  assert.match(bootstrap, /exec 9<"\$token_archive_path"/u);
  assert.match(bootstrap, /exec 10<"\$token_snapshot_path"/u);
  assert.match(bootstrap, /exec 11<"\$token_snapshot_path"/u);
  assert.match(bootstrap, /exec 12<"\$token_snapshot_path"/u);
  assert.match(bootstrap, /token_descriptor_fingerprint\(\)/u);
  assert.match(bootstrap, /%d\|%i\|%p\|%u\|%g\|%z\|%Fm\|%Fc\|%l/u);
  assert.match(bootstrap, /%d\|%i\|%f\|%u\|%g\|%s\|%y\|%z\|%h/u);
  assert.match(bootstrap, /token_path_fingerprint\(\)/u);
  assert.doesNotMatch(bootstrap, /\/dev\/fd\/[789] -ef|-ef \/dev\/fd\/[789]/u);
  assert.doesNotMatch(bootstrap, /stat -f '%d\|%i' -/u);
  assert.match(bootstrap, /\/bin\/dd if=\/dev\/fd\/8 of="\$token_snapshot_path"/u);
  assert.doesNotMatch(bootstrap, /\/bin\/cp \/dev\/fd\//u);
  assert.match(bootstrap, /token_snapshot_sha256=\$\(token_sha256 \/dev\/fd\/10\)/u);
  assert.match(bootstrap, /token_post_extract_snapshot_sha256=\$\(token_sha256 \/dev\/fd\/12\)/u);
  assert.match(bootstrap, /"\$token_node_tar_flag" \/dev\/fd\/11/u);
  assert.match(bootstrap, /token_sha256 \/dev\/fd\/7/u);
  assert.doesNotMatch(bootstrap, /"\$token_node_tar_flag" "\$token_archive_path"/u);
  assert.match(bootstrap, /token_assert_private_snapshot_fingerprint[\s\S]*"\$token_archive_size" 0/u);
  assert.match(bootstrap, /token_run_node "\$token_repo_root\/scripts\/toolchain\.mjs"/u);
  assert.match(bootstrap, /archive\.snapshot/u);
  assert.match(bootstrap, /toolchain-cleanup\.mjs/u);
  assert.doesNotMatch(bootstrap, /rm -rf/u);
  assert.doesNotMatch(bootstrap, /TOKEN_BOOTSTRAP_NODE|\$\{[^}]+:-node\}/);
  assert.ok(bootstrap.indexOf("token_validate_directory \"$token_tools_root\" false") < bootstrap.indexOf("/bin/mkdir -p \"$token_tools_root\""));
  const dev = readFileSync(join(repositoryRoot, "dev"), "utf8");
  assert.doesNotMatch(dev, /exec (?:node|pnpm)|source .*env\.sh/);
  assert.doesNotMatch(bootstrap, /\/bin\/(?:chmod|mkdir|cp|mv|rm)[^\n]* --/);
  assert.doesNotMatch(bootstrap, /dirname --/);
  assert.match(dev, /bootstrap\.sh" doctor/);
  assert.match(dev, /bootstrap\.sh" run-pnpm check/);
});

test("bootstrap rejects a missing Node cache before a hostile PATH binary runs", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-bootstrap-path-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const hostile = join(root, "hostile");
  const markerPath = join(root, "ambient-node-ran");
  mkdirSync(scripts);
  mkdirSync(hostile);
  copyFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), join(scripts, "bootstrap.sh"));
  writeExecutable(join(hostile, "node"), `#!/bin/sh\necho ran > ${JSON.stringify(markerPath)}\n`);
  const result = spawnSync("/bin/bash", [join(scripts, "bootstrap.sh"), "doctor"], {
    encoding: "utf8",
    env: { PATH: hostile },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TOOLCHAIN_OFFLINE_CACHE_MISS/);
  assert.equal(existsSync(markerPath), false);
});

test("Bash download keeps the exclusive part descriptor across a pathname replacement race", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-bootstrap-race-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const payloadRoot = join(root, "payload");
  const nodeDirectory = "node-v24.20.0-linux-x64";
  const nodeBin = join(payloadRoot, nodeDirectory, "bin");
  const archive = join(root, "node-test.tar.gz");
  const archiveName = "node-test.tar.gz";
  const victim = join(root, "victim");
  const part = join(root, ".tools", "downloads", archiveName + ".part");
  const curl = join(root, "race-curl");
  mkdirSync(scripts);
  mkdirSync(nodeBin, { recursive: true });
  copyFileSync(join(repositoryRoot, "scripts/bootstrap.sh"), join(scripts, "bootstrap.sh"));
  writeExecutable(join(nodeBin, "node"), "#!/bin/sh\n[ \"${1:-}\" = --version ] && echo v24.20.0\n");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", payloadRoot, nodeDirectory]);
  writeFileSync(victim, "victim-safe");
  writeExecutable(curl, `#!/bin/sh\n/bin/rm -f ${JSON.stringify(part)}\n/bin/ln -s ${JSON.stringify(victim)} ${JSON.stringify(part)}\n/bin/cat ${JSON.stringify(archive)}\n`);
  const result = spawnSync("/bin/bash", [join(scripts, "bootstrap.sh"), "fetch"], {
    encoding: "utf8",
    env: {
      PATH: "/hostile",
      TOKEN_BOOTSTRAP_TEST_MODE: "1",
      TOKEN_BOOTSTRAP_TEST_NODE_ARCHIVE: archiveName,
      TOKEN_BOOTSTRAP_TEST_NODE_DIRECTORY: nodeDirectory,
      TOKEN_BOOTSTRAP_TEST_NODE_URL: "https://fixtures.invalid/node-test.tar.gz",
      TOKEN_BOOTSTRAP_TEST_NODE_SHA256: digest(archive),
      TOKEN_BOOTSTRAP_TEST_NODE_TAR_FLAG: "-xzf",
      TOKEN_BOOTSTRAP_TEST_CURL: curl,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TOOLCHAIN_FETCH_PART_UNSTABLE/);
  assert.equal(readFileSync(victim, "utf8"), "victim-safe");
});

test("environment helper enforces core and coherent optional pins in Bash and available Zsh", testEnvironmentShells);
}

const invocationFor = (mode) => mode.endsWith("and") ? 'source "$1" && printf "AND_RAN\\n"' : 'source "$1"';
const core = ["node", "forge", "cast", "anvil", "chisel", "solc", "pnpm"];
const solana = ["solana", "solana-keygen", "solana-test-validator", "spl-token"];
const modes = ["direct", "and", "errexit-direct", "errexit-and"];

async function testEnvironmentShells(context) {
  assert.equal(existsSync("/bin/bash"), true, "Bash is a required portability dependency");
  const shells = ["/bin/bash"];
  const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(existsSync);
  if (process.platform === "darwin") {
    assert.ok(zsh, "Zsh is required on darwin");
  } else if (!zsh) {
    process.stdout.write("PORTABILITY_ZSH_NOT_INSTALLED platform=linux result=explicit-not-run\n");
  }
  if (zsh) {shells.push(zsh);}
  const cases = environmentCases();
  for (const shell of shells) {
    const nativeReturns = new Map();
    for (const mode of modes) {
      await context.test(`${shell}: native sourced failure: ${mode}`, (child) => {
        nativeReturns.set(mode, nativeSourceFailure(child, shell, mode));
      });
    }
    for (const scenario of cases) {
      for (const mode of modes) {
        await context.test(`${shell}: ${scenario.name}: ${mode}`, (child) => {
          assert.ok(nativeReturns.has(mode), "independent native shell baseline must pass");
          checkEnvironmentScenario(child, { shell, scenario, mode, returnsToCaller: nativeReturns.get(mode) });
        });
      }
    }
  }
}

function runEnvironmentShell(context, shell, args, options) {
  // One case launches a shell, uname and up to eleven new executable stubs.
  // macOS first-use runs exceeded the old aggregate 5s limit. Keep a finite
  // 30s allowance there, with phase output on failure and no automatic retry.
  const shellTimeout = process.platform === "darwin" ? 30_000 : 5_000;
  const label = context.name;
  const started = performance.now();
  const result = spawnSync(shell, args, {
    ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    timeout: shellTimeout, killSignal: "SIGKILL",
  });
  const elapsed = Math.ceil(performance.now() - started);
  const detail = `${label}: elapsed=${elapsed}ms timeout=${shellTimeout}ms status=${result.status} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  assert.equal(result.error, undefined, detail);
  assert.equal(result.signal, null, detail);
  if (elapsed >= 5_000) {context.diagnostic(`ENV_SHELL_SLOW ${label} elapsed=${elapsed}ms`);}
  return result;
}

function linkDirectory(path) {
  renameSync(path, `${path}.real`);
  symlinkSync(`${path}.real`, path, "dir");
}

function environmentCases() {
  const cases = [
    { name: "core only" },
    { name: "all Solana pins", solana: true },
    { name: "relative source", prepare: (fixture) => { fixture.source = "scripts/env.sh"; } },
    { name: "bare source", prepare: (fixture) => { fixture.cwd = join(fixture.root, "scripts"); fixture.source = "env.sh"; } },
    { name: "unsupported platform", error: /TOOLCHAIN_UNSUPPORTED_PLATFORM/u,
      before: "function /usr/bin/uname { printf 'unsupported\\n'; }\n" },
    { name: "failed root resolution", error: /ROOT_RESOLUTION_FAILED/u,
      before: "cd() { printf 'ROOT_RESOLUTION_FAILED\\n' >&2; return 23; }\n" },
    { name: "PATH separator in root", colon: true, error: /TOOLCHAIN_ENV_PATH_INVALID/u },
    { name: "empty optional root", error: /TOOLCHAIN_ENV_PIN_MISSING/u,
      prepare: (fixture) => mkdirSync(dirname(fixture.agave)) },
    { name: "optional root is a file", error: /TOOLCHAIN_ENV_PIN_MISSING/u,
      prepare: (fixture) => writeFileSync(dirname(fixture.agave), "invalid\n") },
    { name: "dangling optional root", error: /TOOLCHAIN_ENV_PIN_MISSING/u,
      prepare: (fixture) => symlinkSync(join(fixture.root, "absent"), dirname(fixture.agave)) },
    { name: "optional root symlink", solana: true, error: /TOOLCHAIN_ENV_DIRECTORY_IDENTITY_INVALID/u,
      prepare: (fixture) => linkDirectory(dirname(fixture.agave)) },
    { name: "optional bin symlink", solana: true, error: /TOOLCHAIN_ENV_DIRECTORY_IDENTITY_INVALID/u,
      prepare: (fixture) => linkDirectory(fixture.agave) },
    { name: "source symlink", error: /TOOLCHAIN_ENV_SOURCE_IDENTITY_INVALID/u,
      prepare: (fixture) => { const link = join(fixture.root, "env-link.sh"); symlinkSync(fixture.source, link); fixture.source = link; } },
    { name: "scripts directory symlink", error: /TOOLCHAIN_ENV_SOURCE_IDENTITY_INVALID/u,
      prepare: (fixture) => linkDirectory(join(fixture.root, "scripts")) },
    { name: "repository symlink", error: /TOOLCHAIN_ENV_SOURCE_IDENTITY_INVALID/u,
      prepare: (fixture) => {
        const link = join(fixture.root, "alias"); symlinkSync(fixture.root, link, "dir");
        fixture.source = join(link, "scripts/env.sh");
      } },
    { name: "symlink before dot-dot", error: /TOOLCHAIN_ENV_SOURCE_IDENTITY_INVALID/u,
      prepare: (fixture) => {
        const target = join(fixture.root, "target"); mkdirSync(target);
        symlinkSync(target, join(fixture.root, "alias"), "dir");
        fixture.source = `${fixture.root}/alias/../scripts/env.sh`;
      } },
    { name: "re-source missing core", solana: true, error: /TOOLCHAIN_ENV_PIN_MISSING/u,
      before: 'source "$1" || exit 92\n/bin/rm -f "$3"\n' },
    { name: "re-source incomplete optional", solana: true, error: /TOOLCHAIN_ENV_PIN_MISSING/u,
      before: 'source "$1" || exit 92\n/bin/rm -f "$4"\n' },
    { name: "re-source after optional removal", solana: true, coreAfter: true,
      before: 'source "$1" || exit 92\n/bin/rm -rf "$5"\n' },
  ];
  for (const command of core) {
    cases.push({ name: `missing core ${command}`, error: /TOOLCHAIN_ENV_PIN_MISSING/u,
      prepare: (fixture) => rmSync(fixture.commands.get(command)) });
  }
  for (const command of ["node", ...solana]) {
    for (const kind of ["missing", "non-executable", "symlink", "directory"]) {
      cases.push({ name: `${kind} pin ${command}`, solana: true, error: /TOOLCHAIN_ENV_PIN_MISSING/u,
        prepare: (fixture) => {
          const path = fixture.commands.get(command);
          if (kind === "non-executable") { chmodSync(path, 0o644); return; }
          rmSync(path);
          if (kind === "symlink") { symlinkSync(fixture.commands.get("forge"), path); }
          if (kind === "directory") { mkdirSync(path); }
        } });
    }
  }
  for (const key of ["tools", "node", "nodeRoot", "foundry", "solc", "bin"]) {
    cases.push({ name: `${key} directory symlink`, error: /TOOLCHAIN_ENV_DIRECTORY_IDENTITY_INVALID/u,
      prepare: (fixture) => linkDirectory(fixture[key]) });
  }
  if (process.platform === "darwin") {
    cases.push({ name: "trusted macOS temp alias", prefix: "/tmp/agtmai-env alias-",
      prepare: (fixture) => { fixture.source = fixture.source.replace(/^\/private\/tmp\//u, "/tmp/"); } });
  }
  return cases;
}

function nativeSourceFailure(context, shell, mode) {
  // Independent shell semantics, with no env.sh code or toolchain fixture.
  // Bash 3.2 can exit even for `source file && next` under set -e; Zsh and
  // newer Bash return to the caller. Neither may run the RHS on failure.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-shell-baseline-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "failure.sh");
  writeFileSync(source, "f() { unset -f f; return 1; }\nf\n");
  const result = runEnvironmentShell(context, shell, ["-f", "-c", [
    mode.startsWith("errexit") ? "set -e" : ":", invocationFor(mode),
    'source_result=$?', 'printf "STATUS=%s\\n" "$source_result"', 'exit "$source_result"',
  ].join("\n"), "native-test", source], {
    cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "");
  if (mode === "errexit-and") {assert.ok(["", "STATUS=1\n"].includes(result.stdout), result.stdout);}
  else {assert.equal(result.stdout, mode === "errexit-direct" ? "" : "STATUS=1\n");}
  const returnsToCaller = result.stdout === "STATUS=1\n";
  context.diagnostic(`NATIVE_SOURCE_FAILURE returnsToCaller=${returnsToCaller} status=1`);
  return returnsToCaller;
}

function environmentFixture(context, scenario) {
  const root = realpathSync(mkdtempSync(scenario.prefix ?? join(tmpdir(), `agtmai-env '${scenario.colon ? ":" : ""}test-`)));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const tools = join(root, ".tools");
  const fixture = {
    root, tools, cwd: root, source: join(root, "scripts/env.sh"), commands: new Map(),
    nodeRoot: join(tools, `node-v24.20.0-${platform}`),
    node: join(tools, `node-v24.20.0-${platform}`, "bin"),
    foundry: join(tools, `foundry-v1.8.0-${platform}`),
    solc: join(tools, `solc-v0.8.36-${platform}`),
    agave: join(tools, `agave-v4.2.1-${platform}`, "bin"), bin: join(tools, "bin"),
  };
  mkdirSync(dirname(fixture.source));
  copyFileSync(join(repositoryRoot, "scripts/env.sh"), fixture.source);
  for (const [directory, commands] of [
    [fixture.node, ["node"]], [fixture.foundry, ["forge", "cast", "anvil", "chisel"]],
    [fixture.solc, ["solc"]], [fixture.bin, ["pnpm"]],
    ...(scenario.solana ? [[fixture.agave, solana]] : []),
  ]) {
    mkdirSync(directory, { recursive: true });
    for (const command of commands) {
      const path = join(directory, command);
      writeExecutable(path, `#!/bin/sh\nprintf 'pinned-${command}\\n'\n`);
      fixture.commands.set(command, path);
    }
  }
  const hostile = join(root, "hostile");
  const marker = join(root, "ambient-ran");
  mkdirSync(hostile);
  for (const command of [...core, ...solana, "ambient-only", "uname"]) {
    writeExecutable(join(hostile, command), '#!/bin/sh\nprintf decoy > "$ENV_DECOY_MARKER"\nexit 97\n');
  }
  scenario.prepare?.(fixture);
  return { ...fixture, hostile, marker };
}

function acceptedCommands(scenario) {
  return scenario.solana && !scenario.coreAfter ? [...core, ...solana] : core;
}

function environmentProbe(scenario, mode) {
  const accepted = acceptedCommands(scenario);
  return [
    "printf 'SHELL_STARTED\\n'",
    mode.startsWith("errexit") ? "set -e" : ":",
    scenario.before ?? "", "printf 'SOURCE_STARTED\\n'", invocationFor(mode), "source_result=$?",
    "printf 'STATUS=%s\\nPATH=%s\\nANVIL=%s\\nFORGE=%s\\nSOLC=%s\\nDOWNLOAD=%s\\nPROJECT=%s\\n' \"$source_result\" \"$PATH\" \"${AGTMAI_ANVIL_BINARY-unset}\" \"${AGTMAI_FORGE_BINARY-unset}\" \"${AGTMAI_SOLC_BINARY-unset}\" \"${COREPACK_ENABLE_DOWNLOAD_PROMPT-unset}\" \"${COREPACK_ENABLE_PROJECT_SPEC-unset}\"",
    `for probe in ${[...core, ...solana, "ambient-only", "sh", "uname"].join(" ")}; do`,
    "  printf 'RESOLVE:%s=%s\\n' \"$probe\" \"$(command -v \"$probe\" || :)\"", "done",
    `if [[ "$source_result" == 0 ]]; then for probe in ${accepted.join(" ")}; do printf 'EXECUTE:%s\\n' "$probe"; "$probe" || exit 91; done; fi`,
    "printf 'VARIABLES\\n'", "typeset -p", "printf 'FUNCTIONS\\n'", "typeset -f",
    'exit "$source_result"',
  ].join("\n");
}

function checkEnvironmentScenario(context, { shell, scenario, mode, returnsToCaller }) {
  const fixture = environmentFixture(context, scenario);
  const script = environmentProbe(scenario, mode);
  const result = runEnvironmentShell(context, shell, ["-f", "-c", script, "env-test", fixture.source, fixture.root,
    fixture.commands.get("node"), join(fixture.agave, "spl-token"), dirname(fixture.agave)], {
    cwd: fixture.cwd,
    env: { HOME: fixture.root, PATH: `${fixture.hostile}:/usr/bin:/bin`, ENV_DECOY_MARKER: fixture.marker,
      AGTMAI_ANVIL_BINARY: "/old/anvil", AGTMAI_FORGE_BINARY: "/old/forge", AGTMAI_SOLC_BINARY: "/old/solc",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "1", COREPACK_ENABLE_PROJECT_SPEC: "1" },
  });
  assert.equal(result.status, scenario.error ? 1 : 0, result.stderr);
  assert.equal(existsSync(fixture.marker), false, "ambient PATH decoy must not execute");
  if (scenario.error) { assert.match(result.stderr, scenario.error); }
  else { assert.equal(result.stderr, ""); }
  if (scenario.error && !returnsToCaller) {
    assert.equal(result.stdout, "SHELL_STARTED\nSOURCE_STARTED\n", "native errexit must prevent caller continuation and the AND command");
    return;
  }
  assertEnvironmentOutput(result, fixture, scenario, mode);
}

function assertEnvironmentOutput(result, fixture, scenario, mode) {
  const accepted = acceptedCommands(scenario);
  const [output, declarations] = result.stdout.split("VARIABLES\n");
  assert.ok(declarations, "source returned to caller for cleanup inspection");
  const [variables, functions] = declarations.split("FUNCTIONS\n");
  assert.doesNotMatch(variables, /\btoken_env_\w*=/u);
  assert.doesNotMatch(functions, /^token_env_/mu);
  const expectedPath = scenario.error ? "/dev/null" : [fixture.node, fixture.foundry, fixture.solc,
    ...(scenario.solana && !scenario.coreAfter ? [fixture.agave] : []), fixture.bin].join(":");
  assert.ok(output.includes(`STATUS=${scenario.error ? 1 : 0}\nPATH=${expectedPath}\n`), output);
  for (const [label, command] of [["ANVIL", "anvil"], ["FORGE", "forge"], ["SOLC", "solc"]]) {
    assert.ok(output.includes(`${label}=${scenario.error ? "unset" : fixture.commands.get(command)}\n`), output);
  }
  for (const label of ["DOWNLOAD", "PROJECT"]) {
    assert.ok(output.includes(`${label}=${scenario.error ? "unset" : "0"}\n`), output);
  }
  for (const command of [...core, ...solana, "ambient-only", "sh", "uname"]) {
    const path = !scenario.error && accepted.includes(command) ? fixture.commands.get(command) : "";
    assert.ok(output.includes(`RESOLVE:${command}=${path}\n`), output);
    if (path) { assert.ok(output.includes(`pinned-${command}\n`), output); }
  }
  assert.equal(output.includes("AND_RAN\n"), !scenario.error && mode.endsWith("and"));
}
