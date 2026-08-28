import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
} from "../toolchain.mjs";
import { runDoctor } from "../doctor.mjs";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");

function brokenDownloader(_url, part) {
  writeFileSync(part, "truncated");
  return 0;
}

test("committed lock schema covers both platforms and keeps future tools out of Core", () => {
  const lock = loadLock(join(repositoryRoot, "tooling/toolchain.lock.json"));
  assert.deepEqual(lock.platforms, ["darwin-arm64", "linux-x64"]);
  assert.deepEqual(lock.coreTools, ["node", "foundry", "solc"]);
  assert.equal(lock.tools.solc.platforms["darwin-arm64"].sha256, "d4abcf0b3e24b7948ddfd64c374d26c3214648717777790ecb936979054a129d");
  for (const platform of lock.platforms) {
    assert.deepEqual(
      lock.tools.foundry.platforms[platform].versionChecks.map(({ name }) => name),
      ["forge", "cast", "anvil", "chisel"],
    );
  }
  for (const name of ["agave", "ccipSdk", "ccipSolanaPrograms"]) {
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

test("unsupported hosts fail closed", () => {
  assert.throws(() => hostPlatform({ platform: "win32", arch: "x64" }), /TOOLCHAIN_UNSUPPORTED_PLATFORM/);
});

test("environment helper resolves its own repository when sourced by Bash or Zsh", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-env-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  const bin = join(root, ".tools", "bin");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(repositoryRoot, "scripts/env.sh"), join(scripts, "env.sh"));
  writeExecutable(join(bin, "agtmai-env-probe"), "#!/bin/sh\nexit 0\n");
  for (const shell of ["/bin/bash", "/bin/zsh"].filter(existsSync)) {
    const result = spawnSync(shell, ["-c", `source '${join(scripts, "env.sh")}' && command -v agtmai-env-probe`], { encoding: "utf8" });
    assert.equal(result.status, 0, `${shell}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), join(bin, "agtmai-env-probe"));
  }
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
  writeExecutable(join(nodePayload, "node"), "#!/bin/sh\necho 'v24.20.0'\n");
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

  const definitions = {
    node: artifact({ name: "node-test.tar.gz", path: nodeArchive, archive: "tar.gz", installDirectory: "node-test-linux-x64", expectedFiles: ["bin/node"], versionPath: "bin/node", pattern: "^v24\\.20\\.0$" }),
    foundry: artifact({ name: "foundry-test.tar.gz", path: foundryArchive, archive: "tar.gz", installDirectory: "foundry-test-linux-x64", expectedFiles: ["forge", "cast", "anvil", "chisel"], versionPath: "forge", pattern: "^forge Version: 1\\.8\\.0$" }),
    solc: artifact({ name: "solc-test", path: solcArchive, archive: "executable", installDirectory: "solc-test-linux-x64", expectedFiles: ["solc"], versionPath: "solc", pattern: "Version: 0\\.8\\.36\\+commit\\.8a079791\\." }),
  };
  const lock = {
    schemaVersion: 2,
    platforms: ["darwin-arm64", "linux-x64"],
    coreTools: ["node", "foundry", "solc"],
    tools: {
      node: coreTool("24.20.0", definitions.node),
      foundry: coreTool("1.8.0", definitions.foundry),
      solc: coreTool("0.8.36", definitions.solc),
      pnpm: packageTool("11.24.0"),
      typescript: packageTool("7.0.2"),
      oxlint: packageTool("1.80.0"),
      engineeringFoundation: packageTool("0.20.0"),
      agave: futureTool(),
      ccipSdk: futureTool(),
      ccipSolanaPrograms: futureTool(),
    },
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

function artifact({ name, path, archive, installDirectory, expectedFiles, versionPath, pattern }) {
  return {
    url: `https://fixtures.invalid/${name}`,
    checksumSource: "https://fixtures.invalid/checksums",
    sha256: digest(path),
    archive,
    archiveName: name,
    installDirectory,
    expectedFiles,
    versionChecks: [{ name: versionPath.split("/").at(-1), path: versionPath, args: ["--version"], pattern }],
  };
}

function coreTool(version, definition) {
  return { scope: "genesis-core", version, platforms: { "darwin-arm64": definition, "linux-x64": definition } };
}

function packageTool(version) {
  return { version, source: `https://registry.invalid/package-${version}.tgz` };
}

function futureTool() {
  return { scope: "future-non-core", enabledForCore: false };
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
