import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { SlitherGateError } from "../domain/model.ts";

export async function resolveDockerCli(inputPath: string): Promise<string> {
  if (!isAbsolute(inputPath)) {
    throw new SlitherGateError(
      "DOCKER_CLI_INVALID",
      "Docker CLI must be bound to an absolute path",
    );
  }

  try {
    const canonicalPath = await realpath(inputPath);
    const information = await stat(canonicalPath);
    if (!isAbsolute(canonicalPath) || !information.isFile() || (information.mode & 0o111) === 0) {
      throw new SlitherGateError(
        "DOCKER_CLI_INVALID",
        "Docker CLI must resolve to an executable regular file",
      );
    }
    // Same system-tool boundary as native-executable-custody: an unprivileged
    // peer must not be able to replace either the executable or an ancestor.
    let current = canonicalPath;
    for (;;) {
      const entry = await lstat(current);
      if (entry.uid !== 0 || (entry.mode & 0o022) !== 0 || entry.isSymbolicLink()
        || (current === canonicalPath ? !entry.isFile() : !entry.isDirectory())) {
        throw new SlitherGateError("DOCKER_CLI_INVALID", "Docker CLI requires root-owned non-writable system custody");
      }
      if (current === dirname(current)) { break; }
      current = dirname(current);
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof SlitherGateError) {
      throw error;
    }
    throw new SlitherGateError(
      "DOCKER_CLI_INVALID",
      "Docker CLI path is missing or cannot be validated",
    );
  }
}
