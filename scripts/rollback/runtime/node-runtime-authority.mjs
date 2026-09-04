import { constants, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function assertSupportedRuntimePlatform(platform) {
  if (platform === "darwin-arm64") {
    throw new Error(
      "ROLLBACK_RUNTIME_LOADED_IMAGE_BINDING_UNAVAILABLE platform=darwin-arm64",
    );
  }
  if (platform !== "linux-x64") {
    throw new Error("ROLLBACK_RUNTIME_PLATFORM_UNSUPPORTED platform=" + platform);
  }
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw new Error("ROLLBACK_RUNTIME_NOFOLLOW_UNAVAILABLE platform=" + platform);
  }
}

export function assertRuntimeExecutablePath(node, expectedExecutable) {
  if (process.version !== "v" + node.version) {
    throw new Error(
      "ROLLBACK_RUNTIME_VERSION_MISMATCH expected=v" + node.version
      + " actual=" + process.version,
    );
  }
  let actualRealpath;
  try {
    actualRealpath = realpathSync(process.execPath);
  } catch (error) {
    throw new Error("ROLLBACK_RUNTIME_EXEC_PATH_UNSAFE path=" + process.execPath, { cause: error });
  }
  if (!isAbsolute(process.execPath) || resolve(process.execPath) !== expectedExecutable
    || actualRealpath !== expectedExecutable) {
    throw new Error(
      "ROLLBACK_RUNTIME_EXEC_PATH_MISMATCH expected=" + expectedExecutable
      + " actual=" + process.execPath + " realpath=" + actualRealpath,
    );
  }
}
