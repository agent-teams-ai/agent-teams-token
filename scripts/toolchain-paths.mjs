import { lstatSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

export function canonicalizeTrustedPath(path, { platform = process.platform, hostPlatform: hostOs } = {}) {
  platform = hostOs ?? platform;
  const absolute = resolve(path);
  const parts = absolute.split("/"); let current = parts[0] === "" ? "/" : parts[0];
  for (const part of parts.slice(parts[0] === "" ? 1 : 0)) {
    current = current === "/" ? `/${part}` : join(current, part);
    let st; try { st = lstatSync(current); } catch { continue; }
    if (!st.isSymbolicLink()) {continue;}
    const allowed = platform === "darwin" && ((current === "/var" && trustedAliasTarget(current, "/private/var")) || (current === "/tmp" && trustedAliasTarget(current, "/private/tmp")));
    if (!allowed) {throw new Error("TOOLCHAIN_DIRECTORY_IDENTITY_INVALID");}
  }
  if (platform === "darwin") {
    for (const [alias, target] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]]) {
      if (absolute === alias || absolute.startsWith(`${alias}/`)) {
        try { if (lstatSync(alias).isSymbolicLink() && trustedAliasTarget(alias, target)) {return `${target}${absolute.slice(alias.length)}`;} } catch { /* unresolved roots remain lexical */ }
      }
    }
  }
  return absolute;
}

function trustedAliasTarget(alias, target) {
  const link = readlinkSync(alias);
  return link === target || link === target.slice(1);
}

export function assertOwnedDirectoryChain(path, { platform = process.platform, hostPlatform: hostOs } = {}) {
  platform = hostOs ?? platform;
  const absolute = canonicalizeTrustedPath(path, { platform }); const parts = absolute.split("/"); let current = parts[0] === "" ? "/" : parts[0];
  for (const part of parts.slice(parts[0] === "" ? 1 : 0)) {
    current = current === "/" ? `/${part}` : join(current, part);
    let st; try { st = lstatSync(current); } catch { continue; }
    const trustedSystemAncestor = platform === "darwin" && (
      ["/private", "/private/var", "/private/var/folders", "/private/tmp"].includes(current)
      || isMacTempHierarchyAncestor(current, absolute, st)
    );
    const trustedTempAncestor = current === "/tmp";
    if (!st.isDirectory() || st.isSymbolicLink() || st.nlink < 1 || ((st.mode & 0o022) !== 0 && !trustedSystemAncestor && !trustedTempAncestor)) {throw new Error("TOOLCHAIN_DIRECTORY_IDENTITY_INVALID");}
    if (typeof process.getuid === "function" && st.uid !== process.getuid() && current !== "/" && !trustedSystemAncestor) {throw new Error("TOOLCHAIN_DIRECTORY_OWNER_INVALID");}
  }
}

// macOS creates root-owned, non-writable namespace components below
// /private/var/folders (for example the two-character bucket). They are
// trusted only as strict ancestors: the managed root itself, and everything
// below it, must remain process-owned and private.
function isMacTempHierarchyAncestor(current, managedPath, st) {
  return current.startsWith("/private/var/folders/")
    && current !== managedPath
    && st.uid === 0
    && (st.mode & 0o022) === 0;
}
