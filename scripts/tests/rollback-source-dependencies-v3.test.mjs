import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { restoreArchitectureBoundarySource } from "../rollback/slices/transforms.mjs";

const foundationManifestPath = fileURLToPath(
  import.meta.resolve("@agent-teams/engineering-foundation/package.json"),
);
const foundationManifest = JSON.parse(await readFile(foundationManifestPath, "utf8"));
const foundationCli = join(
  dirname(foundationManifestPath),
  foundationManifest.bin["agent-teams-foundation"],
);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const configPath = "architecture/foundation/source-dependencies.yaml";
const policySource = await readFile(join(repositoryRoot, configPath), "utf8");

test("live source policy is schema v3 with root package and workspace package roots", () => {
  assert.match(policySource, /^schemaVersion: 3$/m);
  assert.match(policySource, /^rootPackage: true$/m);
  assert.doesNotMatch(policySource, /^includeRootPackage:/m);
  assert.match(
    policySource,
    /^packageRoots:\n  - packages\/contexts\/supply\n  - packages\/domain$/m,
  );
  assert.match(policySource, /^  - packages\/domain\/src$/m);
  assert.match(policySource, /^  - packages\/domain\/tests$/m);
  assert.match(policySource, /^  - packages\/contexts\/supply\/tests$/m);
  assert.match(policySource, /^  - scripts\/execution-environment$/m);
});

test("applied schema v1 restore does not require a second header demotion", () => {
  const applied = restoreArchitectureBoundarySource(policySource, policySource, "local-solana");
  assert.match(applied, /^schemaVersion: 1$/m);
  assert.doesNotMatch(applied, /^packageRoots:/m);
  assert.equal(
    restoreArchitectureBoundarySource(applied, policySource, "local-solana"),
    applied,
  );
});

test("source v3 rejects includeRootPackage as an unknown public field", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-foundation-include-root-"));
  try {
    await mkdir(join(root, dirname(configPath)), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@agent-teams/token-repository",
        private: true,
        type: "module",
      }),
    );
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    await writeFile(
      join(root, configPath),
      `${await readFile(join(repositoryRoot, configPath), "utf8")}\nincludeRootPackage: true\n`,
    );
    await writeFile(
      join(root, "foundation.config.yaml"),
      JSON.stringify({
        schemaVersion: 1,
        project: { id: "foundation-include-root-fixture" },
        capabilities: { "architecture.source-dependencies": { configPath } },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [foundationCli, "check", "architecture.source-dependencies", "--consumer", root, "--json"],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(result.error, undefined, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.notEqual(envelope.outcome, "passed", JSON.stringify(envelope));
    assert.match(
      JSON.stringify(envelope),
      /includeRootPackage|unknown property|invalid-input/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source v3 rejects a filesystem builtin inside token domain", async () => {
  const root = await mkdtemp(join(tmpdir(), "token-foundation-domain-fs-"));
  const domainFile = "packages/domain/src/supply.ts";
  try {
    await mkdir(join(root, dirname(configPath)), { recursive: true });
    await mkdir(join(root, dirname(domainFile)), { recursive: true });
    await cp(join(repositoryRoot, "package.json"), join(root, "package.json"));
    await cp(join(repositoryRoot, "pnpm-workspace.yaml"), join(root, "pnpm-workspace.yaml"));
    await cp(join(repositoryRoot, "foundation.config.yaml"), join(root, "foundation.config.yaml"));
    await cp(join(repositoryRoot, configPath), join(root, configPath));
    await cp(
      join(repositoryRoot, "packages/domain"),
      join(root, "packages/domain"),
      { recursive: true },
    );
    await cp(
      join(repositoryRoot, "packages/contexts/supply"),
      join(root, "packages/contexts/supply"),
      { recursive: true },
    );
    await cp(
      join(repositoryRoot, "scripts/execution-environment"),
      join(root, "scripts/execution-environment"),
      { recursive: true },
    );
    await cp(join(repositoryRoot, "tooling"), join(root, "tooling"), { recursive: true });
    const original = await readFile(join(root, domainFile), "utf8");
    await writeFile(join(root, domainFile), `import fs from "node:fs";\n${original}\nvoid fs;\n`);
    const result = spawnSync(
      process.execPath,
      [foundationCli, "check", "architecture.source-dependencies", "--consumer", root, "--json"],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(result.error, undefined, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.notEqual(envelope.outcome, "passed", JSON.stringify(envelope));
    assert.match(
      JSON.stringify(envelope),
      /forbidden-builtin-dependency|node:fs|token\.domain/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
