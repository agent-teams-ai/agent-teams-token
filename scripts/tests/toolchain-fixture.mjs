import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { validateLock } from "../toolchain.mjs";

export function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-toolchain-test-")));
  const artifacts = join(root, "artifacts");
  const toolsRoot = join(root, "tools");
  mkdirSync(artifacts);

  const nodePayload = join(root, "node-payload", "node-test-linux-x64", "bin");
  mkdirSync(nodePayload, { recursive: true });
  writeExecutable(
    join(nodePayload, "node"),
    `#!/bin/sh\nif [ "\${1:-}" = --version ]; then echo 'v24.20.0'; else exec '${process.execPath}' "$@"; fi\n`,
  );
  mkdirSync(join(dirname(nodePayload), "lib"));
  writeFileSync(join(dirname(nodePayload), "lib", "runtime-metadata.json"), '{"runtime":"fixture"}\n');
  symlinkSync("../lib/runtime-metadata.json", join(nodePayload, "npm"));
  const nodeArchive = join(artifacts, "node-test.tar.gz");
  execFileSync("tar", ["-czf", nodeArchive, "-C", join(root, "node-payload"), "node-test-linux-x64"]);

  const foundryPayload = join(root, "foundry-payload", "foundry-test-linux-x64");
  mkdirSync(foundryPayload, { recursive: true });
  for (const command of ["forge", "cast", "anvil", "chisel"]) {
    writeExecutable(join(foundryPayload, command), `#!/bin/sh\necho '${command} Version: 1.8.0'\n`);
  }
  writeFileSync(join(foundryPayload, "release-metadata.json"), '{"release":"1.8.0"}\n');
  const foundryArchive = join(artifacts, "foundry-test.tar.gz");
  execFileSync("tar", ["-czf", foundryArchive, "-C", join(root, "foundry-payload"), "foundry-test-linux-x64"]);

  const solcArchive = join(artifacts, "solc-test");
  writeExecutable(solcArchive, "#!/bin/sh\necho 'Version: 0.8.36+commit.8a079791.Linux.g++'\n");

  const agavePayload = join(root, "agave-payload", "solana-release", "bin");
  mkdirSync(agavePayload, { recursive: true });
  const agaveVersions = {
    solana: "solana-cli 4.2.1 (src:test; feat:test, client:Agave)",
    "solana-keygen": "solana-keygen 4.2.1 (src:test; feat:test, client:Agave)",
    "solana-test-validator": "solana-test-validator 4.2.1 (src:test; feat:test, client:Agave)",
    "spl-token": "spl-token-cli 5.6.1",
  };
  for (const [command, version] of Object.entries(agaveVersions)) {
    writeExecutable(join(agavePayload, command), `#!/bin/sh\necho '${version}'\n`);
  }
  const agaveArchive = join(artifacts, "agave-test.tar.bz2");
  execFileSync("tar", ["-cjf", agaveArchive, "-C", join(root, "agave-payload"), "solana-release"]);

  const pnpmPayload = join(root, "pnpm-payload", "package");
  mkdirSync(join(pnpmPayload, "bin"), { recursive: true });
  mkdirSync(join(pnpmPayload, "dist"));
  writeFileSync(join(pnpmPayload, "bin", "pnpm.cjs"), "import('./pnpm.mjs');\n");
  writeFileSync(join(pnpmPayload, "bin", "pnpm.mjs"), "await import('../dist/pnpm.mjs');\n", { mode: 0o755 });
  writeFileSync(join(pnpmPayload, "dist", "pnpm.mjs"), "process.stdout.write('11.24.0\\n');\n");
  writeFileSync(join(pnpmPayload, "package.json"), '{"name":"pnpm","version":"11.24.0"}\n');
  const pnpmArchive = join(artifacts, "pnpm-test.tgz");
  execFileSync("tar", ["-czf", pnpmArchive, "-C", join(root, "pnpm-payload"), "package"]);

  const definitions = fixtureArtifacts({
    nodeArchive,
    foundryArchive,
    foundryPayload,
    solcArchive,
    agaveArchive,
    agavePayload,
    agaveVersions,
  });
  const lock = fixtureLock(definitions, pnpmArchive);
  validateLock(lock);
  return {
    root,
    toolsRoot,
    lock,
    downloader: (url, partDescriptor) => {
      writeSync(partDescriptor, readFileSync(join(artifacts, basename(url))));
      return 0;
    },
  };
}

