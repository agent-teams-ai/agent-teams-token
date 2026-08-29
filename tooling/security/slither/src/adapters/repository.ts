import type { ProcessPort, RepositoryStatePort } from "../application/ports.ts";
import { SlitherGateError } from "../domain/model.ts";

export class GitRepositoryState implements RepositoryStatePort {
  private readonly root: string;
  private readonly processPort: ProcessPort;
  constructor(root: string, processPort: ProcessPort) {
    this.root = root;
    this.processPort = processPort;
  }

  async assertExactClean(candidateSha: string): Promise<void> {
    const head = await this.git(["rev-parse", "HEAD"]);
    if (head.trim() !== candidateSha) {
      throw new SlitherGateError(
        "CANDIDATE_SHA_MISMATCH",
        "candidate SHA does not equal the checked-out HEAD",
      );
    }
    const status = await this.git([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]);
    if (status.length !== 0) {
      throw new SlitherGateError(
        "WORKTREE_NOT_CLEAN",
        "tracked, staged or non-ignored untracked changes are forbidden",
      );
    }
  }

  async trackedProductionSources(): Promise<readonly string[]> {
    const raw = await this.git(["ls-files", "-z", "--", "contracts/evm/src"]);
    return raw.split("\0").filter((path) => path.endsWith(".sol")).toSorted();
  }

  private async git(args: readonly string[]): Promise<string> {
    const result = await this.processPort.run("/usr/bin/git", ["-C", this.root, ...args], 10_000);
    if (result.timedOut || result.exitCode !== 0) {
      throw new SlitherGateError("GIT_STATE_UNAVAILABLE", "exact repository state could not be read");
    }
    return result.stdout;
  }
}
