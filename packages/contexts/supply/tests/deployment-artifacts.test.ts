import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { readArtifactPins } from "../src/features/genesis-manifest/adapters/deployment-artifacts.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { checkPassportFiles } from "../src/features/genesis-manifest/composition/passport.js";
const runDeployment = (args: string[]) => spawnSync(process.execPath, [resolve("dist/features/genesis-manifest/composition/cli.js"), "deployment", ...args], { encoding: "utf8" });
async function temporary(): Promise<string> {
  const parent = resolve("../../../.local/deployment-artifacts-tests");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "case-"));
}

// Small compiler-shaped inputs exercise the file boundary, not compiler qualification.
async function fixture(root: string) {
  const pins = { schema: "agtmai-artifact-pins-v1", sourceRevision: "1".repeat(40), artifacts: [] as { contract: string; artifactPath: string; artifactSha256: string; buildInfoPath: string; buildInfoSha256: string }[] };
  for (const contract of ["AGTMAICCIPToken", "GrantVault"]) {
    const source = `${contract}.sol`, references = { "1": [{ start: 1, length: 32 }] };
    const metadata = { compiler: { version: "0.8.36+commit.8a079791" }, settings: { compilationTarget: { [source]: contract } } };
    const bytecode = { object: "6000", linkReferences: {} }, runtime = { object: `60${"00".repeat(32)}`, immutableReferences: references, linkReferences: {} };
    const rawMetadata = JSON.stringify(metadata);
    const artifact = Buffer.from(JSON.stringify({ metadata, rawMetadata, bytecode: { ...bytecode, object: `0x${bytecode.object}` }, deployedBytecode: { ...runtime, object: `0x${runtime.object}` } }));
    const build = Buffer.from(JSON.stringify({ solcVersion: "0.8.36", input: { language: "Solidity", settings: { evmVersion: "paris", optimizer: { enabled: true, runs: 200 } } },
      output: { contracts: { [source]: { [contract]: { metadata: rawMetadata, evm: { bytecode, deployedBytecode: runtime } } } } } }));
    const artifactPath = `${source}/${contract}.json`, buildInfoPath = `${source}/0123456789abcdef.json`;
    await mkdir(join(root, source));
    await writeFile(join(root, artifactPath), artifact); await writeFile(join(root, buildInfoPath), build);
    pins.artifacts.push({ contract, artifactPath, artifactSha256: sha256(artifact), buildInfoPath, buildInfoSha256: sha256(build) });
  }
  return pins;
}

test("pins accept contained Foundry files and their canonical published copies", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const pins = await fixture(root), path = join(root, "pins.json");
  await writeFile(path, JSON.stringify(pins));
  const loaded = await readArtifactPins(path);
  assert.equal(loaded.artifacts.length, 2);
  for (const [name, bytes] of Object.entries(loaded.files)) { await writeFile(join(root, name), bytes); }
  for (const pin of pins.artifacts) { pin.artifactPath = `${pin.contract.toLowerCase()}.artifact.json`; pin.buildInfoPath = `${pin.contract.toLowerCase()}.build-info.json`; }
  await writeFile(path, JSON.stringify(pins));
  assert.deepEqual(await readArtifactPins(path), loaded);
});