function fixtureArtifacts({ nodeArchive, foundryArchive, foundryPayload, solcArchive, agaveArchive, agavePayload, agaveVersions }) {
  const definitions = {
    node: artifact({ name: "node-test.tar.gz", path: nodeArchive, archive: "tar.gz", installDirectory: "node-test-linux-x64", expectedFiles: ["bin/node"], versionPath: "bin/node", pattern: "^v24\\.20\\.0$" }),
    foundry: artifact({ name: "foundry-test.tar.gz", path: foundryArchive, archive: "tar.gz", installDirectory: "foundry-test-linux-x64", expectedFiles: ["forge", "cast", "anvil", "chisel"], versionPath: "forge", pattern: "^forge Version: 1\\.8\\.0$" }),
    solc: artifact({ name: "solc-test", path: solcArchive, archive: "executable", installDirectory: "solc-test-linux-x64", expectedFiles: ["solc"], versionPath: "solc", pattern: "Version: 0\\.8\\.36\\+commit\\.8a079791\\." }),
    agave: artifact({
      name: "agave-test.tar.bz2",
      path: agaveArchive,
      archive: "tar.bz2",
      installDirectory: "agave-test-linux-x64",
      expectedFiles: Object.keys(agaveVersions).map((name) => `bin/${name}`),
      versionPath: "bin/solana",
      pattern: "^solana-cli 4\\.2\\.1 .*client:Agave\\)$",
    }),
  };
  definitions.foundry.expectedFileSha256 = Object.fromEntries(
    ["forge", "cast", "anvil", "chisel"]
      .map((name) => [name, digest(join(foundryPayload, name))]),
  );
  definitions.agave.versionChecks = Object.keys(agaveVersions).map((name) => ({
    name,
    path: `bin/${name}`,
    args: ["--version"],
    pattern: name === "spl-token"
      ? "^spl-token-cli 5\\.6\\.1$"
      : `^${name === "solana" ? "solana-cli" : name} 4\\.2\\.1 .*client:Agave\\)$`,
  }));
  definitions.agave.expectedFileSha256 = Object.fromEntries(
    Object.keys(agaveVersions).map((name) => [`bin/${name}`, digest(join(agavePayload, name))]),
  );
  return definitions;
}

function fixtureLock(definitions, pnpmArchive) {
  return {
    schemaVersion: 2,
    retrievedAt: "2026-08-29T00:00:00Z",
    platforms: ["darwin-arm64", "linux-x64"],
    coreTools: ["node", "foundry", "solc"],
    nativeBuilds: {
      noReplace: {
        schemaVersion: 1,
        kind: "native-no-replace-build-policy",
        sourcePath: "tooling/deployment-plan/native/no-replace.c",
        sourceSha256: "0xf3bd0279809e011933eb6ed92d55c2c7ee3bb28dedb2294ea47fe49a25483f09",
        compileProfile: "c11-o2-werror-stdin-v1",
        platforms: {
          "darwin-arm64": {
            strategy: "verified-path",
            tuples: [{
              compilerPath: "/usr/bin/cc",
              compilerSha256: `0x${"1".repeat(64)}`,
              executableSha256: `0x${"2".repeat(64)}`,
            }],
          },
          "linux-x64": {
            strategy: "snapshot-fd",
            tuples: [{
              compilerPath: "/usr/bin/x86_64-linux-gnu-gcc-13",
              compilerSha256: `0x${"3".repeat(64)}`,
              executableSha256: `0x${"4".repeat(64)}`,
            }],
          },
        },
      },
    },
    fixtureTools: ["agave"],
    policy: {},
    tools: {
      node: coreTool("24.20.0", definitions.node),
      foundry: coreTool("1.8.0", definitions.foundry),
      solc: coreTool("0.8.36", definitions.solc),
      pnpm: packageManagerTool(pnpmArchive),
      typescript: packageTool("7.0.2"),
      oxlint: packageTool("1.80.0"),
      engineeringFoundation: packageTool("0.20.0"),
      agave: {
        scope: "local-solana-fixture",
        enabledForCore: false,
        version: "4.2.1",
        splTokenVersion: "5.6.1",
        sourceRelease: "https://github.com/anza-xyz/agave/releases/tag/v4.2.1",
        platforms: { "darwin-arm64": definitions.agave, "linux-x64": definitions.agave },
      },
      ccipSdk: futureTool(),
      ccipSolanaPrograms: futureTool(),
    },
    securityImages: { slither: securityImage() },
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
    installationAuthority: "pinned-archive-complete-tree-v1",
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

function packageManagerTool(path) {
  return {
    scope: "genesis-core-package-manager",
    version: "11.24.0",
    source: "https://fixtures.invalid/pnpm-test.tgz",
    sha256: digest(path),
    archive: "tar.gz",
    archiveName: "pnpm-test.tgz",
    installDirectory: "pnpm-test",
    installationAuthority: "pinned-archive-complete-tree-v1",
    expectedFiles: ["bin/pnpm.cjs", "package.json"],
  };
}

function futureTool() {
  return { scope: "future-non-core", enabledForCore: false };
}

function securityImage() {
  return {
    scope: "solidity-security", repository: "ghcr.io/trailofbits/eth-security-toolbox",
    sourceRepository: "https://github.com/trailofbits/eth-security-toolbox", sourceRevision: "8cad443280f7eeb5920a901b5f58f5a91872d9aa",
    tag: "nightly-20260824",
    indexDigest: "sha256:10c058d04f18a572f003e786ecf4e7f396a64137b2d6a9484fff2996621535a8", platform: "linux/amd64",
    manifestDigest: "sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0",
    versions: {
      slither: "0.11.6", cryticCompile: "0.4.2", solc: "0.8.36+commit.8a079791.Linux.g++", forge: "1.8.0",
    },
    toolOverrides: { forge: "tools.foundry.platforms.linux-x64", solc: "tools.solc.platforms.linux-x64" },
    compatibilityMode: "official-image-with-read-only-pinned-project-tool-overrides",
  };
}

export function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
