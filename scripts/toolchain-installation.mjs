import { executeVerifiedFile, executeOpenedNode } from "./toolchain-execution.mjs";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertPreparedArtifactAuthority,
  inspectInstallationInventory,
  withPreparedPayload,
  prepareVerifiedPayload,
  provenanceFile,
} from "./toolchain-archive.mjs";
import {
  updateCleanupTreeSnapshot,
} from "./rollback/runtime/cleanup.mjs";
import {
  trustedNodeEnvironmentKeys,
} from "./toolchain-environment.mjs";
import {
  parseToolchainProvenance,
  serializeToolchainProvenance,
} from "./toolchain-provenance.mjs";
import { publishPreparedInstallation } from "./toolchain-publication.mjs";
import { canonicalizeTrustedPath } from "./toolchain-paths.mjs";

const unknown = "unknown";

function failure(code, actualVersion = unknown, cause) {
  return { ok: false, code, actualVersion, ...(cause === undefined ? {} : { cause }) };
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

function inspectPinnedNodeAuthority({ lock, platform, toolsRoot }, action = (authority) => authority) {
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
  } catch (error) {
    if (error instanceof AggregateError) { throw error; }
    throw new Error("TOOLCHAIN_PINNED_NODE_AUTHORITY_UNAVAILABLE", { cause: error });
  }
  return withPreparedPayload(prepared, () => {
    const authority = inspectAuthority({
      name: "node",
      tool,
      artifact,
      platform,
      destination: join(toolsRoot, artifact.installDirectory),
      prepared,
    });
    return action(authority, prepared);
  });
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
          ...args,
          root: args.destination,
        })
      : executeVersionChecks(args.destination, args.artifact, args.prepared.inventory);
    return { ok: true, code: "ok", actualVersion: singleLine(actualVersion) };
  } catch (error) {
    if (error instanceof AggregateError) { throw error; }
    return failure("version-command", error instanceof Error ? error.message : String(error), error);
  }
}

