import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { validateFinalizedEvidenceBundle } from "../src/adapters/evidence-bundle.ts";
import { writeEnvironmentFailure, writeReadyEvidence } from "../src/adapters/evidence.ts";
import { sha256 } from "../src/adapters/fingerprint.ts";
import type { AnalysisInput, Finding, GateManifest, PolicyDecision } from "../src/domain/model.ts";
import { makeTestDirectory } from "./test-directory.ts";

const sha = "a".repeat(40);
const bytecode = "56d021ec13df6cccbc5d330ccad2acd567f5b4cb75665a0d9982604306c92493";
const triage = JSON.parse(await readFile("tooling/security/slither/triage.v1.json", "utf8")) as { findings: readonly { fingerprint: string }[] };
const findings: readonly Finding[] = triage.findings.map(({ fingerprint }, index) => ({
  detectorId: `detector-${index}`,
  impact: "Informational",
  confidence: "High",
  identity: `test-finding-${index}`,
  findingIdentityHash: `sha256:${"1".repeat(64)}`,
  location: {
    path: "contracts/evm/src/A.sol",
    start: index + 1,
    length: 1,
    sourceHash: `sha256:${"2".repeat(64)}`,
    snippetHash: `sha256:${"3".repeat(64)}`,
  },
  fingerprint,
}));
const manifest: GateManifest = { schemaVersion: 1, targets: [{ path: "contracts/evm/src/A.sol", contract: "A" }], expectedContracts: ["A"], sources: [], config: [], compiler: { version: "0.8.36+commit.8a079791", evmVersion: "paris", optimizerEnabled: true, optimizerRuns: 200, bytecodeHash: "ipfs", cborMetadata: true, useLiteralContent: false, viaIR: false, experimental: false, remappings: ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"] }, tools: { forgeArchiveSha256: "8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57", forgeBinarySha256: "c0fbe3ba32d7f498507042dbb94f5954be51126a76ce84e37d71749e7c9c571f", solcBinarySha256: "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6" }, creationBytecodeSha256: bytecode, detectorInventory: { path: "detectors.json", sha256: "d".repeat(64) } };
const input: AnalysisInput = { success: true, findings, analyzedContracts: ["A"], analyzedSources: [], closure: [], detectorInventory: Array.from({ length: 101 }, (_, index) => `d-${index}`), compiler: manifest.compiler, creationBytecodeSha256: bytecode, freshFoundryCreationBytecodeSha256: bytecode, analysisErrors: [], forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256 };
const decision: PolicyDecision = { category: "clean", exitCode: 0, blocking: [], visible: findings, suppressed: [], errors: [] };
const schemaDirectory = "tooling/security/slither";
const validate = async (output: string, candidateSha = sha): Promise<void> => await validateFinalizedEvidenceBundle({ output, candidateSha, schemaDirectory });

async function makeBundle(output: string): Promise<void> {
  const config = sha256(await readFile(join(schemaDirectory, "slither.config.json")));
  const policy = sha256(await readFile(join(schemaDirectory, "suppressions.v1.json")));
  const triageDigest = sha256(await readFile(join(schemaDirectory, "triage.v1.json")));
  await writeReadyEvidence({ output, candidateSha: sha, manifest, input, decision, hashes: { config, policy }, triageHash: triageDigest, schemaDirectory, assertReadyPrecondition: async () => {} });
}

test("finalized analysis evidence validates independently", async () => {
  const parent = await makeTestDirectory("bundle-valid-"); const output = join(parent, "bundle");
  try {await makeBundle(output); await validate(output);} finally {await rm(parent, { recursive: true, force: true });}
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
    value.analysis.findingCount = 1; await writeFile(path, `${JSON.stringify(value)}\n`);
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
    await assert.rejects(validate(output), /triaged finding count/u);
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("evidence bound to a different candidate SHA is rejected", async () => {
  const parent = await makeTestDirectory("bundle-sha-"); const output = join(parent, "bundle");
  try {await makeBundle(output); await assert.rejects(validate(output, "b".repeat(40)), /candidate SHA differs/u);} finally {await rm(parent, { recursive: true, force: true });}
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
    await writeEnvironmentFailure({ output, candidateSha: sha, stage: "preflight", errorCode: "IMAGE_UNAVAILABLE", schemaDirectory, assertReadyPrecondition: async () => {} });
    await validate(output);
  } finally {await rm(parent, { recursive: true, force: true });}
});
