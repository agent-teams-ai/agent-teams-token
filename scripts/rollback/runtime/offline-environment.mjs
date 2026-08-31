import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { basicRun, gitExecutable } from "./candidate.mjs";
import { sha256 } from "./common.mjs";
import { allowlistedChildEnvironment } from "../../toolchain-environment.mjs";

const SHA_256 = /^[a-f0-9]{64}$/u;

export function copyAndInstallOfflineEnvironment({
  sourceRoot,
  checkout,
  recorder,
  group,
}) {
  const platform = platformId();
  const lock = JSON.parse(readFileSync(join(sourceRoot, "tooling/toolchain.lock.json"), "utf8"));
  const archives = requiredArchives(lock, platform);
  const downloads = join(checkout, ".tools", "downloads");
  mkdirSync(downloads, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const artifact of archives) {
    const source = join(sourceRoot, ".tools", "downloads", artifact.archiveName);
    let entry;
    try {
      entry = lstatSync(source);
    } catch {
      throw new Error("ROLLBACK_TOOLCHAIN_CACHE_UNAVAILABLE archive=" + artifact.archiveName);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("ROLLBACK_TOOLCHAIN_CACHE_UNSAFE archive=" + artifact.archiveName);
    }
    const bytes = readFileSync(source);
    const digest = sha256(bytes);
    if (digest !== artifact.sha256) {
      throw new Error(
        "ROLLBACK_TOOLCHAIN_CACHE_HASH archive=" + artifact.archiveName
        + " expected=" + artifact.sha256 + " actual=" + digest,
      );
    }
    const destination = join(downloads, artifact.archiveName);
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o600);
    copied.push({ archiveName: artifact.archiveName, byteLength: bytes.length, sha256: digest });
  }
  const bootstrapEnvironment = allowlistedChildEnvironment(process.env, {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/lib/git-core",
  });
  recorder.run(group, "bootstrap-core-install", "/bin/bash", ["./dev", "bootstrap", "install", "--offline"], {
    cwd: checkout,
    env: bootstrapEnvironment,
    timeout: 600_000,
  });
  recorder.run(group, "bootstrap-solana-install", "/bin/bash", [
    "./dev", "bootstrap", "install", "--offline", "--scope=solana",
  ], { cwd: checkout, env: bootstrapEnvironment, timeout: 600_000 });
  recorder.run(group, "bootstrap-core-verify", "/bin/bash", ["./dev", "bootstrap", "verify", "--offline"], {
    cwd: checkout,
    env: bootstrapEnvironment,
    timeout: 600_000,
  });
  recorder.run(group, "bootstrap-solana-verify", "/bin/bash", [
    "./dev", "bootstrap", "verify", "--offline", "--scope=solana",
  ], { cwd: checkout, env: bootstrapEnvironment, timeout: 600_000 });
  const tools = strictToolPaths(checkout, { platform, requireSolana: true, requireDocker: false });
  const commandEnvironment = allowlistedChildEnvironment(process.env, { PATH: toolPath(tools) });
  const storeResult = recorder.run(group, "pnpm-store-path", tools.pnpm, ["store", "path", "--silent"], {
    cwd: checkout,
    env: commandEnvironment,
    timeout: 30_000,
  });
  const requestedStore = storeResult.stdout.trim();
  let store;
  try {
    store = realpathSync(requestedStore);
  } catch {
    throw new Error("ROLLBACK_PNPM_STORE_UNAVAILABLE path=" + requestedStore);
  }
  const storeEntry = lstatSync(store);
  if (!storeEntry.isDirectory() || storeEntry.isSymbolicLink()) {
    throw new Error("ROLLBACK_PNPM_STORE_UNSAFE path=" + store);
  }
  recorder.run(
    group,
    "pnpm-frozen-offline-install",
    tools.pnpm,
    pnpmOfflineInstallArguments(store),
    { cwd: checkout, env: commandEnvironment, timeout: 600_000 },
  );
  const links = recorder.stage(
    group,
    "pnpm-workspace-link-validation",
    () => validatePnpmWorkspaceLinks(checkout),
    (value) => ({ linkCount: value.length }),
  );
  return { platform, tools, store, copiedArchives: copied, workspaceLinks: links };
}

