import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  descriptorRoot,
  executeVerifiedFile,
  fetchArtifacts,
  hostPlatform,
  installArtifacts,
  verifyCache,
  canonicalizeTrustedPath,
} from "../toolchain.mjs";
import { runDoctor } from "../doctor.mjs";
import {
  assertDarwinDescriptorEntrypointIsSemanticallyWrong,
  assertDarwinMjsSnapshotEntrypointWorks,
  assertDarwinSnapshotBehavior,
  assertPrivateInvocationRejectsAmbientConfig,
  assertTimedOutProcessGroupCannotWriteLate,
  makeFixture,
} from "../toolchain-test-fixture.mjs";
import { digest, writeExecutable } from "./toolchain-fixtures.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");

function brokenDownloader(_url, partFd) {
  writeSync(partFd, "truncated");
  return 0;
}

test("Solana scope installs exact Agave and rejects a tampered inner binary", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    downloader: fixture.downloader,
    scope: "solana",
  });
  installArtifacts({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    offline: true,
    scope: "solana",
  });
  verifyCache({
    lock: fixture.lock,
    platform: "linux-x64",
    toolsRoot: fixture.toolsRoot,
    offline: true,
    scope: "solana",
  });
  const validator = join(fixture.toolsRoot, "agave-test-linux-x64", "bin", "solana-test-validator");
  writeFileSync(validator, "tampered\n");
  assert.throws(
    () => verifyCache({
      lock: fixture.lock,
      platform: "linux-x64",
      toolsRoot: fixture.toolsRoot,
      offline: true,
      scope: "solana",
    }),
    /TOOLCHAIN_INSTALL_INVALID tool=agave.*file-checksum:bin\/solana-test-validator/,
  );
});

