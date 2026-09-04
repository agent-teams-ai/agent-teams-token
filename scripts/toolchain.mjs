#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalizeTrustedPath, assertOwnedDirectoryChain } from "./toolchain-paths.mjs";
import { validateLock } from "./toolchain-lock-validation.mjs";
import { descriptorRoot, executeOpenedNode, executeVerifiedFile } from "./toolchain-execution.mjs";
import { fileURLToPath } from "node:url";
import { parseToolchainJson, TOOLCHAIN_JSON_LIMITS } from "./toolchain-json.mjs";
import {
  checkedRegularDescriptor, hashDescriptor, readVerifiedBytes, sameIdentity,
} from "./toolchain-files.mjs";
import {
  cleanupPreparedPayload,
  prepareVerifiedPayload,
} from "./toolchain-archive.mjs";
import {
  inspectInstallation,
  installPreparedArtifact,
} from "./toolchain-installation.mjs";

export {
  canonicalizeTrustedPath,
  cleanupPreparedPayload,
  descriptorRoot,
  executeVerifiedFile,
  inspectInstallation,
  installPreparedArtifact,
  prepareVerifiedPayload,
  validateLock,
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function hostPlatform({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin" && arch === "arm64") {return "darwin-arm64";}
  if (platform === "linux" && arch === "x64") {return "linux-x64";}
  throw new Error(
    `TOOLCHAIN_UNSUPPORTED_PLATFORM platform=${platform} arch=${arch}; supported=darwin-arm64,linux-x64`,
  );
}

export function loadLock(lockPath = join(repositoryRoot, "tooling/toolchain.lock.json")) {
  const lock = parseToolchainJson(readVerifiedBytes(lockPath, {
    maximumBytes: TOOLCHAIN_JSON_LIMITS.bytes,
  }).bytes);
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
  try { return readVerifiedBytes(path).hash; } catch { return; }
}

function downloadWithCurl(url, partFd) {
  return spawnSync(
    "/usr/bin/curl",
    ["--fail", "--location", "--proto", "=https", "--show-error", "--output", "-", url],
    { stdio: ["ignore", partFd, "inherit"], env: minimalSubprocessEnv() },
  ).status ?? 1;
}

function minimalSubprocessEnv(executableDirectory) {
  const path = executableDirectory ? `${executableDirectory}:/usr/bin:/bin` : "/usr/bin:/bin";
  return { PATH: path, HOME: "/tmp", LANG: "C", LC_ALL: "C", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_ENABLE_PROJECT_SPEC: "0" };
}

export function installArtifacts({ lock, platform, toolsRoot, offline, scope = "core", hostPlatform: host = process.platform }) {
  if (!offline) {throw new Error("TOOLCHAIN_INSTALL_REQUIRES_OFFLINE use=install --offline");}
  assertSupported(lock, platform);
  toolsRoot = canonicalizeTrustedPath(toolsRoot, { platform: host });
  assertOwnedDirectoryChain(toolsRoot, { platform: host });
  const downloads = containedPath(toolsRoot, "downloads");
  assertOwnedDirectoryChain(downloads, { platform: host });
  mkdirSync(toolsRoot, { recursive: true });
  for (const [name, tool, artifact] of downloadableTools(lock, platform, scope)) {
    const archive = containedPath(downloads, artifact.archiveName);
    const prepared = prepareVerifiedPayload({
      name,
      platform,
      artifact,
      archive,
      toolsRoot,
      missingCode: "TOOLCHAIN_OFFLINE_CACHE_MISS",
    });
    try {
      const destination = containedPath(toolsRoot, artifact.installDirectory);
      assertOwnedDirectoryChain(destination, { platform: host });
      const present = inspectInstallation({
        name,
        tool,
        artifact,
        authorityFiles: prepared.files,
        authorityInventory: prepared.inventory,
        authorityInventorySha256: prepared.inventorySha256,
        platform,
        destination,
        toolsRoot,
        lock,
      });
      if (present.ok) {
        process.stdout.write(
          `INSTALL_PRESENT tool=${name} platform=${platform} version=${present.actualVersion} sha256=${artifact.sha256}\n`,
        );
        continue;
      }
      installPreparedArtifact({
        name,
        tool,
        artifact,
        prepared,
        destination,
        platform,
        toolsRoot,
        lock,
      });
      process.stdout.write(
        `INSTALL_OK tool=${name} platform=${platform} version=${tool.version} sha256=${artifact.sha256}`
        + `${present.code === "missing" ? "" : ` replaced=${present.code}`}\n`,
      );
    } finally {
      cleanupPreparedPayload(prepared);
    }
  }
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

export function verifyCache({ lock, platform, toolsRoot, offline, scope = "core", hostPlatform: host = process.platform }) {
  if (!offline) {throw new Error("TOOLCHAIN_VERIFY_REQUIRES_OFFLINE use=verify --offline");}
  assertSupported(lock, platform);
  toolsRoot = canonicalizeTrustedPath(toolsRoot, { platform: host });
  assertOwnedDirectoryChain(toolsRoot, { platform: host });
  const downloads = containedPath(toolsRoot, "downloads");
  assertOwnedDirectoryChain(downloads, { platform: host });
  for (const [name, tool, artifact] of downloadableTools(lock, platform, scope)) {
    const archive = containedPath(downloads, artifact.archiveName);
    const prepared = prepareVerifiedPayload({
      name,
      platform,
      artifact,
      archive,
      toolsRoot,
      missingCode: "TOOLCHAIN_PINNED_PAYLOAD_AUTHORITY_UNAVAILABLE",
    });
    try {
      const destination = containedPath(toolsRoot, artifact.installDirectory);
      assertOwnedDirectoryChain(destination, { platform: host });
      const installation = inspectInstallation({
        name,
        tool,
        artifact,
        authorityFiles: prepared.files,
        authorityInventory: prepared.inventory,
        authorityInventorySha256: prepared.inventorySha256,
        platform,
        destination,
        toolsRoot,
        lock,
      });
      if (!installation.ok) {
        throw new Error(`TOOLCHAIN_INSTALL_INVALID tool=${name} platform=${platform} reason=${installation.code}`);
      }
      process.stdout.write(
        `VERIFY_OK tool=${name} platform=${platform} version=${installation.actualVersion} sha256=${artifact.sha256}\n`,
      );
    } finally {
      cleanupPreparedPayload(prepared);
    }
  }
}

export function runPnpm({ lock, platform, toolsRoot, args }) {
  assertSupported(lock, platform);
  toolsRoot = canonicalizeTrustedPath(toolsRoot);
  assertOwnedDirectoryChain(toolsRoot);
  assertPnpmArguments(args);

  const preparedAuthorities = [];
  let primaryFailure;
  let result;
  try {
    const authorities = new Map();
    const authenticate = (name, tool, artifact) => {
      const prepared = prepareRunInstallation({
        name, tool, artifact, platform, toolsRoot, lock,
      });
      preparedAuthorities.push(prepared);
      authorities.set(name, prepared);
      return prepared;
    };

    const authenticatedPath = [containedPath(toolsRoot, "bin")];
    for (const name of lock.coreTools) {
      const tool = lock.tools[name];
      const artifact = tool.platforms[platform];
      authenticate(name, tool, artifact);
      if (name !== "node") {
        authenticatedPath.push(...executableDirectories(
          containedPath(toolsRoot, artifact.installDirectory),
          artifact,
        ));
      }
    }

    const pnpmTool = lock.tools.pnpm;
    authenticate("pnpm", pnpmTool, pnpmTool);
    for (const name of lock.fixtureTools) {
      const tool = lock.tools[name];
      const artifact = tool.platforms[platform];
      const destination = containedPath(toolsRoot, artifact.installDirectory);
      if (!pathEntryExists(destination)) {continue;}
      authenticate(name, tool, artifact);
      authenticatedPath.push(...executableDirectories(destination, artifact));
    }

    const store = containedPath(toolsRoot, "pnpm-store");
    if (!existsSync(store)) {mkdirSync(store, { mode: 0o700 });}
    chmodSync(store, 0o700);
    assertOwnedDirectoryChain(store);
    const storeIdentity = lstatSync(store);
    if (!storeIdentity.isDirectory() || storeIdentity.isSymbolicLink()
      || (storeIdentity.mode & 0o777) !== 0o700
      || (typeof process.getuid === "function" && storeIdentity.uid !== process.getuid())) {
      throw new Error("TOOLCHAIN_PNPM_STORE_UNSAFE");
    }

    const nodeTool = lock.tools.node;
    const nodeArtifact = nodeTool.platforms[platform];
    const nodeAuthority = authorities.get("node");
    const pnpmAuthority = authorities.get("pnpm");
    const pnpmEntrypoint = "dist/pnpm.mjs";
    const pnpmEntrypointAuthority = pnpmAuthority.inventory[pnpmEntrypoint];
    if (pnpmEntrypointAuthority?.type !== "file") {
      throw new Error(`TOOLCHAIN_RUN_INVALID tool=pnpm reason=entry-missing:${pnpmEntrypoint}`);
    }
    result = executeOpenedNode({
      node: {
        path: containedPath(
          containedPath(toolsRoot, nodeArtifact.installDirectory),
          "bin/node",
        ),
        sha256: nodeAuthority.files["bin/node"],
      },
      script: {
        path: containedPath(
          containedPath(toolsRoot, pnpmTool.installDirectory),
          pnpmEntrypoint,
        ),
        sha256: pnpmEntrypointAuthority.sha256,
      },
      args: [
        ...args,
        `--config.store-dir=${store}`,
        "--config.cache-dir=/dev/null",
        "--config.ignore-pnpmfile=true",
        "--config.userconfig=/dev/null",
        "--config.globalconfig=/dev/null",
        "--config.auto-install-peers=false",
        "--config.verify-deps-before-run=false",
      ],
      stdio: "inherit",
      subprocessPath: [...new Set(authenticatedPath)],
    });
  } catch (error) {
    primaryFailure = error;
  }

  const cleanupFailures = [];
  for (const prepared of preparedAuthorities.reverse()) {
    try {cleanupPreparedPayload(prepared);}
    catch (error) {cleanupFailures.push(error);}
  }
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures].filter((error) => error !== undefined),
      primaryFailure instanceof Error ? primaryFailure.message : "TOOLCHAIN_RUN_CLEANUP_FAILED",
    );
  }
  return result;
}