export function inspectInstallation(args) {
  let derived;
  try {
    derived = args.authorityInventory === undefined
      ? deriveAuthority({
          ...args,
          missingCode: "TOOLCHAIN_CACHE_MISSING",
        })
      : {
          files: args.authorityFiles,
          inventory: args.authorityInventory,
          inventorySha256: args.authorityInventorySha256,
        };
  } catch (error) {
    if (error instanceof AggregateError) { throw error; }
    return failure(
      "archive-authority-unavailable",
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
  const inspect = () => inspectPreparedInstallation({ ...args, prepared: derived });
  return args.authorityInventory === undefined ? withPreparedPayload(derived, inspect) : inspect();
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
  toolsRoot = canonicalizeTrustedPath(toolsRoot);
  destination = canonicalizeTrustedPath(destination);
  assertPreparedArtifactAuthority(prepared, { name, platform, artifact });
  if (name === "pnpm") {
    const nodeAuthority = inspectPinnedNodeAuthority({ lock, platform, toolsRoot });
    if (!nodeAuthority.ok) {
      throw new Error(`TOOLCHAIN_PNPM_NODE_AUTHORITY_INVALID reason=${nodeAuthority.code}`);
    }
    executePnpmVersionCheck({
      root: prepared.source,
      lock, platform, toolsRoot, prepared, tool,
    });
  } else {
    executeVersionChecks(prepared.source, artifact, prepared.inventory);
  }
  assertPreparedArtifactAuthority(prepared, { name, platform, artifact });
  writeFileSync(join(prepared.source, provenanceFile), serializeToolchainProvenance({
    tool: name,
    version: tool.version,
    platform,
    artifactSha256: artifact.sha256,
    inventorySha256: prepared.inventorySha256,
    files: prepared.files,
  }), { mode: 0o644 });
  updateCleanupTreeSnapshot(prepared.cleanupHandle);
  const wrapper = name === "node"
    ? { target: join(toolsRoot, "bin", "node"), contents: trustedNodeWrapper(lock, platform) }
    : name === "pnpm"
      ? { target: join(toolsRoot, "bin", "pnpm"), contents: pnpmWrapper(lock, platform) }
      : undefined;
  publishPreparedInstallation({
    prepared,
    destination,
    toolsRoot,
    wrapper,
    onPublishBoundary,
    validateDestination() {
      const authority = inspectAuthority({
        name, tool, artifact, platform, destination, prepared,
      });
      if (!authority.ok) {
        throw new Error("TOOLCHAIN_PUBLISHED_AUTHORITY_INVALID reason=" + authority.code);
      }
    },
  });
}

function executePnpmVersionCheck({ root, tool, lock, platform, toolsRoot, prepared }) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packageJson.name !== "pnpm" || packageJson.version !== tool.version) {
    throw new Error(`pnpm-package-mismatch:actual=${packageJson.name}@${packageJson.version}`);
  }
  const actual = inspectPinnedNodeAuthority({ lock, platform, toolsRoot }, (authority, nodePrepared) => {
    if (!authority.ok) { throw new Error(`TOOLCHAIN_PNPM_NODE_AUTHORITY_INVALID reason=${authority.code}`); }
    const entrypoint = "dist/pnpm.mjs";
    const entry = prepared.inventory[entrypoint];
    if (entry?.type !== "file") { throw new Error("TOOLCHAIN_PNPM_ENTRYPOINT_MISSING"); }
    return executeOpenedNode({
      node: { path: join(toolsRoot, lock.tools.node.platforms[platform].installDirectory, "bin/node"),
        sha256: nodePrepared.inventory["bin/node"].sha256 },
      script: { path: join(root, entrypoint), sha256: entry.sha256 },
      args: [
        "--version",
        "--ignore-pnpmfile",
        "--cache-dir=/dev/null",
        "--config.userconfig=/dev/null",
        "--config.globalconfig=/dev/null",
      ],
    });
  });
  if (actual !== tool.version) {throw new Error(`pnpm-version-mismatch:actual=${singleLine(actual)}`);}
  return `pnpm=${actual}`;
}

function pnpmWrapperTemplate(lock, platform) {
  const pnpmDirectory = lock.tools.pnpm.installDirectory;
  const storeAuthority = platform === "darwin-arm64"
    ? `/usr/bin/stat -f '%u|%Lp' "$token_pnpm_store"`
    : `/usr/bin/stat -c '%u|%a' -- "$token_pnpm_store"`;
  return `#!/bin/bash\nset -euo pipefail\ntoken_pnpm_source=\${BASH_SOURCE[0]}\nif [[ "$token_pnpm_source" == */* ]]; then\n  token_pnpm_directory=\${token_pnpm_source%/*}\n  [[ -n "$token_pnpm_directory" ]] || token_pnpm_directory=/\nelse\n  token_pnpm_directory=.\nfi\ntoken_pnpm_tools_root=$(CDPATH= cd -- "$token_pnpm_directory/.." && pwd -P)\ntoken_pnpm_store="$token_pnpm_tools_root/pnpm-store"\ntoken_pnpm_arguments=()\nfor token_pnpm_argument in "$@"; do\n  case "$token_pnpm_argument" in\n    --agtmai-trusted-store=*)\n      [[ "$token_pnpm_store" == "$token_pnpm_tools_root/pnpm-store" ]] || { printf '%s\\n' 'TOOLCHAIN_PNPM_STORE_DUPLICATE' >&2; exit 1; }\n      token_pnpm_store=\${token_pnpm_argument#*=}\n      ;;\n    --store-dir|--store-dir=*|--global-pnpmfile|--global-pnpmfile=*|--pnpmfile|--pnpmfile=*|--ignore-pnpmfile=*|--config.userconfig=*|--config.globalconfig=*)\n      printf 'TOOLCHAIN_PNPM_AUTHORITY_ARGUMENT_FORBIDDEN argument=%s\\n' "$token_pnpm_argument" >&2\n      exit 1\n      ;;\n    *) token_pnpm_arguments+=("$token_pnpm_argument") ;;\n  esac\ndone\nif [[ "$token_pnpm_store" != /* ]]; then\n  printf 'TOOLCHAIN_PNPM_STORE_NOT_ABSOLUTE path=%s\\n' "$token_pnpm_store" >&2\n  exit 1\nfi\nif [[ ! -e "$token_pnpm_store" ]]; then\n  /bin/mkdir -m 700 "$token_pnpm_store" || [[ -d "$token_pnpm_store" ]]\nfi\nif [[ ! -d "$token_pnpm_store" || -L "$token_pnpm_store" || "$(CDPATH= cd -- "$token_pnpm_store" && pwd -P)" != "$token_pnpm_store" ]]; then\n  printf 'TOOLCHAIN_PNPM_STORE_UNSAFE path=%s\\n' "$token_pnpm_store" >&2\n  exit 1\nfi\ntoken_pnpm_store_authority=$(${storeAuthority})\nif [[ "$token_pnpm_store_authority" != "$(/usr/bin/id -u)|700" ]]; then\n  printf 'TOOLCHAIN_PNPM_STORE_UNSAFE path=%s\\n' "$token_pnpm_store" >&2\n  exit 1\nfi\nunset token_pnpm_source token_pnpm_directory token_pnpm_argument token_pnpm_store_authority\nexec "$token_pnpm_tools_root/bin/node" "$token_pnpm_tools_root/${pnpmDirectory}/bin/pnpm.cjs" --store-dir="$token_pnpm_store" --ignore-pnpmfile --config.userconfig=/dev/null --config.globalconfig=/dev/null --config.auto-install-peers=false --config.verify-deps-before-run=false "\${token_pnpm_arguments[@]}"\n`;
}

