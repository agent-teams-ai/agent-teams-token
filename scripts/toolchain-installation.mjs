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
  assertPreparedArtifactAuthority,
  inspectInstallationInventory,
  cleanupPreparedPayload,
  prepareVerifiedPayload,
  provenanceFile,
} from "./toolchain-archive.mjs";
import {
  abandonCleanupHandle,
  assertCapturedCleanupTreeSnapshot,
  captureCleanupTreeSnapshot,
  cleanupIdentityBoundDirectory,
  createCleanupHandle,
  updateCleanupTreeSnapshot,
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

function inspectPnpmWrapper({ lock, platform, toolsRoot }) {
  const wrapper = join(toolsRoot, "bin", "pnpm");
  if (!existsSync(wrapper)) {return "wrapper-missing-or-tampered";}
  const stats = lstatSync(wrapper);
  if (!stats.isFile() || (stats.mode & 0o777) !== 0o755) {return "wrapper-missing-or-tampered";}
  return readFileSync(wrapper, "utf8") === pnpmWrapper(lock, platform)
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
          nodeExecutable: trustedNode(args.toolsRoot),
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
  assertPreparedArtifactAuthority(prepared, { name, platform, artifact });
  if (name === "pnpm") {
    const nodeAuthority = inspectPinnedNodeAuthority({ lock, platform, toolsRoot });
    if (!nodeAuthority.ok) {
      throw new Error(`TOOLCHAIN_PNPM_NODE_AUTHORITY_INVALID reason=${nodeAuthority.code}`);
    }
    executePnpmVersionCheck({
      root: prepared.source,
      nodeExecutable: trustedNode(toolsRoot),
      tool,
    });
  } else {
    executeVersionChecks(prepared.source, artifact);
  }
  assertPreparedArtifactAuthority(prepared, { name, platform, artifact });
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
  updateCleanupTreeSnapshot(prepared.cleanupHandle);
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
      captureCleanupTreeSnapshot(backup.handle);
      renameSync(destination, backup.payload);
      updateCleanupTreeSnapshot(backup.handle, { allowAddedEntries: ["payload"] });
      onPublishBoundary?.("after-backup", { backup: backup.root, destination });
    }
    renameSync(prepared.source, destination);
    updateCleanupTreeSnapshot(prepared.cleanupHandle, prepared.source === join(prepared.stageRoot, "payload")
      ? { allowRemovedEntries: ["payload"] }
      : {});
    if (name === "node") {writeTrustedNodeWrapper({ lock, toolsRoot, platform });}
    if (name === "pnpm") {writePnpmWrapper({ lock, toolsRoot, platform });}
    if (backup) {
      onPublishBoundary?.("before-backup-cleanup", { backup: backup.root, destination });
      cleanupPrivatePublication(backup.handle);
      backup = undefined;
    }
  } catch (error) {
    if (backup && !existsSync(destination) && existsSync(backup.payload)) {
      assertCapturedCleanupTreeSnapshot(backup.handle);
      renameSync(backup.payload, destination);
      updateCleanupTreeSnapshot(backup.handle, { allowRemovedEntries: ["payload"] });
      cleanupPrivatePublication(backup.handle);
      backup = undefined;
    }
    if (backup) {
      if (!backup.handle.closed) {abandonCleanupHandle(backup.handle);}
      backup = undefined;
    }
    throw error;
  }
}

function cleanupPrivatePublication(handle) {
  cleanupIdentityBoundDirectory(handle);
}

function trustedNode(toolsRoot) {
  return join(toolsRoot, "bin", "node");
}

