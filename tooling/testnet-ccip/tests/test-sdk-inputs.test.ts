import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { sdkInputCache, stageSdkInputs } from "../src/adapters/test-sdk-inputs.ts";
import { TEST_SDK_ROOT_HASHES } from "../src/adapters/test-sdk-policy.ts";
import { readVerifiedBytes } from "../../../scripts/toolchain-files.mjs";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const compiler = join(repository, "node_modules/typescript/lib/tsc.js");
const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
function writable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) { writable(join(path, name)); }
  }
}
function temporary(context: TestContext): string {
  const root = mkdtempSync(join(repository, ".local/sdk-input-test-"));
  context.after(() => {
    // Only this test's exclusive tree is removed; readonly projection directories need write permission.
    writable(root); rmSync(root, { recursive: true });
  });
  return root;
}
function run(root: string, args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: { ...environment, TMPDIR: root }, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  process.stdout.write(JSON.stringify({ cwd: root, command: [process.execPath, ...args], status: result.status,
    output: result.stdout + result.stderr }) + "\n");
  return { status: result.status, output: result.stdout + result.stderr };
}
function workspaceLinks(root: string): void {
  const modules = join(root, "node_modules"); mkdirSync(modules);
  for (const name of readdirSync(join(repository, "node_modules"))) {
    if (name !== "@agent-teams") { symlinkSync(join(repository, "node_modules", name), join(modules, name)); }
  }
  mkdirSync(join(modules, "@agent-teams"));
  for (const name of readdirSync(join(repository, "node_modules/@agent-teams"))) {
    symlinkSync(name === "supply" ? join(root, "packages/contexts/supply") : join(repository, "node_modules/@agent-teams", name),
      join(modules, "@agent-teams", name));
  }
  const supplyModules = join(root, "packages/contexts/supply/node_modules");
  mkdirSync(join(supplyModules, "@noble"), { recursive: true });
  symlinkSync(join(repository, "node_modules/.pnpm/yaml@2.9.0/node_modules/yaml"), join(supplyModules, "yaml"));
  symlinkSync(join(repository, "node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes"), join(supplyModules, "@noble/hashes"));
}
test("exact parent without INPUT is RED; real public staged declarations make both authored checks GREEN and retain eight negative contracts and nine units", async context => {
  const root = temporary(context);
  const parent = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, env: environment, encoding: "utf8" }).trim();
  const archive = execFileSync("git", ["archive", parent], { cwd: repository, env: environment, maxBuffer: 128 * 1024 * 1024 });
  execFileSync("/usr/bin/tar", ["-x", "-C", root], { input: archive, env: environment });
  workspaceLinks(root);
  assert.equal(existsSync(join(root, ".local/INPUT")), false);
  const sdkConfig = "tooling/testnet-ccip/tsconfig.sdk-execution.json";
  const red = run(root, [compiler, "-p", sdkConfig, "--pretty", "false"]);
  assert.notEqual(red.status, 0); assert.match(red.output, /TS2307.*\.local\/INPUT\/provider/);
  // Add only the supplier and its exact public metadata; every accepted execution byte stays at parent.
  for (const local of [".github/workflows/ci.yml", "scripts/bootstrap.sh", "scripts/rollback/runtime/offline-environment.mjs",
    "tooling/testnet-ccip/src/adapters/test-sdk-inputs.ts", "tooling/testnet-ccip/tests/test-sdk-inputs.test.ts",
    ...readdirSync(join(repository, "tooling/testnet-ccip/sdk-inputs")).map(name => "tooling/testnet-ccip/sdk-inputs/" + name)]) {
    mkdirSync(dirname(join(root, local)), { recursive: true }); copyFileSync(join(repository, local), join(root, local));
  }
  const destination = join(root, ".local/INPUT/provider");
  const staging = run(root, [join(root, "tooling/testnet-ccip/src/adapters/test-sdk-inputs.ts"), "--offline", "--cache", sdkInputCache]);
  assert.equal(staging.status, 0);
  const staged = JSON.parse(staging.output) as Awaited<ReturnType<typeof stageSdkInputs>>;
  assert.equal(staged.owners, 99); assert.equal(staged.uniqueArchives, 95); assert.ok(staged.declarationFiles > 500);
  assert.equal(readdirSync(join(root, ".tools/downloads/test-sdk-inputs-v1")).length, 95);
  for (const [name, sha256] of Object.entries(TEST_SDK_ROOT_HASHES)) { assert.equal(readVerifiedBytes(join(destination, name)).hash, sha256); }
  assert.equal(existsSync(join(destination, "node_modules/@chainlink/ccip-sdk/dist/evm/index.js")), false);
  assert.equal(run(root, [compiler, "-p", sdkConfig, "--pretty", "false"]).status, 0);
  assert.equal(run(root, [compiler, "--build", "--pretty", "false"]).status, 0);
  assert.equal(run(root, [compiler, "-p", "tooling/testnet-ccip/tsconfig.json", "--pretty", "false"]).status, 0);
  const contracts = ["tooling/testnet-ccip/tests/test-sdk-admission.test.ts", "tooling/testnet-ccip/tests/test-sdk-execution.native.mts"];
  for (const local of contracts) {
    const path = join(root, local); writeFileSync(path, readFileSync(path, "utf8").replace(/^.*@ts-expect-error.*\n/gm, ""));
  }
  const negative = run(root, [compiler, "-p", sdkConfig, "--pretty", "false"]);
  assert.notEqual(negative.status, 0); assert.equal((negative.output.match(/error TS\d+/g) ?? []).length, 8);
  assert.deepEqual(negative.output.match(/error TS\d+/g), ["error TS2339", "error TS2322", "error TS2322", "error TS2322",
    "error TS2769", "error TS2322", "error TS2741", "error TS2375"]);
  assert.match(negative.output, /signTransaction/); assert.match(negative.output, /bigint/);
  assert.match(negative.output, /Property 'fixture' is missing/); assert.match(negative.output, /exactOptionalPropertyTypes/);
  assert.match(negative.output, /number.*not assignable to type 'string'/);
  for (const local of contracts) { copyFileSync(join(repository, local), join(root, local)); }
  const units = run(root, ["--test", "tooling/testnet-ccip/tests/test-sdk-admission.test.ts", "tooling/testnet-ccip/tests/evm-forward.test.mjs"]);
  assert.equal(units.status, 0); assert.match(units.output, /(?:#|ℹ) pass 9/); assert.match(units.output, /(?:#|ℹ) skipped 0/);
  const fixture = join(root, "tooling/testnet-ccip/sdk-inputs/provider-lock.json");
  const original = readFileSync(fixture); writeFileSync(fixture, Buffer.concat([original, Buffer.from("\n")]));
  const corrupted = run(root, ["tooling/testnet-ccip/src/adapters/test-sdk-inputs.ts", "--offline", "--cache", sdkInputCache]);
  assert.notEqual(corrupted.status, 0); assert.match(corrupted.output, /root metadata hash: package-lock.json/);
  writeFileSync(fixture, original);
  assert.equal(run(root, ["tooling/testnet-ccip/src/adapters/test-sdk-inputs.ts", "--offline", "--cache", sdkInputCache]).status, 0);
  process.stdout.write(JSON.stringify({ parent, ...staged, negativeContracts: 8, existingUnits: 9 }) + "\n");
});
test("a late corrupt real cached archive rejects before publication or candidate evaluation, with zero offline fetches", async context => {
  const root = temporary(context), cache = join(root, "cache"), destination = join(root, "provider"); mkdirSync(cache);
  for (const name of readdirSync(sdkInputCache)) { copyFileSync(join(sdkInputCache, name), join(cache, name)); }
  const index = JSON.parse(readFileSync(join(repository, "tooling/testnet-ccip/sdk-inputs/archives.json"), "utf8")) as { placements: Record<string, string> };
  const late = index.placements["node_modules/yaml"]; assert.ok(late);
  chmodSync(join(cache, late), 0o600);
  writeFileSync(join(cache, late), Buffer.concat([readFileSync(join(cache, late)), Buffer.from([1])]));
  let candidateLoads = 0, fetches = 0;
  const prefix = pathToFileURL(resolve(destination)).href + "/";
  const hooks = registerHooks({ load(url, options, next) { if (url.startsWith(prefix)) { candidateLoads++; } return next(url, options); } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; throw new Error("offline fetch forbidden"); };
  try {
    for (const fetchArchives of [false, true]) {
      await assert.rejects(stageSdkInputs({ cache, destination, fetchArchives }), /archive SRI mismatch: node_modules\/yaml/);
    }
    assert.equal(existsSync(destination), false); assert.equal(candidateLoads, 0); assert.equal(fetches, 0);
  } finally { globalThis.fetch = originalFetch; hooks.deregister(); }
});
test("verified read-only projection is repeatable; drift and foreign destinations are rejected without overwriting", async context => {
  const root = temporary(context), destination = join(root, "provider"), retained = join(root, "cache");
  const options = { cache: sdkInputCache, destination, fetchArchives: false, retainCache: retained };
  const first = await stageSdkInputs(options); assert.deepEqual(await stageSdkInputs(options), first);
  assert.equal(lstatSync(destination).mode & 0o7777, 0o500);
  const archive = join(retained, readdirSync(retained)[0]!); const archiveBytes = readFileSync(archive);
  chmodSync(archive, 0o600); writeFileSync(archive, Buffer.concat([archiveBytes, Buffer.from([1])]));
  const fresh = join(root, "fresh");
  await assert.rejects(stageSdkInputs({ ...options, destination: fresh }), /retained cache byte drift/);
  assert.equal(existsSync(fresh), false); assert.equal(readFileSync(archive).length, archiveBytes.length + 1);
  writeFileSync(archive, archiveBytes); chmodSync(archive, 0o400);
  const path = join(destination, "node_modules/ethers/lib.esm/index.d.ts"); chmodSync(path, 0o600);
  writeFileSync(path, "foreign bytes"); chmodSync(path, 0o400);
  await assert.rejects(stageSdkInputs(options), /projection file\/mode\/bytes: node_modules\/ethers\/lib.esm\/index.d.ts/);
  assert.equal(readFileSync(path, "utf8"), "foreign bytes");
  const foreign = join(root, "foreign"); mkdirSync(foreign); writeFileSync(join(foreign, "keep"), "other writer");
  await assert.rejects(stageSdkInputs({ ...options, destination: foreign }), /projection directory\/mode/);
  assert.equal(readFileSync(join(foreign, "keep"), "utf8"), "other writer");
});