function pnpmWrapper(lock, platform) {
  const template = pnpmWrapperTemplate(lock, platform);
  const withRejectedCacheOverride = template.replace(
    "    --store-dir|--store-dir=*",
    "    --cache-dir|--cache-dir=*|--cacheDir|--cacheDir=*|--store-dir|--store-dir=*|--config.cache-dir|--config.cache-dir=*|--config.cacheDir|--config.cacheDir=*|--config.store-dir=*|--config.ignore-pnpmfile=*",
  );
  const withNormalizedCacheArguments = withRejectedCacheOverride.replace(
    '  case "$token_pnpm_argument" in',
    `  if [[ "$token_pnpm_argument" == -* ]]; then
    token_pnpm_cache_key=$(LC_ALL=C /usr/bin/tr '[:upper:]_' '[:lower:]-' <<< "\${token_pnpm_argument%%=*}")
    case "\${token_pnpm_cache_key//-/}" in
      cachedir|config.cachedir|nocachedir|config.nocachedir)
        printf 'TOOLCHAIN_PNPM_AUTHORITY_ARGUMENT_FORBIDDEN argument=%s\\n' "$token_pnpm_argument" >&2
        exit 1 ;;
    esac
  fi
  case "$token_pnpm_argument" in`,
  );
  const withPrivateStoreUmask = withNormalizedCacheArguments.replace(
    "unset token_pnpm_source token_pnpm_directory token_pnpm_argument token_pnpm_store_authority",
    `umask 077\n${pnpmCacheGuard(platform)}\nunset token_pnpm_source token_pnpm_directory token_pnpm_argument token_pnpm_store_authority`,
  );
  const wrapper = withPrivateStoreUmask.replace(
    ' --store-dir="$token_pnpm_store" --ignore-pnpmfile',
    ' --config.store-dir="$token_pnpm_store" --config.cache-dir="$token_pnpm_cache" --config.ignore-pnpmfile=true',
  );
  if (withRejectedCacheOverride === template || withNormalizedCacheArguments === withRejectedCacheOverride
    || withPrivateStoreUmask === withNormalizedCacheArguments
    || wrapper === withPrivateStoreUmask) {
    throw new Error("TOOLCHAIN_PNPM_WRAPPER_AUTHORITY_TEMPLATE_INVALID");
  }
  return wrapper;
}

