import assert from "node:assert/strict";
import { access, mkdtemp, link, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assertSafeSource, inspectArtifacts, writeArtifact } from "../src/features/genesis-manifest/adapters/artifact-store.js";
import { encodeAllocationCommitment } from "../src/features/genesis-manifest/adapters/abi.js";
import { sha256 } from "../src/features/genesis-manifest/adapters/digest.js";
import { compileLocalSource } from "../src/features/genesis-manifest/application/compiler.js";
import { canonicalJson } from "../src/features/genesis-manifest/application/canonical.js";
import type { JsonValue } from "../src/features/genesis-manifest/application/canonical.js";
import type { LocalGenesisManifest, LocalGenesisSource } from "../src/features/genesis-manifest/domain/model.js";

const manifest = {
  schemaVersion: 1, purpose: "local-fixture-artifact", status: "test-only", network: { kind: "local-evm", chainId: "31337" },
  token: { name: "Agent Teams AI", symbol: "AGTMAI", decimals: 9, initialSupplyBaseUnits: "1" }, allocations: [],
  sourceSha256: `0x${"1".repeat(64)}`, rawAllocationAbi: "0x00", genesisAllocationHash: `0x${"2".repeat(64)}`,
  tool: { name: "@agent-teams/supply", feature: "genesis-manifest", version: "1" }, localFixtureArtifactSha256: `0x${"3".repeat(64)}`,
} as LocalGenesisManifest;

test("artifact write is content addressed, fsynced, READY-last and never silently reused", async (context) => {
  const root = await makeTemp("artifact"); context.after(() => rm(root, { force: true, recursive: true })); const compiled = validManifest(), artifact = compiled.manifest!, bytes = compiled.canonicalBytes!, artifactJson = new TextDecoder().decode(bytes);
  const directory = await writeArtifact(root, artifact, bytes); assert.equal(await readFile(join(directory, "manifest.json"), "utf8"), artifactJson);
  const readyBytes = await readFile(join(directory, "READY"), "utf8"), ready = JSON.parse(readyBytes); assert.equal(ready.sourceSha256, artifact.sourceSha256);
  await assert.rejects(writeArtifact(root, artifact, bytes));
  assert.equal(await readFile(join(directory, "READY"), "utf8"), readyBytes);
  assert.equal((await inspectArtifacts(root)).length, 1);
  await writeFile(join(directory, "manifest.json"), artifactJson.replace(artifact.genesisAllocationHash, `0x${"f".repeat(64)}`));
  assert.deepEqual(await inspectArtifacts(root), []);
});

test("incomplete or stale directories without READY are never inspected", async (context) => {
  const root = await makeTemp("stale"); context.after(() => rm(root, { force: true, recursive: true })); const directory = join(root, "4".repeat(64)); await mkdir(directory); await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await inspectArtifacts(root), []);
});

test("a failure before READY removes the new content-addressed directory", async (context) => {
  const root = await makeTemp("failed-write"); context.after(() => rm(root, { force: true, recursive: true })); const compiled = validManifest(), artifact = compiled.manifest!;
  const directory = join(root, artifact.localFixtureArtifactSha256.slice(2));
  await assert.rejects(writeArtifact(root, artifact, null as unknown as Uint8Array));
  await assert.rejects(access(directory), { code: "ENOENT" });
});

test("symlink and hardlink sources and symlink output roots fail closed", async (context) => {
  const root = await makeTemp("links"); context.after(() => rm(root, { force: true, recursive: true })); const source = join(root, "source.yaml"), hard = join(root, "hard.yaml"), symbolic = join(root, "symbolic.yaml"), output = join(root, "output-link");
  await writeFile(source, "x: y\n"); await link(source, hard); await symlink(source, symbolic); await symlink(root, output);
  await assert.rejects(assertSafeSource(hard, join(root, "out")), /HARDLINK/);
  await assert.rejects(assertSafeSource(symbolic, join(root, "out")), /SYMLINK/);
  await assert.rejects(assertSafeSource(source, output), /HARDLINK|SYMLINK/);
});

test("write rejects a pre-existing symlink output root", async (context) => {
  const root = await makeTemp("output-root-link"); context.after(() => rm(root, { force: true, recursive: true }));
  const target = join(root, "target"), output = join(root, "output");
  await mkdir(target); await symlink(target, output);
  const compiled = validManifest();
  await assert.rejects(writeArtifact(output, compiled.manifest!, compiled.canonicalBytes!), /OUTPUT_ROOT_SYMLINK/);
  await assert.rejects(inspectArtifacts(output), /OUTPUT_ROOT_SYMLINK/);
  assert.deepEqual(await readdir(target), []);
});

test("inspection rejects a non-directory output root before reading", async (context) => {
  const root = await makeTemp("output-root-file"); context.after(() => rm(root, { force: true, recursive: true }));
  const output = join(root, "output"); await writeFile(output, "not a directory");
  await assert.rejects(inspectArtifacts(output), /OUTPUT_ROOT_NOT_DIRECTORY/);
});

