import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  inspectInstallationInventory,
  cleanupPreparedPayload,
  prepareVerifiedPayload,
  provenanceFile,
} from "./toolchain-archive.mjs";
import {
  abandonCleanupHandle,
  captureCleanupTreeSnapshot,
  cleanupIdentityBoundDirectory,
  createCleanupHandle,
} from "./rollback/runtime/cleanup.mjs";
import {
  allowlistedChildEnvironment,
  trustedNodeEnvironmentKeys,
} from "./toolchain-environment.mjs";
import {
  parseToolchainProvenance,
  serializeToolchainProvenance,
} from "./toolchain-provenance.mjs";

const unknown = "unknown";

function failure(code, actualVersion = unknown) {
  return { ok: false, code, actualVersion };
}

function inspectProvenance({ name, tool, artifact, platform, destination, prepared }) {
  const provenancePath = join(destination, provenanceFile);
  if (!existsSync(provenancePath) || !lstatSync(provenancePath).isFile()) {
    return "provenance-missing";
  }
  let provenance;
  try {
    provenance = parseToolchainProvenance(readFileSync(provenancePath), {
      tool: name,
      version: tool.version,
      platform,
      artifactSha256: artifact.sha256,
      inventorySha256: prepared.inventorySha256,
      files: prepared.files,
    });
  } catch (error) {
    return error instanceof Error && error.message.startsWith("TOOLCHAIN_PROVENANCE_MISMATCH")
      ? "provenance-mismatch"
      : "provenance-invalid";
  }
  if (provenance.inventorySha256 !== prepared.inventorySha256) {return "provenance-mismatch";}
  return;
}

function inspectAuthority({ name, tool, artifact, platform, destination, prepared }) {
  if (!existsSync(destination)) {return failure("missing", "missing");}
  if (!lstatSync(destination).isDirectory()) {return failure("installation-not-directory");}
  const inventoryCode = inspectInstallationInventory(destination, prepared.inventory);
  if (inventoryCode) {return failure(inventoryCode);}
  const provenanceCode = inspectProvenance({ name, tool, artifact, platform, destination, prepared });
  return provenanceCode ? failure(provenanceCode) : { ok: true, code: "authority-ok", actualVersion: unknown };
}

function deriveAuthority({ name, platform, artifact, toolsRoot, missingCode }) {
  return prepareVerifiedPayload({
    name,
    platform,
    artifact,
    archive: join(toolsRoot, "downloads", artifact.archiveName),
    toolsRoot,
    missingCode,
  });
}

function inspectPinnedNodeAuthority({ lock, platform, toolsRoot }) {
  const tool = lock.tools.node;
  const artifact = tool.platforms[platform];
  let prepared;
  try {
    prepared = deriveAuthority({
      name: "node",
      platform,
      artifact,
      toolsRoot,
      missingCode: "TOOLCHAIN_PINNED_NODE_AUTHORITY_UNAVAILABLE",
    });
    return inspectAuthority({
      name: "node",
      tool,
      artifact,
      platform,
      destination: join(toolsRoot, artifact.installDirectory),
      prepared,
    });
  } catch (error) {
    return failure(
      "pinned-node-authority-unavailable",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (prepared !== undefined) {cleanupPreparedPayload(prepared);}
  }
}

function inspectPnpmWrapper({ lock, toolsRoot }) {
  const wrapper = join(toolsRoot, "bin", "pnpm");
  if (!existsSync(wrapper)) {return "wrapper-missing-or-tampered";}
  const stats = lstatSync(wrapper);
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o755) {return "wrapper-missing-or-tampered";}
  return readFileSync(wrapper, "utf8") === pnpmWrapper(lock)
    ? undefined
    : "wrapper-missing-or-tampered";
}

function inspectTrustedNodeWrapper({ lock, platform, toolsRoot }) {
  const wrapper = join(toolsRoot, "bin", "node");
  if (!existsSync(wrapper)) {return "trusted-node-wrapper-missing-or-tampered";}
  const stats = lstatSync(wrapper);
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o755) {
    return "trusted-node-wrapper-missing-or-tampered";
  }
  return readFileSync(wrapper, "utf8") === trustedNodeWrapper(lock, platform)
    ? undefined
    : "trusted-node-wrapper-missing-or-tampered";
}

