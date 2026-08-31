import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  fetchArtifacts,
  hostPlatform,
  installArtifacts,
  loadLock,
  prepareVerifiedPayload,
  validateLock,
  verifyCache,
} from "../toolchain.mjs";
import { runDoctor } from "../doctor.mjs";
import { registerToolchainAuthorityTests } from "./toolchain-authority.test.mjs";
import { digest, makeFixture, writeExecutable } from "./toolchain-fixture.mjs";

registerToolchainAuthorityTests();

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
});

test("environment helper requires Bash and runs Zsh portability where required or available", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-env-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const bin = join(root, ".tools", "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(repositoryRoot, "scripts/env.sh"), join(scripts, "env.sh"));
  const probe = join(bin, "agtmai-env-probe");
  writeExecutable(probe, "#!/bin/sh\nexit 0\n");
  const canonicalProbe = realpathSync(probe);
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
    assert.equal(result.stdout.trim(), canonicalProbe);
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
    /TOOLCHAIN_ARCHIVE_EXTRACTION_FAILED/u,
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
  const wrapperText = readFileSync(wrapper, "utf8");
  const nodeWrapperText = readFileSync(join(fixture.toolsRoot, "bin", "node"), "utf8");
  assert.match(wrapperText, /^#!\/bin\/bash/u);
  assert.match(wrapperText, /pnpm-test\/bin\/pnpm\.cjs/);
  assert.match(wrapperText, /--ignore-pnpmfile/u);
  assert.match(wrapperText, /--config\.store-dir="\$token_pnpm_store"/u);
  assert.match(wrapperText, /--config\.cache-dir=\/dev\/null/u);
  assert.match(wrapperText, /--config\.ignore-pnpmfile=true/u);
  assert.match(wrapperText, /--config\.userconfig=\/dev\/null/u);
  assert.match(wrapperText, /\/usr\/bin\/stat -c '%u\|%a'/u);
  assert.match(wrapperText, /\/usr\/bin\/id -u/u);
  assert.match(wrapperText, /--config\.auto-install-peers=false/);
  assert.match(wrapperText, /--config\.verify-deps-before-run=false/);
  assert.doesNotMatch(wrapperText, /\/usr\/bin\/env|\bdirname\b/u);
  assert.match(nodeWrapperText, /\/usr\/bin\/env -i/u);
  assert.match(nodeWrapperText, /GIT_CONFIG_COUNT=6/u);
  assert.match(nodeWrapperText, /GIT_CONFIG_KEY_0=core\.fsmonitor GIT_CONFIG_VALUE_0=false/u);
  assert.match(nodeWrapperText, /GIT_CONFIG_KEY_1=core\.hooksPath GIT_CONFIG_VALUE_1=\/dev\/null/u);
  assert.match(nodeWrapperText, /GIT_CONFIG_KEY_2=core\.attributesFile GIT_CONFIG_VALUE_2=\/dev\/null/u);
  assert.match(nodeWrapperText, /GIT_CONFIG_KEY_5=safe\.directory/u);
  assert.match(nodeWrapperText, /HOME="\$token_node_private_root\/home"/u);
  assert.match(nodeWrapperText, /NODE_DISABLE_COMPILE_CACHE=1/u);
  assert.match(nodeWrapperText, /npm_config_userconfig=\/dev\/null/u);
  assert.doesNotMatch(nodeWrapperText, /NODE_OPTIONS|NODE_PATH|HTTP_PROXY/iu);

  const payload = join(fixture.toolsRoot, "pnpm-test", "bin", "pnpm.cjs");
  writeFileSync(payload, "tampered-payload\n");
  assert.throws(
    () => verifyCache({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true }),
    /TOOLCHAIN_INSTALL_INVALID tool=pnpm.*file-checksum:bin\/pnpm\.cjs/,
  );
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  verifyCache({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
});

test("coherent forged payload and mutable provenance cannot self-attest Foundry, solc or pnpm", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });

  const forgeries = [
    {
      directory: "foundry-test-linux-x64",
      path: "forge",
      contents: "#!/bin/sh\necho 'forge Version: 1.8.0'\n# forged no-op\n",
      tool: "foundry",
    },
    {
      directory: "solc-test-linux-x64",
      path: "solc",
      contents: "#!/bin/sh\necho 'Version: 0.8.36+commit.8a079791.Linux.g++'\n# forged compiler\n",
      tool: "solc",
    },
    {
      directory: "pnpm-test",
      path: "bin/pnpm.cjs",
      contents: "process.stdout.write('11.24.0\\n'); // forged package manager\n",
      tool: "pnpm",
    },
  ];
  for (const forgery of forgeries) {
    const directory = join(fixture.toolsRoot, forgery.directory);
    const payload = join(directory, forgery.path);
    writeFileSync(payload, forgery.contents);
    if (forgery.tool !== "pnpm") {chmodSync(payload, 0o755);}
    const provenancePath = join(directory, ".agtmai-toolchain-install.json");
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    provenance.files[forgery.path] = digest(payload);
    writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    assert.throws(
      () => verifyCache({
        lock: fixture.lock,
        platform: "linux-x64",
        toolsRoot: fixture.toolsRoot,
        offline: true,
      }),
      new RegExp(`TOOLCHAIN_INSTALL_INVALID tool=${forgery.tool}.*file-checksum:${forgery.path.replace("/", "\\/")}`),
    );
    installArtifacts({
      lock: fixture.lock,
      platform: "linux-x64",
      toolsRoot: fixture.toolsRoot,
      offline: true,
    });
  }
});

test("verification reports unavailable pinned payload authority instead of trusting an installed tool", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });
  installArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, offline: true });
  rmSync(join(
    fixture.toolsRoot,
    "downloads",
    fixture.lock.tools.foundry.platforms["linux-x64"].archiveName,
  ));
  assert.throws(
    () => verifyCache({
      lock: fixture.lock,
      platform: "linux-x64",
      toolsRoot: fixture.toolsRoot,
      offline: true,
    }),
    /TOOLCHAIN_PINNED_PAYLOAD_AUTHORITY_UNAVAILABLE tool=foundry platform=linux-x64/u,
  );
});

test("verified archive descriptors remain the copy and extraction source and pathname substitution fails closed", (context) => {
  const fixture = makeFixture();
  context.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", toolsRoot: fixture.toolsRoot, downloader: fixture.downloader });

  for (const [name, artifact] of [
    ["foundry", fixture.lock.tools.foundry.platforms["linux-x64"]],
    ["solc", fixture.lock.tools.solc.platforms["linux-x64"]],
  ]) {
    const archive = join(fixture.toolsRoot, "downloads", artifact.archiveName);
    assert.throws(
      () => prepareVerifiedPayload({
        name,
        platform: "linux-x64",
        artifact,
        archive,
        toolsRoot: fixture.toolsRoot,
        missingCode: "TOOLCHAIN_CACHE_MISSING",
        onArchiveVerified() {
          renameSync(archive, `${archive}.held`);
          writeFileSync(archive, "forged archive at the verified pathname\n");
        },
      }),
      new RegExp(`TOOLCHAIN_ARCHIVE_SUBSTITUTED tool=${name}`),
    );
    assert.deepEqual(
      readdirSync(fixture.toolsRoot).filter((entry) => entry.startsWith(".install-part-")),
      [],
    );
  }
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
