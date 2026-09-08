import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { readStableRegularFile } from "./container-input.ts";
import { trustedChildInvocation } from "./trusted-git.mjs";
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
    await this.assertCanonicalTree(candidateSha);
  }

  async assertCanonicalBytes(candidateSha: string, path: string, bytes: Buffer): Promise<void> {
    if (!/^[0-9a-f]{40}$/u.test(candidateSha) || !/^[A-Za-z0-9._/-]+$/u.test(path)
      || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new SlitherGateError("GIT_STATE_UNAVAILABLE", "canonical Git input identity is invalid");
    }
    const object = await this.git(["ls-tree", "-z", candidateSha, "--", path]);
    const digest = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (object !== `100644 blob ${digest}\t${path}\0` && object !== `100755 blob ${digest}\t${path}\0`) {
      throw new SlitherGateError("INPUT_HASH_MISMATCH", "canonical input bytes differ from the requested Git commit");
    }
  }

  private async assertCanonicalTree(candidateSha: string): Promise<void> {
    const entries = await this.git(["ls-tree", "-r", "--name-only", "-z", candidateSha, "--",
      "contracts/evm/src", "contracts/evm/lib", "contracts/evm/foundry.toml", "tooling/security/slither", "tooling/toolchain.lock.json"]);
    for (const path of entries.split("\0").filter(Boolean)) {
      const absolute = join(this.root, path);
      if (await realpath(absolute) !== absolute) { throw new SlitherGateError("INPUT_HASH_MISMATCH", "canonical input path is redirected"); }
      await this.assertCanonicalBytes(candidateSha, path, await readStableRegularFile(absolute, path));
    }
  }

  async trackedProductionSources(): Promise<readonly string[]> {
    const raw = await this.git(["ls-files", "-z", "--", "contracts/evm/src"]);
    return raw.split("\0").filter((path) => path.endsWith(".sol")).toSorted();
  }

  private async git(args: readonly string[]): Promise<string> {
    let invocation;
    try {
      invocation = trustedChildInvocation("/usr/bin/git", ["-C", this.root, ...args], {}, { workingDirectory: this.root });
    } catch (cause) {
      const failure = new SlitherGateError("GIT_STATE_UNAVAILABLE", "repository Git authority is unsafe");
      failure.cause = cause;
      throw failure;
    }
    const result = await this.processPort.run("/usr/bin/git", invocation.arguments, 10_000, { env: invocation.environment });
    if (result.timedOut || result.exitCode !== 0) {
      throw new SlitherGateError("GIT_STATE_UNAVAILABLE", "exact repository state could not be read");
    }
    return result.stdout;
  }
}
