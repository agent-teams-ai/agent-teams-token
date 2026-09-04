const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PREFIXED_SHA256 = /^0x[a-f0-9]{64}$/;

export function validateNativeNoReplacePolicy(policy) {
  exactObjectKeys(policy, ["schemaVersion", "kind", "sourcePath", "sourceSha256", "compileProfile", "platforms"], "POLICY");
  if (policy.schemaVersion !== 1 || policy.kind !== "native-no-replace-build-policy"
    || policy.sourcePath !== "tooling/deployment-plan/native/no-replace.c"
    || policy.sourceSha256 !== "0xf3bd0279809e011933eb6ed92d55c2c7ee3bb28dedb2294ea47fe49a25483f09"
    || policy.compileProfile !== "c11-o2-werror-stdin-v1") {
    throw new Error("TOOLCHAIN_LOCK_NATIVE_POLICY");
  }
  exactObjectKeys(policy.platforms, ["darwin-arm64", "linux-x64"], "PLATFORMS");
  validateNativePlatform(policy.platforms["darwin-arm64"], "darwin-arm64", "verified-path");
  validateNativePlatform(policy.platforms["linux-x64"], "linux-x64", "snapshot-fd");
}

function validateNativePlatform(value, platform, strategy) {
  exactObjectKeys(value, ["strategy", "tuples"], `PLATFORM platform=${platform}`);
  if (value.strategy !== strategy || !Array.isArray(value.tuples)
    || value.tuples.length < 1 || value.tuples.length > 2) {
    throw new Error(`TOOLCHAIN_LOCK_NATIVE_PLATFORM platform=${platform}`);
  }
  const serialized = [];
  for (const tuple of value.tuples) {
    exactObjectKeys(tuple, ["compilerPath", "compilerSha256", "executableSha256"], `TUPLE platform=${platform}`);
    const compilerPath = platform === "darwin-arm64"
      ? "/usr/bin/cc" : "/usr/bin/x86_64-linux-gnu-gcc-13";
    if (tuple.compilerPath !== compilerPath || !PREFIXED_SHA256.test(tuple.compilerSha256 ?? "")
      || !PREFIXED_SHA256.test(tuple.executableSha256 ?? "")) {
      throw new Error(`TOOLCHAIN_LOCK_NATIVE_TUPLE platform=${platform}`);
    }
    serialized.push(`${tuple.compilerPath}|${tuple.compilerSha256}|${tuple.executableSha256}`);
  }
  const compilerIdentities = value.tuples.map((tuple) => `${tuple.compilerPath}|${tuple.compilerSha256}`);
  if (new Set(serialized).size !== serialized.length || new Set(compilerIdentities).size !== compilerIdentities.length
    || serialized.some((entry, index) => index > 0 && serialized[index - 1].localeCompare(entry) >= 0)) {
    throw new Error(`TOOLCHAIN_LOCK_NATIVE_TUPLE_ORDER platform=${platform}`);
  }
}

function exactObjectKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`TOOLCHAIN_LOCK_NATIVE_${label}`);
  }
  const actual = Object.keys(value).toSorted();
  const wanted = expected.toSorted();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`TOOLCHAIN_LOCK_NATIVE_${label}`);
  }
}

export function validateFixtureToolShape(tool, name) {
  if (
    !tool
    || tool.scope !== "local-solana-fixture"
    || tool.enabledForCore !== false
    || tool.version !== "4.2.1"
    || tool.splTokenVersion !== "5.6.1"
    || !tool.sourceRelease?.startsWith("https://github.com/anza-xyz/agave/releases/tag/")
  ) {
    throw new Error(`TOOLCHAIN_LOCK_FIXTURE_TOOL tool=${name}`);
  }
}

export function validateSecurityImage(image) {
  if (!securityImageIdentityValid(image) || !securityVersionsValid(image) || !securityOverridesValid(image)) {
    throw new Error("TOOLCHAIN_LOCK_SECURITY_IMAGE image=slither");
  }
}

function securityImageIdentityValid(image) {
  return image?.scope === "solidity-security"
    && image.repository === "ghcr.io/trailofbits/eth-security-toolbox"
    && image.sourceRepository === "https://github.com/trailofbits/eth-security-toolbox"
    && /^[a-f0-9]{40}$/.test(image.sourceRevision ?? "")
    && /^nightly-[0-9]{8}$/.test(image.tag ?? "")
    && OCI_DIGEST.test(image.indexDigest ?? "")
    && image.platform === "linux/amd64"
    && OCI_DIGEST.test(image.manifestDigest ?? "");
}

function securityVersionsValid(image) {
  return image?.versions?.slither === "0.11.6"
    && image.versions.cryticCompile === "0.4.2"
    && image.versions.solc === "0.8.36+commit.8a079791.Linux.g++"
    && image.versions.forge === "1.8.0";
}

function securityOverridesValid(image) {
  return image?.toolOverrides?.forge === "tools.foundry.platforms.linux-x64"
    && image.toolOverrides.solc === "tools.solc.platforms.linux-x64"
    && image.compatibilityMode === "official-image-with-read-only-pinned-project-tool-overrides";
}

export function validateExpectedFileHashes(name, platform, artifact) {
  const hashEntries = Object.entries(artifact.expectedFileSha256 ?? {});
  const coversExpected = hashEntries.length === artifact.expectedFiles.length
    && artifact.expectedFiles.every((path) => SHA256.test(artifact.expectedFileSha256?.[path] ?? ""));
  const containsOnlyExpected = hashEntries.every(([path]) => artifact.expectedFiles.includes(path));
  if (!coversExpected || !containsOnlyExpected) {
    throw new Error(`TOOLCHAIN_LOCK_INNER_HASHES tool=${name} platform=${platform}`);
  }
}

export function assertExpectedFileHashes({ name, platform, artifact, files }) {
  for (const [path, expected] of Object.entries(artifact.expectedFileSha256 ?? {})) {
    if (files[path] !== expected) {
      throw new Error(
        `TOOLCHAIN_INSTALL_INNER_CHECKSUM tool=${name} platform=${platform}`
        + ` path=${path} expected=${expected} actual=${files[path] ?? "missing"}`,
      );
    }
  }
}

export function lockedFileMismatch(artifact, path, actual) {
  const expected = artifact.expectedFileSha256?.[path];
  return expected === undefined ? false : expected !== actual;
}

export function inspectExpectedFile({ artifact, path, target, exists, isFile, sha256 }) {
  if (!exists || !isFile) {return `file-missing:${path}`;}
  const actual = sha256(target);
  if (artifact.provenanceFiles?.[path] !== actual) {return `file-checksum:${path}`;}
  return lockedFileMismatch(artifact, path, actual) ? `file-lock-checksum:${path}` : undefined;
}