function pnpmCacheGuard(platform) {
  const stat = platform === "darwin-arm64"
    ? "/usr/bin/stat -f '%d|%i|%u|%Lp'"
    : "/usr/bin/stat -c '%d|%i|%u|%a' --";
  // Keep policy metadata with the selected store, including rollback stores.
  // A separate child avoids pnpm store prune treating the package store as cache.
  return `token_pnpm_store_identity=$(${stat} "$token_pnpm_store")
token_pnpm_cache="$token_pnpm_store/metadata-cache"
if [[ ! -e "$token_pnpm_cache" ]]; then
  /bin/mkdir -m 700 "$token_pnpm_cache" || [[ -d "$token_pnpm_cache" ]]
fi
if [[ ! -d "$token_pnpm_cache" || -L "$token_pnpm_cache" || "$(CDPATH= cd -- "$token_pnpm_cache" && pwd -P)" != "$token_pnpm_cache" ]]; then
  printf 'TOOLCHAIN_PNPM_CACHE_UNSAFE path=%s\\n' "$token_pnpm_cache" >&2
  exit 1
fi
token_pnpm_cache_authority=$(${stat} "$token_pnpm_cache")
token_pnpm_cache_unsafe=$(/usr/bin/find "$token_pnpm_cache" \\( ! -user "$(/usr/bin/id -u)" -o \\( -type d ! -perm 0700 \\) -o \\( -type f \\( ! -perm 0600 -o ! -links 1 \\) \\) -o \\( ! -type d ! -type f \\) \\) -print)
if [[ -n "$token_pnpm_cache_unsafe" || "$(${stat} "$token_pnpm_cache")" != "$token_pnpm_cache_authority" ]]; then
  printf 'TOOLCHAIN_PNPM_CACHE_UNSAFE path=%s\\n' "$token_pnpm_cache" >&2
  exit 1
fi
if [[ "\${token_pnpm_cache_authority#*|*|}" != "$(/usr/bin/id -u)|700" || "$(${stat} "$token_pnpm_store")" != "$token_pnpm_store_identity" || -L "$token_pnpm_store" ]]; then
  printf 'TOOLCHAIN_PNPM_CACHE_UNSAFE path=%s\\n' "$token_pnpm_cache" >&2
  exit 1
fi
unset token_pnpm_store_identity token_pnpm_cache_authority token_pnpm_cache_unsafe`;
}

