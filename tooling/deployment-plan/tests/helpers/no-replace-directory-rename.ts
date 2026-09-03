import { lstat, rename } from "node:fs/promises";

/** Deterministic test-only no-replace directory rename stand-in. */
export async function testOnlyNoReplaceDirectoryRename(source: string, target: string): Promise<void> {
  try {
    await lstat(target);
    const error = new Error("target already exists") as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(source, target);
}