test("write validates an untrusted runtime manifest before deriving its content-addressed path", async (context) => {
  const parent = await makeTemp("invalid-runtime"), root = join(parent, "output"); context.after(() => rm(parent, { force: true, recursive: true }));
  const compiled = validManifest(), valid = compiled.manifest!;
  const forged = { ...valid, localFixtureArtifactSha256: "../outside" } as unknown as LocalGenesisManifest;
  await assert.rejects(writeArtifact(root, forged, compiled.canonicalBytes!), /INVALID_MANIFEST/);
  const structurallyForged = withArtifactDigest({ ...structuredClone(valid), unexpected: true });
  await assert.rejects(writeArtifact(root, structurallyForged.manifest, structurallyForged.bytes), /INVALID_MANIFEST/);
  const semanticallyForgedValue = structuredClone(valid) as unknown as Record<string, unknown>;
  ((semanticallyForgedValue.allocations as Array<Record<string, unknown>>)[0]!).recipient = "0x0000000000000000000000000000000000002001";
  const semanticallyForged = withArtifactDigest(semanticallyForgedValue);
  await assert.rejects(writeArtifact(root, semanticallyForged.manifest, semanticallyForged.bytes), /INVALID_MANIFEST/);
  await assert.rejects(access(root), { code: "ENOENT" });
});

test("inspection rejects structurally forged manifests even with recomputed artifact digests", async (context) => {
  const root = await makeTemp("forged-shape"); context.after(() => rm(root, { force: true, recursive: true }));
  const original = validManifest().manifest!;
  const cases: unknown[] = [
    { ...structuredClone(original), unexpected: true },
    (() => { const value = structuredClone(original) as unknown as Record<string, unknown>; delete value.sourceSha256; return value; })(),
    { ...structuredClone(original), rawAllocationAbi: 7 },
    { ...structuredClone(original), allocations: [{ ...original.allocations[0], recipient: false }] },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const caseRoot = join(root, String(index)); await mkdir(caseRoot);
    await writeForged(caseRoot, cases[index] as Record<string, unknown>, original.sourceSha256);
    assert.deepEqual(await inspectArtifacts(caseRoot), []);
  }
});

test("inspection rejects symlink and hardlink READY and manifest files before reading", async (context) => {
  const root = await makeTemp("linked-artifacts"); context.after(() => rm(root, { force: true, recursive: true }));
  for (const file of ["READY", "manifest.json"] as const) {
    for (const kind of ["symlink", "hardlink"] as const) {
      const caseRoot = join(root, `${file}-${kind}`); await mkdir(caseRoot);
      const compiled = validManifest(), directory = await writeArtifact(caseRoot, compiled.manifest!, compiled.canonicalBytes!);
      const path = join(directory, file), bytes = await readFile(path), external = join(caseRoot, `external-${file}`);
      await writeFile(external, bytes); await rm(path);
      if (kind === "symlink") {await symlink(external, path);} else {await link(external, path);}
      assert.deepEqual(await inspectArtifacts(caseRoot), []);
    }
  }
});

async function makeTemp(label: string): Promise<string> { const packageRoot = process.cwd().endsWith("/packages/contexts/supply") ? process.cwd() : resolve(process.cwd(), "packages/contexts/supply"), parent = join(packageRoot, "../../../.local"); await mkdir(parent, { recursive: true }); return mkdtemp(join(parent, `agtmai-${label}-`)); }
function validManifest(): ReturnType<typeof compileLocalSource> {
  const source: LocalGenesisSource = { schemaVersion: 1, purpose: "local-fixture", status: "test-only", network: { kind: "local-evm", chainId: "31337" }, token: { name: "Agent Teams AI", symbol: "AGTMAI", decimals: 9, initialSupplyBaseUnits: "1" }, allocations: [{ id: "a", recipient: "0x0000000000000000000000000000000000001001", amountBaseUnits: "1", bps: 10_000 }] };
  return compileLocalSource(source, { encodeAllocationCommitment, sha256 });
}

async function writeForged(root: string, value: Record<string, unknown>, sourceSha256: string): Promise<void> {
  const forged = withArtifactDigest(value), digest = forged.manifest.localFixtureArtifactSha256;
  const directory = join(root, digest.slice(2)); await mkdir(directory);
  await writeFile(join(directory, "manifest.json"), forged.bytes);
  await writeFile(join(directory, "READY"), `${JSON.stringify({ sourceSha256, localFixtureArtifactSha256: digest })}\n`);
}

function withArtifactDigest(value: Record<string, unknown>): { manifest: LocalGenesisManifest; bytes: Uint8Array } {
  const withoutDigest = { ...value }; delete withoutDigest.localFixtureArtifactSha256;
  const prefix = Buffer.from("AGTMAI_LOCAL_FIXTURE_ARTIFACT_V1\0", "ascii");
  const digest = sha256(Buffer.concat([prefix, Buffer.from(canonicalJson(withoutDigest as JsonValue), "utf8")]));
  const forgedManifest = { ...withoutDigest, localFixtureArtifactSha256: digest } as unknown as LocalGenesisManifest;
  return { manifest: forgedManifest, bytes: Buffer.from(canonicalJson(forgedManifest as unknown as JsonValue), "utf8") };
}
