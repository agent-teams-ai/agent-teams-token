import { lstat, rename } from "node:fs/promises";
import { join } from "node:path";
import type { NoReplaceRenameRequest } from "../../src/adapters/safe-output.ts";

/** Deterministic test-only no-replace directory rename stand-in. */
export async function testOnlyNoReplaceDirectoryRename(request: NoReplaceRenameRequest): Promise<void> {
  const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const source = join(fdRoot, String(request.sourceParent.fd), request.sourceLeaf);
  const target = join(fdRoot, String(request.destinationParent.fd), request.destinationLeaf);
  try {
    await lstat(target);
    const error = new Error("target already exists") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
  }
  await rename(source, target);
}
