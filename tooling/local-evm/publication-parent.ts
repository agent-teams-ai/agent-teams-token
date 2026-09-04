import { constants, lstat, open, realpath } from "node:fs/promises";
import { LocalEvmError } from "./model.ts";

/** Holds the directory alive while publishing; content metadata may change. */
export async function holdPublicationParent(path: string): Promise<{
  assertReady(): Promise<void>;
  close(): Promise<void>;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const expected = await handle.stat({bigint: true});
    const owner = process.getuid?.();
    if (!expected.isDirectory() || (expected.mode & 0o077n) !== 0n
      || (owner !== undefined && expected.uid !== BigInt(owner))) {
      throw new LocalEvmError("LOCAL_EVM_PUBLICATION_PARENT_INVALID", "publication parent must be a private owned directory");
    }
    const capability = {
      async assertReady(): Promise<void> {
        const held = await handle.stat({bigint: true});
        const named = await lstat(path, {bigint: true});
        if (await realpath(path) !== path || !named.isDirectory()
          || [held, named].some((stat) => stat.dev !== expected.dev
            || stat.ino !== expected.ino || stat.uid !== expected.uid
            || stat.gid !== expected.gid || stat.mode !== expected.mode)) {
          throw new LocalEvmError("LOCAL_EVM_PUBLICATION_PARENT_CHANGED", "publication parent identity changed");
        }
      },
      async close(): Promise<void> {await handle.close();},
    };
    await capability.assertReady();
    return capability;
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}
