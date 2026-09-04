import { isAbsolute, relative, resolve, sep } from "node:path";
import { validateExpectedFileHashes, validateFixtureToolShape, validateSecurityImage } from "./toolchain-policy.mjs";

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
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
    || JSON.stringify(tool.expectedFiles) !== JSON.stringify(["bin/pnpm.cjs", "package.json"])
  ) {
    throw new Error("TOOLCHAIN_LOCK_PACKAGE_MANAGER expected=checksum-pinned-package-manager");
  }
  assertPathSegment("pnpm", "all", tool.archiveName, "archiveName");
  assertPathSegment("pnpm", "all", tool.installDirectory, "installDirectory");
  for (const expected of tool.expectedFiles) { assertRelativePath("pnpm", "all", expected); }
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
    assertPathSegment(name, platform, artifact[field], field);
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
  if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)
    || value.includes("\\") || isAbsolute(value)) {
    throw new Error(`TOOLCHAIN_LOCK_RELATIVE_PATH tool=${name} platform=${platform}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("-"))) {
    throw new Error(`TOOLCHAIN_LOCK_RELATIVE_PATH tool=${name} platform=${platform}`);
  }
  const root = resolve("/toolchain-lock-root");
  const child = resolve(root, value);
  const contained = relative(root, child);
  if (contained === "" || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error(`TOOLCHAIN_LOCK_RELATIVE_PATH tool=${name} platform=${platform}`);
  }
}

function assertPathSegment(name, platform, value, field) {
  try {
    assertRelativePath(name, platform, value);
  } catch {
    throw new Error(`TOOLCHAIN_LOCK_PATH tool=${name} platform=${platform} field=${field}`);
  }
  if (value.includes("/")) {
    throw new Error(`TOOLCHAIN_LOCK_PATH tool=${name} platform=${platform} field=${field}`);
  }
}
