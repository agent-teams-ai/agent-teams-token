import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
export function artifact({ name, path, archive, installDirectory, expectedFiles, versionPath, pattern }) {
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

export function coreTool(version, definition) {
  return { scope: "genesis-core", version, platforms: { "darwin-arm64": definition, "linux-x64": definition } };
}
export function packageTool(version) {
  return { version, source: `https://registry.invalid/package-${version}.tgz` };
}
export function packageManagerTool(path) {
  return {
    scope: "genesis-core-package-manager",
    version: "11.24.0",
    source: "https://fixtures.invalid/pnpm-test.tgz",
    sha256: digest(path),
    archive: "tar.gz",
    archiveName: "pnpm-test.tgz",
    installDirectory: "pnpm-test",
    expectedFiles: ["bin/pnpm.cjs", "package.json"],
  };
}
export function futureTool() {
  return { scope: "future-non-core", enabledForCore: false };
}
export function securityImage() {
  return {
    scope: "solidity-security", repository: "ghcr.io/trailofbits/eth-security-toolbox",
    sourceRepository: "https://github.com/trailofbits/eth-security-toolbox", sourceRevision: "8cad443280f7eeb5920a901b5f58f5a91872d9aa",
    tag: "nightly-20260824",
    indexDigest: "sha256:10c058d04f18a572f003e786ecf4e7f396a64137b2d6a9484fff2996621535a8", platform: "linux/amd64",
    manifestDigest: "sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0",
    versions: {
      slither: "0.11.6",
      cryticCompile: "0.4.2",
      solc: "0.8.36+commit.8a079791.Linux.g++",
      forge: "1.8.0",
    },
    toolOverrides: {
      forge: "tools.foundry.platforms.linux-x64",
      solc: "tools.solc.platforms.linux-x64",
    },
    compatibilityMode: "official-image-with-read-only-pinned-project-tool-overrides" };
}
export function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