test("pins reject absolute paths, traversal, unexpected leaves and linked escapes for both inputs", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const trusted = join(root, "trusted"), outside = join(root, "outside");
  await mkdir(trusted); await mkdir(outside);
  const pins = await fixture(trusted), path = join(trusted, "pins.json");
  for (const field of ["artifactPath", "buildInfoPath"] as const) {
    const original = pins.artifacts[0]![field], leaf = original.split("/").at(-1)!;
    for (const bad of [join(trusted, original), `../outside/${leaf}`, `AGTMAICCIPToken.sol/../${original}`, `./${original}`, `AGTMAICCIPToken.sol\\${leaf}`,
      `AGTMAICCIPToken.sol/unexpected.json`, "AGTMAICCIPToken.sol", "", `${original}/`]) {
      const changed = structuredClone(pins); changed.artifacts[0]![field] = bad;
      await writeFile(path, JSON.stringify(changed));
      await assert.rejects(readArtifactPins(path), /DEPLOYMENT_ARTIFACT_PATH/, bad);
    }
    const target = join(outside, leaf);
    await writeFile(target, "outside input must not be read or published");
    await rm(join(trusted, original));
    await symlink(target, join(trusted, original));
    await writeFile(path, JSON.stringify(pins));
    await assert.rejects(readArtifactPins(path), { code: "ELOOP" });
    await rm(join(trusted, original));
    await link(target, join(trusted, original));
    await assert.rejects(readArtifactPins(path), /FILE_BOUND_OR_IDENTITY/);
    await rm(join(trusted, original));
    await mkdir(join(trusted, original));
    await assert.rejects(readArtifactPins(path), /FILE_BOUND_OR_IDENTITY/);
    await rm(join(trusted, original), { recursive: true });
    assert.equal(spawnSync("mkfifo", [join(trusted, original)]).status, 0);
    await assert.rejects(readArtifactPins(path), /FILE_BOUND_OR_IDENTITY/);
    await rm(join(trusted, original));
    // Restore this input so the next field's rejection cannot be masked by it.
    await rm(join(trusted, "AGTMAICCIPToken.sol"), { recursive: true });
    await rm(join(trusted, "GrantVault.sol"), { recursive: true });
    await fixture(trusted);
  }
  await rm(join(trusted, "AGTMAICCIPToken.sol"), { recursive: true });
  await symlink(outside, join(trusted, "AGTMAICCIPToken.sol"));
  await writeFile(path, JSON.stringify(pins));
  await assert.rejects(readArtifactPins(path), /DIRECTORY_IDENTITY/);
});

test("advertised passport CLI generates archives but requires a canonical current observation clock to check", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const pins = await fixture(root), pinsPath = join(root, "pins.json"), prepared = join(root, "prepared"), deployment = join(root, "deployment");
  await writeFile(pinsPath, JSON.stringify(pins));
  const compiled = runDeployment(["compile", "--config", "tests/fixtures/deployment/local-test.json", "--artifacts", pinsPath, "--output", prepared]);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const configDigest = JSON.parse(compiled.stdout).configurationSha256, evidencePath = join(root, "evidence.json");
  await writeFile(evidencePath, JSON.stringify({ schema: "agtmai-deployment-evidence-v1", configurationSha256: configDigest,
    collector: { kind: "local-anvil", sourceRevision: pins.sourceRevision }, token: null, grants: [] }));
  const materialized = runDeployment(["materialize", "--prepared", join(prepared, "prepared-deployment.json"), "--evidence", evidencePath, "--output", deployment]);
  assert.equal(materialized.status, 0, materialized.stdout + materialized.stderr);
  const packageJson = JSON.parse(await readFile("../../../package.json", "utf8"));
  const emitted = packageJson.scripts["token:passport"].split(" && .tools/bin/node ")[1];
  assert.equal(emitted, "packages/contexts/supply/dist/features/genesis-manifest/composition/passport-cli.js");
  const runPassport = (args: string[]) => spawnSync(process.execPath, [resolve("../../..", emitted), ...args], { encoding: "utf8" });
  const manifestPath = join(deployment, "deployment-manifest.json"), observationsPath = join(root, "observations.json"), output = join(root, "passport");
  await writeFile(observationsPath, JSON.stringify({ schema: "agtmai-deployment-observations-v1", observedAt: "1", validUntil: "2" }));
  const generated = runPassport(["generate", "--manifest", manifestPath, "--observations", observationsPath, "--output", output]);
  assert.equal(generated.status, 0, generated.stderr);
  const passportPath = join(output, "token-passport.md"), registryPath = join(output, "authority-registry.v1.json");
  const args = ["check", "--manifest", manifestPath, "--observations", observationsPath, "--passport", passportPath, "--registry", registryPath];
  const missingClock = runPassport(args);
  assert.equal(missingClock.status, 2); assert.equal(JSON.parse(missingClock.stderr).reason, "PASSPORT_ARGUMENTS");
  for (const now of ["1", "2"]) {
    const checked = runPassport([...args, "--now", now]); assert.equal(checked.status, 0, checked.stderr);
  }
  for (const now of ["0", "3", "01", "1.5", "not-utc-seconds"]) {
    const rejected = runPassport([...args, "--now", now]);
    assert.equal(rejected.status, 2, rejected.stderr); assert.equal(JSON.parse(rejected.stderr).reason, "PASSPORT_OBSERVATIONS_EXPIRED");
  }
  await assert.rejects(checkPassportFiles(manifestPath, observationsPath, passportPath, registryPath, "3"), /PASSPORT_OBSERVATIONS_EXPIRED/);
});
