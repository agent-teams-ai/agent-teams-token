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
  tools: { forgeBinarySha256: "x", solcBinarySha256: "x" },
  creationBytecodeSha256: "x",
} as GateManifest;

test("application use case checks exact cleanliness before inputs and after analysis", async () => {
  const events: string[] = [];
  const repository: RepositoryStatePort = {
    assertExactClean: async () => {events.push("clean");},
    trackedProductionSources: async () => {events.push("sources"); return ["contracts/evm/src/A.sol"];},
  };
  const analysis: AnalysisPort = {
    run: async () => {events.push("analysis"); return { manifest, input: { success: true, findings: [], analyzedContracts: ["A"], analyzedSources: ["src/A.sol"], closure: [...manifest.sources, manifest.detectorInventory], detectorInventory: [], compiler: manifest.compiler, creationBytecodeSha256: "x", freshFoundryCreationBytecodeSha256: "x", analysisErrors: [], forgeBinarySha256: "x", solcBinarySha256: "x" }, expectedDetectors: [], suppressions: [], triage: [], configHash: "x", policyHash: "x", triageHash: "x" } as GateAnalysis;},
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
