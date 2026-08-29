import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { assertContainerResult } from "../src/adapters/runner.ts";
import { classifyGateFailure } from "../src/application/failure.ts";
import { writeEnvironmentFailure, writeReadyEvidence } from "../src/adapters/evidence.ts";
import type { AnalysisInput, GateManifest, PolicyDecision } from "../src/domain/model.ts";
import { makeTestDirectory } from "./test-directory.ts";
import { schemaDirectory, writeCanonicalFixture } from "./evidence-canonical-fixture.ts";

test("container fault markers preserve the exact fallible phase", async (context) => {
  const cases = [
    ["container-execution", "CONTAINER_FAILED"],
    ["compiler-build", "COMPILER_BUILD_FAILED"], ["version-inventory", "TOOL_VERSION_MISMATCH"],
    ["detector-inventory", "DETECTOR_INVENTORY_INVALID"], ["manifest-validation", "TARGET_MANIFEST_INVALID"],
    ["analysis-runtime", "ANALYZER_RUNTIME_FAILED"], ["artifact-validation", "ARTIFACT_EXPORT_FAILED"],
  ] as const;
  for (const [marker, code] of cases) {
    await context.test(marker, async () => {
      const output = await makeTestDirectory(`phase-${marker}-`);
      try {
        await writeFile(join(output, "failure.stage"), `${marker}\n`);
        await assert.rejects(assertContainerResult({ timedOut: false, exitCode: 1 }, output),
          (error: unknown) => error instanceof Error && "code" in error && error.code === code);
      } finally {await rm(output, { recursive: true, force: true });}
    });
  }
});

test("container timeout has its own exact phase classification", async () => {
  const output = await makeTestDirectory("phase-timeout-");
  try {
    await assert.rejects(assertContainerResult({ timedOut: true, exitCode: null }, output),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTAINER_TIMEOUT");
  } finally {await rm(output, { recursive: true, force: true });}
});

test("late publication failure leaves no partial bundle and permits a READY-last failure envelope", async () => {
  const parent = await makeTestDirectory("late-publication-"); const output = join(parent, "bundle");
  const bytecode = "56d021ec13df6cccbc5d330ccad2acd567f5b4cb75665a0d9982604306c92493";
  const manifest: GateManifest = { schemaVersion: 1, targets: [{ path: "contracts/evm/src/A.sol", contract: "A" }], expectedContracts: ["A"], sources: [], config: [], compiler: { version: "0.8.36+commit.8a079791", evmVersion: "paris", optimizerEnabled: true, optimizerRuns: 200, bytecodeHash: "ipfs", cborMetadata: true, useLiteralContent: false, viaIR: false, experimental: false, remappings: ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"] }, tools: { forgeArchiveSha256: "8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57", forgeBinarySha256: "c0fbe3ba32d7f498507042dbb94f5954be51126a76ce84e37d71749e7c9c571f", solcBinarySha256: "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6" }, creationBytecodeSha256: bytecode, detectorInventory: { path: "detector-inventory.v1.json", sha256: "0".repeat(64) } };
  const input: AnalysisInput = { success: true, findings: [], analyzedContracts: ["A"], analyzedSources: [], closure: [], detectorInventory: Array.from({ length: 101 }, (_, index) => `d-${index}`).toSorted(), compiler: manifest.compiler, creationBytecodeSha256: bytecode, freshFoundryCreationBytecodeSha256: bytecode, analysisErrors: [], forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256 };
  const decision: PolicyDecision = { category: "clean", exitCode: 0, blocking: [], visible: [], suppressed: [], errors: [] };
  try {
    const canonicalDirectory = join(parent, "canonical"); const hashes = await writeCanonicalFixture(canonicalDirectory, manifest, input);
    await assert.rejects(writeReadyEvidence({ output, candidateSha: "a".repeat(40), manifest: hashes.manifest, input, decision, hashes: { config: hashes.config, policy: hashes.policy }, triageHash: hashes.triage, schemaDirectory, canonicalDirectory, assertReadyPrecondition: async () => {throw new Error("injected-final-publication-failure");} }), /injected-final-publication-failure/u);
    await assert.rejects(readFile(output));
    const failure = classifyGateFailure("UNEXPECTED_ENVIRONMENT_FAILURE");
    await writeEnvironmentFailure({ output, candidateSha: "a".repeat(40), stage: failure.stage, errorCode: "UNEXPECTED_ENVIRONMENT_FAILURE", schemaDirectory, assertReadyPrecondition: async () => {} });
    assert.equal((await readFile(join(output, "READY"))).length, 0);
  } finally {await rm(parent, { recursive: true, force: true });}
});
