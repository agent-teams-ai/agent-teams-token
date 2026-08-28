#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostPlatform, inspectInstallation, loadLock, sha256 } from "./toolchain.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function runDoctor({
  lock = loadLock(),
  toolsRoot = join(repositoryRoot, ".tools"),
  platformResolver = hostPlatform,
  commandRunner = defaultCommandRunner,
  packageVersionReader = defaultPackageVersionReader,
  environment = process.env,
  coreOnly = false,
  write = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  let platform;
  try {
    platform = platformResolver();
    write(`PLATFORM_OK actual=${platform} supported=${lock.platforms.join(",")}`);
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)} action=use-darwin-arm64-or-linux-x64`);
    return 1;
  }

  let failed = inspectCoreTools({ lock, toolsRoot, platform, write });
  if (!coreOnly) {
    const packageFailed = inspectPackages({ lock, toolsRoot, commandRunner, packageVersionReader, write });
    failed ||= packageFailed;
  }

  const unsafeFlag = ["ALLOW_PUBLIC_NETWORK", "ENABLE_PUBLIC_RPC", "MAINNET_ENABLED"]
    .find((name) => environment[name] === "true");
  if (unsafeFlag) {
    write(`PUBLIC_NETWORK_GUARD_MISMATCH flag=${unsafeFlag} expected=false action=unset-flag`);
    failed = true;
  } else {
    write("PUBLIC_NETWORK_GUARD_OK expected=disabled actual=disabled");
  }
  return failed ? 1 : 0;
}

function inspectCoreTools({ lock, toolsRoot, platform, write }) {
  let failed = false;
  for (const name of [...lock.coreTools, "pnpm"]) {
    const tool = lock.tools[name];
    const artifact = name === "pnpm" ? tool : tool.platforms[platform];
    const archive = join(toolsRoot, "downloads", artifact.archiveName);
    const actualArchiveSha256 = existsSync(archive) ? sha256(archive) : "missing";
    const installation = inspectInstallation({
      name,
      tool,
      artifact,
      platform,
      destination: join(toolsRoot, artifact.installDirectory),
      toolsRoot,
      lock,
    });
    const checksumMatches = actualArchiveSha256 === artifact.sha256;
    if (checksumMatches && installation.ok) {
      write(
        `TOOL_OK tool=${name} platform=${platform} expectedVersion=${tool.version}`
        + ` actualVersion=${quote(installation.actualVersion)} expectedSha256=${artifact.sha256}`
        + ` actualSha256=${actualArchiveSha256} install=verified`,
      );
    } else {
      write(
        `TOOL_MISMATCH tool=${name} platform=${platform} expectedVersion=${tool.version}`
        + ` actualVersion=${quote(installation.actualVersion)} expectedSha256=${artifact.sha256}`
        + ` actualSha256=${actualArchiveSha256} install=${installation.code}`
        + " action=run-./dev-bootstrap-fetch-then-install---offline",
      );
      failed = true;
    }
  }
  return failed;
}

function inspectPackages({ lock, toolsRoot, commandRunner, packageVersionReader, write }) {
  const packageChecks = [
    ["pnpm", lock.tools.pnpm.version, () => commandRunner(join(toolsRoot, "bin", "pnpm"), ["--version"])],
    ["typescript", lock.tools.typescript.version, () => packageVersionReader("typescript")],
    ["oxlint", lock.tools.oxlint.version, () => packageVersionReader("oxlint")],
    [
      "engineeringFoundation",
      lock.tools.engineeringFoundation.version,
      () => packageVersionReader("@agent-teams/engineering-foundation"),
    ],
  ];
  let failed = false;
  for (const [name, expected, readActual] of packageChecks) {
    let actual = "missing";
    try {
      actual = String(readActual()).trim();
    } catch {
      // Stable diagnostics intentionally omit command output and environment values.
    }
    if (actual === expected) {
      write(`PACKAGE_OK tool=${name} expectedVersion=${expected} actualVersion=${actual}`);
    } else {
      write(
        `PACKAGE_MISMATCH tool=${name} expectedVersion=${expected} actualVersion=${quote(actual)}`
        + " action=run-pnpm-install---frozen-lockfile",
      );
      failed = true;
    }
  }
  return failed;
}

function defaultCommandRunner(command, args) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 15_000 }).trim();
}

function defaultPackageVersionReader(packageName) {
  const packagePath = packageName === "@agent-teams/engineering-foundation"
    ? join(repositoryRoot, "node_modules", "@agent-teams", "engineering-foundation", "package.json")
    : join(repositoryRoot, "node_modules", packageName, "package.json");
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}

function quote(value) {
  return JSON.stringify(String(value).replaceAll(/\s+/g, " ").trim());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--scope=core");
  if (unknown.length > 0) {
    process.stderr.write("Usage: ./dev doctor [--scope=core]\n");
    process.exitCode = 64;
  } else {
    process.exitCode = runDoctor({ coreOnly: process.argv.includes("--scope=core") });
  }
}