function executePnpmVersionCheck({ root, nodeExecutable, tool }) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packageJson.name !== "pnpm" || packageJson.version !== tool.version) {
    throw new Error(`pnpm-package-mismatch:actual=${packageJson.name}@${packageJson.version}`);
  }
  const actual = execFileSync(nodeExecutable, [
    join(root, "bin", "pnpm.cjs"),
    "--ignore-pnpmfile",
    "--cache-dir=/dev/null",
    "--config.userconfig=/dev/null",
    "--config.globalconfig=/dev/null",
    "--version",
  ], {
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

function pnpmWrapperTemplate(lock, platform) {
  const pnpmDirectory = lock.tools.pnpm.installDirectory;
  const storeAuthority = platform === "darwin-arm64"
    ? `/usr/bin/stat -f '%u|%Lp' "$token_pnpm_store"`
    : `/usr/bin/stat -c '%u|%a' -- "$token_pnpm_store"`;
  return `#!/bin/bash\nset -euo pipefail\ntoken_pnpm_source=\${BASH_SOURCE[0]}\nif [[ "$token_pnpm_source" == */* ]]; then\n  token_pnpm_directory=\${token_pnpm_source%/*}\n  [[ -n "$token_pnpm_directory" ]] || token_pnpm_directory=/\nelse\n  token_pnpm_directory=.\nfi\ntoken_pnpm_tools_root=$(CDPATH= cd -- "$token_pnpm_directory/.." && pwd -P)\ntoken_pnpm_store="$token_pnpm_tools_root/pnpm-store"\ntoken_pnpm_arguments=()\nfor token_pnpm_argument in "$@"; do\n  case "$token_pnpm_argument" in\n    --agtmai-trusted-store=*)\n      [[ "$token_pnpm_store" == "$token_pnpm_tools_root/pnpm-store" ]] || { printf '%s\\n' 'TOOLCHAIN_PNPM_STORE_DUPLICATE' >&2; exit 1; }\n      token_pnpm_store=\${token_pnpm_argument#*=}\n      ;;\n    --store-dir|--store-dir=*|--global-pnpmfile|--global-pnpmfile=*|--pnpmfile|--pnpmfile=*|--ignore-pnpmfile=*|--config.userconfig=*|--config.globalconfig=*)\n      printf 'TOOLCHAIN_PNPM_AUTHORITY_ARGUMENT_FORBIDDEN argument=%s\\n' "$token_pnpm_argument" >&2\n      exit 1\n      ;;\n    *) token_pnpm_arguments+=("$token_pnpm_argument") ;;\n  esac\ndone\nif [[ "$token_pnpm_store" != /* ]]; then\n  printf 'TOOLCHAIN_PNPM_STORE_NOT_ABSOLUTE path=%s\\n' "$token_pnpm_store" >&2\n  exit 1\nfi\nif [[ ! -e "$token_pnpm_store" ]]; then\n  /bin/mkdir -m 700 "$token_pnpm_store"\nfi\nif [[ ! -d "$token_pnpm_store" || -L "$token_pnpm_store" || "$(CDPATH= cd -- "$token_pnpm_store" && pwd -P)" != "$token_pnpm_store" ]]; then\n  printf 'TOOLCHAIN_PNPM_STORE_UNSAFE path=%s\\n' "$token_pnpm_store" >&2\n  exit 1\nfi\ntoken_pnpm_store_authority=$(${storeAuthority})\nif [[ "$token_pnpm_store_authority" != "$(/usr/bin/id -u)|700" ]]; then\n  printf 'TOOLCHAIN_PNPM_STORE_UNSAFE path=%s\\n' "$token_pnpm_store" >&2\n  exit 1\nfi\nunset token_pnpm_source token_pnpm_directory token_pnpm_argument token_pnpm_store_authority\nexec "$token_pnpm_tools_root/bin/node" "$token_pnpm_tools_root/${pnpmDirectory}/bin/pnpm.cjs" --store-dir="$token_pnpm_store" --ignore-pnpmfile --config.userconfig=/dev/null --config.globalconfig=/dev/null --config.auto-install-peers=false --config.verify-deps-before-run=false "\${token_pnpm_arguments[@]}"\n`;
}

function pnpmWrapper(lock, platform) {
  const template = pnpmWrapperTemplate(lock, platform);
  const withRejectedCacheOverride = template.replace(
    "    --store-dir|--store-dir=*",
    "    --cache-dir|--cache-dir=*|--store-dir|--store-dir=*|--config.cache-dir=*|--config.store-dir=*|--config.ignore-pnpmfile=*",
  );
  const wrapper = withRejectedCacheOverride.replace(
    ' --store-dir="$token_pnpm_store" --ignore-pnpmfile',
    ' --config.store-dir="$token_pnpm_store" --config.cache-dir=/dev/null --config.ignore-pnpmfile=true',
  );
  if (withRejectedCacheOverride === template || wrapper === withRejectedCacheOverride) {
    throw new Error("TOOLCHAIN_PNPM_WRAPPER_AUTHORITY_TEMPLATE_INVALID");
  }
  return wrapper;
}

function trustedNodeWrapper(lock, platform) {
  const nodeDirectory = lock.tools.node.platforms[platform].installDirectory;
  const foundryDirectory = lock.tools.foundry?.platforms?.[platform]?.installDirectory;
  const solcDirectory = lock.tools.solc?.platforms?.[platform]?.installDirectory;
  const agaveDirectory = lock.tools.agave?.platforms?.[platform]?.installDirectory;
  const directories = [
    "bin",
    foundryDirectory,
    solcDirectory,
    agaveDirectory ? `${agaveDirectory}/bin` : undefined,
  ].filter(Boolean);
  const keys = trustedNodeEnvironmentKeys.filter((key) =>
    !["LANG", "LC_ALL", "PATH", "TZ"].includes(key));
  return `#!/bin/bash\nset -euo pipefail\ntoken_node_source=\${BASH_SOURCE[0]}\nif [[ "$token_node_source" == */* ]]; then\n  token_node_directory=\${token_node_source%/*}\n  [[ -n "$token_node_directory" ]] || token_node_directory=/\nelse\n  token_node_directory=.\nfi\ntoken_node_tools_root=$(CDPATH= cd -- "$token_node_directory/.." && pwd -P)\ntoken_node_git_root=$(pwd -P)\ntoken_node_private_root=$(/usr/bin/mktemp -d /tmp/agtmai-node-environment.XXXXXX)\n/bin/chmod 700 "$token_node_private_root"\nfor token_node_private_name in home xdg-cache xdg-config xdg-data xdg-runtime tmp; do\n  /bin/mkdir -m 700 "$token_node_private_root/$token_node_private_name"\ndone\ntoken_node_cleanup_private() {\n  local token_node_cleanup_status=0\n  for token_node_private_name in home xdg-cache xdg-config xdg-data xdg-runtime tmp; do\n    /bin/rmdir "$token_node_private_root/$token_node_private_name" 2>/dev/null || token_node_cleanup_status=1\n  done\n  /bin/rmdir "$token_node_private_root" 2>/dev/null || token_node_cleanup_status=1\n  return "$token_node_cleanup_status"\n}\ntrap 'token_node_cleanup_private || true' EXIT HUP INT TERM\ntoken_node_environment=(/usr/bin/env -i HOME="$token_node_private_root/home" TMPDIR="$token_node_private_root/tmp" XDG_CACHE_HOME="$token_node_private_root/xdg-cache" XDG_CONFIG_HOME="$token_node_private_root/xdg-config" XDG_DATA_HOME="$token_node_private_root/xdg-data" XDG_RUNTIME_DIR="$token_node_private_root/xdg-runtime" NODE_DISABLE_COMPILE_CACHE=1 NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/dev/null npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null LANG=C LC_ALL=C TZ=UTC PATH="$token_node_tools_root/${directories.join(`:$token_node_tools_root/`)}:/usr/local/bin:/usr/bin:/bin:/usr/lib/git-core" GCM_INTERACTIVE=never GIT_ASKPASS=/bin/false GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_COUNT=6 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null GIT_CONFIG_KEY_2=core.attributesFile GIT_CONFIG_VALUE_2=/dev/null GIT_CONFIG_KEY_3=credential.helper GIT_CONFIG_VALUE_3= GIT_CONFIG_KEY_4=credential.interactive GIT_CONFIG_VALUE_4=never GIT_CONFIG_KEY_5=safe.directory GIT_CONFIG_VALUE_5="$token_node_git_root" GIT_NO_REPLACE_OBJECTS=1 GIT_SSH_COMMAND=/bin/false GIT_TERMINAL_PROMPT=0 SSH_ASKPASS=/bin/false)\nunset token_node_git_root\nfor token_node_key in ${keys.join(" ")}; do\n  if [[ -v $token_node_key ]]; then\n    token_node_environment+=("$token_node_key=\${!token_node_key}")\n  fi\ndone\nset +e\n"\${token_node_environment[@]}" "$token_node_tools_root/${nodeDirectory}/bin/node" "$@"\ntoken_node_status=$?\nset -e\ntrap - EXIT HUP INT TERM\nif ! token_node_cleanup_private; then\n  printf 'TOOLCHAIN_PRIVATE_ENVIRONMENT_PRESERVED path=%s\\n' "$token_node_private_root" >&2\n  token_node_status=1\nfi\nexit "$token_node_status"\n`;
}

function writeTrustedNodeWrapper({ lock, toolsRoot, platform }) {
  writeWrapper(join(toolsRoot, "bin", "node"), trustedNodeWrapper(lock, platform));
}

function writePnpmWrapper({ lock, toolsRoot, platform }) {
  writeWrapper(join(toolsRoot, "bin", "pnpm"), pnpmWrapper(lock, platform));
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
