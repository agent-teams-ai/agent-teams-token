import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