test("canonicalizes the macOS system temp aliases but rejects attacker symlink roots", (context) => {
  if (process.platform === "darwin") {
    const canonical = canonicalizeTrustedPath(join("/var", "tmp", "agtmai-tools"), { platform: "darwin" });
    assert.equal(canonical.startsWith("/private/var/"), true);
  }
  const root = mkdtempSync(join(tmpdir(), "agtmai-symlink-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real-tools");
  const link = join(root, ".tools");
  mkdirSync(real);
  symlinkSync(real, link, "dir");
  assert.throws(() => canonicalizeTrustedPath(link), /TOOLCHAIN_DIRECTORY_IDENTITY_INVALID/);
});

test("macOS canonical root accepts trusted root-owned temp ancestors", (context) => {
  if (process.platform !== "darwin") {return;}
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const macToolsRoot = join("/tmp", basename(fixture.toolsRoot));
  rmSync(macToolsRoot, { recursive: true, force: true });
  mkdirSync(macToolsRoot, { recursive: true, mode: 0o700 });
  context.after(() => rmSync(macToolsRoot, { recursive: true, force: true }));
  assert.equal(canonicalizeTrustedPath(macToolsRoot, { platform: "darwin" }).startsWith("/private/tmp/"), true);
  // Host path semantics must accept macOS /tmp aliases while selecting linux artifacts.
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", hostPlatform: "darwin", toolsRoot: macToolsRoot, downloader: fixture.downloader });
});

test("macOS /var/folders canonical hierarchy rejects descendant symlinks", (context) => {
  if (process.platform !== "darwin") {return;}
  const folders = canonicalizeTrustedPath("/var/folders", { platform: "darwin" });
  assert.equal(folders, "/private/var/folders");
  const macTemp = canonicalizeTrustedPath(tmpdir(), { platform: "darwin" });
  assert.equal(macTemp.startsWith(`${folders}/`), true);
  const probe = mkdtempSync(join(macTemp, "agtmai-toolchain-probe-"));
  context.after(() => rmSync(probe, { recursive: true, force: true }));
  const real = join(probe, "real"); const link = join(probe, "link");
  mkdirSync(real); symlinkSync(real, link, "dir");
  assert.throws(() => canonicalizeTrustedPath(link, { platform: "darwin" }), /TOOLCHAIN_DIRECTORY_IDENTITY_INVALID/);
});

test("unsupported hosts fail closed", () => {
  assert.throws(() => hostPlatform({ platform: "win32", arch: "x64" }), /TOOLCHAIN_UNSUPPORTED_PLATFORM/);
});

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
  assert.match(bootstrap, /token_pinned_node.*scripts\/toolchain\.mjs/);
  assert.match(bootstrap, /fetch --scope=solana/);
  assert.doesNotMatch(bootstrap, /foundry-v1\.8\.0-linux-x64:.*solc-v0\.8\.36-linux-x64/);
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

test("environment helper requires Bash and runs Zsh portability where required or available", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-env-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const bin = join(root, ".tools", "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const pinnedDirectories = {
    [join(root, ".tools", `node-v24.20.0-${platform}`, "bin")]: ["node"],
    [join(root, ".tools", `foundry-v1.8.0-${platform}`)]: ["forge", "cast", "anvil", "chisel"],
    [join(root, ".tools", `solc-v0.8.36-${platform}`)]: ["solc"],
    [join(root, ".tools", `agave-v4.2.1-${platform}`, "bin")]: ["solana", "solana-keygen", "solana-test-validator", "spl-token"],
  };
  for (const [directory, commands] of Object.entries(pinnedDirectories)) {
    mkdirSync(directory, { recursive: true });
    for (const command of commands) { writeExecutable(join(directory, command), "#!/bin/sh\nexit 0\n"); }
  }
  writeExecutable(join(bin, "pnpm"), "#!/bin/sh\nexit 0\n");
  copyFileSync(join(repositoryRoot, "scripts/env.sh"), join(scripts, "env.sh"));
  writeExecutable(join(bin, "agtmai-env-probe"), "#!/bin/sh\nexit 0\n");
  assert.equal(existsSync("/bin/bash"), true, "Bash is a required portability dependency");
  const shells = ["/bin/bash"];
  const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(existsSync);
  if (process.platform === "darwin") {
    assert.ok(zsh, "Zsh is required on darwin");
  } else if (!zsh) {
    process.stdout.write("PORTABILITY_ZSH_NOT_INSTALLED platform=linux result=explicit-not-run\n");
  }
  if (zsh) {shells.push(zsh);}
  for (const shell of shells) {
    const result = spawnSync(shell, ["-c", `source '${join(scripts, "env.sh")}' && command -v agtmai-env-probe`], { encoding: "utf8" });
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), realpathSync(join(bin, "agtmai-env-probe")));
  }
});
test("pnpm offline cold cache ignores a system package manager", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  rmSync(join(fixture.toolsRoot, "downloads", fixture.lock.tools.pnpm.archiveName));
  const pathBin = join(fixture.root, "path-pnpm");
  mkdirSync(pathBin);
  writeExecutable(join(pathBin, "pnpm"), "#!/bin/sh\necho SYSTEM_PNPM_USED >&2\nexit 99\n");
  const oldPath = process.env.PATH;
  process.env.PATH = `${pathBin}:/usr/bin:/bin`;
  try {
    assert.throws(
      () => installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true }),
      /TOOLCHAIN_OFFLINE_CACHE_MISS tool=pnpm/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(existsSync(join(fixture.toolsRoot, "bin", "pnpm")), false);
});

test("production CLI rejects platform override", () => {
  const result = spawnSync(
    process.execPath,
    [join(repositoryRoot, "scripts/toolchain.mjs"), "verify", "--offline", "--platform=darwin-arm64"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TOOLCHAIN_PLATFORM_OVERRIDE_DISABLED/);
});

test("checksum mismatch retains truncated part and a clean retry installs atomically", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(
    () => fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: brokenDownloader }),
    /TOOLCHAIN_CHECKSUM_MISMATCH/,
  );
  const nodePart = join(fixture.toolsRoot, "downloads", fixture.lock.tools.node.platforms["linux-x64"].archiveName + ".part");
  assert.equal(readFileSync(nodePart, "utf8"), "truncated");

  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  assert.equal(existsSync(nodePart), false);
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  verifyCache({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  assert.deepEqual(
    readdirSync(fixture.toolsRoot).filter((name) => name.startsWith(".install-part-")),
    [],
  );
});

test("replacement of an open download part never writes the replacement target", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const victim = join(fixture.root, "victim");
  writeFileSync(victim, "victim-safe");
  const downloader = (url, partFd) => {
    fixture.downloader(url, partFd);
    const part = join(fixture.toolsRoot, "downloads", basename(url) + ".part");
    unlinkSync(part);
    symlinkSync(victim, part);
    writeSync(partFd, "unlinked-only");
    return 0;
  };
  assert.throws(
    () => fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader }),
    /TOOLCHAIN_FETCH_PART_UNSTABLE/,
  );
  assert.equal(readFileSync(victim, "utf8"), "victim-safe");
});

