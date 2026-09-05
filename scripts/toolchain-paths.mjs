import { lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
  } catch (error) {
    if (error?.code === "ENOENT") {return;}
    throw new Error("TOOLCHAIN_DIRECTORY_IDENTITY_INVALID", { cause: error });
  }
}

function isTrustedAlias(current, platform) {
  return platform === "darwin"
    && ((current === "/var" && trustedAliasTarget(current, "/private/var"))
      || (current === "/tmp" && trustedAliasTarget(current, "/private/tmp")));
}

function isWithin(parent, child, allowEqual = false) {
  const value = relative(parent, child);
  return (allowEqual && value === "")
    || (value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function canonicalAlias(absolute, platform) {
  if (platform !== "darwin") {return;}
  for (const [alias, target] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]]) {
    if (isWithin(alias, absolute, true) && inspect(alias)?.isSymbolicLink() && trustedAliasTarget(alias, target)) {
      return target + absolute.slice(alias.length);
    }
  }
  return;
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

function isSharedTemporaryRoot(current, platform, st, uid) {
  return (current === "/tmp" || (platform === "darwin" && current === "/private/tmp"))
    && (st.uid === 0 || st.uid === uid)
    && (st.mode & 0o7777) === 0o1777;
}

function assertDirectoryIdentity(st, { sharedAncestor, temporaryRoot, uid }) {
  const writable = (st.mode & 0o022) !== 0;
  if (!st.isDirectory() || st.isSymbolicLink() || st.nlink < 1 || (writable && !temporaryRoot)) {
    throw new Error("TOOLCHAIN_DIRECTORY_IDENTITY_INVALID");
  }
  if (uid !== undefined && st.uid !== uid && !(sharedAncestor && st.uid === 0)) {
    throw new Error("TOOLCHAIN_DIRECTORY_OWNER_INVALID");
  }
}

// Only the leading shared prefix may belong to root. The requested directory
// is managed, and entering a caller-owned directory makes every descendant
// managed too. Callers check toolsRoot before downloads/install/bin/store/cache;
// checking a child must never re-admit root ownership inside that owned tree.
// Missing components are allowed only below an existing caller-owned directory.
export function assertOwnedDirectoryChain(path, { platform = process.platform, hostPlatform: hostOs } = {}) {
  platform = selectedPlatform(platform, hostOs);
  const absolute = canonicalizeTrustedPath(path, { platform });
  const [root, parts] = pathParts(absolute);
  const uid = process.getuid?.();
  let current = root;
  let ownedTree = false;
  for (const part of parts) {
    current = current === "/" ? "/" + part : join(current, part);
    const st = inspect(current);
    if (!st) {
      if (!ownedTree) {throw new Error("TOOLCHAIN_DIRECTORY_OWNER_INVALID");}
      continue;
    }
    const sharedAncestor = !ownedTree && current !== absolute;
    const temporaryRoot = current !== absolute && (!ownedTree || uid === 0)
      && isSharedTemporaryRoot(current, platform, st, uid);
    assertDirectoryIdentity(st, { sharedAncestor, temporaryRoot, uid });
    if (!temporaryRoot && st.uid === uid) {ownedTree = true;}
  }
}
