import { createHash } from "node:crypto";
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync,
} from "node:fs";

export function readVerifiedBytes(path, { maximumBytes } = {}) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = checkedRegularDescriptor(fd);
    if (!Number.isSafeInteger(before.size)
      || (maximumBytes !== undefined && before.size > maximumBytes)) {
      throw new Error("TOOLCHAIN_JSON_LIMIT_BYTES");
    }
    const bytes = readDescriptorBytes(fd, before.size);
    const after = checkedRegularDescriptor(fd);
    const pathStat = lstatSync(path);
    if (!sameIdentity(before, after) || !sameIdentity(before, pathStat) || pathStat.nlink !== 1) {
      throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");
    }
    return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    closeSync(fd);
  }
}

export function checkedRegularDescriptor(fd) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) { throw new Error("TOOLCHAIN_FILE_IDENTITY_INVALID"); }
  return stat;
}

function readDescriptorBytes(fd, size = checkedRegularDescriptor(fd).size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) { throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED"); }
    offset += count;
  }
  return bytes;
}

export function hashDescriptor(fd) {
  const before = checkedRegularDescriptor(fd);
  const bytes = readDescriptorBytes(fd, before.size);
  const after = checkedRegularDescriptor(fd);
  if (!sameIdentity(before, after) || before.size !== after.size) {
    throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function sameIdentity(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}