test("verified execution fails closed when the pathname is replaced after hashing", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-exec-race-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "tool");
  const markerPath = join(root, "attacker-ran");
  writeExecutable(executable, "#!/bin/sh\necho verified\n");
  const expectedSha256 = digest(executable);
  assert.throws(() => executeVerifiedFile({
    path: executable,
    expectedSha256,
    beforeSpawn: () => {
      renameSync(executable, executable + ".verified");
      writeExecutable(executable, `#!/bin/sh\necho attacker > ${JSON.stringify(markerPath)}\n`);
    },
  }), /TOOLCHAIN_FILE_IDENTITY_CHANGED/);
  assert.equal(existsSync(markerPath), false);
});

test("descriptor execution rejects unsupported hosts", () => {
  assert.throws(() => descriptorRoot("win32"), /TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED/);
});

test("Darwin execution uses private snapshots and preserves uncertain cleanup evidence", assertDarwinSnapshotBehavior);

test("Darwin dev-fd entrypoint loses pathname-sensitive pnpm output", {
  skip: process.platform === "darwin" ? false : `Darwin-only semantic check (host=${process.platform})`,
}, assertDarwinDescriptorEntrypointIsSemanticallyWrong);

test("Darwin authenticated mjs snapshot preserves pathname-sensitive pnpm output", assertDarwinMjsSnapshotEntrypointWorks);

test("private invocation environment behaviorally ignores ambient pnpm config poisoning", assertPrivateInvocationRejectsAmbientConfig);

test("timeout kills a TERM-ignoring process group before its grandchild writes", assertTimedOutProcessGroupCannotWriteLate);

test("Linux verified execution retains proc descriptor execution", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-linux-exec-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, "tool");
  writeExecutable(executable, "#!/bin/sh\necho linux-descriptor\n");
  if (process.platform !== "linux") {return;}
  assert.equal(executeVerifiedFile({
    path: executable,
    expectedSha256: digest(executable),
    platform: "linux",
  }), "linux-descriptor");
  assert.equal(descriptorRoot("linux"), "/proc/self/fd");
});

test("offline cold cache never uses PATH or a downloader", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const pathBin = join(fixture.root, "path-bin");
  mkdirSync(pathBin);
  writeExecutable(join(pathBin, "forge"), "#!/bin/sh\necho 'forge Version: 1.8.0'\n");
  const oldPath = process.env.PATH;
  process.env.PATH = pathBin;
  try {
    assert.throws(
      () => installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true }),
      /TOOLCHAIN_OFFLINE_CACHE_MISS/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
  assert.equal(existsSync(join(fixture.toolsRoot, "foundry-test-linux-x64")), false);
});

test("tampered present install is atomically replaced from the verified warm cache", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  const forge = join(fixture.toolsRoot, "foundry-test-linux-x64", "forge");
  const expected = readFileSync(forge, "utf8");
  writeFileSync(forge, "tampered\n");
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  assert.equal(readFileSync(forge, "utf8"), expected);
  assert.equal(
    readdirSync(fixture.toolsRoot).some((name) => name.includes(".replace-")),
    false,
  );
});

test("failed extraction preserves the present install and a verified retry replaces it", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });

  const forge = join(fixture.toolsRoot, "foundry-test-linux-x64", "forge");
  writeFileSync(forge, "tampered-present-install\n");
  const foundryArtifact = fixture.lock.tools.foundry.platforms["linux-x64"];
  const archive = join(fixture.toolsRoot, "downloads", foundryArtifact.archiveName);
  const expectedSha256 = foundryArtifact.sha256;
  writeFileSync(archive, "truncated-verified-fixture");
  foundryArtifact.sha256 = digest(archive);

  assert.throws(
    () => installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true }),
    /Command failed.*tar/s,
  );
  assert.equal(readFileSync(forge, "utf8"), "tampered-present-install\n");
  assert.deepEqual(readdirSync(fixture.toolsRoot).filter((name) => name.startsWith(".install-part-")), []);

  foundryArtifact.sha256 = expectedSha256;
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  assert.match(readFileSync(forge, "utf8"), /forge Version: 1\.8\.0/);
});

