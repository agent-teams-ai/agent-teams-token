#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertExpectedFileHashes,
  inspectExpectedFile,
  validateExpectedFileHashes,
  validateFixtureToolShape,
  validateSecurityImage,
} from "./toolchain-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenanceFile = ".agtmai-toolchain-install.json";

export function hostPlatform({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin" && arch === "arm64") {return "darwin-arm64";}
  if (platform === "linux" && arch === "x64") {return "linux-x64";}
  throw new Error(
    `TOOLCHAIN_UNSUPPORTED_PLATFORM platform=${platform} arch=${arch}; supported=darwin-arm64,linux-x64`,
  );
}

export function loadLock(lockPath = join(repositoryRoot, "tooling/toolchain.lock.json")) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  validateLock(lock);
  return lock;
}

export function validateLock(lock) {
  if (lock.schemaVersion !== 2) {throw new Error("TOOLCHAIN_LOCK_SCHEMA expected=2");}
  if (JSON.stringify(lock.platforms) !== JSON.stringify(["darwin-arm64", "linux-x64"])) {
    throw new Error("TOOLCHAIN_LOCK_PLATFORMS expected=darwin-arm64,linux-x64");
  }
  if (JSON.stringify(lock.coreTools) !== JSON.stringify(["node", "foundry", "solc"])) {
    throw new Error("TOOLCHAIN_LOCK_CORE_TOOLS expected=node,foundry,solc");
  }
  if (JSON.stringify(lock.fixtureTools) !== JSON.stringify(["agave"])) {
    throw new Error("TOOLCHAIN_LOCK_FIXTURE_TOOLS expected=agave");
  }
  for (const name of lock.coreTools) {
    validateCoreTool(lock, name);
  }
  validateFixtureTool(lock, "agave");
  validateSecurityImage(lock.securityImages?.slither);
  validatePackageManager(lock.tools?.pnpm);
  for (const name of ["pnpm", "typescript", "oxlint", "engineeringFoundation"]) {
    const tool = lock.tools?.[name];
    if (!tool?.version || !tool.source.startsWith('https://')) {
      throw new Error(`TOOLCHAIN_LOCK_PACKAGE tool=${name}`);
    }
  }
  for (const name of ["ccipSdk", "ccipSolanaPrograms"]) {
    if (lock.tools?.[name]?.scope !== "future-non-core" || lock.tools[name].enabledForCore !== false) {
      throw new Error(`TOOLCHAIN_LOCK_FUTURE_SCOPE tool=${name}`);
    }
  }
}

function validateFixtureTool(lock, name) {
  const tool = lock.tools?.[name];
  validateFixtureToolShape(tool, name);
  for (const platform of lock.platforms) {
    validateArtifact(name, platform, tool.platforms?.[platform], { requireInnerHashes: true });
  }
}

function validatePackageManager(tool) {
  if (
    tool?.scope !== "genesis-core-package-manager"
    || typeof tool.version !== "string"
    || !tool.source?.startsWith("https://")
    || !/^[a-f0-9]{64}$/.test(tool.sha256)
    || tool.archive !== "tar.gz"
    || !/^[a-zA-Z0-9.+_-]+$/.test(tool.archiveName)
    || !/^[a-zA-Z0-9.+_-]+$/.test(tool.installDirectory)
    || JSON.stringify(tool.expectedFiles) !== JSON.stringify(["bin/pnpm.cjs", "package.json"])
  ) {
    throw new Error("TOOLCHAIN_LOCK_PACKAGE_MANAGER expected=checksum-pinned-package-manager");
  }
}

function validateCoreTool(lock, name) {
  const tool = lock.tools?.[name];
  if (!tool || tool.scope !== "genesis-core" || typeof tool.version !== "string") {
    throw new Error(`TOOLCHAIN_LOCK_TOOL tool=${name}`);
  }
  for (const platform of lock.platforms) {
    validateArtifact(name, platform, tool.platforms?.[platform]);
  }
}