function prepareRunInstallation({ name, tool, artifact, platform, toolsRoot, lock }) {
  const destination = containedPath(toolsRoot, artifact.installDirectory);
  assertOwnedDirectoryChain(destination);
  const prepared = prepareVerifiedPayload({
    name,
    platform,
    artifact,
    archive: containedPath(containedPath(toolsRoot, "downloads"), artifact.archiveName),
    toolsRoot,
    missingCode: "TOOLCHAIN_PINNED_PAYLOAD_AUTHORITY_UNAVAILABLE",
  });
  const installation = inspectInstallation({
    name,
    tool,
    artifact,
    authorityFiles: prepared.files,
    authorityInventory: prepared.inventory,
    authorityInventorySha256: prepared.inventorySha256,
    platform,
    destination,
    toolsRoot,
    lock,
  });
  if (!installation.ok) {
    try {cleanupPreparedPayload(prepared);}
    catch (cleanupError) {
      throw new AggregateError(
        [new Error(`TOOLCHAIN_RUN_INVALID tool=${name} reason=${installation.code}`), cleanupError],
        `TOOLCHAIN_RUN_INVALID tool=${name} reason=${installation.code}`,
      );
    }
    throw new Error(`TOOLCHAIN_RUN_INVALID tool=${name} reason=${installation.code}`);
  }
  return prepared;
}

function assertPnpmArguments(args) {
  const forbidden = args.find((argument) => /^(?:--agtmai-trusted-store=|--(?:cache-dir|store-dir|global-pnpmfile|pnpmfile|ignore-pnpmfile|config\.cache-dir|config\.store-dir|config\.ignore-pnpmfile|config\.userconfig|config\.globalconfig)(?:=|$))/u.test(argument));
  if (forbidden !== undefined) {
    throw new Error(`TOOLCHAIN_PNPM_AUTHORITY_ARGUMENT_FORBIDDEN argument=${forbidden}`);
  }
}

function executableDirectories(destination, artifact) {
  return [...new Set(artifact.versionChecks.map((check) =>
    dirname(containedPath(destination, check.path))))];
}

function pathEntryExists(path) {
  try {lstatSync(path); return true;}
  catch (error) {if (error?.code === "ENOENT") {return false;} throw error;}
}

/*
 * The authenticated runner deliberately does not execute .tools/bin/pnpm.
 * That wrapper remains the interactive shell boundary, while this path holds
 * verified Node and pnpm descriptors across process creation.
 */

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
