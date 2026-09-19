import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const run = (args: string[]) => spawnSync(process.execPath, [resolve("dist/features/genesis-manifest/composition/cli.js"), "deployment", ...args], { encoding: "utf8" });

test("deployment CLI validates explicit configuration, rejects execution flags and redacts I/O paths", () => {
  const valid = run(["validate", "--config", "tests/fixtures/deployment/local-test.json"]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).broadcastAllowed, false);
  assert.equal(JSON.parse(valid.stdout).configurationStatus, "test-only");
  for (const flag of ["--execute", "--broadcast", "--private-key", "--rpc-url"]) {
    const refused = run(["validate", "--config", "tests/fixtures/deployment/local-test.json", flag, "private-value"]);
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout.includes("private-value"), false);
  }
  const missing = run(["compile", "--config", "missing-secret-credential-path"]);
  assert.equal(missing.status, 3, missing.stderr);
  assert.equal((missing.stdout + missing.stderr).includes("missing-secret-credential-path"), false);
  assert.equal(JSON.parse(missing.stdout).reason, "DEPLOYMENT_IO_UNAVAILABLE");
});
