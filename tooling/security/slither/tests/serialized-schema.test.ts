import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertSerializedAgainstSchema } from "../src/adapters/json-schema.ts";
import { writeFailureEvidence, writeReadyEvidence } from "../src/adapters/evidence.ts";
import type { AnalysisInput, GateManifest } from "../src/domain/model.ts";
import { writeCanonicalFixture } from "./evidence-canonical-fixture.ts";
import { makeCompilerEvidence } from "./test-compiler-evidence.ts";
import { makeTestDirectory } from "./test-directory.ts";
import { testPublication } from "./test-publication.ts";

const schemaDirectory = "tooling/security/slither";

test("duplicate keys are rejected before ordinary JSON parsing", async () => {
  const serialized = '{"schemaVersion":1,"schemaVersion":1,"findings":[]}\n';
  await assert.rejects(
    assertSerializedAgainstSchema(serialized, `${schemaDirectory}/triage-ledger.schema.v1.json`),
    /malformed JSON/u,
  );
});

interface CliFixture { candidateSha: string; readonly parent: string; readonly repositoryRoot: string; readonly output: string }

async function makeCliFixture(parent: string): Promise<CliFixture> {
  const repositoryRoot = join(parent, "repository");
  const schemas = join(repositoryRoot, schemaDirectory);
  await mkdir(schemas, { recursive: true });
  for (const name of ["environment-failure", "output-failure", "tool-failure", "evidence-report", "suppression-ledger", "triage-ledger"]) {
    await copyFile(`${schemaDirectory}/${name}.schema.v1.json`, join(schemas, `${name}.schema.v1.json`));
  }
  await copyFile("tooling/toolchain.lock.json", join(repositoryRoot, "tooling/toolchain.lock.json"));
  const fixture = { parent, repositoryRoot, output: join(parent, "bundle"), candidateSha: "" };
  fixtureGit(fixture, ["init", "--quiet"]);
  await commitFixture(fixture);
  return fixture;
}

