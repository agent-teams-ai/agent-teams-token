import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { assertOwnedDirectoryChain, canonicalizeTrustedPath } from "./toolchain-paths.mjs";

export function pnpmWrapper() {
  return "#!/bin/bash\n"
    + "set -euo pipefail\n"
    + "if [[ \"$#\" -eq 1 && \"$1\" == --version ]]; then printf '11.24.0\\n'; exit 0; fi\n"
    + "token_pnpm_script=${BASH_SOURCE[0]}\n"
    + "[[ \"$token_pnpm_script\" == */* ]] || token_pnpm_script=\"./$token_pnpm_script\"\n"
    + "token_pnpm_tools_root=$(CDPATH= cd -P -- \"${token_pnpm_script%/*}/..\" && pwd -P)\n"
    + "token_pnpm_repo_root=$(CDPATH= cd -P -- \"$token_pnpm_tools_root/..\" && pwd -P)\n"
    + "exec \"$token_pnpm_repo_root/scripts/bootstrap.sh\" run-pnpm \"$@\"\n";
}

function sameIdentity(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function assertStableFile(fd, path) {
  const identity = fstatSync(fd);
  const current = lstatSync(path);
  if (!identity.isFile() || identity.nlink !== 1 || current.nlink !== 1 || !sameIdentity(identity, current)) {
    throw new Error("TOOLCHAIN_PNPM_WRAPPER_IDENTITY_INVALID");
  }
  return identity;
}

function readStableFile(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const contents = readFileSync(fd, "utf8");
    assertStableFile(fd, path);
    return contents;
  } finally {
    closeSync(fd);
  }
}

export function writePnpmWrapper({ toolsRoot, hostPlatform: host = process.platform }) {
  toolsRoot = canonicalizeTrustedPath(toolsRoot, { platform: host });
  const bin = join(toolsRoot, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  assertOwnedDirectoryChain(bin, { platform: host });
  const target = join(bin, "pnpm");
  const part = `${target}.part`;
  if (existsSync(part)) {
    const stale = lstatSync(part);
    if (!stale.isFile() || stale.nlink !== 1) {throw new Error("TOOLCHAIN_PNPM_WRAPPER_PART_UNSAFE");}
    rmSync(part);
  }
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  const fd = openSync(part, flags, 0o700);
  try {
    writeSync(fd, pnpmWrapper());
    const identity = assertStableFile(fd, part);
    renameSync(part, target);
    const published = lstatSync(target);
    if (!sameIdentity(identity, published) || published.nlink !== 1) {
      throw new Error("TOOLCHAIN_PNPM_WRAPPER_IDENTITY_INVALID");
    }
  } finally {
    closeSync(fd);
  }
  if (readStableFile(target) !== pnpmWrapper()) {
    throw new Error("TOOLCHAIN_PNPM_WRAPPER_IDENTITY_INVALID");
  }
}
