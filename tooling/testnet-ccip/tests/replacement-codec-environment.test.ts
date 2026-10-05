import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowlistedChildEnvironment, validateReplacementCodecDirectory } from "../../../scripts/execution-environment/toolchain-environment.mjs";

const manifest = { name: "agtmai-replacement-test-codecs", version: "0.0.0", private: true, type: "module",
  dependencies: { "@chainlink/ccip-sdk": "1.13.0", "@solana/web3.js": "1.98.4", "@solana/spl-token": "0.4.14", ethers: "6.17.0", got: "11.8.6" } };
if (process.argv[2] === "--probe-codec-environment") {
  try { console.log(JSON.stringify({ directory: allowlistedChildEnvironment().AGTMAI_REPLACEMENT_CODEC_DIRECTORY })); }
  catch (error) { console.error((error as Error).message); process.exitCode = 1; }
} else {
  test("authenticated Node wrapper forwards only validated public codec configuration", () => {
    const directory = mkdtempSync(join(tmpdir(), "public codecs-"));
    try {
      writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
      const env = { AGTMAI_REPLACEMENT_CODEC_DIRECTORY: directory, UNRELATED_CREDENTIAL: "synthetic-reject" };
      assert.equal(allowlistedChildEnvironment(env).AGTMAI_REPLACEMENT_CODEC_DIRECTORY, directory);
      assert.equal(Object.hasOwn(allowlistedChildEnvironment(env), "UNRELATED_CREDENTIAL"), false);
      const child = spawnSync(resolve(".tools/bin/node"), [fileURLToPath(import.meta.url), "--probe-codec-environment"],
        { env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), { directory });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ ...manifest, scripts: { test: "forbidden" } }));
      const rejected = spawnSync(resolve(".tools/bin/node"), [fileURLToPath(import.meta.url), "--probe-codec-environment"],
        { env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 });
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /TOOLCHAIN_REPLACEMENT_CODEC_CONFIG_INVALID/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test("codec configuration rejects relative, missing, symlink and non-public manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "codec-config-")), directory = join(root, "real");
    try {
      mkdirSync(directory); writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
      symlinkSync(directory, join(root, "alias"));
      for (const value of ["relative", join(root, "absent"), join(root, "alias"), directory + "/", directory + "\n"]) {
        assert.throws(() => allowlistedChildEnvironment({ AGTMAI_REPLACEMENT_CODEC_DIRECTORY: value }), /CODEC_CONFIG_INVALID/);
      }
      for (const changed of [{ ...manifest, private: false }, { ...manifest, token: "synthetic" },
        { ...manifest, dependencies: { ...manifest.dependencies, ethers: "^6.17.0" } },
        { ...manifest, dependencies: { ...manifest.dependencies, extra: "1.0.0" } }, null, []]) {
        writeFileSync(join(directory, "package.json"), JSON.stringify(changed));
        assert.throws(() => validateReplacementCodecDirectory(directory), /CODEC_CONFIG_INVALID/);
      }
      writeFileSync(join(root, "public.json"), JSON.stringify(manifest));
      rmSync(join(directory, "package.json")); symlinkSync(join(root, "public.json"), join(directory, "package.json"));
      assert.throws(() => validateReplacementCodecDirectory(directory), /CODEC_CONFIG_INVALID/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
