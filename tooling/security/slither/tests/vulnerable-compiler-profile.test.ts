import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { evaluatePolicy, evaluateVulnerableFixture } from "../src/application/policy.ts";
import type { CompiledOutput, VulnerableCompilerRequest } from "../src/adapters/compiler-output.ts";
import { validateEvidenceBundleContents } from "../src/adapters/evidence-bundle.ts";
import { writeReadyEvidence } from "../src/adapters/evidence.ts";
import { sha256 } from "../src/adapters/fingerprint.ts";
import { assertSlitherStatus, parseCompiledOutput, parseGateManifest, parseSlitherExit } from "../src/adapters/runner.ts";
import { parseSlitherJson } from "../src/adapters/slither-json.ts";
import type { AnalysisInput, FindingTriage, GateManifest } from "../src/domain/model.ts";
import { makeTestDirectory } from "./test-directory.ts";
import { testPublication } from "./test-publication.ts";

// Historical byte-exact capture from the actual vulnerable stage at 09c19109,
// image nightly-20260824@sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0,
// sourceRevision 8cad443280f7eeb5920a901b5f58f5a91872d9aa. Replay is not fresh Docker acceptance.
const candidateSha = "035a1dd3845014ec764970849a498c35f127c189";
const schemaDirectory = "tooling/security/slither";
const fixtureDirectory = `${schemaDirectory}/tests/fixtures`;
// Both compiler captures belong to the retained two-token closure at 8977f78.
const manifestRaw = await readFile(`${fixtureDirectory}/production-closure.8977f78.json`, "utf8");
assert.equal(sha256(manifestRaw), "77d21b9e415f111463a5b014ce6a2ecd65e33685469131821cedfb351c10119e");
const manifest = parseGateManifest(manifestRaw);
const triageRaw = await readFile(`${fixtureDirectory}/triage.8977f78.json`, "utf8");
assert.equal(sha256(triageRaw), "da21f8a8a21ef827e4c96afc0d1a6a4527c63c5f66c6c1f7d46a915ad34c2cfe");
assert.equal(sha256(triageRaw), manifest.config.find(({ path }) => path === `${schemaDirectory}/triage.v1.json`)!.sha256);
type Json = Record<string, unknown>;
type Pair = { readonly build: string; readonly artifact: string };
const object = (value: unknown): Json => value as Json;
const parse = (value: string): Json => object(JSON.parse(value));
const captured: Pair = {
  build: await readFile(`${fixtureDirectory}/foundry-1.8.0-vulnerable-build-info.json`, "utf8"),
  artifact: await readFile(`${fixtureDirectory}/foundry-1.8.0-vulnerable-artifact.json`, "utf8"),
};
const production: Pair = {
  build: await readFile(`${fixtureDirectory}/foundry-1.8.0-production-build-info.json`, "utf8"),
  artifact: await readFile(`${fixtureDirectory}/foundry-1.8.0-production-artifact.json`, "utf8"),
};
const slither = await readFile(`${fixtureDirectory}/slither-0.11.6-vulnerable.json`, "utf8");
const request: VulnerableCompilerRequest = { scope: "vulnerable-fixture", fixture: manifest.vulnerableFixture };
const settings = (build: Json): Json => object(object(build.input).settings);
const target = (build: Json): Json => object(object(object(object(build.output).contracts)["src/Vulnerable.sol"]).Vulnerable);

