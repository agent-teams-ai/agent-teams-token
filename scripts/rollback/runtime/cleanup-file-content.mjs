import { createHash } from "node:crypto";
import { constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

import { useCustodyDescriptor } from "./custody.mjs";

// Each pass is bounded by the captured size and uses a fixed-size buffer.
// A second pass detects a changing read view even when metadata appears stable.
export function cleanupFileContentSha256(identity, path, identityFields) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error("ROLLBACK_CLEANUP_FILE_NOFOLLOW_UNAVAILABLE");
  }
  if (!Number.isInteger(constants.O_NONBLOCK)) {
    throw new Error("ROLLBACK_CLEANUP_FILE_NONBLOCK_UNAVAILABLE");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  return useCustodyDescriptor(descriptor, "ROLLBACK_CLEANUP_FILE_CLOSE_FAILED", () => {
    const assertStable = () => {
      const held = fstatSync(descriptor, { bigint: true });
      const named = lstatSync(path, { bigint: true });
      if (!held.isFile() || !named.isFile() || identityFields.some(
        (field) => held[field] !== identity[field] || named[field] !== identity[field],
      )) {
        throw new Error("ROLLBACK_CLEANUP_FILE_CHANGED");
      }
    };
    const digest = () => {
      assertStable();
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const read = (length, position) => {
        try {
          return readSync(descriptor, buffer, 0, length, position);
        } catch (error) {
          throw new Error("ROLLBACK_CLEANUP_FILE_READ_FAILED", { cause: error });
        }
      };
      let position = 0n;
      while (position < identity.size) {
        const remaining = identity.size - position;
        const length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
        const count = read(length, position);
        if (count <= 0) {
          throw new Error("ROLLBACK_CLEANUP_FILE_CHANGED");
        }
        hash.update(buffer.subarray(0, count));
        position += BigInt(count);
      }
      // Probe once at the captured EOF; never chase a growing file.
      if (read(1, identity.size) !== 0) {
        throw new Error("ROLLBACK_CLEANUP_FILE_CHANGED");
      }
      assertStable();
      return hash.digest("hex");
    };
    const first = digest();
    if (first !== digest()) {
      throw new Error("ROLLBACK_CLEANUP_FILE_CHANGED");
    }
    return first;
  });
}
