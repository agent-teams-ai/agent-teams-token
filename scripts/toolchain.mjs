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
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,constants as fsConstants
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  const lock = JSON.parse(readVerifiedBytes(lockPath).bytes.toString("utf8"));
  validateLock(lock);
  return lock;
}

export function sha256(path) {
  return readVerifiedBytes(path).hash;
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

export function fetchArtifacts({
  lock,
  platform,
  toolsRoot,
  downloader = downloadWithCurl,
  scope = "core",
  hostPlatform: host = process.platform,
}) {
  assertSupported(lock, platform);
  toolsRoot = canonicalizeTrustedPath(toolsRoot, { platform: host });
  assertOwnedDirectoryChain(toolsRoot, { platform: host });
  const downloads = join(toolsRoot, "downloads");
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  assertOwnedDirectoryChain(downloads, { platform: host });
  chmodSync(downloads, 0o700);
  for (const [name, _tool, artifact] of downloadableTools(lock, platform, scope)) {
    const target = containedPath(downloads, artifact.archiveName);
    if (verifiedCacheHash(target) === artifact.sha256) {
      process.stdout.write(`FETCH_CACHED tool=${name} platform=${platform} sha256=${artifact.sha256}\n`);
      continue;
    }
    if (existsSync(target)) { rmSync(target); }
    fetchArtifact({ name, platform, artifact, target, downloader });
  }
}

function fetchArtifact({ name, platform, artifact, target, downloader }) {
  const part = `${target}.part`;
  if (existsSync(part)) { rmSync(part, { force: true }); }
  const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const partFd = openSync(part, flags, 0o600);
  try {
    const before = checkedRegularDescriptor(partFd);
    const result = downloader(artifact.url ?? artifact.source, partFd);
    if (result !== 0) {
      throw new Error(`TOOLCHAIN_FETCH_FAILED tool=${name} platform=${platform} partial=${part}`);
    }
    let after;
    try {
      after = checkedRegularDescriptor(partFd);
    } catch {
      throw new Error(`TOOLCHAIN_FETCH_PART_UNSTABLE tool=${name} platform=${platform}`);
    }
    const pathStat = lstatSync(part);
    if (!sameIdentity(before, after) || !sameIdentity(before, pathStat) || pathStat.nlink !== 1) {
      throw new Error(`TOOLCHAIN_FETCH_PART_UNSTABLE tool=${name} platform=${platform}`);
    }
    const actual = hashDescriptor(partFd);
    if (actual !== artifact.sha256) {
      throw new Error(
        `TOOLCHAIN_CHECKSUM_MISMATCH tool=${name} platform=${platform}`
        + ` expected=${artifact.sha256} actual=${actual} partial=${part}`,
      );
    }
    renameSync(part, target);
    const published = lstatSync(target);
    if (!sameIdentity(before, published) || published.nlink !== 1) {
      throw new Error(`TOOLCHAIN_FETCH_PART_UNSTABLE tool=${name} platform=${platform}`);
    }
    process.stdout.write(`FETCH_OK tool=${name} platform=${platform} sha256=${actual}\n`);
  } finally {
    closeSync(partFd);
  }
}

function verifiedCacheHash(path) {
  try { return readVerifiedBytes(path).hash; } catch { return undefined; }
}

function downloadWithCurl(url, partFd) {
  return spawnSync(
    "/usr/bin/curl",
    ["--fail", "--location", "--proto", "=https", "--show-error", "--output", "-", url],
    { stdio: ["ignore", partFd, "inherit"], env: minimalSubprocessEnv() },
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
    const archive = containedPath(downloads, artifact.archiveName);
    verifyArchive({ name, platform, artifact, archive, missingCode: "TOOLCHAIN_OFFLINE_CACHE_MISS" });
    const destination = containedPath(toolsRoot, artifact.installDirectory);
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
    const before = checkedRegularDescriptor(fd);
    const bytes = readDescriptorBytes(fd, before.size);
    const after = checkedRegularDescriptor(fd);
    const pathStat = lstatSync(path);
    if (!sameIdentity(before, after) || !sameIdentity(before, pathStat) || pathStat.nlink !== 1) {
      throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");
    }
    return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function checkedRegularDescriptor(fd) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) { throw new Error("TOOLCHAIN_FILE_IDENTITY_INVALID"); }
  return stat;
}

function readDescriptorBytes(fd, size = checkedRegularDescriptor(fd).size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) { throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED"); }
    offset += count;
  }
  return bytes;
}

