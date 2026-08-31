const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;

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