function trustedNodeWrapper(lock, platform) {
  const nodeDirectory = lock.tools.node.platforms[platform].installDirectory;
  const directories = ["bin"];
  const pathGuard = wrapperPathGuard(lock, platform);
  const supervisor = `(${trustedNodeChildMain.toString()})(require)`;
  const quotedSupervisor = "'" + supervisor.replaceAll("'", "'\\''") + "'";
  const keys = trustedNodeEnvironmentKeys.filter((key) =>
    !["LANG", "LC_ALL", "PATH", "TZ"].includes(key));
  return `#!/bin/bash\nset -euo pipefail\ntoken_node_source=\${BASH_SOURCE[0]}\nif [[ "$token_node_source" == */* ]]; then\n  token_node_directory=\${token_node_source%/*}\n  [[ -n "$token_node_directory" ]] || token_node_directory=/\nelse\n  token_node_directory=.\nfi\ntoken_node_tools_root=$(CDPATH= cd -- "$token_node_directory/.." && pwd -P)\n${pathGuard}\ntoken_node_git_root=$(pwd -P)\ntoken_node_private_root=$(/usr/bin/mktemp -d /tmp/agtmai-node-environment.XXXXXX)\ntoken_node_private_root=$(CDPATH= cd -- "$token_node_private_root" && pwd -P)\n/bin/chmod 700 "$token_node_private_root"\nfor token_node_private_name in home xdg-cache xdg-config xdg-data xdg-runtime tmp; do\n  /bin/mkdir -m 700 "$token_node_private_root/$token_node_private_name"\ndone\ntoken_node_cleanup_private() {\n  local token_node_cleanup_status=0\n  for token_node_private_name in home xdg-cache xdg-config xdg-data xdg-runtime tmp; do\n    /bin/rmdir "$token_node_private_root/$token_node_private_name" 2>/dev/null || token_node_cleanup_status=1\n  done\n  /bin/rmdir "$token_node_private_root" 2>/dev/null || token_node_cleanup_status=1\n  return "$token_node_cleanup_status"\n}\ntrap 'token_node_cleanup_private || true' EXIT\ntrap 'exit 129' HUP\ntrap 'exit 130' INT\ntrap 'exit 143' TERM\ntoken_node_environment=(/usr/bin/env -i HOME="$token_node_private_root/home" TMPDIR="$token_node_private_root/tmp" XDG_CACHE_HOME="$token_node_private_root/xdg-cache" XDG_CONFIG_HOME="$token_node_private_root/xdg-config" XDG_DATA_HOME="$token_node_private_root/xdg-data" XDG_RUNTIME_DIR="$token_node_private_root/xdg-runtime" NODE_DISABLE_COMPILE_CACHE=1 NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/dev/null npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null LANG=C LC_ALL=C TZ=UTC PATH="$token_node_tools_root/${directories.join(`:$token_node_tools_root/`)}:/usr/bin:/bin:/usr/lib/git-core" GCM_INTERACTIVE=never GIT_ASKPASS=/bin/false GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_COUNT=6 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null GIT_CONFIG_KEY_2=core.attributesFile GIT_CONFIG_VALUE_2=/dev/null GIT_CONFIG_KEY_3=credential.helper GIT_CONFIG_VALUE_3= GIT_CONFIG_KEY_4=credential.interactive GIT_CONFIG_VALUE_4=never GIT_CONFIG_KEY_5=safe.directory GIT_CONFIG_VALUE_5="$token_node_git_root" GIT_NO_REPLACE_OBJECTS=1 GIT_SSH_COMMAND=/bin/false GIT_TERMINAL_PROMPT=0 SSH_ASKPASS=/bin/false)\nunset token_node_git_root\nfor token_node_key in ${keys.join(" ")}; do\n  if [[ -n \${!token_node_key+x} ]]; then\n    token_node_environment+=("$token_node_key=\${!token_node_key}")\n  fi\ndone\nexec "\${token_node_environment[@]}" "$token_node_tools_root/${nodeDirectory}/bin/node" --input-type=commonjs --eval ${quotedSupervisor} -- "$@"\n`;
}

