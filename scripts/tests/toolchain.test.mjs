import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  fetchArtifacts,
  hostPlatform,
  installArtifacts,
  loadLock,
  validateLock,
  verifyCache,
  canonicalizeTrustedPath,
} from "../toolchain.mjs";
import { runDoctor } from "../doctor.mjs";
import {
  artifact, coreTool, packageTool, packageManagerTool, futureTool, securityImage, digest, writeExecutable,
} from "./toolchain-fixtures.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");

function brokenDownloader(_url, part) {
  writeFileSync(part, "truncated");
  return 0;
}

test("committed lock schema covers Core, Solana fixture and future tools separately", () => {
  const lock = loadLock(join(repositoryRoot, "tooling/toolchain.lock.json"));
  assert.deepEqual(lock.platforms, ["darwin-arm64", "linux-x64"]);
  assert.deepEqual(lock.coreTools, ["node", "foundry", "solc"]);
  assert.deepEqual(lock.fixtureTools, ["agave"]);
  assert.equal(lock.tools.pnpm.version, "11.24.0");
  assert.equal(lock.tools.pnpm.source, "https://registry.npmjs.org/pnpm/-/pnpm-11.24.0.tgz");
  assert.equal(lock.tools.pnpm.sha256, "d1eab2433172661cc36a18ec85fce93f771db1962717329cc01ec9c2824ca24f");
  assert.equal(lock.tools.solc.platforms["darwin-arm64"].requires, "Rosetta 2 because upstream publishes macosx-amd64");
  assert.equal(lock.tools.solc.platforms["darwin-arm64"].sha256, "d4abcf0b3e24b7948ddfd64c374d26c3214648717777790ecb936979054a129d");
  assert.equal(lock.tools.foundry.platforms["linux-x64"].sha256, "8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57");
  assert.match(lock.tools.foundry.platforms["darwin-arm64"].checksumSource, /darwin_arm64\.sha256$/);
  assert.match(lock.tools.foundry.platforms["linux-x64"].checksumSource, /linux_amd64\.sha256$/);
  for (const platform of lock.platforms) {
    assert.deepEqual(
      lock.tools.foundry.platforms[platform].versionChecks.map(({ name }) => name),
      ["forge", "cast", "anvil", "chisel"],
    );
  }
  assert.equal(lock.tools.agave.scope, "local-solana-fixture");
  assert.equal(lock.tools.agave.version, "4.2.1");
  assert.equal(lock.tools.agave.splTokenVersion, "5.6.1");
  for (const platform of lock.platforms) {
    assert.equal(lock.tools.agave.platforms[platform].archive, "tar.bz2");
    assert.deepEqual(
      Object.keys(lock.tools.agave.platforms[platform].expectedFileSha256),
      lock.tools.agave.platforms[platform].expectedFiles,
    );
  }
  assert.equal(lock.securityImages.slither.versions.slither, "0.11.6");
  assert.equal(lock.securityImages.slither.versions.forge, "1.8.0");
  assert.match(lock.securityImages.slither.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  for (const name of ["ccipSdk", "ccipSolanaPrograms"]) {
    assert.equal(lock.tools[name].scope, "future-non-core");
    assert.equal(lock.tools[name].enabledForCore, false);
  }
  assert.throws(
    () => validateLock({ ...lock, platforms: ["linux-x64"] }),
    /TOOLCHAIN_LOCK_PLATFORMS/,
  );
  const floating = structuredClone(lock);
  floating.tools.node.platforms["linux-x64"].url = "https://fixtures.invalid/latest/node.tar.xz";
  assert.throws(() => validateLock(floating), /TOOLCHAIN_LOCK_FLOATING/);
});

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
  fetchArtifacts({ lock: fixture.lock, platform: "darwin-arm64", toolsRoot: macToolsRoot, downloader: fixture.downloader });
});

test("macOS /var/folders canonical hierarchy rejects descendant symlinks", (context) => {
  if (process.platform !== "darwin") return;
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
  assert.match(bootstrap, /token_pinned_node.*scripts\/toolchain\.mjs/);
  assert.doesNotMatch(bootstrap, /TOKEN_BOOTSTRAP_NODE|\$\{[^}]+:-node\}/);
});

