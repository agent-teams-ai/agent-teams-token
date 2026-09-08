import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitRepositoryState } from "../src/adapters/repository.ts";
import { OwnedProcess } from "../src/adapters/process.ts";

// Disposable repositories only; the writer checkout and its config are untouched.
test("repository rejects executable fsmonitor before any configured command runs", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "slither-git-authority-"));
  const git = (args: string[]): string => execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  try {
    git(["init", "--quiet"]);
    await writeFile(join(root, "tracked"), "canonical\n");
    git(["add", "tracked"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "test: canonical input"]);
    const candidate = git(["rev-parse", "HEAD"]).trim();
    const marker = join(root, "executed");
    const helper = join(root, "fsmonitor");
    await writeFile(helper, `#!/bin/sh\nprintf executed > '${marker}'\nprintf '\\0'\n`, { mode: 0o700 });
    git(["config", "core.fsmonitor", helper]);
    // Reproduce the old cleanliness invocation, retaining a positive execution witness.
    git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
    assert.equal(await readFile(marker, "utf8"), "executed");
    await rm(marker);
    const repository = new GitRepositoryState(root, new OwnedProcess());
    await assert.rejects(repository.assertExactClean(candidate), { code: "GIT_STATE_UNAVAILABLE" });
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
