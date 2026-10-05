import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { lockReleaseConstructor } from "../src/domain/evm-pool.ts";
import { validateReplacementCodecDirectory } from "../../../scripts/execution-environment/toolchain-environment.mjs";
import { loadOfficialPoolArtifact } from "../src/composition/deploy-pool.ts";
interface Coder { encode(types: readonly string[], values: readonly unknown[]): string; decode(types: readonly string[], data: string): { toArray(): unknown[] } }
test("actual ethers AbiCoder checks the compiled constructor and malformed ABI without claiming decoder canonicality", async () => {
  const directory = process.env.AGTMAI_REPLACEMENT_CODEC_DIRECTORY;
  assert.ok(directory, "Prerequisite: isolated preinstalled approved codec workspace; set AGTMAI_REPLACEMENT_CODEC_DIRECTORY (ethers 6.17.0). No installation or fallback.");
  validateReplacementCodecDirectory(directory);
  const require = createRequire(resolve(directory, "package.json"));
  assert.equal((require("ethers") as { version: string }).version, "6.17.0");
  const { AbiCoder } = require("ethers") as { AbiCoder: { defaultAbiCoder(): Coder } }, coder = AbiCoder.defaultAbiCoder();
  const artifact = JSON.parse(await readFile(fileURLToPath(new URL("./fixtures/source-built-test-pool/LockReleaseTokenPool.source-built.json", import.meta.url)), "utf8")) as { abi: { type: string; inputs?: { type: string }[] }[] };
  const types = artifact.abi.find(item => item.type === "constructor")!.inputs!.map(input => input.type);
  assert.deepEqual(types, ["address", "uint8", "address[]", "address", "address"]);
  const token = "0x812c4dcbc459a55f8517e87e825b8c728cee7316";
  const values = [token, 9n, [], "0xba3f6251de62ded61ff98590cb2fdf6871fbb991", "0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59"];
  const encoded = lockReleaseConstructor(token); assert.equal(encoded, coder.encode(types, values));
  assert.equal(encoded.slice(130, 194), "a0".padStart(64, "0"));
  function canonical(bytes: string): void { assert.equal(coder.encode(types, coder.decode(types, bytes).toArray()), bytes, "ABI decoder alone may accept noncanonical words/tails"); }
  canonical(encoded);
  const replaceWord = (i: number, word: string) => encoded.slice(0, 2 + i * 64) + word.padStart(64, "0") + encoded.slice(66 + i * 64);
  for (const bytes of [encoded.slice(0, -64), replaceWord(2, "ffff"), replaceWord(5, "1"), replaceWord(1, "100"),
    replaceWord(0, "1" + token.slice(2).padStart(63, "0")), encoded + "00"]) { assert.throws(() => canonical(bytes)); }
});
test("authentic historical artifact remains accepted by the unchanged single-pin legacy loader", async () => {
  const file = process.env.AGTMAI_LEGACY_POOL_ARTIFACT_FILE;
  assert.ok(file, "Prerequisite: authentic historical artifact file SHA256 82dac8896b84a7abe909e076a4de830258e19f5aae50f48ce17cfe8305f74114; set AGTMAI_LEGACY_POOL_ARTIFACT_FILE. No network fallback.");
  const artifact = await loadOfficialPoolArtifact(file);
  assert.equal(artifact.artifactSha256, "82dac8896b84a7abe909e076a4de830258e19f5aae50f48ce17cfe8305f74114");
});
