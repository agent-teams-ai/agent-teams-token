import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertRecoveryGitAuthority, canonicalGitEnvironment } from "../../toolchain-environment.mjs";

const history = fileURLToPath(new URL("../../assert-complete-history.sh", import.meta.url));

test("checkout v7.0.1 gc.auto is exact in both Git authority validators", () => {
  const root = mkdtempSync(join(tmpdir(), "agtmai-checkout-config-"));
  const env = canonicalGitEnvironment({ PATH: "/usr/bin:/bin" });
  const git = (...args) => {
    const result = spawnSync("/usr/bin/git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "--quiet");
    git("config", "user.name", "Checkout Fixture");
    git("config", "user.email", "fixture@invalid.example");
    writeFileSync(join(root, "fixture.txt"), "checkout\n");
    git("add", "fixture.txt");
    git("commit", "--quiet", "-m", "test: checkout fixture");
    const head = git("rev-parse", "HEAD");
    const config = join(root, ".git/config");
    const original = readFileSync(config);
    const verify = (allowed, unavailable = false) => {
      const result = spawnSync("/bin/bash", [history, head, head], { cwd: root, env, encoding: "utf8" });
      if (allowed) {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /ROLLBACK_HISTORY_OK/u);
        assert.doesNotThrow(() => assertRecoveryGitAuthority(root));
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, unavailable
          ? /ROLLBACK_GIT_LOCAL_CONFIG_UNAVAILABLE/u : /ROLLBACK_GIT_LOCAL_CONFIG_FORBIDDEN/u);
        assert.throws(() => assertRecoveryGitAuthority(root), unavailable
          ? /TOOLCHAIN_GIT_LOCAL_CONFIG_UNAVAILABLE/u : /TOOLCHAIN_GIT_LOCAL_CONFIG_FORBIDDEN/u);
      }
    };
    verify(true);
    git("config", "--local", "gc.auto", "0");
    verify(true);
    for (const value of ["1", "-1", "00", "false", "", "0\n", "0\ninclude.path=/tmp/hostile", "!touch /tmp/hostile", " 0", "0k"]) {
      writeFileSync(config, original);
      git("config", "--local", "gc.auto", value);
      verify(false);
    }
    for (const values of [["1", "0"], ["0", "1"]]) {
      writeFileSync(config, original);
      for (const value of values) {git("config", "--local", "--add", "gc.auto", value);}
      verify(false);
    }
    for (const key of ["gc.autodetach", "gc.pruneexpire", "core.sshcommand", "core.hookspath", "core.worktree", "include.path", "credential.helper", "url.example.insteadof", "filter.evil.clean"]) {
      writeFileSync(config, original);
      git("config", "--local", "gc.auto", "0");
      git("config", "--local", key, "0");
      verify(false, key === "core.worktree");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
