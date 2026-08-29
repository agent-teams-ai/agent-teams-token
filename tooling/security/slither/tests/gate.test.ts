import assert from "node:assert/strict";
import { test } from "node:test";
import { executeGate } from "../src/application/gate.ts";
import { assertProductionCoverage } from "../src/application/coverage.ts";
import type { AnalysisPort, GateAnalysis, RepositoryStatePort } from "../src/application/ports.ts";
import type { GateManifest } from "../src/domain/model.ts";

const manifest = {
  schemaVersion: 1,
  targets: [{ path: "contracts/evm/src/A.sol", contract: "A" }],
  expectedContracts: ["A"],
  sources: [{ path: "contracts/evm/src/A.sol", sha256: "a".repeat(64) }],
  config: [],
  detectorInventory: { path: "detectors.json", sha256: "d".repeat(64) },
  compiler: {
    version: "0.8.36+commit.8a079791",
    evmVersion: "paris",
    optimizerEnabled: true,
    optimizerRuns: 200,
    bytecodeHash: "ipfs",
    cborMetadata: true,
    useLiteralContent: false,
    viaIR: false,
    experimental: false,
    remappings: [
      "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/",
      "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/",
    ],
  },
  tools: {
    forgeArchiveSha256: "8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57",
    forgeBinarySha256: "c0fbe3ba32d7f498507042dbb94f5954be51126a76ce84e37d71749e7c9c571f",
    solcBinarySha256: "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6",
  },
  creationBytecodeSha256: "x",
} satisfies GateManifest;

test("application use case checks exact cleanliness before inputs and after analysis", async () => {
  const events: string[] = [];
  const repository: RepositoryStatePort = {
    assertExactClean: async () => {events.push("clean");},
    trackedProductionSources: async () => {events.push("sources"); return ["contracts/evm/src/A.sol"];},
  };
  const analysis: AnalysisPort = {
    run: async () => {events.push("analysis"); return { manifest, input: { success: true, findings: [], analyzedContracts: ["A"], analyzedSources: ["src/A.sol"], closure: [...manifest.sources, manifest.detectorInventory], detectorInventory: [], compiler: manifest.compiler, creationBytecodeSha256: "x", freshFoundryCreationBytecodeSha256: "x", analysisErrors: [], forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256 }, expectedDetectors: [], suppressions: [], triage: [], configHash: "x", policyHash: "x", triageHash: "x" } as GateAnalysis;},
  };
  await executeGate("a".repeat(40), repository, analysis);
  assert.deepEqual(events, ["clean", "sources", "analysis", "clean"]);
});

test("an extra standalone tracked production source fails closed", () => {
  assert.throws(
    () => assertProductionCoverage(
      ["contracts/evm/src/A.sol", "contracts/evm/src/Standalone.sol"],
      manifest,
    ),
    /every tracked production Solidity source/u,
  );
});
