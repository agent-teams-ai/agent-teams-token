import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const policyText = readFileSync(
  join(repositoryRoot, "architecture/foundation/repository-agent-workflow.yaml"),
  "utf8",
);

function fullScanPaths(source) {
  const marker = "fullScanPaths:\n";
  const start = source.indexOf(marker);
  assert.ok(start >= 0);
  const lines = source.slice(start + marker.length).split("\n");
  const paths = [];
  for (const line of lines) {
    const match = /^  - (.+)$/u.exec(line);
    if (!match) {break;}
    paths.push(match[1]);
  }
  return paths;
}

function routed(path, roots) {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

test("Foundation full-scan policy routes every recovery production and test surface", () => {
  const roots = fullScanPaths(policyText);
  const mandatory = [
    "architecture/rollback/local-solana.json",
    "architecture/rollback/recovery-evidence.schema.json",
    "scripts/rollback/proof-runtime.mjs",
    "scripts/rollback/prove-slices.mjs",
    "scripts/rollback/runtime/node-runtime.mjs",
    "scripts/rollback/slices/cli.mjs",
    "scripts/rollback/test-support/proof-fixture.mjs",
    "scripts/rollback/validate-evidence.mjs",
    "scripts/assert-complete-history.sh",
    "scripts/tests/rollback-ci-history.test.mjs",
    "scripts/tests/rollback-cleanup-safety.test.mjs",
    "scripts/tests/rollback-evidence.test.mjs",
    "scripts/tests/rollback-proof.test.mjs",
    "scripts/tests/rollback-routing.test.mjs",
  ];
  for (const path of mandatory) {assert.equal(routed(path, roots), true, path);}
});

test("negative routing fixtures prove recovery coverage is explicit rather than extension-based", () => {
  const roots = fullScanPaths(policyText);
  const withoutRecoveryRoutes = roots.filter((root) =>
    root !== "architecture/rollback"
    && root !== "scripts/rollback"
    && root !== "scripts/assert-complete-history.sh"
    && !root.startsWith("scripts/tests/rollback-"));
  for (const path of [
    "architecture/rollback/local-solana.json",
    "scripts/rollback/validate-evidence.mjs",
    "scripts/assert-complete-history.sh",
    "scripts/tests/rollback-proof.test.mjs",
    "scripts/tests/rollback-routing.test.mjs",
  ]) {
    assert.equal(routed(path, withoutRecoveryRoutes), false, path);
  }
  assert.equal(routed("architecture/rollback-adjacent/fixture.json", roots), false);
  assert.equal(routed("scripts/rollback-adjacent/fixture.mjs", roots), false);
  assert.equal(routed("scripts/tests/not-a-rollback.test.mjs", roots), false);
});
