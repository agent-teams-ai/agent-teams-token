import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { evaluatePolicy } from "../src/application/policy.ts";
import { validateEvidenceBundleContents } from "../src/adapters/evidence-bundle.ts";
import { writeReadyEvidence } from "../src/adapters/evidence.ts";
import { sha256 } from "../src/adapters/fingerprint.ts";
import { parseCompiledOutput, parseGateManifest } from "../src/adapters/runner.ts";
import { parseSlitherJson } from "../src/adapters/slither-json.ts";
import type { AnalysisInput, FindingTriage, GateManifest } from "../src/domain/model.ts";
import type { CompiledOutput } from "../src/adapters/compiler-output.ts";
import { makeCompilerEvidence } from "./test-compiler-evidence.ts";
import { makeTestDirectory } from "./test-directory.ts";
import { testPublication } from "./test-publication.ts";

// Byte-exact compilerEvidence from product-slither-reviewed-capture.json,
// reviewed 2026-09-08 for the current two-token closure.
// Image nightly-20260824@sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0,
// sourceRevision 8cad443280f7eeb5920a901b5f58f5a91872d9aa. This is replay,
// not a newly observed container run or a real vulnerable-fixture acceptance.
const base = "8a56dc28ff55af87f9d0e04ca3cfef0602d950f4";
const schemaDirectory = "tooling/security/slither";
const sourceName = "src/features/token-genesis/AGTMAIToken.sol";
const version = "0.8.36+commit.8a079791";
const buildRaw = await readFile(`${schemaDirectory}/tests/fixtures/foundry-1.8.0-production-build-info.json`, "utf8");
const artifactRaw = await readFile(`${schemaDirectory}/tests/fixtures/foundry-1.8.0-production-artifact.json`, "utf8");
const manifest = parseGateManifest(await readFile(`${schemaDirectory}/production-closure.v1.json`, "utf8"));
type Json = Record<string, unknown>;
type Pair = { build: string; artifact: string };
const captured: Pair = { build: buildRaw, artifact: artifactRaw };
const object = (value: unknown): Json => value as Json;
const parse = (value: string): Json => object(JSON.parse(value));
const contracts = (build: Json): Json[] => Object.values(object(object(build.output).contracts)).flatMap((source) => Object.values(object(source)).map(object));
const target = (build: Json): Json => object(object(object(object(build.output).contracts)[sourceName]).AGTMAIToken);

async function compiled(directory: string, pair?: Pair, fixture?: false): Promise<CompiledOutput<GateManifest["compiler"]>>;
async function compiled(directory: string, pair: Pair, fixture: true): Promise<CompiledOutput>;
async function compiled(directory: string, pair: Pair = captured, fixture = false): Promise<CompiledOutput> {
  await mkdir(directory, { recursive: true });
  const artifactName = fixture ? "Vulnerable.json" : "AGTMAIToken.json";
  const entries = await Promise.all(([ ["build-info.json", pair.build], [artifactName, pair.artifact] ] as const).map(async ([name, raw]) => {
    const path = join(directory, name);
    await writeFile(path, raw);
    const info = await lstat(path, { bigint: true });
    return [name, { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, sha256: sha256(raw) }] as const;
  }));
  return fixture
    ? await parseCompiledOutput(directory, new Map(entries), { scope: "vulnerable-fixture", fixture: makeCompilerEvidence("unused\n").vulnerableFixture })
    : await parseCompiledOutput(directory, new Map(entries));
}

