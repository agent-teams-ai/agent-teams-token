import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bindFixture } from "./fixture-binding.ts";
import type { FixtureSettings } from "./fixture-binding.ts";
import { SOURCE_BUILT_POOL } from "../../artifacts/replacement-source-built-test-v1.ts";

export interface PoolArtifactSelection extends FixtureSettings {
  readonly poolArtifactProfile?: typeof SOURCE_BUILT_POOL.profile;
}
export interface PoolArtifact { readonly artifactSha256: string; readonly creationBytecode: string }
/** Absence alone retains the legacy loader. A present profile never calls it. */
export function selectPoolArtifact(settings: PoolArtifactSelection,
  legacy: (file: string) => Promise<PoolArtifact>, journals: readonly string[] = []) {
  const fixture = bindFixture(settings, journals);
  if (!Object.hasOwn(settings, "poolArtifactProfile")) {
    return { artifactId: "@chainlink/contracts-ccip@1.6.1/LockReleaseTokenPool", fixture, load: legacy };
  }
  if (settings.poolArtifactProfile !== SOURCE_BUILT_POOL.profile || settings.testOnly !== true ||
    !fixture || fixture.identity !== SOURCE_BUILT_POOL.fixtureIdentity) {
    throw new Error("Exact source-built TEST pool profile/fixture required");
  }
  for (const file of journals) {
    if (!isAbsolute(file)) { throw new Error("Absolute replacement journal paths required"); }
    for (const [path, directory] of [[dirname(resolve(file)), true], [resolve(file), false]] as const) {
      let stat;
      try { stat = lstatSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { continue; } throw error; }
      if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) {
        throw new Error("Private owned replacement journals required");
      }
    }
  }
  return { artifactId: SOURCE_BUILT_POOL.artifactId, fixture, async load(file: string): Promise<PoolArtifact> {
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== SOURCE_BUILT_POOL.artifactSha256) {
      throw new Error("Source-built TEST pool artifact mismatch");
    }
    const artifact = JSON.parse(bytes.toString("utf8")) as { bytecode: { object: string } };
    return { artifactSha256: SOURCE_BUILT_POOL.artifactSha256, creationBytecode: artifact.bytecode.object };
  } };
}
/** Bind CREATE's selected public identity before a new deployment can have effects. */
export function assertSelectedPoolAddress(from: string, nonce: string, expected: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(nonce) || BigInt(nonce) >= (1n << 64n) - 1n || !/^0x[0-9a-fA-F]{40}$/.test(from)) {
    throw new Error("Invalid selected pool CREATE inputs");
  }
  const n = BigInt(nonce), hex = n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, "0");
  const encoded = n === 0n ? Buffer.from([0x80]) : n < 128n ? Buffer.from([Number(n)])
    : Buffer.concat([Buffer.from([0x80 + hex.length / 2]), Buffer.from(hex, "hex")]);
  const payload = Buffer.concat([Buffer.from([0x94]), Buffer.from(from.slice(2), "hex"), encoded]);
  const address = "0x" + Buffer.from(keccak_256(Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]))).subarray(12).toString("hex");
  if (address !== expected.toLowerCase()) { throw new Error("Selected pool CREATE address mismatch"); }
}
