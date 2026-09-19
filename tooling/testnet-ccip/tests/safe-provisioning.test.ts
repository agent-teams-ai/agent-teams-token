import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Safe provisioning fails closed offline for absent and tampered archives", t => {
  const root = mkdtempSync(join(tmpdir(), "safe-provisioning-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, ".tools/downloads"), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, "../../../scripts/prepare-safe-artifacts.sh"), join(root, "scripts/prepare-safe-artifacts.sh"));
  const run = (...args: string[]) => spawnSync("/bin/bash", [join(root, "scripts/prepare-safe-artifacts.sh"), ...args], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 10_000,
  });
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /SAFE_ARCHIVE_REQUIRED/);
  assert.equal(missing.stdout, "");
  assert.deepEqual(readdirSync(join(root, ".local")), []);
  writeFileSync(join(root, ".tools/downloads/safe-contracts-1.4.1.tgz"), "tampered");
  for (const args of [[], ["--fetch"]]) {
    const tampered = run(...args);
    assert.equal(tampered.status, 1);
    assert.equal(tampered.stdout, "");
    assert.deepEqual(readdirSync(join(root, ".local")), []);
  }
});
