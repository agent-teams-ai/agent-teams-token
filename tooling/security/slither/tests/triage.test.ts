import assert from "node:assert/strict";
import { test } from "node:test";
import { validateFindingTriage } from "../src/application/triage.ts";
import { findingFingerprint, normalizedIdentityHash, sourceLocation } from "../src/adapters/fingerprint.ts";
import type { Finding, FindingTriage } from "../src/domain/model.ts";

const source = "contract A {}";
const base = { detectorId: "naming-convention", impact: "Informational" as const, confidence: "High", identity: "name", findingIdentityHash: normalizedIdentityHash("name"), location: sourceLocation("contracts/evm/src/A.sol", 0, 8, source) };
const finding: Finding = { ...base, fingerprint: findingFingerprint(base) };
const triage: FindingTriage = { schemaVersion: 1, fingerprint: finding.fingerprint, owner: "security", disposition: "accepted-design", rationale: "Public token constants intentionally follow Solidity constant naming.", reviewedAt: "2026-08-29T00:00:00Z" };

test("every visible lower-impact fingerprint requires exact current triage", () => {
  assert.deepEqual(validateFindingTriage([finding], [triage]), []);
  assert.match(validateFindingTriage([finding], [])[0] ?? "", /requires exactly one/u);
  assert.match(validateFindingTriage([], [triage])[0] ?? "", /stale/u);
  assert.match(validateFindingTriage([finding], [triage, triage])[0] ?? "", /unique/u);
});
