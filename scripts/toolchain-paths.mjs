import { lstatSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

function selectedPlatform(platform, hostOs) {
  return hostOs ?? platform;
}

function pathParts(absolute) {
  const parts = absolute.split("/");
  return [parts[0] === "" ? "/" : parts[0], parts.slice(parts[0] === "" ? 1 : 0)];
}

function trustedAliasTarget(alias, target) {
  const link = readlinkSync(alias);
  return link === target || link === target.slice(1);
}

function inspect(path) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function isTrustedAlias(current, platform) {
  return platform === "darwin"
    && ((current === "/var" && trustedAliasTarget(current, "/private/var"))
      || (current === "/tmp" && trustedAliasTarget(current, "/private/tmp")));
}

function canonicalAlias(absolute, platform) {
  if (platform !== "darwin") return undefined;
  for (const [alias, target] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]]) {
    const matchesAlias = absolute === alias || absolute.startsWith(alias + "/");
    if (matchesAlias && inspect(alias)?.isSymbolicLink() && trustedAliasTarget(alias, target)) {
      return target + absolute.slice(alias.length);
    }
  }
  return undefined;
}

export function canonicalizeTrustedPath(path, { platform = process.platform, hostPlatform: hostOs } = {}) {
  platform = selectedPlatform(platform, hostOs);
  const absolute = resolve(path);
  const [root, parts] = pathParts(absolute);
  let current = root;
  for (const part of parts) {
    current = current === "/" ? "/" + part : join(current, part);
    const st = inspect(current);
    if (st?.isSymbolicLink() && !isTrustedAlias(current, platform)) {
      throw new Error("TOOLCHAIN_DIRECTORY_IDENTITY_INVALID");
    }
  }
  return canonicalAlias(absolute, platform) ?? absolute;
}

function isMacTempHierarchyAncestor(current, managedPath, st) {
  return current.startsWith("/private/var/folders/")
    && current !== managedPath
    && st.uid === 0
    && (st.mode & 0o022) === 0;
}

function trustedSystemAncestor(current, absolute, platform, st) {
  const known = ["/private", "/private/var", "/private/var/folders", "/private/tmp"];
  return platform === "darwin"
    && (known.includes(current) || isMacTempHierarchyAncestor(current, absolute, st));
}

function assertDirectoryIdentity(current, absolute, platform, st) {
  const system = trustedSystemAncestor(current, absolute, platform, st);
  const temp = current === "/tmp";
  const writable = (st.mode & 0o022) !== 0;
  if (!st.isDirectory() || st.isSymbolicLink() || st.nlink < 1 || (writable && !system && !temp)) {
    throw new Error("TOOLCHAIN_DIRECTORY_IDENTITY_INVALID");
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid() && current !== "/" && !system) {
    throw new Error("TOOLCHAIN_DIRECTORY_OWNER_INVALID");
  }
}

export function assertOwnedDirectoryChain(path, { platform = process.platform, hostPlatform: hostOs } = {}) {
  platform = selectedPlatform(platform, hostOs);
  const absolute = canonicalizeTrustedPath(path, { platform });
  const [root, parts] = pathParts(absolute);
  let current = root;
  for (const part of parts) {
    current = current === "/" ? "/" + part : join(current, part);
    const st = inspect(current);
    if (st) assertDirectoryIdentity(current, absolute, platform, st);
  }
}