function assertCli(fixture: CliFixture, expectedCode: number, expectedError = "", options: { entrypoint?: string; output?: string; sha?: string; githubSha?: string } = {}): void {
  const result = spawnSync(process.execPath, [resolve(`${schemaDirectory}/src/composition/${options.entrypoint ?? "validate-evidence"}.ts`)], {
    cwd: fixture.repositoryRoot,
    env: { SLITHER_REPOSITORY_ROOT: fixture.repositoryRoot, SLITHER_CANDIDATE_SHA: options.sha ?? fixture.candidateSha,
      SLITHER_EVIDENCE_DIRECTORY: options.output ?? fixture.output, GITHUB_SHA: options.githubSha, TMPDIR: fixture.parent },
    encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 128 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, expectedCode, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, expectedError);
}

async function snapshot(path: string): Promise<unknown> {
  const info = await lstat(path, { bigint: true });
  const { dev, ino, mode, nlink, uid, gid, size, mtimeNs, ctimeNs } = info;
  const content = info.isSymbolicLink() ? await readlink(path) : info.isDirectory()
    ? await Promise.all((await readdir(path)).toSorted().map(async (name) => [name, await snapshot(join(path, name))]))
    : await readFile(path);
  return { dev, ino, mode, nlink, uid, gid, size, mtimeNs, ctimeNs, content };
}

async function makeFailureBundle(fixture: CliFixture): Promise<void> {
  await writeFailureEvidence({ output: fixture.output, candidateSha: fixture.candidateSha, category: "environment-failure", exitCode: 50,
    stage: "image-preflight", errorCode: "IMAGE_UNAVAILABLE", schemaDirectory: join(fixture.repositoryRoot, schemaDirectory),
    assertReadyPrecondition: async () => {}, publication: testPublication() });
  const parentInfo = await lstat(fixture.parent, { bigint: true });
  const outputInfo = await lstat(fixture.output, { bigint: true });
  assert.equal(outputInfo.uid, parentInfo.uid);
  assert.equal(outputInfo.gid, parentInfo.gid);
}

test("real finalized-evidence CLI accepts an existing failure bundle unchanged through a parent alias", async () => {
  const parent = await makeTestDirectory("serialized-cli-valid-");
  try {
    const fixture = await makeCliFixture(parent);
    await makeFailureBundle(fixture);
    await symlink(parent, join(parent, "alias"));
    const before = await snapshot(fixture.output);
    assertCli(fixture, 0);
    assertCli(fixture, 0, "", { output: join(parent, "alias/bundle") });
    assert.deepEqual(await snapshot(fixture.output), before);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("real producer CLIs reject existing outputs without overwriting or removing them", async () => {
  const parent = await makeTestDirectory("serialized-cli-producers-");
  try {
    const fixture = await makeCliFixture(parent);
    await makeFailureBundle(fixture);
    const occupied = join(parent, "occupied");
    const empty = join(parent, "empty");
    await writeFile(occupied, "owned synthetic sentinel\n", { mode: 0o600 });
    await mkdir(empty, { mode: 0o700 });
    for (const output of [fixture.output, occupied, empty]) {
      const before = await snapshot(output);
      assertCli(fixture, 50, "SLITHER_GATE_FAILED ABSOLUTE_PATH_REQUIRED\n", { entrypoint: "cli", output });
      assertCli(fixture, 50, "SLITHER_ENVIRONMENT_FAILURE ABSOLUTE_PATH_REQUIRED\n", { entrypoint: "record-environment-failure", output });
      assert.deepEqual(await snapshot(output), before);
    }
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("real finalized-evidence CLI rejects invalid SHA and path boundaries", async () => {
  const parent = await makeTestDirectory("serialized-cli-paths-");
  try {
    const fixture = await makeCliFixture(parent);
    await makeFailureBundle(fixture);
    await symlink(fixture.output, join(parent, "leaf-alias"));
    await symlink(fixture.repositoryRoot, join(parent, "repository-alias"));
    await mkdir(join(fixture.repositoryRoot, "inside"));
    await writeFile(join(parent, "file"), "synthetic file");
    const before = await snapshot(fixture.output);
    assertCli(fixture, 40, "SLITHER_EVIDENCE_INVALID CANDIDATE_SHA_MISMATCH\n", { sha: "b".repeat(40) });
    for (const sha of ["", "bad", "A".repeat(40)]) {
      assertCli(fixture, 40, "SLITHER_EVIDENCE_INVALID CANDIDATE_SHA_INVALID\n", { sha });
    }
    assertCli(fixture, 40, "SLITHER_EVIDENCE_INVALID CANDIDATE_SHA_INVALID\n", { githubSha: "b".repeat(40) });
    for (const output of [join(parent, "missing"), join(parent, "leaf-alias"), join(parent, "file"),
      `${parent}/repository/../bundle`, `${fixture.output}/.`, `${fixture.output}/`, "relative/bundle"]) {
      assertCli(fixture, 40, "SLITHER_EVIDENCE_INVALID ABSOLUTE_PATH_REQUIRED\n", { output });
    }
    for (const output of [join(fixture.repositoryRoot, "inside"), join(parent, "repository-alias/inside")]) {
      assertCli(fixture, 40, "SLITHER_EVIDENCE_INVALID EVIDENCE_INSIDE_REPOSITORY\n", { output });
    }
    assert.deepEqual(await snapshot(fixture.output), before);
  } finally {await rm(parent, { recursive: true, force: true });}
});

async function mutateJson(path: string, change: (value: Record<string, unknown>) => void): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(value);
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

test("real finalized-evidence CLI independently rejects READY and serialized failure mutations", async (context) => {
  const cases: readonly [string, (fixture: CliFixture) => Promise<void>][] = [
    ["missing READY", async ({ output }) => await rm(join(output, "READY"))],
    ["nonempty READY", async ({ output }) => await writeFile(join(output, "READY"), "ready")],
    ["symlink READY", async ({ output, parent }) => {
      await rm(join(output, "READY")); await writeFile(join(parent, "marker"), "", { mode: 0o600 });
      await symlink(join(parent, "marker"), join(output, "READY"));
    }],
    ["extra file", async ({ output }) => await writeFile(join(output, "extra"), "extra", { mode: 0o600 })],
    ["extra field", async ({ output }) => await mutateJson(join(output, "environment-failure.json"), (value) => {value.injected = true;})],
    ["mutated stage", async ({ output }) => await mutateJson(join(output, "environment-failure.json"), (value) => {value.stage = "repository-validation";})],
    ["mutated image", async ({ output }) => await mutateJson(join(output, "environment-failure.json"), (value) => {value.image = String(value.image).replace(/sha256:[0-9a-f]{64}/u, `sha256:${"0".repeat(64)}`);})],
    ["duplicate key", async ({ output }) => {
      const path = join(output, "environment-failure.json");
      await writeFile(path, (await readFile(path, "utf8")).replace("{", '{"ready":true,'));
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      const parent = await makeTestDirectory("serialized-cli-invalid-");
      try {
        const fixture = await makeCliFixture(parent);
        await makeFailureBundle(fixture);
        await mutate(fixture);
        const before = await snapshot(fixture.output);
        const code = ["extra field", "mutated stage", "mutated image", "duplicate key"].includes(name) ? "EVIDENCE_SCHEMA_INVALID" : "EVIDENCE_BUNDLE_INVALID";
        assertCli(fixture, 40, `SLITHER_EVIDENCE_INVALID ${code}\n`);
        assert.deepEqual(await snapshot(fixture.output), before);
      } finally {await rm(parent, { recursive: true, force: true });}
    });
  }
});

async function makeAnalysisBundle(fixture: CliFixture): Promise<void> {
  const build = makeCompilerEvidence("contract A {}\n");
  const pinned = JSON.parse(await readFile(`${schemaDirectory}/production-closure.v1.json`, "utf8")) as GateManifest;
  const manifest: GateManifest = { ...pinned, targets: [{ path: "contracts/evm/src/A.sol", contract: "A" }],
    expectedContracts: ["A"], sources: [{ path: "contracts/evm/src/A.sol", sha256: "0".repeat(64) }], config: [],
    creationBytecodeSha256: build.compilerEvidence.creationBytecodeSha256, vulnerableFixture: build.vulnerableFixture };
  const input: AnalysisInput = { success: true, findings: [], analysisErrors: [], analyzedContracts: ["A"], analyzedSources: ["src/A.sol"],
    closure: [], detectorInventory: Array.from({ length: 101 }, (_, i) => `fixture-${i}`).toSorted(), compiler: manifest.compiler,
    creationBytecodeSha256: manifest.creationBytecodeSha256, freshFoundryCreationBytecodeSha256: manifest.creationBytecodeSha256,
    forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256,
    compilerEvidence: build.compilerEvidence, fixtureProof: build.fixtureProof };
  const hashes = await writeCanonicalFixture(fixture.repositoryRoot, manifest, input);
  const schemas = join(fixture.repositoryRoot, schemaDirectory);
  const accepted = { ...hashes.manifest, detectorInventory: { ...hashes.manifest.detectorInventory, path: `${schemaDirectory}/detector-inventory.v1.json` } };
  await writeFile(join(schemas, "production-closure.v1.json"), `${JSON.stringify(accepted)}\n`);
  for (const name of ["detector-inventory.v1.json", "slither.config.json", "suppressions.v1.json", "triage.v1.json"]) {
    await copyFile(join(fixture.repositoryRoot, name), join(schemas, name));
  }
  await commitFixture(fixture);
  await writeReadyEvidence({ output: fixture.output, candidateSha: fixture.candidateSha, manifest: accepted, input,
    decision: { category: "clean", exitCode: 0, blocking: [], visible: [], suppressed: [], errors: [] },
    hashes: { config: hashes.config, policy: hashes.policy }, triageHash: hashes.triage, schemaDirectory: schemas,
    assertReadyPrecondition: async () => {}, publication: testPublication() });
}

test("real finalized-evidence CLI validates full synthetic analysis and rejects raw or aggregate mutation", async () => {
  const parent = await makeTestDirectory("serialized-cli-analysis-");
  try {
    const fixture = await makeCliFixture(parent);
    await makeAnalysisBundle(fixture);
    const before = await snapshot(fixture.output);
    assertCli(fixture, 0);
    assert.deepEqual(await snapshot(fixture.output), before);
    for (const [name, mutate] of [
      ["evidence.json", (value: Record<string, unknown>) => { (value.analysis as Record<string, unknown>).findingCount = 1; }],
      ["slither-inventory.json", (value: Record<string, unknown>) => { value.contracts = ["Forged"]; }],
    ] as const) {
      const path = join(fixture.output, name);
      const original = await readFile(path);
      await mutateJson(path, mutate);
      const mutated = await snapshot(fixture.output);
      assertCli(fixture, 40, "SLITHER_EVIDENCE_INVALID EVIDENCE_BUNDLE_INVALID\n");
      assert.deepEqual(await snapshot(fixture.output), mutated);
      await writeFile(path, original);
    }
    assertCli(fixture, 0);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("date-time validates the exact UTC calendar value", async () => {
  const serialized = `${JSON.stringify({ schemaVersion: 1, findings: [{ schemaVersion: 1, fingerprint: `sha256:${"1".repeat(64)}`, owner: "security", disposition: "accepted-design", rationale: "A sufficiently long reviewed rationale.", reviewedAt: "2026-02-30T00:00:00.000Z" }] })}\n`;
  await assert.rejects(
    assertSerializedAgainstSchema(serialized, `${schemaDirectory}/triage-ledger.schema.v1.json`),
    /invalid date-time/u,
  );
});

test("cross-category failure mutations are impossible to publish", async () => {
  const parent = await makeTestDirectory("cross-category-");
  try {
    await assert.rejects(writeFailureEvidence({
      output: join(parent, "bundle"), candidateSha: "a".repeat(40), category: "tool-failure",
      exitCode: 30, stage: "artifact-parsing", errorCode: "MALFORMED_JSON",
      schemaDirectory, assertReadyPrecondition: async () => {}, publication: testPublication(),
    }), /exhaustive registry/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});

function fixtureGit(fixture: CliFixture, args: string[]): string {
  return execFileSync("/usr/bin/git", ["-C", fixture.repositoryRoot, ...args], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}
async function commitFixture(fixture: CliFixture): Promise<void> {
  const paths = (await readdir(fixture.repositoryRoot)).filter((name) => name !== ".git");
  fixtureGit(fixture, ["add", "--", ...paths]);
  fixtureGit(fixture, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "test: canonical evidence fixture"]);
  fixture.candidateSha = fixtureGit(fixture, ["rev-parse", "HEAD"]).trim();
}