function hashDescriptor(fd) {
  const before = checkedRegularDescriptor(fd);
  const bytes = readDescriptorBytes(fd, before.size);
  const after = checkedRegularDescriptor(fd);
  if (!sameIdentity(before, after) || before.size !== after.size) {
    throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function containedPath(root, value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || isAbsolute(value)) {
    throw new Error("TOOLCHAIN_PATH_OUTSIDE_ROOT");
  }
  const target = resolve(root, value);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("TOOLCHAIN_PATH_OUTSIDE_ROOT");
  }
  return target;
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
      const target = containedPath(staged, artifact.expectedFiles[0]);
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
      const target = containedPath(source, path);
      if (!existsSync(target) || !lstatSync(target).isFile()) {
        throw new Error(`TOOLCHAIN_INSTALL_EXPECTED_FILE tool=${name} platform=${platform} path=${path}`);
      }
      return [path, sha256(target)];
    }));
    assertExpectedFileHashes({ name, platform, artifact, files });
    if (name === "pnpm") {
      executePnpmVersionCheck({
        root: source,
        node: pinnedNode(lock, toolsRoot, platform),
        pnpmHash: files["bin/pnpm.cjs"],
        tool,
      });
    } else {
      executeVersionChecks(source, artifact, files);
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
    if (name === "pnpm") {writePnpmWrapper({ toolsRoot, hostPlatform: host });}
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
    provenance = JSON.parse(readVerifiedBytes(provenancePath).bytes.toString("utf8"));
  } catch {
    return { ok: false, code: "provenance-invalid", actualVersion: "unknown" };
  }
  const provenanceKeys = ["artifactSha256", "files", "platform", "schemaVersion", "tool", "version"];
  const fileKeys = typeof provenance.files === "object" && provenance.files !== null
    ? Object.keys(provenance.files).sort()
    : [];
  if (
    JSON.stringify(Object.keys(provenance).sort()) !== JSON.stringify(provenanceKeys)
    || JSON.stringify(fileKeys) !== JSON.stringify([...artifact.expectedFiles].sort())
    || fileKeys.some((key) => !/^[a-f0-9]{64}$/.test(provenance.files[key]))
    || provenance.schemaVersion !== 1
    || provenance.tool !== name
    || provenance.version !== tool.version
    || provenance.platform !== platform
    || provenance.artifactSha256 !== artifact.sha256
  ) {
    return { ok: false, code: "provenance-mismatch", actualVersion: "unknown" };
  }
  let canonicalFiles;
  try { canonicalFiles = canonicalArchiveFileHashes({ artifact, archive: containedPath(join(toolsRoot, "downloads"), artifact.archiveName) }); }
  catch { return { ok: false, code: "archive-provenance-unavailable", actualVersion: "unknown" }; }
  if (fileKeys.some((path) => provenance.files[path] !== canonicalFiles[path])) {
    return { ok: false, code: "provenance-mismatch", actualVersion: "unknown" };
  }
  for (const path of artifact.expectedFiles) {
    const target = containedPath(destination, path);
    const exists = existsSync(target);
    const code = inspectStableExpectedFile({ artifact: { ...artifact, provenanceFiles: canonicalFiles }, path, target, exists });
    if (code) {return { ok: false, code, actualVersion: "unknown" };}
  }
  let actualVersion;
  try {
    actualVersion = name === "pnpm"
      ? executePnpmVersionCheck({
          root: destination,
          node: pinnedNode(lock, toolsRoot, platform),
          pnpmHash: canonicalFiles["bin/pnpm.cjs"],
          tool,
        })
      : executeVersionChecks(destination, artifact, canonicalFiles);
  } catch (error) {
    return { ok: false, code: "version-command", actualVersion: error instanceof Error ? error.message : String(error) };
  }
  if (name === "pnpm") {
    const wrapper = join(toolsRoot, "bin", "pnpm");
    if (!existsSync(wrapper) || readVerifiedBytes(wrapper).bytes.toString("utf8") !== pnpmWrapper()) {
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
  const artifact = lock.tools.node.platforms[platform];
  const hashes = canonicalArchiveFileHashes({ artifact, archive: containedPath(join(toolsRoot, "downloads"), artifact.archiveName) });
  return { path: containedPath(containedPath(toolsRoot, artifact.installDirectory), "bin/node"), sha256: hashes["bin/node"] };
}

function executePnpmVersionCheck({ root, node, pnpmHash, tool }) {
  const packageJson = JSON.parse(readVerifiedBytes(containedPath(root, "package.json")).bytes.toString("utf8"));
  if (packageJson.name !== "pnpm" || packageJson.version !== tool.version) {
    throw new Error(`pnpm-package-mismatch:actual=${packageJson.name}@${packageJson.version}`);
  }
  const script = { path: containedPath(root, "bin/pnpm.cjs"), sha256: pnpmHash };
  const actual = executeOpenedNode({ node, script, args: ["--version"] });
  if (actual !== tool.version) { throw new Error(`pnpm-version-mismatch:actual=${singleLine(actual)}`); }
  return `pnpm=${actual}`;
}

function pnpmWrapper() {
  return "#!/usr/bin/env bash\n"
    + "set -euo pipefail\n"
    + "token_pnpm_tools_root=$(CDPATH= cd -- \"$(dirname -- \"${BASH_SOURCE[0]}\")/..\" && pwd)\n"
    + "token_pnpm_repo_root=$(CDPATH= cd -- \"$token_pnpm_tools_root/..\" && pwd)\n"
    + "exec \"$token_pnpm_repo_root/scripts/bootstrap.sh\" run-pnpm \"$@\"\n";
}

function writePnpmWrapper({ toolsRoot, hostPlatform: host = process.platform }) {
  toolsRoot = canonicalizeTrustedPath(toolsRoot, { platform: host });
  const bin = containedPath(toolsRoot, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  assertOwnedDirectoryChain(bin, { platform: host });
  const target = containedPath(bin, "pnpm"); const part = `${target}.part`;
  if (existsSync(part)) {
    const stale = lstatSync(part);
    if (!stale.isFile() || stale.nlink !== 1) { throw new Error("TOOLCHAIN_PNPM_WRAPPER_PART_UNSAFE"); }
    rmSync(part);
  }
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const fd = openSync(part, flags, 0o700);
  try {
    writeSync(fd, pnpmWrapper());
    const identity = checkedRegularDescriptor(fd);
    const check = lstatSync(part);
    if (!sameIdentity(identity, check) || check.nlink !== 1) {
      throw new Error("TOOLCHAIN_PNPM_WRAPPER_IDENTITY_INVALID");
    }
    renameSync(part, target);
    const published = lstatSync(target);
    if (!sameIdentity(identity, published) || published.nlink !== 1) {
      throw new Error("TOOLCHAIN_PNPM_WRAPPER_IDENTITY_INVALID");
    }
  } finally {
    closeSync(fd);
  }
  if (readVerifiedBytes(target).bytes.toString("utf8") !== pnpmWrapper()) {
    throw new Error("TOOLCHAIN_PNPM_WRAPPER_IDENTITY_INVALID");
  }
}

export function descriptorRoot(platform = process.platform) {
  if (platform === "linux") { return "/proc/self/fd"; }
  if (platform === "darwin") { return "/dev/fd"; }
  throw new Error(`TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED platform=${platform}`);
}

function openExpectedFile(path, expectedHash) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const identity = checkedRegularDescriptor(fd); const actual = hashDescriptor(fd);
    if (actual !== expectedHash) { throw new Error(`TOOLCHAIN_EXECUTABLE_CHECKSUM expected=${expectedHash} actual=${actual}`); }
    return { fd, identity, path };
  } catch (error) { closeSync(fd); throw error; }
}