async function makeBundle(parent: string): Promise<{ output: string; canonicalDirectory: string }> {
  const output = join(parent, "bundle"); const canonicalDirectory = join(parent, "canonical");
  const result = await compiled(join(parent, "raw"));
  // Only the vulnerable proof is synthetic. Preserve the actual production
  // source/config/bytecode/tool pins; no Docker or contract build is invoked.
  const synthetic = makeCompilerEvidence("unused\n");
  const accepted = { ...manifest, vulnerableFixture: synthetic.vulnerableFixture };
  for (const entry of [...manifest.sources, ...manifest.config, manifest.detectorInventory]) {
    const destination = join(canonicalDirectory, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(entry.path));
  }
  await mkdir(dirname(join(canonicalDirectory, accepted.vulnerableFixture.source.path)), { recursive: true });
  await writeFile(join(canonicalDirectory, accepted.vulnerableFixture.source.path), synthetic.fixtureSource);
  for (const name of ["slither.config.json", "suppressions.v1.json", "triage.v1.json"]) {
    await writeFile(join(canonicalDirectory, name), await readFile(`${schemaDirectory}/${name}`));
  }
  await writeFile(join(canonicalDirectory, "production-closure.v1.json"), JSON.stringify(accepted));
  const detectorInventory = (parse(await readFile(manifest.detectorInventory.path, "utf8")).detectors as string[]);
  const parsed = await parseSlitherJson(await readFile(`${schemaDirectory}/tests/fixtures/slither-0.11.6-production.json`, "utf8"), process.cwd());
  const input: AnalysisInput = {
    success: parsed.success, findings: parsed.findings, analyzedContracts: manifest.expectedContracts,
    analyzedSources: manifest.sources.map(({ path }) => path.replace(/^contracts\/evm\//u, "")),
    closure: [...manifest.sources, ...manifest.config, manifest.detectorInventory], detectorInventory,
    compiler: result.compiler, creationBytecodeSha256: result.artifactBytecode,
    freshFoundryCreationBytecodeSha256: result.buildInfoBytecode, analysisErrors: parsed.errors,
    forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256,
    compilerEvidence: result.evidence, fixtureProof: synthetic.fixtureProof,
  };
  const triage = parse(await readFile(`${schemaDirectory}/triage.v1.json`, "utf8")).findings as FindingTriage[];
  const decision = evaluatePolicy({ input, manifest: accepted, expectedDetectors: detectorInventory, suppressions: [], triage });
  assert.equal(parsed.findings.length, 12);
  assert.equal(detectorInventory.length, 101);
  assert.equal(decision.exitCode, 0, JSON.stringify(decision.errors));
  assert.equal(decision.category, "clean");
  assert.equal(decision.blocking.length, 0);
  assert.equal(decision.visible.length, 12);
  assert.equal(decision.suppressed.length, 0);
  await writeReadyEvidence({ output, candidateSha: base, manifest: accepted, input, decision,
    hashes: { config: sha256(await readFile(`${schemaDirectory}/slither.config.json`)), policy: sha256(await readFile(`${schemaDirectory}/suppressions.v1.json`)) },
    triageHash: sha256(await readFile(`${schemaDirectory}/triage.v1.json`)), schemaDirectory, canonicalDirectory,
    assertReadyPrecondition: async () => {}, publication: testPublication() });
  return { output, canonicalDirectory };
}
const validate = async (bundle: { output: string; canonicalDirectory: string }): Promise<void> => await validateEvidenceBundleContents({ ...bundle, candidateSha: base, schemaDirectory, finalizationMode: "local" });

test("captured Foundry output preserves exact raw bytes, all 9 compiler commits and production pins", async () => {
  assert.equal(Buffer.byteLength(buildRaw), 429063);
  assert.equal(sha256(buildRaw), "2b3d02abe8852d9ccaeded88f6aab3c0c88273041d7b5401a9623f0324469d1d");
  assert.equal(Buffer.byteLength(artifactRaw), 132501);
  assert.equal(sha256(artifactRaw), "460107665721878a8c9c27bdc308b59a53a627b8f5e715ac9e09e45409084c41");
  const build = parse(buildRaw); const artifact = parse(artifactRaw);
  assert.equal(build.solcVersion, "0.8.36"); assert.equal(build.solcLongVersion, "0.8.36");
  assert.equal(contracts(build).length, 9);
  for (const contract of contracts(build)) {assert.equal(object(parse(contract.metadata as string).compiler).version, version);}
  assert.equal(object(object(artifact.metadata).compiler).version, version);
  assert.deepEqual(parse(artifact.rawMetadata as string), parse(target(build).metadata as string));
  const parent = await makeTestDirectory("compiler-captured-");
  try {
    const result = await compiled(join(parent, "raw"));
    assert.deepEqual(result.compiler, manifest.compiler);
    assert.equal(result.artifactBytecode, "56d021ec13df6cccbc5d330ccad2acd567f5b4cb75665a0d9982604306c92493");
    assert.equal(result.buildInfoBytecode, manifest.creationBytecodeSha256);
    assert.equal(result.evidence.rawBuildInfo, buildRaw); assert.equal(result.evidence.rawArtifact, artifactRaw);
    assert.equal(result.evidence.abiSha256, sha256(JSON.stringify(artifact.abi)));
    assert.deepEqual(result.evidence.sourceHashes, manifest.sources.map(({ path, sha256: hash }) => ({ path: path.replace(/^contracts\/evm\//u, ""), sha256: hash })).toSorted((a, b) => a.path.localeCompare(b.path)));
    for (const entry of [...manifest.sources, ...manifest.config, manifest.detectorInventory]) {assert.equal(sha256(await readFile(entry.path)), entry.sha256, entry.path);}
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("actual compiled-output producer reaches READY-last publication and independent finalized consumer", async () => {
  const parent = await makeTestDirectory("compiler-finalized-");
  try {
    const bundle = await makeBundle(parent); await validate(bundle);
    assert.equal((await readFile(join(bundle.output, "READY"))).length, 0);
    assert.equal(await readFile(join(bundle.output, "build-info.json"), "utf8"), buildRaw);
    assert.equal(await readFile(join(bundle.output, "artifact.json"), "utf8"), artifactRaw);
  } finally {await rm(parent, { recursive: true, force: true });}
});

function mutation(change: (build: Json, artifact: Json) => void): Pair {
  const build = parse(buildRaw); const artifact = parse(artifactRaw); change(build, artifact);
  return { build: JSON.stringify(build), artifact: JSON.stringify(artifact) };
}
function allVersions(build: Json, artifact: Json, value: unknown): void {
  for (const contract of contracts(build)) {
    const metadata = parse(contract.metadata as string); object(metadata.compiler).version = value; contract.metadata = JSON.stringify(metadata);
  }
  object(object(artifact.metadata).compiler).version = value;
  const raw = parse(artifact.rawMetadata as string); object(raw.compiler).version = value; artifact.rawMetadata = JSON.stringify(raw);
}
function hostilePairs(): [string, Pair][] {
  const cases: [string, Pair][] = [];
  for (const field of ["solcVersion", "solcLongVersion"]) {
    for (const value of [undefined, null, 836, [], {}, "", "0.8.35", version, "0.8.360", "0.8.36-dev", "0.8.36\n"]) {
      cases.push([`${field} ${JSON.stringify(value)}`, mutation((build) => {build[field] = value;})]);
    }
    cases.push([`${field} duplicate`, { ...captured, build: buildRaw.replace(`"${field}":"0.8.36"`, `"${field}":"0.8.36","${field}":"0.8.36"`) }]);
  }
  for (const value of [undefined, null, 836, {}, [version], "", "0.8.36", "0.8.36+commit.deadbeef", `${version}.Linux.g++`, `${version}-forged`, `${version}\n`]) {
    cases.push([`coherent embedded identity ${JSON.stringify(value)}`, mutation((build, artifact) => {allVersions(build, artifact, value);})]);
  }
  cases.push(["coherent alternate release", mutation((build, artifact) => {build.solcVersion = "0.8.35"; build.solcLongVersion = "0.8.35"; allVersions(build, artifact, "0.8.35+commit.deadbeef");})]);
  for (let index = 0; index < contracts(parse(buildRaw)).length; index += 1) {
    cases.push([`wrong commit in contract ${index}`, mutation((build) => {
      const contract = contracts(build)[index]!; const metadata = parse(contract.metadata as string);
      object(metadata.compiler).version = "0.8.36+commit.deadbeef"; contract.metadata = JSON.stringify(metadata);
    })]);
  }
  for (const value of [undefined, null, [], {}, 1, "", "{}", "{", "null", "[]", '"metadata"']) {
    cases.push([`build metadata ${JSON.stringify(value)}`, mutation((build) => {target(build).metadata = value;})]);
    cases.push([`artifact raw metadata ${JSON.stringify(value)}`, mutation((_build, artifact) => {artifact.rawMetadata = value;})]);
  }
  for (const value of [undefined, null, [], 1, "", "{}", {}]) {
    cases.push([`artifact object metadata ${JSON.stringify(value)}`, mutation((_build, artifact) => {artifact.metadata = value;})]);
  }
  for (const value of [undefined, null, [], 1, "compiler", {}, { version, extra: version }]) {
    cases.push([`coherent compiler object ${JSON.stringify(value)}`, mutation((build, artifact) => {
      for (const contract of contracts(build)) {const metadata = parse(contract.metadata as string); metadata.compiler = value; contract.metadata = JSON.stringify(metadata);}
      object(artifact.metadata).compiler = value;
      const metadata = parse(artifact.rawMetadata as string); metadata.compiler = value; artifact.rawMetadata = JSON.stringify(metadata);
    })]);
  }
  for (const raw of [`{"compiler":{"version":"${version}","version":"${version}"}}`, `{"compiler":{"version":"${version}"},"compiler":{"version":"${version}"}}`, `{"compiler":{"version":"${version}","ver\\u0073ion":"${version}"}}`]) {
    cases.push([`embedded duplicate ${raw}`, mutation((build, artifact) => {target(build).metadata = raw; artifact.rawMetadata = raw;})]);
    cases.push([`raw artifact duplicate ${raw}`, mutation((_build, artifact) => {artifact.rawMetadata = raw;})]);
  }
  cases.push(["artifact object duplicate version", { ...captured, artifact: artifactRaw.replace(`"compiler":{"version":"${version}"}`, `"compiler":{"version":"${version}","version":"${version}"}`) }]);
  cases.push(["artifact object wrong commit alone", mutation((_build, artifact) => {object(object(artifact.metadata).compiler).version = "0.8.36+commit.deadbeef";})]);
  cases.push(["conflicting raw artifact metadata", mutation((_build, artifact) => {const raw = parse(artifact.rawMetadata as string); object(raw.settings).evmVersion = "cancun"; artifact.rawMetadata = JSON.stringify(raw);})]);
  cases.push(["absent output metadata", mutation((build) => {object(build.output).contracts = {};})]);
  cases.push(["empty contract set", mutation((build) => {object(object(build.output).contracts).empty = {};})]);
  return cases;
}

test("producer and finalized consumer reject coherent hostile compiler formats and metadata", async (context) => {
  const parent = await makeTestDirectory("compiler-hostile-");
  try {
    const bundle = await makeBundle(parent);
    const originalEvidence = await readFile(join(bundle.output, "evidence.json"), "utf8");
    for (const [name, pair] of hostilePairs()) {
      await context.test(name, async () => {
        assert.notDeepEqual(pair, captured, "hostile mutation must actually change captured bytes");
        await assert.rejects(compiled(join(parent, "hostile"), pair), { code: "BUILD_INFO_INVALID" });
        // Rehash the envelope coherently, so stale digests cannot explain the
        // independent consumer's rejection of the hostile embedded identities.
        const evidence = parse(originalEvidence); const compiler = object(object(evidence.analysis).compiler);
        compiler.buildInfoSha256 = `sha256:${sha256(pair.build)}`;
        compiler.artifactSha256 = `sha256:${sha256(pair.artifact)}`;
        await writeFile(join(bundle.output, "build-info.json"), pair.build);
        await writeFile(join(bundle.output, "artifact.json"), pair.artifact);
        await writeFile(join(bundle.output, "evidence.json"), JSON.stringify(evidence));
        await assert.rejects(validate(bundle), /compiler|metadata|duplicate JSON key|source output/u);
      });
    }
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("synthetic vulnerable compiler output uses the same strict producer and finalized-consumer checks", async (context) => {
  const parent = await makeTestDirectory("compiler-vulnerable-");
  try {
    const bundle = await makeBundle(parent);
    const raw = { build: await readFile(join(bundle.output, "fixture-build-info.json"), "utf8"), artifact: await readFile(join(bundle.output, "fixture-artifact.json"), "utf8") };
    await compiled(join(parent, "fixture"), raw, true);
    const original = await readFile(join(bundle.output, "evidence.json"), "utf8");
    for (const name of ["missing long version", "wrong commit", "artifact object missing", "embedded duplicate"]) {
      await context.test(name, async () => {
        const build = parse(raw.build); const artifact = parse(raw.artifact);
        if (name === "missing long version") {delete build.solcLongVersion;}
        if (name === "wrong commit") {allVersions(build, artifact, "0.8.36+commit.deadbeef");}
        if (name === "artifact object missing") {delete artifact.metadata;}
        if (name === "embedded duplicate") {
          const duplicate = `{"compiler":{"version":"${version}","version":"${version}"}}`;
          contracts(build)[0]!.metadata = duplicate; artifact.rawMetadata = duplicate;
        }
        const pair = { build: JSON.stringify(build), artifact: JSON.stringify(artifact) };
        await assert.rejects(compiled(join(parent, "fixture"), pair, true), { code: "BUILD_INFO_INVALID" });
        const evidence = parse(original); const proof = object(object(evidence.analysis).fixture);
        proof.buildInfoSha256 = `sha256:${sha256(pair.build)}`; proof.artifactSha256 = `sha256:${sha256(pair.artifact)}`;
        await writeFile(join(bundle.output, "fixture-build-info.json"), pair.build);
        await writeFile(join(bundle.output, "fixture-artifact.json"), pair.artifact);
        await writeFile(join(bundle.output, "evidence.json"), JSON.stringify(evidence));
        await assert.rejects(validate(bundle), /compiler|metadata/u);
      });
    }
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("real compiler capture still enforces source, profile, bytecode, ABI, tool and finalized bundle authority", async (context) => {
  const parent = await makeTestDirectory("compiler-authority-");
  try {
    const bundle = await makeBundle(parent);
    const original = await readFile(join(bundle.output, "evidence.json"), "utf8");
    const cases: [string, Pair, RegExp][] = [
      ["coherent source substitution", mutation((build) => {const source = object(object(object(build.input).sources)[sourceName]); source.content = `${source.content as string}\n// substituted\n`;}), /per-source hashes differ/u],
      ["coherent bytecode substitution", mutation((build, artifact) => {object(object(target(build).evm).bytecode).object = "6000"; object(artifact.bytecode).object = "0x6000";}), /creation bytecode differs from manifest pins/u],
      ["compiler settings substitution", mutation((build) => {object(object(build.input).settings).evmVersion = "cancun";}), /raw compiler settings differ/u],
      ["missing ABI", mutation((_build, artifact) => {delete artifact.abi;}), /artifact ABI/u],
    ];
    for (const [name, pair, expected] of cases) {
      await context.test(name, async () => {
        const evidence = parse(original); const compiler = object(object(evidence.analysis).compiler);
        const build = parse(pair.build); const artifact = parse(pair.artifact); const input = object(build.input);
        compiler.buildInfoSha256 = `sha256:${sha256(pair.build)}`; compiler.artifactSha256 = `sha256:${sha256(pair.artifact)}`;
        compiler.compilerInput = input; compiler.compilerInputSha256 = `sha256:${sha256(JSON.stringify(input))}`;
        compiler.compilerSettings = input.settings; compiler.compilerSettingsSha256 = `sha256:${sha256(JSON.stringify(input.settings))}`;
        compiler.sourceHashes = Object.entries(object(input.sources)).map(([path, source]) => ({ path, sha256: `sha256:${sha256(object(source).content as string)}` })).toSorted((a, b) => a.path.localeCompare(b.path));
        compiler.creationBytecode = object(artifact.bytecode).object;
        compiler.creationBytecodeSha256 = `sha256:${sha256(Buffer.from((compiler.creationBytecode as string).replace(/^0x/u, ""), "hex"))}`;
        await writeFile(join(bundle.output, "build-info.json"), pair.build);
        await writeFile(join(bundle.output, "artifact.json"), pair.artifact);
        await writeFile(join(bundle.output, "evidence.json"), JSON.stringify(evidence));
        await assert.rejects(validate(bundle), expected);
        if (name === "compiler settings substitution") {await assert.rejects(compiled(join(parent, "hostile"), pair), { code: "COMPILER_SETTINGS_MISMATCH" });}
        if (name === "missing ABI") {await assert.rejects(compiled(join(parent, "hostile"), pair), { code: "BUILD_INFO_INVALID" });}
      });
    }
    await writeFile(join(bundle.output, "build-info.json"), buildRaw);
    await writeFile(join(bundle.output, "artifact.json"), artifactRaw);
    for (const field of ["image", "solcBinarySha256", "forgeBinarySha256", "solc"]) {
      await context.test(`tool identity ${field}`, async () => {
        const evidence = parse(original); const tools = object(evidence.tools);
        tools[field] = field.endsWith("Sha256") ? `sha256:${"0".repeat(64)}`
          : field === "solc" ? "0.8.36+commit.deadbeef" : (tools[field] as string).replace("ghcr.io", "example.invalid");
        assert.notEqual(tools[field], object(parse(original).tools)[field]);
        await writeFile(join(bundle.output, "evidence.json"), JSON.stringify(evidence));
        await assert.rejects(validate(bundle), /tool identity|const mismatch/u);
      });
    }
    await writeFile(join(bundle.output, "evidence.json"), original);
    await context.test("nonempty READY", async () => {
      await writeFile(join(bundle.output, "READY"), "forged");
      await assert.rejects(validate(bundle), /READY must be empty/u);
    });
    await writeFile(join(bundle.output, "READY"), "");
    await context.test("extra bundle entry", async () => {
      await writeFile(join(bundle.output, "extra.json"), "{}");
      await assert.rejects(validate(bundle), /missing or extra entries/u);
    });
  } finally {await rm(parent, { recursive: true, force: true });}
});