test("offline verified warm cache succeeds with PATH fallback disabled", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  const pathBin = join(fixture.root, "path-bin");
  mkdirSync(pathBin);
  for (const command of ["node", "forge", "cast", "anvil", "solc"]) {
    writeExecutable(join(pathBin, command), "#!/bin/sh\necho PATH_FALLBACK_USED >&2\nexit 99\n");
  }
  const oldPath = process.env.PATH;
  process.env.PATH = `${pathBin}:/usr/bin:/bin`;
  try {
    installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
    verifyCache({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("tampered pnpm payload and wrapper are rejected and restored from verified cache", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  const wrapper = join(fixture.toolsRoot, "bin", "pnpm");
  writeFileSync(wrapper, "tampered-wrapper\n");
  assert.throws(
    () => verifyCache({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true }),
    /TOOLCHAIN_INSTALL_INVALID tool=pnpm.*wrapper-missing-or-tampered/,
  );
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  assert.match(readFileSync(wrapper, "utf8"), /bootstrap\.sh.*run-pnpm/);

  const payload = join(fixture.toolsRoot, "pnpm-test", "bin", "pnpm.cjs");
  writeFileSync(payload, "tampered-payload\n");
  assert.throws(
    () => verifyCache({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true }),
    /TOOLCHAIN_INSTALL_INVALID tool=pnpm.*file-checksum:bin\/pnpm\.cjs/,
  );
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  verifyCache({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
});

test("forged provenance cannot bless a spoofed executable", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  const destination = join(fixture.toolsRoot, "solc-test-linux-x64");
  const executable = join(destination, "solc");
  writeExecutable(executable, "#!/bin/sh\necho spoofed\n");
  const provenancePath = join(destination, ".agtmai-toolchain-install.json");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  provenance.files.solc = digest(executable);
  writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`);
  assert.throws(
    () => verifyCache({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true }),
    /TOOLCHAIN_INSTALL_INVALID tool=solc.*provenance-mismatch/,
  );
});

test("doctor identifies a cached installation for the wrong platform", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  const lines = [];
  assert.equal(runDoctor({
    lock: fixture.lock,
    toolsRoot: fixture.toolsRoot,
    platformResolver: () => "darwin-arm64",
    environment: {},
    coreOnly: true,
    write: (line) => lines.push(line),
  }), 1);
  assert.match(lines.join("\n"), /TOOL_MISMATCH tool=node platform=darwin-arm64/);
  assert.match(lines.join("\n"), /install=provenance-mismatch/);
});

test("doctor reports exact checksums and actionable mismatch without exposing environment values", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  const lines = [];
  assert.equal(runDoctor({
    lock: fixture.lock,
    toolsRoot: fixture.toolsRoot,
    platformResolver: () => "linux-x64",
    environment: { PRIVATE_KEY: "must-not-appear" },
    coreOnly: true,
    write: (line) => lines.push(line),
  }), 0);
  assert.match(lines.join("\n"), /TOOL_OK tool=solc .*expectedSha256=[a-f0-9]{64} actualSha256=[a-f0-9]{64}/);
  assert.doesNotMatch(lines.join("\n"), /must-not-appear/);

  writeFileSync(join(fixture.toolsRoot, "solc-test-linux-x64", "solc"), "tampered\n");
  const mismatch = [];
  assert.equal(runDoctor({
    lock: fixture.lock,
    toolsRoot: fixture.toolsRoot,
    platformResolver: () => "linux-x64",
    environment: {},
    coreOnly: true,
    write: (line) => mismatch.push(line),
  }), 1);
  assert.match(mismatch.join("\n"), /TOOL_MISMATCH tool=solc .*install=file-checksum:solc .*action=/);
});

test("toolchain subprocesses use a minimal environment and protected download parts", () => {
  const executionSource = readFileSync(join(repositoryRoot, "scripts/toolchain-execution.mjs"), "utf8");
  const source = [readFileSync(join(repositoryRoot, "scripts/toolchain.mjs"), "utf8"), executionSource]
    .join("\n");
  assert.doesNotMatch(source, /env:\s*\{\s*\.\.\.process\.env/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /O_EXCL/);
  assert.match(source, /nlink !== 1/);
  assert.match(source, /function minimalSubprocessEnv/);
  assert.doesNotMatch(executionSource, /beforeSnapshotSpawn|rmSync\([^\n]+recursive/);
});
