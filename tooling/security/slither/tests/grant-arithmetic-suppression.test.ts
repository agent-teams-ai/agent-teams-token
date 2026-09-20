import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { evaluatePolicy } from "../src/application/policy.ts";
import { findingFingerprint, normalizedIdentityHash, sha256, sourceLocation } from "../src/adapters/fingerprint.ts";
import { assertSerializedAgainstSchema } from "../src/adapters/json-schema.ts";
import { parseGateManifest } from "../src/adapters/runner.ts";
import type { AnalysisInput, Finding, Suppression } from "../src/domain/model.ts";

import { makeCompilerEvidence } from "./test-compiler-evidence.ts";

const directory = "tooling/security/slither";
// Observed Medium tuple from slither-c70bd19-final/evidence.json, not the policy ledger.
const finding: Finding = {
  "detectorId": "divide-before-multiply",
  "impact": "Medium",
  "confidence": "Medium",
  "identity": "GrantAccounting._curve(GrantAccounting.Terms,uint64) (src/features/contributor-grants/GrantAccounting.sol#125-136) performs a multiplication on the result of a division: - (terms.allocation / duration) * elapsed + ((terms.allocation % duration) * elapsed) / duration (src/features/contributor-grants/GrantAccounting.sol#134-135)",
  "findingIdentityHash": "sha256:fa25b38ae2b10a1b7002748fcd3b5eb908c5c6edf1e814488980e86eceacd1ca",
  "fingerprint": "sha256:704c6fd405b64b61d8f0712240be87d8ce8b180287dc75322e25459bd3cea098",
  "location": {
    "path": "contracts/evm/src/features/contributor-grants/GrantAccounting.sol",
    "start": 5597,
    "length": 783,
    "sourceHash": "sha256:52b9f943411da5187a7660d8125f2801f6ade1dc0271c660f4b6ee49b5efe13d",
    "snippetHash": "sha256:addb3c243d2beeba7e0fcb7f4ab337216896ce73935bad6b9bd52e130323af5b"
  }
};
const policyRaw = await readFile(`${directory}/suppressions.v1.json`, "utf8");
const { suppressions } = JSON.parse(policyRaw) as { suppressions: Suppression[] };
const arithmeticSuppressions = suppressions.filter(({ fingerprint }) =>
  fingerprint === finding.fingerprint);
const manifest = parseGateManifest(await readFile(`${directory}/production-closure.v1.json`, "utf8"));
const detectors = (JSON.parse(await readFile(manifest.detectorInventory.path, "utf8")) as { detectors: string[] }).detectors;
// Policy seam only: closure/compiler values below are synthetic, not a fresh analysis.
const input: AnalysisInput = {
  ...makeCompilerEvidence("unused\n"),
  success: true, findings: [finding], analysisErrors: [],
  analyzedContracts: manifest.expectedContracts,
  analyzedSources: manifest.sources.map(({ path }) => path.replace(/^contracts\/evm\//u, "")),
  closure: [...manifest.sources, ...manifest.config, manifest.detectorInventory],
  detectorInventory: detectors, compiler: manifest.compiler,
  creationBytecodeSha256: manifest.creationBytecodeSha256,
  freshFoundryCreationBytecodeSha256: manifest.creationBytecodeSha256,
  forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256,
};
const decide = (findings: readonly Finding[], ledger = arithmeticSuppressions, now = "2026-09-14T00:00:00Z") =>
  evaluatePolicy({ input: { ...input, findings }, manifest, expectedDetectors: detectors, suppressions: ledger, now: new Date(now) });

test("only the observed source-bound arithmetic Medium is authorized and remains surfaced", async () => {
  await assertSerializedAgainstSchema(policyRaw, `${directory}/suppression-ledger.schema.v1.json`);
  assert.equal(suppressions.length, 9);
  assert.equal(arithmeticSuppressions.length, 1);
  assert.equal(arithmeticSuppressions[0]?.owner, "project-security");
  assert.equal(arithmeticSuppressions[0]?.reviewAt, "2026-12-14T00:00:00Z");
  assert.equal(arithmeticSuppressions[0]?.expiresAt, "2027-03-14T00:00:00Z");
  assert.equal(sha256(policyRaw), manifest.config.find(({ path }) => path === `${directory}/suppressions.v1.json`)!.sha256);
  const source = await readFile(finding.location.path, "utf8");
  assert.deepEqual(sourceLocation(finding.location.path, 5597, 783, source), finding.location);
  assert.equal(normalizedIdentityHash(finding.identity), finding.findingIdentityHash);
  assert.equal(findingFingerprint(finding), finding.fingerprint);
  const decision = decide([finding]);
  assert.equal(decision.category, "clean", JSON.stringify(decision.errors));
  assert.deepEqual(decision.suppressed, [finding]);
  assert.deepEqual(decision.blocking, []);
  assert.equal(decide([finding], []).category, "policy-failure");
  assert.deepEqual(decide([finding], []).blocking, [finding]);
});

test("changed source or any observed tuple field cannot inherit the exception", () => {
  const changed: Finding[] = [
    { ...finding, detectorId: "tx-origin" },
    { ...finding, fingerprint: `sha256:${"0".repeat(64)}` },
    { ...finding, findingIdentityHash: `sha256:${"0".repeat(64)}` },
    ...[
      { path: "contracts/evm/src/Other.sol" }, { start: 5598 }, { length: 782 },
      { sourceHash: `sha256:${"0".repeat(64)}` }, { snippetHash: `sha256:${"0".repeat(64)}` },
    ].map((location) => ({ ...finding, location: { ...finding.location, ...location } })),
  ];
  for (const value of changed) {
    const decision = decide([value]);
    assert.equal(decision.category, "output-failure");
    assert.equal(decision.exitCode, 40);
    assert.deepEqual(decision.suppressed, []);
    assert.ok(decision.errors.some((error) => error.includes("unused")));
  }
  const unrelated = { ...finding, fingerprint: `sha256:${"1".repeat(64)}` };
  assert.deepEqual(decide([finding, unrelated]).blocking, [unrelated]);
});

test("review deadline, expiry and historical wrong-policy replay fail closed", async () => {
  for (const now of ["2026-12-14T00:00:00Z", "2027-03-14T00:00:00Z"]) {
    const decision = decide([finding], suppressions, now);
    assert.equal(decision.exitCode, 40);
    assert.ok(decision.errors.some((error) => error.includes("expired, review-overdue")));
  }
  const historicalRaw = await readFile(`${directory}/tests/fixtures/suppressions.8977f78.json`, "utf8");
  const historicalManifest = parseGateManifest(await readFile(`${directory}/tests/fixtures/production-closure.8977f78.json`, "utf8"));
  const pinned = historicalManifest.config.find(({ path }) => path === `${directory}/suppressions.v1.json`)!.sha256;
  assert.equal(sha256(historicalRaw), pinned);
  assert.notEqual(sha256(policyRaw), pinned);
  const historical = JSON.parse(historicalRaw) as { suppressions: Suppression[] };
  assert.deepEqual(historical.suppressions, []);
  assert.equal(decide([finding], historical.suppressions).exitCode, 20);
  assert.equal(decide([]).exitCode, 40);
});
