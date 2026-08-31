import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  inspectInstallationInventory,
  prepareVerifiedPayload,
  provenanceFile,
} from "./toolchain-archive.mjs";

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
    provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  } catch {
    return "provenance-invalid";
  }
  if (
    provenance.schemaVersion !== 2
    || provenance.tool !== name
    || provenance.version !== tool.version
    || provenance.platform !== platform
    || provenance.artifactSha256 !== artifact.sha256
    || provenance.inventorySha256 !== prepared.inventorySha256
    || JSON.stringify(provenance.files) !== JSON.stringify(prepared.files)
  ) {
    return "provenance-mismatch";
  }
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
    if (prepared !== undefined) {rmSync(prepared.stageRoot, { recursive: true, force: true });}
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

function inspectPreparedInstallation(args) {
  const authority = inspectAuthority(args);
  if (!authority.ok) {return authority;}
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
    if (derived !== undefined) {rmSync(derived.stageRoot, { recursive: true, force: true });}
  }
}

export function installPreparedArtifact({ name, tool, artifact, prepared, destination, platform, toolsRoot, lock }) {
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
  atomicPublish({ name, tool, artifact, prepared, destination, platform, toolsRoot, lock });
}

function atomicPublish({ name, tool, artifact, prepared, destination, platform, toolsRoot, lock }) {
  let backup;
  writeFileSync(join(prepared.source, provenanceFile), `${JSON.stringify({
    schemaVersion: 2,
    tool: name,
    version: tool.version,
    platform,
    artifactSha256: artifact.sha256,
    inventorySha256: prepared.inventorySha256,
    files: prepared.files,
  }, null, 2)}\n`, { mode: 0o644 });
  try {
    if (existsSync(destination)) {
      backup = `${destination}.replace-${process.pid}-${Date.now()}`;
      renameSync(destination, backup);
    }
    renameSync(prepared.source, destination);
    if (name === "pnpm") {writePnpmWrapper({ lock, toolsRoot, platform });}
    if (backup) {rmSync(backup, { force: true, recursive: true });}
  } catch (error) {
    if (existsSync(destination)) {rmSync(destination, { force: true, recursive: true });}
    if (backup && !existsSync(destination)) {renameSync(backup, destination);}
    throw error;
  }
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
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", COREPACK_ENABLE_PROJECT_SPEC: "0" },
    timeout: 15_000,
  }).trim();
  if (actual !== tool.version) {throw new Error(`pnpm-version-mismatch:actual=${singleLine(actual)}`);}
  return `pnpm=${actual}`;
}

function pnpmWrapper(lock, platform) {
  const nodeDirectory = lock.tools.node.platforms[platform].installDirectory;
  const pnpmDirectory = lock.tools.pnpm.installDirectory;
  return `#!/bin/bash\nset -euo pipefail\ntoken_pnpm_source=\${BASH_SOURCE[0]}\nif [[ "$token_pnpm_source" == */* ]]; then\n  token_pnpm_directory=\${token_pnpm_source%/*}\n  [[ -n "$token_pnpm_directory" ]] || token_pnpm_directory=/\nelse\n  token_pnpm_directory=.\nfi\ntoken_pnpm_tools_root=$(CDPATH= cd -- "$token_pnpm_directory/.." && pwd -P)\nunset token_pnpm_source token_pnpm_directory\nexport COREPACK_ENABLE_DOWNLOAD_PROMPT=0\nexport COREPACK_ENABLE_PROJECT_SPEC=0\nexec "$token_pnpm_tools_root/${nodeDirectory}/bin/node" "$token_pnpm_tools_root/${pnpmDirectory}/bin/pnpm.cjs" --config.auto-install-peers=false --config.verify-deps-before-run=false "$@"\n`;
}

function writePnpmWrapper({ lock, toolsRoot, platform }) {
  const bin = join(toolsRoot, "bin");
  const target = join(bin, "pnpm");
  const part = `${target}.part`;
  mkdirSync(bin, { recursive: true });
  rmSync(part, { force: true });
  writeFileSync(part, pnpmWrapper(lock, platform), { mode: 0o755 });
  chmodSync(part, 0o755);
  renameSync(part, target);
}

function executeVersionChecks(root, artifact) {
  return artifact.versionChecks.map((check) => {
    const actual = execFileSync(join(root, check.path), check.args, {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
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
