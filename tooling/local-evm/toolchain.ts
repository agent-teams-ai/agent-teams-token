import { join, resolve } from "node:path";
import { LocalEvmError } from "./model.ts";

export function pinnedSolcPath(repositoryRoot: string): string {
  const platform = process.platform === "linux" && process.arch === "x64" ? "linux-x64"
    : process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : undefined;
  if (!platform) {throw new LocalEvmError("LOCAL_EVM_PLATFORM_UNSUPPORTED", `unsupported local EVM platform ${process.platform}-${process.arch}`);}
  return resolve(join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`, "solc"));
}

export function assertPinnedSolcVersionOutput(output: string): string {
  const version = output.trim().split(/\r?\n/u).find((line) => line.startsWith("Version:")) ?? "";
  if (!/^Version: 0\.8\.36\+commit\.8a079791\.(?:Linux\.g\+\+|Darwin\.appleclang)$/u.test(version)) {
    throw new LocalEvmError("LOCAL_EVM_SOLC_VERSION_MISMATCH", "repository-pinned solc must be exactly 0.8.36+commit.8a079791");
  }
  return version;
}
