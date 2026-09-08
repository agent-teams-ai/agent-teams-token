import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validateFindingTriage } from "../src/application/triage.ts";
import { findingFingerprint, normalizedIdentityHash, sourceLocation } from "../src/adapters/fingerprint.ts";
import { assertSerializedAgainstSchema } from "../src/adapters/json-schema.ts";
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

test("production triage pins the exact current captured findings without suppressing them", async () => {
  const raw = await readFile("tooling/security/slither/triage.v1.json", "utf8");
  await assertSerializedAgainstSchema(raw, "tooling/security/slither/triage-ledger.schema.v1.json");
  const document = JSON.parse(raw) as {
    schemaVersion: number;
    findings: FindingTriage[];
  };
  const suppressions = JSON.parse(await readFile("tooling/security/slither/suppressions.v1.json", "utf8")) as {
    suppressions: unknown[];
  };
  const expected = [
    "sha256:140af649035e807216f8c00445e94afd9bc7ead2c6e488c07a055e1a9f4351cb",
    "sha256:14d28e3d595e6c0183a7aa9af6506913ff42e526ababa720b0740d32c25076bb",
    "sha256:3e9bbd4f4becbedeaf399132a78aae873c16832f014081535116f8d9a71b58bf",
    "sha256:41a24f69881fa7e61a657184f095cca8f63b0294157d67d51f53c35fa205be6a",
    "sha256:467424bcf1a60111645314c6c00da8f7fba5ddeb991f55d82eae0cd5b54c4742",
    "sha256:6968e5dfe430c2af75b3853c25e887ca502f113bf9bda91f9534c82162306811",
    "sha256:8263a454f64d24c9db2b6ba6d64e2f87cd69bd6a25d40eeb480da1133e77acfa",
    "sha256:83f6581c3996d4e9b5968b277ce1ff495a578911f308179538cc8f86ed788d8c",
    "sha256:8dcdc97543baa44ed283ce33a2c4fc42bc59911a37b8b2d132787666173d54ff",
    "sha256:9d8ec352a3f51ab1633f119d920d738e74bfeac64ffdcae6a3f53ae7bcf64272",
    "sha256:cf3dec3433de4ea4c848ce18b2dcf0c2b034f800f9d37f47f038d32f767ebad1",
    "sha256:fb34e078e26432fff83d02582abcd0a15d915cf968edc1caa59ceb40a395ba82",
  ];
  const reviewedDates = [
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-08T05:52:55.734Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-08T05:52:55.734Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-08-29T00:00:00.000Z",
    "2026-09-08T05:52:55.734Z",
    "2026-08-29T00:00:00.000Z",
  ];

  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.findings.map(({ fingerprint }) => fingerprint), expected);
  assert.ok(document.findings.every(({ owner }) => owner === "project-security"));
  assert.deepEqual(document.findings.map(({ reviewedAt }) => reviewedAt), reviewedDates);
  assert.ok(document.findings.every(({ rationale }) => rationale.trim().length >= 20));
  assert.deepEqual(suppressions.suppressions, []);
});