function inspectPreparedInstallation(args) {
  const authority = inspectAuthority(args);
  if (!authority.ok) {return authority;}
  if (args.name === "node") {
    const wrapperCode = inspectTrustedNodeWrapper(args);
    if (wrapperCode) {return failure(wrapperCode);}
  }
  if (args.name === "pnpm") {
    const nodeAuthority = inspectPinnedNodeAuthority(args);
    if (!nodeAuthority.ok) {return failure(`pinned-node-${nodeAuthority.code}`, nodeAuthority.actualVersion);}
    const wrapperCode = inspectPnpmWrapper(args);
    if (wrapperCode) {return failure(wrapperCode);}
  }
  try {
    const actualVersion = args.name === "pnpm"
      ? executePnpmVersionCheck({
          root: args.destination,
          nodeExecutable: pinnedNode(args.lock, args.toolsRoot, args.platform),
          tool: args.tool,
        })
      : executeVersionChecks(args.destination, args.artifact);
    return { ok: true, code: "ok", actualVersion: singleLine(actualVersion) };
  } catch (error) {
    return failure("version-command", error instanceof Error ? error.message : String(error));
  }
}

export function inspectInstallation(args) {
  let derived;
  try {
    const prepared = args.authorityInventory === undefined
      ? (derived = deriveAuthority({
          ...args,
          missingCode: "TOOLCHAIN_CACHE_MISSING",
        }))
      : {
          files: args.authorityFiles,
          inventory: args.authorityInventory,
          inventorySha256: args.authorityInventorySha256,
        };
    return inspectPreparedInstallation({ ...args, prepared });
  } catch (error) {
    return failure(
      "archive-authority-unavailable",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (derived !== undefined) {cleanupPreparedPayload(derived);}
  }
}

export function installPreparedArtifact({
  name,
  tool,
  artifact,
  prepared,
  destination,
  platform,
  toolsRoot,
  lock,
  onPublishBoundary,
}) {
  if (name === "pnpm") {
    const nodeAuthority = inspectPinnedNodeAuthority({ lock, platform, toolsRoot });
    if (!nodeAuthority.ok) {
      throw new Error(`TOOLCHAIN_PNPM_NODE_AUTHORITY_INVALID reason=${nodeAuthority.code}`);
    }
    executePnpmVersionCheck({
      root: prepared.source,
      nodeExecutable: pinnedNode(lock, toolsRoot, platform),
      tool,
    });
  } else {
    executeVersionChecks(prepared.source, artifact);
  }
  atomicPublish({
    name,
    tool,
    artifact,
    prepared,
    destination,
    platform,
    toolsRoot,
    lock,
    onPublishBoundary,
  });
}

function atomicPublish({
  name,
  tool,
  artifact,
  prepared,
  destination,
  platform,
  toolsRoot,
  lock,
  onPublishBoundary,
}) {
  let backup;
  writeFileSync(join(prepared.source, provenanceFile), serializeToolchainProvenance({
    tool: name,
    version: tool.version,
    platform,
    artifactSha256: artifact.sha256,
    inventorySha256: prepared.inventorySha256,
    files: prepared.files,
  }), { mode: 0o644 });
  try {
    if (existsSync(destination)) {
      const root = mkdtempSync(join(toolsRoot, ".install-backup-"));
      backup = {
        root,
        payload: join(root, "payload"),
        handle: createCleanupHandle(root, {
          temporaryRoot: toolsRoot,
          targetPrefix: ".install-backup-",
          allowedEntries: ["payload"],
        }),
      };
      renameSync(destination, backup.payload);
      onPublishBoundary?.("after-backup", { backup: backup.root, destination });
    }
    renameSync(prepared.source, destination);
    if (name === "node") {writeTrustedNodeWrapper({ lock, toolsRoot, platform });}
    if (name === "pnpm") {writePnpmWrapper({ lock, toolsRoot, platform });}
    if (backup) {
      onPublishBoundary?.("before-backup-cleanup", { backup: backup.root, destination });
      cleanupPrivatePublication(backup.handle);
      backup = undefined;
    }
  } catch (error) {
    if (backup && !existsSync(destination) && existsSync(backup.payload)) {
      renameSync(backup.payload, destination);
      cleanupPrivatePublication(backup.handle);
      backup = undefined;
    }
    if (backup) {
      abandonCleanupHandle(backup.handle);
      backup = undefined;
    }
    throw error;
  }
}

function cleanupPrivatePublication(handle) {
  captureCleanupTreeSnapshot(handle);
  cleanupIdentityBoundDirectory(handle);
}

function pinnedNode(lock, toolsRoot, platform) {
  return join(toolsRoot, lock.tools.node.platforms[platform].installDirectory, "bin", "node");
}

function executePnpmVersionCheck({ root, nodeExecutable, tool }) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packageJson.name !== "pnpm" || packageJson.version !== tool.version) {
    throw new Error(`pnpm-package-mismatch:actual=${packageJson.name}@${packageJson.version}`);
  }
  const actual = execFileSync(nodeExecutable, [join(root, "bin", "pnpm.cjs"), "--version"], {
    encoding: "utf8",
    env: allowlistedChildEnvironment(process.env, {
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      COREPACK_ENABLE_PROJECT_SPEC: "0",
    }),
    timeout: 15_000,
  }).trim();
  if (actual !== tool.version) {throw new Error(`pnpm-version-mismatch:actual=${singleLine(actual)}`);}
  return `pnpm=${actual}`;
}

