import { lstat, rename } from "node:fs/promises";
import { join } from "node:path";
import { after } from "node:test";
import {
  createNativeNoReplaceCapability,
  type NativeNoReplaceCapability,
} from "../../src/adapters/native-no-replace.ts";
import type { NoReplaceRenameRequest } from "../../src/adapters/safe-output.ts";

let darwinCapabilityPromise: Promise<NativeNoReplaceCapability> | undefined;

after(async () => {
  const pendingCapability = darwinCapabilityPromise;
  if (pendingCapability === undefined) { return; }
  let capability: NativeNoReplaceCapability;
  try {
    capability = await pendingCapability;
  } catch {
    return;
  }
  await capability.close();
});

/** Deterministic test-only no-replace directory rename stand-in. */
export async function testOnlyNoReplaceDirectoryRename(request: NoReplaceRenameRequest): Promise<void> {
  if (process.platform === "darwin") {
    darwinCapabilityPromise ??= createNativeNoReplaceCapability();
    const capability = await darwinCapabilityPromise;
    await capability.rename(request);
    return;
  }

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
