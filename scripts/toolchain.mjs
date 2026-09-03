#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,constants as fsConstants
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalizeTrustedPath, assertOwnedDirectoryChain } from "./toolchain-paths.mjs";
import { validateLock } from "./toolchain-lock-validation.mjs";
import { fileURLToPath } from "node:url";
import { assertExpectedFileHashes, lockedFileMismatch } from "./toolchain-policy.mjs";

export { canonicalizeTrustedPath, validateLock };

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

export function fetchArtifacts({ lock, platform, toolsRoot, downloader = downloadWithCurl, scope = "core", hostPlatform: host = process.platform }) {
  assertSupported(lock, platform);
  toolsRoot = canonicalizeTrustedPath(toolsRoot, { platform: host });
  assertOwnedDirectoryChain(toolsRoot, { platform: host });
  const downloads = join(toolsRoot, "downloads");
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  assertOwnedDirectoryChain(downloads, { platform: host });
  chmodSync(downloads, 0o700);
  for (const [name, _tool, artifact] of downloadableTools(lock, platform, scope)) {
    const target = join(downloads, artifact.archiveName);
    if (isRegularCacheEntry(target) && sha256(target) === artifact.sha256) {
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
    const publishFd = openSync(part, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const fdStat = fstatSync(publishFd);
      const pathStat = lstatSync(part);
      if (!pathStat.isFile() || pathStat.nlink !== 1 || pathStat.ino !== fdStat.ino || pathStat.dev !== fdStat.dev) {
        throw new Error(`TOOLCHAIN_FETCH_PART_UNSTABLE tool=${name} platform=${platform}`);
      }
      renameSync(part, target);
    } finally { closeSync(publishFd); }
    process.stdout.write(`FETCH_OK tool=${name} platform=${platform} sha256=${actual}\n`);
  }
}

function isRegularCacheEntry(path) {
  try { const entry = lstatSync(path); return entry.isFile() && entry.nlink === 1; } catch { return false; }
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

export function installArtifacts({ lock, platform, toolsRoot, offline, scope = "core", hostPlatform: host = process.platform }) {
  if (!offline) {throw new Error("TOOLCHAIN_INSTALL_REQUIRES_OFFLINE use=install --offline");}
  assertSupported(lock, platform);
  toolsRoot = canonicalizeTrustedPath(toolsRoot, { platform: host });
  const downloads = join(toolsRoot, "downloads");
  assertOwnedDirectoryChain(toolsRoot, { platform: host });
  assertOwnedDirectoryChain(downloads, { platform: host });
  mkdirSync(toolsRoot, { recursive: true });
  for (const [name, tool, artifact] of downloadableTools(lock, platform, scope)) {
    const archive = join(downloads, artifact.archiveName);
    verifyArchive({ name, platform, artifact, archive, missingCode: "TOOLCHAIN_OFFLINE_CACHE_MISS" });
    const destination = join(toolsRoot, artifact.installDirectory);
    const present = inspectInstallation({ name, tool, artifact, platform, destination, toolsRoot, lock, hostPlatform: host });
    if (present.ok) {
      process.stdout.write(
        `INSTALL_PRESENT tool=${name} platform=${platform} version=${present.actualVersion} sha256=${artifact.sha256}\n`,
      );
      continue;
    }
    atomicInstall({ name, tool, artifact, archive, destination, platform, toolsRoot, lock, hostPlatform: host });
    process.stdout.write(
      `INSTALL_OK tool=${name} platform=${platform} version=${tool.version} sha256=${artifact.sha256}`
      + `${present.code === "missing" ? "" : ` replaced=${present.code}`}\n`,
    );
  }
}

function verifyArchive({ name, platform, artifact, archive, missingCode }) {
  let actual;
  try { actual = readVerifiedBytes(archive); }
  catch (error) { if (error?.code === "ENOENT") {throw new Error(`${missingCode} tool=${name} platform=${platform} expected=${archive}`, { cause: error });} throw error; }
  if (actual.hash !== artifact.sha256) {throw new Error(`TOOLCHAIN_OFFLINE_UNVERIFIED_CACHE tool=${name} platform=${platform} expected=${artifact.sha256} actual=${actual.hash}`);}
  return actual.bytes;
}

function readVerifiedBytes(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) {throw new Error("TOOLCHAIN_FILE_IDENTITY_INVALID");}
    const bytes = readFileSync(fd);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const pathStat = lstatSync(path); const after = fstatSync(fd);
    if (!pathStat.isFile() || pathStat.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev || pathStat.ino !== before.ino || pathStat.dev !== before.dev) {throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
    return { bytes, hash };
  } finally { closeSync(fd); }
}

function atomicInstall({ name, tool, artifact, archive, destination, platform, toolsRoot, lock, hostPlatform: host = process.platform }) {
  assertOwnedDirectoryChain(destination, { platform: host });
  const stageRoot = mkdtempSync(join(toolsRoot, ".install-part-"));
  const staged = join(stageRoot, "payload");
  let backup;
  try {
    mkdirSync(staged);
    const verifiedArchive = join(stageRoot, "archive");
    const archiveBytes = verifyArchive({ name, platform, artifact, archive, missingCode: "TOOLCHAIN_OFFLINE_UNVERIFIED_CACHE" });
    const archiveFd = openSync(verifiedArchive, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { writeSync(archiveFd, archiveBytes); } finally { closeSync(archiveFd); }
    if (artifact.archive === "executable") {
      const target = join(staged, artifact.expectedFiles[0]);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, archiveBytes);
      chmodSync(target, 0o755);
    } else {
      const args = artifact.archive === "tar.xz"
        ? ["-xJf", verifiedArchive, "-C", staged]
        : artifact.archive === "tar.bz2"
          ? ["-xjf", verifiedArchive, "-C", staged]
          : ["-xzf", verifiedArchive, "-C", staged];
      execFileSync("/usr/bin/tar", args, { stdio: "pipe", env: minimalSubprocessEnv() });
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
    if (name === "pnpm") {writePnpmWrapper({ lock, toolsRoot, platform, hostPlatform: host });}
    if (backup) {rmSync(backup, { force: true, recursive: true });}
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

export function inspectInstallation({ name, tool, artifact, platform, destination, toolsRoot, lock, hostPlatform: host = process.platform }) {
  try { assertOwnedDirectoryChain(toolsRoot, { platform: host }); assertOwnedDirectoryChain(join(toolsRoot, "downloads"), { platform: host }); assertOwnedDirectoryChain(destination, { platform: host }); }
  catch { return { ok: false, code: "installation-path-unsafe", actualVersion: "unknown" }; }
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
  let canonicalFiles;
  try { canonicalFiles = canonicalArchiveFileHashes({ artifact, archive: join(toolsRoot, "downloads", artifact.archiveName) }); }
  catch { return { ok: false, code: "archive-provenance-unavailable", actualVersion: "unknown" }; }
  for (const path of artifact.expectedFiles) {
    const target = join(destination, path);
    const exists = existsSync(target);
    const code = inspectStableExpectedFile({ artifact: { ...artifact, provenanceFiles: canonicalFiles }, path, target, exists });
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

function inspectStableExpectedFile({ artifact, path, target, exists }) {
  if (!exists) {return `file-missing:${path}`;}
  let fd;
  try {
    fd = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) {return `file-missing:${path}`;}
    const bytes = readFileSync(fd); const actual = createHash("sha256").update(bytes).digest("hex");
    const after = fstatSync(fd); const pathStat = lstatSync(target);
    if (after.ino !== before.ino || after.dev !== before.dev || pathStat.ino !== before.ino || pathStat.dev !== before.dev || pathStat.nlink !== 1) {return `file-checksum:${path}`;}
    if (artifact.provenanceFiles?.[path] !== actual) {return `file-checksum:${path}`;}
    return lockedFileMismatch(artifact, path, actual) ? `file-lock-checksum:${path}` : undefined;
  } catch { return `file-missing:${path}`; } finally { if (fd !== undefined) {closeSync(fd);} }
}

function canonicalArchiveFileHashes({ artifact, archive }) {
  const bytes = verifyArchive({ name: "canonical", platform: "canonical", artifact, archive, missingCode: "TOOLCHAIN_ARCHIVE_MISSING" });
  if (artifact.archive === "executable") {return { [artifact.expectedFiles[0]]: createHash("sha256").update(bytes).digest("hex") };}
  const root = mkdtempSync(join(dirname(archive), ".inspect-archive-")); const snapshot = join(root, "archive");
  try {
    writeFileSync(snapshot, bytes, { mode: 0o600 });
    execFileSync("/usr/bin/tar", [artifact.archive === "tar.xz" ? "-xJf" : artifact.archive === "tar.bz2" ? "-xjf" : "-xzf", snapshot, "-C", root], { stdio: "pipe", env: minimalSubprocessEnv() });
    const entries = readdirSync(root).filter((entry) => entry !== "archive"); const source = entries.length === 1 && statSync(join(root, entries[0])).isDirectory() ? join(root, entries[0]) : root;
    return Object.fromEntries(artifact.expectedFiles.map((path) => [path, sha256(join(source, path))]));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function pinnedNode(lock, toolsRoot, platform) {
  return join(toolsRoot, lock.tools.node.platforms[platform].installDirectory, "bin", "node");
}

function executePnpmVersionCheck({ root, nodeExecutable, tool }) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packageJson.name !== "pnpm" || packageJson.version !== tool.version) {
    throw new Error(`pnpm-package-mismatch:actual=${packageJson.name}@${packageJson.version}`);
  }
  const pnpmPath = join(root, "bin", "pnpm.cjs");
  const identity = stablePathIdentity(pnpmPath);
  const actual = execFileSync(nodeExecutable, [pnpmPath, "--version"], {
    encoding: "utf8",
    env: minimalSubprocessEnv(),
    timeout: 15_000,
  }).trim();
  if (!samePathIdentity(pnpmPath, identity)) {throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
  if (actual !== tool.version) {throw new Error(`pnpm-version-mismatch:actual=${singleLine(actual)}`);}
  return `pnpm=${actual}`;
}

function pnpmWrapper(lock, platform) {
  const nodeDirectory = lock.tools.node.platforms[platform].installDirectory;
  const pnpmDirectory = lock.tools.pnpm.installDirectory;
  return `#!/usr/bin/env bash\nset -euo pipefail\ntoken_pnpm_tools_root=$(CDPATH= cd -- "$(dirname -- "\${BASH_SOURCE[0]}")/.." && pwd)\nexport COREPACK_ENABLE_DOWNLOAD_PROMPT=0\nexport COREPACK_ENABLE_PROJECT_SPEC=0\nexec "$token_pnpm_tools_root/${nodeDirectory}/bin/node" "$token_pnpm_tools_root/${pnpmDirectory}/bin/pnpm.cjs" --config.auto-install-peers=false "$@"\n`;
}

function writePnpmWrapper({ lock, toolsRoot, platform, hostPlatform: host = process.platform }) {
  toolsRoot = canonicalizeTrustedPath(toolsRoot, { platform: host });
  const bin = join(toolsRoot, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  assertOwnedDirectoryChain(bin, { platform: host });
  const target = join(bin, "pnpm");
  const part = `${target}.part`;
  if (existsSync(part)) { const stale = lstatSync(part); if (!stale.isFile() || stale.nlink !== 1) {throw new Error("TOOLCHAIN_PNPM_WRAPPER_PART_UNSAFE");} rmSync(part); }
  const fd = openSync(part, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o700);
  try {
    const contents = pnpmWrapper(lock, platform);
    writeSync(fd, contents);
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) {throw new Error("TOOLCHAIN_PNPM_WRAPPER_IDENTITY_INVALID");}
  } finally { closeSync(fd); }
  const check = lstatSync(part);
  if (!check.isFile() || check.nlink !== 1) {throw new Error("TOOLCHAIN_PNPM_WRAPPER_IDENTITY_INVALID");}
  renameSync(part, target);
  const published = lstatSync(target); if (!published.isFile() || published.nlink !== 1 || readFileSync(target, "utf8") !== pnpmWrapper(lock, platform)) {throw new Error("TOOLCHAIN_PNPM_WRAPPER_IDENTITY_INVALID");}
}

function stablePathIdentity(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1) {throw new Error("TOOLCHAIN_FILE_IDENTITY_INVALID");} return { ino: st.ino, dev: st.dev }; }
  finally { closeSync(fd); }
}
function samePathIdentity(path, identity) {
  try { const st = lstatSync(path); return st.isFile() && st.nlink === 1 && st.ino === identity.ino && st.dev === identity.dev; } catch { return false; }
}

function executeVersionChecks(root, artifact) {
  return artifact.versionChecks.map((check) => {
    const executable = join(root, check.path);
    const identity = stablePathIdentity(executable);
    const actual = execFileSync(executable, check.args, {
      encoding: "utf8",
      env: minimalSubprocessEnv(),
      timeout: 15_000,
    }).trim();
    if (!samePathIdentity(executable, identity)) {throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
    if (!new RegExp(check.pattern).test(actual)) {
      throw new Error(`version-mismatch:${check.name}:actual=${singleLine(actual)}`);
    }
    return `${check.name}=${singleLine(actual)}`;
  }).join(",");
}

function singleLine(value) {
  return String(value).replaceAll(/\s+/g, " ").trim();
}

export function verifyCache({ lock, platform, toolsRoot, offline, scope = "core", hostPlatform: host = process.platform }) {
  if (!offline) {throw new Error("TOOLCHAIN_VERIFY_REQUIRES_OFFLINE use=verify --offline");}
  assertSupported(lock, platform);
  toolsRoot = canonicalizeTrustedPath(toolsRoot, { platform: host });
  const downloads = join(toolsRoot, "downloads");
  assertOwnedDirectoryChain(toolsRoot, { platform: host });
  assertOwnedDirectoryChain(downloads, { platform: host });
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
      hostPlatform: host,
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