function pnpmWrapper(lock) {
  const pnpmDirectory = lock.tools.pnpm.installDirectory;
  return `#!/bin/bash\nset -euo pipefail\ntoken_pnpm_source=\${BASH_SOURCE[0]}\nif [[ "$token_pnpm_source" == */* ]]; then\n  token_pnpm_directory=\${token_pnpm_source%/*}\n  [[ -n "$token_pnpm_directory" ]] || token_pnpm_directory=/\nelse\n  token_pnpm_directory=.\nfi\ntoken_pnpm_tools_root=$(CDPATH= cd -- "$token_pnpm_directory/.." && pwd -P)\nunset token_pnpm_source token_pnpm_directory\nexport COREPACK_ENABLE_DOWNLOAD_PROMPT=0\nexport COREPACK_ENABLE_PROJECT_SPEC=0\nexec "$token_pnpm_tools_root/bin/node" "$token_pnpm_tools_root/${pnpmDirectory}/bin/pnpm.cjs" --config.auto-install-peers=false --config.verify-deps-before-run=false "$@"\n`;
}

function trustedNodeWrapper(lock, platform) {
  const nodeDirectory = lock.tools.node.platforms[platform].installDirectory;
  const foundryDirectory = lock.tools.foundry?.platforms?.[platform]?.installDirectory;
  const solcDirectory = lock.tools.solc?.platforms?.[platform]?.installDirectory;
  const agaveDirectory = lock.tools.agave?.platforms?.[platform]?.installDirectory;
  const directories = [
    `${nodeDirectory}/bin`,
    foundryDirectory,
    solcDirectory,
    "bin",
    agaveDirectory ? `${agaveDirectory}/bin` : undefined,
  ].filter(Boolean);
  const keys = trustedNodeEnvironmentKeys.filter((key) =>
    !["LANG", "LC_ALL", "PATH", "TZ"].includes(key));
  return `#!/bin/bash\nset -euo pipefail\ntoken_node_source=\${BASH_SOURCE[0]}\nif [[ "$token_node_source" == */* ]]; then\n  token_node_directory=\${token_node_source%/*}\n  [[ -n "$token_node_directory" ]] || token_node_directory=/\nelse\n  token_node_directory=.\nfi\ntoken_node_tools_root=$(CDPATH= cd -- "$token_node_directory/.." && pwd -P)\ntoken_node_git_root=$(pwd -P)\ntoken_node_environment=(/usr/bin/env -i LANG=C LC_ALL=C TZ=UTC PATH="$token_node_tools_root/${directories.join(`:$token_node_tools_root/`)}:/usr/local/bin:/usr/bin:/bin:/usr/lib/git-core" GCM_INTERACTIVE=never GIT_ASKPASS=/bin/false GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_COUNT=4 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1= GIT_CONFIG_KEY_2=credential.interactive GIT_CONFIG_VALUE_2=never GIT_CONFIG_KEY_3=safe.directory GIT_CONFIG_VALUE_3="$token_node_git_root" GIT_NO_REPLACE_OBJECTS=1 GIT_SSH_COMMAND=/bin/false GIT_TERMINAL_PROMPT=0 SSH_ASKPASS=/bin/false)\nunset token_node_git_root\nfor token_node_key in ${keys.join(" ")}; do\n  if [[ -v $token_node_key ]]; then\n    token_node_environment+=("$token_node_key=\${!token_node_key}")\n  fi\ndone\nexec "\${token_node_environment[@]}" "$token_node_tools_root/${nodeDirectory}/bin/node" "$@"\n`;
}

function writeTrustedNodeWrapper({ lock, toolsRoot, platform }) {
  writeWrapper(join(toolsRoot, "bin", "node"), trustedNodeWrapper(lock, platform));
}

function writePnpmWrapper({ lock, toolsRoot }) {
  writeWrapper(join(toolsRoot, "bin", "pnpm"), pnpmWrapper(lock));
}

function writeWrapper(target, contents) {
  const bin = dirname(target);
  const part = `${target}.part`;
  mkdirSync(bin, { recursive: true });
  rmSync(part, { force: true });
  writeFileSync(part, contents, { mode: 0o755 });
  chmodSync(part, 0o755);
  renameSync(part, target);
}

function executeVersionChecks(root, artifact) {
  return artifact.versionChecks.map((check) => {
    const actual = execFileSync(join(root, check.path), check.args, {
      encoding: "utf8",
      env: allowlistedChildEnvironment(process.env, { PATH: "/usr/bin:/bin" }),
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