// Embedded in the authenticated wrapper, then exec'd in its private environment.
// Own exactly one ChildProcess: no PID polling, delayed numeric kills, process
// groups or descendant discovery. A signal gets 1s grace, then KILL and 1s to
// reap. Unconfirmed termination preserves the environment and fails closed.
function trustedNodeChildMain(require) {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  const { constants } = require("node:os");
  const root = path.dirname(process.env.HOME);
  const paths = [root, ...["home", "xdg-cache", "xdg-config", "xdg-data", "xdg-runtime", "tmp"]
    .map((name) => path.join(root, name))];
  const identities = [];
  let child;
  let interruption;
  let finished = false;
  let childError = false;
  let graceTimer;
  let reapTimer;

  function verify(index) {
    const current = fs.lstatSync(paths[index], { bigint: true });
    const expected = identities[index];
    if (!current.isDirectory() || current.uid !== BigInt(process.getuid())
      || (current.mode & 0o777n) !== 0o700n
      || ["dev", "ino", "mode", "uid"].some((key) => current[key] !== expected[key])) {
      throw new Error("TOOLCHAIN_PRIVATE_ENVIRONMENT_SUBSTITUTED");
    }
  }

  function finish(status, reaped = true) {
    if (finished) { return; }
    finished = true;
    clearTimeout(graceTimer);
    clearTimeout(reapTimer);
    let cleanupFailed = !reaped;
    if (reaped) {
      // Check the root before each exact rmdir; never traverse retained output.
      for (const index of [1, 2, 3, 4, 5, 6, 0]) {
        try {
          verify(0);
          verify(index);
          fs.rmdirSync(paths[index]);
        } catch {
          cleanupFailed = true;
        }
      }
    }
    if (cleanupFailed) {
      process.stderr.write("TOOLCHAIN_PRIVATE_ENVIRONMENT_PRESERVED path=" + root + "\n");
    }
    process.exitCode = interruption ?? (cleanupFailed || childError ? 1 : status);
  }

  function interrupt(signal) {
    if (interruption !== undefined) { return; }
    interruption = 128 + constants.signals[signal];
    if (finished) { process.exitCode = interruption; return; }
    child.kill(signal);
    graceTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reapTimer = setTimeout(() => {
        process.stderr.write("TOOLCHAIN_NODE_CHILD_TERMINATION_UNCONFIRMED\n");
        finish(interruption, false);
        child.unref();
      }, 1_000);
    }, 1_000);
  }

  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(signal, () => interrupt(signal));
  }
  try {
    for (const directory of paths) { identities.push(fs.lstatSync(directory, { bigint: true })); }
    for (let index = 0; index < paths.length; index += 1) { verify(index); }
    child = spawn(process.execPath, process.argv.slice(1), { stdio: "inherit" });
    child.on("error", (error) => {
      childError = true;
      process.stderr.write("TOOLCHAIN_NODE_CHILD_ERROR code=" + error.code + "\n");
    });
    child.once("close", (status, signal) => {
      finish(status ?? (signal === null ? 1 : 128 + constants.signals[signal]));
    });
  } catch {
    finish(1);
  }
}

function wrapperPathGuard(lock, platform) {
  const pnpmHash = createHash("sha256").update(pnpmWrapper(lock, platform)).digest("hex");
  const hashCommand = platform === "darwin-arm64" ? "/usr/bin/shasum -a 256" : "/usr/bin/sha256sum";
  return `shopt -s dotglob nullglob
token_node_wrappers=("$token_node_tools_root/bin/"*)
shopt -u dotglob nullglob
for token_node_wrapper in "\${token_node_wrappers[@]}"; do
  case "\${token_node_wrapper##*/}" in
    node|pnpm) ;;
    *) printf '%s\\n' 'TOOLCHAIN_WRAPPER_DIRECTORY_UNAUTHENTICATED' >&2; exit 1 ;;
  esac
  if [[ ! -f "$token_node_wrapper" || -L "$token_node_wrapper" ]]; then
    printf '%s\\n' 'TOOLCHAIN_WRAPPER_DIRECTORY_UNAUTHENTICATED' >&2; exit 1
  fi
done
if [[ -e "$token_node_tools_root/bin/pnpm" ]]; then
  token_node_pnpm_hash=$(/usr/bin/env -i PATH=/usr/bin:/bin ${hashCommand} "$token_node_tools_root/bin/pnpm")
  if [[ "\${token_node_pnpm_hash%% *}" != '${pnpmHash}' ]]; then
    printf '%s\\n' 'TOOLCHAIN_WRAPPER_DIRECTORY_UNAUTHENTICATED' >&2; exit 1
  fi
fi
unset token_node_wrappers token_node_wrapper token_node_pnpm_hash`;
}


function executeVersionChecks(root, artifact, inventory) {
  return artifact.versionChecks.map((check) => {
    const actual = executeVerifiedFile({
      path: join(root, check.path), args: check.args,
      expectedSha256: inventory[check.path]?.sha256,
    });
    if (!new RegExp(check.pattern).test(actual)) {
      throw new Error(`version-mismatch:${check.name}:actual=${singleLine(actual)}`);
    }
    return `${check.name}=${singleLine(actual)}`;
  }).join(",");
}

function singleLine(value) {
  return String(value).replaceAll(/\s+/g, " ").trim();
}