export function pnpmOfflineInstallArguments(store) {
  if (!isAbsolute(store)) {
    throw new Error("ROLLBACK_PNPM_STORE_NOT_ABSOLUTE path=" + store);
  }
  return [
    "install",
    "--offline",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--package-import-method=copy",
    "--store-dir=" + store,
  ];
}

export function validatePnpmWorkspaceLinks(root, packageJsonPaths) {
  const git = gitExecutable();
  const paths = packageJsonPaths ?? basicRun(git, ["ls-files", "-z", "*package.json"], { cwd: root })
    .split("\0").filter(Boolean);
  const rootReal = realpathSync(root);
  const packageDocuments = new Map(paths.map((packagePath) => [
    packagePath,
    JSON.parse(readFileSync(join(root, packagePath), "utf8")),
  ]));
  const workspacePackages = workspacePackageRoots(root, packageDocuments);
  const virtualStore = join(rootReal, "node_modules", ".pnpm");
  const virtualStoreReal = validateVirtualStore(virtualStore);
  const links = [];
  for (const packagePath of paths) {
    const document = packageDocuments.get(packagePath);
    const dependencies = {
      ...document.dependencies,
      ...document.devDependencies,
      ...document.optionalDependencies,
    };
    const packageRoot = dirname(join(root, packagePath));
    for (const name of Object.keys(dependencies).toSorted()) {
      links.push(validatePnpmLink({
        dependencies,
        name,
        packagePath,
        packageRoot,
        rootReal,
        virtualStoreReal,
        workspacePackages,
      }));
    }
  }
  assertRequiredWorkspaceLinks(paths, links);
  return links;
}

function workspacePackageRoots(root, packageDocuments) {
  const roots = new Map();
  for (const [packagePath, document] of packageDocuments) {
    if (typeof document.name === "string") {
      roots.set(document.name, realpathSync(dirname(join(root, packagePath))));
    }
  }
  return roots;
}

function validateVirtualStore(virtualStore) {
  let entry;
  try {
    entry = lstatSync(virtualStore);
  } catch (error) {
    throw new Error("ROLLBACK_PNPM_VIRTUAL_STORE_UNAVAILABLE path=" + virtualStore, {
      cause: error,
    });
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("ROLLBACK_PNPM_VIRTUAL_STORE_UNSAFE path=" + virtualStore);
  }
  return realpathSync(virtualStore);
}

function validatePnpmLink(context) {
  const { name, packagePath, packageRoot, rootReal } = context;
  const link = join(packageRoot, "node_modules", ...name.split("/"));
  const entry = readPnpmLink(link, packagePath, name);
  if (!entry.isSymbolicLink()) {
    throw new Error("ROLLBACK_PNPM_LINK_NOT_ISOLATED package=" + packagePath + " dependency=" + name);
  }
  const target = realpathSync(link);
  const targetRelative = relative(rootReal, target);
  if (escapesDirectory(targetRelative, true)) {
    throw new Error("ROLLBACK_PNPM_LINK_ESCAPES_CHECKOUT package=" + packagePath + " dependency=" + name);
  }
  assertPnpmLinkTarget(context, target);
  return { package: packagePath, dependency: name, target: targetRelative };
}

function readPnpmLink(link, packagePath, name) {
  try {
    return lstatSync(link);
  } catch {
    throw new Error("ROLLBACK_PNPM_LINK_MISSING package=" + packagePath + " dependency=" + name);
  }
}

function assertPnpmLinkTarget(context, target) {
  const { dependencies, name, packagePath, virtualStoreReal, workspacePackages } = context;
  const specification = dependencies[name];
  if (typeof specification === "string" && specification.startsWith("workspace:")) {
    const expectedWorkspace = workspacePackages.get(name);
    if (expectedWorkspace === undefined || target !== expectedWorkspace) {
      throw new Error(
        "ROLLBACK_PNPM_WORKSPACE_LINK_TARGET package=" + packagePath + " dependency=" + name,
      );
    }
    return;
  }
  const virtualRelative = relative(virtualStoreReal, target);
  if (escapesDirectory(virtualRelative, false)) {
    throw new Error(
      "ROLLBACK_PNPM_EXTERNAL_LINK_TARGET package=" + packagePath + " dependency=" + name,
    );
  }
  assertPnpmTargetManifest(target, packagePath, name);
}

