import assert from "node:assert/strict";
import { test } from "node:test";
import { findingFingerprint, normalizedIdentityHash, sha256, sourceLocation } from "../src/adapters/fingerprint.ts";
import { evaluatePolicy } from "../src/application/policy.ts";
import type { AnalysisInput, Finding, GateManifest, Suppression } from "../src/domain/model.ts";
import { parseCompilerProfile } from "../src/domain/model.ts";

const expectedDetectors = ["suicidal", "tx-origin"];
const manifest: GateManifest = {
  schemaVersion: 1,
  target: "contracts/evm/A.sol:A",
  expectedContracts: ["A"],
  sources: [{ path: "contracts/evm/A.sol", sha256: "a".repeat(64) }],
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
  creationBytecodeSha256: "b",
  detectorInventory: { path: "detectors.json", sha256: "d".repeat(64) },
};
const source = "contract A { function x() external {} }";

function finding(impact: Finding["impact"] = "High"): Finding {
  const location = sourceLocation("contracts/evm/A.sol", 0, 10, source);
  const identity = "A.x permits destruction";
  const base = {
    detectorId: "suicidal",
    impact,
    confidence: "High",
    identity,
    findingIdentityHash: normalizedIdentityHash(identity),
    location,
  };
  return { ...base, fingerprint: findingFingerprint(base) };
}

function input(findings: readonly Finding[]): AnalysisInput {
  return {
    success: true,
    findings,
    contracts: ["A"],
    compiledSources: ["A.sol"],
    closure: [...manifest.sources, manifest.detectorInventory],
    detectorInventory: expectedDetectors,
    compiler: manifest.compiler,
    creationBytecodeSha256: "b",
    freshFoundryCreationBytecodeSha256: "b",
    analysisErrors: [],
    forgeBinarySha256: manifest.tools.forgeBinarySha256,
    solcBinarySha256: manifest.tools.solcBinarySha256,
  };
}

function decide(value: AnalysisInput, suppressions: readonly Suppression[] = [], now?: Date) {
  return evaluatePolicy({ input: value, manifest, expectedDetectors, suppressions, now });
}

function suppression(value: Finding): Suppression {
  return {
    schemaVersion: 1,
    fingerprint: value.fingerprint,
    detectorId: value.detectorId,
    path: value.location.path,
    start: value.location.start,
    length: value.location.length,
    sourceHash: value.location.sourceHash,
    snippetHash: value.location.snippetHash,
    findingIdentityHash: value.findingIdentityHash,
    reason: "Reviewed false positive",
    owner: "security-owner",
    expiresAt: "2030-01-01T00:00:00Z",
    reviewAt: "2029-01-01T00:00:00Z",
    regressionEvidence: "policy.test.ts exact fingerprint",
  };
}

test("High and Medium findings block while lower impacts remain visible", () => {
  assert.equal(decide(input([finding("High")])).category, "policy-failure");
  assert.equal(decide(input([finding("Medium")])).exitCode, 20);
  assert.equal(decide(input([{ ...finding("High"), confidence: "Low" }])).category, "policy-failure");
  for (const impact of ["Low", "Informational", "Optimization"] as const) {
    const decision = decide(input([finding(impact)]));
    assert.equal(decision.category, "clean");
    assert.equal(decision.visible.length, 1);
  }
});

test("success plus findings is policy evaluation rather than tool failure", () => {
  const decision = decide(input([finding()]));
  assert.equal(decision.category, "policy-failure");
  assert.equal(decision.errors.length, 0);
});

test("an exact owned unexpired suppression matches one-to-one", () => {
  const value = finding();
  const decision = decide(input([value]), [suppression(value)], new Date("2028-01-01T00:00:00Z"));
  assert.equal(decision.category, "clean");
  assert.equal(decision.suppressed.length, 1);
});

test("every fingerprint tuple mutation invalidates a suppression", () => {
  const value = finding();
  const base = suppression(value);
  const mutations: Suppression[] = [
    { ...base, detectorId: "tx-origin" },
    { ...base, path: "contracts/evm/B.sol" },
    { ...base, start: 1 },
    { ...base, length: 9 },
    { ...base, sourceHash: `sha256:${"1".repeat(64)}` },
    { ...base, snippetHash: `sha256:${"2".repeat(64)}` },
    { ...base, findingIdentityHash: `sha256:${"3".repeat(64)}` },
  ];
  for (const mutated of mutations) {
    assert.equal(
      decide(input([value]), [mutated], new Date("2028-01-01T00:00:00Z")).category,
      "output-failure",
    );
  }
});

test("absolute worktree changes do not alter a repository-relative fingerprint", () => {
  const left = sourceLocation("/tmp/one/contracts/evm/A.sol", 0, 10, source);
  const right = sourceLocation("/different/worktree/contracts/evm/A.sol", 0, 10, source);
  assert.deepEqual(left, right);
});

test("duplicate, unused, expired and ownerless suppressions fail closed", () => {
  const value = finding();
  const valid = suppression(value);
  const now = new Date("2028-01-01T00:00:00Z");
  assert.equal(decide(input([value]), [valid, valid], now).category, "output-failure");
  assert.equal(decide(input([]), [valid], now).category, "output-failure");
  assert.equal(decide(input([value]), [{ ...valid, expiresAt: "2027-01-01T00:00:00Z" }], now).category, "output-failure");
  assert.equal(decide(input([value]), [{ ...valid, reviewAt: "2027-12-31T00:00:00Z" }], now).category, "output-failure");
  assert.equal(decide(input([value]), [{ ...valid, reason: "" }], now).category, "output-failure");
});

test("exact detector inventory rejects missing, extra, duplicate, and renamed names", () => {
  const inventories = [
    ["suicidal"],
    [...expectedDetectors, "unexpected"],
    [...expectedDetectors, "tx-origin"],
    ["suicidal", "renamed-tx-origin"],
  ];
  for (const detectorInventory of inventories) {
    assert.equal(decide({ ...input([]), detectorInventory }).category, "output-failure");
  }
});

test("closure, targets, bytecode, compiler and analysis errors fail closed", () => {
  const cases: readonly [AnalysisInput, "output-failure" | "tool-failure"][] = [
    [{ ...input([]), contracts: [] }, "output-failure"],
    [{ ...input([]), compiledSources: [] }, "output-failure"],
    [{ ...input([]), closure: [] }, "output-failure"],
    [{ ...input([]), creationBytecodeSha256: "different" }, "output-failure"],
    [{ ...input([]), forgeBinarySha256: "0".repeat(64) }, "output-failure"],
    [{ ...input([]), success: false }, "tool-failure"],
    [{ ...input([]), analysisErrors: ["compile failed"] }, "tool-failure"],
  ];
  for (const [value, category] of cases) {
    assert.equal(decide(value).category, category);
  }
});

test("invalid compiler input is rejected without mutating an impossible literal type", () => {
  const invalid: unknown = { ...manifest.compiler, optimizerRuns: 201 };
  assert.throws(() => parseCompilerProfile(invalid), /exact approved profile/u);
});

test("source hashes are byte exact", () => {
  assert.notEqual(sha256(source), sha256(`${source}\n`));
});
