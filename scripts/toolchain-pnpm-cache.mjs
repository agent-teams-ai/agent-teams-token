import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertOwnedDirectoryChain } from "./toolchain-paths.mjs";

export function preparePnpmDirectory(path, kind) {
  assertOwnedDirectoryChain(path);
  try {mkdirSync(path, { mode: 0o700 });}
  catch (error) {if (error?.code !== "EEXIST") {throw error;}}
  assertOwnedDirectoryChain(path);
  const identity = lstatSync(path);
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || (identity.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && identity.uid !== process.getuid())) {
    throw new Error(`TOOLCHAIN_PNPM_${kind}_UNSAFE`);
  }
  return identity;
}

export function assertPnpmCacheTree(path) {
  const entry = lstatSync(path);
  if ((typeof process.getuid === "function" && entry.uid !== process.getuid())
    || (entry.isDirectory() ? (entry.mode & 0o777) !== 0o700
      : !entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600)) {
    throw new Error("TOOLCHAIN_PNPM_CACHE_UNSAFE");
  }
  if (entry.isDirectory()) {
    for (const leaf of readdirSync(path)) {assertPnpmCacheTree(join(path, leaf));}
  }
  const current = lstatSync(path);
  if (current.dev !== entry.dev || current.ino !== entry.ino || current.mode !== entry.mode
    || current.uid !== entry.uid || current.nlink !== entry.nlink) {
    throw new Error("TOOLCHAIN_PNPM_CACHE_UNSAFE");
  }
}

export function assertPnpmDirectoryIdentity(path, identity) {
  assertOwnedDirectoryChain(path);
  const current = lstatSync(path);
  if (current.dev !== identity.dev || current.ino !== identity.ino
    || current.mode !== identity.mode || current.uid !== identity.uid) {
    throw new Error("TOOLCHAIN_PNPM_CACHE_UNSAFE");
  }
}
