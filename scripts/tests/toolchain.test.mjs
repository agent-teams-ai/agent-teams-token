import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  fetchArtifacts,
  hostPlatform,
  installArtifacts,
  prepareVerifiedPayload,
  verifyCache,
  canonicalizeTrustedPath,
} from "../toolchain.mjs";
import { registerBootstrapTests } from "./toolchain-bootstrap.test.mjs";
import { registerExecutionTests } from "./toolchain-invocation.test.mjs";
import { runDoctor } from "../doctor.mjs";
import {
  assertProtectedPnpmResolvesAuthenticatedTools,
  makeFixture,
} from "../toolchain-test-fixture.mjs";
import { brokenDownloader, digest, writeExecutable } from "./toolchain-fixtures.mjs";
import { registerToolchainAuthorityTests } from "./toolchain-authority.test.mjs";

registerToolchainAuthorityTests();
registerBootstrapTests();
registerExecutionTests();

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");


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

test("protected pnpm resolves only authenticated core and optional fixture commands", assertProtectedPnpmResolvesAuthenticatedTools);

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
  const macToolsRoot = mkdtempSync("/tmp/agtmai-mac-tools-");
  context.after(() => rmSync(macToolsRoot, { recursive: true, force: true }));
  assert.equal(canonicalizeTrustedPath(macToolsRoot, { platform: "darwin" }).startsWith("/private/tmp/"), true);
  // Host path semantics must accept macOS /tmp aliases while selecting linux artifacts.
  fetchArtifacts({ lock: fixture.lock, platform: "linux-x64", hostPlatform: "darwin", toolsRoot: macToolsRoot, downloader: fixture.downloader });
});

test("macOS trusted temp hierarchies reject descendant symlinks", (context) => {
  if (process.platform !== "darwin") {return;}
  const folders = canonicalizeTrustedPath("/var/folders", { platform: "darwin" });
  assert.equal(folders, "/private/var/folders");
  const macTemp = canonicalizeTrustedPath(tmpdir(), { platform: "darwin" });
  assert.equal(
    macTemp === "/private/tmp"
      || macTemp.startsWith("/private/tmp/")
      || macTemp.startsWith(`${folders}/`),
    true,
  );
  const probe = mkdtempSync(join(macTemp, "agtmai-toolchain-probe-"));
  context.after(() => rmSync(probe, { recursive: true, force: true }));
  const real = join(probe, "real"); const link = join(probe, "link");
  mkdirSync(real); symlinkSync(real, link, "dir");
  assert.throws(() => canonicalizeTrustedPath(link, { platform: "darwin" }), /TOOLCHAIN_DIRECTORY_IDENTITY_INVALID/);
});

test("unsupported hosts fail closed", () => {
  assert.throws(() => hostPlatform({ platform: "win32", arch: "x64" }), /TOOLCHAIN_UNSUPPORTED_PLATFORM/);
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
  assert.doesNotMatch(nodeWrapperText, /\/usr\/local\/bin/u);
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
