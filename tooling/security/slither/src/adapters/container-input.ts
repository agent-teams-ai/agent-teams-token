import type { ScratchCustody } from "./scratch-custody.ts";
import { chmod, constants, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SlitherGateError } from "../domain/model.ts";

export async function readStableRegularFile(path: string, label: string): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new SlitherGateError("INPUT_HASH_MISMATCH", `pinned input is not an unlinked regular file: ${label}`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1n) {
      throw new SlitherGateError("INPUT_HASH_MISMATCH", `pinned input changed while reading: ${label}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.nlink !== 1n) {
      throw new SlitherGateError("INPUT_HASH_MISMATCH", `pinned input changed while reading: ${label}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

export async function ensureContainerReadableDirectory(
  root: string,
  relativePath: string,
  custody?: ScratchCustody,
): Promise<void> {
  let current = root;
  for (const part of relativePath.split("/").filter((value) => value !== ".")) {
    if (!/^[A-Za-z0-9._-]+$/u.test(part) || part === "..") {
      throw unsafeInput();
    }
    current = join(current, part);
    if (custody) { await custody.directory(current); continue; }
    await mkdir(current, { mode: 0o700 }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EEXIST") { throw cause; }
    });
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(current) !== current) {
      throw unsafeInput();
    }
    await chmod(current, 0o755);
  }
}

export async function writeContainerReadableFile(
  path: string,
  content: Uint8Array | string,
  custody?: ScratchCustody,
): Promise<void> {
  await custody?.assert(dirname(path));
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await custody?.file(path, handle);
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(0o444);
    await handle.sync();
    const entry = await handle.stat({ bigint: true });
    if (!entry.isFile() || entry.nlink !== 1n || (entry.mode & 0o777n) !== 0o444n) {
      throw unsafeInput();
    }
  } finally {
    await handle.close();
  }
}

function unsafeInput(): SlitherGateError {
  return new SlitherGateError("INPUT_HASH_MISMATCH", "container input path is unsafe");
}