function assertPathStillIdentifies(opened) {
  const current = lstatSync(opened.path);
  if (current.nlink !== 1 || !sameIdentity(opened.identity, current)) { throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED"); }
}

function checkedSpawn(result) {
  if (result.error) { throw new Error(`TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED cause=${result.error.code ?? "unknown"}`); }
  if (result.status !== 0) { throw new Error(`TOOLCHAIN_VERSION_COMMAND_FAILED status=${result.status} stderr=${singleLine(result.stderr)}`); }
  return String(result.stdout).trim();
}

export function executeVerifiedFile({ path, expectedSha256, args = [], beforeSpawn }) {
  const opened = openExpectedFile(path, expectedSha256);
  try {
    beforeSpawn?.(); assertPathStillIdentifies(opened);
    return checkedSpawn(spawnSync(`${descriptorRoot()}/3`, args, {
      encoding: "utf8", env: minimalSubprocessEnv(), stdio: ["ignore", "pipe", "pipe", opened.fd], timeout: 15_000,
    }));
  } finally { closeSync(opened.fd); }
}

function executeOpenedNode({ node, script, args, stdio = "pipe" }) {
  const openedNode = openExpectedFile(node.path, node.sha256); const openedScript = openExpectedFile(script.path, script.sha256);
  try {
    assertPathStillIdentifies(openedNode); assertPathStillIdentifies(openedScript);
    const root = descriptorRoot(); const inherited = stdio === "inherit" ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"];
    const result = spawnSync(`${root}/3`, [`${root}/4`, ...args], {
      encoding: stdio === "inherit" ? undefined : "utf8", env: minimalSubprocessEnv(), stdio: [...inherited, openedNode.fd, openedScript.fd],
      timeout: stdio === "inherit" ? undefined : 15_000,
    });
    if (stdio === "inherit") {
      if (result.error) { throw new Error(`TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED cause=${result.error.code ?? "unknown"}`); }
      return result.status ?? 1;
    }
    return checkedSpawn(result);
  } finally { closeSync(openedScript.fd); closeSync(openedNode.fd); }
}

function executeVersionChecks(root, artifact, hashes) {
  return artifact.versionChecks.map((check) => {
    const actual = executeVerifiedFile({ path: containedPath(root, check.path), expectedSha256: hashes[check.path], args: check.args });
    if (!new RegExp(check.pattern).test(actual)) { throw new Error(`version-mismatch:${check.name}:actual=${singleLine(actual)}`); }
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
    const archive = containedPath(downloads, artifact.archiveName);
    verifyArchive({ name, platform, artifact, archive, missingCode: "TOOLCHAIN_CACHE_MISSING" });
    const installation = inspectInstallation({
      name,
      tool,
      artifact,
      platform,
      destination: containedPath(toolsRoot, artifact.installDirectory),
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

export function runPnpm({ lock, platform, toolsRoot, args }) {
  assertSupported(lock, platform);
  toolsRoot = canonicalizeTrustedPath(toolsRoot);
  assertOwnedDirectoryChain(toolsRoot);
  const nodeTool = lock.tools.node;
  const nodeArtifact = nodeTool.platforms[platform];
  const pnpmTool = lock.tools.pnpm;
  for (const [name, tool, artifact] of [["node", nodeTool, nodeArtifact], ["pnpm", pnpmTool, pnpmTool]]) {
    const installation = inspectInstallation({
      name, tool, artifact, platform, destination: containedPath(toolsRoot, artifact.installDirectory), toolsRoot, lock,
    });
    if (!installation.ok) { throw new Error(`TOOLCHAIN_RUN_INVALID tool=${name} reason=${installation.code}`); }
  }
  const pnpmHashes = canonicalArchiveFileHashes({
    artifact: pnpmTool,
    archive: containedPath(join(toolsRoot, "downloads"), pnpmTool.archiveName),
  });
  return executeOpenedNode({
    node: pinnedNode(lock, toolsRoot, platform),
    script: { path: containedPath(containedPath(toolsRoot, pnpmTool.installDirectory), "bin/pnpm.cjs"), sha256: pnpmHashes["bin/pnpm.cjs"] },
    args,
    stdio: "inherit",
  });
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
  if (command === "run-pnpm") { process.exitCode = runPnpm({ lock, platform, toolsRoot, args }); return; }
  throw new Error(
    "Usage: ./dev bootstrap fetch [--scope=solana] | install --offline [--scope=solana]"
    + " | verify --offline [--scope=solana] | run-pnpm [args...]",
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