function validateArtifact(name, platform, artifact, { requireInnerHashes = false } = {}) {
  if (!artifact) {throw new Error(`TOOLCHAIN_LOCK_COVERAGE tool=${name} platform=${platform}`);}
  if (!["executable", "tar.bz2", "tar.gz", "tar.xz"].includes(artifact.archive)) {
    throw new Error(`TOOLCHAIN_LOCK_ARCHIVE tool=${name} platform=${platform}`);
  }
  for (const field of ["url", "checksumSource"]) {
    if (!artifact[field].startsWith("https://")) {
      throw new Error(`TOOLCHAIN_LOCK_URL tool=${name} platform=${platform} field=${field}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`TOOLCHAIN_LOCK_SHA256 tool=${name} platform=${platform}`);
  }
  for (const field of ["archiveName", "installDirectory"]) {
    if (!/^[a-zA-Z0-9.+_-]+$/.test(artifact[field])) {
      throw new Error(`TOOLCHAIN_LOCK_PATH tool=${name} platform=${platform} field=${field}`);
    }
  }
  if (!Array.isArray(artifact.expectedFiles) || artifact.expectedFiles.length === 0) {
    throw new Error(`TOOLCHAIN_LOCK_EXPECTED_FILES tool=${name} platform=${platform}`);
  }
  for (const expected of artifact.expectedFiles) {assertRelativePath(name, platform, expected);}
  if (requireInnerHashes) {validateExpectedFileHashes(name, platform, artifact);}
  validateVersionChecks(name, platform, artifact);
  if (/\b(?:latest|nightly|master|main)\b/i.test(`${artifact.url} ${artifact.installDirectory}`)) {
    throw new Error(`TOOLCHAIN_LOCK_FLOATING tool=${name} platform=${platform}`);
  }
}

function validateVersionChecks(name, platform, artifact) {
  if (!Array.isArray(artifact.versionChecks) || artifact.versionChecks.length === 0) {
    throw new Error(`TOOLCHAIN_LOCK_VERSION_CHECKS tool=${name} platform=${platform}`);
  }
  const checkNames = new Set();
  for (const check of artifact.versionChecks) {
    if (!/^[a-z0-9-]+$/.test(check.name) || checkNames.has(check.name) || !Array.isArray(check.args)) {
      throw new Error(`TOOLCHAIN_LOCK_VERSION_CHECK tool=${name} platform=${platform}`);
    }
    checkNames.add(check.name);
    assertRelativePath(name, platform, check.path);
    if (!artifact.expectedFiles.includes(check.path)) {
      throw new Error(`TOOLCHAIN_LOCK_VERSION_PATH tool=${name} platform=${platform} path=${check.path}`);
    }
    try {
      RegExp(check.pattern);
    } catch {
      throw new Error(`TOOLCHAIN_LOCK_VERSION_PATTERN tool=${name} platform=${platform}`);
    }
  }
}

function assertRelativePath(name, platform, value) {
  if (typeof value !== "string" || value.startsWith("/") || value.split("/").includes("..")) {
    throw new Error(`TOOLCHAIN_LOCK_RELATIVE_PATH tool=${name} platform=${platform}`);
  }
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function coreDownloadableTools(lock) {
  return lock.coreTools.map((name) => [name, lock.tools[name]]);
}

function downloadableTools(lock, platform, scope = "core") {
  const tools = [
    ...coreDownloadableTools(lock).map(([name, tool]) => [name, tool, tool.platforms[platform]]),
    ["pnpm", lock.tools.pnpm, lock.tools.pnpm],
  ];
  if (scope === "solana") {
    for (const name of lock.fixtureTools) {
      const tool = lock.tools[name];
      tools.push([name, tool, tool.platforms[platform]]);
    }
  } else if (scope !== "core") {
    throw new Error(`TOOLCHAIN_SCOPE_UNSUPPORTED scope=${scope}`);
  }
  return tools;
}

export function fetchArtifacts({ lock, platform, toolsRoot, downloader = downloadWithCurl, scope = "core" }) {
  assertSupported(lock, platform);
  const downloads = join(toolsRoot, "downloads");
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  chmodSync(downloads, 0o700);
  for (const [name, _tool, artifact] of downloadableTools(lock, platform, scope)) {
    const target = join(downloads, artifact.archiveName);
    if (existsSync(target) && sha256(target) === artifact.sha256) {
      process.stdout.write(`FETCH_CACHED tool=${name} platform=${platform} sha256=${artifact.sha256}\n`);
      continue;
    }
    if (existsSync(target)) {rmSync(target);}
    const part = `${target}.part`;
    if (existsSync(part)) {rmSync(part, { force: true });}
    const partFd = openSync(part, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const before = lstatSync(part);
    closeSync(partFd);
    const result = downloader(artifact.url ?? artifact.source, part);
    if (result !== 0) {
      throw new Error(`TOOLCHAIN_FETCH_FAILED tool=${name} platform=${platform} partial=${part}`);
    }
    const after = lstatSync(part);
    if (!after.isFile() || after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev) {
      throw new Error(`TOOLCHAIN_FETCH_PART_UNSTABLE tool=${name} platform=${platform}`);
    }
    const actual = sha256(part);
    if (actual !== artifact.sha256) {
      throw new Error(
        `TOOLCHAIN_CHECKSUM_MISMATCH tool=${name} platform=${platform} expected=${artifact.sha256} actual=${actual} partial=${part}`,
      );
    }
    renameSync(part, target);
    process.stdout.write(`FETCH_OK tool=${name} platform=${platform} sha256=${actual}\n`);
  }
}

function downloadWithCurl(url, part) {
  return spawnSync(
    "/usr/bin/curl",
    ["--fail", "--location", "--proto", "=https", "--show-error", "--output", part, url],
    { stdio: "inherit", env: minimalSubprocessEnv() },
  ).status ?? 1;
}

function minimalSubprocessEnv() {
  return { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C", LC_ALL: "C", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_ENABLE_PROJECT_SPEC: "0" };
}

export function installArtifacts({ lock, platform, toolsRoot, offline, scope = "core" }) {
  if (!offline) {throw new Error("TOOLCHAIN_INSTALL_REQUIRES_OFFLINE use=install --offline");}
  assertSupported(lock, platform);
  const downloads = join(toolsRoot, "downloads");
  mkdirSync(toolsRoot, { recursive: true });
  for (const [name, tool, artifact] of downloadableTools(lock, platform, scope)) {
    const archive = join(downloads, artifact.archiveName);
    verifyArchive({ name, platform, artifact, archive, missingCode: "TOOLCHAIN_OFFLINE_CACHE_MISS" });
    const destination = join(toolsRoot, artifact.installDirectory);
    const present = inspectInstallation({ name, tool, artifact, platform, destination, toolsRoot, lock });
    if (present.ok) {
      process.stdout.write(
        `INSTALL_PRESENT tool=${name} platform=${platform} version=${present.actualVersion} sha256=${artifact.sha256}\n`,
      );
      continue;
    }
    atomicInstall({ name, tool, artifact, archive, destination, platform, toolsRoot, lock });
    process.stdout.write(
      `INSTALL_OK tool=${name} platform=${platform} version=${tool.version} sha256=${artifact.sha256}`
      + `${present.code === "missing" ? "" : ` replaced=${present.code}`}\n`,
    );
  }
}

function verifyArchive({ name, platform, artifact, archive, missingCode }) {
  if (!existsSync(archive)) {
    throw new Error(`${missingCode} tool=${name} platform=${platform} expected=${archive}`);
  }
  const actual = sha256(archive);
  if (actual !== artifact.sha256) {
    throw new Error(
      `TOOLCHAIN_OFFLINE_UNVERIFIED_CACHE tool=${name} platform=${platform} expected=${artifact.sha256} actual=${actual}`,
    );
  }
}

function atomicInstall({ name, tool, artifact, archive, destination, platform, toolsRoot, lock }) {
  const stageRoot = mkdtempSync(join(toolsRoot, ".install-part-"));
  const staged = join(stageRoot, "payload");
  let backup;
  try {
    mkdirSync(staged);
    if (artifact.archive === "executable") {
      const target = join(staged, artifact.expectedFiles[0]);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(archive, target);
      chmodSync(target, 0o755);
    } else {
      const args = artifact.archive === "tar.xz"
        ? ["-xJf", archive, "-C", staged]
        : artifact.archive === "tar.bz2"
          ? ["-xjf", archive, "-C", staged]
          : ["-xzf", archive, "-C", staged];
      execFileSync("/usr/bin/tar", args, { stdio: "pipe" });
    }
    const entries = readdirSync(staged);
    const source = entries.length === 1 && statSync(join(staged, entries[0])).isDirectory()
      ? join(staged, entries[0])
      : staged;
    const files = Object.fromEntries(artifact.expectedFiles.map((path) => {
      const target = join(source, path);
      if (!existsSync(target) || !lstatSync(target).isFile()) {
        throw new Error(`TOOLCHAIN_INSTALL_EXPECTED_FILE tool=${name} platform=${platform} path=${path}`);
      }
      return [path, sha256(target)];
    }));
    assertExpectedFileHashes({ name, platform, artifact, files });
    if (name === "pnpm") {
      executePnpmVersionCheck({
        root: source,
        nodeExecutable: pinnedNode(lock, toolsRoot, platform),
        tool,
      });
    } else {
      executeVersionChecks(source, artifact);
    }
    writeFileSync(join(source, provenanceFile), `${JSON.stringify({
      schemaVersion: 1,
      tool: name,
      version: tool.version,
      platform,
      artifactSha256: artifact.sha256,
      files,
    }, null, 2)}\n`, { mode: 0o644 });
    if (existsSync(destination)) {
      backup = `${destination}.replace-${process.pid}-${Date.now()}`;
      renameSync(destination, backup);
    }
    try {
      renameSync(source, destination);
    } catch (error) {
      if (backup && !existsSync(destination)) {renameSync(backup, destination);}
      throw error;
    }
    if (name === "pnpm") {writePnpmWrapper({ lock, toolsRoot, platform });}
    if (backup) {rmSync(backup, { force: true, recursive: true });}
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

export function inspectInstallation({ name, tool, artifact, platform, destination, toolsRoot, lock }) {
  if (!existsSync(destination)) {return { ok: false, code: "missing", actualVersion: "missing" };}
  const provenancePath = join(destination, provenanceFile);
  if (!existsSync(provenancePath)) {return { ok: false, code: "provenance-missing", actualVersion: "unknown" };}
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  } catch {
    return { ok: false, code: "provenance-invalid", actualVersion: "unknown" };
  }
  if (
    provenance.schemaVersion !== 1
    || provenance.tool !== name
    || provenance.version !== tool.version
    || provenance.platform !== platform
    || provenance.artifactSha256 !== artifact.sha256
  ) {
    return { ok: false, code: "provenance-mismatch", actualVersion: "unknown" };
  }
  for (const path of artifact.expectedFiles) {
    const target = join(destination, path);
    const exists = existsSync(target);
    const code = inspectExpectedFile({
      artifact: { ...artifact, provenanceFiles: provenance.files },
      path,
      target,
      exists,
      isFile: exists && lstatSync(target).isFile(),
      sha256,
    });
    if (code) {return { ok: false, code, actualVersion: "unknown" };}
  }
  let actualVersion;
  try {
    actualVersion = name === "pnpm"
      ? executePnpmVersionCheck({
          root: destination,
          nodeExecutable: pinnedNode(lock, toolsRoot, platform),
          tool,
        })
      : executeVersionChecks(destination, artifact);
  } catch (error) {
    return { ok: false, code: "version-command", actualVersion: error instanceof Error ? error.message : String(error) };
  }
  if (name === "pnpm") {
    const wrapper = join(toolsRoot, "bin", "pnpm");
    if (!existsSync(wrapper) || readFileSync(wrapper, "utf8") !== pnpmWrapper(lock, platform)) {
      return { ok: false, code: "wrapper-missing-or-tampered", actualVersion: singleLine(actualVersion) };
    }
  }
  return { ok: true, code: "ok", actualVersion: singleLine(actualVersion) };
}

function pinnedNode(lock, toolsRoot, platform) {
  return join(toolsRoot, lock.tools.node.platforms[platform].installDirectory, "bin", "node");
}

function executePnpmVersionCheck({ root, nodeExecutable, tool }) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packageJson.name !== "pnpm" || packageJson.version !== tool.version) {
    throw new Error(`pnpm-package-mismatch:actual=${packageJson.name}@${packageJson.version}`);
  }
  const actual = execFileSync(nodeExecutable, [join(root, "bin", "pnpm.cjs"), "--version"], {
    encoding: "utf8",
    env: minimalSubprocessEnv(),
    timeout: 15_000,
  }).trim();
  if (actual !== tool.version) {throw new Error(`pnpm-version-mismatch:actual=${singleLine(actual)}`);}
  return `pnpm=${actual}`;
}

function pnpmWrapper(lock, platform) {
  const nodeDirectory = lock.tools.node.platforms[platform].installDirectory;
  const pnpmDirectory = lock.tools.pnpm.installDirectory;
  return `#!/usr/bin/env bash\nset -euo pipefail\ntoken_pnpm_tools_root=$(CDPATH= cd -- "$(dirname -- "\${BASH_SOURCE[0]}")/.." && pwd)\nexport COREPACK_ENABLE_DOWNLOAD_PROMPT=0\nexport COREPACK_ENABLE_PROJECT_SPEC=0\nexec "$token_pnpm_tools_root/${nodeDirectory}/bin/node" "$token_pnpm_tools_root/${pnpmDirectory}/bin/pnpm.cjs" --config.auto-install-peers=false "$@"\n`;
}

function writePnpmWrapper({ lock, toolsRoot, platform }) {
  const bin = join(toolsRoot, "bin");
  const target = join(bin, "pnpm");
  const part = `${target}.part`;
  mkdirSync(bin, { recursive: true });
  rmSync(part, { force: true });
  writeFileSync(part, pnpmWrapper(lock, platform), { mode: 0o755 });
  chmodSync(part, 0o755);
  renameSync(part, target);
}

function executeVersionChecks(root, artifact) {
  return artifact.versionChecks.map((check) => {
    const actual = execFileSync(join(root, check.path), check.args, {
      encoding: "utf8",
      env: minimalSubprocessEnv(),
      timeout: 15_000,
    }).trim();
    if (!new RegExp(check.pattern).test(actual)) {
      throw new Error(`version-mismatch:${check.name}:actual=${singleLine(actual)}`);
    }
    return `${check.name}=${singleLine(actual)}`;
  }).join(",");
}

function singleLine(value) {
  return String(value).replaceAll(/\s+/g, " ").trim();
}

export function verifyCache({ lock, platform, toolsRoot, offline, scope = "core" }) {
  if (!offline) {throw new Error("TOOLCHAIN_VERIFY_REQUIRES_OFFLINE use=verify --offline");}
  assertSupported(lock, platform);
  const downloads = join(toolsRoot, "downloads");
  for (const [name, tool, artifact] of downloadableTools(lock, platform, scope)) {
    const archive = join(downloads, artifact.archiveName);
    verifyArchive({ name, platform, artifact, archive, missingCode: "TOOLCHAIN_CACHE_MISSING" });
    const installation = inspectInstallation({
      name,
      tool,
      artifact,
      platform,
      destination: join(toolsRoot, artifact.installDirectory),
      toolsRoot,
      lock,
    });
    if (!installation.ok) {
      throw new Error(`TOOLCHAIN_INSTALL_INVALID tool=${name} platform=${platform} reason=${installation.code}`);
    }
    process.stdout.write(
      `VERIFY_OK tool=${name} platform=${platform} version=${installation.actualVersion} sha256=${artifact.sha256}\n`,
    );
  }
}

function assertSupported(lock, platform) {
  if (!lock.platforms.includes(platform)) {throw new Error(`TOOLCHAIN_UNSUPPORTED_PLATFORM platform=${platform}`);}
}

function cli() {
  const [command = "help", ...args] = process.argv.slice(2);
  const offline = args.includes("--offline");
  const scopeArgument = args.find((value) => value.startsWith("--scope="));
  const scope = scopeArgument ? scopeArgument.slice("--scope=".length) : "core";
  const testMode = process.env.TOKEN_BOOTSTRAP_TEST_MODE === "1";
  const platformArgument = args.find((value) => value.startsWith("--platform="));
  if (platformArgument && !testMode) {
    throw new Error("TOOLCHAIN_PLATFORM_OVERRIDE_DISABLED expected=host-platform");
  }
  const platform = platformArgument ? platformArgument.slice("--platform=".length) : hostPlatform();
  const lockPath = testMode && process.env.TOKEN_TOOLCHAIN_LOCK
    ? resolve(process.env.TOKEN_TOOLCHAIN_LOCK)
    : join(repositoryRoot, "tooling/toolchain.lock.json");
  const toolsRoot = testMode && process.env.TOKEN_TOOLS_ROOT
    ? resolve(process.env.TOKEN_TOOLS_ROOT)
    : join(repositoryRoot, ".tools");
  const lock = loadLock(lockPath);
  if (command === "fetch") {return fetchArtifacts({ lock, platform, toolsRoot, scope });}
  if (command === "install") {return installArtifacts({ lock, platform, toolsRoot, offline, scope });}
  if (command === "verify") {return verifyCache({ lock, platform, toolsRoot, offline, scope });}
  throw new Error(
    "Usage: ./dev bootstrap fetch [--scope=solana] | install --offline [--scope=solana]"
    + " | verify --offline [--scope=solana]",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