test("environment helper requires Bash and runs Zsh portability where required or available", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-env-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const bin = join(root, ".tools", "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
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
    assert.equal(result.stdout.trim(), join(bin, "agtmai-env-probe"));
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
  assert.match(readFileSync(wrapper, "utf8"), /pnpm-test\/bin\/pnpm\.cjs/);
  assert.match(readFileSync(wrapper, "utf8"), /--config\.auto-install-peers=false/);

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
    /TOOLCHAIN_INSTALL_INVALID tool=solc.*file-checksum:solc/,
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

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "agtmai-toolchain-test-"));
  const artifacts = join(root, "artifacts");
  const toolsRoot = join(root, "tools");
  mkdirSync(artifacts);

  const nodePayload = join(root, "node-payload", "node-test-linux-x64", "bin");
  mkdirSync(nodePayload, { recursive: true });
  writeExecutable(
    join(nodePayload, "node"),
    "#!/bin/sh\ncase \"${1:-}\" in *pnpm.cjs) echo '11.24.0' ;; *) echo 'v24.20.0' ;; esac\n",
  );
  const nodeArchive = join(artifacts, "node-test.tar.gz");
  execFileSync("tar", ["-czf", nodeArchive, "-C", join(root, "node-payload"), "node-test-linux-x64"]);

  const foundryPayload = join(root, "foundry-payload", "foundry-test-linux-x64");
  mkdirSync(foundryPayload, { recursive: true });
  for (const command of ["forge", "cast", "anvil", "chisel"]) {
    writeExecutable(join(foundryPayload, command), `#!/bin/sh\necho '${command} Version: 1.8.0'\n`);
  }
  const foundryArchive = join(artifacts, "foundry-test.tar.gz");
  execFileSync("tar", ["-czf", foundryArchive, "-C", join(root, "foundry-payload"), "foundry-test-linux-x64"]);

  const solcArchive = join(artifacts, "solc-test");
  writeExecutable(solcArchive, "#!/bin/sh\necho 'Version: 0.8.36+commit.8a079791.Linux.g++'\n");

  const agavePayload = join(root, "agave-payload", "solana-release", "bin");
  mkdirSync(agavePayload, { recursive: true });
  const agaveVersions = {
    solana: "solana-cli 4.2.1 (src:test; feat:test, client:Agave)",
    "solana-keygen": "solana-keygen 4.2.1 (src:test; feat:test, client:Agave)",
    "solana-test-validator": "solana-test-validator 4.2.1 (src:test; feat:test, client:Agave)",
    "spl-token": "spl-token-cli 5.6.1",
  };
  for (const [command, version] of Object.entries(agaveVersions)) {
    writeExecutable(join(agavePayload, command), `#!/bin/sh\necho '${version}'\n`);
  }
  const agaveArchive = join(artifacts, "agave-test.tar.bz2");
  execFileSync("tar", ["-cjf", agaveArchive, "-C", join(root, "agave-payload"), "solana-release"]);

  const pnpmPayload = join(root, "pnpm-payload", "package");
  mkdirSync(join(pnpmPayload, "bin"), { recursive: true });
  writeFileSync(join(pnpmPayload, "bin", "pnpm.cjs"), "process.stdout.write('11.24.0\\n');\n");
  writeFileSync(join(pnpmPayload, "package.json"), '{"name":"pnpm","version":"11.24.0"}\n');
  const pnpmArchive = join(artifacts, "pnpm-test.tgz");
  execFileSync("tar", ["-czf", pnpmArchive, "-C", join(root, "pnpm-payload"), "package"]);

  const definitions = {
    node: artifact({ name: "node-test.tar.gz", path: nodeArchive, archive: "tar.gz", installDirectory: "node-test-linux-x64", expectedFiles: ["bin/node"], versionPath: "bin/node", pattern: "^v24\\.20\\.0$" }),
    foundry: artifact({ name: "foundry-test.tar.gz", path: foundryArchive, archive: "tar.gz", installDirectory: "foundry-test-linux-x64", expectedFiles: ["forge", "cast", "anvil", "chisel"], versionPath: "forge", pattern: "^forge Version: 1\\.8\\.0$" }),
    solc: artifact({ name: "solc-test", path: solcArchive, archive: "executable", installDirectory: "solc-test-linux-x64", expectedFiles: ["solc"], versionPath: "solc", pattern: "Version: 0\\.8\\.36\\+commit\\.8a079791\\." }),
    agave: artifact({
      name: "agave-test.tar.bz2",
      path: agaveArchive,
      archive: "tar.bz2",
      installDirectory: "agave-test-linux-x64",
      expectedFiles: Object.keys(agaveVersions).map((name) => `bin/${name}`),
      versionPath: "bin/solana",
      pattern: "^solana-cli 4\\.2\\.1 .*client:Agave\\)$",
    }),
  };
  definitions.agave.versionChecks = Object.keys(agaveVersions).map((name) => ({
    name,
    path: `bin/${name}`,
    args: ["--version"],
    pattern: name === "spl-token"
      ? "^spl-token-cli 5\\.6\\.1$"
      : `^${name === "solana" ? "solana-cli" : name} 4\\.2\\.1 .*client:Agave\\)$`,
  }));
  definitions.agave.expectedFileSha256 = Object.fromEntries(
    Object.keys(agaveVersions).map((name) => [`bin/${name}`, digest(join(agavePayload, name))]),
  );
  const lock = {
    schemaVersion: 2,
    platforms: ["darwin-arm64", "linux-x64"],
    coreTools: ["node", "foundry", "solc"],
    fixtureTools: ["agave"],
    tools: {
      node: coreTool("24.20.0", definitions.node),
      foundry: coreTool("1.8.0", definitions.foundry),
      solc: coreTool("0.8.36", definitions.solc),
      pnpm: packageManagerTool(pnpmArchive),
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
  validateLock(lock);
  return {
    root,
    toolsRoot,
    lock,
    downloader: (url, part) => {
      copyFileSync(join(artifacts, basename(url)), part);
      return 0;
    },
  };
}



test("toolchain subprocesses use a minimal environment and protected download parts", () => {
  const source = readFileSync(join(repositoryRoot, "scripts/toolchain.mjs"), "utf8");
  assert.doesNotMatch(source, /env:\s*\{\s*\.\.\.process\.env/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /O_EXCL/);
  assert.match(source, /nlink !== 1/);
  assert.match(source, /function minimalSubprocessEnv/);
});
