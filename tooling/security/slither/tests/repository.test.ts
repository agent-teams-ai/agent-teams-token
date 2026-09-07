import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProcessPort, ProcessResult } from "../src/application/ports.ts";
import { GitRepositoryState } from "../src/adapters/repository.ts";

class FakeProcess implements ProcessPort {
  private readonly results: ProcessResult[];
  constructor(results: ProcessResult[]) {this.results = results;}
  async run(): Promise<ProcessResult> {return this.results.shift()!;}
}
const result = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });

test("repository state rejects tracked, staged, and non-ignored untracked dirt", async (context) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "slither-repository-"));
  execFileSync("/usr/bin/git", ["init", "--quiet", root], { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  for (const dirt of [" M tooling/security/slither/src/application/policy.ts\0", "M  tooling/security/slither/src/application/policy.ts\0", "?? contracts/evm/src/New.sol\0"]) {
    const repository = new GitRepositoryState(root, new FakeProcess([result("a".repeat(40)), result(dirt)]));
    await assert.rejects(repository.assertExactClean("a".repeat(40)), /untracked changes are forbidden/u);
  }
});

test("repository state returns the exact tracked production source inventory", async (context) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "slither-repository-"));
  execFileSync("/usr/bin/git", ["init", "--quiet", root], { env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const repository = new GitRepositoryState(root, new FakeProcess([result("contracts/evm/src/B.sol\0contracts/evm/src/A.sol\0")]));
  assert.deepEqual(await repository.trackedProductionSources(), ["contracts/evm/src/A.sol", "contracts/evm/src/B.sol"]);
});