function escapesDirectory(path, allowRoot) {
  return path === ".." || path.startsWith(".." + sep) || (!allowRoot && path === "");
}

function assertPnpmTargetManifest(target, packagePath, name) {
  let targetDocument;
  try {
    const targetManifest = join(target, "package.json");
    const entry = lstatSync(targetManifest);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("unsafe target manifest");
    }
    targetDocument = JSON.parse(readFileSync(targetManifest, "utf8"));
  } catch (error) {
    throw new Error(
      "ROLLBACK_PNPM_TARGET_IDENTITY_UNAVAILABLE package=" + packagePath + " dependency=" + name,
      { cause: error },
    );
  }
  if (targetDocument.name !== name) {
    throw new Error(
      "ROLLBACK_PNPM_TARGET_IDENTITY_MISMATCH package=" + packagePath + " dependency=" + name,
    );
  }
}

function assertRequiredWorkspaceLinks(paths, links) {
  for (const [packagePath, dependency] of [
    ["packages/contexts/supply/package.json", "@noble/hashes"],
    ["packages/contexts/supply/package.json", "yaml"],
  ]) {
    if (paths.includes(packagePath)
      && !links.some((link) => link.package === packagePath && link.dependency === dependency)) {
      throw new Error("ROLLBACK_PNPM_REQUIRED_WORKSPACE_LINK_MISSING dependency=" + dependency);
    }
  }
}

export function strictToolPaths(root, {
  platform = platformId(),
  requireSolana = false,
  requireDocker = false,
  dockerPath = process.env.SLITHER_DOCKER_PATH ?? "/usr/bin/docker",
} = {}) {
  const paths = {
    node: join(root, ".tools", "node-v24.20.0-" + platform, "bin", "node"),
    pnpm: join(root, ".tools", "bin", "pnpm"),
    forge: join(root, ".tools", "foundry-v1.8.0-" + platform, "forge"),
    cast: join(root, ".tools", "foundry-v1.8.0-" + platform, "cast"),
    anvil: join(root, ".tools", "foundry-v1.8.0-" + platform, "anvil"),
    solc: join(root, ".tools", "solc-v0.8.36-" + platform, "solc"),
  };
  if (requireSolana) {
    for (const name of ["solana", "solana-keygen", "solana-test-validator", "spl-token"]) {
      paths[name] = join(root, ".tools", "agave-v4.2.1-" + platform, "bin", name);
    }
  }
  if (requireDocker) {
    paths.docker = dockerPath;
  }
  for (const [name, path] of Object.entries(paths)) {
    assertExecutable(path, name);
  }
  return paths;
}

export function toolPath(tools) {
  const directories = [
    dirname(tools.node),
    dirname(tools.forge),
    dirname(tools.solc),
    dirname(tools.pnpm),
  ];
  if (tools.solana !== undefined) {
    directories.push(dirname(tools.solana));
  }
  return [...new Set(directories), "/usr/local/bin", "/usr/bin", "/bin", "/usr/lib/git-core"].join(":");
}

export function platformId() {
  if (process.platform === "linux" && process.arch === "x64") {
    return "linux-x64";
  }
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "darwin-arm64";
  }
  throw new Error("ROLLBACK_PLATFORM_UNSUPPORTED platform=" + process.platform + "-" + process.arch);
}

function requiredArchives(lock, platform) {
  const artifacts = [];
  for (const name of ["node", "foundry", "solc"]) {
    artifacts.push(lock.tools[name]?.platforms?.[platform]);
  }
  artifacts.push(lock.tools.pnpm);
  artifacts.push(lock.tools.agave?.platforms?.[platform]);
  for (const artifact of artifacts) {
    if (typeof artifact?.archiveName !== "string" || !SHA_256.test(artifact.sha256 ?? "")) {
      throw new Error("ROLLBACK_TOOLCHAIN_LOCK_INVALID platform=" + platform);
    }
  }
  return artifacts;
}

function assertExecutable(path, name) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    throw new Error("ROLLBACK_STRICT_BINARY_MISSING binary=" + name + " path=" + path);
  }
  if (!entry.isFile() || entry.isSymbolicLink() || realpathSync(path) !== path
    || (statSync(path).mode & 0o111) === 0) {
    throw new Error("ROLLBACK_STRICT_BINARY_UNSAFE binary=" + name + " path=" + path);
  }
}
