import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AnalysisInput, GateManifest, PolicyDecision } from "../src/domain/model.ts";
import { writeEnvironmentFailure, writeFailureEvidence, writeReadyEvidence } from "../src/adapters/evidence.ts";
import { makeTestDirectory } from "./test-directory.ts";

const bytecode = "56d021ec13df6cccbc5d330ccad2acd567f5b4cb75665a0d9982604306c92493";
const manifest: GateManifest = { schemaVersion: 1, targets: [{ path: "contracts/evm/src/A.sol", contract: "A" }], expectedContracts: ["A"], sources: [], config: [], compiler: { version: "0.8.36+commit.8a079791", evmVersion: "paris", optimizerEnabled: true, optimizerRuns: 200, bytecodeHash: "ipfs", cborMetadata: true, useLiteralContent: false, viaIR: false, experimental: false, remappings: ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"] }, tools: { forgeArchiveSha256: "8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57", forgeBinarySha256: "c0fbe3ba32d7f498507042dbb94f5954be51126a76ce84e37d71749e7c9c571f", solcBinarySha256: "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6" }, creationBytecodeSha256: bytecode, detectorInventory: { path: "detectors.json", sha256: "d".repeat(64) } };
const detectors = Array.from({ length: 101 }, (_, index) => `d-${index}`);
const input: AnalysisInput = { success: true, findings: [], analyzedContracts: ["A"], analyzedSources: [], closure: [], detectorInventory: detectors, compiler: manifest.compiler, creationBytecodeSha256: bytecode, freshFoundryCreationBytecodeSha256: bytecode, analysisErrors: [], forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256 };
const decision: PolicyDecision = { category: "clean", exitCode: 0, blocking: [], visible: [], suppressed: [], errors: [] };
const schemaDirectory = "tooling/security/slither";
const precondition = async (): Promise<void> => {};
const readyRequest = (output: string) => ({ output, candidateSha: "a".repeat(40), manifest, input, decision, hashes: { config: "b".repeat(64), policy: "c".repeat(64) }, triageHash: "d".repeat(64), schemaDirectory, assertReadyPrecondition: precondition });

test("evidence is sanitised, exact-SHA-bound and READY-last", async () => {
  const parent = await makeTestDirectory("evidence-"); const output = join(parent, "bundle");
  try {
    await writeReadyEvidence(readyRequest(output));
    const evidence = JSON.parse(await readFile(join(output, "evidence.json"), "utf8")) as Record<string, unknown>;
    assert.equal(evidence.ready, true); assert.equal(evidence.candidateSha, "a".repeat(40)); assert.equal(evidence.sanitised, true);
    assert.equal((await readFile(join(output, "READY"))).length, 0);
    assert.match(await readFile(join(output, "summary.md"), "utf8"), /Result: clean/u);
    assert.equal(JSON.stringify(evidence).includes(process.cwd()), false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("minimal environment failures also produce READY envelopes", async () => {
  const parent = await makeTestDirectory("failure-"); const output = join(parent, "bundle");
  try { await writeEnvironmentFailure({ output, candidateSha: "d".repeat(40), stage: "preflight", errorCode: "IMAGE_UNAVAILABLE", schemaDirectory, assertReadyPrecondition: precondition }); const value = JSON.parse(await readFile(join(output, "environment-failure.json"), "utf8")) as { exitCode: unknown }; assert.equal(value.exitCode, 50); assert.equal((await readFile(join(output, "READY"))).length, 0); }
  finally { await rm(parent, { recursive: true, force: true }); }
});

test("evidence writers reject stale or redirected output paths", async () => {
  const parent = await makeTestDirectory("redirect-"); const output = join(parent, "bundle");
  try {
    const request = { output, candidateSha: "d".repeat(40), stage: "preflight", errorCode: "IMAGE_UNAVAILABLE", schemaDirectory, assertReadyPrecondition: precondition };
    await writeEnvironmentFailure(request);
    await assert.rejects(writeEnvironmentFailure(request));
    await assert.rejects(writeReadyEvidence(readyRequest(output)));
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("malformed analysis output has a distinct READY-last exit-40 envelope", async () => {
  const parent = await makeTestDirectory("output-failure-"); const output = join(parent, "bundle");
  try {
    await writeFailureEvidence({ output, candidateSha: "e".repeat(40), category: "output-failure", exitCode: 40, stage: "analysis", errorCode: "MALFORMED_JSON", schemaDirectory, assertReadyPrecondition: precondition });
    const value = JSON.parse(await readFile(join(output, "output-failure.json"), "utf8")) as { category: unknown; exitCode: unknown };
    assert.equal(value.category, "output-failure"); assert.equal(value.exitCode, 40); assert.equal((await readFile(join(output, "READY"))).length, 0);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("analyzer runtime failures have a distinct READY-last exit-30 envelope", async () => {
  const parent = await makeTestDirectory("tool-failure-"); const output = join(parent, "bundle");
  try {
    await writeFailureEvidence({ output, candidateSha: "e".repeat(40), category: "tool-failure", exitCode: 30, stage: "analysis-runtime", errorCode: "ANALYZER_RUNTIME_FAILED", schemaDirectory, assertReadyPrecondition: precondition });
    const value = JSON.parse(await readFile(join(output, "tool-failure.json"), "utf8")) as { category: unknown; exitCode: unknown };
    assert.equal(value.category, "tool-failure"); assert.equal(value.exitCode, 30); assert.equal((await readFile(join(output, "READY"))).length, 0);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("schema validation and final precondition both happen before READY", async () => {
  const parent = await makeTestDirectory("schema-before-ready-");
  try {
    const invalidOutput = join(parent, "invalid");
    await assert.rejects(writeReadyEvidence({ ...readyRequest(invalidOutput), candidateSha: "not-a-sha" }), /pattern mismatch/u);
    await assert.rejects(readFile(join(invalidOutput, "READY")));
    const dirtyOutput = join(parent, "dirty");
    await assert.rejects(writeReadyEvidence({ ...readyRequest(dirtyOutput), assertReadyPrecondition: async () => {throw new Error("dirty");} }), /dirty/u);
    await assert.rejects(readFile(join(dirtyOutput, "READY")));
  } finally {await rm(parent, { recursive: true, force: true });}
});
