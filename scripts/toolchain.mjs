#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  for (const name of lock.coreTools) {
    validateCoreTool(lock, name);
  }
  for (const name of ["pnpm", "typescript", "oxlint", "engineeringFoundation"]) {
    const tool = lock.tools?.[name];
    if (!tool?.version || !tool.source.startsWith('https://')) {
      throw new Error(`TOOLCHAIN_LOCK_PACKAGE tool=${name}`);
    }
  }
  for (const name of ["agave", "ccipSdk", "ccipSolanaPrograms"]) {
    if (lock.tools?.[name]?.scope !== "future-non-core" || lock.tools[name].enabledForCore !== false) {
      throw new Error(`TOOLCHAIN_LOCK_FUTURE_SCOPE tool=${name}`);
    }
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

function validateArtifact(name, platform, artifact) {
  if (!artifact) {throw new Error(`TOOLCHAIN_LOCK_COVERAGE tool=${name} platform=${platform}`);}
  if (!["executable", "tar.gz", "tar.xz"].includes(artifact.archive)) {
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

export function fetchArtifacts({ lock, platform, toolsRoot, downloader = downloadWithCurl }) {
  assertSupported(lock, platform);
  const downloads = join(toolsRoot, "downloads");
  mkdirSync(downloads, { recursive: true });
  for (const [name, tool] of coreDownloadableTools(lock)) {
    const artifact = tool.platforms[platform];
    const target = join(downloads, artifact.archiveName);
    if (existsSync(target) && sha256(target) === artifact.sha256) {
      process.stdout.write(`FETCH_CACHED tool=${name} platform=${platform} sha256=${artifact.sha256}\n`);
      continue;
    }
    if (existsSync(target)) {rmSync(target);}
    const part = `${target}.part`;
    if (existsSync(part)) {rmSync(part);}
    const result = downloader(artifact.url, part);
    if (result !== 0) {
      throw new Error(`TOOLCHAIN_FETCH_FAILED tool=${name} platform=${platform} partial=${part}`);
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
    { stdio: "inherit" },
  ).status ?? 1;
}

export function installArtifacts({ lock, platform, toolsRoot, offline }) {
  if (!offline) {throw new Error("TOOLCHAIN_INSTALL_REQUIRES_OFFLINE use=install --offline");}
  assertSupported(lock, platform);
  const downloads = join(toolsRoot, "downloads");
  mkdirSync(toolsRoot, { recursive: true });
  for (const [name, tool] of coreDownloadableTools(lock)) {
    const artifact = tool.platforms[platform];
    const archive = join(downloads, artifact.archiveName);
    verifyArchive({ name, platform, artifact, archive, missingCode: "TOOLCHAIN_OFFLINE_CACHE_MISS" });
    const destination = join(toolsRoot, artifact.installDirectory);
    const present = inspectInstallation({ name, tool, artifact, platform, destination });
    if (present.ok) {
      process.stdout.write(
        `INSTALL_PRESENT tool=${name} platform=${platform} version=${present.actualVersion} sha256=${artifact.sha256}\n`,
      );
      continue;
    }
    atomicInstall({ name, tool, artifact, archive, destination, platform, toolsRoot });
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

function atomicInstall({ name, tool, artifact, archive, destination, platform, toolsRoot }) {
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
    executeVersionChecks(source, artifact);
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
    if (backup) {rmSync(backup, { force: true, recursive: true });}
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

export function inspectInstallation({ name, tool, artifact, platform, destination }) {
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
    if (!existsSync(target) || !lstatSync(target).isFile()) {
      return { ok: false, code: `file-missing:${path}`, actualVersion: "unknown" };
    }
    if (provenance.files?.[path] !== sha256(target)) {
      return { ok: false, code: `file-checksum:${path}`, actualVersion: "unknown" };
    }
  }
  let actualVersion;
  try {
    actualVersion = executeVersionChecks(destination, artifact);
  } catch (error) {
    return { ok: false, code: "version-command", actualVersion: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, code: "ok", actualVersion: singleLine(actualVersion) };
}

function executeVersionChecks(root, artifact) {
  return artifact.versionChecks.map((check) => {
    const actual = execFileSync(join(root, check.path), check.args, {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
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

export function verifyCache({ lock, platform, toolsRoot, offline }) {
  if (!offline) {throw new Error("TOOLCHAIN_VERIFY_REQUIRES_OFFLINE use=verify --offline");}
  assertSupported(lock, platform);
  const downloads = join(toolsRoot, "downloads");
  for (const [name, tool] of coreDownloadableTools(lock)) {
    const artifact = tool.platforms[platform];
    const archive = join(downloads, artifact.archiveName);
    verifyArchive({ name, platform, artifact, archive, missingCode: "TOOLCHAIN_CACHE_MISSING" });
    const installation = inspectInstallation({
      name,
      tool,
      artifact,
      platform,
      destination: join(toolsRoot, artifact.installDirectory),
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
  if (command === "fetch") {return fetchArtifacts({ lock, platform, toolsRoot });}
  if (command === "install") {return installArtifacts({ lock, platform, toolsRoot, offline });}
  if (command === "verify") {return verifyCache({ lock, platform, toolsRoot, offline });}
  throw new Error("Usage: ./dev bootstrap fetch | install --offline | verify --offline");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
