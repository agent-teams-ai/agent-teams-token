import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/adapters/fingerprint.ts";
import { parseSlitherJson } from "../src/adapters/slither-json.ts";
import { evaluatePolicy } from "../src/application/policy.ts";
import type { AnalysisInput, DetectorInventoryDocument, GateManifest } from "../src/domain/model.ts";
import { makeTestDirectory } from "./test-directory.ts";

test("synthetic vulnerable contract blocks against the real pinned detector inventory", async () => {
  const root = await makeTestDirectory("vulnerable-");
  try {
    const source = await readFile("tooling/security/slither/tests/fixtures/Vulnerable.sol", "utf8");
    const inventory = JSON.parse(
      await readFile("tooling/security/slither/detector-inventory.v1.json", "utf8"),
    ) as DetectorInventoryDocument;
    const path = "contracts/evm/src/Vulnerable.sol";
    await mkdir(join(root, "contracts/evm/src"), { recursive: true });
    await writeFile(join(root, path), source);
    const start = Buffer.from(source.slice(0, source.indexOf("selfdestruct"))).length;
    const raw = JSON.stringify({
      success: true,
      results: {
        detectors: [{
          check: "suicidal",
          impact: "High",
          confidence: "High",
          description: "Vulnerable.destroy can destroy the contract",
          elements: [{
            source_mapping: {
              filename_relative: "src/Vulnerable.sol",
              start,
              length: "selfdestruct".length,
            },
          }],
        }],
        errors: [],
      },
    });
    const parsed = await parseSlitherJson(raw, root);
    const manifest = vulnerableManifest(path, source);
    const input: AnalysisInput = {
      success: parsed.success,
      findings: parsed.findings,
      contracts: ["Vulnerable"],
      compiledSources: ["src/Vulnerable.sol"],
      closure: [...manifest.sources, manifest.detectorInventory],
      detectorInventory: inventory.detectors,
      compiler: manifest.compiler,
      creationBytecodeSha256: "bytecode",
      freshFoundryCreationBytecodeSha256: "bytecode",
      analysisErrors: [],
      forgeBinarySha256: manifest.tools.forgeBinarySha256,
      solcBinarySha256: manifest.tools.solcBinarySha256,
    };
    const decision = evaluatePolicy({
      input,
      manifest,
      expectedDetectors: inventory.detectors,
      suppressions: [],
    });
    assert.equal(decision.category, "policy-failure");
    assert.equal(decision.exitCode, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function vulnerableManifest(path: string, source: string): GateManifest {
  return {
    schemaVersion: 1,
    target: `${path}:Vulnerable`,
    expectedContracts: ["Vulnerable"],
    sources: [{ path, sha256: sha256(source) }],
    config: [],
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
    creationBytecodeSha256: "bytecode",
    detectorInventory: { path: "detectors.json", sha256: "d".repeat(64) },
  };
}
