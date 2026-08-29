import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { validateFinalizedEvidenceBundle } from "../src/adapters/evidence-bundle.ts";
import { writeEnvironmentFailure, writeReadyEvidence } from "../src/adapters/evidence.ts";
import type { AnalysisInput, Finding, GateManifest, PolicyDecision } from "../src/domain/model.ts";
import { makeTestDirectory } from "./test-directory.ts";
import { schemaDirectory, writeCanonicalFixture } from "./evidence-canonical-fixture.ts";

const sha = "a".repeat(40);
const bytecode = "56d021ec13df6cccbc5d330ccad2acd567f5b4cb75665a0d9982604306c92493";
const golden = JSON.parse(await readFile("tooling/security/slither/tests/fixtures/golden-bundle-input.v1.json", "utf8")) as { finding: Finding };
const findings: readonly Finding[] = [golden.finding];
const manifest: GateManifest = { schemaVersion: 1, targets: [{ path: "contracts/evm/src/A.sol", contract: "A" }], expectedContracts: ["A"], sources: [{ path: "contracts/evm/src/A.sol", sha256: "2".repeat(64) }], config: [], compiler: { version: "0.8.36+commit.8a079791", evmVersion: "paris", optimizerEnabled: true, optimizerRuns: 200, bytecodeHash: "ipfs", cborMetadata: true, useLiteralContent: false, viaIR: false, experimental: false, remappings: ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"] }, tools: { forgeArchiveSha256: "8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57", forgeBinarySha256: "c0fbe3ba32d7f498507042dbb94f5954be51126a76ce84e37d71749e7c9c571f", solcBinarySha256: "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6" }, creationBytecodeSha256: bytecode, detectorInventory: { path: "detectors.json", sha256: "d".repeat(64) } };
const input: AnalysisInput = { success: true, findings, analyzedContracts: ["A"], analyzedSources: ["src/A.sol"], closure: [], detectorInventory: [...Array.from({ length: 100 }, (_, index) => `d-${index}`), "fixture-detector"].toSorted(), compiler: manifest.compiler, creationBytecodeSha256: bytecode, freshFoundryCreationBytecodeSha256: bytecode, analysisErrors: [], forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256 };
const decision: PolicyDecision = { category: "clean", exitCode: 0, blocking: [], visible: findings, suppressed: [], errors: [] };
const validate = async (output: string, candidateSha = sha): Promise<void> => await validateFinalizedEvidenceBundle({ output, candidateSha, schemaDirectory, canonicalDirectory: join(dirname(output), "canonical") });

async function makeBundle(output: string): Promise<void> {
  const canonicalDirectory = join(dirname(output), "canonical");
  const hashes = await writeCanonicalFixture(canonicalDirectory, manifest, input);
  await writeReadyEvidence({ output, candidateSha: sha, manifest: hashes.manifest, input, decision, hashes: { config: hashes.config, policy: hashes.policy }, triageHash: hashes.triage, schemaDirectory, canonicalDirectory, assertReadyPrecondition: async () => {} });
}

test("finalized analysis evidence validates independently", async () => {
  const parent = await makeTestDirectory("bundle-valid-"); const output = join(parent, "bundle");
  try {await makeIndependentGoldenBundle(output); await validate(output);} finally {await rm(parent, { recursive: true, force: true });}
});

test("schema-invalid tampering is rejected", async () => {
  const parent = await makeTestDirectory("bundle-tamper-"); const output = join(parent, "bundle");
  try {
    await makeBundle(output);
    const path = join(output, "evidence.json");
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    value.injected = true; await writeFile(path, `${JSON.stringify(value)}\n`);
    await assert.rejects(validate(output), /unexpected injected/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("schema-valid semantic tampering is rejected", async () => {
  const parent = await makeTestDirectory("bundle-semantic-"); const output = join(parent, "bundle");
  try {
    await makeBundle(output);
    const path = join(output, "evidence.json");
    const value = JSON.parse(await readFile(path, "utf8")) as { analysis: { findingCount: number } };
    value.analysis.findingCount = 0; await writeFile(path, `${JSON.stringify(value)}\n`);
    await assert.rejects(validate(output), /finding count differs/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("derived triage count cannot be reduced while policy hashes remain valid", async () => {
  const parent = await makeTestDirectory("bundle-triage-"); const output = join(parent, "bundle");
  try {
    await makeBundle(output);
    const path = join(output, "evidence.json");
    const value = JSON.parse(await readFile(path, "utf8")) as { analysis: { triaged: number } };
    value.analysis.triaged = 0; await writeFile(path, `${JSON.stringify(value)}\n`);
    await assert.rejects(validate(output), /classifications differ/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("hostile closure, fingerprint, target, source and detector forgeries fail independently", async (context) => {
  const cases: readonly [string, (output: string) => Promise<void>, RegExp][] = [
    ["closure", async (output) => await mutate(output, "evidence.json", (value) => {objectAt(value, "inputs").closureHash = `sha256:${"0".repeat(64)}`;}), /input hashes differ/u],
    ["fingerprint", async (output) => {
      const forged = `sha256:${"0".repeat(64)}`;
      await mutate(output, "evidence.json", (value) => {firstFinding(objectAt(value, "analysis")).fingerprint = forged;});
    }, /findings differ from raw evidence/u],
    ["target", async (output) => {
      await mutate(output, "slither-inventory.json", (value) => {value.contracts = ["ForgedTarget"];});
      await mutate(output, "evidence.json", (value) => {const analysis = objectAt(value, "analysis"); analysis.expectedTargets = ["ForgedTarget"]; analysis.observedTargets = ["ForgedTarget"];});
    }, /targets, sources or detectors differ/u],
    ["source", async (output) => {
      const forged = `sha256:${"0".repeat(64)}`;
      await mutate(output, "slither.json", (value) => {firstFinding(value).sourceHash = forged;});
      await mutate(output, "evidence.json", (value) => {firstFinding(objectAt(value, "analysis")).sourceHash = forged;});
    }, /source hash differs/u],
    ["detector", async (output) => {
      await mutate(output, "detector-inventory.json", (value) => {const items = value.detectors as string[]; items[0] = "aaa-forged"; items.sort();});
      await mutate(output, "evidence.json", (value) => {const items = objectAt(value, "analysis").detectors as string[]; items[0] = "aaa-forged"; items.sort();});
    }, /targets, sources or detectors differ/u],
  ];
  for (const [name, forge, expected] of cases) {
    await context.test(name, async () => {
      const parent = await makeTestDirectory(`bundle-forged-${name}-`); const output = join(parent, "bundle");
      try {await makeBundle(output); await forge(output); await assert.rejects(validate(output), expected);}
      finally {await rm(parent, { recursive: true, force: true });}
    });
  }
});

test("a self-consistent evidence fingerprint forgery cannot replace the canonical raw identity", async () => {
  const parent = await makeTestDirectory("bundle-self-consistent-forgery-"); const output = join(parent, "bundle");
  try {
    await makeBundle(output);
    const identity = "forged normalized identity";
    const identityHash = `sha256:${digest(identity)}`;
    const canonical = ["agtmai-slither-finding-v1", golden.finding.detectorId, golden.finding.location.path,
      String(golden.finding.location.start), String(golden.finding.location.length), golden.finding.location.sourceHash,
      golden.finding.location.snippetHash, identityHash].join("\n");
    const fingerprint = `sha256:${digest(canonical)}`;
    await mutate(output, "slither.json", (value) => {firstFinding(value).identity = identity;});
    await mutate(output, "evidence.json", (value) => {
      const finding = firstFinding(objectAt(value, "analysis"));
      finding.identity = identity; finding.findingIdentityHash = identityHash; finding.fingerprint = fingerprint;
    });
    await assert.rejects(validate(output), /triage does not exactly cover/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("evidence bound to a different candidate SHA is rejected", async () => {
  const parent = await makeTestDirectory("bundle-sha-"); const output = join(parent, "bundle");
  try {await makeBundle(output); await assert.rejects(validate(output, "b".repeat(40)), /candidate SHA differs/u);} finally {await rm(parent, { recursive: true, force: true });}
});

test("CI finalization rejects evidence without the current complete GitHub execution identity", async () => {
  const parent = await makeTestDirectory("bundle-ci-identity-"); const output = join(parent, "bundle");
  try {
    await makeBundle(output);
    await assert.rejects(validateFinalizedEvidenceBundle({ output, candidateSha: sha, schemaDirectory,
      canonicalDirectory: join(parent, "canonical"), finalizationMode: "ci" }), /current CI environment|requires GitHub Actions/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("an extra evidence variant is rejected as ambiguous", async () => {
  const parent = await makeTestDirectory("bundle-extra-"); const output = join(parent, "bundle");
  try {
    await makeBundle(output);
    await writeFile(join(output, "output-failure.json"), "{}\n");
    await assert.rejects(validate(output), /exactly one evidence variant/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("a missing evidence variant is rejected", async () => {
  const parent = await makeTestDirectory("bundle-missing-"); const output = join(parent, "bundle");
  try {
    await makeBundle(output); await rm(join(output, "evidence.json"));
    await assert.rejects(validate(output), /exactly one evidence variant/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("finalized failure evidence validates against its exact variant schema", async () => {
  const parent = await makeTestDirectory("bundle-failure-"); const output = join(parent, "bundle");
  try {
    await writeEnvironmentFailure({ output, candidateSha: sha, stage: "image-preflight", errorCode: "IMAGE_UNAVAILABLE", schemaDirectory, assertReadyPrecondition: async () => {} });
    await validate(output);
  } finally {await rm(parent, { recursive: true, force: true });}
});

async function mutate(output: string, name: string, change: (value: Record<string, unknown>) => void): Promise<void> {
  const path = join(output, name); const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  change(value); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
function objectAt(value: Record<string, unknown>, field: string): Record<string, unknown> {return value[field] as Record<string, unknown>;}
function firstFinding(value: Record<string, unknown>): Record<string, unknown> {return (value.findings as Record<string, unknown>[])[0]!;}

/*
 * A deliberately separate golden-bundle author: it does not call the
 * production serializer, summary renderer, fingerprint helper or semantic
 * functions. This is the positive oracle for the final validator.
 */
async function makeIndependentGoldenBundle(output: string): Promise<void> {
  const canonicalDirectory = join(dirname(output), "canonical");
  const detectors = [...Array.from({ length: 100 }, (_, index) => `d-${index}`), "fixture-detector"].toSorted();
  const detectorBytes = json({ schemaVersion: 1, slitherVersion: "0.11.6", detectors });
  const configBytes = json({ filter_paths: [] });
  const policyBytes = json({ schemaVersion: 1, suppressions: [] });
  const triageBytes = json({ schemaVersion: 1, findings: [{ schemaVersion: 1, fingerprint: golden.finding.fingerprint,
    owner: "fixture-security", disposition: "accepted-design", rationale: "Independently reviewed golden evidence fixture finding.",
    reviewedAt: "2026-08-29T00:00:00.000Z" }] });
  const acceptedManifest = { ...manifest, detectorInventory: { path: "detector-inventory.v1.json", sha256: digest(detectorBytes) } };
  const rawFinding = {
    detectorId: golden.finding.detectorId, impact: golden.finding.impact, confidence: golden.finding.confidence,
    identity: golden.finding.identity, findingIdentityHash: golden.finding.findingIdentityHash,
    fingerprint: golden.finding.fingerprint, path: golden.finding.location.path, start: golden.finding.location.start,
    length: golden.finding.location.length, sourceHash: golden.finding.location.sourceHash,
    snippetHash: golden.finding.location.snippetHash, blocking: false, suppressed: false,
  };
  const closure = [...acceptedManifest.sources, ...acceptedManifest.config, acceptedManifest.detectorInventory];
  const evidence = {
    schemaVersion: 1, ready: true, candidateSha: sha,
    execution: { platform: "linux/amd64", event: "local", repository: "local", workflow: "local", job: "local", runId: "local", runAttempt: "1" },
    tools: { image: "ghcr.io/trailofbits/eth-security-toolbox:nightly-20260824@sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0", imageRevision: "8cad443280f7eeb5920a901b5f58f5a91872d9aa", slither: "0.11.6", cryticCompile: "0.4.2", forge: "1.8.0", forgeBinarySha256: `sha256:${manifest.tools.forgeBinarySha256}`, solc: "0.8.36+commit.8a079791", solcBinarySha256: `sha256:${manifest.tools.solcBinarySha256}` },
    inputs: { closureHash: `sha256:${digest(JSON.stringify(closure))}`, configHash: `sha256:${digest(configBytes)}`,
      policyHash: `sha256:${digest(policyBytes)}`, triageHash: `sha256:${digest(triageBytes)}` },
    analysis: { expectedTargets: ["A"], observedTargets: ["A"], expectedSources: ["src/A.sol"], observedSources: ["src/A.sol"],
      creationBytecodeSha256: `sha256:${bytecode}`, detectors, findingCount: 1,
      perImpact: { High: 0, Medium: 0, Low: 0, Informational: 1, Optimization: 0 }, findings: [rawFinding], suppressions: 0, triaged: 1 },
    policy: { blocking: 0, visible: 1, suppressed: 0, errors: [] }, result: { category: "clean", exitCode: 0 }, sanitised: true,
  };
  const summary = "# Slither security gate\n\nResult: clean (exit 0)\nFindings: 1; blocking: 0; suppressed: 0\nTargets: A\n- Informational fixture-detector at contracts/evm/src/A.sol:1 (visible)\n";
  await mkdir(canonicalDirectory, { recursive: true }); await mkdir(output);
  await Promise.all([
    writeFile(join(canonicalDirectory, "production-closure.v1.json"), json(acceptedManifest)),
    writeFile(join(canonicalDirectory, "detector-inventory.v1.json"), detectorBytes),
    writeFile(join(canonicalDirectory, "slither.config.json"), configBytes),
    writeFile(join(canonicalDirectory, "suppressions.v1.json"), policyBytes),
    writeFile(join(canonicalDirectory, "triage.v1.json"), triageBytes),
    writeFile(join(output, "evidence.json"), json(evidence)), writeFile(join(output, "summary.md"), summary),
    writeFile(join(output, "slither.json"), json({ schemaVersion: 1, success: true, errors: [], findings: [{
      detectorId: rawFinding.detectorId, impact: rawFinding.impact, confidence: rawFinding.confidence,
      identity: rawFinding.identity, path: rawFinding.path, start: rawFinding.start, length: rawFinding.length,
      sourceHash: rawFinding.sourceHash, snippetHash: rawFinding.snippetHash,
    }] })),
    writeFile(join(output, "slither-inventory.json"), json({ schemaVersion: 1, success: true, contracts: ["A"], sources: ["src/A.sol"], errors: [] })),
    writeFile(join(output, "detector-inventory.json"), json({ schemaVersion: 1, detectors })),
    writeFile(join(output, "slither-status.json"), json({ schemaVersion: 1, analysisExit: 255, inventoryExit: 0 })),
    writeFile(join(output, "READY"), ""),
  ]);
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