async function sealedPair(directory: string, pair: Pair, artifactName: string): Promise<Parameters<typeof parseCompiledOutput>[1]> {
  await mkdir(directory, { recursive: true });
  return new Map(await Promise.all(([ ["build-info.json", pair.build], [artifactName, pair.artifact] ] as const).map(async ([name, bytes]) => {
    const path = join(directory, name); await writeFile(path, bytes);
    const info = await lstat(path, { bigint: true });
    return [name, { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, sha256: sha256(bytes) }] as const;
  })));
}
async function compileFixture(directory: string, pair = captured): Promise<CompiledOutput> {
  return await parseCompiledOutput(directory, await sealedPair(directory, pair, "Vulnerable.json"), request);
}
async function compileProduction(directory: string, pair = production): Promise<CompiledOutput<GateManifest["compiler"]>> {
  return await parseCompiledOutput(directory, await sealedPair(directory, pair, "AGTMAIToken.json"));
}
function proof(result: CompiledOutput): AnalysisInput["fixtureProof"] {
  return { sourceSha256: manifest.vulnerableFixture.source.sha256, buildInfoSha256: result.evidence.buildInfoSha256,
    artifactSha256: result.evidence.artifactSha256, abiSha256: result.evidence.abiSha256, creationBytecodeSha256: result.artifactBytecode,
    rawBuildInfo: result.evidence.rawBuildInfo, rawArtifact: result.evidence.rawArtifact };
}
async function bundle(parent: string): Promise<string> {
  const productionResult = await compileProduction(join(parent, "production"));
  const fixtureResult = await compileFixture(join(parent, "fixture"));
  const parsed = await parseSlitherJson(await readFile(`${fixtureDirectory}/slither-0.11.6-production.json`, "utf8"), process.cwd());
  const detectorInventory = parse(await readFile(manifest.detectorInventory.path, "utf8")).detectors as string[];
  const triage = parse(triageRaw).findings as FindingTriage[];
  const input: AnalysisInput = {
    success: parsed.success, findings: parsed.findings, analyzedContracts: manifest.expectedContracts,
    analyzedSources: manifest.sources.map(({ path }) => path.replace(/^contracts\/evm\//u, "")),
    closure: [...manifest.sources, ...manifest.config, manifest.detectorInventory], detectorInventory,
    compiler: productionResult.compiler, creationBytecodeSha256: productionResult.artifactBytecode,
    freshFoundryCreationBytecodeSha256: productionResult.buildInfoBytecode, analysisErrors: parsed.errors,
    forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256,
    compilerEvidence: productionResult.evidence, fixtureProof: proof(fixtureResult),
  };
  const decision = evaluatePolicy({ input, manifest, expectedDetectors: detectorInventory, suppressions: [], triage });
  assert.equal(decision.exitCode, 0, JSON.stringify(decision.errors));
  const canonicalDirectory = join(parent, "canonical");
  for (const entry of [...manifest.sources, ...manifest.config, manifest.detectorInventory, manifest.vulnerableFixture.source]) {
    const raw = entry.path === `${schemaDirectory}/triage.v1.json` ? triageRaw : await readFile(entry.path);
    assert.equal(sha256(raw), entry.sha256, entry.path);
    const destination = join(canonicalDirectory, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, raw);
  }
  for (const name of ["slither.config.json", "suppressions.v1.json", "triage.v1.json"]) {
    await writeFile(join(canonicalDirectory, name), name === "triage.v1.json" ? triageRaw : await readFile(`${schemaDirectory}/${name}`));
  }
  await writeFile(join(canonicalDirectory, "production-closure.v1.json"), manifestRaw);
  const output = join(parent, "bundle");
  await writeReadyEvidence({ output, candidateSha, manifest, input, decision, schemaDirectory, canonicalDirectory,
    hashes: { config: sha256(await readFile(`${schemaDirectory}/slither.config.json`)), policy: sha256(await readFile(`${schemaDirectory}/suppressions.v1.json`)) },
    triageHash: sha256(triageRaw), assertReadyPrecondition: async () => {}, publication: testPublication() });
  return output;
}
const validate = async (output: string): Promise<void> => await validateEvidenceBundleContents({ output, candidateSha, schemaDirectory, canonicalDirectory: join(dirname(output), "canonical"), finalizationMode: "local" });

test("actual isolated fixture preserves captures, source, compiler and bytecode pins and reaches policy exit 20", async () => {
  assert.equal(Buffer.byteLength(captured.build), 7635);
  assert.equal(sha256(captured.build), "07c1537839c8175a1c24079ce8a2f2b1f7544dbf9d616d44e1546198065fbf59");
  assert.equal(Buffer.byteLength(captured.artifact), 5881);
  assert.equal(sha256(captured.artifact), "58d17d621a5a3ced54ea22b45624a5504a7468f39702ada84aeb050f1833988b");
  assert.equal(Buffer.byteLength(slither), 2095);
  assert.equal(sha256(slither), "5bf7cf58549061dec799e8ab872e530b774df92e294e160663e0e64e62740915");
  assert.equal(manifest.vulnerableFixture.creationBytecodeSha256, "533f8e0f5752adb0c75003392f5090dedf3765318dbe130c90bb9bd26b594ee9");
  const build = parse(captured.build); const artifact = parse(captured.artifact);
  assert.equal(Object.hasOwn(settings(build), "remappings"), false);
  assert.deepEqual(settings(build).libraries, {});
  assert.equal(build.solcVersion, "0.8.36"); assert.equal(build.solcLongVersion, "0.8.36");
  assert.equal(object(parse(target(build).metadata as string).compiler).version, "0.8.36+commit.8a079791");
  const parent = await makeTestDirectory("vulnerable-profile-capture-");
  try {
    const result = await compileFixture(join(parent, "raw"));
    assert.deepEqual(result.compiler, { ...manifest.compiler, remappings: [] });
    assert.notDeepEqual(result.compiler, manifest.compiler);
    assert.equal(result.evidence.rawBuildInfo, captured.build); assert.equal(result.evidence.rawArtifact, captured.artifact);
    assert.equal(result.artifactBytecode, manifest.vulnerableFixture.creationBytecodeSha256);
    assert.equal(result.buildInfoBytecode, result.artifactBytecode);
    assert.equal(result.evidence.abiSha256, sha256(JSON.stringify(artifact.abi)));
    const source = await readFile(manifest.vulnerableFixture.source.path);
    assert.equal(sha256(source), manifest.vulnerableFixture.source.sha256);
    assert.deepEqual(result.evidence.sourceHashes, [{ path: "src/Vulnerable.sol", sha256: sha256(source) }]);
    await mkdir(join(parent, "contracts/evm/src"), { recursive: true });
    await writeFile(join(parent, "contracts/evm/src/Vulnerable.sol"), source);
    const parsed = await parseSlitherJson(slither, parent);
    assertSlitherStatus(parsed.success, parsed.errors, parsed.findings.length, parseSlitherExit("255\n"));
    assert.equal(parsed.findings.length, 1); assert.equal(parsed.findings[0]?.detectorId, "suicidal");
    assert.equal(evaluateVulnerableFixture(parsed.findings, sha256(source)).exitCode, 20);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("full actual raw pair finalizes independently using the unchanged canonical production and vulnerable pins", async () => {
  const parent = await makeTestDirectory("vulnerable-profile-finalized-");
  try {
    const output = await bundle(parent); await validate(output);
    for (const [name, bytes] of [["build-info.json", production.build], ["artifact.json", production.artifact], ["fixture-build-info.json", captured.build], ["fixture-artifact.json", captured.artifact]] as const) {
      assert.equal(await readFile(join(output, name), "utf8"), bytes);
    }
    assert.equal((await readFile(join(output, "READY"))).length, 0);
    const evidence = parse(await readFile(join(output, "evidence.json"), "utf8"));
    assert.deepEqual(object(object(object(evidence.analysis).compiler).compilerSettings).remappings, manifest.compiler.remappings);
    assert.equal(object(object(evidence.analysis).fixture).creationBytecodeSha256, `sha256:${manifest.vulnerableFixture.creationBytecodeSha256}`);
  } finally {await rm(parent, { recursive: true, force: true });}
});

function mutation(change: (build: Json, artifact: Json) => void, pair = captured): Pair {
  const build = parse(pair.build); const artifact = parse(pair.artifact); change(build, artifact);
  return { build: JSON.stringify(build), artifact: JSON.stringify(artifact) };
}
function metadataMutation(build: Json, artifact: Json, change: (metadata: Json) => void): void {
  const raw = parse(target(build).metadata as string); change(raw); target(build).metadata = JSON.stringify(raw);
  artifact.rawMetadata = JSON.stringify(raw); change(object(artifact.metadata));
}
async function rewrite(output: string, original: string, pair: Pair, isolated = true): Promise<void> {
  const evidence = parse(original); const entry = object(object(evidence.analysis)[isolated ? "fixture" : "compiler"]);
  const build = parse(pair.build); const artifact = parse(pair.artifact); const input = object(build.input);
  entry.buildInfoSha256 = `sha256:${sha256(pair.build)}`; entry.artifactSha256 = `sha256:${sha256(pair.artifact)}`;
  if (Array.isArray(artifact.abi)) {entry.abiSha256 = `sha256:${sha256(JSON.stringify(artifact.abi))}`;}
  const bytecode = object(artifact.bytecode).object as string;
  entry.creationBytecodeSha256 = `sha256:${sha256(Buffer.from(bytecode.replace(/^0x/u, ""), "hex"))}`;
  if (!isolated) {
    entry.compilerInput = input; entry.compilerSettings = input.settings;
    entry.compilerInputSha256 = `sha256:${sha256(JSON.stringify(input))}`;
    entry.compilerSettingsSha256 = `sha256:${sha256(JSON.stringify(input.settings))}`;
    entry.creationBytecode = bytecode;
    entry.sourceHashes = Object.entries(object(input.sources)).map(([path, value]) => ({ path, sha256: `sha256:${sha256(object(value).content as string)}` })).toSorted((a, b) => a.path.localeCompare(b.path));
  } else {
    const content = object(object(input.sources)["src/Vulnerable.sol"] ?? {}).content;
    if (typeof content === "string") {entry.sourceSha256 = `sha256:${sha256(content)}`;}
  }
  await writeFile(join(output, isolated ? "fixture-build-info.json" : "build-info.json"), pair.build);
  await writeFile(join(output, isolated ? "fixture-artifact.json" : "artifact.json"), pair.artifact);
  await writeFile(join(output, "evidence.json"), JSON.stringify(evidence));
}

function hostileFixtures(): [string, Pair][] {
  const cases: [string, Pair][] = [];
  for (const value of [null, {}, "", 0, false, [null], [1], [""], ["x/=lib/x/"], manifest.compiler.remappings]) {
    cases.push([`input remappings ${JSON.stringify(value)}`, mutation((build) => {settings(build).remappings = value;})]);
  }
  for (const [key, value] of [["evmVersion", "cancun"], ["viaIR", true], ["experimental", true], ["viaSSACFG", true], ["libraries", []], ["libraries", { "src/Vulnerable.sol": {} }], ["debug", {}]] as const) {
    cases.push([`input ${key} ${JSON.stringify(value)}`, mutation((build) => {settings(build)[key] = value;})]);
  }
  for (const key of ["evmVersion", "optimizer", "metadata", "viaIR", "experimental", "libraries"]) {
    cases.push([`missing ${key}`, mutation((build) => {delete settings(build)[key];})]);
  }
  for (const [section, key, value] of [["optimizer", "enabled", false], ["optimizer", "runs", "200"], ["optimizer", "runs", 201], ["optimizer", "details", {}], ["metadata", "appendCBOR", false], ["metadata", "useLiteralContent", true], ["metadata", "bytecodeHash", "none"], ["metadata", "extra", false]] as const) {
    cases.push([`${section}.${key}`, mutation((build) => {object(settings(build)[section])[key] = value;})]);
  }
  cases.push(["source content substituted", mutation((build) => {object(object(object(build.input).sources)["src/Vulnerable.sol"]).content += "\n// substituted\n";})]);
  cases.push(["source URL supplied alongside content", mutation((build) => {object(object(object(build.input).sources)["src/Vulnerable.sol"]).urls = ["https://example.invalid/source"];})]);
  for (const [key, value] of [["version", "0.8.35"], ["language", "Yul"], ["basePath", "/tmp/foreign"], ["includePaths", ["/tmp/foreign"]], ["allowPaths", ["/"]], ["scope", "production"]] as const) {
    cases.push([`input scope ${key}`, mutation((build) => {object(build.input)[key] = value;})]);
  }
  cases.push(["extra input source", mutation((build) => {object(object(build.input).sources)["src/Extra.sol"] = { content: "contract Extra {}" };})]);
  cases.push(["extra output source", mutation((build) => {object(object(build.output).sources)["src/Extra.sol"] = {};})]);
  cases.push(["extra output contract", mutation((build) => {object(object(object(build.output).contracts)["src/Vulnerable.sol"]).Extra = target(build);})]);
  cases.push(["extra output contract source", mutation((build) => {object(object(build.output).contracts)["src/Extra.sol"] = { Extra: target(build) };})]);
  cases.push(["source map substitution", mutation((build) => {build.source_id_to_path = { "0": "src/Extra.sol" };})]);
  cases.push(["coherent bytecode substitution", mutation((build, artifact) => {object(object(target(build).evm).bytecode).object = "6000"; object(artifact.bytecode).object = "0x6000";})]);
  cases.push(["build bytecode invalid suffix", mutation((build) => {object(object(target(build).evm).bytecode).object += "zz";})]);
  cases.push(["missing ABI", mutation((_build, artifact) => {delete artifact.abi;})]);
  cases.push(["coherent artifact and build ABI substitution", mutation((build, artifact) => {artifact.abi = []; target(build).abi = [];})]);
  for (const [key, value] of [["remappings", manifest.compiler.remappings], ["remappings", {}], ["remappings", null], ["evmVersion", "cancun"], ["optimizer", { enabled: true, runs: 201 }], ["libraries", { X: "0x00" }], ["metadata", { bytecodeHash: "none" }], ["compilationTarget", { "src/Other.sol": "Vulnerable" }]] as const) {
    cases.push([`coherent embedded metadata ${key} ${JSON.stringify(value)}`, mutation((build, artifact) => {
      metadataMutation(build, artifact, (document) => {object(document.settings)[key] = value;});
    })]);
  }
  cases.push(["coherent metadata extra source", mutation((build, artifact) => {metadataMutation(build, artifact, (document) => {object(document.sources)["src/Extra.sol"] = {};});})]);
  cases.push(["artifact metadata profile differs alone", mutation((_build, artifact) => {object(object(artifact.metadata).settings).remappings = manifest.compiler.remappings;})]);
  for (const field of ["solcVersion", "solcLongVersion"]) {
    for (const value of [undefined, "0.8.36+commit.8a079791", "0.8.35", null]) {
      cases.push([`${field} ${JSON.stringify(value)}`, mutation((build) => {build[field] = value;})]);
    }
  }
  cases.push(["coherent wrong full compiler commit", mutation((build, artifact) => {metadataMutation(build, artifact, (document) => {object(document.compiler).version = "0.8.36+commit.deadbeef";});})]);
  cases.push(["metadata absent", mutation((build) => {delete target(build).metadata;})]);
  cases.push(["duplicate remappings", { ...captured, build: captured.build.replace('"settings":{', '"settings":{"remappings":[],"remappings":[],') }]);
  cases.push(["production raw pair relabelled as fixture", production]);
  return cases;
}

test("producer and finalized independent consumer reject hostile fixture scope and profiles after coherent rehashing", async (context) => {
  const parent = await makeTestDirectory("vulnerable-profile-hostile-");
  try {
    const output = await bundle(parent); const original = await readFile(join(output, "evidence.json"), "utf8");
    for (const [name, pair] of hostileFixtures()) {
      await context.test(name, async () => {
        assert.notDeepEqual(pair, captured);
        await assert.rejects(compileFixture(join(parent, "hostile"), pair), (error: unknown) => {
          assert.match(String(object(error).code), /^(?:BUILD_INFO_INVALID|COMPILER_SETTINGS_MISMATCH|BYTECODE_MISSING)$/u); return true;
        });
        // Bypass the producer for the consumer test and recompute every affected
        // serialized digest. A producer failure or stale digest is not evidence.
        await rewrite(output, original, pair);
        await assert.rejects(validate(output), (error: unknown) => {
          if (name !== "duplicate remappings") {assert.equal(object(error).code, "EVIDENCE_BUNDLE_INVALID");}
          assert.match(String(object(error).message), /compiler|metadata|remappings|optimizer|libraries|ABI|bytecode|scope|source output|string|duplicate JSON/u);
          return true;
        });
      });
    }
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("production still rejects absent, empty and hostile remappings independently; empty fixture array is explicit", async (context) => {
  const parent = await makeTestDirectory("vulnerable-profile-separation-");
  try {
    const output = await bundle(parent); const original = await readFile(join(output, "evidence.json"), "utf8");
    for (const value of [undefined, [], null, {}, "", [1], ["wrong/=lib/"], [manifest.compiler.remappings[0]], [...manifest.compiler.remappings, manifest.compiler.remappings[0]]]) {
      await context.test(`production remappings ${JSON.stringify(value)}`, async () => {
        const pair = mutation((build) => {settings(build).remappings = value;}, production);
        await assert.rejects(compileProduction(join(parent, "hostile-production"), pair), { code: "COMPILER_SETTINGS_MISMATCH" });
        await rewrite(output, original, pair, false);
        await assert.rejects(validate(output), /remappings|raw compiler settings|expected string/u);
      });
    }
    await rewrite(output, original, production, false);
    const empty = mutation((build) => {settings(build).remappings = [];});
    const result = await compileFixture(join(parent, "empty-fixture"), empty);
    assert.deepEqual(result.compiler.remappings, []);
    await rewrite(output, original, empty); await validate(output);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("compiler caller scope and authenticated raw-file seal cannot be selected or overridden by artifact data", async (context) => {
  const parent = await makeTestDirectory("vulnerable-profile-caller-");
  try {
    const sealed = await sealedPair(parent, captured, "Vulnerable.json");
    for (const value of [null, false, "Vulnerable.json", {}, { scope: "production", fixture: manifest.vulnerableFixture },
      { ...request, sourceName: "src/Vulnerable.sol" }, { ...request, artifactName: "Vulnerable.json" },
      { ...request, fixture: { ...manifest.vulnerableFixture, source: { ...manifest.vulnerableFixture.source, path: "src/Vulnerable.sol" } } },
      { ...request, fixture: { ...manifest.vulnerableFixture, source: { ...manifest.vulnerableFixture.source, sha256: "0".repeat(64) } } },
      { ...request, fixture: { ...manifest.vulnerableFixture, creationBytecodeSha256: "0".repeat(64) } }]) {
      await context.test(`caller ${JSON.stringify(value)}`, async () => {
        await assert.rejects(parseCompiledOutput(parent, sealed, value as VulnerableCompilerRequest), { code: "BUILD_INFO_INVALID" });
      });
    }
    await context.test("default production scope cannot parse relabelled fixture output", async () => {
      await assert.rejects(compileProduction(join(parent, "relabeled"), captured), { code: "BUILD_INFO_INVALID" });
    });
    await context.test("changed raw file does not inherit a previous seal", async () => {
      await writeFile(join(parent, "build-info.json"), `${captured.build}\n`);
      await assert.rejects(parseCompiledOutput(parent, sealed, request), /missing or unreadable/u);
    });
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("finalized fixture summary must equal independent reconstruction of every actual digest", async (context) => {
  const parent = await makeTestDirectory("vulnerable-profile-summary-");
  try {
    const output = await bundle(parent); const original = await readFile(join(output, "evidence.json"), "utf8");
    for (const field of ["sourceSha256", "buildInfoSha256", "artifactSha256", "abiSha256", "creationBytecodeSha256"]) {
      await context.test(field, async () => {
        const evidence = parse(original); object(object(evidence.analysis).fixture)[field] = `sha256:${"0".repeat(64)}`;
        await writeFile(join(output, "evidence.json"), JSON.stringify(evidence));
        await assert.rejects(validate(output), /bytecode or tool identity differs from canonical inputs/u);
      });
    }
  } finally {await rm(parent, { recursive: true, force: true });}
});
